import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

type RuntimeConfigModule = typeof import('../../src/runtime-config.js');

const tempDirs: string[] = [];

function makeTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-validation-'));
  tempDirs.push(dir);
  return dir;
}

async function importRuntimeConfig(
  dataDir: string,
): Promise<RuntimeConfigModule> {
  vi.resetModules();
  vi.doMock('../../src/config.js', async () => ({
    ASSISTANT_NAME: 'HappyClaw',
    DATA_DIR: dataDir,
  }));
  return import('../../src/runtime-config.js');
}

afterEach(() => {
  vi.doUnmock('../../src/config.js');
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('validateProviderFinalState', () => {
  test('direct bedrock provider with no baseUrl/token is valid (cloud auth via customEnv)', async () => {
    const runtime = await importRuntimeConfig(makeTempDataDir());

    // Direct bedrock providers authenticate via AWS credential chain — they
    // legitimately ship without baseUrl or auth token. The previous
    // schema-level "third_party requires baseUrl or authToken" rule wrongly
    // rejected these.
    const provider = runtime.createProvider({
      name: 'AWS Bedrock Direct',
      type: 'third_party',
      backend: 'bedrock',
      customEnv: {
        AWS_REGION: 'us-east-1',
        AWS_PROFILE: 'bedrock-prod',
      },
    });

    expect(provider.backend).toBe('bedrock');
    expect(provider.anthropicBaseUrl).toBe('');
    expect(provider.anthropicAuthToken).toBe('');
  });

  test('direct vertex provider with no baseUrl/token is valid (cloud auth via customEnv)', async () => {
    const runtime = await importRuntimeConfig(makeTempDataDir());

    const provider = runtime.createProvider({
      name: 'GCP Vertex Direct',
      type: 'third_party',
      backend: 'vertex',
      customEnv: {
        ANTHROPIC_VERTEX_PROJECT_ID: 'my-project',
        CLOUD_ML_REGION: 'us-east5',
      },
    });

    expect(provider.backend).toBe('vertex');
  });

  test('foundry create requires API key (apiKey or authToken)', async () => {
    const runtime = await importRuntimeConfig(makeTempDataDir());

    expect(() =>
      runtime.createProvider({
        name: 'Foundry No Key',
        type: 'third_party',
        backend: 'foundry',
        anthropicBaseUrl: 'https://foundry.example.com',
      }),
    ).toThrow(/Foundry/);
  });

  test('foundry created with API key, then secrets endpoint clearing the key, must throw', async () => {
    const runtime = await importRuntimeConfig(makeTempDataDir());

    const created = runtime.createProvider({
      name: 'Foundry',
      type: 'third_party',
      backend: 'foundry',
      anthropicBaseUrl: 'https://foundry.example.com',
      anthropicApiKey: 'foundry-key',
    });

    // Clearing the only credential leaves the provider with just
    // CLAUDE_CODE_USE_FOUNDRY=1 and no auth — final-state validation should
    // refuse the write.
    expect(() =>
      runtime.updateProviderSecrets(created.id, {
        clearAnthropicApiKey: true,
      }),
    ).toThrow(/Foundry/);
  });

  test('foundry secrets clear is allowed when authToken still provides credentials', async () => {
    const runtime = await importRuntimeConfig(makeTempDataDir());

    const created = runtime.createProvider({
      name: 'Foundry With Both',
      type: 'third_party',
      backend: 'foundry',
      anthropicBaseUrl: 'https://foundry.example.com',
      anthropicApiKey: 'foundry-key',
      anthropicAuthToken: 'foundry-fallback-token',
    });

    // Should NOT throw — authToken still satisfies the foundry credential check.
    const updated = runtime.updateProviderSecrets(created.id, {
      clearAnthropicApiKey: true,
    });
    expect(updated.anthropicApiKey).toBe('');
    expect(updated.anthropicAuthToken).toBe('foundry-fallback-token');
  });

  test('bedrock_gateway create requires baseUrl', async () => {
    const runtime = await importRuntimeConfig(makeTempDataDir());

    expect(() =>
      runtime.createProvider({
        name: 'Bedrock Gateway No URL',
        type: 'third_party',
        backend: 'bedrock_gateway',
      }),
    ).toThrow(/Bedrock 网关/);
  });

  test('bedrock_gateway updateProvider rejects clearing baseUrl in final state', async () => {
    const runtime = await importRuntimeConfig(makeTempDataDir());

    const created = runtime.createProvider({
      name: 'Bedrock Gateway',
      type: 'third_party',
      backend: 'bedrock_gateway',
      anthropicBaseUrl: 'https://bedrock.example.com',
    });

    // Patch keeps backend the same but clears baseUrl — final state is invalid.
    expect(() =>
      runtime.updateProvider(created.id, {
        anthropicBaseUrl: '',
      }),
    ).toThrow(/Bedrock 网关/);
  });

  test('bedrock_gateway updateProvider succeeds when only unrelated fields change', async () => {
    const runtime = await importRuntimeConfig(makeTempDataDir());

    const created = runtime.createProvider({
      name: 'Bedrock Gateway',
      type: 'third_party',
      backend: 'bedrock_gateway',
      anthropicBaseUrl: 'https://bedrock.example.com',
      anthropicModel: 'old-model',
    });

    const updated = runtime.updateProvider(created.id, {
      anthropicModel: 'new-model',
    });
    expect(updated.anthropicBaseUrl).toBe('https://bedrock.example.com');
    expect(updated.anthropicModel).toBe('new-model');
  });

  test('vertex_gateway create requires baseUrl', async () => {
    const runtime = await importRuntimeConfig(makeTempDataDir());

    expect(() =>
      runtime.createProvider({
        name: 'Vertex Gateway No URL',
        type: 'third_party',
        backend: 'vertex_gateway',
      }),
    ).toThrow(/Vertex 网关/);
  });

  test('anthropic_messages create requires baseUrl + (authToken or apiKey)', async () => {
    const runtime = await importRuntimeConfig(makeTempDataDir());

    expect(() =>
      runtime.createProvider({
        name: 'Third Party No URL',
        type: 'third_party',
        backend: 'anthropic_messages',
        anthropicAuthToken: 'token-without-url',
      }),
    ).toThrow(/Base URL/);

    expect(() =>
      runtime.createProvider({
        name: 'Third Party No Cred',
        type: 'third_party',
        backend: 'anthropic_messages',
        anthropicBaseUrl: 'https://gateway.example.com',
      }),
    ).toThrow(/Auth Token 或 API Key/);

    // With both baseUrl and a credential the provider should be created.
    const ok = runtime.createProvider({
      name: 'Third Party OK',
      type: 'third_party',
      backend: 'anthropic_messages',
      anthropicBaseUrl: 'https://gateway.example.com',
      anthropicAuthToken: 'real-token',
    });
    expect(ok.backend).toBe('anthropic_messages');
  });

  test('anthropic_official create requires API key or OAuth credential', async () => {
    const runtime = await importRuntimeConfig(makeTempDataDir());

    expect(() =>
      runtime.createProvider({
        name: 'Official No Key',
        type: 'official',
        backend: 'anthropic_official',
      }),
    ).toThrow(/官方/);

    const ok = runtime.createProvider({
      name: 'Official OK',
      type: 'official',
      backend: 'anthropic_official',
      anthropicApiKey: 'sk-ant-real-key',
    });
    expect(ok.backend).toBe('anthropic_official');
  });
});
