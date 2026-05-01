/**
 * Provider 错误诊断
 *
 * 纯函数 helper：根据 stderr / stdout 中的错误文本片段（以及可选的 backend 提示），
 * 返回一个结构化诊断对象，给运维和用户一个明确的「下一步该怎么办」。
 *
 * 关联背景：Claude Code issue #30926 — Anthropic Messages 兼容网关在 SDK 升级后
 * 会被注入新的 beta header（如 `advanced-tool-use-2025-11-20`），后端 Bedrock /
 * Vertex 不识别会直接 4xx；`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` 对部分 beta
 * 失效，根治方法是显式声明 backend 走 SDK 原生 Bedrock / Vertex 路径，或者在
 * provider 上勾选「禁用实验 beta」。
 *
 * 本模块零副作用，可在任何上下文使用：
 * - `agent-output-parser.ts` 解析 stderr 时挂诊断到 ContainerOutput
 * - `provider-pool.ts` reportFailure 之后记录 lastDiagnostic
 * - `routes/config.ts` GET /claude/providers 的 DTO 暴露 hint
 */

import type { ProviderBackend } from './runtime-config.js';

export type ProviderDiagnosticKind =
  | 'invalid_beta'
  | 'unsupported_beta'
  | 'bedrock_auth'
  | 'vertex_auth'
  | 'foundry_auth'
  | 'unknown';

export interface ProviderDiagnostic {
  kind: ProviderDiagnosticKind;
  /** Short human-readable summary of the matched error text. */
  message: string;
  /** Concrete next step phrased in 中文，面向运维 / 用户。 */
  hint: string;
  /** Optional structured action token consumed by UI to render a CTA button. */
  suggestedAction?:
    | 'switch_backend_bedrock'
    | 'switch_backend_vertex'
    | 'enable_disable_experimental_betas'
    | 'check_aws_credentials'
    | 'check_gcp_credentials'
    | 'check_azure_credentials';
}

export interface DiagnoseInput {
  /** Combined stderr + error message text. */
  errorText?: string;
  /** Optional HTTP-like status code or short code from upstream. */
  errorCode?: string | number;
  /** Optional backend hint when caller knows which provider was active. */
  backend?: ProviderBackend;
}

// ─── 子串匹配规则（按优先级从高到低） ─────────────────────────

/** Substring matchers — tested via case-insensitive `includes`. */
interface Rule {
  kind: ProviderDiagnosticKind;
  /** Lowercase tokens — ALL must appear in errorText for the rule to match. */
  needles: string[];
  build: (
    input: DiagnoseInput,
    matchedNeedle: string,
  ) => Omit<ProviderDiagnostic, 'kind'>;
}

