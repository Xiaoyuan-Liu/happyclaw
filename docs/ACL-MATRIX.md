# ACL 权限矩阵

Issue #518 follow-up。记录所有 Web API / WebSocket / IM 操作的权限级别。

## 权限级别

| 级别 | 函数 / 中间件 | 含义 |
|------|--------------|------|
| Login | `authMiddleware` | 已登录即可 |
| Access | `canAccessGroup(user, group)` | owner 或 `group_members` 成员 |
| Modify | `canModifyGroup(user, group)` | 仅 owner（`created_by`） |
| Delete | `canDeleteGroup(user, group)` | 仅 owner，且非 home group |
| ManageMembers | `canManageGroupMembers(user, group)` | 仅 owner，且非 home group |
| SystemConfig | `systemConfigMiddleware` | `manage_system_config` 权限 |
| ManageUsers | `usersManageMiddleware` | `manage_users` 权限 |
| ManageInvites | `inviteManageMiddleware` | `manage_invites` 权限 |
| ViewAudit | `auditViewMiddleware` | `view_audit_log` 权限 |
| Admin | `user.role === 'admin'` | 仅管理员角色 |
| HostPerm | `hasHostExecutionPermission(user)` | 仅 admin（宿主机操作） |
| Public | 无 | 无需认证 |

> **补充说明**：所有涉及 host 执行模式的群组操作，在基础 ACL 检查之上，还会额外检查 `isHostExecutionGroup(group) && hasHostExecutionPermission(user)`，非 admin 无法操作 host 模式群组。下表中标注 `+HostPerm` 表示此额外检查。

## HTTP 路由

### 认证（`src/routes/auth.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/auth/status` | GET | Public | 返回系统初始化状态 |
| `/api/auth/setup` | POST | Public | 仅用户表为空时可用 |
| `/api/auth/login` | POST | Public | 频率限制 |
| `/api/auth/register` | POST | Public | 受注册开关/邀请码控制 |
| `/api/auth/logout` | POST | Login | |
| `/api/auth/me` | GET | Login | |
| `/api/auth/profile` | PUT | Login | 修改自己的资料 |
| `/api/auth/password` | PUT | Login | 修改自己的密码 |
| `/api/auth/sessions` | GET | Login | 列出自己的会话 |
| `/api/auth/sessions/:id` | DELETE | Login | 撤销自己的会话 |
| `/api/auth/avatar` | POST | Login | 上传头像 |

### 群组（`src/routes/groups.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/groups` | GET | Login | `buildGroupsPayload` 内部过滤，用 `canAccessGroup` |
| `/api/groups` | POST | Login | 创建群组；host 模式需 HostPerm；`init_source_path`/`init_git_url` 需 admin |
| `/api/groups/:jid` | PATCH | Access(仅 pin) / Modify(其他) +HostPerm | pin/unpin 只需 Access；rename/skills/execution_mode 需 Modify |
| `/api/groups/:jid` | DELETE | Delete +HostPerm | home group 不可删 |
| `/api/groups/:jid/stop` | POST | Access | **P2 待改**：需 queue 追踪 query initiator 后收紧为"仅 owner 或发起者" |
| `/api/groups/:jid/interrupt` | POST | Access | **P2 待改**：同上 |
| `/api/groups/:jid/reset-session` | POST | Modify +HostPerm | |
| `/api/groups/:jid/clear-history` | POST | Modify +HostPerm | |
| `/api/groups/:jid/messages` | GET | Access +HostPerm | home 群组合并同 folder 下的 sibling JID |
| `/api/groups/:jid/messages/:messageId` | DELETE | Access | admin 可删任意消息；非 admin 只能删自己的非 AI 消息 |
| `/api/groups/:jid/env` | GET | Access + `manage_group_env` | 非 admin 且无权限则隐藏 `customEnv` |
| `/api/groups/:jid/env` | PUT | Access + `manage_group_env` +HostPerm | |
| `/api/groups/:jid/members` | GET | Access | |
| `/api/groups/:jid/members/search` | GET | ManageMembers | |
| `/api/groups/:jid/members` | POST | ManageMembers | home group 不可添加成员 |
| `/api/groups/:jid/members/:userId` | DELETE | ManageMembers / 自退 | 自己退出不需要 ManageMembers；owner 不可被移除 |
| `/api/groups/:jid/mcp` | GET | Access | |
| `/api/groups/:jid/mcp` | PUT | Access | |

### 消息（`src/web.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/messages` | POST | Access +HostPerm | `/clear` 命令也走此路由，**ACL 与 send_message 对齐（Access），P2 待评估是否应为 Modify** |

