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

/**
 * Build the env passed to the SDK subprocess.
 *
 * Strategy: start from a copy of `process.env`, strip every Claude-reserved
 * key (so stale credentials from a previous backend cannot leak — e.g.
 * `ANTHROPIC_API_KEY` left over after switching to a Bedrock gateway, or
 * `CLAUDE_CODE_USE_BEDROCK=1` left over after switching back to
 * `anthropic_messages`), then layer the freshly generated provider env on top.
 */
function buildSubprocessEnv(envLines: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of getClaudeReservedEnvKeys()) {
    delete env[key];
  }
  for (const line of envLines) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    env[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return env;
}

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
  const timeout = opts?.timeout ?? 60_000;

  const config = getClaudeProviderConfig();
  const envLines = buildClaudeEnvLines(config);
  const subprocessEnv = buildSubprocessEnv(envLines);

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeout);

  try {
    const model = opts?.model || config.anthropicModel || undefined;

    let result = '';
    const conversation = query({
      prompt,
      options: {
        ...(model && { model }),
        env: subprocessEnv,
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
  }
}
