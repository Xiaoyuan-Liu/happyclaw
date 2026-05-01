# Claude Agent SDK 第三方 Provider 调研记录

调研日期：2026-04-30

本文记录 Claude Code / Claude Agent SDK 当前第三方 API 接入现状、上游 issue #30926 的根因，以及 HappyClaw 当前接入模型的差距。本文只做事实沉淀和改造建议，不代表已经修改运行逻辑。

## 结论摘要

HappyClaw 目前不是完全不支持第三方 API，而是第三方 provider 抽象偏旧：主要把第三方接入统一建模为 `ANTHROPIC_BASE_URL` + token + `ANTHROPIC_MODEL`。

这对 Anthropic Messages 兼容网关通常能工作，但 Claude Code / Claude Agent SDK 现在已经有更细的 provider 语义：

- Anthropic Messages 格式网关：`ANTHROPIC_BASE_URL`
- Amazon Bedrock：`CLAUDE_CODE_USE_BEDROCK=1`
- Google Vertex AI：`CLAUDE_CODE_USE_VERTEX=1`
- Microsoft Foundry：`CLAUDE_CODE_USE_FOUNDRY=1`
- Bedrock / Vertex 的网关透传场景还有对应的 provider-specific base URL 和 skip auth env

因此，HappyClaw 当前的通用 `third_party` 模型在 Bedrock-backed / Vertex-backed gateway 上容易被 SDK 识别成 first-party / Anthropic Messages 路径，从而触发不兼容的 beta header 或认证路径。

补充调研结论：

- HappyClaw 根项目当前安装的 `@anthropic-ai/claude-agent-sdk` 版本与 `container/agent-runner` 使用的版本可能不一致；调研时根项目是 `0.2.87`，`container/agent-runner` lock 中是 `0.2.123`。这会导致 `src/sdk-query.ts` 与主 agent-runner 面对不同 SDK 行为。
- 当前 provider 配置文件的 `version` 是 HappyClaw 本地配置 schema 版本，不是 HappyClaw 应用版本。若 provider 存储结构新增 backend 字段，建议升级配置 schema，并提供旧配置自动迁移。
- GLM、Minimax 等非 Claude 官方 provider 没有 Claude Agent SDK 原生 backend。它们只能通过 Anthropic Messages 兼容网关接入，归类为 `anthropic_messages`，并需要更保守的兼容策略。

## 官方文档现状

Claude Code SDK 已重命名为 Claude Agent SDK。Agent SDK 文档明确说它复用 Claude Code 的能力，并支持第三方 API provider：

- Amazon Bedrock：设置 `CLAUDE_CODE_USE_BEDROCK=1` 并配置 AWS credentials。
- Google Vertex AI：设置 `CLAUDE_CODE_USE_VERTEX=1` 并配置 Google Cloud credentials。
- Microsoft Foundry：设置 `CLAUDE_CODE_USE_FOUNDRY=1` 并配置 Azure credentials 或 API key。

LLM gateway 文档还明确区分了几类 API 格式：

- Anthropic Messages：`/v1/messages`、`/v1/messages/count_tokens`
- Bedrock InvokeModel：`/invoke`、`/invoke-with-response-stream`
- Vertex rawPredict：`:rawPredict`、`:streamRawPredict`、`/count-tokens:rawPredict`

对 Anthropic Messages 格式网关，官方要求网关转发 `anthropic-beta` 和 `anthropic-version` header。文档同时提醒：当使用 Anthropic Messages 格式代理到 Bedrock 或 Vertex 后端时，可能需要设置 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`。

Bedrock / Vertex 通过 LiteLLM 等网关做 provider-specific pass-through 时，官方推荐使用 provider-specific env，而不是只用 `ANTHROPIC_BASE_URL`：

```bash
# Bedrock through LiteLLM
export ANTHROPIC_BEDROCK_BASE_URL=https://litellm-server:4000/bedrock
export CLAUDE_CODE_SKIP_BEDROCK_AUTH=1
export CLAUDE_CODE_USE_BEDROCK=1

