import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

type RuntimeConfigModule = typeof import('../../src/runtime-config.js');

interface StoredProviderJson {
  id: string;
  backend?: string;
  disableExperimentalBetas?: boolean;
  secrets?: unknown;
  [key: string]: unknown;
}

interface StoredProviderConfigJson {
  version: number;
  providers: StoredProviderJson[];
  balancing?: unknown;
  updatedAt?: unknown;
}

const tempDirs: string[] = [];

function makeTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-migration-'));
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

function providerConfigPath(dataDir: string): string {
  return path.join(dataDir, 'config', 'claude-provider.json');
}

function providerPoolPath(dataDir: string): string {
  return path.join(dataDir, 'config', 'provider-pool.json');
}

function readProviderConfig(dataDir: string): StoredProviderConfigJson {
  return JSON.parse(fs.readFileSync(providerConfigPath(dataDir), 'utf-8'));
}

function writeProviderConfig(dataDir: string, payload: unknown): void {
  fs.writeFileSync(
    providerConfigPath(dataDir),
    JSON.stringify(payload, null, 2) + '\n',
    'utf-8',
  );
}

afterEach(() => {
  vi.doUnmock('../../src/config.js');
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('provider config V4 to V5 migration', () => {
  test('migrates legacy provider types to explicit backends and preserves runtime fields', async () => {
    const dataDir = makeTempDataDir();
    const initialRuntime = await importRuntimeConfig(dataDir);

    const official = initialRuntime.createProvider({
      name: 'Official Claude',
      type: 'official',
      enabled: false,
      weight: 7,
      anthropicApiKey: 'sk-ant-official-secret',
      claudeCodeOauthToken: 'oauth-official-secret',
      customEnv: { OFFICIAL_ENV: 'kept' },
    });
    const thirdParty = initialRuntime.createProvider({
      name: 'Third Party',
      type: 'third_party',
      enabled: true,
      weight: 13,
      anthropicBaseUrl: 'https://proxy.example.com',
      anthropicAuthToken: 'third-party-auth-secret',
      anthropicModel: 'claude-test-model',
      customEnv: { THIRD_PARTY_ENV: 'also-kept' },
    });
    initialRuntime.saveBalancingConfig({
      strategy: 'weighted-round-robin',
      unhealthyThreshold: 5,
      recoveryIntervalMs: 123_456,
    });

    const v5 = readProviderConfig(dataDir);
    const v4 = {
      version: 4,
      providers: v5.providers.map((provider) => {
        const {
          backend: _backend,
          disableExperimentalBetas: _disableExperimentalBetas,
          ...v4Provider
        } = provider;
        return v4Provider;
      }),
      balancing: v5.balancing,
      updatedAt: v5.updatedAt,
    };
    writeProviderConfig(dataDir, v4);

    const migratingRuntime = await importRuntimeConfig(dataDir);
    const providers = migratingRuntime.getProviders();
    const balancing = migratingRuntime.getBalancingConfig();
    const migratedFile = readProviderConfig(dataDir);

    const migratedOfficial = providers.find((p) => p.id === official.id);
    const migratedThirdParty = providers.find((p) => p.id === thirdParty.id);
    expect(migratedOfficial).toBeDefined();
    expect(migratedThirdParty).toBeDefined();

    expect(migratedOfficial).toMatchObject({
      backend: 'anthropic_official',
      enabled: false,
      weight: 7,
      customEnv: { OFFICIAL_ENV: 'kept' },
    });
    expect(migratedOfficial?.disableExperimentalBetas).toBeUndefined();

    expect(migratedThirdParty).toMatchObject({
      backend: 'anthropic_messages',
      enabled: true,
      weight: 13,
      anthropicBaseUrl: 'https://proxy.example.com',
      anthropicModel: 'claude-test-model',
      customEnv: { THIRD_PARTY_ENV: 'also-kept' },
    });
    expect(migratedThirdParty?.disableExperimentalBetas).toBeUndefined();

    expect(balancing).toEqual({
      strategy: 'weighted-round-robin',
      unhealthyThreshold: 5,
      recoveryIntervalMs: 123_456,
    });

    expect(migratedFile.version).toBe(5);
    expect(
      migratedFile.providers.find((p) => p.id === official.id)?.backend,
    ).toBe('anthropic_official');
    expect(
      migratedFile.providers.find((p) => p.id === thirdParty.id)?.backend,
    ).toBe('anthropic_messages');
    expect(
      migratedFile.providers.find((p) => p.id === thirdParty.id)
        ?.disableExperimentalBetas,
    ).toBeUndefined();

    for (const legacyProvider of v4.providers) {
      expect(
        migratedFile.providers.find((p) => p.id === legacyProvider.id)?.secrets,
      ).toEqual(legacyProvider.secrets);
    }

    const publicOfficial = migratingRuntime.toPublicProvider(migratedOfficial!);
    const publicThirdParty = migratingRuntime.toPublicProvider(
      migratedThirdParty!,
    );
    expect(publicOfficial.hasAnthropicApiKey).toBe(true);
    expect(publicOfficial.anthropicApiKeyMasked).toBeTruthy();
    expect(publicOfficial.hasClaudeCodeOauthToken).toBe(true);
    expect(publicOfficial.claudeCodeOauthTokenMasked).toBeTruthy();
    expect(publicThirdParty.hasAnthropicAuthToken).toBe(true);
    expect(publicThirdParty.anthropicAuthTokenMasked).toBeTruthy();
  });

  test('hoists V3 state through V4 into V5 without using the legacy parser', async () => {
    const dataDir = makeTempDataDir();
    const initialRuntime = await importRuntimeConfig(dataDir);

    initialRuntime.createProvider({
      name: 'Official Claude',
      type: 'official',
      enabled: false,
      anthropicApiKey: 'sk-ant-v3-official-secret',
      customEnv: { OFFICIAL_ENV: 'from-v3' },
    });
    const thirdParty = initialRuntime.createProvider({
      name: 'Third Party V3',
      type: 'third_party',
      enabled: true,
      weight: 9,
      anthropicBaseUrl: 'https://v3-proxy.example.com',
      anthropicAuthToken: 'v3-third-party-token',
      anthropicModel: 'claude-v3-model',
      customEnv: { THIRD_ENV: 'from-v3' },
    });

    const generatedV5 = readProviderConfig(dataDir);
    const generatedOfficial = generatedV5.providers.find(
      (p) => p.type === 'official',
    );
    const generatedThirdParty = generatedV5.providers.find(
      (p) => p.id === thirdParty.id,
    );
    expect(generatedOfficial?.secrets).toBeDefined();
    expect(generatedThirdParty?.secrets).toBeDefined();

    writeProviderConfig(dataDir, {
      version: 3,
      activeProfileId: thirdParty.id,
      profiles: [
        {
          id: thirdParty.id,
          name: 'Third Party V3',
          anthropicBaseUrl: 'https://v3-proxy.example.com',
          anthropicModel: 'claude-v3-model',
          updatedAt: thirdParty.updatedAt,
          secrets: generatedThirdParty!.secrets,
          customEnv: { THIRD_ENV: 'from-v3' },
        },
      ],
      official: {
        updatedAt: generatedOfficial!.updatedAt,
        secrets: generatedOfficial!.secrets,
        customEnv: { OFFICIAL_ENV: 'from-v3' },
      },
    });
    writeProviderConfig(dataDir, readProviderConfig(dataDir));
    fs.writeFileSync(
      providerPoolPath(dataDir),
      JSON.stringify(
        {
          version: 1,
          mode: 'pool',
          strategy: 'failover',
          unhealthyThreshold: 4,
          recoveryIntervalMs: 98_765,
          members: [
            {
              profileId: thirdParty.id,
              weight: 21,
              enabled: true,
            },
          ],
        },
        null,
        2,
      ) + '\n',
      'utf-8',
    );

    const migratingRuntime = await importRuntimeConfig(dataDir);
    const providers = migratingRuntime.getProviders();
    const balancing = migratingRuntime.getBalancingConfig();
    const migratedFile = readProviderConfig(dataDir);

    const migratedThirdParty = providers.find((p) => p.id === thirdParty.id);
    expect(migratedThirdParty).toMatchObject({
      backend: 'anthropic_messages',
      enabled: true,
      weight: 21,
      anthropicBaseUrl: 'https://v3-proxy.example.com',
      anthropicModel: 'claude-v3-model',
      customEnv: { THIRD_ENV: 'from-v3' },
    });
    expect(
      migratingRuntime.toPublicProvider(migratedThirdParty!)
        .hasAnthropicAuthToken,
    ).toBe(true);
    expect(providers.find((p) => p.type === 'official')).toMatchObject({
      backend: 'anthropic_official',
      customEnv: { OFFICIAL_ENV: 'from-v3' },
    });
    expect(balancing).toEqual({
      strategy: 'failover',
      unhealthyThreshold: 4,
      recoveryIntervalMs: 98_765,
    });
    expect(migratedFile.version).toBe(5);
    expect(
      migratedFile.providers.find((p) => p.id === thirdParty.id)?.backend,
    ).toBe('anthropic_messages');
  });

  test('deprecated V3 writer refuses to overwrite an existing V5 provider config', async () => {
    const dataDir = makeTempDataDir();
    const runtime = await importRuntimeConfig(dataDir);

    runtime.createProvider({
      name: 'Third Party',
      type: 'third_party',
      anthropicBaseUrl: 'https://proxy.example.com',
      anthropicAuthToken: 'third-party-auth-secret',
    });
    const before = readProviderConfig(dataDir);

    expect(() =>
      runtime.saveClaudeProviderConfig(
        {
          anthropicBaseUrl: 'https://other.example.com',
          anthropicAuthToken: 'other-token',
          anthropicApiKey: '',
          claudeCodeOauthToken: '',
          claudeOAuthCredentials: null,
          anthropicModel: '',
        },
        { mode: 'third_party' },
      ),
    ).toThrow('旧版 Claude 配置写入接口不能覆盖统一供应商配置');

    expect(readProviderConfig(dataDir)).toEqual(before);
  });
});
