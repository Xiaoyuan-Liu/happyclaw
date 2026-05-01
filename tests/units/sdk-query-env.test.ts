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

async function setupSdkQueryWithProvider(opts: {
  providerSetup: (
    runtime: typeof import('../../src/runtime-config.js'),
  ) => void;
  capture: (env: NodeJS.ProcessEnv) => void;
}): Promise<typeof import('../../src/sdk-query.js')> {
  const dataDir = makeTempDataDir();
  vi.resetModules();
  vi.doMock('../../src/config.js', async () => ({
    ASSISTANT_NAME: 'HappyClaw',
    DATA_DIR: dataDir,
  }));

  // Mock the SDK query function: capture process.env at call time so the test
  // can verify the env state during the SDK call (between inject + restore).
  vi.doMock('@anthropic-ai/claude-agent-sdk', () => {
    return {
      query: () => {
        opts.capture({ ...process.env });
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

describe('sdkQuery reserved-key cleanup', () => {
  test('switching from anthropic_official to anthropic_messages strips inherited ANTHROPIC_API_KEY', async () => {
    // Simulate the dangerous case: previous run on anthropic_official left
    // ANTHROPIC_API_KEY in process.env. New active provider is
    // anthropic_messages (gateway) which authenticates via ANTHROPIC_AUTH_TOKEN
    // → ANTHROPIC_API_KEY mapping. Without reserved cleanup, the stale key
    // leaks through.
    process.env.ANTHROPIC_API_KEY = 'leaked-official-api-key';

    let capturedEnv: NodeJS.ProcessEnv = {};
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
      capture: (env) => {
        capturedEnv = env;
      },
    });

    const result = await sdk.sdkQuery('test prompt');
    expect(result).toBe('mock-response');

    // During the SDK call, ANTHROPIC_API_KEY must reflect the active provider's
    // mapping (gateway-token), NOT the stale leaked-official-api-key.
    expect(capturedEnv.ANTHROPIC_API_KEY).toBe('gateway-token');
    expect(capturedEnv.ANTHROPIC_API_KEY).not.toBe('leaked-official-api-key');
    expect(capturedEnv.ANTHROPIC_BASE_URL).toBe('https://gateway.example.com');
  });

  test('switching back from bedrock_gateway to anthropic_official strips CLAUDE_CODE_USE_BEDROCK', async () => {
    // Simulate: previous bedrock_gateway run left CLAUDE_CODE_USE_BEDROCK=1
    // and CLAUDE_CODE_SKIP_BEDROCK_AUTH=1 in process.env. New active provider
    // is anthropic_official; without reserved cleanup, the SDK would still
    // dispatch to Bedrock.
    process.env.CLAUDE_CODE_USE_BEDROCK = '1';
    process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH = '1';
    process.env.ANTHROPIC_BEDROCK_BASE_URL = 'https://stale-bedrock.example.com';

    let capturedEnv: NodeJS.ProcessEnv = {};
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
      capture: (env) => {
        capturedEnv = env;
      },
    });

    await sdk.sdkQuery('test prompt');

    expect(capturedEnv.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(capturedEnv.CLAUDE_CODE_SKIP_BEDROCK_AUTH).toBeUndefined();
    expect(capturedEnv.ANTHROPIC_BEDROCK_BASE_URL).toBeUndefined();
    expect(capturedEnv.ANTHROPIC_API_KEY).toBe('sk-ant-real');
  });

  test('process.env is fully restored after sdkQuery (including keys that did not exist before)', async () => {
    // Pre-state: ANTHROPIC_API_KEY exists with a "host" value, no ANTHROPIC_BASE_URL.
    process.env.ANTHROPIC_API_KEY = 'host-key';
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();

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
      capture: () => {
        /* not asserting captured env in this test */
      },
    });

    await sdk.sdkQuery('test');

    // After the call, every reserved key must be back to its pre-call state.
    expect(process.env.ANTHROPIC_API_KEY).toBe('host-key');
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(process.env.CLAUDE_AGENT_SDK_CLIENT_APP).toBeUndefined();
  });

  test('reserved keys that did not exist before sdkQuery are deleted (not left as undefined string) after restore', async () => {
    // None of the reserved keys are set pre-call.
    for (const key of ENV_KEYS_TO_TRACK) {
      expect(process.env[key]).toBeUndefined();
    }

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
      capture: () => {
        /* irrelevant */
      },
    });

    await sdk.sdkQuery('test');

    for (const key of ENV_KEYS_TO_TRACK) {
      // `key in process.env` is the strict check: undefined value still counts
      // as present if `process.env[k] = undefined` was used. Restore must
      // actually `delete` so subsequent `key in process.env` is false.
      expect(key in process.env).toBe(false);
    }
  });
});
