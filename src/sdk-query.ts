/**
 * Lightweight Claude Agent SDK wrapper for simple text-in → text-out queries.
 * Replaces all `claude --print` CLI calls so authentication uses the
 * provider configured in the settings page (ANTHROPIC_API_KEY / OAuth / Base URL).
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  buildClaudeEnvLines,
  getClaudeProviderConfig,
  getClaudeReservedEnvKeys,
} from './runtime-config.js';
import { logger } from './logger.js';

// Mutex: process.env mutation is not re-entrant. Serialize concurrent calls
// to prevent overlapping env writes from corrupting each other.
let envLock: Promise<void> = Promise.resolve();

/**
 * Send a prompt to Claude and return the plain-text response.
 * Uses the provider configured in the web settings (not a separate CLI install).
 *
 * @param prompt  The user prompt text
 * @param opts.model   Override model (defaults to provider config)
 * @param opts.timeout Timeout in ms (default 60 000)
 * @returns The assistant's text response, or null on failure
 */
export async function sdkQuery(
  prompt: string,
  opts?: { model?: string; timeout?: number },
): Promise<string | null> {
  // Chain on the lock so only one sdkQuery touches process.env at a time
  let release: () => void;
  const acquired = new Promise<void>((r) => (release = r));
  const prevLock = envLock;
  envLock = acquired;
  await prevLock;

  const timeout = opts?.timeout ?? 60_000;

  // Inject provider credentials into process.env for the SDK.
  //
  // Two stages of backup/restore:
  //   1. Reserved Claude env keys: snapshot every key in
  //      RESERVED_CLAUDE_ENV_KEYS even if the new generated env doesn't include
  //      it, then DELETE all of them. This prevents stale credentials from a
  //      previous backend (e.g. ANTHROPIC_API_KEY left over after switching to
  //      a Bedrock gateway, or CLAUDE_CODE_USE_BEDROCK=1 left over after
  //      switching back to anthropic_messages) from leaking into the SDK call.
  //   2. Generated env keys: layered on top, restored in `finally` after the
  //      reserved snapshot is restored.
  const reservedKeys = getClaudeReservedEnvKeys();
  const reservedSnapshot: Record<string, string | undefined> = {};
  for (const key of reservedKeys) {
    reservedSnapshot[key] = process.env[key];
    delete process.env[key];
  }

  const config = getClaudeProviderConfig();
  const envLines = buildClaudeEnvLines(config);
  const generatedSnapshot: Record<string, string | undefined> = {};
  for (const line of envLines) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);
    // After the reserved-cleanup pass `process.env[key]` is already cleared
    // for any reserved key, so the snapshot here only matters for non-reserved
    // generated keys (which is currently none, but kept for forward-compat).
    if (!(key in reservedSnapshot)) {
      generatedSnapshot[key] = process.env[key];
    }
    process.env[key] = value;
  }

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeout);

  try {
    const model = opts?.model || config.anthropicModel || undefined;

    let result = '';
    const conversation = query({
      prompt,
      options: {
        ...(model && { model }),
        maxTurns: 1,
        allowedTools: [],
        permissionMode: 'bypassPermissions' as const,
        allowDangerouslySkipPermissions: true,
        abortController,
      },
    });

    for await (const event of conversation) {
      if (event.type === 'result' && event.subtype === 'success') {
        result = event.result;
      }
    }

    return result.trim() || null;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message?.slice(0, 200) },
      'sdkQuery failed',
    );
    return null;
  } finally {
    clearTimeout(timer);
    // Restore in reverse order: generated keys first (they were applied last),
    // then reserved snapshot (which contains the real pre-call state, including
    // explicit `undefined` for keys that didn't exist before).
    for (const [key, original] of Object.entries(generatedSnapshot)) {
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    for (const [key, original] of Object.entries(reservedSnapshot)) {
      if (original === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = original;
      }
    }
    release!();
  }
}
