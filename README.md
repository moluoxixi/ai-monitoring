# AI Coding Monitor

本仓库提供本地 AI 任务消息监控中心：保存任务提问、回答、失败原因和通知投递状态，并通过 [OpenClaw](https://github.com/openclaw/openclaw) 及腾讯维护的通道插件发送 QQ/微信消息。本仓库提供 Windows 源码快速部署、Windows/macOS 桌面安装包、官方 hooks/notify 接入、可靠通知 outbox 和统一入口。

## 架构

```text
Claude CLI
  -> 官方 Claude hooks
  -> 通知中心 :8787 -> OpenClaw / Apprise

Claude Desktop
  -> Desktop audit watcher
  -> 通知中心 :8787 -> OpenClaw / Apprise

Codex CLI
  -> notify multiplexer / App Server proxy
  -> 通知中心 :8787

Codex Desktop
  -> Codex session watcher
  -> 通知中心 :8787

Codex App Server 客户端
  -> 本仓库 stdio 协议代理
  -> turn/item/error 正式终态 -> 通知中心 :8787

Qoder CLI
  -> 官方 Stop / PostToolUseFailure hooks
  -> 通知中心 :8787 -> OpenClaw / Apprise

Qoder Desktop
  -> 官方 Stop / PostToolUseFailure hooks + Windows 运行端识别
  -> 通知中心 :8787 -> OpenClaw / Apprise

Qoder Quest
  -> Qoder Desktop Quest session 的官方 Stop / PostToolUseFailure hooks
  -> 通知中心 :8787 -> OpenClaw / Apprise

Hermes CLI
  -> 官方 on_session_end / api_request_error shell hooks
  -> 通知中心 :8787

Hermes Desktop
  -> 官方 on_session_end / api_request_error shell hooks
  -> 通知中心 :8787

Cursor CLI
  -> 官方 stop / postToolUseFailure hooks
  -> 通知中心 :8787

Cursor Desktop
  -> 官方 stop / postToolUseFailure hooks
  -> 通知中心 :8787
```

通知中心负责任务详情、失败原因、消息概览、重试和通道状态。OpenClaw 只作为后台 QQ/微信发送网关，不作为本项目用户界面。`8787` 是唯一入口。Vue 3 主界面提供“消息”“扩展”两个视图：消息支持搜索、按独立的 CLI/Desktop/Quest 平台和状态筛选；扩展页会分别展示 Codex、Claude、Qoder（含 CLI、Desktop、Quest）、Hermes、Cursor 的独立条目，可切换“已检测/已展示”、重新扫描、选择显示平台并配置通知长度。点击消息直接打开本地任务详情。

通知中心采用标准 npm workspace：`apps/web` 是 Vue 3 + Vite + Element Plus，`apps/server` 是 NestJS。扩展、事件、数据库、通道 provider、投递 worker 和页面组件均为独立模块。Codex、Claude、Qoder、Hermes、Cursor 都有独立适配器；只有本项目命令实际写入官方 hook 且通过真实事件验收后，平台才会报告“已验证可用”。新 AI 软件需在代码中提供 hook、插件或协议适配器后才会产生事件。

## Windows 快速部署

前置条件：Windows 10/11、Node.js 20 或更高版本、Python 3.12 或更高版本，以及可访问 npm/PyPI 的网络。Python 用于官方 hook、notify 和 App Server 适配器。

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install.ps1 -ConfigureHooks
.\scripts\run.ps1
.\scripts\run-relay.ps1
```

主界面：[http://127.0.0.1:8787](http://127.0.0.1:8787)。任务详情和通知记录使用 `data/monitor.db` 下的本地 SQLite，单机部署不需要 Docker、PostgreSQL、ClickHouse、Redis 或 MinIO。

安装脚本直接注册本仓库的 Claude、Codex、Qoder、Hermes 和 Cursor hooks/notify 适配器。配置备份保存在 `%LOCALAPPDATA%\AI-Monitor\config-backups`，不进入仓库。默认关闭提示词/回复正文与工具输出内容记录，仅保留工具详情。Hermes 首次运行还需要用 `hermes --accept-hooks` 启动一次实际任务，或在交互终端确认本项目 hook；未获 Hermes 安全同意前不会报告已配置。

扩展页首次启动会按当前环境的进程、PATH 命令和 canonical 配置目录做隔离扫描；Windows 主机显示检测结果，容器或不支持的平台扫描会回退到全部支持目录。用户可在扩展设置中保存要展示的平台集合，这只影响界面，不会停止事件采集、数据库归类或通知投递。消息平台绑定后全局生效：绑定多少个，所有 AI 软件的新事件就向多少个通道分别创建 outbox 投递，其中一个失败不会阻断其它通道。不绑定通道时事件仍保留在本地，但不会产生外发消息。

`scripts/install.ps1` 会自动安装 workspace 依赖并构建。开发模式使用 `npm run dev`，完整生产构建使用 `npm run build`，类型检查使用 `npm run typecheck`，测试使用 `npm test`。

## 桌面 App（Tauri）

仓库同时提供可选的 Tauri 2 桌面壳，适合希望登录后自动启动通知中心、使用独立窗口并避免手工管理 `8787` 服务的用户。桌面端不重写 Nest 监控逻辑，而是启动同一个 Node sidecar；因此 Codex、Claude、Qoder、Hermes、Cursor 的监听和 QQ/微信通道保持一致。

前置条件：Node.js 24.15+（或 22.22.3+）、Rust。Windows 还需要 Visual Studio Build Tools + Windows SDK 和 WebView2；macOS 需要 Xcode Command Line Tools。先运行 `npm run desktop:check` 检查环境；Windows 缺少 MSVC 时运行 `npm run desktop:install-windows-runtime`（管理员 PowerShell），macOS 缺少 Apple 工具链时运行 `npm run desktop:install-macos-runtime` 并完成系统安装提示。开发运行：

```powershell
npm run desktop:dev
```

构建安装包：

```powershell
npm run desktop:build
```

桌面包默认内置固定版本的 OpenClaw、QQ 插件和微信插件，用户无需另装 Node.js 或 OpenClaw；首次使用仍需在界面扫码登录，凭据不会写进安装包。Windows 和 macOS 必须分别在目标系统构建，因为安装包会嵌入当前系统的 Node runtime 与 `better-sqlite3` 原生模块；macOS 还需按 Intel/Apple Silicon 分别构建，除非另行配置 universal pipeline。

仓库提供 `desktop-build` GitHub Actions（手动触发或推送 `v*` 标签）分别构建 Windows x64、macOS Intel 和 macOS Apple Silicon 安装包；手动构建产物位于 Actions artifacts，`v*` 标签构建还会把 MSI/EXE/DMG 汇总到对应 GitHub Release。当前未配置 Windows 代码签名或 macOS 签名/公证，公开分发前应接入平台证书。

Tauri 会优先复用 `127.0.0.1:8787` 上健康的通知中心；没有服务时启动 Node sidecar，并等待 `/api/health` 后再打开本地页面。这样已安装的 AI hooks 不需要改成随机端口。桌面构建默认把固定版本的 OpenClaw、QQ 插件和微信插件一起打进安装包，首次启动自动把插件准备到用户数据目录并启动 `127.0.0.1:18789` Gateway；已有 Gateway 会复用，不重复启动。首次构建/首次启动需要访问 npm 下载或校验插件，QQ/微信扫码登录仍需用户在页面中完成。SQLite、用户设置、绑定、OpenClaw 登录状态和通知 outbox 使用系统用户数据目录，不会写入安装包。可通过 `AIMONITOR_OPENCLAW_CLI_PATH` 使用外部 CLI，或设置 `AIMONITOR_DESKTOP_SKIP_OPENCLAW_INSTALL=1` 构建不含 OpenClaw 的精简包。

## Docker 快速部署

Docker 方案包含通知中心、Apprise、OpenClaw Gateway 和已固定版本的 QQ/微信插件。数据库、绑定信息和本地配置统一保存在宿主机 `data` 目录，OpenClaw 运行状态保存在 Compose 具名卷中。容器启动时会校验卷中的插件，只有插件缺失、损坏或版本漂移时才从 npm 恢复固定版本。

前置条件是 Docker Desktop、Linux containers 和 Docker Compose v2：

```powershell
.\scripts\docker-start.ps1
```

脚本会创建或补全 `.env`，生成本地 API/Gateway token，挂载当前用户的 Codex session 目录，构建镜像并等待两个服务健康。启动后访问 [http://127.0.0.1:8787](http://127.0.0.1:8787)。AI 客户端仍运行在宿主机，因此首次部署后在宿主机执行一次：

```powershell
.\scripts\install-hooks.ps1 -ConfigureNotifications
```

若项目 `.venv` 不存在，该脚本会自动创建仅供 hooks 使用的 Python 3.12+ 环境并安装最小依赖，不会在宿主机重复构建 Vue/Nest 服务。

停止容器但保留数据库和机器人登录状态：

```powershell
.\scripts\docker-stop.ps1
```

`data` 下全部内容都是本机运行数据或凭据，默认不提交到 Git。`codex-notify-targets.json` 会由 hooks 安装脚本按需生成，不需要仓库模板。

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

QQ 通知由 OpenClaw Gateway 的官方 `cron --announce` 路径投递，确保复用已运行的 QQ Bot 连接；微信通知使用标准 `message send --json` 直连接口。正文不经过模型改写，Gateway/插件未确认时不会标记为成功。腾讯微信插件 2.4.6 的 direct-send 入口不会自动恢复已落盘的 context token，Docker 启动入口会校验固定插件版本并应用跨平台兼容补丁，防止 CLI 返回消息 ID 但微信未实际展示。OpenClaw 返回失败时，delivery 保持在 SQLite outbox 中指数退避；连续 10 次失败后进入死信，可通过 relay 重试 API 手工重试。

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

## 任务结果与长度限制

通知正文直接使用采集到的最终回答，不调用在线模型改写或摘要。完成通知包含“提问”和“任务结果”，失败通知包含“提问”和“失败消息”。扩展设置可在线配置外发正文上限：提问范围为 1-2,000 字，任务结果或失败消息范围为 1-24,000 字，默认仍为 100/2,000；超出部分以省略号截断，并保留换行和 Markdown。上游适配器会保留不低于上述范围的安全上限，避免配置较大值时数据已在采集阶段丢失。回答会先经过敏感信息清洗，最多保存末尾 24,000 字到本地 SQLite，仅在单条任务详情中查看，不出现在消息列表、投递列表或日志中。

若设置 `AIMONITOR_INGEST_TOKEN`，relay 的事件、查询、测试和重试 API 都要求同一个 Bearer token。已安装的 Claude/Codex 生产者会直接读取仓库 `.env`，不需要把 token 写进用户级 Claude/Codex 配置。

Relay 收到事件后先写 SQLite outbox，再由 Apprise 投递；失败会指数退避，连续 10 次失败后进入 `dead` 状态。这个保证从 relay 成功接收事件开始，生产者到 relay 的短暂不可用会记录到 stderr，但当前没有跨进程的入口持久队列。

## 错误检测边界

- **Claude CLI**：官方 hook 覆盖 `Stop`、`StopFailure`、`PostToolUseFailure`，可监测任务完成、API/轮次失败和工具失败。
- **Claude Desktop**：独立读取 Desktop 的 `audit.jsonl`，不把 Desktop 事件归入 Claude CLI。
- **Qoder CLI**：官方 hook 覆盖完成终态 `Stop` 和工具失败 `PostToolUseFailure`；当前版本未公开任务失败终态 hook，不能把工具失败等同于整轮失败。
- **Qoder Desktop**：独立平台条目；适配器优先使用官方 payload/环境中的运行端，缺失时在 Windows 沿进程祖先识别 `Qoder.exe`，不会静默归入 CLI。
- **Qoder Quest**：独立平台条目；通过 Quest session id 的 `.session.execution` 后缀归类，复用 Qoder 官方 hook。当前已实测完成事件；官方失败终态 schema 尚未公开，因此失败能力不宣称已验证。
- **QoderWork**：已检测到独立应用，但 GUI 当前没有稳定、公开且可由本项目订阅的完成/失败 hook；保持“已安装，未接入”，不会从日志猜测任务结果。
- **Hermes CLI**：官方 shell hook 覆盖 `on_session_end` 和 `api_request_error`；首次 hook consent 未完成时不会运行。
- **Hermes Desktop**：Desktop 的 `tui_gateway` 不加载 CLI shell hooks，因此服务只读监听官方 `state.db` 的终态回答和新生成的 `request_dump` 失败记录；不会读取请求 headers/body、thinking 或工具内容，验证状态和事件计数不与 CLI 合并。
- **Cursor CLI**：官方 `stop` 可监测响应完成，`postToolUseFailure` 只代表工具失败，不等价于整个任务/API 失败。
- **Cursor Desktop**：独立平台条目；同样只报告官方能证明的“完成 + 工具失败”能力，不伪造完整错误覆盖。
- **Codex CLI**：notify multiplexer 与 App Server proxy 归入 Codex CLI，负责 CLI 的完成和严格协议错误。
- **Codex Desktop**：结构化 session JSONL watcher 独立归入 Codex Desktop，补齐 Desktop 的完成、中断和带错误终态；Desktop 没有公开内部 App Server 事件订阅，不能承诺捕获每一次 API 失败。
- **Codex 严格错误终态**：只有通过 [Codex App Server 正式协议](https://learn.chatgpt.com/docs/app-server) 的客户端，才能可靠获得 `error`、`turn/completed` 的 `completed/interrupted/failed` 以及 `item/completed`。使用 `.\scripts\run-codex-app-server-proxy.ps1` 作为该客户端的 stdio server command。
- **Codex Desktop 限制**：Desktop 当前没有向第三方公开其内部 App Server 事件订阅，因此无法承诺外部监控能捕获每一次 Desktop API 失败。仅靠 `notify` 或猜测私有日志不能满足“错误必检”。
- **Claude Desktop**：新版 Desktop 生成的 `audit.jsonl` 由本地 watcher 读取，只接受真正的 `audit.jsonl` 终态并忽略工具回写；Claude Code hooks 与 Desktop audit 的验证来源在界面中分开记录。

## 服务

| 服务 | 地址 | 作用 |
|---|---|---|
| 通知中心 | `http://127.0.0.1:8787` | 默认入口、任务/消息概览、重试和通道状态 |
| OpenClaw Gateway | `127.0.0.1:18789` | 后台 QQ/微信机器人网关，不作为用户入口 |

可用 `.\scripts\install-task.ps1` 将通知 relay 注册为当前用户登录时启动项。脚本优先使用 Task Scheduler；权限不足时自动回退到当前用户 Startup 快捷方式，无需管理员权限。使用 `.\scripts\install-task.ps1 -Remove` 可移除。

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
