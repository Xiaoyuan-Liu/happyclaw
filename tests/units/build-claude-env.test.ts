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
      'CLAUDE_AGENT_SDK_CLIENT_APP=happyclaw',
      'ENABLE_TOOL_SEARCH=0',
      'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1',
      'ANTHROPIC_BASE_URL=https://gateway.example.com',
      'ANTHROPIC_API_KEY=third-party-token',
      'ANTHROPIC_MODEL=claude-compatible-model',
    ]);
    expect(lines).not.toContain('ANTHROPIC_AUTH_TOKEN=third-party-token');
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
      'CLAUDE_AGENT_SDK_CLIENT_APP=happyclaw',
      'ENABLE_TOOL_SEARCH=0',
      'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1',
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
      'CLAUDE_AGENT_SDK_CLIENT_APP=happyclaw',
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
      'CLAUDE_AGENT_SDK_CLIENT_APP=happyclaw',
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

  test('bedrock backend emits CLAUDE_CODE_USE_BEDROCK and forwards AWS env via customEnv', async () => {
    const runtime = await importRuntimeConfig();

    const lines = runtime.buildClaudeEnvLines(
      providerConfig({
        backend: 'bedrock',
        anthropicModel: 'anthropic.claude-sonnet-4-5-v1:0',
      }),
      {
        AWS_REGION: 'us-east-1',
        AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
        AWS_SECRET_ACCESS_KEY: 'super-secret',
      },
    );

    expect(lines).toContain('CLAUDE_AGENT_SDK_CLIENT_APP=happyclaw');
    expect(lines).toContain('CLAUDE_CODE_USE_BEDROCK=1');
    expect(lines).toContain('AWS_REGION=us-east-1');
    expect(lines).toContain('AWS_ACCESS_KEY_ID=AKIAEXAMPLE');
    expect(lines).toContain('AWS_SECRET_ACCESS_KEY=super-secret');
    expect(lines).toContain(
      'ANTHROPIC_MODEL=anthropic.claude-sonnet-4-5-v1:0',
    );
    expect(lines.some((l) => l.startsWith('ANTHROPIC_BASE_URL='))).toBe(false);
    expect(lines.some((l) => l.startsWith('ANTHROPIC_AUTH_TOKEN='))).toBe(
      false,
    );
    expect(
      lines.filter((l) => l === 'CLAUDE_AGENT_SDK_CLIENT_APP=happyclaw').length,
    ).toBe(1);
  });

  test('bedrock_gateway backend emits gateway env trio and passes gateway token via customEnv', async () => {
    const runtime = await importRuntimeConfig();

    const lines = runtime.buildClaudeEnvLines(
      providerConfig({
        backend: 'bedrock_gateway',
        anthropicBaseUrl: 'https://bedrock.gateway.example.com',
        anthropicModel: 'anthropic.claude-sonnet-4-5-v1:0',
      }),
      {
        GATEWAY_TOKEN: 'gateway-secret',
      },
    );

    expect(lines).toContain('CLAUDE_AGENT_SDK_CLIENT_APP=happyclaw');
    expect(lines).toContain('CLAUDE_CODE_USE_BEDROCK=1');
    expect(lines).toContain('CLAUDE_CODE_SKIP_BEDROCK_AUTH=1');
    expect(lines).toContain(
      'ANTHROPIC_BEDROCK_BASE_URL=https://bedrock.gateway.example.com',
    );
    expect(lines).toContain('GATEWAY_TOKEN=gateway-secret');
    // ANTHROPIC_BASE_URL must NOT leak — gateway uses the Bedrock-specific var.
    expect(lines.some((l) => l.startsWith('ANTHROPIC_BASE_URL='))).toBe(false);
    // No hard-coded ANTHROPIC_AUTH_TOKEN / API_KEY for gateway tokens.
    expect(lines.some((l) => l.startsWith('ANTHROPIC_AUTH_TOKEN='))).toBe(
      false,
    );
    expect(lines.some((l) => l.startsWith('ANTHROPIC_API_KEY='))).toBe(false);
    expect(
      lines.filter((l) => l === 'CLAUDE_AGENT_SDK_CLIENT_APP=happyclaw').length,
    ).toBe(1);
  });

  test('bedrock_gateway backend injects ANTHROPIC_AUTH_TOKEN when anthropicAuthToken is configured', async () => {
    const runtime = await importRuntimeConfig();

    const lines = runtime.buildClaudeEnvLines(
      providerConfig({
        backend: 'bedrock_gateway',
        anthropicBaseUrl: 'https://bedrock.gateway.example.com',
        anthropicAuthToken: 'gateway-bedrock-token',
        anthropicModel: 'anthropic.claude-sonnet-4-5-v1:0',
      }),
      {},
    );

    expect(lines).toContain('CLAUDE_CODE_USE_BEDROCK=1');
    expect(lines).toContain('CLAUDE_CODE_SKIP_BEDROCK_AUTH=1');
    expect(lines).toContain(
      'ANTHROPIC_BEDROCK_BASE_URL=https://bedrock.gateway.example.com',
    );
    expect(lines).toContain('ANTHROPIC_AUTH_TOKEN=gateway-bedrock-token');
    // No generic ANTHROPIC_BASE_URL leakage.
    expect(lines.some((l) => l.startsWith('ANTHROPIC_BASE_URL='))).toBe(false);
  });

  test('bedrock_gateway backend without auth token does NOT emit ANTHROPIC_AUTH_TOKEN', async () => {
    const runtime = await importRuntimeConfig();

    const lines = runtime.buildClaudeEnvLines(
      providerConfig({
        backend: 'bedrock_gateway',
        anthropicBaseUrl: 'https://bedrock.gateway.example.com',
      }),
      {},
    );

    expect(lines.some((l) => l.startsWith('ANTHROPIC_AUTH_TOKEN='))).toBe(
      false,
    );
  });

  test('vertex backend emits CLAUDE_CODE_USE_VERTEX without base URL and forwards GCP env', async () => {
    const runtime = await importRuntimeConfig();

    const lines = runtime.buildClaudeEnvLines(
      providerConfig({
        backend: 'vertex',
        anthropicModel: 'claude-sonnet-4-5@20250219',
      }),
      {
        ANTHROPIC_VERTEX_PROJECT_ID: 'my-gcp-project',
        CLOUD_ML_REGION: 'us-east5',
      },
    );

    expect(lines).toContain('CLAUDE_AGENT_SDK_CLIENT_APP=happyclaw');
    expect(lines).toContain('CLAUDE_CODE_USE_VERTEX=1');
    expect(lines).toContain('ANTHROPIC_VERTEX_PROJECT_ID=my-gcp-project');
    expect(lines).toContain('CLOUD_ML_REGION=us-east5');
    expect(lines.some((l) => l.startsWith('ANTHROPIC_BASE_URL='))).toBe(false);
    expect(lines.some((l) => l.startsWith('ANTHROPIC_VERTEX_BASE_URL='))).toBe(
      false,
    );
    expect(
      lines.filter((l) => l === 'CLAUDE_AGENT_SDK_CLIENT_APP=happyclaw').length,
    ).toBe(1);
  });

  test('vertex_gateway backend emits gateway env trio and forwards token via customEnv', async () => {
    const runtime = await importRuntimeConfig();

    const lines = runtime.buildClaudeEnvLines(
      providerConfig({
        backend: 'vertex_gateway',
        anthropicBaseUrl: 'https://vertex.gateway.example.com',
        anthropicModel: 'claude-sonnet-4-5@20250219',
      }),
      {
        GATEWAY_TOKEN: 'vertex-gateway-secret',
        ANTHROPIC_VERTEX_PROJECT_ID: 'my-gcp-project',
      },
    );

    expect(lines).toContain('CLAUDE_AGENT_SDK_CLIENT_APP=happyclaw');
    expect(lines).toContain('CLAUDE_CODE_USE_VERTEX=1');
    expect(lines).toContain('CLAUDE_CODE_SKIP_VERTEX_AUTH=1');
    expect(lines).toContain(
      'ANTHROPIC_VERTEX_BASE_URL=https://vertex.gateway.example.com',
    );
    expect(lines).toContain('GATEWAY_TOKEN=vertex-gateway-secret');
    expect(lines).toContain('ANTHROPIC_VERTEX_PROJECT_ID=my-gcp-project');
    expect(lines.some((l) => l.startsWith('ANTHROPIC_BASE_URL='))).toBe(false);
    expect(lines.some((l) => l.startsWith('ANTHROPIC_AUTH_TOKEN='))).toBe(
      false,
    );
    expect(
      lines.filter((l) => l === 'CLAUDE_AGENT_SDK_CLIENT_APP=happyclaw').length,
    ).toBe(1);
  });

  test('vertex_gateway backend injects ANTHROPIC_AUTH_TOKEN when anthropicAuthToken is configured', async () => {
    const runtime = await importRuntimeConfig();

    const lines = runtime.buildClaudeEnvLines(
      providerConfig({
        backend: 'vertex_gateway',
        anthropicBaseUrl: 'https://vertex.gateway.example.com',
        anthropicAuthToken: 'gateway-vertex-token',
        anthropicModel: 'claude-sonnet-4-5@20250219',
      }),
      {},
    );

    expect(lines).toContain('CLAUDE_CODE_USE_VERTEX=1');
    expect(lines).toContain('CLAUDE_CODE_SKIP_VERTEX_AUTH=1');
    expect(lines).toContain(
      'ANTHROPIC_VERTEX_BASE_URL=https://vertex.gateway.example.com',
    );
    expect(lines).toContain('ANTHROPIC_AUTH_TOKEN=gateway-vertex-token');
    expect(lines.some((l) => l.startsWith('ANTHROPIC_BASE_URL='))).toBe(false);
  });

  test('vertex_gateway backend without auth token does NOT emit ANTHROPIC_AUTH_TOKEN', async () => {
    const runtime = await importRuntimeConfig();

    const lines = runtime.buildClaudeEnvLines(
      providerConfig({
        backend: 'vertex_gateway',
        anthropicBaseUrl: 'https://vertex.gateway.example.com',
      }),
      {},
    );

    expect(lines.some((l) => l.startsWith('ANTHROPIC_AUTH_TOKEN='))).toBe(
      false,
    );
  });

  test('foundry backend maps anthropicApiKey to ANTHROPIC_FOUNDRY_API_KEY and base URL', async () => {
    const runtime = await importRuntimeConfig();

    const lines = runtime.buildClaudeEnvLines(
      providerConfig({
        backend: 'foundry',
        anthropicBaseUrl: 'https://foundry.example.com',
        anthropicApiKey: 'foundry-api-key',
        anthropicModel: 'claude-sonnet-4-5',
      }),
      {},
    );

    expect(lines).toContain('CLAUDE_AGENT_SDK_CLIENT_APP=happyclaw');
    expect(lines).toContain('CLAUDE_CODE_USE_FOUNDRY=1');
    expect(lines).toContain(
      'ANTHROPIC_FOUNDRY_BASE_URL=https://foundry.example.com',
    );
    expect(lines).toContain('ANTHROPIC_FOUNDRY_API_KEY=foundry-api-key');
    expect(lines).toContain('ANTHROPIC_MODEL=claude-sonnet-4-5');
    // Generic ANTHROPIC_API_KEY must NOT be set — foundry uses its own var.
    expect(lines.some((l) => l.startsWith('ANTHROPIC_API_KEY='))).toBe(false);
    expect(lines.some((l) => l.startsWith('ANTHROPIC_BASE_URL='))).toBe(false);
  });

  test('foundry backend falls back to anthropicAuthToken for ANTHROPIC_FOUNDRY_API_KEY', async () => {
    const runtime = await importRuntimeConfig();

    const lines = runtime.buildClaudeEnvLines(
      providerConfig({
        backend: 'foundry',
        anthropicBaseUrl: 'https://foundry.example.com',
        anthropicAuthToken: 'foundry-auth-token',
      }),
      {},
    );

    expect(lines).toContain('CLAUDE_CODE_USE_FOUNDRY=1');
    expect(lines).toContain('ANTHROPIC_FOUNDRY_API_KEY=foundry-auth-token');
    // Auth token must NOT leak as ANTHROPIC_AUTH_TOKEN for foundry.
    expect(lines.some((l) => l.startsWith('ANTHROPIC_AUTH_TOKEN='))).toBe(
      false,
    );
  });

  test('ANTHROPIC_API_KEY is reserved and cannot be overridden via profile customEnv', async () => {
    const runtime = await importRuntimeConfig();

    const lines = runtime.buildClaudeEnvLines(
      providerConfig({
        backend: 'anthropic_messages',
        anthropicBaseUrl: 'https://gateway.example.com',
        anthropicAuthToken: 'real-token',
      }),
      {
        ANTHROPIC_API_KEY: 'leaked-key',
      },
    );

    expect(lines).not.toContain('ANTHROPIC_API_KEY=leaked-key');
    // Backend-generated mapping still wins.
    expect(lines).toContain('ANTHROPIC_API_KEY=real-token');
  });

  test('getClaudeReservedEnvKeys returns ANTHROPIC_API_KEY among the reserved keys', async () => {
    const runtime = await importRuntimeConfig();

    const keys = runtime.getClaudeReservedEnvKeys();
    expect(Array.isArray(keys)).toBe(true);
    expect(keys).toContain('ANTHROPIC_API_KEY');
    expect(keys).toContain('ANTHROPIC_AUTH_TOKEN');
    expect(keys).toContain('CLAUDE_CODE_USE_BEDROCK');
    expect(keys).toContain('CLAUDE_AGENT_SDK_CLIENT_APP');
  });

  test('reserved backend env keys cannot be overridden via customEnv', async () => {
    const runtime = await importRuntimeConfig();

    const lines = runtime.buildClaudeEnvLines(
      providerConfig({
        backend: 'bedrock_gateway',
        anthropicBaseUrl: 'https://bedrock.gateway.example.com',
      }),
      {
        // All of these should be silently dropped.
        CLAUDE_CODE_USE_BEDROCK: '0',
        CLAUDE_CODE_SKIP_BEDROCK_AUTH: '0',
        ANTHROPIC_BEDROCK_BASE_URL: 'https://hijack.example.com',
        CLAUDE_AGENT_SDK_CLIENT_APP: 'evil',
      },
    );

    expect(
      lines.filter((l) => l === 'CLAUDE_CODE_USE_BEDROCK=1').length,
    ).toBe(1);
    expect(lines).not.toContain('CLAUDE_CODE_USE_BEDROCK=0');
    expect(lines).not.toContain('CLAUDE_CODE_SKIP_BEDROCK_AUTH=0');
    expect(lines).not.toContain(
      'ANTHROPIC_BEDROCK_BASE_URL=https://hijack.example.com',
    );
    expect(lines).not.toContain('CLAUDE_AGENT_SDK_CLIENT_APP=evil');
    expect(
      lines.filter((l) => l === 'CLAUDE_AGENT_SDK_CLIENT_APP=happyclaw').length,
    ).toBe(1);
  });
});

