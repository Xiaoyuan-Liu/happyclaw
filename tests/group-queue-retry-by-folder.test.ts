/**
 * Regression tests for GroupQueue.getRetryCountByFolder — the folder-domain
 * retry lookup behind the IPC send_message 跨重试去重 (isRetryDuplicateIpcSend).
 *
 * The bug it fixes: retryCount lives on the GroupState keyed by chatJid, but the
 * dedup only knows the source FOLDER (the IPC directory name). The old code
 * guessed the key as `web:<folder>` / `<folder>`, which only ever matched admin
 * home (folder=`main`, chatJid=`web:main`). For a normal web group the chatJid
 * is `web:<uuid>` (routes/groups.ts) — unrelated to the folder — so both guesses
 * missed → inRetry was永远 false → 去重永不触发 → 重试重放的 send_message 重复刷屏。
 *
 * These tests pin the state exactly as it exists DURING a replay run (active +
 * groupFolder set by registerProcess + retryCount bumped by a prior failure).
 * groupFolder / retryCount are otherwise only mutated by the private run loop,
 * so we reach in to seed that precise shape for a deterministic unit test.
 */
import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, DATA_DIR: '/tmp/happyclaw-queue-retry-folder-test' };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

// killProcessTree pulls the heavy container-runner graph; these tests never
// spawn a real process, so stub it out.
vi.mock('../src/container-runner.js', () => ({
  killProcessTree: () => {},
}));

vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({ maxConcurrentContainers: 20, maxConcurrentHostProcesses: 5 }),
}));

vi.mock('../src/db.js', () => ({
  getTaskById: () => undefined,
}));

const { GroupQueue } = await import('../src/group-queue.js');

type AnyQueue = InstanceType<typeof GroupQueue> & {
  getGroup(jid: string): { active: boolean; groupFolder: string | null; retryCount: number };
};

/**
 * Seed a GroupState as it exists DURING an active (replay) run: active=true,
 * groupFolder populated (registerProcess does this in the real path), and
 * retryCount bumped by a previous failure's scheduleRetry.
 */
function seedActiveRun(q: AnyQueue, chatJid: string, folder: string, retryCount: number): void {
  const state = q.getGroup(chatJid);
  state.active = true;
  state.groupFolder = folder;
  state.retryCount = retryCount;
}

describe('GroupQueue.getRetryCountByFolder (IPC send dedup retry key)', () => {
  test('finds retry state for a normal web group whose chatJid ≠ web:<folder>', () => {
    const q = new GroupQueue() as AnyQueue;
    // 普通 web 群：jid = web:<uuid>，folder = flow-...，两者互不相等。
    seedActiveRun(q, 'web:7b1f0c1e-1234-dead-beef', 'flow-abc123', 2);

    // 修复后：按 folder 域查询命中真实重试轮次。
    expect(q.getRetryCountByFolder('flow-abc123')).toBe(2);

    // 回归证据：旧的按键猜测（web:<folder> / <folder>）必然落空 → inRetry 恒 false。
    expect(q.getRetryCount('web:flow-abc123')).toBe(0);
    expect(q.getRetryCount('flow-abc123')).toBe(0);
  });

  test('admin home (folder=main, chatJid=web:main) still works — no regression', () => {
    const q = new GroupQueue() as AnyQueue;
    seedActiveRun(q, 'web:main', 'main', 1);

    expect(q.getRetryCountByFolder('main')).toBe(1);
    // 旧逻辑在 home 上巧合命中（web:${folder} === chatJid），修复后仍命中。
    expect(q.getRetryCount('web:main')).toBe(1);
  });

  test('returns 0 when the folder has no active run (no false suppression)', () => {
    const q = new GroupQueue() as AnyQueue;
    expect(q.getRetryCountByFolder('flow-nonexistent')).toBe(0);
  });

  test('first attempt (retryCount=0) is never treated as in-retry', () => {
    const q = new GroupQueue() as AnyQueue;
    seedActiveRun(q, 'web:uuid-first-try', 'flow-def456', 0);
    expect(q.getRetryCountByFolder('flow-def456')).toBe(0);
  });

  test('takes the max across multiple chatJids mapped to the same folder', () => {
    const q = new GroupQueue() as AnyQueue;
    // 一个 folder 可被多个 chatJid 触达（如 web:main + feishu 群共享 folder）；
    // 取 max 做保守判定，只要有任一活跃 runner 在重试就算 inRetry。
    seedActiveRun(q, 'web:sibling-1', 'shared-folder', 0);
    seedActiveRun(q, 'web:sibling-2', 'shared-folder', 3);
    expect(q.getRetryCountByFolder('shared-folder')).toBe(3);
  });
});