# Vertex through LiteLLM
export ANTHROPIC_VERTEX_BASE_URL=https://litellm-server:4000/vertex_ai/v1
export ANTHROPIC_VERTEX_PROJECT_ID=your-gcp-project-id
export CLAUDE_CODE_SKIP_VERTEX_AUTH=1
export CLAUDE_CODE_USE_VERTEX=1
export CLOUD_ML_REGION=us-east5
```

Foundry 文档中的核心 env：

```bash
export CLAUDE_CODE_USE_FOUNDRY=1
export ANTHROPIC_FOUNDRY_RESOURCE={resource}
# 或
export ANTHROPIC_FOUNDRY_BASE_URL=https://{resource}.services.ai.azure.com/anthropic
export ANTHROPIC_FOUNDRY_API_KEY=your-azure-api-key
```

模型 pinning 也需要纳入 provider 配置能力。Bedrock、Vertex、Foundry 官方文档都建议 pin 默认模型，避免 `opus` / `sonnet` / `haiku` alias 随 Claude Code 默认值变化后，云厂商账号未启用新模型而报错。相关 env 包括：

```bash
export ANTHROPIC_DEFAULT_OPUS_MODEL=...
export ANTHROPIC_DEFAULT_SONNET_MODEL=...
export ANTHROPIC_DEFAULT_HAIKU_MODEL=...
```

## 上游 issue #30926 根因

Issue: https://github.com/anthropics/claude-code/issues/30926

该 issue 描述的是 Claude Code 2.1.69 相比 2.1.68 新增发送 `advanced-tool-use-2025-11-20` beta flag，导致 LiteLLM + AWS Bedrock gateway 返回 400：

```text
invalid beta flag
```

关键点：

- 用户配置的是 `ANTHROPIC_BASE_URL=https://<litellm-gateway>`。
- 实际后端是 Bedrock，但没有设置 `CLAUDE_CODE_USE_BEDROCK=1`，因为认证通过 LiteLLM API key 完成，不走 AWS IAM。
- SDK / Claude Code provider detection 只看到 `ANTHROPIC_BASE_URL`，于是按 first-party / Anthropic Messages 路径处理。
- 该路径会带上 Bedrock 不支持的 beta flag。
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` 对 issue 中的 `advanced-tool-use-2025-11-20` 没有完全解决作用，因为该 beta 当时不受这个开关控制。

这说明仅靠 `ANTHROPIC_BASE_URL` 无法表达“这个 endpoint 虽然暴露 Anthropic Messages 格式，但真实 backend 是 Bedrock / Vertex”。

## HappyClaw 当前相关实现

当前 HappyClaw provider 配置主要集中在：

- `src/runtime-config.ts`
- `src/container-runner.ts`
- `src/sdk-query.ts`
- `web/src/components/settings/ProviderEditor.tsx`
- `web/src/pages/SetupProvidersPage.tsx`

现有运行时结构中，第三方 provider 主要字段是：

- `type: 'third_party'`
- `anthropicBaseUrl`
- `anthropicAuthToken`
- `anthropicModel`
- `customEnv`

`buildClaudeEnvLines()` 里当前逻辑大致是：

- 有 `anthropicBaseUrl` 时注入 `ANTHROPIC_BASE_URL`。
- 有 `anthropicAuthToken` 且有 base URL 时，将 token 注入为 `ANTHROPIC_API_KEY`，避免 SDK 把 `ANTHROPIC_AUTH_TOKEN` 当 OAuth legacy path。
- 有 `anthropicModel` 时注入 `ANTHROPIC_MODEL`。
- 再合并 provider 的 `customEnv`。

`container-runner` 里还针对第三方 provider 做了防 OAuth 误判处理：

- 删除继承来的 `ANTHROPIC_AUTH_TOKEN`。
- 去掉 `.claude.json` 里的 `oauthAccount`。
- 删除 stale `.credentials.json`。

这些处理主要解决的是“第三方 base URL 下 SDK 误走 OAuth / 官方登录态”的问题，但没有解决 provider backend 类型问题，也没有内建 Bedrock / Vertex / Foundry 的官方 env 语义。

OAuth 清理的含义需要明确：这里清理的是 Claude 官方登录态，不是所有 OAuth。Claude Code / Agent SDK 会从 env、`.credentials.json`、`.claude.json.oauthAccount` 等位置发现官方 Claude 登录态。如果当前访问的是第三方网关，但进程里残留官方 OAuth，SDK 可能误走官方认证路径，导致第三方网关收到错误 Authorization header 或直接选错 provider path。因此第三方 gateway / Bedrock / Vertex / Foundry backend 下应清理 Claude 官方 OAuth；官方 Claude backend 下则必须保留。

当前代码还存在一个潜在不一致点：`src/sdk-query.ts` 使用根项目 SDK，并直接通过 `getClaudeProviderConfig()` + `buildClaudeEnvLines()` 临时写入 `process.env`；主 agent-runner 则走 `container/agent-runner` 的 SDK 和 provider pool / sticky binding。两处 SDK 版本和 provider 选择逻辑都应统一，否则辅助查询与主会话可能表现不同。

## 当前差距

### 1. Provider 类型过粗

HappyClaw 当前只有 `official` / `third_party`。但 Claude Agent SDK 现在实际需要至少区分：

- official Anthropic API
- Anthropic Messages compatible gateway
- Bedrock direct
- Bedrock gateway / pass-through
- Vertex direct
- Vertex gateway / pass-through
- Foundry

如果继续只用 `third_party`，HappyClaw 无法知道该注入 `ANTHROPIC_BASE_URL`，还是 `ANTHROPIC_BEDROCK_BASE_URL` + `CLAUDE_CODE_USE_BEDROCK=1`，或者 Vertex / Foundry 的 env。

### 2. Beta header 兼容策略不足

官方 LLM gateway 文档已经把 `anthropic-beta` 作为网关要求的一部分，并且提醒 Bedrock / Vertex 后端可能需要 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`。