describe('buildContainerEnvLines reserved-key filtering', () => {
  test('container-level customEnv cannot shadow reserved Claude env keys', async () => {
    const runtime = await importRuntimeConfig();

    const lines = runtime.buildContainerEnvLines(
      providerConfig({
        backend: 'bedrock_gateway',
        anthropicBaseUrl: 'https://bedrock.gateway.example.com',
        anthropicAuthToken: 'real-gateway-token',
      }),
      {
        anthropicBaseUrl: '',
        anthropicAuthToken: '',
        anthropicApiKey: '',
        claudeCodeOauthToken: '',
        claudeOAuthCredentials: null,
        anthropicModel: '',
        customEnv: {
          // All reserved — must be silently dropped from override.customEnv.
          ANTHROPIC_API_KEY: 'attacker-api-key',
          ANTHROPIC_AUTH_TOKEN: 'attacker-token',
          CLAUDE_CODE_USE_BEDROCK: '0',
          CLAUDE_CODE_SKIP_BEDROCK_AUTH: '0',
          ANTHROPIC_BEDROCK_BASE_URL: 'https://hijack.example.com',
          // Non-reserved — should pass through.
          AWS_REGION: 'us-east-1',
        },
      },
    );

    expect(lines).toContain('CLAUDE_CODE_USE_BEDROCK=1');
    expect(lines).toContain('CLAUDE_CODE_SKIP_BEDROCK_AUTH=1');
    expect(lines).toContain(
      'ANTHROPIC_BEDROCK_BASE_URL=https://bedrock.gateway.example.com',
    );
    expect(lines).toContain('ANTHROPIC_AUTH_TOKEN=real-gateway-token');
    expect(lines).toContain('AWS_REGION=us-east-1');
    // Reserved overrides dropped.
    expect(lines).not.toContain('ANTHROPIC_API_KEY=attacker-api-key');
    expect(lines).not.toContain('ANTHROPIC_AUTH_TOKEN=attacker-token');
    expect(lines).not.toContain('CLAUDE_CODE_USE_BEDROCK=0');
    expect(lines).not.toContain('CLAUDE_CODE_SKIP_BEDROCK_AUTH=0');
    expect(lines).not.toContain(
      'ANTHROPIC_BEDROCK_BASE_URL=https://hijack.example.com',
    );
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
