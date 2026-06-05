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
