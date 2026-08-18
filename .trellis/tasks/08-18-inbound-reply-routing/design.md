# QQ inbound reply routing - Design

## Boundaries

回复链路与现有事件采集保持分离：事件仍由 `POST /api/events` 进入 outbox；新的 `POST /api/replies/inbound` 只接收 OpenClaw QQ 插件归一化后的引用消息。MVP 不提供通用聊天 webhook，也不让普通 QQ 消息进入 Monitor。

仅 `openclaw-qq` 且事件 `client=codex-cli`、`metadata.thread_id` 非空的 delivery 可创建路由令牌。投递 worker 在发送前取得同一 delivery 的稳定令牌，并在 QQ 正文开头追加任务 ID 与路由标记：

```text
[任务ID:<delivery event id>]

[AI-MONITOR-REPLY:<base64url token>]
```

其他渠道和不可续接事件保持现有正文不变。

## Persistence

`deliveries` 增加 nullable unique `reply_token` 和 `reply_expires_at`。令牌由加密安全随机字节生成，`ensureDeliveryReplyRoute(deliveryId)` 在 transaction 中只写一次，投递重试复用同一值。默认有效期 30 天，可通过配置调整。

新增 `inbound_replies`：

```text
id, channel, external_message_id, delivery_id, sender_id, account_id,
text, state, last_error, created_at, accepted_at
UNIQUE(channel, external_message_id)
```

插入 `processing` 行是调用 Codex 前的幂等门。成功转为 `accepted`；确定性失败转为 `failed`。重复 external id 返回已有状态，不重复 dispatch。

路由查询联结 delivery/event，投影 `client`、事件 metadata、channel 和 reply expiry。QQ 身份验证使用原通知当前绑定记录：target 必须精确为 `qqbot:c2c:<senderId>`，account id 必须一致。只允许私聊引用回复。

## OpenClaw Plugin

项目内置一个无第三方运行时依赖的 native plugin，注册 `api.on("before_dispatch", ...)`。OpenClaw 2026.7.1-2 只会对 plugin-owned conversation binding 调用 `inbound_claim`，普通 QQ 会话不会执行该 hook；`before_dispatch` 则在普通消息的默认 agent 路由前全局执行，并允许用 `{ handled: true, text }` 直接回复和短路。

插件 manifest 必须声明 `activation.onCapabilities: ["hook"]`。`plugins inspect --runtime` 会显式导入指定插件，因此只能验证注册代码；Gateway 启动计划不会仅凭 `plugins.entries.<id>.enabled=true` 选择 hook-only 插件。安装校验必须同时验证运行时 hook 注册和 manifest 的 Gateway startup capability。

handler 只处理：

- `event.channel === "qqbot"`
- `event.isGroup === false`
- `event.replyToBody` 含且仅含一个有效格式的 AI Monitor 路由令牌

腾讯 QQ 插件 2.0.1 会把引用正文传入 `replyToBody`，但不会设置 `replyToIsQuote`；其 `replyToId` 是当前入站 QQ message id，可用于幂等键。handler 将 `content` 中不含引用正文的用户文本、sender/account/message id 和结构化引用正文 POST 到 Monitor。成功或确定性失败均返回 `{ handled: true, text }`，从而阻止 OpenClaw 自身 agent 同时消费；无关消息返回 `undefined`。

安装脚本把当前 reply token、Monitor URL 和超时持久化到 `plugins.entries.ai-monitor-replies.config`；handler 优先读取 OpenClaw 注入的 `api.pluginConfig`，再回退到 `AIMONITOR_REPLY_TOKEN` / `AIMONITOR_INGEST_TOKEN` 环境变量，避免独立重启 Gateway 与 Monitor 后沿用旧进程环境。Docker 使用服务内地址 `http://monitor:8787/api/replies/inbound`；桌面默认 loopback 地址。安装脚本像 QQ/微信插件一样检查并安装项目内插件，插件或鉴权配置变化后必须重启 Gateway。

## Authentication

controller 自行校验 bearer token，不依赖全局 guard 的“ingest token 为空即放行”行为。有效密钥为 `AIMONITOR_REPLY_TOKEN || AIMONITOR_INGEST_TOKEN`；空值直接返回未授权。比较使用常量时间比较。

payload 通过 DTO 严格限制为 QQ、private quote、4,000 字符文本和有界标识符。服务端不信任插件的 route target，始终从 quoted body 重新提取 token 并查库。

## Platform Dispatch

`PlatformReplyDispatcher` 依据 route client 选择 adapter。MVP 只有 `codex-cli`，其他 client 明确拒绝。

Codex adapter 每个 accepted reply 启动一个 `codex app-server` 子进程，以 JSONL JSON-RPC 执行：

```text
initialize -> initialized -> thread/resume -> turn/start
```

每个 request 有独立 id 和超时；stderr 只保留有界、脱敏诊断。`turn/start` result 到达后 endpoint 返回 accepted，进程在后台等待匹配 thread/turn 的终态后退出；异常、超时和提前退出都清理子进程。`approvalPolicy: never` 放入 `turn/start`。

## Compatibility And Recovery

数据库迁移只做 additive `ALTER TABLE`/`CREATE TABLE IF NOT EXISTS`。旧 delivery 没有 reply token，只有后续发送或重试的可回复 QQ delivery 才生成。插件缺失时现有出站通知仍可发送，但 QQ 回复不会被认领。

已经写入 `processing` 后进程崩溃的记录不会自动重放，避免未知 Codex 接受状态导致重复 turn；记录保留错误供人工诊断。MVP 不承诺 exactly-once 的跨进程恢复，只保证同一运行期和已落库 external id 不会主动二次 dispatch。
