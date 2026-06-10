import { describe, expect, test } from 'vitest';

import {
  MIXED_ADMIN_BATCH,
  resolveInjectionOwnerConstraint,
  preferActiveAdminFallback,
  type RuntimeOwnerCandidateUser,
} from '../src/runtime-owner.js';

/**
 * Pure-function tests for the active-injection owner constraint (#519).
 *
 * The bug this guards: the previous latest-sender resolution at the
 * active-injection site was bypassable by interleave — a batch
 * [B_deferred, A_new] resolved to A == the active run's owner, so B's
 * message was piped into A's live runtime, defeating the step-4 guard.
 * A batch with two or more distinct active admins must therefore resolve
 * to the MIXED_ADMIN_BATCH sentinel (matches no real user id → the
 * group-queue owner-mismatch guard always defers with 'no_active').
 */

const users: Record<string, RuntimeOwnerCandidateUser> = {
  adminA: { id: 'adminA', status: 'active', role: 'admin' },
  adminB: { id: 'adminB', status: 'active', role: 'admin' },
  disabledAdmin: { id: 'disabledAdmin', status: 'disabled', role: 'admin' },
  member1: { id: 'member1', status: 'active', role: 'member' },
};

const getUserById = (id: string) => users[id] ?? null;

const msgs = (...senders: string[]) => senders.map((sender) => ({ sender }));

describe('resolveInjectionOwnerConstraint', () => {
  test('empty batch → null (no constraint)', () => {
    expect(resolveInjectionOwnerConstraint([], getUserById)).toBe(null);
  });

  test('only IM open_id / unknown senders → null (preserves same-admin IM continuation)', () => {
    expect(
      resolveInjectionOwnerConstraint(
        msgs('ou_feishu_open_id_1', 'tg:123456', 'ou_feishu_open_id_2'),
        getUserById,
      ),
    ).toBe(null);
  });

  test('one active admin, repeated across many messages → that id', () => {
    expect(
      resolveInjectionOwnerConstraint(
        msgs('adminA', 'adminA', 'adminA', 'adminA'),
        getUserById,
      ),
    ).toBe('adminA');
  });

  test('two distinct active admins → MIXED_ADMIN_BATCH (interleave must defer)', () => {
    // The exact interleave bypass: B's deferred message followed by A's new
    // one. Resolving to A would pipe B into A's live runtime.
    expect(
      resolveInjectionOwnerConstraint(msgs('adminB', 'adminA'), getUserById),
    ).toBe(MIXED_ADMIN_BATCH);
  });

  test('active admin + disabled admin sender → the active one (disabled never counts)', () => {
    expect(
      resolveInjectionOwnerConstraint(
        msgs('disabledAdmin', 'adminA'),
        getUserById,
      ),
    ).toBe('adminA');
  });

  test('active admin + member sender → the admin (members never count)', () => {
    expect(
      resolveInjectionOwnerConstraint(msgs('member1', 'adminA'), getUserById),
    ).toBe('adminA');
  });

  test("system senders ('happyclaw-agent', '__system__', '') are skipped", () => {
    expect(
      resolveInjectionOwnerConstraint(
        msgs('happyclaw-agent', '__system__', '', 'adminA'),
        getUserById,
      ),
    ).toBe('adminA');
    // Skipped without being treated as a distinct admin: a lookup for them
    // must never even be attempted.
    const lookups: string[] = [];
    resolveInjectionOwnerConstraint(
      msgs('happyclaw-agent', '__system__', ''),
      (id) => {
        lookups.push(id);
        return null;
      },
    );
    expect(lookups).toEqual([]);
  });

  test('MIXED_ADMIN_BATCH is the exported non-empty sentinel, not a plausible user id', () => {
    expect(MIXED_ADMIN_BATCH).toBe('__mixed_admin_batch__');
    expect(MIXED_ADMIN_BATCH.length).toBeGreaterThan(0);
    // Dunder-wrapped like the existing '__system__' reserved sender — no real
    // user id in this codebase takes that shape.
    expect(MIXED_ADMIN_BATCH.startsWith('__')).toBe(true);
    expect(MIXED_ADMIN_BATCH.endsWith('__')).toBe(true);
    expect(Object.keys(users)).not.toContain(MIXED_ADMIN_BATCH);
  });
});

describe('preferActiveAdminFallback (#519 — IM-bound agent isolation)', () => {
  // The bug this guards: an auto_im agent owned by admin B runs under the
  // bootstrap admin A's runtime because every IM sender is an open_id the
  // resolver can't map. The agent's own created_by (B) is the reliable owner.
  test('active-admin candidate distinct from fallback → candidate wins', () => {
    expect(preferActiveAdminFallback('adminB', 'adminA', getUserById)).toBe(
      'adminB',
    );
  });

  test('disabled-admin candidate → fallback (never an inactive owner)', () => {
    expect(
      preferActiveAdminFallback('disabledAdmin', 'adminA', getUserById),
    ).toBe('adminA');
  });

  test('member candidate → fallback (agents owned by non-admins do not override)', () => {
    expect(preferActiveAdminFallback('member1', 'adminA', getUserById)).toBe(
      'adminA',
    );
  });

  test('unknown candidate → fallback', () => {
    expect(preferActiveAdminFallback('ghost', 'adminA', getUserById)).toBe(
      'adminA',
    );
  });

  test('null/empty candidate or candidate === fallback → fallback (no lookup)', () => {
    const lookups: string[] = [];
    const spy = (id: string) => {
      lookups.push(id);
      return users[id] ?? null;
    };
    expect(preferActiveAdminFallback(null, 'adminA', spy)).toBe('adminA');
    expect(preferActiveAdminFallback(undefined, 'adminA', spy)).toBe('adminA');
    expect(preferActiveAdminFallback('adminA', 'adminA', spy)).toBe('adminA');
    expect(lookups).toEqual([]); // short-circuits before consulting the DB
  });
});