HappyClaw 当前没有基于 provider backend 类型默认设置这个兼容开关。用户可以通过 custom env 手动加，但 UI 和配置模型没有表达“这是 Bedrock-backed Anthropic Messages gateway”。

### 3. 通用 `ANTHROPIC_BASE_URL` 容易触发错误 provider detection

对于 Bedrock-backed LiteLLM，如果 HappyClaw 只注入 `ANTHROPIC_BASE_URL`，SDK 会按 Anthropic Messages path 处理，而不是 Bedrock provider path。issue #30926 就是这种配置的典型失败模式。

### 4. UI 没有展示官方第三方 provider 接入方式

当前第三方配置页主要提示：

- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_AUTH_TOKEN`
- `ANTHROPIC_MODEL`
- 自定义 env

这会引导用户把所有第三方都当作 Anthropic-compatible gateway。对 Bedrock / Vertex / Foundry 用户来说，需要自行知道并手写 custom env，容易配置错。

### 5. SDK 版本与行为不一致

根项目和 `container/agent-runner` 分别依赖 Claude Agent SDK。若两边版本不同，则以下行为可能不一致：

- provider detection
- beta header 选择
- auth env 优先级
- `Options.env` / `settingSources` / session API 类型
- Claude Code 内置工具名称和事件结构

建议 pin 到同一版本或建立明确的升级策略，不应一处使用 semver range，另一处使用 `"*"` 并依赖构建时最新版本。

### 6. 配置文件 schema 迁移需要明确

`data/config/claude-provider.json` 中的 `version` 是本地配置文件格式版本。历史演进：

- 初始版本 `c148a14`：`CURRENT_CONFIG_VERSION = 2`，单一 provider 配置。
- `c9f2f70`：升级到 V3，支持第三方多 profile 和官方凭据分离。
- `06340f2`：引入 V4，统一为 `providers[] + balancing`，支持多 provider 负载均衡。

当前 V4 读取逻辑是懒迁移：

- `readStoredStateV4()` 发现 `version: 4` 时直接读取。
- 如果不是 V4，则调用旧的 `readStoredState()` 读取 V3 / V2 / legacy。
- 然后 `migrateV3toV4()`。
- 最后 `writeStoredStateV4()` 写回本地文件。

因此未来若增加 V5，不是改 HappyClaw 应用版本，而是给本地 provider 配置新增 schema。用户升级代码后，第一次读取 provider 配置时自动从 V4 迁移到 V5。

## 建议改造方向

建议保留现有配置兼容，同时新增 backend 类型字段，而不是直接改变 `third_party` 行为。

### 配置模型

可以在 provider 上新增类似字段：

```ts
backend:
  | 'anthropic_official'
  | 'anthropic_messages'
  | 'bedrock'
  | 'bedrock_gateway'
  | 'vertex'
  | 'vertex_gateway'
  | 'foundry';
