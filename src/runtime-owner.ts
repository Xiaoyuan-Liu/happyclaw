/**
 * Shared runtime-owner resolution for plugin-command expansion.
 *
 * On the admin-shared `web:main` workspace, plugin runtime is per-user — so
 * the *latest* active admin sender is the correct owner to expand against,
 * not whichever admin first materialised the group (`group.created_by`).
 *
 * Three cold-start / IPC paths share this logic:
 *   - `processGroupMessages` main-conversation cold-start (src/index.ts)
 *   - `processAgentConversation` agent-conv cold-start (src/index.ts)
 *   - active IPC injection in the message-loop (src/index.ts)
 *
 * Keeping a single helper avoids the three call sites drifting apart again
 * (codex review #21 round-13 P2-2). The function is pure: callers inject the
 * user lookup so it stays trivially unit-testable without touching the DB.
 */

export interface RuntimeOwnerCandidateMessage {
  /** Message sender id — system messages (e.g. `__system__`, `happyclaw-agent`) are skipped. */
  sender: string;
}

export interface RuntimeOwnerCandidateUser {
  id: string;
  status: 'active' | 'disabled' | 'deleted';
  role: 'admin' | 'member';
}

/**
 * Walk `messages` from end to start and return the id of the most recent
 * `active admin` sender, or `null` if none qualifies. System / agent senders
 * (`__system__`, `happyclaw-agent`) are skipped without breaking the walk.
 *
 * Callers compose this with their own fallback (typically `group.created_by`)
 * — we deliberately don't accept a fallback parameter here because the
 * admin-shared override only applies on `web:main + is_home`; on other
 * workspaces `created_by` wins outright and the helper isn't called at all.
 */
export function resolveLatestAdminSenderOverride(
  messages: ReadonlyArray<RuntimeOwnerCandidateMessage>,
  getUserById: (id: string) => RuntimeOwnerCandidateUser | null | undefined,
): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const sender = messages[i]?.sender;
    if (!sender || sender === 'happyclaw-agent' || sender === '__system__') {
      continue;
    }
    const user = getUserById(sender);
    if (user?.status === 'active' && user.role === 'admin') {
      return user.id;
    }
  }
  return null;
}

/**
 * Convenience wrapper: returns the override sender id if (and only if) the
 * resolved group is the admin-shared `web:main + is_home` workspace; otherwise
 * returns `fallbackOwner` unchanged. Centralises the `chatJid === 'web:main'
 * && isHome` gate that all three call sites previously inlined.
 *
 * `chatJid` may be a virtual JID (`web:main#agent:<id>`) — the gate checks the
 * base JID before the first `#` (mirrors the legacy virtual-JID base check).
 */
export function resolveAdminSharedRuntimeOwner(args: {
  chatJid: string;
  isHome: boolean;
  fallbackOwner: string | null | undefined;
  messages: ReadonlyArray<RuntimeOwnerCandidateMessage>;
  getUserById: (id: string) => RuntimeOwnerCandidateUser | null | undefined;
}): string | null | undefined {
  const hashIdx = args.chatJid.indexOf('#');
  const baseJid =
    hashIdx >= 0 ? args.chatJid.slice(0, hashIdx) : args.chatJid;
  if (baseJid !== 'web:main' || !args.isHome) {
    return args.fallbackOwner;
  }
  const override = resolveLatestAdminSenderOverride(
    args.messages,
    args.getUserById,
  );
  return override ?? args.fallbackOwner;
}

/**
 * Sentinel returned by `resolveInjectionOwnerConstraint` for a batch that
 * contains messages from two or more distinct active admins. It matches no
 * real user id, so the group-queue owner-mismatch guard always defers such a
 * batch with `no_active` instead of piping it into a live runtime.
 */
export const MIXED_ADMIN_BATCH = '__mixed_admin_batch__';

