import { describe, expect, test } from 'vitest';

import {
  isMainHome,
  canAdminShareMainHome,
  evaluateOwnerGate,
} from '../src/main-home-acl.js';
import { checkOwnerActive } from '../src/owner-gate.js';

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

describe('evaluateOwnerGate (#519 — owner-gate lockout)', () => {
  // The bug this guards: the dispatch loops gated web:main on the bootstrap
  // `created_by`. Once that admin is disabled/deleted, every active admin's
  // message was dropped (permanent loss + lockout), contradicting option B.
  const allAdminsGone = { hasActiveAdmin: () => false, checkOwner: noOwner };
  function noOwner(): ReturnType<typeof checkOwnerActive> {
    throw new Error('checkOwner must not be consulted on web:main');
  }
  const usersById: Record<string, { status: string } | null> = {
    bootstrapAdmin: { status: 'deleted' },
    activeMember: { status: 'active' },
    disabledMember: { status: 'disabled' },
  };
  const checkOwner = (id: string) => checkOwnerActive(usersById[id]);

  test('web:main: an active admin exists → process even if bootstrap created_by is deleted', () => {
    // The defining option-B fix: the gate must NOT consult created_by for
    // web:main — it gates purely on active-admin presence.
    const gate = evaluateOwnerGate(
      { ...mainHome, created_by: 'bootstrapAdmin' },
      { hasActiveAdmin: () => true, checkOwner: noOwner },
    );
    expect(gate.drop).toBe(false);
  });

  test('web:main: NO active admin remains → drop with no_active_admin reason', () => {
    const gate = evaluateOwnerGate(
      { ...mainHome, created_by: 'bootstrapAdmin' },
      allAdminsGone,
    );
    expect(gate).toEqual({ drop: true, reason: 'no_active_admin' });
  });

  test('non-home group: active owner → process', () => {
    const gate = evaluateOwnerGate(
      { is_home: false, folder: 'ws-x', created_by: 'activeMember' },
      { hasActiveAdmin: () => true, checkOwner },
    );
    expect(gate.drop).toBe(false);
  });

  test('non-home group: disabled owner → drop with inactive_owner reason + status', () => {
    const gate = evaluateOwnerGate(
      { is_home: false, folder: 'ws-x', created_by: 'disabledMember' },
      { hasActiveAdmin: () => true, checkOwner },
    );
    expect(gate).toEqual({
      drop: true,
      reason: 'inactive_owner',
      ownerStatus: 'disabled',
    });
  });

  test('group without created_by is never dropped (legacy)', () => {
    const gate = evaluateOwnerGate(
      { is_home: false, folder: 'ws-x' },
      { hasActiveAdmin: () => false, checkOwner: noOwner },
    );
    expect(gate.drop).toBe(false);
  });
});