```

为了兼容老配置：

- 老的 `type: 'third_party'` 且没有 backend 时，默认视为 `anthropic_messages`。
- 老用户现有 `ANTHROPIC_BASE_URL` 行为保持不变。
- 新建 provider 时让用户显式选择 backend。
- 如果升级存储结构，建议新增 V5 schema 和 `migrateV4toV5()`；若只加 optional 字段也可行，但会让“旧 V4”和“新 V4”共用同一个版本号，长期排查更困难。

backend 语义说明：

- `anthropic_official`：官方 Anthropic API / Claude OAuth。
- `anthropic_messages`：暴露 Anthropic Messages `/v1/messages` 的兼容网关。GLM、Minimax、OpenAI-compatible 模型若通过 LiteLLM / one-api / new-api / 自建 adapter 转成 Anthropic Messages，属于这个类型。
- `bedrock`：直连 AWS Bedrock。
- `bedrock_gateway`：通过 LiteLLM 或企业网关访问 Bedrock pass-through。
- `vertex`：直连 Google Vertex AI。
- `vertex_gateway`：通过网关访问 Vertex pass-through。
- `foundry`：Microsoft Foundry；如后续需要也可拆出 `foundry_gateway`。

GLM / Minimax 等模型没有 Claude Agent SDK 原生 provider；如果只有 OpenAI-compatible endpoint，Claude Agent SDK 不能直接访问，必须通过 Anthropic Messages adapter 接入。

### 环境变量生成

按 backend 注入 env：

```text
anthropic_messages:
  ANTHROPIC_BASE_URL
  ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN
  ANTHROPIC_MODEL
  可选 CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1

bedrock:
  CLAUDE_CODE_USE_BEDROCK=1
  AWS_REGION / AWS_PROFILE / AWS_* 通过 customEnv 或专门字段
  ANTHROPIC_DEFAULT_*_MODEL 或 ANTHROPIC_MODEL 视 SDK 支持再定

bedrock_gateway:
  CLAUDE_CODE_USE_BEDROCK=1
  CLAUDE_CODE_SKIP_BEDROCK_AUTH=1
  ANTHROPIC_BEDROCK_BASE_URL
  token 走网关支持的 env，需结合官方和实际 SDK 行为验证

vertex:
  CLAUDE_CODE_USE_VERTEX=1
  CLOUD_ML_REGION
  ANTHROPIC_VERTEX_PROJECT_ID

vertex_gateway:
  CLAUDE_CODE_USE_VERTEX=1
  CLAUDE_CODE_SKIP_VERTEX_AUTH=1
  ANTHROPIC_VERTEX_BASE_URL
  ANTHROPIC_VERTEX_PROJECT_ID
  CLOUD_ML_REGION

foundry:
  CLAUDE_CODE_USE_FOUNDRY=1
  ANTHROPIC_FOUNDRY_RESOURCE 或 ANTHROPIC_FOUNDRY_BASE_URL
  ANTHROPIC_FOUNDRY_API_KEY 或 Azure default credential chain
```

另外建议统一注入：

```bash
CLAUDE_AGENT_SDK_CLIENT_APP=happyclaw
```

用于 SDK User-Agent / 审计识别。

### Beta header 策略

建议提供两个层级：

1. 默认策略：
   - 对 `anthropic_messages` gateway 可默认注入 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`，降低代理兼容风险。
   - 对明确的 Bedrock / Vertex gateway，根据官方文档和实测设置必要开关。
2. 高级覆盖：
   - 允许用户在 custom env 中显式覆盖默认值。
   - UI 文案说明：如果网关完整支持 Claude Code beta headers，可以关闭该兼容开关。

需要注意：issue #30926 中提到 `advanced-tool-use-2025-11-20` 在当时不受 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` 控制。因此该开关不能被视为万能修复。更根本的修复是让 Bedrock / Vertex 后端走 SDK 对应 provider path，或在 gateway 层支持 / 过滤对应 beta。

### UI

第三方 provider 创建 / 编辑页建议从“只填 base URL”升级为“选择接入类型”：

- Anthropic-compatible gateway
- Amazon Bedrock
- Amazon Bedrock via gateway
- Google Vertex AI
- Google Vertex AI via gateway
- Microsoft Foundry

不同类型展示不同字段，减少用户手写 custom env。

### 错误诊断

建议在 API error parser 或 provider health 中识别以下错误，并给出可操作提示：

- `invalid beta flag`
- `Unsupported beta header`
- Bedrock / Vertex / Foundry auth 失败
- gateway 不支持 `count_tokens`
- tool use / thinking schema 不兼容

例如遇到 `invalid beta flag` 时，提示用户：

