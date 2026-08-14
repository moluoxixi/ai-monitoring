# AI Coding Monitor

本仓库不再自研 AI 监控平台。Trace 与错误详情使用成熟开源项目 [Arize Phoenix](https://github.com/Arize-ai/phoenix)，QQ/微信机器人使用 [OpenClaw](https://github.com/openclaw/openclaw) 及腾讯维护的通道插件。本仓库只提供 Windows 快速部署、官方 Arize coding harness 接入，以及可靠通知 outbox 和统一入口。

## 架构

```text
Claude Code
  -> Arize 官方 Claude hooks
  -> Phoenix OTLP -> Phoenix UI :6006
  -> 完成/失败并行 hook -> 通知中心 :8787 -> OpenClaw / Apprise

Codex CLI / Desktop
  -> Arize 官方 notify hook（完成事件）
  -> Phoenix OTLP -> Phoenix UI :6006
  -> notify multiplexer -> 通知中心 :8787

Codex App Server 客户端
  -> 本仓库 stdio 协议代理
  -> turn/item/error 正式终态 -> Phoenix + Apprise relay

Qoder CLI
  -> 官方 Stop / StopFailure / PostToolUseFailure hooks
  -> 通知中心 :8787 -> OpenClaw / Apprise
```

Phoenix 负责 Projects、Sessions、Traces、Spans、模型/工具调用、延迟、Token、错误状态与筛选。OpenClaw 只作为后台 QQ/微信发送网关，不作为本项目用户界面。`8787` 是唯一入口。Vue 3 主界面提供“消息”“扩展”和“设置”三个视图：消息支持搜索、按 AI 扩展和状态筛选；扩展用于查看 Codex、Claude、Qoder 采集能力和绑定全局通知通道；设置用于配置回答摘要的在线模型渠道。点击消息统一打开本机 Phoenix。

通知中心采用标准 npm workspace：`apps/web` 是 Vue 3 + Vite + Element Plus，`apps/server` 是 NestJS。扩展、事件、数据库、通道 provider、投递 worker 和页面组件均为独立模块。Codex、Claude、Qoder 都是内置采集扩展；新 AI 软件需在代码中提供 hook、插件或协议适配器后才会出现在界面中。

## Windows 快速部署

前置条件：Windows 10/11、Node.js 20 或更高版本、Python 3.12 或更高版本、Git，以及可访问 GitHub/npm/PyPI 的网络。Python 仅供 Phoenix 和官方 hook 工具链使用。

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install.ps1
.\scripts\install-tracing.ps1 -ConfigureNotifications
.\scripts\run-phoenix.ps1
.\scripts\run-relay.ps1
```

主界面：[http://127.0.0.1:8787](http://127.0.0.1:8787)。Phoenix 详情：[http://127.0.0.1:6006](http://127.0.0.1:6006)。Phoenix 使用 `data/phoenix` 下的本地 SQLite，单机部署不需要 Docker、PostgreSQL、ClickHouse、Redis 或 MinIO。

安装脚本从 [Arize coding-harness-tracing](https://github.com/Arize-ai/coding-harness-tracing) 的已验证 commit `d8e19a5b967774cdc21db666a895390349734e30` 部署官方 Claude/Codex integration。配置备份保存在 `%LOCALAPPDATA%\AI-Monitor\config-backups`，不进入仓库。默认关闭提示词/回复正文与工具输出内容记录，仅保留工具详情。

首页默认按 Codex、Claude、Qoder 三个扩展分组。消息平台绑定后全局生效：绑定多少个，所有 AI 软件的新事件就向多少个通道分别创建 outbox 投递，其中一个失败不会阻断其它通道。不绑定通道时事件仍保留在本地/Phoenix，但不会产生外发消息。Phoenix 地址由服务级 `AIMONITOR_PHOENIX_URL` 固定配置，默认 `http://127.0.0.1:6006`，不是逐扩展配置项。

`scripts/install.ps1` 会自动安装 workspace 依赖并构建。开发模式使用 `npm run dev`，完整生产构建使用 `npm run build`，类型检查使用 `npm run typecheck`，测试使用 `npm test`。

## QQ 和微信机器人

OpenClaw Gateway 默认运行在 `http://127.0.0.1:18789`。本项目使用两个腾讯维护的插件：

```powershell
openclaw plugins install @tencent-connect/openclaw-qqbot@2.0.1 --pin
openclaw plugins install @tencent-weixin/openclaw-weixin@2.4.6 --pin
```

QQ 可直接在通知中心绑定：

1. 在 `8787` 的扩展页点击 QQ 机器人的“绑定”。
2. 页面弹出二维码后使用手机 QQ 扫码确认。
3. 扫码凭据由腾讯官方 `@tencent-connect/qqbot-connector` 获取并写入 OpenClaw；本项目自己的绑定文件只保存发送所需的不透明 target/account ID，UI 和日志不展示这些值。
4. 绑定完成后立即生效，之后所有 AI 软件的新事件都会发送到 QQ。

微信也可在通知中心点击“绑定”。服务调用腾讯插件官方 `openclaw channels login --channel openclaw-weixin` 流程，并把插件生成的二维码显示在页面中；扫码确认后，需要先在微信中给机器人发送任意一条消息，使腾讯协议签发主动回复所需的 context token。页面验证该 token 已由插件落盘后，才会读取当前账号 ID 和扫码用户 ID 作为通知路由并显示绑定成功。本项目自己的绑定文件不保存微信 token，也不会通过“最近私聊”猜测接收目标。

QQ 通知由 OpenClaw Gateway 的官方 `cron --announce` 路径投递，确保复用已运行的 QQ Bot 连接；微信通知使用标准 `message send --json` 直连接口。正文不经过模型改写，Gateway/插件未确认时不会标记为成功。腾讯微信插件 2.4.6 的 direct-send 入口不会自动恢复已落盘的 context token，`scripts/patch-openclaw-weixin.ps1` 会在安装和启动时校验并应用兼容补丁，防止 CLI 返回消息 ID 但微信未实际展示。OpenClaw 返回失败时，delivery 保持在 SQLite outbox 中指数退避；连续 10 次失败后进入死信，可通过 relay 重试 API 手工重试。

## 通知通道

通知中心内置 QQ、微信和 PushPlus，并通过已安装的 Apprise v1.12.0 支持企业微信机器人、钉钉机器人、飞书机器人、邮件 SMTP、Bark、Gotify、ntfy、通用 JSON Webhook、Telegram 和 Discord。打开 `8787` 的“扩展”视图即可按平台绑定；每个平台由后端 schema 下发所需字段，前端不会拼接或回显凭据。

PushPlus Token 单独保存在 `data/pushplus-binding.json`，其它 Apprise 平台配置保存在 `data/apprise-channels.json`。文件只落在本机并使用受限权限与原子替换写入；通道状态、日志和 API 错误不会返回 Token、密码或完整通知 URL。绑定阶段使用 Apprise `--dry-run` 校验配置格式，不会发送测试消息；需要验证真实可达性时，使用扩展页的“测试通知”。

所有已绑定通道同时生效：新事件会为每个通道创建独立 outbox 投递，一个平台失败不会阻塞其它平台。推荐在中国大陆使用企业微信、钉钉或飞书作为第二出口，并用邮件兜底；Telegram 和 Discord 需要可稳定访问对应服务的网络环境。

`AIMONITOR_APPRISE_URLS` 只作为高级兼容入口，可继续挂载注册表之外的 Apprise URL：

```env
# 企业微信群机器人
AIMONITOR_APPRISE_URLS=wecombot://YOUR_WEBHOOK_KEY

# 多个 URL 用英文逗号分隔
AIMONITOR_APPRISE_URLS=SERVICE_URL_1,SERVICE_URL_2
```

配置后可手工启动通知 relay：

```powershell
.\scripts\run-relay.ps1
```

环境变量通道以只读兼容项运行，不能在页面解绑；新配置应优先使用页面绑定。

## 回答摘要

Codex 完成通知可同时显示任务摘要与回答摘要。打开 `8787` 的“设置”视图，按优先级配置 Groq、OpenRouter、Google Gemini，或一个 OpenAI-compatible 自定义渠道。内置渠道的配置弹窗提供官方 API Key 页面：

- Groq: [https://console.groq.com/keys](https://console.groq.com/keys)
- OpenRouter: [https://openrouter.ai/keys](https://openrouter.ai/keys)
- Google Gemini: [https://aistudio.google.com/apikey](https://aistudio.google.com/apikey)

系统按页面顺序调用已启用渠道。某渠道返回 HTTP 429 后，本次请求立即尝试下一渠道，并将该渠道冷却到服务器本地次日零点；当天后续任务直接跳过它。鉴权、余额、容量、网络、超时和上游错误也会回退，但不会阻塞事件入库。事件先写入 SQLite，回答摘要在后台生成，完成后才释放投递；进程异常时，持久化的延迟投递会在到期后以任务摘要兜底发送。

自定义渠道必须使用解析到公网地址的 HTTPS OpenAI-compatible Base URL；本机、局域网、链路本地地址和 HTTP 明文端点会被拒绝，请求也不跟随重定向。服务监听非本机地址时必须设置 `AIMONITOR_INGEST_TOKEN`，否则不能在页面写入模型凭据。

API Key 存在 `data/answer-summary.json`，使用受限权限和原子替换写入，页面与状态 API 不回显。完整回答只在服务端内存中短暂用于摘要，输入限制为最后 24,000 字符；原文不会写入事件数据库或通知。免费模型和额度会随服务商变化，预填模型可在页面修改，本项目不承诺永久免费或不限量。

若设置 `AIMONITOR_INGEST_TOKEN`，relay 的事件、查询、测试和重试 API 都要求同一个 Bearer token。已安装的 Claude/Codex 生产者会直接读取仓库 `.env`，不需要把 token 写进用户级 Claude/Codex 配置。

Relay 收到事件后先写 SQLite outbox，再由 Apprise 投递；失败会指数退避，连续 10 次失败后进入 `dead` 状态。这个保证从 relay 成功接收事件开始，生产者到 relay 的短暂不可用会记录到 stderr，但当前没有跨进程的入口持久队列。

## 错误检测边界

- **Claude Code**：官方 hook 覆盖 `Stop`、`StopFailure`、`PostToolUseFailure`，可监测任务完成、API/轮次失败和工具失败。
- **Qoder CLI**：官方 hook 覆盖 `Stop`、`StopFailure`、`PostToolUseFailure`。本仓库只接 CLI hooks；`Stop` 代表当前响应结束，不等价于业务目标成功。
- **Codex 完成事件**：官方 Arize `notify` integration 可用于 Codex CLI/Desktop；本仓库 multiplexer 保留已有 notify 命令并并行发送 Phoenix trace 和完成通知。通知中心同时监听 Codex 的结构化 session JSONL，补齐 Desktop 未触发 notify 的完成、中断和带错误的终态；启动回扫只补消息概览，不补发历史通知，实时新增终态才创建投递。
- **Codex 严格错误终态**：只有通过 [Codex App Server 正式协议](https://learn.chatgpt.com/docs/app-server) 的客户端，才能可靠获得 `error`、`turn/completed` 的 `completed/interrupted/failed` 以及 `item/completed`。使用 `.\scripts\run-codex-app-server-proxy.ps1` 作为该客户端的 stdio server command。
- **Codex Desktop 限制**：Desktop 当前没有向第三方公开其内部 App Server 事件订阅，因此无法承诺外部监控能捕获每一次 Desktop API 失败。仅靠 `notify` 或猜测私有日志不能满足“错误必检”。
- **Claude Desktop 限制**：当前接入的是 Claude Code hooks，不是 Claude Desktop；不能把 Claude Code 的配置推断为 Desktop 已接入。

## 服务

| 服务 | 地址 | 作用 |
|---|---|---|
| 通知中心 | `http://127.0.0.1:8787` | 默认入口、任务/消息概览、重试和通道状态 |
| Arize Phoenix | `http://127.0.0.1:6006` | AI trace、span 与错误详情 |
| OpenClaw Gateway | `127.0.0.1:18789` | 后台 QQ/微信机器人网关，不作为用户入口 |

可用 `.\scripts\install-task.ps1` 将 Phoenix 和通知 relay 分别注册为当前用户登录时启动项。脚本优先使用 Task Scheduler；权限不足时自动回退到两个独立的当前用户 Startup 快捷方式，无需管理员权限。使用 `.\scripts\install-task.ps1 -Remove` 可同时移除。

<!-- AIRULES:MOLUOXIXI:START -->
## Moluoxixi 工作流

本项目使用 Moluoxixi 管理 AI 辅助开发流程。在本项目中使用 AI 编程助手时，可以直接发送以下提示词：

```text
请使用 Moluoxixi 开始处理这个需求：<描述需求>
请使用 Moluoxixi 继续当前任务。
请使用 Moluoxixi 检查当前改动。
请使用 Moluoxixi 完成本次工作。
```

AI 编程助手会根据当前宿主选择可用的命令或技能。项目的工作流、任务和规范状态位于 `.moluoxixi/`；无需安装或调用全局 Moluoxixi CLI。
<!-- AIRULES:MOLUOXIXI:END -->
