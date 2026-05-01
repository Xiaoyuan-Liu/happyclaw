import { useCallback, useEffect, useState } from 'react';
import {
  ExternalLink,
  Key,
  Loader2,
  Plus,
  X,
} from 'lucide-react';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api } from '../../api/client';
import type { ProviderWithHealth, EnvRow, ProviderBackend } from './types';
import { getErrorMessage } from './types';

/**
 * Sentinel marking a customEnv row whose value is currently displayed in masked
 * form (returned by the server as `customEnvMasked[key]`). When the user does
 * NOT edit such a row, we omit it from the merge patch so the stored secret
 * stays untouched. Any row whose value differs from this sentinel was edited
 * by the user and is sent as a real new value.
 */
const MASKED_VALUE_PLACEHOLDER = '__HAPPYCLAW_MASKED__';

type ProviderType = 'official' | 'third_party';
type OfficialAuthTab = 'oauth' | 'setup_token' | 'api_key';

/** 第三方 backend 二级选项 — 第一级 official 自动映射到 anthropic_official */
type ThirdPartyBackend = Exclude<ProviderBackend, 'anthropic_official'>;

interface ThirdPartyBackendOption {
  value: ThirdPartyBackend;
  label: string;
  description: string;
}

const THIRD_PARTY_BACKEND_OPTIONS: ThirdPartyBackendOption[] = [
  {
    value: 'anthropic_messages',
    label: 'Anthropic Messages 兼容网关',
    description: 'GLM / Minimax / OpenAI-compatible 网关 → LiteLLM/one-api 等',
  },
  {
    value: 'bedrock',
    label: 'Amazon Bedrock 直连',
    description: '通过 AWS 凭据直接调用 Bedrock',
  },
  {
    value: 'bedrock_gateway',
    label: 'Amazon Bedrock via 网关',
    description: 'LiteLLM 等代理 → Bedrock',
  },
  {
    value: 'vertex',
    label: 'Google Vertex AI 直连',
    description: '通过 GCP 凭据直接调用 Vertex',
  },
  {
    value: 'vertex_gateway',
    label: 'Google Vertex AI via 网关',
    description: 'LiteLLM 等代理 → Vertex',
  },
  {
    value: 'foundry',
    label: 'Microsoft Foundry',
    description: 'Azure / Foundry endpoints',
  },
];

/** 把 V5 backend 映射回第一级 ProviderType（兼容老 provider 编辑） */
function deriveProviderType(backend: ProviderBackend | undefined): ProviderType {
  return backend === 'anthropic_official' ? 'official' : 'third_party';
}

/**
 * Keys reserved for dedicated form fields. The UI surfaces a separate password
 * input for each (Base URL / Auth Token / API Key / OAuth Token / Model), so
 * users should never re-enter them in the customEnv table. The error message
 * tells the user which field to use instead.
 */
const RESERVED_ENV_KEYS = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_MODEL',
]);

/**
 * Row tracker used by the customEnv editor. `originalKey` records the key as
 * the row was first loaded from the server (null for newly-added rows); when
 * the user renames a row we treat it as delete-old + create-new in the merge
 * patch. `dirty` flips to true the first time the user edits the value.
 */
interface CustomEnvRow extends EnvRow {
  originalKey: string | null;
  /** True when value differs from the masked placeholder we initialized with. */
  dirty: boolean;
}

interface CustomEnvBuildResult {
  patch: Record<string, string | null>;
  error: string | null;
}

/**
 * Build a `customEnvPatch` for merge-update semantics:
 *
 * - keys present in `originalKeys` but missing from `rows` -> set to null (delete)
 * - rows whose value is still the masked sentinel -> omitted (server keeps stored value)
 * - rows where the user edited the value -> included with the new plaintext value
 * - rows where the user renamed the key -> delete original + add new
 */
function buildCustomEnvPatch(
  rows: CustomEnvRow[],
  originalKeys: string[],
): CustomEnvBuildResult {
  const patch: Record<string, string | null> = {};
  const seenKeys = new Set<string>();
  const survivingOriginals = new Set<string>();

  for (const [idx, row] of rows.entries()) {
    const key = row.key.trim();
    const value = row.value;

    // Allow deleting an empty/empty row even if it had no original key.
    if (!key && !value.trim() && row.originalKey === null) continue;

    if (!key) {
      return { patch: {}, error: `第 ${idx + 1} 行环境变量 Key 不能为空` };
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return {
        patch: {},
        error: `环境变量 Key "${key}" 格式无效（需匹配 [A-Za-z_][A-Za-z0-9_]*）`,
      };
    }
    if (RESERVED_ENV_KEYS.has(key)) {
      return {
        patch: {},
        error: `${key} 已有专用配置区，不要在自定义环境变量表中重复填写`,
      };
    }
    if (seenKeys.has(key)) {
      return { patch: {}, error: `环境变量 Key "${key}" 重复` };
    }
    seenKeys.add(key);

    // Renamed key: delete the old key as part of the patch.
    if (row.originalKey && row.originalKey !== key) {
      patch[row.originalKey] = null;
    }
    if (row.originalKey === key) {
      survivingOriginals.add(key);
    }

    // Untouched masked rows: skip — keep stored value as-is.
    if (!row.dirty && row.originalKey !== null && row.originalKey === key) {
      continue;
    }

    // Brand-new row with an empty value is ambiguous — require a real value.
    if (row.originalKey === null && !value) {
      return {
        patch: {},
        error: `环境变量 "${key}" 缺少 value`,
      };
    }

    patch[key] = value;
  }

  // Any original key the user removed (no surviving row) -> explicit delete.
  for (const orig of originalKeys) {
    if (!survivingOriginals.has(orig) && !(orig in patch)) {
      patch[orig] = null;
    }
  }

  return { patch, error: null };
}

/** Backend-aware client-side validation, mirrored from the server's
 *  validateProviderFinalState() so the user gets immediate feedback. */
