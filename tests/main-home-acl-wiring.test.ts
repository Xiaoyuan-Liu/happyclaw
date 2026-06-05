/**
 * Wiring tests for the admin-shared `web:main` slice (issue #519 option B).
 *
 * tests/main-home-acl.test.ts covers the pure predicates (isMainHome /
 * canAdminShareMainHome). But predicate-green ≠ wiring-green: if the call sites
 * that consume those predicates are deleted, reordered, or inverted, the pure
 * tests still pass. These tests pin the two security-critical wirings the slice
 * introduces:
 *
 *   1. canAccessGroup (web-context.ts) — the access decision. Its is_home branch
 *      returns before touching the db, so it is testable directly with group
 *      objects (no rows needed).
 *   2. getActiveAdminIds (db.ts) — the live broadcast/allow-set roster. Must
 *      include only role='admin' AND status='active' users (a disabled or
 *      deleted admin must drop out so they stop receiving web:main broadcasts).
 *
 * (buildGroupsPayload's is_my_home / sidebar visibility is cosmetic and derives
 * from the same tested predicate; its route-level coverage is folded into the
 * step-5 mixed-admin integration tests, not this slice.)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeAll, describe, expect, test, vi } from 'vitest';

const tmpDataDir =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-main-home-wiring-'));
    process.env.HAPPYCLAW_TEST_DATA_DIR = d;
    return d;
  })();

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const dataDir = process.env.HAPPYCLAW_TEST_DATA_DIR!;
  return {
    ...real,
    DATA_DIR: dataDir,
    GROUPS_DIR: path.join(dataDir, 'groups'),
    STORE_DIR: path.join(dataDir, 'db'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const db = await import('../src/db.js');
const { canAccessGroup, canModifyGroup, canDeleteGroup } = await import(
  '../src/web-context.js'
);

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDataDir, 'groups'), { recursive: true });
  db.initDatabase();
});

// canAccessGroup only reads jid / is_home / created_by / folder for the cases
// below; cast a minimal object to the full type.
function group(partial: {
  jid: string;
  is_home?: boolean;
  folder: string;
  created_by?: string;
}): Parameters<typeof canAccessGroup>[1] {
  return partial as unknown as Parameters<typeof canAccessGroup>[1];
}

const webMain = group({
  jid: 'web:main',
  is_home: true,
  folder: 'main',
  created_by: 'adminA',
});
const memberHome = group({
  jid: 'web:home-u2',
  is_home: true,
  folder: 'home-u2',
  created_by: 'u2',
});

describe('canAccessGroup wiring — web:main is active-admins-shared (#519 option B)', () => {
  test('a second active admin (created_by mismatch) CAN access web:main', () => {
    // This is the whole point of option B and the line most likely to regress:
    // `if (canAdminShareMainHome(group, user)) return true;` in the is_home branch.
    expect(canAccessGroup({ id: 'adminB', role: 'admin' }, webMain)).toBe(true);
  });

  test('the bootstrap admin (created_by match) still accesses web:main', () => {
    expect(canAccessGroup({ id: 'adminA', role: 'admin' }, webMain)).toBe(true);
  });

  test('a member CANNOT access web:main', () => {
    expect(canAccessGroup({ id: 'mallory', role: 'member' }, webMain)).toBe(false);
  });

  test("an admin does NOT gain access to another user's home via the share rule", () => {
    // isMainHome gates on folder === 'main', so the share exception must NOT leak
    // to a member's personal home (folder = home-{userId}).
    expect(canAccessGroup({ id: 'adminB', role: 'admin' }, memberHome)).toBe(false);
  });

  test('the home owner can always access their own home', () => {
    expect(canAccessGroup({ id: 'u2', role: 'member' }, memberHome)).toBe(true);
  });
});

describe('canModifyGroup wiring — web:main reset/clear is active-admins-shared (#519)', () => {
  test('a second active admin (created_by mismatch) CAN modify web:main', () => {
    // The #519 fix: once the bootstrap admin is disabled/deleted, another active
    // admin must still be able to /clear or reset the shared home. Regresses if
    // the is_home branch reverts to `return group.created_by === user.id`.
    expect(canModifyGroup({ id: 'adminB', role: 'admin' }, webMain)).toBe(true);
  });

  test('the bootstrap admin still modifies web:main', () => {
    expect(canModifyGroup({ id: 'adminA', role: 'admin' }, webMain)).toBe(true);
  });

  test('a member CANNOT modify web:main', () => {
    expect(canModifyGroup({ id: 'mallory', role: 'member' }, webMain)).toBe(false);
  });

  test("an admin does NOT gain modify rights on another user's home", () => {
    expect(canModifyGroup({ id: 'adminB', role: 'admin' }, memberHome)).toBe(false);
  });

  test('the share exception opens reset/clear but NOT delete of web:main', () => {
    // Deletion of any is_home group is blocked outright (canDeleteGroup), so the
    // shared-modify exception must not leak into a delete capability.
    expect(canDeleteGroup({ id: 'adminB', role: 'admin' }, webMain)).toBe(false);
    expect(canDeleteGroup({ id: 'adminA', role: 'admin' }, webMain)).toBe(false);
  });
});

describe('getActiveAdminIds wiring — live broadcast roster', () => {
  const now = new Date().toISOString();
  function seedUser(
    id: string,
    role: 'admin' | 'member',
    status: 'active' | 'disabled' | 'deleted',
  ): void {
    db.createUser({
      id,
      username: id,
      password_hash: 'x',
      display_name: id,
      role,
      status,
      created_at: now,
      updated_at: now,
      ...(status === 'deleted' ? { deleted_at: now } : {}),
    } as Parameters<typeof db.createUser>[0]);
  }

  beforeAll(() => {
    seedUser('wadminA', 'admin', 'active');
    seedUser('wadminB', 'admin', 'active');
    seedUser('wadminDisabled', 'admin', 'disabled');
    seedUser('wadminDeleted', 'admin', 'deleted');
    seedUser('wmember', 'member', 'active');
  });

  test('returns exactly the active admins (excludes disabled, deleted, members)', () => {
    const ids = db.getActiveAdminIds().sort();
    expect(ids).toContain('wadminA');
    expect(ids).toContain('wadminB');
    expect(ids).not.toContain('wadminDisabled');
    expect(ids).not.toContain('wadminDeleted');
    expect(ids).not.toContain('wmember');
  });

  test('a demoted/disabled admin drops out of the roster immediately', () => {
    // Self-contained (own user) so it never disturbs the roster other tests read.
    seedUser('wadminToggle', 'admin', 'active');
    expect(db.getActiveAdminIds()).toContain('wadminToggle');
    db.updateUserFields('wadminToggle', { status: 'disabled' });
    expect(db.getActiveAdminIds()).not.toContain('wadminToggle');
  });
});