- 如果真实 backend 是 Bedrock / Vertex，改用 `bedrock_gateway` / `vertex_gateway`。
- 如果只能使用 Anthropic Messages gateway，尝试启用 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` 或升级 / 配置 gateway beta whitelist。
- 如果是 GLM / Minimax adapter，确认网关是否过滤 Claude Code 不支持的 beta 和 tool schema。

### 具体实施计划

建议分阶段执行，避免一次性改动过大：

1. 配置地基：
   - 在 provider runtime 类型中增加 backend 概念。
   - 增加 V4 -> V5 migration，老 `third_party` 默认迁移为 `anthropic_messages`。
   - 保留旧字段和旧行为，确保现有 `ANTHROPIC_BASE_URL` 用户不受影响。
2. Env builder：
   - 将 `buildClaudeEnvLines()` 从“看 base URL 判断”改为“看 backend 判断”。
   - OAuth 清理逻辑也按 backend 处理。
   - host/container/sdkQuery 三条链路复用同一 env builder。
3. API / schema：
   - 扩展 create / patch / secrets schema。
   - public DTO 暴露 backend 和脱敏字段。
   - 按 backend 校验必填项。
4. 前端：
   - ProviderEditor 和 SetupProvidersPage 增加 backend 选择。
   - 分 backend 展示字段。
   - 保留 custom env 高级入口。
5. SDK 版本：
   - pin 根项目和 `container/agent-runner` 的 Agent SDK 到同一版本。
   - 明确 `@anthropic-ai/claude-code` 是否仍需独立依赖，避免 SDK/CLI 版本漂移。
6. 诊断与文档：
   - 增加 invalid beta / auth path 诊断。
   - 更新设置页提示和 README / docs。

### 测试

建议先补纯函数测试，不依赖真实第三方服务：

- V4 -> V5 迁移：老 official provider、老 third_party provider、balancing、customEnv、secrets 脱敏均保持。
- 老 `third_party` 配置仍输出原来的 `ANTHROPIC_BASE_URL` 行为。
- `bedrock_gateway` 输出 `CLAUDE_CODE_USE_BEDROCK=1`、`CLAUDE_CODE_SKIP_BEDROCK_AUTH=1`、`ANTHROPIC_BEDROCK_BASE_URL`。
- `vertex_gateway` 输出 `CLAUDE_CODE_USE_VERTEX=1`、`CLAUDE_CODE_SKIP_VERTEX_AUTH=1`、`ANTHROPIC_VERTEX_BASE_URL`。
- `foundry` 输出 `CLAUDE_CODE_USE_FOUNDRY=1` 和 Foundry 相关 env。
- custom env 能覆盖默认 beta 兼容开关。
- provider pool / session sticky binding 不受 backend 字段影响。
- host/container 双链路：确认 env 文件、`hostEnv`、`.credentials.json`、`.claude.json.oauthAccount` 处理一致。
- API / UI：create、patch、secrets、toggle、balancing、旧 provider 编辑不丢字段。
- 回归：官方 OAuth、官方 API key、现有 third_party `ANTHROPIC_BASE_URL` 老配置仍可用。

## 实施风险

- SDK 版本更新频繁，provider-specific env 的细节需要以当前 SDK 和官方文档为准。
- Bedrock / Vertex gateway token 的注入方式需要实测。官方文档对 LiteLLM unified endpoint 说 `ANTHROPIC_AUTH_TOKEN` 会作为 Authorization header；但 HappyClaw 当前为了避开 SDK OAuth path，把第三方 token 映射到了 `ANTHROPIC_API_KEY`。这部分不能贸然改全局行为。
- 旧配置必须无损兼容，否则会影响已有用户的第三方代理。
- 如果默认禁用 experimental betas，可能影响部分 Claude Code 新功能；应允许用户覆盖。
- 非 Claude 原生后端（GLM、Minimax 等）即使通过 Anthropic Messages adapter 接入，也可能不支持 Claude Code 的全部 tool use、thinking、beta 能力；HappyClaw 只能提供兼容配置和错误提示，无法保证模型能力等价。
- V5 迁移涉及加密 secrets；需要测试迁移不会丢 token，也需要考虑用户降级代码时无法读取新 schema 的风险。
- `sdkQuery()` 与主 agent-runner 如果继续使用不同 SDK 版本或不同 provider selection，会出现“辅助查询成功但主会话失败”或相反的情况。

## 参考链接

- Claude Agent SDK overview: https://code.claude.com/docs/en/agent-sdk/overview
- LLM gateway configuration: https://code.claude.com/docs/en/llm-gateway
- Claude Code on Amazon Bedrock: https://code.claude.com/docs/en/amazon-bedrock
- Claude Code on Google Vertex AI: https://code.claude.com/docs/en/google-vertex-ai
- Claude Code on Microsoft Foundry: https://code.claude.com/docs/en/microsoft-foundry
- Claude Code env vars: https://code.claude.com/docs/en/env-vars
- Claude Code model config: https://code.claude.com/docs/en/model-config
- Issue #30926: https://github.com/anthropics/claude-code/issues/30926
- Related issue #20031: https://github.com/anthropics/claude-code/issues/20031
- Related issue #21676: https://github.com/anthropics/claude-code/issues/21676

## 实施记录

本节记录 V5 改造的落地过程。改造分支 `fix/third-party-provider-backends`，5 个阶段独立 commit，可独立 revert。关联上游 issue [#30926](https://github.com/anthropics/claude-code/issues/30926)。

### 阶段 commit

| 阶段 | Commit | 标题 | 范围 |
|------|--------|------|------|
| 1+2 | `6767652` | 重构: 引入 V5 provider schema 与 backend env 分发 | V5 schema + V4→V5 lazy 迁移 + buildClaudeEnvLines 按 backend 分派（老 anthropic_messages 行为零变化） |
| 3 | `3118742` | feat: 实现 Bedrock/Vertex/Foundry 各 backend 专属 env 生成 | 5 个新 backend env 注入 + cross-field 校验 + 测试增量 |
| 4 | `9f01a5a` | feat: provider 编辑/向导支持 backend 两级选择 | 前端两级 UI（ProviderEditor + SetupProvidersPage） |
| 5 | （本次提交） | feat: pin root SDK + provider 错误诊断 + 文档 | root SDK pin `0.2.126` + `src/provider-diagnostics.ts` + UI 诊断展示 + 文档 |

### V5 schema 字段

`UnifiedProvider`（V5 in-memory）相对 V4 新增：

| 字段 | 类型 | 说明 |
|------|------|------|
| `backend` | `ProviderBackend` | 7 选 1 枚举，决定 `buildClaudeEnvLines` 走哪条分支。V4 → V5 迁移时按 `type` 推断（`official` → `anthropic_official`，`third_party` → `anthropic_messages`） |
| `disableExperimentalBetas` | `boolean?` | 仅当显式 `true` 时注入 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`。V4 → V5 迁移一律 `undefined`，老配置行为零变化 |