interface ValidateBackendFieldsArgs {
  providerType: ProviderType;
  thirdPartyBackend: ThirdPartyBackend;
  baseUrl: string;
  /** Auth token currently in the form (may be empty if user did not edit). */
  authToken: string;
  /** True when the provider already has a stored auth token (edit mode). */
  hasStoredAuthToken: boolean;
  /** True when the user marked the existing token for clearing. */
  clearTokenOnSave: boolean;
  /** API key currently in the form (foundry-only path). */
  apiKey: string;
  /** True when the provider already has a stored API key (edit mode). */
  hasStoredApiKey: boolean;
}

function validateBackendFields(args: ValidateBackendFieldsArgs): string | null {
  if (args.providerType === 'official') return null;
  const trimmedBase = args.baseUrl.trim();
  const trimmedToken = args.authToken.trim();
  const trimmedKey = args.apiKey.trim();

  // Effective credential availability after this save:
  //   - clearTokenOnSave wipes the stored token (or it is empty already)
  //   - otherwise stored token survives if user did not type a new one
  const tokenWillBePresent = args.clearTokenOnSave
    ? trimmedToken !== ''
    : trimmedToken !== '' || args.hasStoredAuthToken;
  const apiKeyWillBePresent = trimmedKey !== '' || args.hasStoredApiKey;

  switch (args.thirdPartyBackend) {
    case 'anthropic_messages':
      if (!trimmedBase) return '请填写 ANTHROPIC_BASE_URL';
      if (!tokenWillBePresent && !apiKeyWillBePresent) {
        return '兼容网关 provider 必须提供 Auth Token 或 API Key';
      }
      return null;
    case 'bedrock_gateway':
      if (!trimmedBase) {
        return 'Bedrock 网关后端必须填写 Base URL（用作 ANTHROPIC_BEDROCK_BASE_URL）';
      }
      return null;
    case 'vertex_gateway':
      if (!trimmedBase) {
        return 'Vertex 网关后端必须填写 Base URL（用作 ANTHROPIC_VERTEX_BASE_URL）';
      }
      return null;
    case 'foundry':
      if (!tokenWillBePresent && !apiKeyWillBePresent) {
        return 'Foundry 后端必须提供 API Key 或 Auth Token';
      }
      return null;
    case 'bedrock':
    case 'vertex':
      // Direct cloud auth — credentials live in customEnv / IAM role / GCP ADC.
      return null;
    default:
      return null;
  }
}

interface ProviderEditorProps {
  open: boolean;
  /** null 表示创建模式 */
  provider: ProviderWithHealth | null;
  /** 当前负载均衡策略，影响权重字段的展示和提示 */
  balancingStrategy?: 'round-robin' | 'weighted-round-robin' | 'failover';
  onSave: () => void;
  onCancel: () => void;
  setNotice: (msg: string | null) => void;
  setError: (msg: string | null) => void;
}

