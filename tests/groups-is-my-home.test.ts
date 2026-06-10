/**
 * is_my_home single-flag invariant (#519 regression).
 *
 * buildGroupsPayload used to compute is_my_home as
 *   (isHome && created_by === user.id) || canAdminShareMainHome(group, user)
 * which double-flags for a member who was later promoted to admin: the role
 * change never converts their home-{userId} row (ensureUserHomeGroup
 * early-returns on the exact match), so BOTH home-{userId} AND web:main got
 * flagged and the frontend home-slot logic (last-write-wins / first-match)
 * broke. The fix derives is_my_home from db.getUserHomeGroup — the canonical
 * resolver where the exact-match home row wins and the web:main admin
 * fallback applies only otherwise.
 *
 * Covered here:
 *   1. db.getUserHomeGroup canonical resolution (exact match beats fallback;
 *      fallback is active-admin-only).
 *   2. GET /api/groups route-level: exactly ONE group carries is_my_home per
 *      user, and it agrees with getUserHomeGroup in every persona.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-groups-is-my-home-'));
    process.env.HAPPYCLAW_TEST_DATA_DIR = d;
    return d;
  })();

const tmpDataDir = SHARED_TMP;

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

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: process.env.HAPPYCLAW_TEST_USER_ID ?? 'bob',
      username: process.env.HAPPYCLAW_TEST_USER_ID ?? 'bob',
      role: process.env.HAPPYCLAW_TEST_USER_ROLE ?? 'member',
      permissions: [],
    });
    return next();
  },
}));

// groups.ts statically imports these from web.js; mock them so importing the
// route module doesn't pull in the full Hono app + every route's middleware.
vi.mock('../src/web.js', () => ({
  broadcastNewMessage: () => {},
  invalidateAllowedUserCache: () => {},
}));

// web-context.ts imports GroupQueue from group-queue.js (type-position only);
// stub it so this test never loads the queue/runner module graph.
vi.mock('../src/group-queue.js', () => ({ GroupQueue: class {} }));

const groupRoutesModule = await import('../src/routes/groups.js');
const db = await import('../src/db.js');
const webContext = await import('../src/web-context.js');

const groupRoutes = groupRoutesModule.default;

const now = new Date().toISOString();

function seedUser(
  id: string,
  role: 'admin' | 'member',
  status: 'active' | 'disabled' = 'active',
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
  } as Parameters<typeof db.createUser>[0]);
}

function seedHomeGroup(
  jid: string,
  folder: string,
  createdBy: string,
  executionMode: 'host' | 'container',
): void {
  db.setRegisteredGroup(jid, {
    name: jid,
    folder,
    added_at: now,
    executionMode,
    created_by: createdBy,
    is_home: true,
  } as Parameters<typeof db.setRegisteredGroup>[1]);
}

function asUser(userId: string, role: 'admin' | 'member'): void {
  process.env.HAPPYCLAW_TEST_USER_ID = userId;
  process.env.HAPPYCLAW_TEST_USER_ROLE = role;
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDataDir, 'groups'), { recursive: true });
  db.initDatabase();
  // Routes guard on getWebDeps(); the paths exercised here only need the
  // registered-groups cache stub (same shape as routes-groups-owner-acl).
  webContext.setWebDeps({
    getRegisteredGroups: () => ({}),
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

  seedUser('adminA', 'admin'); // bootstrap admin (created_by of web:main)
  seedUser('bob', 'member'); // member, promoted to admin mid-suite
  seedUser('carol', 'admin'); // second admin, never had an own home row
  seedUser('dave', 'member'); // ordinary member, stays member
  seedUser('edgar', 'admin', 'disabled'); // disabled admin without own row

  seedHomeGroup('web:main', 'main', 'adminA', 'host');
  seedHomeGroup('web:home-bob', 'home-bob', 'bob', 'container');
  seedHomeGroup('web:home-dave', 'home-dave', 'dave', 'container');
});

afterEach(() => {
  delete process.env.HAPPYCLAW_TEST_USER_ID;
  delete process.env.HAPPYCLAW_TEST_USER_ROLE;
});

describe('db.getUserHomeGroup — canonical home resolution (#519)', () => {
  test('bootstrap admin resolves web:main via exact created_by match', () => {
    expect(db.getUserHomeGroup('adminA')?.jid).toBe('web:main');
  });

  test('member resolves their own home row', () => {
    expect(db.getUserHomeGroup('bob')?.jid).toBe('web:home-bob');
  });

  test('second active admin without an own row falls back to web:main', () => {
    expect(db.getUserHomeGroup('carol')?.jid).toBe('web:main');
  });

  test('promoted member keeps their leftover home row (exact match wins over fallback)', () => {
    db.updateUserFields('bob', { role: 'admin' });
    expect(db.getUserHomeGroup('bob')?.jid).toBe('web:home-bob');
  });

  test('disabled admin without an own row gets NO fallback', () => {
    expect(db.getUserHomeGroup('edgar')).toBeUndefined();
  });
});

describe('GET /api/groups — exactly one is_my_home per user', () => {
  async function fetchGroups(): Promise<Record<string, { is_my_home?: boolean }>> {
    const res = await groupRoutes.request('/', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      groups: Record<string, { is_my_home?: boolean }>;
    };
    return body.groups;
  }

  function flaggedJids(groups: Record<string, { is_my_home?: boolean }>): string[] {
    return Object.entries(groups)
      .filter(([, g]) => g.is_my_home === true)
      .map(([jid]) => jid);
  }

  test('promoted member-turned-admin: ONLY home-bob is flagged, never web:main too', async () => {
    // bob was promoted in the db-level suite above; promote idempotently so
    // this test stands on its own if suites are reordered.
    db.updateUserFields('bob', { role: 'admin' });
    asUser('bob', 'admin');

    const groups = await fetchGroups();
    // As an admin, bob now also SEES the shared web:main...
    expect(groups['web:main']).toBeDefined();
    expect(groups['web:home-bob']).toBeDefined();
    // ...but exactly one group carries the home flag, and it is his own row.
    // The pre-fix dual-flag expression flagged BOTH (the #519 regression).
    expect(flaggedJids(groups)).toEqual(['web:home-bob']);
  });

  test('second admin without an own row: web:main is the (only) flagged home', async () => {
    asUser('carol', 'admin');
    const groups = await fetchGroups();
    expect(flaggedJids(groups)).toEqual(['web:main']);
  });

  test('bootstrap admin: web:main is the (only) flagged home', async () => {
    asUser('adminA', 'admin');
    const groups = await fetchGroups();
    expect(flaggedJids(groups)).toEqual(['web:main']);
  });

  test('ordinary member: own home flagged, web:main not even visible', async () => {
    asUser('dave', 'member');
    const groups = await fetchGroups();
    expect(groups['web:main']).toBeUndefined();
    expect(flaggedJids(groups)).toEqual(['web:home-dave']);
  });
});
