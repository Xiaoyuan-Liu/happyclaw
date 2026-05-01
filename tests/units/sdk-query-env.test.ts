import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const tempDirs: string[] = [];

function makeTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdk-query-env-'));
  tempDirs.push(dir);
  return dir;
}

// Snapshot of env keys we mutate in this test file. Restored in afterEach so
// no test pollutes process.env globally.
const ENV_KEYS_TO_TRACK = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_FOUNDRY_BASE_URL',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'CLAUDE_AGENT_SDK_CLIENT_APP',
];

let envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  envBackup = {};
  for (const key of ENV_KEYS_TO_TRACK) {
    envBackup[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  vi.doUnmock('../../src/config.js');
  vi.doUnmock('@anthropic-ai/claude-agent-sdk');
  vi.resetModules();
  for (const [key, value] of Object.entries(envBackup)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface CapturedCall {
  optionsEnv: Record<string, string | undefined> | undefined;
  processEnvAtCall: NodeJS.ProcessEnv;
}

async function setupSdkQueryWithProvider(opts: {
  providerSetup: (
    runtime: typeof import('../../src/runtime-config.js'),
  ) => void;
  capture: (call: CapturedCall) => void;
}): Promise<typeof import('../../src/sdk-query.js')> {
  const dataDir = makeTempDataDir();
  vi.resetModules();
  vi.doMock('../../src/config.js', async () => ({
    ASSISTANT_NAME: 'HappyClaw',
    DATA_DIR: dataDir,
  }));

  // Mock the SDK query function: capture both the explicit options.env that
  // sdkQuery passes (which is what the SDK subprocess actually sees) and
  // process.env at call time (must be untouched by sdkQuery).
  vi.doMock('@anthropic-ai/claude-agent-sdk', () => {
    return {
      query: (input: { options?: { env?: Record<string, string> } }) => {
        opts.capture({
          optionsEnv: input.options?.env,
          processEnvAtCall: { ...process.env },
        });
        async function* gen() {
          yield {
            type: 'result' as const,
            subtype: 'success' as const,
            result: 'mock-response',
          };
        }
        return gen();
      },
    };
  });

  const runtime = await import('../../src/runtime-config.js');
  opts.providerSetup(runtime);

  return import('../../src/sdk-query.js');
}

describe('sdkQuery env isolation via options.env', () => {
  test('switching from anthropic_official to anthropic_messages strips inherited ANTHROPIC_API_KEY', async () => {
    // Simulate the dangerous case: previous run on anthropic_official left
    // ANTHROPIC_API_KEY in process.env. New active provider is
    // anthropic_messages (gateway) which authenticates via ANTHROPIC_AUTH_TOKEN
    // → ANTHROPIC_API_KEY mapping. Without reserved cleanup, the stale key
    // leaks through.
    process.env.ANTHROPIC_API_KEY = 'leaked-official-api-key';

    let captured: CapturedCall | null = null;
    const sdk = await setupSdkQueryWithProvider({
      providerSetup: (runtime) => {
        runtime.createProvider({
          name: 'Third-party Gateway',
          type: 'third_party',
          backend: 'anthropic_messages',
          enabled: true,
          anthropicBaseUrl: 'https://gateway.example.com',
          anthropicAuthToken: 'gateway-token',
        });
      },
      capture: (call) => {
        captured = call;
      },
    });

    const result = await sdk.sdkQuery('test prompt');
    expect(result).toBe('mock-response');
    expect(captured).not.toBeNull();
    const subprocessEnv = captured!.optionsEnv!;

    // The env handed to the SDK subprocess must reflect the active provider's
    // mapping (gateway-token), NOT the stale leaked-official-api-key.
    expect(subprocessEnv.ANTHROPIC_API_KEY).toBe('gateway-token');
    expect(subprocessEnv.ANTHROPIC_API_KEY).not.toBe('leaked-official-api-key');
    expect(subprocessEnv.ANTHROPIC_BASE_URL).toBe('https://gateway.example.com');
  });

  test('switching back from bedrock_gateway to anthropic_official strips CLAUDE_CODE_USE_BEDROCK', async () => {
    // Simulate: previous bedrock_gateway run left CLAUDE_CODE_USE_BEDROCK=1
    // and CLAUDE_CODE_SKIP_BEDROCK_AUTH=1 in process.env. New active provider
    // is anthropic_official; without reserved cleanup, the SDK subprocess
    // would still dispatch to Bedrock.
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH = '1';
    process.env.ANTHROPIC_BEDROCK_BASE_URL = 'https://stale-bedrock.example.com';

    let captured: CapturedCall | null = null;
    const sdk = await setupSdkQueryWithProvider({
      providerSetup: (runtime) => {
        runtime.createProvider({
          name: 'Official',
          type: 'official',
          backend: 'anthropic_official',
          enabled: true,
          anthropicApiKey: 'sk-ant-real',
        });
      },
      capture: (call) => {
        captured = call;
      },
    });

    await sdk.sdkQuery('test prompt');
    const subprocessEnv = captured!.optionsEnv!;

    expect(subprocessEnv.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(subprocessEnv.CLAUDE_CODE_SKIP_BEDROCK_AUTH).toBeUndefined();
    expect(subprocessEnv.ANTHROPIC_BEDROCK_BASE_URL).toBeUndefined();
    expect(subprocessEnv.ANTHROPIC_API_KEY).toBe('sk-ant-real');
  });

  test('process.env is never mutated by sdkQuery (no global side effect)', async () => {
    // Pre-state: ANTHROPIC_API_KEY exists with a "host" value, no ANTHROPIC_BASE_URL.
    process.env.ANTHROPIC_API_KEY = 'host-key';
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();

    let captured: CapturedCall | null = null;
    const sdk = await setupSdkQueryWithProvider({
      providerSetup: (runtime) => {
        runtime.createProvider({
          name: 'Gateway',
          type: 'third_party',
          backend: 'anthropic_messages',
          enabled: true,
          anthropicBaseUrl: 'https://gateway.example.com',
          anthropicAuthToken: 'gateway-token',
        });
      },
      capture: (call) => {
        captured = call;
      },
    });

    await sdk.sdkQuery('test');

    // process.env at SDK call time is identical to pre-call state — sdkQuery
    // never touched it. (This is the core advantage over the previous
    // mutex+save+restore implementation.)
    expect(captured!.processEnvAtCall.ANTHROPIC_API_KEY).toBe('host-key');
    expect(captured!.processEnvAtCall.ANTHROPIC_BASE_URL).toBeUndefined();

    // Post-call: process.env still untouched.
    expect(process.env.ANTHROPIC_API_KEY).toBe('host-key');
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(process.env.CLAUDE_AGENT_SDK_CLIENT_APP).toBeUndefined();
  });

  test('subprocess env merges process.env essentials (e.g. PATH, HOME)', async () => {
    // The SDK subprocess needs PATH/HOME to spawn the Claude Code CLI binary.
    // sdkQuery copies process.env first, then strips reserved keys, then
    // overlays generated provider env — so non-reserved keys are preserved.
    process.env.PATH = process.env.PATH || '/usr/bin';
    const expectedPath = process.env.PATH;

    let captured: CapturedCall | null = null;
    const sdk = await setupSdkQueryWithProvider({
      providerSetup: (runtime) => {
        runtime.createProvider({
          name: 'Gateway',
          type: 'third_party',
          backend: 'anthropic_messages',
          enabled: true,
          anthropicBaseUrl: 'https://gateway.example.com',
          anthropicAuthToken: 'gateway-token',
        });
      },
      capture: (call) => {
        captured = call;
      },
    });

    await sdk.sdkQuery('test');
    const subprocessEnv = captured!.optionsEnv!;

    expect(subprocessEnv.PATH).toBe(expectedPath);
  });

  test('concurrent sdkQuery calls do not interfere via shared global state', async () => {
    // Without the previous mutex, two parallel calls used to risk corrupting
    // each other through process.env. With options.env each call has its own
    // env bag, so concurrency is safe by construction.
    process.env.ANTHROPIC_API_KEY = 'host-key';

    const captured: CapturedCall[] = [];
    const sdk = await setupSdkQueryWithProvider({
      providerSetup: (runtime) => {
        runtime.createProvider({
          name: 'Gateway',
          type: 'third_party',
          backend: 'anthropic_messages',
          enabled: true,
          anthropicBaseUrl: 'https://gateway.example.com',
          anthropicAuthToken: 'gateway-token',
        });
      },
      capture: (call) => {
        captured.push(call);
      },
    });

    await Promise.all([
      sdk.sdkQuery('a'),
      sdk.sdkQuery('b'),
      sdk.sdkQuery('c'),
    ]);

    expect(captured).toHaveLength(3);
    for (const call of captured) {
      // Each call sees its own clean subprocessEnv with the active gateway
      // mapping; process.env stays at host-key throughout.
      expect(call.optionsEnv!.ANTHROPIC_API_KEY).toBe('gateway-token');
      expect(call.processEnvAtCall.ANTHROPIC_API_KEY).toBe('host-key');
    }
    expect(process.env.ANTHROPIC_API_KEY).toBe('host-key');
  });
});
