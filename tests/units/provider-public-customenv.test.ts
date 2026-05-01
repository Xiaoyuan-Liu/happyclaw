import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

type RuntimeConfigModule = typeof import('../../src/runtime-config.js');

const tempDirs: string[] = [];

function makeTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-public-env-'));
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

describe('toPublicProvider customEnv masking', () => {
  test('replaces plaintext customEnv values with masked equivalents', async () => {
    const runtime = await importRuntimeConfig(makeTempDataDir());
    const provider = runtime.createProvider({
      name: 'Bedrock Direct',
      type: 'third_party',
      backend: 'bedrock',
      customEnv: {
        AWS_REGION: 'us-east-1',
        AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        AWS_BEARER_TOKEN_BEDROCK: 'aws-bearer-token-very-secret-9876543210',
      },
    });

    const publicView = runtime.toPublicProvider(provider);

    // Old plaintext field is gone (replaced by *Masked + *Keys).
    expect((publicView as unknown as Record<string, unknown>).customEnv).toBeUndefined();

    // Keys stay intact so the UI knows what was configured.
    expect(publicView.customEnvKeys.sort()).toEqual([
      'AWS_BEARER_TOKEN_BEDROCK',
      'AWS_REGION',
      'AWS_SECRET_ACCESS_KEY',
    ]);

    // Every value must be masked (no original plaintext leaks).
    expect(publicView.customEnvMasked.AWS_SECRET_ACCESS_KEY).not.toBe(
      'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    );
    expect(publicView.customEnvMasked.AWS_BEARER_TOKEN_BEDROCK).not.toBe(
      'aws-bearer-token-very-secret-9876543210',
    );
    // Mask format: contains `*` characters.
    expect(publicView.customEnvMasked.AWS_SECRET_ACCESS_KEY).toMatch(/\*/);
    expect(publicView.customEnvMasked.AWS_BEARER_TOKEN_BEDROCK).toMatch(/\*/);
  });

  test('still reveals stored config in plaintext through resolveProviderById (server-side path)', async () => {
    const runtime = await importRuntimeConfig(makeTempDataDir());
    const provider = runtime.createProvider({
      name: 'Bedrock Direct',
      type: 'third_party',
      backend: 'bedrock',
      customEnv: { AWS_REGION: 'us-east-1', AWS_SECRET_ACCESS_KEY: 'real-secret' },
    });

    const resolved = runtime.resolveProviderById(provider.id);
    // Internal use (e.g. container-runner injecting envs) still gets plaintext.
    expect(resolved.customEnv.AWS_SECRET_ACCESS_KEY).toBe('real-secret');
  });
});

describe('updateProvider customEnvPatch merge semantics', () => {
  test('add: patch with new key inserts it without touching existing keys', async () => {
    const runtime = await importRuntimeConfig(makeTempDataDir());
    const provider = runtime.createProvider({
      name: 'Bedrock',
      type: 'third_party',
      backend: 'bedrock',
      customEnv: { AWS_REGION: 'us-east-1' },
    });

    const updated = runtime.updateProvider(provider.id, {
      customEnvPatch: { AWS_PROFILE: 'bedrock-prod' },
    });

    expect(updated.customEnv).toEqual({
      AWS_REGION: 'us-east-1',
      AWS_PROFILE: 'bedrock-prod',
    });
  });

  test('update: patch with existing key overwrites that value, leaves others alone', async () => {
    const runtime = await importRuntimeConfig(makeTempDataDir());
    const provider = runtime.createProvider({
      name: 'Bedrock',
      type: 'third_party',
      backend: 'bedrock',
      customEnv: { AWS_REGION: 'us-east-1', AWS_PROFILE: 'old' },
    });

    const updated = runtime.updateProvider(provider.id, {
      customEnvPatch: { AWS_PROFILE: 'new' },
    });

    expect(updated.customEnv).toEqual({
      AWS_REGION: 'us-east-1',
      AWS_PROFILE: 'new',
    });
  });

  test('delete: patch with null value removes the key', async () => {
    const runtime = await importRuntimeConfig(makeTempDataDir());
    const provider = runtime.createProvider({
      name: 'Bedrock',
      type: 'third_party',
      backend: 'bedrock',
      customEnv: { AWS_REGION: 'us-east-1', AWS_PROFILE: 'doomed' },
    });

    const updated = runtime.updateProvider(provider.id, {
      customEnvPatch: { AWS_PROFILE: null },
    });

    expect(updated.customEnv).toEqual({ AWS_REGION: 'us-east-1' });
    expect(updated.customEnv).not.toHaveProperty('AWS_PROFILE');
  });

  test('mixed patch: simultaneously adds, updates and deletes', async () => {
    const runtime = await importRuntimeConfig(makeTempDataDir());
    const provider = runtime.createProvider({
      name: 'Bedrock',
      type: 'third_party',
      backend: 'bedrock',
      customEnv: {
        AWS_REGION: 'us-east-1',
        AWS_PROFILE: 'will-stay',
        OLD_KEY: 'will-die',
      },
    });

    const updated = runtime.updateProvider(provider.id, {
      customEnvPatch: {
        AWS_REGION: 'eu-west-1', // update
        NEW_KEY: 'newly-added', // add
        OLD_KEY: null, // delete
        // AWS_PROFILE absent → keep
      },
    });

    expect(updated.customEnv).toEqual({
      AWS_REGION: 'eu-west-1',
      AWS_PROFILE: 'will-stay',
      NEW_KEY: 'newly-added',
    });
  });

  test('full customEnv replacement still works (legacy path)', async () => {
    const runtime = await importRuntimeConfig(makeTempDataDir());
    const provider = runtime.createProvider({
      name: 'Bedrock',
      type: 'third_party',
      backend: 'bedrock',
      customEnv: { OLD_A: '1', OLD_B: '2' },
    });

    const updated = runtime.updateProvider(provider.id, {
      customEnv: { NEW_X: 'x' },
    });

    // Full replacement removes old keys.
    expect(updated.customEnv).toEqual({ NEW_X: 'x' });
  });

  test('merge patch handles secrets without round-tripping masked values', async () => {
    // Simulates the realistic flow: GET returns masked values, the user
    // changes only one key, the UI sends a customEnvPatch with just that key,
    // and the server preserves the other (real) secrets unchanged.
    const runtime = await importRuntimeConfig(makeTempDataDir());
    const provider = runtime.createProvider({
      name: 'Bedrock',
      type: 'third_party',
      backend: 'bedrock',
      customEnv: {
        AWS_SECRET_ACCESS_KEY: 'real-secret-do-not-leak',
        AWS_BEARER_TOKEN_BEDROCK: 'real-bearer-do-not-leak',
      },
    });

    // User edits only AWS_SECRET_ACCESS_KEY in the UI.
    const updated = runtime.updateProvider(provider.id, {
      customEnvPatch: { AWS_SECRET_ACCESS_KEY: 'rotated-secret' },
    });

    expect(updated.customEnv.AWS_SECRET_ACCESS_KEY).toBe('rotated-secret');
    // Critical: the untouched secret is preserved verbatim.
    expect(updated.customEnv.AWS_BEARER_TOKEN_BEDROCK).toBe(
      'real-bearer-do-not-leak',
    );
  });
});
