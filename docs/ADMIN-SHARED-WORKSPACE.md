# Admin-shared `web:main` workspace (issue #519)

This document **locks** the product/architecture decision for the `web:main`
workspace so the ACL, UI, and runner layers stop disagreeing about it.

## Decision: option B — active-admins-SHARED

`web:main` (the admin home, `folder = 'main'`) is the **shared admin home
workspace for every active admin**, NOT an owner-only home.

- **Option A (rejected):** `web:main` is owner-only — only the bootstrap admin
  recorded in `created_by` may use it.
- **Option B (chosen):** `web:main` is shared by all active admins. The data
  layer already behaves this way — `db.ts getUserHomeGroup()` falls back to
  `web:main` for any active admin without an own home row, and
  `ensureUserHomeGroup()` reuses the single `web:main` row for every admin
  rather than minting one per admin. Option A would mean unwinding that, so we
  formalize B.

There is exactly **one** `web:main` row; `is_home && folder === 'main'`
uniquely identifies it (see `src/main-home-acl.ts`).

## Identity split

Opening access alone is not enough — three distinct identities must not be
conflated:

| Identity | Meaning |
|---|---|
| `created_by` | Workspace **metadata owner** — the bootstrap admin who first materialized `web:main`. Still governs *modify* (rename/reset), which stays owner-only. |
| `runtimeOwnerId` | Whose plugins / MCP / skills / global memory **this run** loads. On `web:main` this is the message *sender* (per-admin), not `created_by`. |
| `actorUserId` | Who is being **audited / permission-checked** for a given action. |

## What this slice implements (steps 1–2)

- **Step 1 — semantics locked:** this document + the existing per-sender
  runtime-owner tests (`plugin-expander-*`) + `tests/main-home-acl.test.ts`.
- **Step 2 — list / access / broadcast opened to active admins:**
  - `src/main-home-acl.ts` — pure predicates `isMainHome()` /
    `canAdminShareMainHome()` (single source of the rule).
  - `canAccessGroup()` (`src/web-context.ts`) — active admins may access
    `web:main` (messages, files, tasks, agents, workspace-config: all 54
    call sites of `canAccessGroup` inherit this). This is deliberate: the
    contents of `web:main` (conversation agents, scheduled tasks, files) become
    collaboratively manageable by every active admin — the same model a shared
    web workspace already gives its `group_members`. Per-admin privacy of items
    *inside* the shared workspace is explicitly NOT a goal; only workspace
    metadata (rename/reset/members) stays owner-only.

  Session-cache note: `canAdminShareMainHome` keys on `user.role`, and the auth
  session cache (`SESSION_CACHE_TTL_MS`, 30s) holds a copy of the role. So
  `admin.ts` invalidates a user's cached session on role/permission change —
  otherwise a just-demoted admin would keep `role:'admin'` (and thus `web:main`
  access) for up to the TTL.
  - `buildGroupsPayload()` (`src/routes/groups.ts`) — `web:main` is listed for
    every active admin, and `is_my_home` is true for them (so the sidebar home
    slot, default chat selection, and IM-binding panel resolve).
  - `computeGroupAllowedUserIds()` (`src/web.ts`) — every active admin receives
    `web:main` broadcasts (`getActiveAdminIds()`). `web:main` is the one group
    whose allow-set depends on the live admin roster, so `getGroupAllowedUserIds`
    bypasses the 10s TTL cache for it — a promoted/demoted/re-enabled admin
    starts/stops receiving immediately, with no roster→cache invalidation hook
    needed in `admin.ts`.

`canModifyGroup()` is intentionally **unchanged**: renaming/resetting `web:main`
remains owner-only (`created_by`).

## Known follow-ups (NOT in this slice)

