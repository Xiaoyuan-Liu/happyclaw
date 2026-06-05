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

- **Steps 3–4 — runtime isolation.** Cold-start already resolves the runtime
  owner per active-admin sender (`src/index.ts processGroupMessages`), so a
  cold run writes global memory to the correct admin. The remaining gap: when
  admin A's runner is **already active**, admin B's IPC-injected message
  executes under admin A's loaded plugin/MCP runtime. This is a correctness
  issue between mutually-trusted admins (not a privilege escalation), to be
  closed by threading `runtimeOwnerId` through the runner
  (`ContainerInput.runtimeOwnerId`) and guarding active-runner owner mismatch
  in the queue. These touch `src/index.ts` / `src/container-runner.ts` /
  `src/group-queue.ts` and are sequenced as separate PRs.
- **Frontend button gating.** A second admin sees the `web:main` rename/reset
  controls (payload `editable: true`) but the owner-only `canModifyGroup` will
  return 403 — same frontend-shows / backend-enforces pattern as elsewhere.
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