磁盘格式 `StoredClaudeProviderConfigV5` 复用 V4 加密（AES-256-GCM、相同 IV 路径），首次读取 V4 时 lazy 迁移并写回 V5。

### SDK 版本策略

- **root `package.json`**：`0.2.126` 精确 pin。仅 `src/sdk-query.ts` 的辅助 sdkQuery 使用，pin 求稳
- **`container/agent-runner/package.json`**：维持 `"*"`，npm latest 自动跟随
- **明确接受漂移**。`make print-sdk-versions` / `make status` 显示双方实际版本，便于排查
- 升级 root SDK 需手动改 `package.json` pin 版本 + `npm install`；升级 agent-runner SDK 走 `make update-sdk`

### Provider 错误诊断

`src/provider-diagnostics.ts` 提供纯函数 `diagnoseProviderError({ errorText, errorCode, backend })`，返回 `ProviderDiagnostic | null`，覆盖 5 种诊断 kind：

- `invalid_beta` / `unsupported_beta`：识别 issue #30926 的 beta header 不兼容，引导用户切换 gateway backend 或勾选「禁用实验 beta」
- `bedrock_auth`：识别 AWS 凭据 / IAM 不足
- `vertex_auth`：识别 GCP ADC 缺失 / 权限不足
- `foundry_auth`：识别 Azure / Foundry API key 失效

集成点：
- `src/agent-output-parser.ts` 的错误退出路径解析 stderr/stdout，将诊断挂到 `ContainerOutput.providerDiagnostic`
- `src/container-runner.ts` 的 `providerPool.reportFailure()` 调用透传诊断
- `src/provider-pool.ts` 在 `ProviderHealthStatus.lastDiagnostic` 缓存，`reportSuccess` 时清除
- `GET /api/config/claude/providers` 自动透出
- `web/src/components/settings/ProviderList.tsx` 在 provider 行内 inline 展示 hint（黄底卡片）

### 关键复用

- 加密：`encryptSecrets`/`decryptSecrets` 沿用 V4 实现，迁移过程不重新加密
- helper：`shouldStripClaudeOAuthArtifacts` / `shouldStripInheritedAnthropicAuthToken` 在阶段 2 抽出，给 `container-runner.ts` 复用
- 测试：`tests/units/provider-migration.test.ts` / `build-claude-env.test.ts` / `provider-diagnostics.test.ts` 是回归网