### Sub-Agent（`src/routes/agents.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/groups/:jid/agents` | GET | Access | |
| `/api/groups/:jid/agents` | POST | Access | 创建对话 |
| `/api/groups/:jid/agents/:agentId` | PATCH | Access | 重命名 |
| `/api/groups/:jid/agents/:agentId` | DELETE | Access | 有 IM 绑定时拒绝删除 |
| `/api/groups/:jid/im-groups` | GET | Access | 列出可绑定的 IM 群组 |
| `/api/groups/:jid/agents/:agentId/im-binding` | PUT | Access (双向) | 同时检查工作区和 IM 群组的 Access |
| `/api/groups/:jid/agents/:agentId/im-binding/:imJid` | DELETE | Access (双向) | |
| `/api/groups/:jid/im-binding` | PUT | Access (双向) | 绑定 IM 到工作区主对话 |
| `/api/groups/:jid/im-binding/:imJid` | DELETE | Access (双向) | |

### 文件（`src/routes/files.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/groups/:jid/files` | GET | Access +HostPerm | |
| `/api/groups/:jid/files` | POST | Access +HostPerm | 上传 |
| `/api/groups/:jid/files/open-directory` | POST | Access + **HostPerm(硬性)** | 打开本地目录必须 admin |
| `/api/groups/:jid/files/download/:path` | GET | Access +HostPerm | |
| `/api/groups/:jid/files/preview/:path` | GET | Access +HostPerm | |
| `/api/groups/:jid/files/content/:path` | GET | Access +HostPerm | |
| `/api/groups/:jid/files/content/:path` | PUT | Access +HostPerm | |
| `/api/groups/:jid/files/:path` | DELETE | Access +HostPerm | |
| `/api/groups/:jid/directories` | POST | Access +HostPerm | |

### 记忆（`src/routes/memory.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/memory/sources` | GET | Login | 内部按 `created_by` 过滤 folder |
| `/api/memory/search` | GET | Login | 同上 |
| `/api/memory/file` | GET | Login | `resolveMemoryPath` 内部做 userId 校验 |
| `/api/memory/file` | PUT | Login | 同上 + 系统路径写保护 |
| `/api/memory/global` | GET | Login | 读自己的 user-global |
| `/api/memory/global` | PUT | Login | 写自己的 user-global |

### 定时任务（`src/routes/tasks.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/tasks` | GET | Login | 内部按 `canAccessGroup` 过滤 |
| `/api/tasks` | POST | Access | 创建任务 |
| `/api/tasks/:id` | PATCH | Access | 更新任务 |
| `/api/tasks/:id` | DELETE | Access | 删除任务 |
| `/api/tasks/:id/run` | POST | Access | 手动触发 |
| `/api/tasks/:id/logs` | GET | Access | 查看执行日志 |
| `/api/tasks/ai` | POST | Access | AI 辅助创建 |
| `/api/tasks/parse` | POST | Login | 解析自然语言 |