export function ProviderEditor({
  open,
  provider,
  balancingStrategy,
  onSave,
  onCancel,
  setNotice,
  setError,
}: ProviderEditorProps) {
  const isCreate = provider === null;

  // 基础字段
  const [providerType, setProviderType] = useState<ProviderType>('third_party');
  const [thirdPartyBackend, setThirdPartyBackend] =
    useState<ThirdPartyBackend>('anthropic_messages');
  const [disableExperimentalBetas, setDisableExperimentalBetas] = useState(false);
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [weight, setWeight] = useState(1);

  // 官方认证
  const [authTab, setAuthTab] = useState<OfficialAuthTab>('oauth');
  const [setupToken, setSetupToken] = useState('');
  const [apiKey, setApiKey] = useState('');

  // OAuth 流程
  const [oauthLoading, setOauthLoading] = useState(false);
  const [oauthState, setOauthState] = useState<string | null>(null);
  const [oauthCode, setOauthCode] = useState('');
  const [oauthExchanging, setOauthExchanging] = useState(false);

  // 第三方认证
  const [authToken, setAuthToken] = useState('');
  const [authTokenDirty, setAuthTokenDirty] = useState(false);
  const [clearTokenOnSave, setClearTokenOnSave] = useState(false);

  // 环境变量 — 编辑模式下，row.value 初始为脱敏占位符，dirty=false 表示用户尚未修改，
  // 提交时会被合并补丁忽略（保留服务端已存的真实值）。
  const [customEnvRows, setCustomEnvRows] = useState<CustomEnvRow[]>([]);
  // 编辑模式下加载时的原始 key 列表（用于检测删除）。
  const [originalEnvKeys, setOriginalEnvKeys] = useState<string[]>([]);

  // 状态
  const [saving, setSaving] = useState(false);

  // 初始化表单
  useEffect(() => {
    if (!open) return;

    if (isCreate) {
      setProviderType('third_party');
      setThirdPartyBackend('anthropic_messages');
      setDisableExperimentalBetas(false);
      setName('');
      setBaseUrl('');
      setModel('');
      setWeight(1);
      setAuthTab('oauth');
      setSetupToken('');
      setApiKey('');
      setOauthState(null);
      setOauthCode('');
      setAuthToken('');
      setAuthTokenDirty(false);
      setClearTokenOnSave(false);
      setCustomEnvRows([]);
      setOriginalEnvKeys([]);
    } else {
      const derivedType = deriveProviderType(provider.backend);
      setProviderType(derivedType);
      // 第三方时回填二级 backend；官方时保留默认（不会渲染）
      if (derivedType === 'third_party') {
        const backend = (provider.backend ?? 'anthropic_messages') as ProviderBackend;
        setThirdPartyBackend(
          backend === 'anthropic_official' ? 'anthropic_messages' : backend,
        );
      } else {
        setThirdPartyBackend('anthropic_messages');
      }
      setDisableExperimentalBetas(!!provider.disableExperimentalBetas);
      setName(provider.name);
      setBaseUrl(provider.anthropicBaseUrl || '');
      setModel(provider.anthropicModel || '');
      setWeight(provider.weight);
      setAuthTab('oauth');
      setSetupToken('');
      setApiKey('');
      setOauthState(null);
      setOauthCode('');
      setAuthToken('');
      setAuthTokenDirty(false);
      setClearTokenOnSave(false);
      // customEnv 已经由后端脱敏（customEnvMasked），此处用占位符填充；
      // 用户编辑后 dirty 才置为 true，保存时只会提交被改过的 key。
      const masked = provider.customEnvMasked || {};
      const keys = provider.customEnvKeys ?? Object.keys(masked);
      const envRows: CustomEnvRow[] = keys.map((key) => ({
        key,
        value: MASKED_VALUE_PLACEHOLDER,
        originalKey: key,
        dirty: false,
      }));
      setCustomEnvRows(envRows);
      setOriginalEnvKeys(keys);
    }
  }, [open, isCreate, provider]);

  const addRow = () =>
    setCustomEnvRows((prev) => [
      ...prev,
      { key: '', value: '', originalKey: null, dirty: true },
    ]);
  const removeRow = (index: number) =>
    setCustomEnvRows((prev) => prev.filter((_, i) => i !== index));
  const updateRow = (index: number, field: keyof EnvRow, value: string) =>
    setCustomEnvRows((prev) =>
      prev.map((row, i) =>
        i === index
          ? {
              ...row,
              [field]: value,
              // 任何修改都视为 dirty —— 当用户编辑掉脱敏占位符或修改 key 时，
              // 这一行的 value 会作为新明文写回服务器。
              dirty: true,
            }
          : row,
      ),
    );

  // ─── OAuth 流程 ─────────────────────────────────────────────
  const handleOAuthStart = useCallback(async () => {
    setOauthLoading(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      // 编辑模式下传入目标提供商 ID
      if (!isCreate && provider) {
        body.targetProviderId = provider.id;
      }
      const data = await api.post<{ authorizeUrl: string; state: string }>(
        '/api/config/claude/oauth/start',
        Object.keys(body).length > 0 ? body : undefined,
      );
      setOauthState(data.state);
      setOauthCode('');
      window.open(data.authorizeUrl, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(getErrorMessage(err, 'OAuth 授权启动失败'));
    } finally {
      setOauthLoading(false);
    }
  }, [isCreate, provider, setError]);

  const handleOAuthCallback = useCallback(async () => {
    if (!oauthState || !oauthCode.trim()) {
      setError('请粘贴授权码');
      return;
    }
    setOauthExchanging(true);
    setError(null);
    try {
      await api.post('/api/config/claude/oauth/callback', {
        state: oauthState,
        code: oauthCode.trim(),
      });
      setOauthState(null);
      setOauthCode('');
      setNotice('OAuth 登录成功，凭据已保存。');
      onSave();
    } catch (err) {
      setError(getErrorMessage(err, 'OAuth 授权码换取失败'));
    } finally {
      setOauthExchanging(false);
    }
  }, [oauthState, oauthCode, setError, setNotice, onSave]);

  // ─── 保存 ──────────────────────────────────────────────────
  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('请填写提供商名称');
      return;
    }

    // 统一 backend-aware 必填校验（创建/编辑都跑一遍）。
    const backendError = validateBackendFields({
      providerType,
      thirdPartyBackend,
      baseUrl,
      authToken,
      hasStoredAuthToken: !isCreate && !!provider?.hasAnthropicAuthToken,
      clearTokenOnSave,
      apiKey,
      hasStoredApiKey: !isCreate && !!provider?.hasAnthropicApiKey,
    });
    if (backendError) {
      setError(backendError);
      return;
    }

    // customEnv 改用 merge-patch：编辑时未被用户改动的脱敏行不会回传明文，
    // 服务端按补丁合并到已存的真实值上。
    const envResult = buildCustomEnvPatch(customEnvRows, originalEnvKeys);
    if (envResult.error) {
      setError(envResult.error);
      return;
    }

    setSaving(true);
    setError(null);

    try {
      if (isCreate) {
        // ── 创建模式 ──
        const finalBackend: ProviderBackend =
          providerType === 'official' ? 'anthropic_official' : thirdPartyBackend;

        // 创建时直接用全量 customEnv（patch 的 null 值不可能存在，因为创建模式
        // 没有任何"原始 key"）。
        const createCustomEnv: Record<string, string> = {};
        for (const [k, v] of Object.entries(envResult.patch)) {
          if (typeof v === 'string') createCustomEnv[k] = v;
        }

        const createBody: Record<string, unknown> = {
          name: trimmedName,
          type: providerType,
          backend: finalBackend,
          customEnv: createCustomEnv,
          weight,
        };

        if (providerType === 'third_party') {
          const trimmedBaseUrl = baseUrl.trim();
          const trimmedToken = authToken.trim();

          if (trimmedBaseUrl) createBody.anthropicBaseUrl = trimmedBaseUrl;
          if (trimmedToken) createBody.anthropicAuthToken = trimmedToken;
          // foundry 支持把 API Key 单独传
          if (thirdPartyBackend === 'foundry' && apiKey.trim()) {
            createBody.anthropicApiKey = apiKey.trim();
          }

          // 仅 anthropic_messages 暴露 disableExperimentalBetas
          if (
            thirdPartyBackend === 'anthropic_messages' &&
            disableExperimentalBetas
          ) {
            createBody.disableExperimentalBetas = true;
          }
        } else {
          // 官方模式 — 根据认证方式设置凭据
          if (authTab === 'setup_token') {
            const trimmed = setupToken.trim();
            if (!trimmed) {
              setError('请填写 setup-token 或粘贴 .credentials.json 内容');
              setSaving(false);
              return;
            }
            // 检测是否为 .credentials.json
            if (trimmed.startsWith('{')) {
              try {
                const parsed = JSON.parse(trimmed) as Record<string, unknown>;
                const oauth = parsed.claudeAiOauth as Record<string, unknown> | undefined;
                if (oauth?.accessToken && oauth?.refreshToken) {
                  createBody.claudeOAuthCredentials = {
                    accessToken: oauth.accessToken,
                    refreshToken: oauth.refreshToken,
                    expiresAt: oauth.expiresAt
                      ? new Date(oauth.expiresAt as string).getTime()
                      : Date.now() + 8 * 60 * 60 * 1000,
                    scopes: Array.isArray(oauth.scopes) ? oauth.scopes : [],
                  };
                } else {
                  createBody.claudeCodeOauthToken = trimmed;
                }
              } catch {
                createBody.claudeCodeOauthToken = trimmed;
              }
            } else {
              createBody.claudeCodeOauthToken = trimmed;
            }
          } else if (authTab === 'api_key') {
            const trimmed = apiKey.trim();
            if (!trimmed) {
              setError('请填写 Anthropic API Key');
              setSaving(false);
              return;
            }
            createBody.anthropicApiKey = trimmed;
          } else {
            // OAuth 模式 — 不需要凭据，通过 OAuth 流程设置
            // 允许不带凭据创建，用户之后通过 OAuth 流程补充
          }
        }

        if (model.trim()) createBody.anthropicModel = model.trim();

        await api.post('/api/config/claude/providers', createBody);
        setNotice('提供商已创建。');
      } else {
        // ── 编辑模式 ──
        const finalBackend: ProviderBackend =
          providerType === 'official' ? 'anthropic_official' : thirdPartyBackend;

        const patchBody: Record<string, unknown> = {
          name: trimmedName,
          backend: finalBackend,
          weight,
        };
        // 仅当真的有 customEnv 变更时才发送 patch，避免空对象触发"至少一个字段"校验。
        if (Object.keys(envResult.patch).length > 0) {
          patchBody.customEnvPatch = envResult.patch;
        }

        if (providerType === 'third_party') {
          patchBody.anthropicBaseUrl = baseUrl.trim();
          // 仅 anthropic_messages 暴露此字段；其他 backend 显式置回默认（undefined）
          if (thirdPartyBackend === 'anthropic_messages') {
            patchBody.disableExperimentalBetas = disableExperimentalBetas;
          } else {
            patchBody.disableExperimentalBetas = false;
          }
        } else {
          // 切回官方时清掉该标志
          patchBody.disableExperimentalBetas = false;
        }
        if (model.trim()) {
          patchBody.anthropicModel = model.trim();
        }

        await api.patch(`/api/config/claude/providers/${provider!.id}`, patchBody);

        // 更新密钥（如果有变更）
        const secretsBody: Record<string, unknown> = {};
        let hasSecretsChange = false;

        if (providerType === 'third_party') {
          if (clearTokenOnSave) {
            secretsBody.clearAnthropicAuthToken = true;
            hasSecretsChange = true;
          } else if (authTokenDirty && authToken.trim()) {
            secretsBody.anthropicAuthToken = authToken.trim();
            hasSecretsChange = true;
          }
          // Foundry 支持 API Key
          if (thirdPartyBackend === 'foundry' && apiKey.trim()) {
            secretsBody.anthropicApiKey = apiKey.trim();
            hasSecretsChange = true;
          }
        } else {
          // 官方模式编辑时更新凭据
          if (authTab === 'setup_token' && setupToken.trim()) {
            const trimmed = setupToken.trim();
            if (trimmed.startsWith('{')) {
              try {
                const parsed = JSON.parse(trimmed) as Record<string, unknown>;
                const oauth = parsed.claudeAiOauth as Record<string, unknown> | undefined;
                if (oauth?.accessToken && oauth?.refreshToken) {
                  secretsBody.claudeOAuthCredentials = {
                    accessToken: oauth.accessToken,
                    refreshToken: oauth.refreshToken,
                    expiresAt: oauth.expiresAt
                      ? new Date(oauth.expiresAt as string).getTime()
                      : Date.now() + 8 * 60 * 60 * 1000,
                    scopes: Array.isArray(oauth.scopes) ? oauth.scopes : [],
                  };
                  secretsBody.clearAnthropicAuthToken = true;
                  secretsBody.clearAnthropicApiKey = true;
                  secretsBody.clearClaudeCodeOauthToken = true;
                  hasSecretsChange = true;
                }
              } catch {
                // 不是 JSON，视为 setup-token
              }
            }
            if (!hasSecretsChange) {
              secretsBody.claudeCodeOauthToken = trimmed;
              secretsBody.clearAnthropicAuthToken = true;
              secretsBody.clearAnthropicApiKey = true;
              hasSecretsChange = true;
            }
          } else if (authTab === 'api_key' && apiKey.trim()) {
            secretsBody.anthropicApiKey = apiKey.trim();
            secretsBody.clearAnthropicAuthToken = true;
            secretsBody.clearClaudeCodeOauthToken = true;
            secretsBody.clearClaudeOAuthCredentials = true;
            hasSecretsChange = true;
          }
        }

        if (hasSecretsChange) {
          await api.put(`/api/config/claude/providers/${provider!.id}/secrets`, secretsBody);
        }

        setNotice('提供商配置已保存。');
      }

      onSave();
    } catch (err) {
      setError(getErrorMessage(err, isCreate ? '创建提供商失败' : '保存提供商失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    if (!saving && !oauthExchanging) {
      setOauthState(null);
      onCancel();
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isCreate ? '添加提供商' : `编辑提供商：${provider?.name}`}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* 类型选择（仅创建模式） */}
          {isCreate && (
            <div>
              <label className="block text-xs text-muted-foreground mb-1">提供商类型</label>
              <div className="inline-flex rounded-lg border border-border p-1 bg-muted">
                <button
                  type="button"
                  onClick={() => setProviderType('official')}
                  className={`px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${
                    providerType === 'official'
                      ? 'bg-background text-primary shadow-sm'
                      : 'text-muted-foreground'
                  }`}
                >
                  官方
                </button>
                <button
                  type="button"
                  onClick={() => setProviderType('third_party')}
                  className={`px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${
                    providerType === 'third_party'
                      ? 'bg-background text-primary shadow-sm'
                      : 'text-muted-foreground'
                  }`}
                >
                  第三方
                </button>
              </div>
            </div>
          )}

          {/* 名称 */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">名称</label>
            <Input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={saving}
              placeholder={providerType === 'official' ? '如：Claude 官方' : '如：OpenRouter-主账号'}
            />
          </div>

          {/* ─── 官方模式 ─── */}
          {providerType === 'official' && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-muted-foreground mb-2">认证方式</label>
                <div className="inline-flex rounded-lg border border-border p-1 bg-muted">
                  {(['oauth', 'setup_token', 'api_key'] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setAuthTab(tab)}
                      className={`px-3 py-1.5 text-xs rounded-md transition-colors cursor-pointer ${
                        authTab === tab
                          ? 'bg-background text-primary shadow-sm'
                          : 'text-muted-foreground'
                      }`}
                    >
                      {tab === 'oauth' ? 'OAuth 登录' : tab === 'setup_token' ? 'Setup Token' : 'API Key'}
                    </button>
                  ))}
                </div>
              </div>

              {authTab === 'oauth' && (
                <div className="rounded-lg border border-teal-200 bg-teal-50/50 p-4 space-y-3">
                  <div className="text-sm font-medium text-foreground">一键登录 Claude（推荐）</div>
                  <div className="text-xs text-muted-foreground">
                    点击按钮后会打开 claude.ai 授权页面，完成授权后将页面上显示的授权码粘贴回来。
                  </div>

                  {/* 编辑模式显示现有凭据 */}
                  {!isCreate && provider?.hasClaudeOAuthCredentials && (
                    <div className="rounded-md border border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-950/30 p-3 space-y-1 text-xs">
                      <div className="text-emerald-700 dark:text-emerald-300">
                        Access Token: {provider.claudeOAuthCredentialsAccessTokenMasked || '***'}
                      </div>
                      {provider.claudeOAuthCredentialsExpiresAt && (
                        <div className={
                          provider.claudeOAuthCredentialsExpiresAt <= Date.now()
                            ? 'text-red-700 dark:text-red-400 font-medium'
                            : 'text-emerald-700 dark:text-emerald-300'
                        }>
                          过期时间: {new Date(provider.claudeOAuthCredentialsExpiresAt).toLocaleString('zh-CN')}
                          {provider.claudeOAuthCredentialsExpiresAt > Date.now()
                            ? ` (${Math.round((provider.claudeOAuthCredentialsExpiresAt - Date.now()) / 60000)} 分钟后)`
                            : ' (已过期)'}
                        </div>
                      )}
                      <div className="text-emerald-600">SDK 会在 token 过期时自动刷新。</div>
                    </div>
                  )}

                  {!oauthState ? (
                    <Button onClick={handleOAuthStart} disabled={saving || oauthLoading}>
                      {oauthLoading ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
                      {!isCreate && provider?.hasClaudeOAuthCredentials ? '重新登录 Claude' : '一键登录 Claude'}
                    </Button>
                  ) : (
                    <div className="space-y-2">
                      <div className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-md px-3 py-2">
                        授权窗口已打开，请在 claude.ai 完成授权后，将页面上显示的授权码粘贴到下方。
                      </div>
                      <div className="flex gap-2">
                        <Input
                          type="text"
                          value={oauthCode}
                          onChange={(e) => setOauthCode(e.target.value)}
                          disabled={oauthExchanging}
                          placeholder="粘贴授权码"
                          className="flex-1"
                        />
                        <Button onClick={handleOAuthCallback} disabled={oauthExchanging || !oauthCode.trim()}>
                          {oauthExchanging && <Loader2 className="size-4 animate-spin" />}
                          确认
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => {
                            setOauthState(null);
                            setOauthCode('');
                          }}
                        >
                          取消
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {authTab === 'setup_token' && (
                <div className="space-y-2">
                  <label className="block text-xs text-muted-foreground mb-1">
                    setup-token 或 .credentials.json{' '}
                    {!isCreate && provider?.hasClaudeCodeOauthToken
                      ? `(${provider.claudeCodeOauthTokenMasked})`
                      : ''}
                  </label>
                  <Input
                    type="password"
                    value={setupToken}
                    onChange={(e) => setSetupToken(e.target.value)}
                    disabled={saving}
                    placeholder={
                      !isCreate && (provider?.hasClaudeCodeOauthToken || provider?.hasClaudeOAuthCredentials)
                        ? '输入新值覆盖'
                        : '粘贴 setup-token 或 cat ~/.claude/.credentials.json 输出'
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    支持粘贴{' '}
                    <code className="bg-muted px-1 rounded">cat ~/.claude/.credentials.json</code>{' '}
                    的 JSON 内容
                  </p>
                </div>
              )}

              {authTab === 'api_key' && (
                <div className="space-y-2">
                  <label className="block text-xs text-muted-foreground mb-1">
                    <span className="flex items-center gap-1.5">
                      <Key className="w-3.5 h-3.5" />
                      ANTHROPIC_API_KEY{' '}
                      {!isCreate && provider?.hasAnthropicApiKey
                        ? `(${provider.anthropicApiKeyMasked})`
                        : ''}
                    </span>
                  </label>
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    disabled={saving}
                    placeholder={
                      !isCreate && provider?.hasAnthropicApiKey
                        ? '输入新值覆盖'
                        : 'sk-ant-api03-...'
                    }
                    className="font-mono"
                  />
                  <p className="text-xs text-muted-foreground">
                    直接使用 Anthropic 官方 API Key，从{' '}
                    <a
                      href="https://console.anthropic.com/settings/keys"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-teal-600 underline"
                    >
                      console.anthropic.com
                    </a>{' '}
                    获取
                  </p>
                </div>
              )}
            </div>
          )}

          {/* ─── 第三方模式 ─── */}
          {providerType === 'third_party' && (
            <div className="space-y-4">
              {/* 第二级 backend 选择 */}
              <div>
                <label className="block text-xs text-muted-foreground mb-1">Backend 类型</label>
                <select
                  value={thirdPartyBackend}
                  onChange={(e) => setThirdPartyBackend(e.target.value as ThirdPartyBackend)}
                  disabled={saving}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                >
                  {THIRD_PARTY_BACKEND_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground mt-1">
                  {THIRD_PARTY_BACKEND_OPTIONS.find((o) => o.value === thirdPartyBackend)
                    ?.description}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  不确定？大多数 OpenAI/Claude 兼容网关（GLM、Minimax、LiteLLM unified
                  等）选「Anthropic 兼容网关」并建议勾选兼容模式。
                </p>
              </div>

              {/* anthropic_messages：Base URL + Auth Token + 可选兼容模式 */}
              {thirdPartyBackend === 'anthropic_messages' && (
                <>
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">
                      ANTHROPIC_BASE_URL <span className="text-red-500">*</span>
                    </label>
                    <Input
                      type="text"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      disabled={saving}
                      placeholder="https://your-relay.example.com/v1"
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">
                      ANTHROPIC_AUTH_TOKEN <span className="text-red-500">*</span>{' '}
                      {!isCreate && provider?.hasAnthropicAuthToken
                        ? `(${provider.anthropicAuthTokenMasked})`
                        : ''}
                    </label>
                    <Input
                      type="password"
                      value={authToken}
                      onChange={(e) => {
                        setAuthToken(e.target.value);
                        setAuthTokenDirty(true);
                        setClearTokenOnSave(false);
                      }}
                      disabled={saving || clearTokenOnSave}
                      placeholder={
                        isCreate
                          ? '输入 Token（必填）'
                          : provider?.hasAnthropicAuthToken
                            ? '留空不变；输入新值覆盖'
                            : '输入 Token（可选）'
                      }
                    />
                    {!isCreate && provider?.hasAnthropicAuthToken && (
                      <label className="mt-2 inline-flex items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={clearTokenOnSave}
                          onChange={(e) => {
                            setClearTokenOnSave(e.target.checked);
                            if (e.target.checked) {
                              setAuthToken('');
                              setAuthTokenDirty(false);
                            }
                          }}
                          disabled={saving}
                        />
                        保存时清空当前 Token
                      </label>
                    )}
                  </div>

                  <label className="inline-flex items-start gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={disableExperimentalBetas}
                      onChange={(e) => setDisableExperimentalBetas(e.target.checked)}
                      disabled={saving}
                      className="mt-0.5"
                    />
                    <span>
                      禁用实验 beta（兼容老网关）
                      <span className="block text-[11px] text-muted-foreground mt-0.5">
                        注入 <code className="bg-muted px-1 rounded">CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1</code>，
                        如果你的第三方网关报错 "Unsupported beta header"，请勾选。
                      </span>
                    </span>
                  </label>
                </>
              )}

              {/* bedrock：直连 cloud — 凭据走 IAM/AWS profile，不推荐 secret 入 customEnv */}
              {thirdPartyBackend === 'bedrock' && (
                <div className="rounded-md border border-amber-200 bg-amber-50/50 dark:bg-amber-950/30 p-3 text-xs text-amber-800 dark:text-amber-300 space-y-1">
                  <div className="font-medium">直连 AWS Bedrock — 凭据建议走运维侧机制</div>
                  <div>
                    推荐使用 IAM Role / EC2 instance profile / 容器 secret 等机制让进程自动获取 AWS 凭据；
                    如确实需要通过环境变量传递（例如本地调试），可在下方「自定义环境变量」加入
                    <code className="bg-muted px-1 rounded mx-1">AWS_REGION</code>、
                    <code className="bg-muted px-1 rounded">AWS_PROFILE</code>
                    等非敏感配置。
                  </div>
                  <div>
                    自定义环境变量在 GET 接口中以脱敏形式回显，但仍以加密形式持久化在磁盘。
                    凡敏感长期密钥（access key / secret / bearer token），优先用 IAM 短期凭据替代。
                  </div>
                  <div>
                    HappyClaw 会自动注入 <code className="bg-muted px-1 rounded">CLAUDE_CODE_USE_BEDROCK=1</code>。
                  </div>
                </div>
              )}

              {/* bedrock_gateway：Base URL（必填）+ 专用 Auth Token + customEnv 提示 */}
              {thirdPartyBackend === 'bedrock_gateway' && (
                <>
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">
                      Base URL <span className="text-red-500">*</span>
                      <span className="block text-[11px] text-muted-foreground">
                        用作 ANTHROPIC_BEDROCK_BASE_URL
                      </span>
                    </label>
                    <Input
                      type="text"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      disabled={saving}
                      placeholder="https://litellm.example.com/bedrock"
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">
                      Auth Token（网关认证，注入为 ANTHROPIC_AUTH_TOKEN）
                      {!isCreate && provider?.hasAnthropicAuthToken
                        ? ` (${provider.anthropicAuthTokenMasked})`
                        : ''}
                    </label>
                    <Input
                      type="password"
                      value={authToken}
                      onChange={(e) => {
                        setAuthToken(e.target.value);
                        setAuthTokenDirty(true);
                        setClearTokenOnSave(false);
                      }}
                      disabled={saving || clearTokenOnSave}
                      placeholder={
                        isCreate
                          ? '可选 — 网关要求 ANTHROPIC_AUTH_TOKEN 时填入'
                          : provider?.hasAnthropicAuthToken
                            ? '留空不变；输入新值覆盖'
                            : '可选 — 网关要求 ANTHROPIC_AUTH_TOKEN 时填入'
                      }
                    />
                    <p className="text-[11px] text-muted-foreground mt-1">
                      网关 token 通过此专用字段加密存储，<strong>不要</strong>在下方「自定义环境变量」里再次填写
                      <code className="bg-muted px-1 rounded mx-1">ANTHROPIC_AUTH_TOKEN</code>。
                    </p>
                    {!isCreate && provider?.hasAnthropicAuthToken && (
                      <label className="mt-2 inline-flex items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={clearTokenOnSave}
                          onChange={(e) => {
                            setClearTokenOnSave(e.target.checked);
                            if (e.target.checked) {
                              setAuthToken('');
                              setAuthTokenDirty(false);
                            }
                          }}
                          disabled={saving}
                        />
                        保存时清空当前 Token
                      </label>
                    )}
                  </div>

                  <div className="rounded-md border border-amber-200 bg-amber-50/50 dark:bg-amber-950/30 p-3 text-xs text-amber-800 dark:text-amber-300 space-y-1">
                    <div>
                      其他网关专属变量（例如 <code className="bg-muted px-1 rounded">AWS_BEARER_TOKEN_BEDROCK</code>）
                      可填到下方「自定义环境变量」。
                    </div>
                    <div>
                      HappyClaw 会自动注入
                      <code className="bg-muted px-1 rounded mx-1">CLAUDE_CODE_USE_BEDROCK=1</code>
                      和 <code className="bg-muted px-1 rounded">CLAUDE_CODE_SKIP_BEDROCK_AUTH=1</code>。
                    </div>
                  </div>
                </>
              )}

              {/* vertex：直连 GCP — 凭据走 ADC，不推荐 secret 入 customEnv */}
              {thirdPartyBackend === 'vertex' && (
                <div className="rounded-md border border-amber-200 bg-amber-50/50 dark:bg-amber-950/30 p-3 text-xs text-amber-800 dark:text-amber-300 space-y-1">
                  <div className="font-medium">直连 GCP Vertex — 凭据建议走运维侧机制</div>
                  <div>
                    推荐使用 GCP Application Default Credentials（ADC）/ Workload Identity / 容器 secret 让进程自动获取 GCP 凭据。
                    项目和区域等非敏感配置（例如
                    <code className="bg-muted px-1 rounded mx-1">ANTHROPIC_VERTEX_PROJECT_ID</code>、
                    <code className="bg-muted px-1 rounded">CLOUD_ML_REGION</code>）可填到下方「自定义环境变量」。
                  </div>
                  <div>
                    自定义环境变量在 GET 接口中以脱敏形式回显，但仍以加密形式持久化。
                    长期 service account JSON 文件路径请确保对应文件本身在容器中受访问控制保护。
                  </div>
                  <div>
                    HappyClaw 会自动注入 <code className="bg-muted px-1 rounded">CLAUDE_CODE_USE_VERTEX=1</code>。
                  </div>
                </div>
              )}

              {/* vertex_gateway：Base URL（必填）+ 专用 Auth Token + customEnv 提示 */}
              {thirdPartyBackend === 'vertex_gateway' && (
                <>
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">
                      Base URL <span className="text-red-500">*</span>
                      <span className="block text-[11px] text-muted-foreground">
                        用作 ANTHROPIC_VERTEX_BASE_URL
                      </span>
                    </label>
                    <Input
                      type="text"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      disabled={saving}
                      placeholder="https://litellm.example.com/vertex"
                    />
                  </div>

                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">
                      Auth Token（网关认证，注入为 ANTHROPIC_AUTH_TOKEN）
                      {!isCreate && provider?.hasAnthropicAuthToken
                        ? ` (${provider.anthropicAuthTokenMasked})`
                        : ''}
                    </label>
                    <Input
                      type="password"
                      value={authToken}
                      onChange={(e) => {
                        setAuthToken(e.target.value);
                        setAuthTokenDirty(true);
                        setClearTokenOnSave(false);
                      }}
                      disabled={saving || clearTokenOnSave}
                      placeholder={
                        isCreate
                          ? '可选 — 网关要求 ANTHROPIC_AUTH_TOKEN 时填入'
                          : provider?.hasAnthropicAuthToken
                            ? '留空不变；输入新值覆盖'
                            : '可选 — 网关要求 ANTHROPIC_AUTH_TOKEN 时填入'
                      }
                    />
                    <p className="text-[11px] text-muted-foreground mt-1">
                      网关 token 通过此专用字段加密存储，<strong>不要</strong>在下方「自定义环境变量」里再次填写
                      <code className="bg-muted px-1 rounded mx-1">ANTHROPIC_AUTH_TOKEN</code>。
                    </p>
                    {!isCreate && provider?.hasAnthropicAuthToken && (
                      <label className="mt-2 inline-flex items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={clearTokenOnSave}
                          onChange={(e) => {
                            setClearTokenOnSave(e.target.checked);
                            if (e.target.checked) {
                              setAuthToken('');
                              setAuthTokenDirty(false);
                            }
                          }}
                          disabled={saving}
                        />
                        保存时清空当前 Token
                      </label>
                    )}
                  </div>

                  <div className="rounded-md border border-amber-200 bg-amber-50/50 dark:bg-amber-950/30 p-3 text-xs text-amber-800 dark:text-amber-300 space-y-1">
                    <div>
                      GCP project / region 等非敏感变量可填到下方「自定义环境变量」。
                    </div>
                    <div>
                      HappyClaw 会自动注入
                      <code className="bg-muted px-1 rounded mx-1">CLAUDE_CODE_USE_VERTEX=1</code>
                      和 <code className="bg-muted px-1 rounded">CLAUDE_CODE_SKIP_VERTEX_AUTH=1</code>。
                    </div>
                  </div>
                </>
              )}

              {/* foundry：Base URL（可选）+ API Key/Auth Token（必填，二选一） */}
              {thirdPartyBackend === 'foundry' && (
                <>
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">
                      Base URL（可选）
                      <span className="block text-[11px] text-muted-foreground">
                        用作 ANTHROPIC_FOUNDRY_BASE_URL
                      </span>
                    </label>
                    <Input
                      type="text"
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      disabled={saving}
                      placeholder="https://your-foundry-resource.cognitiveservices.azure.com"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">
                      <span className="flex items-center gap-1.5">
                        <Key className="w-3.5 h-3.5" />
                        API Key <span className="text-red-500">*</span>
                        <span className="text-[11px] text-muted-foreground">
                          （或下方 Auth Token 二选一）
                        </span>
                        {!isCreate && provider?.hasAnthropicApiKey
                          ? `(${provider.anthropicApiKeyMasked})`
                          : ''}
                      </span>
                    </label>
                    <Input
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      disabled={saving}
                      placeholder={
                        !isCreate && provider?.hasAnthropicApiKey
                          ? '输入新值覆盖'
                          : '输入 Foundry API Key'
                      }
                      className="font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-muted-foreground mb-1">
                      Auth Token（可选，与 API Key 二选一）{' '}
                      {!isCreate && provider?.hasAnthropicAuthToken
                        ? `(${provider.anthropicAuthTokenMasked})`
                        : ''}
                    </label>
                    <Input
                      type="password"
                      value={authToken}
                      onChange={(e) => {
                        setAuthToken(e.target.value);
                        setAuthTokenDirty(true);
                        setClearTokenOnSave(false);
                      }}
                      disabled={saving}
                      placeholder={
                        !isCreate && provider?.hasAnthropicAuthToken
                          ? '留空不变；输入新值覆盖'
                          : '输入 Auth Token'
                      }
                    />
                  </div>
                  <div className="rounded-md border border-amber-200 bg-amber-50/50 dark:bg-amber-950/30 p-3 text-xs text-amber-800 dark:text-amber-300">
                    HappyClaw 会自动注入
                    <code className="bg-muted px-1 rounded mx-1">CLAUDE_CODE_USE_FOUNDRY=1</code>
                    并把上方填的 API Key 映射到 ANTHROPIC_FOUNDRY_API_KEY。
                  </div>
                </>
              )}
            </div>
          )}

          {/* ─── 模型选择 ─── */}
          <div>
            <label className="block text-xs text-muted-foreground mb-1">
              {providerType === 'official' ? '模型' : 'ANTHROPIC_MODEL'}
            </label>
            {providerType === 'official' ? (
              <>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={saving}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/30"
                >
                  <option value="">default（默认）</option>
                  <option value="sonnet">sonnet</option>
                  <option value="haiku">haiku</option>
                </select>
                <p className="text-xs text-muted-foreground mt-1">
                  别名自动解析为最新版本，留空使用 default。
                </p>
              </>
            ) : (
              <>
                <Input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={saving}
                  placeholder="第三方 API 的模型名称"
                  className="font-mono"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  注入为 ANTHROPIC_MODEL 环境变量，值取决于第三方 API 支持的模型。
                </p>
              </>
            )}
          </div>

          {/* ─── 自定义环境变量 ─── */}
          <div className="border-t border-border pt-4">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs text-muted-foreground">其他自定义环境变量（可选）</label>
              <button
                type="button"
                onClick={addRow}
                className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                添加
              </button>
            </div>
            <p className="mb-2 text-xs text-muted-foreground">
              这些变量仅在当前提供商生效，不同提供商互不影响。已存在的变量值以脱敏形式显示
              （<code className="bg-muted px-1 rounded">{MASKED_VALUE_PLACEHOLDER}</code>），
              <strong>未修改的行</strong>保存时不会被覆盖；输入新值或修改 key 即视为更新该条目。
            </p>

            {customEnvRows.length === 0 ? (
              <p className="text-xs text-muted-foreground">暂无</p>
            ) : (
              <div className="space-y-2">
                {customEnvRows.map((row, idx) => {
                  const isMaskedPlaceholder =
                    row.value === MASKED_VALUE_PLACEHOLDER && !row.dirty;
                  return (
                    <div key={idx} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                      <Input
                        type="text"
                        value={row.key}
                        onChange={(e) => updateRow(idx, 'key', e.target.value)}
                        placeholder="KEY"
                        className="w-full sm:w-[38%] px-2.5 py-1.5 text-xs font-mono h-auto"
                      />
                      <Input
                        type="text"
                        value={row.value}
                        onChange={(e) => updateRow(idx, 'value', e.target.value)}
                        title={
                          isMaskedPlaceholder
                            ? '已存值（脱敏）— 点击该输入框并输入新值即视为修改；不修改则保留此占位符'
                            : undefined
                        }
                        placeholder="value"
                        className={`flex-1 px-2.5 py-1.5 text-xs font-mono h-auto ${
                          isMaskedPlaceholder ? 'text-muted-foreground italic' : ''
                        }`}
                      />
                      <button
                        type="button"
                        onClick={() => removeRow(idx)}
                        className="w-8 h-8 rounded-md hover:bg-muted text-muted-foreground hover:text-red-500 flex items-center justify-center cursor-pointer"
                        aria-label="删除环境变量"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ─── 权重 ─── */}
          <div className="border-t border-border pt-3">
            <div className="flex items-center gap-2 mb-1">
              <label className="block text-sm font-medium">权重</label>
              {balancingStrategy === 'weighted-round-robin' && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium bg-teal-100 text-teal-800">
                  当前策略生效中
                </span>
              )}
            </div>
            <Input
              type="number"
              min={1}
              max={100}
              value={weight}
              onChange={(e) => setWeight(Math.max(1, Math.min(100, parseInt(e.target.value) || 1)))}
              disabled={saving}
              className="w-24"
            />
            <p className="text-xs text-muted-foreground mt-1">
              {balancingStrategy === 'weighted-round-robin'
                ? '值越大分配到的请求越多。例如三家分别设 5/3/2，流量比例就是 5:3:2。'
                : '仅当负载均衡策略为「加权轮询」时生效（当前策略未生效）。范围 1–100。'}
            </p>
          </div>

          {/* ─── 操作按钮 ─── */}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={handleClose} disabled={saving || oauthExchanging}>
              取消
            </Button>
            {/* OAuth 模式下创建时不需要保存按钮（OAuth 回调会自动触发 onSave） */}
            <Button onClick={handleSave} disabled={saving || oauthExchanging}>
              {saving && <Loader2 className="size-4 animate-spin" />}
              {isCreate ? '创建' : '保存'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
