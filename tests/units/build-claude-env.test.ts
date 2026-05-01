import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import type {
  ClaudeProviderConfig,
  ProviderBackend,
} from '../../src/runtime-config.js';

type RuntimeConfigModule = typeof import('../../src/runtime-config.js') & {
  shouldStripClaudeOAuthArtifacts?: (backend?: ProviderBackend) => boolean;
  shouldStripInheritedAnthropicAuthToken?: (
    backend: ProviderBackend | undefined,
    env: Record<string, string | undefined>,
  ) => boolean;
};

const tempDirs: string[] = [];

function makeTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-claude-env-'));
  tempDirs.push(dir);
  return dir;
}

async function importRuntimeConfig(): Promise<RuntimeConfigModule> {
  const dataDir = makeTempDataDir();
  vi.resetModules();
  vi.doMock('../../src/config.js', async () => ({
    ASSISTANT_NAME: 'HappyClaw',
    DATA_DIR: dataDir,
  }));
  return import('../../src/runtime-config.js') as Promise<RuntimeConfigModule>;
}

function providerConfig(
  overrides: Partial<ClaudeProviderConfig> = {},
): ClaudeProviderConfig {
  return {
    anthropicBaseUrl: '',
    anthropicAuthToken: '',
    anthropicApiKey: '',
    claudeCodeOauthToken: '',
    claudeOAuthCredentials: null,
    anthropicModel: '',
    updatedAt: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.doUnmock('../../src/config.js');
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('buildClaudeEnvLines', () => {
  test('preserves legacy third-party env behavior when backend is omitted', async () => {
    const runtime = await importRuntimeConfig();

    const lines = runtime.buildClaudeEnvLines(
      providerConfig({
        anthropicBaseUrl: 'https://gateway.example.com',
        anthropicAuthToken: 'third-party-token',
        anthropicModel: 'claude-compatible-model',
      }),
      {},
    );

    expect(lines).toEqual([
      'ANTHROPIC_BASE_URL=https://gateway.example.com',
      'ANTHROPIC_API_KEY=third-party-token',
      'ANTHROPIC_MODEL=claude-compatible-model',
    ]);
    expect(lines).not.toContain('ANTHROPIC_AUTH_TOKEN=third-party-token');
    expect(lines).not.toContain('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1');
  });

  test('adds experimental beta opt-out for anthropic messages backend when enabled', async () => {
    const runtime = await importRuntimeConfig();

    const lines = runtime.buildClaudeEnvLines(
      providerConfig({
        backend: 'anthropic_messages',
        disableExperimentalBetas: true,
        anthropicBaseUrl: 'https://gateway.example.com',
        anthropicAuthToken: 'third-party-token',
        anthropicModel: 'claude-compatible-model',
      }),
      {},
    );

    expect(lines).toContain('ANTHROPIC_BASE_URL=https://gateway.example.com');
    expect(lines).toContain('ANTHROPIC_API_KEY=third-party-token');
    expect(lines).toContain('ANTHROPIC_MODEL=claude-compatible-model');
    expect(lines).toContain('CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1');
    expect(lines).not.toContain('ANTHROPIC_AUTH_TOKEN=third-party-token');
  });

  test('preserves token-only third-party auth behavior for migrated providers', async () => {
    const runtime = await importRuntimeConfig();

    const lines = runtime.buildClaudeEnvLines(
      providerConfig({
        backend: 'anthropic_messages',
        anthropicAuthToken: 'third-party-token',
        anthropicModel: 'claude-compatible-model',
      }),
      {},
    );

    expect(lines).toEqual([
      'ANTHROPIC_AUTH_TOKEN=third-party-token',
      'ANTHROPIC_MODEL=claude-compatible-model',
    ]);
  });

  test('keeps official Anthropic auth env behavior', async () => {
    const runtime = await importRuntimeConfig();

    const legacyTokenLines = runtime.buildClaudeEnvLines(
      providerConfig({
        backend: 'anthropic_official',
        claudeCodeOauthToken: 'oauth-token',
        anthropicApiKey: 'api-key',
        anthropicAuthToken: 'auth-token',
        anthropicModel: 'claude-sonnet-4-5',
      }),
      {},
    );

    expect(legacyTokenLines).toEqual([
      'CLAUDE_CODE_OAUTH_TOKEN=oauth-token',
      'ANTHROPIC_API_KEY=api-key',
      'ANTHROPIC_AUTH_TOKEN=auth-token',
      'ANTHROPIC_MODEL=claude-sonnet-4-5',
    ]);

    const credentialFileLines = runtime.buildClaudeEnvLines(
      providerConfig({
        backend: 'anthropic_official',
        claudeCodeOauthToken: 'oauth-token',
        claudeOAuthCredentials: {
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          expiresAt: 1_800_000_000_000,
          scopes: ['user:inference'],
        },
        anthropicApiKey: 'api-key',
        anthropicAuthToken: 'auth-token',
        anthropicModel: 'claude-sonnet-4-5',
      }),
      {},
    );

    expect(credentialFileLines).toEqual([
      'ANTHROPIC_API_KEY=api-key',
      'ANTHROPIC_AUTH_TOKEN=auth-token',
      'ANTHROPIC_MODEL=claude-sonnet-4-5',
    ]);
  });

  test('merges custom env and skips reserved Claude env keys', async () => {
    const runtime = await importRuntimeConfig();

    const lines = runtime.buildClaudeEnvLines(
      providerConfig({
        backend: 'anthropic_messages',
        anthropicBaseUrl: 'https://gateway.example.com',
        anthropicAuthToken: 'third-party-token',
        anthropicModel: 'claude-compatible-model',
      }),
      {
        CUSTOM_FLAG: 'enabled',
        ANTHROPIC_BASE_URL: 'https://reserved.example.com',
        ANTHROPIC_AUTH_TOKEN: 'reserved-token',
        ANTHROPIC_MODEL: 'reserved-model',
        CLAUDE_CODE_OAUTH_TOKEN: 'reserved-oauth-token',
      },
    );

    expect(lines).toContain('CUSTOM_FLAG=enabled');
    expect(lines).toContain('ANTHROPIC_BASE_URL=https://gateway.example.com');
    expect(lines).toContain('ANTHROPIC_API_KEY=third-party-token');
    expect(lines).toContain('ANTHROPIC_MODEL=claude-compatible-model');
    expect(lines).not.toContain(
      'ANTHROPIC_BASE_URL=https://reserved.example.com',
    );
    expect(lines).not.toContain('ANTHROPIC_AUTH_TOKEN=reserved-token');
    expect(lines).not.toContain('ANTHROPIC_MODEL=reserved-model');
    expect(lines).not.toContain('CLAUDE_CODE_OAUTH_TOKEN=reserved-oauth-token');
  });
});

describe('Claude env helper dispatch', () => {
  test('shouldStripClaudeOAuthArtifacts only strips for anthropic messages', async () => {
    const runtime = await importRuntimeConfig();

    expect(runtime.shouldStripClaudeOAuthArtifacts).toBeTypeOf('function');
    expect(
      runtime.shouldStripClaudeOAuthArtifacts?.('anthropic_official'),
    ).toBe(false);
    expect(
      runtime.shouldStripClaudeOAuthArtifacts?.('anthropic_messages'),
    ).toBe(true);
    expect(runtime.shouldStripClaudeOAuthArtifacts?.()).toBe(false);
  });

  test('shouldStripInheritedAnthropicAuthToken respects backend and explicit env', async () => {
    const runtime = await importRuntimeConfig();

    expect(runtime.shouldStripInheritedAnthropicAuthToken).toBeTypeOf(
      'function',
    );
    expect(
      runtime.shouldStripInheritedAnthropicAuthToken?.('anthropic_messages', {
        ANTHROPIC_AUTH_TOKEN: 'x',
      }),
    ).toBe(false);
    expect(
      runtime.shouldStripInheritedAnthropicAuthToken?.(
        'anthropic_messages',
        {},
      ),
    ).toBe(true);
    expect(
      runtime.shouldStripInheritedAnthropicAuthToken?.(
        'anthropic_official',
        {},
      ),
    ).toBe(false);
    expect(
      runtime.shouldStripInheritedAnthropicAuthToken?.(undefined, {}),
    ).toBe(false);
  });

  test('mergeClaudeEnvConfig treats per-container base URL overrides as third-party compatible', async () => {
    const runtime = await importRuntimeConfig();

    const merged = runtime.mergeClaudeEnvConfig(
      providerConfig({
        backend: 'anthropic_official',
        claudeCodeOauthToken: 'oauth-token',
        claudeOAuthCredentials: {
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          expiresAt: 1_800_000_000_000,
          scopes: ['user:inference'],
        },
      }),
      {
        anthropicBaseUrl: 'https://gateway.example.com',
        anthropicAuthToken: '',
        anthropicApiKey: '',
        claudeCodeOauthToken: '',
        claudeOAuthCredentials: null,
        anthropicModel: '',
        customEnv: {},
      },
    );

    expect(merged.backend).toBe('anthropic_messages');
    expect(merged.claudeCodeOauthToken).toBe('');
    expect(merged.claudeOAuthCredentials).toBeNull();
  });
});
