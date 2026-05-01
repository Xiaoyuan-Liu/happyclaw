// ─── 统一供应商类型 (V5) ─────────────────────────────────────

/** Backend 类型 — 决定 SDK env 如何注入 (与后端 ProviderBackend 保持一致) */
export type ProviderBackend =
  | 'anthropic_official'
  | 'anthropic_messages'
  | 'bedrock'
  | 'bedrock_gateway'
  | 'vertex'
  | 'vertex_gateway'
  | 'foundry';

export interface UnifiedProviderPublic {
  id: string;
  name: string;
  type: 'official' | 'third_party';
  /** V5 新增：明确 backend 分发路径 */
  backend: ProviderBackend;
  /** V5 新增：显式禁用实验 beta（兼容老网关） */
  disableExperimentalBetas?: boolean;
  enabled: boolean;
  weight: number;
  anthropicBaseUrl: string;
  anthropicModel: string;
  hasAnthropicAuthToken: boolean;
  anthropicAuthTokenMasked: string | null;
  hasAnthropicApiKey: boolean;
  anthropicApiKeyMasked: string | null;
  hasClaudeCodeOauthToken: boolean;
  claudeCodeOauthTokenMasked: string | null;
  hasClaudeOAuthCredentials: boolean;
  claudeOAuthCredentialsExpiresAt: number | null;
  claudeOAuthCredentialsAccessTokenMasked: string | null;
  /**
   * Custom env values returned with each value masked (run through
   * maskSecret on the server). These are display-only — the UI must not send
   * masked strings back as plaintext values; use the `customEnvPatch` merge
   * field on the patch endpoint to update only the keys the user changed.
   */
  customEnvMasked: Record<string, string>;
  /** Stable list of customEnv key names (mirrors `customEnvMasked` keys). */
  customEnvKeys: string[];
  updatedAt: string;
}

export type ProviderDiagnosticKind =
  | 'invalid_beta'
  | 'unsupported_beta'
  | 'bedrock_auth'
  | 'vertex_auth'
  | 'foundry_auth'
  | 'unknown';

export interface ProviderDiagnostic {
  kind: ProviderDiagnosticKind;
  message: string;
  hint: string;
  suggestedAction?: string;
}

export interface ProviderHealthStatus {
  profileId: string;
  healthy: boolean;
  consecutiveErrors: number;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  unhealthySince: number | null;
  activeSessionCount: number;
  /** Tail of the most recent failure message (null if never failed). */
  lastErrorMessage?: string | null;
  /** Structured diagnostic for the most recent failure (null if no match). */
  lastDiagnostic?: ProviderDiagnostic | null;
}

export interface ProviderWithHealth extends UnifiedProviderPublic {
  health: ProviderHealthStatus | null;
}

export interface BalancingConfig {
  strategy: 'round-robin' | 'weighted-round-robin' | 'failover';
  unhealthyThreshold: number;
  recoveryIntervalMs: number;
}

export interface ProvidersListResponse {
  providers: ProviderWithHealth[];
  balancing: BalancingConfig;
  enabledCount: number;
}

export interface ClaudeApplyResult {
  success: boolean;
  stoppedCount: number;
  failedCount?: number;
  error?: string;
}

// ─── 兼容旧类型（仍被 GET /claude 返回） ────────────────────

export interface ClaudeConfigPublic {
  anthropicBaseUrl: string;
  anthropicModel: string;
  updatedAt: string | null;
  hasAnthropicAuthToken: boolean;
  hasAnthropicApiKey: boolean;
  hasClaudeCodeOauthToken: boolean;
  anthropicAuthTokenMasked: string | null;
  anthropicApiKeyMasked: string | null;
  claudeCodeOauthTokenMasked: string | null;
  hasClaudeOAuthCredentials: boolean;
  claudeOAuthCredentialsExpiresAt: number | null;
  claudeOAuthCredentialsAccessTokenMasked: string | null;
}

// ─── 通用类型 ────────────────────────────────────────────────

export interface EnvRow {
  key: string;
  value: string;
}

export interface SessionInfo {
  id: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  last_active_at: string;
  is_current: boolean;
}

export interface SystemSettings {
  containerTimeout: number;
  idleTimeout: number;
  containerMaxOutputSize: number;
  maxConcurrentContainers: number;
  maxConcurrentHostProcesses: number;
  maxLoginAttempts: number;
  loginLockoutMinutes: number;
  maxConcurrentScripts: number;
  scriptTimeout: number;
  billingEnabled: boolean;
  billingMode: 'wallet_first';
  billingMinStartBalanceUsd: number;
  billingCurrency: string;
  billingCurrencyRate: number;
  externalClaudeDir: string;
  autoCompactWindow: number;
  disableMemoryLayerForAdminHost: boolean;
}

// ─── OAuth Usage ────────────────────────────────────────────

export interface OAuthUsageBucket {
  utilization: number;
  resets_at: string;
}

export interface OAuthUsageResponse {
  five_hour: OAuthUsageBucket | null;
  seven_day: OAuthUsageBucket | null;
  seven_day_opus: OAuthUsageBucket | null;
  seven_day_sonnet: OAuthUsageBucket | null;
}

export interface CachedOAuthUsage {
  data: OAuthUsageResponse;
  fetchedAt: number;
  error?: string;
}

export type SettingsTab = 'claude' | 'registration' | 'appearance' | 'system' | 'profile' | 'my-channels' | 'security' | 'groups' | 'memory' | 'skills' | 'mcp-servers' | 'agent-definitions' | 'users' | 'about' | 'bindings' | 'usage' | 'monitor';

export function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