/**
 * Resolve the owner constraint for ACTIVE-INJECTION of a message batch into a
 * running `web:main` agent (the `injectOwnerId` passed to
 * `GroupQueue.sendMessage`).
 *
 * Why this exists: the previous latest-sender resolution
 * (`resolveLatestAdminSenderOverride`) was bypassable by interleave — a batch
 * `[B_deferred, A_new]` resolved to A, which equals the active run's owner,
 * so B's message was piped into A's live runtime. That defeats the step-4
 * guard's stated guarantee that admin B's messages never execute under admin
 * A's identity (plugins / MCP / user-global memory).
 *
 * So instead of "latest wins", this walks the WHOLE batch and collects the
 * distinct active-admin senders (system senders `happyclaw-agent` /
 * `__system__` are skipped, consistent with
 * `resolveLatestAdminSenderOverride`; unknown / inactive / member senders
 * never count):
 *   - 0 distinct active admins → `null` (no constraint — e.g. IM open_id
 *     senders; preserves same-admin IM continuation),
 *   - exactly 1 → that admin's id (inject only if the live run is theirs),
 *   - 2 or more → `MIXED_ADMIN_BATCH` — a mixed-admin batch must NEVER be
 *     piped into one admin's live runtime; it always defers to a fresh
 *     cold-start where each message expands under its own sender's runtime.
 */
export function resolveInjectionOwnerConstraint(
  messages: ReadonlyArray<RuntimeOwnerCandidateMessage>,
  getUserById: (id: string) => RuntimeOwnerCandidateUser | null | undefined,
): string | null {
  const adminIds = new Set<string>();
  for (const message of messages) {
    const sender = message?.sender;
    if (!sender || sender === 'happyclaw-agent' || sender === '__system__') {
      continue;
    }
    const user = getUserById(sender);
    if (user?.status === 'active' && user.role === 'admin') {
      adminIds.add(user.id);
      if (adminIds.size >= 2) {
        return MIXED_ADMIN_BATCH;
      }
    }
  }
  if (adminIds.size === 0) {
    return null;
  }
  return adminIds.values().next().value ?? null;
}

/**
 * Per-message variant of `resolveAdminSharedRuntimeOwner` (#23 round-15
 * P2-2). On the admin-shared `web:main + is_home` workspace, plugin runtime
 * is per-user — so each message in a mixed-admin batch must expand under
 * its OWN sender's runtime, not whichever admin happened to be the latest
 * sender for the batch as a whole.
 *
 * Returns:
 *   - the message's sender id when the sender is an active admin (use
 *     their personal plugin runtime to expand),
 *   - `fallbackOwner` when the sender is non-admin / disabled / unknown
 *     (mirrors the legacy fallback so non-admin senders on web:main still
 *     resolve plugins via the workspace's `created_by` admin),
 *   - `fallbackOwner` outright on non-admin-shared workspaces.
 */
export function resolvePerMessageRuntimeOwner(args: {
  chatJid: string;
  isHome: boolean;
  fallbackOwner: string | null | undefined;
  message: RuntimeOwnerCandidateMessage;
  getUserById: (id: string) => RuntimeOwnerCandidateUser | null | undefined;
}): string | null | undefined {
  const hashIdx = args.chatJid.indexOf('#');
  const baseJid =
    hashIdx >= 0 ? args.chatJid.slice(0, hashIdx) : args.chatJid;
  if (baseJid !== 'web:main' || !args.isHome) {
    return args.fallbackOwner;
  }
  const sender = args.message?.sender;
  if (!sender || sender === 'happyclaw-agent' || sender === '__system__') {
    return args.fallbackOwner;
  }
  const user = args.getUserById(sender);
  if (user?.status === 'active' && user.role === 'admin') {
    return user.id;
  }
  return args.fallbackOwner;
}

/**
 * Choose the fallback runtime owner for an agent conversation: prefer
 * `candidateId` (the agent's own `created_by` — auto_im agents stamp the
 * binding admin) over `fallbackId` (the workspace's `created_by`, i.e. the
 * bootstrap admin on shared web:main) — but only when `candidateId` is a
 * distinct *active admin*.
 *
 * Why this exists: IM-origin agent conversations carry open_id senders that
 * `resolveAdminSharedRuntimeOwner`'s sender walk cannot map to a HappyClaw
 * user, so it returns the fallback. Without this preference that fallback is
 * the bootstrap admin, and admin B's IM-bound agent would load admin A's
 * plugins/MCP and write B's memory into A's user-global dir. Pure: the caller
 * injects the user lookup and gates the web:main check, keeping it unit-testable.
 */
export function preferActiveAdminFallback(
  candidateId: string | null | undefined,
  fallbackId: string | null | undefined,
  getUserById: (id: string) => RuntimeOwnerCandidateUser | null | undefined,
): string | null | undefined {
  if (!candidateId || candidateId === fallbackId) {
    return fallbackId;
  }
  const user = getUserById(candidateId);
  if (user?.status === 'active' && user.role === 'admin') {
    return candidateId;
  }
  return fallbackId;
}
