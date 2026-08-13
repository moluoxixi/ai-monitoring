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

Phoenix 负责 Projects、Sessions、Traces、Spans、模型/工具调用、延迟、Token、错误状态与筛选。OpenClaw 只作为后台 QQ/微信发送网关，不作为本项目用户界面。`8787` 是唯一入口。Vue 3 主界面提供“消息概览”和“平台配置”两个视图：消息概览支持搜索、按 AI 软件和状态筛选；平台配置为每个软件保存一个通知通道。点击消息统一打开本机 Phoenix。

通知中心采用标准 npm workspace：`apps/web` 是 Vue 3 + Vite + Element Plus，`apps/server` 是 NestJS。平台、事件、数据库、通道 provider、投递 worker 和页面组件均为独立模块。内置 Codex、Claude、Qoder 的采集适配器，也可从页面注册其它 AI 软件及其事件别名。

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

首页默认按 Codex、Claude、Qoder 三个平台分组，也可注册其它 AI 软件。每个平台只能配置一个消息通道；不配置通道时事件仍保留在本地/Phoenix，但不会产生外发消息。Phoenix 地址由服务级 `AIMONITOR_PHOENIX_URL` 固定配置，默认 `http://127.0.0.1:6006`，不是逐平台配置项。

注册自定义 AI 软件只会建立消息分类和通用 `POST /api/events` 事件契约，不等于已经完成原生监控。要自动捕获该软件的完成和错误事件，仍需为它编写 hook、插件或协议适配器，并明确验证该软件实际开放的事件能力。

`scripts/install.ps1` 会自动安装 workspace 依赖并构建。开发模式使用 `npm run dev`，完整生产构建使用 `npm run build`，类型检查使用 `npm run typecheck`，测试使用 `npm test`。

## QQ 和微信机器人

OpenClaw Gateway 默认运行在 `http://127.0.0.1:18789`。本项目使用两个腾讯维护的插件：

```powershell
openclaw plugins install @tencent-connect/openclaw-qqbot@2.0.1 --pin
openclaw plugins install @tencent-weixin/openclaw-weixin@2.4.6 --pin
```

QQ 可直接在通知中心绑定：

1. 在 `8787` 的平台配置页点击 QQ 机器人的“绑定”。
2. 页面弹出二维码后使用手机 QQ 扫码确认。
3. 扫码凭据由腾讯官方 `@tencent-connect/qqbot-connector` 获取并写入 OpenClaw；本项目自己的绑定文件只保存发送所需的不透明 target/account ID，UI 和日志不展示这些值。
4. 绑定完成后，为所需 AI 软件选择“QQ 机器人”并保存。

当前安装的 OpenClaw 微信插件没有公开可路由的二维码登录方法，因此本页面会明确提示外部登录，不会再通过“最近私聊”猜测绑定关系。微信需执行 `openclaw channels login --channel openclaw-weixin` 完成插件官方登录；在插件提供可验证的绑定目标接口前，本项目不会把最近会话伪装为已绑定。

通知由 OpenClaw command cron 确定性投递，正文不经过模型改写。OpenClaw 返回失败时，delivery 保持在 SQLite outbox 中指数退避；连续 10 次失败后进入死信，可通过 relay 重试 API 手工重试。

## 其它通知通道

在 `.env` 中设置 Apprise URL：

```env
# 企业微信群机器人
AIMONITOR_APPRISE_URLS=wecombot://YOUR_WEBHOOK_KEY

# PushPlus 微信消息
AIMONITOR_APPRISE_URLS=pushplus://YOUR_TOKEN
```

配置后可手工启动通知 relay：

```powershell
.\scripts\run-relay.ps1
```

可配置多个 URL，以英文逗号分隔。PushPlus、企业微信群机器人以及 Apprise 的其它成熟通道可作为 OpenClaw 机器人之外的并行或备用出口。

若设置 `AIMONITOR_INGEST_TOKEN`，relay 的事件、查询、测试和重试 API 都要求同一个 Bearer token。已安装的 Claude/Codex 生产者会直接读取仓库 `.env`，不需要把 token 写进用户级 Claude/Codex 配置。

Relay 收到事件后先写 SQLite outbox，再由 Apprise 投递；失败会指数退避，连续 10 次失败后进入 `dead` 状态。这个保证从 relay 成功接收事件开始，生产者到 relay 的短暂不可用会记录到 stderr，但当前没有跨进程的入口持久队列。

## 错误检测边界

- **Claude Code**：官方 hook 覆盖 `Stop`、`StopFailure`、`PostToolUseFailure`，可监测任务完成、API/轮次失败和工具失败。
- **Qoder CLI**：官方 hook 覆盖 `Stop`、`StopFailure`、`PostToolUseFailure`。本仓库只接 CLI hooks；`Stop` 代表当前响应结束，不等价于业务目标成功。
- **Codex 完成事件**：官方 Arize `notify` integration 可用于 Codex CLI/Desktop；本仓库 multiplexer 保留已有 notify 命令并并行发送 Phoenix trace 和完成通知。
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
