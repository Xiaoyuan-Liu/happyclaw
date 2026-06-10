/**
 * Unit tests for GroupQueue's runtime-owner injection guard (#519 step 4).
 *
 * On the active-admins-shared web:main home, an active runner is loaded for one
 * admin's runtime (plugins / MCP / global memory). A *different* admin's message
 * must not be IPC-injected into it — that would execute under the wrong admin's
 * plugins and write to their memory. sendMessage() returns 'no_active' on such a
 * mismatch so the caller starts a fresh run (whose cold-start re-resolves the
 * runtime owner from the new sender). On every other group injectOwnerId equals
 * the run's owner (both = created_by), so the guard is a no-op.
 *
 * The run is made active via enqueueMessageCheck + a gated processMessagesFn
 * that registers the process (with a configurable runtimeOwnerId) the moment it
 * starts — mirroring production, where runAgent's onProcessCb calls
 * registerProcess({ runtimeOwnerId }).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import type { ChildProcess } from 'node:child_process';

const TEST_DATA_DIR = '/tmp/happyclaw-queue-runtime-owner-test';

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, DATA_DIR: '/tmp/happyclaw-queue-runtime-owner-test' };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/container-runner.js', () => ({ killProcessTree: () => {} }));

vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({
    maxConcurrentContainers: 5,
    maxConcurrentHostProcesses: 5,
  }),
}));

vi.mock('../src/db.js', () => ({ getTaskById: () => undefined }));

const { GroupQueue } = await import('../src/group-queue.js');
const { MIXED_ADMIN_BATCH } = await import('../src/runtime-owner.js');

const tick = () => new Promise((r) => setImmediate(r));
const JID = 'web:main';
const FOLDER = 'main';

const fakeProc = () =>
  ({ pid: 1, kill: () => {}, on: () => {} }) as unknown as ChildProcess;

let queue: InstanceType<typeof GroupQueue>;
let resolveGate: (() => void) | null;
let activeOwner: string | null;

beforeEach(() => {
  // Hermetic per test: earlier tests' sendMessage calls leave IPC .json files
  // under the shared tmp DATA_DIR; recoverUnconsumedIpc in the run's finally
  // would see them, re-arm pendingMessages and start an unwanted fresh run.
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  queue = new GroupQueue();
  resolveGate = null;
  activeOwner = 'adminA';
  queue.setProcessMessagesFn(async (jid: string) => {
    // Mirror production: register the run's process (with its runtime owner) the
    // moment it starts, then stay active while it works.
    queue.registerProcess(jid, fakeProc(), {
      containerName: 'c',
      groupFolder: FOLDER,
      runtimeOwnerId: activeOwner,
    });
    await new Promise<void>((r) => {
      resolveGate = r;
    });
    return true;
  });
});

afterEach(async () => {
  resolveGate?.();
  await tick();
  await tick();
});

describe('GroupQueue sendMessage runtime-owner guard (#519 step 4)', () => {
  test("rejects a different admin's injection into an active run (→ no_active)", async () => {
    queue.enqueueMessageCheck(JID, 'adminA');
    await tick();
    // adminA's runner is active; adminB's message must defer to a fresh run.
    expect(
      queue.sendMessage(JID, 'hi from B', undefined, undefined, undefined, 'adminB'),
    ).toBe('no_active');
  });

  test('MIXED_ADMIN_BATCH sentinel always defers (mixed-admin batch never pipes into a live run)', async () => {
    // resolveInjectionOwnerConstraint returns this sentinel for a batch with two
    // or more distinct active admins. It matches no real runtimeOwnerId, so the
    // guard must always defer — this is the queue-side wiring of the interleave
    // fix (the pure resolver is pinned in injection-owner-constraint.test.ts).
    queue.enqueueMessageCheck(JID, 'adminA');
    await tick();
    expect(
      queue.sendMessage(
        JID,
        'mixed [B, A]',
        undefined,
        undefined,
        undefined,
        MIXED_ADMIN_BATCH,
      ),
    ).toBe('no_active');
  });

  test('allows the same admin to inject into their own active run (→ sent)', async () => {
    queue.enqueueMessageCheck(JID, 'adminA');
    await tick();
    expect(
      queue.sendMessage(JID, 'more from A', undefined, undefined, undefined, 'adminA'),
    ).toBe('sent');
  });

  test('no injectOwnerId → guard skipped (backward compatible, → sent)', async () => {
    queue.enqueueMessageCheck(JID, 'adminA');
    await tick();
    expect(queue.sendMessage(JID, 'legacy inject', undefined, undefined, undefined)).toBe(
      'sent',
    );
  });

  test("guard is a no-op when the run has no recorded runtime owner", async () => {
    activeOwner = null; // run registered without a runtime owner (legacy / non-shared)
    queue.enqueueMessageCheck(JID, 'adminA');
    await tick();
    expect(
      queue.sendMessage(JID, 'x', undefined, undefined, undefined, 'adminB'),
    ).toBe('sent');
  });
});

describe('GroupQueue runTask runtime-owner cleanup (#519)', () => {
  test("runTask's finally clears the run's runtime owner (symmetric with runForGroup)", async () => {
    let ownerDuringTask: string | null | undefined;
    queue.enqueueTask(JID, 'task-1', async () => {
      // Mirror production: a task run registers its process (with its runtime
      // owner) while active, just like a message run does.
      queue.registerProcess(JID, fakeProc(), {
        containerName: 'c',
        groupFolder: FOLDER,
        runtimeOwnerId: 'adminA',
      });
      ownerDuringTask = (queue as any).groups.get(JID)?.runtimeOwnerId;
    });
    await tick();
    await tick();
    const state = (queue as any).groups.get(JID);
    expect(ownerDuringTask).toBe('adminA'); // the owner really was stamped mid-run
    expect(state?.active).toBe(false); // the real runTask finally has executed…
    expect(state?.runtimeOwnerId).toBeNull(); // …and cleared the per-run owner
  });
});