### 配置（`src/routes/config.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/config/claude` | GET | SystemConfig | |
| `/api/config/claude/providers` | GET | SystemConfig | |
| `/api/config/claude/providers` | POST | SystemConfig | |
| `/api/config/claude/providers/:id` | PATCH | SystemConfig | |
| `/api/config/claude/providers/:id/secrets` | PUT | SystemConfig | |
| `/api/config/claude/providers/:id` | DELETE | SystemConfig | |
| `/api/config/claude/providers/:id/toggle` | POST | SystemConfig | |
| `/api/config/claude/providers/:id/reset-health` | POST | SystemConfig | |
| `/api/config/claude/providers/health` | GET | SystemConfig | |
| `/api/config/claude/providers/:id/usage` | GET | SystemConfig | |
| `/api/config/claude/balancing` | PUT | SystemConfig | |
| `/api/config/claude/apply` | POST | SystemConfig | |
| `/api/config/claude/oauth/start` | POST | SystemConfig | |
| `/api/config/claude/oauth/callback` | POST | SystemConfig | |
| `/api/config/claude/custom-env` | PUT | SystemConfig | |
| `/api/config/feishu` | GET/PUT | SystemConfig | deprecated，改用 user-im |
| `/api/config/telegram` | GET/PUT | SystemConfig | deprecated，改用 user-im |
| `/api/config/telegram/test` | POST | SystemConfig | |
| `/api/config/registration` | GET/PUT | SystemConfig | |
| `/api/config/appearance` | GET/PUT | SystemConfig | |
| `/api/config/appearance/public` | GET | **Public** | 仅返回 appName/aiName/emoji/color |
| `/api/config/system` | GET/PUT | SystemConfig | |
| `/api/config/external-resources` | GET | SystemConfig + Admin 角色检查 | 非 admin 返回空数据 |
| `/api/config/external-resources/rule` | GET | SystemConfig + Admin 角色检查 | |
| `/api/config/user-im/status` | GET | Login | 返回自己的 IM 连接状态 |
| `/api/config/user-im/feishu` | GET/PUT | Login | 操作自己的配置 |
| `/api/config/user-im/telegram` | GET/PUT | Login | |
| `/api/config/user-im/telegram/test` | POST | Login | |
| `/api/config/user-im/telegram/pairing-code` | POST | Login | |
| `/api/config/user-im/telegram/paired-chats` | GET | Login | 按 `created_by` 过滤 |
| `/api/config/user-im/telegram/paired-chats/:jid` | DELETE | Login + owner 检查 | `created_by === user.id` |
| `/api/config/user-im/qq` | GET/PUT | Login | |
| `/api/config/user-im/qq/test` | POST | Login | |
| `/api/config/user-im/qq/pairing-code` | POST | Login | |
| `/api/config/user-im/qq/paired-chats` | GET | Login | 按 `created_by` 过滤 |
| `/api/config/user-im/qq/paired-chats/:jid` | PUT/DELETE | Login + owner 检查 | |
| `/api/config/user-im/dingtalk` | GET/PUT | Login | |
| `/api/config/user-im/dingtalk/test` | POST | Login | |
| `/api/config/user-im/discord` | GET/PUT | Login | |
| `/api/config/user-im/discord/test` | POST | Login | |
| `/api/config/user-im/wechat` | GET/PUT | Login | |
| `/api/config/user-im/wechat/qrcode` | POST | Login | |
| `/api/config/user-im/wechat/qrcode-status` | GET | Login | |
| `/api/config/user-im/wechat/disconnect` | POST | Login | |
| `/api/config/user-im/whatsapp` | GET/PUT | Login | |
| `/api/config/user-im/whatsapp/logout` | POST | Login | |
| `/api/config/user-im/bindings/:imJid` | PUT | Access | 操作 IM 绑定 |
| `/api/config/user-im/bindings/:imJid/reset-allowlist` | POST | Access + owner 检查 | `created_by === user.id` |

### 管理（`src/routes/admin.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/admin/users` | GET | ManageUsers | |
| `/api/admin/users` | POST | ManageUsers | 非 admin 不可创建 admin 用户 |
| `/api/admin/users/:id` | PATCH | ManageUsers | 非 admin 不可管理 admin 用户 |
| `/api/admin/users/:id` | DELETE | ManageUsers | 不可删自己；不可删最后一个 admin |
| `/api/admin/users/:id/restore` | POST | ManageUsers | |
| `/api/admin/users/:id/sessions` | DELETE | ManageUsers | |
| `/api/admin/permission-templates` | GET | Login + (`manage_users` \| `manage_invites`) | |
| `/api/admin/invites` | GET | ManageInvites | |
| `/api/admin/invites` | POST | ManageInvites | |
| `/api/admin/invites/:code` | DELETE | ManageInvites | |
| `/api/admin/audit-log` | GET | ViewAudit | |
| `/api/admin/audit-log/export` | GET | ViewAudit | |

### 监控（`src/routes/monitor.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/health` | GET | **Public** | 健康检查 |
| `/api/status` | GET | Login | 非 admin 只能看自己 `canAccessGroup` 的群组 |
| `/api/docker/build` | POST | SystemConfig | 构建 Docker 镜像 |
| `/api/docker/status` | GET | SystemConfig | |

### Skills（`src/routes/skills.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/skills` | GET | Login | |
| `/api/skills/search` | GET | Login | |
| `/api/skills/search/detail` | GET | Login | |
| `/api/skills/:id` | GET | Login | |
| `/api/skills/:id` | PATCH | Login | |
| `/api/skills/user-all` | DELETE | Login | |
| `/api/skills/:id` | DELETE | Login | |
| `/api/skills/install` | POST | Login | |
| `/api/skills/:id/reinstall` | POST | Login | |

### MCP Servers（`src/routes/mcp-servers.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/mcp-servers` | GET | Login | per-user 数据 |
| `/api/mcp-servers` | POST | Login | |
| `/api/mcp-servers/:id` | PATCH | Login | |
| `/api/mcp-servers/:id` | DELETE | Login | |
| `/api/mcp-servers/sync-host` | POST | Login | |