const RULES: Rule[] = [
  // —— invalid / unsupported beta 类 ————————————————————————
  {
    kind: 'invalid_beta',
    needles: ['invalid beta flag'],
    build: () => ({
      message: '上游返回 invalid beta flag',
      hint: '当前 provider 走 Anthropic Messages 路径，但后端不识别 SDK 注入的实验性 beta header。若实际后端是 Bedrock/Vertex，请把 backend 切换为 bedrock_gateway 或 vertex_gateway；否则在 provider 上勾选「禁用实验 beta」复选框。',
      suggestedAction: 'enable_disable_experimental_betas',
    }),
  },
  {
    kind: 'unsupported_beta',
    needles: ['unsupported beta'],
    build: () => ({
      message: '上游返回 unsupported beta header',
      hint: '后端不支持当前 SDK 注入的 beta header。若网关后端是 Bedrock/Vertex，请改用对应 gateway backend；其它情况下在 provider 上勾选「禁用实验 beta」。',
      suggestedAction: 'enable_disable_experimental_betas',
    }),
  },
  {
    kind: 'unsupported_beta',
    needles: ['anthropic-beta', 'unrecognized'],
    build: () => ({
      message: '上游不识别 anthropic-beta header',
      hint: '常见于 Anthropic Messages 兼容网关 + Bedrock/Vertex 后端。请在 provider 上勾选「禁用实验 beta」或切换到 bedrock_gateway / vertex_gateway。',
      suggestedAction: 'enable_disable_experimental_betas',
    }),
  },

  // —— Bedrock 认证类 ————————————————————————————————————————
  {
    kind: 'bedrock_auth',
    needles: ['bedrock', 'unauthorized'],
    build: () => ({
      message: 'Bedrock 认证失败',
      hint: '检查容器是否能透传 AWS 凭据（AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION 或 AWS_PROFILE / AWS_BEARER_TOKEN_BEDROCK），并确认 IAM 角色对目标 model 的 invoke 权限已开通。',
      suggestedAction: 'check_aws_credentials',
    }),
  },
  {
    kind: 'bedrock_auth',
    needles: ['bedrock', 'forbidden'],
    build: () => ({
      message: 'Bedrock 拒绝调用 (403)',
      hint: 'AWS IAM 通常在角色或 model 层禁用了 invoke 权限。检查 AWS_REGION 是否与 model 区域一致，IAM policy 是否包含 bedrock:InvokeModel*。',
      suggestedAction: 'check_aws_credentials',
    }),
  },
  {
    kind: 'bedrock_auth',
    needles: ['accessdeniedexception'],
    build: () => ({
      message: 'AWS AccessDenied',
      hint: '上游 Bedrock 返回 AccessDeniedException。通常是 IAM 凭据或角色未授予目标 model 的 invoke 权限。',
      suggestedAction: 'check_aws_credentials',
    }),
  },

  // —— Vertex 认证类 ————————————————————————————————————————
  {
    kind: 'vertex_auth',
    needles: ['vertex', 'unauthorized'],
    build: () => ({
      message: 'Vertex 认证失败',
      hint: '检查 Google Cloud 凭据（ADC、服务账号 JSON、ANTHROPIC_VERTEX_PROJECT_ID / CLOUD_ML_REGION）是否在容器内可见，且账户具备 aiplatform.endpoints.predict 权限。',
      suggestedAction: 'check_gcp_credentials',
    }),
  },
  {
    kind: 'vertex_auth',
    needles: ['vertex', 'permission denied'],
    build: () => ({
      message: 'Vertex 权限不足',
      hint: 'GCP 服务账号缺少 Vertex AI 调用权限（roles/aiplatform.user 或更高）。请在 IAM 中授予对应角色，或确认 region 与 endpoint 设置一致。',
      suggestedAction: 'check_gcp_credentials',
    }),
  },
  {
    kind: 'vertex_auth',
    needles: ['could not load default credentials'],
    build: () => ({
      message: 'GCP ADC 未找到',
      hint: '容器内没有 Application Default Credentials。请挂载 GCP 服务账号 JSON 并通过 GOOGLE_APPLICATION_CREDENTIALS 指向它，或使用其它官方支持的认证方式。',
      suggestedAction: 'check_gcp_credentials',
    }),
  },

  // —— Foundry 认证类 ————————————————————————————————————————
  {
    kind: 'foundry_auth',
    needles: ['foundry', 'unauthorized'],
    build: () => ({
      message: 'Foundry 认证失败',
      hint: '检查 Azure / Microsoft Foundry 凭据：ANTHROPIC_FOUNDRY_API_KEY 或 Entra ID token 是否正确，资源端点 ANTHROPIC_FOUNDRY_RESOURCE / ANTHROPIC_FOUNDRY_BASE_URL 与 deployment 是否匹配。',
      suggestedAction: 'check_azure_credentials',
    }),
  },
  {
    kind: 'foundry_auth',
    needles: ['azure', 'invalid_api_key'],
    build: () => ({
      message: 'Azure / Foundry API key 无效',
      hint: '上游返回 invalid_api_key。请重新生成 Foundry API key 并更新 provider 配置，确认 deployment name / resource 端点与 key 来自同一资源。',
      suggestedAction: 'check_azure_credentials',
    }),
  },
];

// ─── 主入口 ───────────────────────────────────────────────────

/**
 * 诊断 provider 错误。返回 null 表示无匹配规则（调用方可继续走通用错误路径）。
 *
 * 设计：
 * - 不抛异常
 * - 不读 fs / 不发起网络请求 / 不依赖全局状态
 * - 多条规则按列表顺序匹配，第一条命中即返回
 */
export function diagnoseProviderError(
  input: DiagnoseInput,
): ProviderDiagnostic | null {
  const text = (input.errorText || '').toLowerCase();
  const code =
    typeof input.errorCode === 'number'
      ? String(input.errorCode)
      : (input.errorCode || '').toString().toLowerCase();

  if (!text && !code) return null;

  // Combined search corpus: errorText + errorCode (so codes like "AccessDeniedException" can match)
  const corpus = `${text} ${code}`.trim();
  if (!corpus) return null;

  for (const rule of RULES) {
    const allMatch = rule.needles.every((needle) => corpus.includes(needle));
    if (!allMatch) continue;
    const built = rule.build(input, rule.needles[0]);
    return {
      kind: rule.kind,
      ...built,
    };
  }

  return null;
}

/**
 * 序列化诊断为简短一行（日志友好）。
 */
export function diagnosticToLogLine(d: ProviderDiagnostic): string {
  return `[${d.kind}] ${d.message} -> ${d.hint}`;
}
