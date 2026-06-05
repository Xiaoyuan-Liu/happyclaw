// Pure ACL predicates for the admin-shared main home workspace.
//
// `web:main` (the admin home, folder === 'main') is the active-admins-SHARED
// admin home workspace — issue #519, option B — NOT an owner-only home. Every
// active admin, not just the bootstrap admin recorded in `created_by`, may
// access it and receives its broadcasts. The data layer already treats it this
// way (db.ts getUserHomeGroup falls back to web:main for any active admin); these
// predicates let the ACL / list / broadcast layers agree on the same rule from a
// single source instead of inlining `folder === 'main'` checks in three places.
//
// Kept dependency-free (like cross-group-acl.ts / owner-gate.ts) so the rule is
// unit-testable without mocking the db / queue / socket graph.

import type { OwnerGateResult } from './owner-gate.js';
import type { UserRole } from './types.js';

/**
 * Whether `group` is the shared admin home workspace (`web:main`). There is
 * exactly one such group (ensureUserHomeGroup reuses web:main for every admin),
 * so `is_home && folder === 'main'` uniquely identifies it.
 */
export function isMainHome(group: {
  is_home?: boolean | null;
  folder: string;
}): boolean {
  return !!group.is_home && group.folder === 'main';
}

/**
 * Whether `user` gets active-admin-shared access to `group` — true only when the
 * group is the shared admin home AND the user is an admin.
 *
 * Callers reach this only for active users (the auth middleware rejects
 * disabled/deleted before any route, and the broadcast allow-set is built from a
 * live active-admin query), so the admin role here implies an *active* admin.
 */
export function canAdminShareMainHome(
  group: { is_home?: boolean | null; folder: string },
  user: { role: UserRole },
): boolean {
  return isMainHome(group) && user.role === 'admin';
}

/** Verdict of the message/agent-conversation owner gate (#519). */
export type OwnerGateVerdict =
  | { drop: false }
  | { drop: true; reason: 'no_active_admin' }
  | { drop: true; reason: 'inactive_owner'; ownerStatus: string };

/**
 * Decide whether a dispatch loop must DROP a pending batch because the workspace
 * has no active owner to run it under (#519).
 *
 * - Shared web:main home: do NOT pin to the bootstrap `created_by` (which may be
 *   a since-disabled/deleted admin) — that would lock every active admin out of
 *   the shared home. Drop only when no active admin remains to own it; the run's
 *   cold-start then resolves the runtime owner from the active-admin sender.
 * - Any other group: drop when its `created_by` owner is disabled/deleted (the
 *   pre-existing owner gate, see owner-gate.ts).
 *
 * Pure: callers inject the lookups, so it is unit-testable without a running
 * loop (mirrors the runtime-owner.ts resolver style used across #519).
 */
export function evaluateOwnerGate(
  group: { is_home?: boolean | null; folder: string; created_by?: string | null },
  deps: {
    hasActiveAdmin: () => boolean;
    checkOwner: (userId: string) => OwnerGateResult;
  },
): OwnerGateVerdict {
  if (isMainHome(group)) {
    return deps.hasActiveAdmin()
      ? { drop: false }
      : { drop: true, reason: 'no_active_admin' };
  }
  if (group.created_by) {
    const gate = deps.checkOwner(group.created_by);
    if (!gate.allowed) {
      return { drop: true, reason: 'inactive_owner', ownerStatus: gate.status };
    }
  }
  return { drop: false };
}