### Plugins（`src/routes/plugins.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/plugins` | GET | Login | admin 可见额外信息 |
| `/api/plugins/enabled/:pluginFullId` | PATCH | Login | |
| `/api/plugins/materialize` | POST | Login | |
| `/api/plugins/marketplaces/:name` | DELETE | Login | 仅删自己的 enabled refs |
| `/api/plugins/commands` | GET | Login | |
| `/api/plugins/catalog` | GET | Login | admin 可见额外信息 |
| `/api/plugins/catalog/marketplaces/:mp` | GET | Login | admin 可见额外信息 |
| `/api/plugins/catalog/scan` | POST | **Admin 角色检查** | `role !== 'admin'` → 403 |

### 用量统计（`src/routes/usage.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/usage/*` | ALL | Login | 全局 `authMiddleware` |

### 目录浏览（`src/routes/browse.ts`）

| 路由 | 方法 | ACL | 备注 |
|------|------|-----|------|
| `/api/browse/directories` | GET/POST | Login | 受 mount-allowlist 白名单约束 |

## WebSocket 操作

WebSocket 连接建立时从 Cookie 解析会话，验证通过后缓存 `session.user_id` 和 `session.role`。

| 操作 | ACL | 备注 |
|------|-----|------|
| `send_message` | Access +HostPerm | 对目标群组做 `canAccessGroup` |
| `send_message` + `/clear` | **Access** +HostPerm | **与 send_message 对齐；P2 待评估是否应收紧为 Modify** |
| `send_message` + `/sw` | Access +HostPerm | spawn 并行任务，复用 send_message ACL |
| `terminal_start` | Access | `canAccessGroup`；host 模式直接拒绝（不支持终端） |
| `terminal_input` | 无额外检查 | 依赖 `terminal_start` 时的 ACL |
| `terminal_resize` | 无额外检查 | 同上 |
| `terminal_stop` | 无额外检查 | 同上 |

## IM 斜杠命令

IM 命令通过 `handleCommand()` 在主进程 `src/index.ts` 中处理，**不经过 Web 认证中间件**。

| 命令 | ACL | 备注 |
|------|-----|------|
| `/clear` | **无** | 任何能发消息到该 IM 群组的人都可执行 |
| `/list`、`/ls` | **无** | |
| `/status` | **无** | |
| `/recall`、`/rc` | **无** | |
| `/where` | **无** | |
| `/bind` | **无** | |
| `/unbind` | **无** | |
| `/new` | **无** | |
| `/sw`、`/spawn` | **无** | |
| `/require_mention` | **无** | 接受 `senderImId` 参数但不做权限校验 |
| `/owner_mention` | **无** | |
| `/allow` | **无** | |
| `/disallow` | **无** | |
| `/allowlist` | **无** | |

## 已知不一致

### 本次 PR 修复的

- **系统消息渲染**：`__system__` 消息的 if-else 链改为 registry + fallback，修复 `context_reset:` 前缀消息被静默丢弃的 bug；`context_overflow:` 消息路由到 `MessageBubble` 的红色卡片 UI（之前是 dead code）。

### 待后续 P2 修复的

- **`POST /api/groups/:jid/stop` 和 `interrupt`**：当前为 `canAccessGroup`，共享成员可停止/中断 owner 的容器。直接收紧为 `canModifyGroup` 会导致成员无法中断自己发起的查询（UX 回归）。正确方案：在 queue 层追踪 query initiator，实现"仅 owner 或发起者可操作"的资源级检查（参考删除消息路由的 `canAccessGroup` + sender 检查模式）。

- **IM 斜杠命令无 ACL**：所有 IM 命令（`/clear`、`/bind`、`/unbind`、`/require_mention` 等）不经过任何权限校验，任何能向该 IM 群组发消息的人都可执行。尤其 `/clear` 可以重置会话上下文，`/bind`、`/unbind` 可以修改 IM 绑定。
- **Web `/clear` 命令 ACL 降级**：通过 `POST /api/messages` 和 WebSocket `send_message` 发送的 `/clear` 使用 `canAccessGroup`（Access），而 HTTP 路由 `POST /api/groups/:jid/reset-session` 使用 `canModifyGroup`（Modify）。共享成员可以通过 `/clear` 绕过 reset-session 的 owner-only 限制。
- **Sub-Agent CRUD 宽松**：agents 路由的 create/rename/delete 均为 `canAccessGroup`，共享成员可以创建和删除 owner 工作区中的对话。是否需要收紧为 Modify 待讨论。
- **MCP 配置写入宽松**：`PUT /api/groups/:jid/mcp` 使用 `canAccessGroup`，共享成员可以修改工作区的 MCP 配置。应为 Modify。