- **Steps 3–4 — runtime isolation: DONE for web senders and IM-bound agents.**
  `runtimeOwnerId` now threads through the runner
  (`ContainerInput.runtimeOwnerId` → plugins / MCP / user-global memory),
  `GroupQueue.sendMessage` guards active-runner owner mismatch via
  `injectOwnerId` (mismatch defers to a fresh cold-start), and the
  agent-conversation path (`processAgentConversation` + `buildOnAgentMessage`)
  resolves and pins the per-run owner the same way the main conversation does —
  closing the sub-agent gap where admin B's agent conversation ran under the
  bootstrap admin's plugins/MCP and wrote B's memory into the bootstrap admin's
  user-global directory. Agent conversations additionally prefer the agent's own
  `created_by` (auto_im agents stamp the binding admin) as the cold-start
  fallback, so IM-bound agents isolate even though their senders are open_ids.
- **IM-origin sender on the MAIN conversation — residual.** Runtime owner
  resolution is *sender-based*, and only senders that map to a HappyClaw user id
  (web senders) constrain the runtime. An IM message routed to the shared
  `web:main` **main** conversation carries an open_id sender that maps to no
  user, so `resolveInjectionOwnerConstraint` / `resolveAdminSharedRuntimeOwner`
  treat it as "no constraint" and it injects into / cold-starts under whichever
  active-admin runtime applies (active runner's owner, or the workspace
  fallback) rather than the IM sender's own. The owning admin IS derivable
  (`message.source_jid` → source group `created_by`); wiring that mapping into
  the resolvers (so IM-origin main-conversation traffic isolates like web and
  agent traffic) is follow-up. This is pre-existing (carried over from the
  prior latest-sender resolver), not introduced by this slice.
- **Mixed-admin batch residual.** When messages from two or more active
  admins accumulate into one pending batch — the window is the remainder of
  any active run (up to `containerTimeout`) plus any capacity wait, NOT just
  one poll cycle — the injection constraint resolves to the
  `MIXED_ADMIN_BATCH` sentinel (`src/runtime-owner.ts`), so the batch always
  defers instead of piping into one admin's live runtime. Two caveats: (a) the
  sentinel only counts *web-identifiable* admins, so a batch mixing one IM
  (open_id) admin and one web admin resolves to the single web admin (see the
  IM-origin residual above); (b) the subsequent cold-start pins the WHOLE batch
  to the latest active-admin sender (`resolveAdminSharedRuntimeOwner`).
  Per-message runtime within one run is impossible — one process = one mount set
  (plugins / MCP / memory are fixed at spawn) — so splitting a mixed batch into
  per-admin cold-starts is the remaining follow-up.
- **Three-identity decoupling.** `created_by` / `runtimeOwnerId` /
  `actorUserId` (see the identity split above) are still partially conflated
  downstream: cold-start rewrites `effectiveGroup.created_by` to carry the
  runtime owner, so usage attribution and other consumers follow the runtime
  owner rather than receiving the three identities as explicit, independent
  parameters. Decoupling them is follow-up work.
- **Modify vs delete on `web:main`.** `canModifyGroup` now admits any active
  admin on `web:main` (rename / reset / `/clear` / agent + skill management),
  symmetric with `canAccessGroup`, so a second admin's controls are backed by the
  API — not a frontend-shows / backend-403 mismatch. Deletion stays blocked for
  every `is_home` group (`canDeleteGroup` returns false outright), so the shared
  home cannot be deleted by anyone.
- **IM siblings of the main folder.** A personal IM channel (feishu/telegram)
  bound to the `main` folder produces a non-home jid (`is_home=false`). Two
  related gaps follow, both rooted in sibling selection being owner-scoped rather
  than admin-roster-scoped:
  - *Broadcast:* an IM sibling's `computeGroupAllowedUserIds` resolves to owner +
    `group_members`, NOT all active admins — so a second admin sees web-sourced
    `web:main` messages live but an admin's IM-sourced message only on reload.
  - *Message merge (read):* `GET /api/groups/web:main/messages` merges siblings
    via `ownerMatch || adminSelfMatch` (same `created_by`, or the caller's own IM
    channels), so admin C does not see admin B's IM-sibling history — despite the
    `// admin: merge all siblings in the folder` comment in `routes/groups.ts`
    overstating it. Both want "merge all active-admin siblings on `folder==='main'`".
  Live/read parity here belongs with the folder-level broadcast work, not this slice.
- **Regression tests for the scheduled-task mixed-admin batch** (step 5).
