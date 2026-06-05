import { describe, expect, test } from 'vitest';

import { isMainHome, canAdminShareMainHome } from '../src/main-home-acl.js';

/**
 * Pure-predicate tests for the active-admins-shared admin home (`web:main`),
 * issue #519 option B. These predicates are the single source of the
 * `is_home && folder === 'main'` rule used by canAccessGroup (web-context.ts),
 * the group-list filter + is_my_home flag (routes/groups.ts), and the broadcast
 * allow-set (web.ts) — so getting them right here covers all three call sites.
 *
 * The defining property of option B: access does NOT depend on `created_by`.
 * A second admin whose id differs from the bootstrap admin still qualifies, and
 * a member never does — these predicates take no created_by at all.
 */

const mainHome = { is_home: true, folder: 'main' };
const memberHome = { is_home: true, folder: 'home-u2' };
const sharedWeb = { is_home: false, folder: 'ws-x' };
// A non-home row on folder 'main' — this is exactly an IM sibling auto-bound to
// the admin's main folder (e.g. feishu:xxx, is_home=false, folder='main'). The
// predicate must reject it: only the is_home web:main row is the shared admin
// home. (IM siblings are a documented broadcast-parity follow-up, not this slice.)
const nonHomeMain = { is_home: false, folder: 'main' };

describe('isMainHome', () => {
  test('web:main (is_home + folder main) is the shared admin home', () => {
    expect(isMainHome(mainHome)).toBe(true);
  });

  test("a member's own home is NOT the shared admin home", () => {
    expect(isMainHome(memberHome)).toBe(false);
  });

  test('a shared/web non-home workspace is not the admin home', () => {
    expect(isMainHome(sharedWeb)).toBe(false);
  });

  test("folder 'main' without is_home does not qualify", () => {
    expect(isMainHome(nonHomeMain)).toBe(false);
  });

  test('null/undefined is_home is treated as not-home', () => {
    expect(isMainHome({ is_home: null, folder: 'main' })).toBe(false);
    expect(isMainHome({ folder: 'main' })).toBe(false);
  });
});

describe('canAdminShareMainHome', () => {
  test('any admin gets shared access to web:main (independent of created_by)', () => {
    // The bootstrap admin and a second admin are indistinguishable here — the
    // predicate never sees created_by, which is exactly option B.
    expect(canAdminShareMainHome(mainHome, { role: 'admin' })).toBe(true);
  });

  test('a member is denied shared access to web:main', () => {
    expect(canAdminShareMainHome(mainHome, { role: 'member' })).toBe(false);
  });

  test("an admin does NOT get shared access to a member's home", () => {
    expect(canAdminShareMainHome(memberHome, { role: 'admin' })).toBe(false);
  });

  test('an admin does NOT get shared access to a normal web workspace', () => {
    expect(canAdminShareMainHome(sharedWeb, { role: 'admin' })).toBe(false);
  });

  test("folder 'main' without is_home is rejected even for an admin", () => {
    expect(canAdminShareMainHome(nonHomeMain, { role: 'admin' })).toBe(false);
  });
});
