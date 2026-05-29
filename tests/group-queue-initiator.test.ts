/**
 * Unit tests for GroupQueue's current-run-initiator tracking (the queue half of
 * the stop/interrupt resource-level ACL).
 *
 * Invariants under test:
 *   - the initiator passed to enqueueMessageCheck is visible via
 *     getActiveRunInitiator while that run is active;
 *   - a sender whose message is IPC-injected into an already-active run does
 *     NOT become the initiator (方案 A: only the run-starter);
 *   - the initiator is cleared back to null once the run goes idle;
 *   - an enqueue with no initiator yields a null initiator (→ owner-only).
 *
 * processMessagesFn is stubbed and observes the initiator from inside the run,
 * so assertions don't depend on fragile external timing.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, DATA_DIR: '/tmp/happyclaw-queue-initiator-test' };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

// killProcessTree pulls the heavy container-runner graph; the gated tests never
// spawn a real process, so stub it out.
vi.mock('../src/container-runner.js', () => ({
  killProcessTree: () => {},
}));

// Force capacity to 1 so the leak test can hold the single slot with one run and
// keep a second jid capacity-queued (the exact precondition for the task-leak).
vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({ maxConcurrentContainers: 1, maxConcurrentHostProcesses: 1 }),
}));

// drainWaiting calls getTaskById to skip cancelled scheduled tasks; a dynamic
// task (no DB row) must be treated as live → return undefined.
vi.mock('../src/db.js', () => ({
  getTaskById: () => undefined,
}));

const { GroupQueue } = await import('../src/group-queue.js');

const tick = () => new Promise((r) => setImmediate(r));
const JID = 'web:initiator-test';

let queue: InstanceType<typeof GroupQueue>;
let observed: Array<string | null>;
let blocking: boolean;
let resolveGate: (() => void) | null;

beforeEach(() => {
  queue = new GroupQueue();
  observed = [];
  blocking = true;
  resolveGate = null;
  queue.setProcessMessagesFn(async (jid: string) => {
    observed.push(queue.getActiveRunInitiator(jid));
    if (blocking) {
      await new Promise<void>((r) => {
        resolveGate = r;
      });
    }
    return true;
  });
});

afterEach(async () => {
  // Release any still-gated run so the queue settles before the next test.
  blocking = false;
  resolveGate?.();
  await tick();
  await tick();
});

describe('GroupQueue current-run initiator', () => {
  test('records the initiator and exposes it while the run is active', async () => {
    expect(queue.getActiveRunInitiator(JID)).toBe(null); // idle

    queue.enqueueMessageCheck(JID, 'alice');
    await tick();

    expect(observed[0]).toBe('alice'); // visible from inside the run
    expect(queue.getActiveRunInitiator(JID)).toBe('alice');
  });

  test('IPC-injected sender does not become the initiator', async () => {
    queue.enqueueMessageCheck(JID, 'alice'); // starts the run (blocks on gate)
    await tick();
    expect(queue.getActiveRunInitiator(JID)).toBe('alice');

    queue.enqueueMessageCheck(JID, 'bob'); // active → injected, must not override
    expect(queue.getActiveRunInitiator(JID)).toBe('alice');
  });

  test('clears the initiator once the run goes idle', async () => {
    queue.enqueueMessageCheck(JID, 'alice');
    await tick();
    expect(queue.getActiveRunInitiator(JID)).toBe('alice');

    blocking = false;
    resolveGate?.();
    await tick();
    await tick();

    expect(queue.getActiveRunInitiator(JID)).toBe(null);
  });

  test('an enqueue with no initiator yields a null initiator (owner-only)', async () => {
    queue.enqueueMessageCheck(JID); // no initiator supplied
    await tick();
    expect(observed[0]).toBe(null);
    expect(queue.getActiveRunInitiator(JID)).toBe(null);
  });

  test('a TASK run does not expose a pending message initiator (no over-grant)', async () => {
    // Hold the single capacity slot with an unrelated message run.
    queue.enqueueMessageCheck('web:holder', 'holder');
    await tick();
    // JID's message is now capacity-queued: it records initiator 'bob' but does
    // NOT go active (capacity full).
    queue.enqueueMessageCheck(JID, 'bob');
    // A base-jid task (e.g. terminal warmup) is queued on the SAME jid.
    let taskObserved: string | null | undefined;
    let releaseTask: () => void = () => {};
    let signalObserved: () => void = () => {};
    // Wait on an explicit signal fired from inside the task fn rather than a
    // fixed tick count: the fn samples getActiveRunInitiator while THIS task run
    // is active (activeRunnerIsTask=true), so the read is deterministic
    // regardless of how many microtask turns the holder-free → drain → runTask
    // chain takes under load. (A fixed `await tick()` count was flaky in the
    // full parallel suite.)
    const observed = new Promise<void>((r) => {
      signalObserved = r;
    });
    queue.enqueueTask(JID, 'warmup-dynamic', async () => {
      taskObserved = queue.getActiveRunInitiator(JID);
      signalObserved();
      await new Promise<void>((r) => {
        releaseTask = r;
      });
    });
    // Free the slot → drain runs JID's TASK first (tasks-first) while
    // currentRunInitiator(JID) still holds 'bob'.
    blocking = false;
    resolveGate?.();
    await observed;
    // The task run must NOT report 'bob' (it's a task, not bob's message run).
    expect(taskObserved).toBe(null);
    releaseTask();
    await tick();
  });

  test('resolves the initiator across sibling jids sharing a serialization key', async () => {
    queue.setSerializationKeyResolver((jid: string) =>
      jid.startsWith('web:sib') ? 'shared-folder' : jid,
    );
    queue.enqueueMessageCheck('web:sib1', 'alice'); // run starts on sib1
    await tick();
    // sib2 shares the serialization key → resolves to sib1's active runner.
    expect(queue.getActiveRunInitiator('web:sib2')).toBe('alice');
  });
});
