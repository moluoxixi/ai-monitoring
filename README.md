# AI Coding Monitor

本仓库提供本地 AI 任务消息监控中心：保存任务提问、回答、失败原因和通知投递状态，并通过 [OpenClaw](https://github.com/openclaw/openclaw) 及腾讯维护的通道插件发送 QQ/微信消息。本仓库提供 Windows 源码快速部署、Windows/macOS 桌面安装包、官方 hooks/notify 接入、可靠通知 outbox 和统一入口。

## 架构

```text
Claude CLI
  -> 官方 Claude hooks
  -> 通知中心 :8787 -> OpenClaw / Apprise

Claude Desktop
  -> Desktop session transcript watcher
  -> 通知中心 :8787 -> OpenClaw / Apprise

Codex CLI
  -> notify multiplexer / App Server proxy
  -> 通知中心 :8787

QQ 引用回复 Codex / Claude 完成通知
  -> OpenClaw before_dispatch 插件 -> 通知中心 :8787
  -> Codex: thread/fork + turn/start；Claude: resume + fork-session
  -> 每条回复推进独立分支头，不抢占 Desktop 持有的源会话

Codex Desktop
  -> Codex session watcher
  -> 通知中心 :8787

Codex App Server 客户端
  -> 本仓库 stdio 协议代理
  -> turn/item/error 正式终态 -> 通知中心 :8787

Qoder CLI
  -> ~/.qoder/projects session watcher（entrypoint=cli + end_turn）
  -> 通知中心 :8787 -> OpenClaw / Apprise

Qoder Desktop
  -> ~/.qoder/projects/**/transcript + Qoder window*/agent.log completed state
  -> 通知中心 :8787 -> OpenClaw / Apprise

Qoder Quest
  -> .session.execution transcript + Qoder questWindow/agent.log completed state
  -> 通知中心 :8787 -> OpenClaw / Apprise

Hermes CLI
  -> 官方 on_session_end / api_request_error shell hooks
  -> 通知中心 :8787

Hermes Desktop
  -> state.db / request dump / Desktop log watcher
  -> 通知中心 :8787

Cursor CLI
  -> 官方 stop / postToolUseFailure hooks
  -> 通知中心 :8787

Cursor Desktop
  -> 官方 stop / postToolUseFailure hooks
  -> 通知中心 :8787
```

通知中心负责任务详情、失败原因、消息概览、重试和通道状态。OpenClaw 只作为后台 QQ/微信发送网关，不作为本项目用户界面。`8787` 是唯一入口。Vue 3 主界面提供“消息”“扩展”两个视图：消息支持搜索、按独立的 CLI/Desktop/Quest 平台和状态筛选；扩展页会分别展示 Codex、Claude、Qoder（含 CLI、Desktop、Quest）、Hermes、Cursor 的独立条目，可切换“已检测/已展示”、重新扫描、选择显示平台并配置通知长度。点击消息直接打开本地任务详情。

通知中心采用标准 npm workspace：`apps/web` 是 Vue 3 + Vite + Element Plus，`apps/server` 是 NestJS。扩展、事件、数据库、通道 provider、投递 worker 和页面组件均为独立模块。Codex、Claude、Qoder、Hermes、Cursor 都有独立适配器；只有稳定 session、数据库、协议或官方 hook 数据源经过验收后，平台才会报告“已验证可用”。

## Windows 快速部署

前置条件：Windows 10/11、Node.js 20 或更高版本、Python 3.12 或更高版本，以及可访问 npm/PyPI 的网络。Python 用于官方 hook、notify 和 App Server 适配器。

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install.ps1 -ConfigureHooks
.\scripts\run.ps1
.\scripts\run-relay.ps1
```

主界面：[http://127.0.0.1:8787](http://127.0.0.1:8787)。任务详情和通知记录使用 `data/monitor.db` 下的本地 SQLite，单机部署不需要 Docker、PostgreSQL、ClickHouse、Redis 或 MinIO。

安装脚本注册 Claude、Codex、Hermes 和 Cursor 的 hooks/notify 适配器，并只读监听 Qoder 的 `~/.qoder/projects` session 与 Qoder 自身 `agent.log`。每个集成通过稳定的 adapter 文件名标识本项目条目，重复安装会替换旧条目而不会叠加。安装或升级时会备份 Codex、Claude、Qoder、Hermes、Cursor 配置和 Codex notify targets，并精确移除旧版 `qoder_event_adapter.py` 条目，不会改动其它 Qoder hooks。配置备份保存在 `%LOCALAPPDATA%\AI-Monitor\config-backups`，每个新备份含 `manifest.json`，不进入仓库。Hermes 首次运行还需要用 `hermes --accept-hooks` 启动一次实际任务，或在交互终端确认本项目 hook；未获 Hermes 安全同意前不会报告已配置。

卸载时默认使用精确 marker 删除 AI Monitor 条目，保留用户其他 hooks 和设置：

```powershell
.\scripts\uninstall-hooks.ps1 -RemoveOnly
```

如需完整恢复某次安装前的配置，必须显式指定带 manifest 的备份目录：

```powershell
.\scripts\uninstall-hooks.ps1 -RestoreBackup `
  -BackupPath "$env:LOCALAPPDATA\AI-Monitor\config-backups\20260819-120000-000"
```

`RestoreBackup` 会覆盖备份时已存在的配置文件；对当时不存在的文件，只移除本项目 marker，保留安装后新增的用户配置。两种模式都会卸载 OpenClaw `ai-monitor-replies`，但保留 `openclaw-qqbot`、`openclaw-weixin`、扫码登录态和整个 OpenClaw state 目录。已知 state 路径时还会移除其中的精确 bootstrap marker；桌面包或外部 Gateway 使用非默认 state 时传入 `-OpenClawStateDir <path>`。只清理 AI 客户 hooks 时使用 `-SkipOpenClaw`。

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

桌面包默认内置固定版本的 OpenClaw、QQ 插件、微信插件和 AI Monitor 引用回复插件，用户无需另装 Node.js 或 OpenClaw；首次使用仍需在界面扫码登录，凭据不会写进安装包。Windows 和 macOS 必须分别在目标系统构建，因为安装包会嵌入当前系统的 Node runtime 与 `better-sqlite3` 原生模块；macOS 还需按 Intel/Apple Silicon 分别构建，除非另行配置 universal pipeline。

仓库提供 `desktop-build` GitHub Actions（手动触发或推送 `v*` 标签）分别构建 Windows x64、macOS Intel 和 macOS Apple Silicon 安装包；手动构建产物位于 Actions artifacts，`v*` 标签构建还会把 MSI/EXE/DMG 汇总到对应 GitHub Release。当前未配置 Windows 代码签名或 macOS 签名/公证，公开分发前应接入平台证书。

Tauri 会优先复用 `127.0.0.1:8787` 上健康的通知中心；没有服务时启动 Node sidecar，并等待 `/api/health` 后再打开本地页面。这样已安装的 AI hooks 不需要改成随机端口。桌面构建默认把固定版本的 OpenClaw、QQ 插件和微信插件一起打进安装包，首次启动自动把插件准备到用户数据目录并启动 `127.0.0.1:18789` Gateway。若该端口已有外部 Gateway，桌面端会拒绝复用，因为无法验证其插件 state 和回复令牌；可先关闭外部 Gateway，或继续使用它所连接的现有通知中心。首次构建/首次启动需要访问 npm 下载或校验插件，QQ/微信扫码登录仍需用户在页面中完成。SQLite、用户设置、绑定、OpenClaw 登录状态和通知 outbox 使用系统用户数据目录，不会写入安装包。可通过 `AIMONITOR_OPENCLAW_CLI_PATH` 使用外部 CLI，或设置 `AIMONITOR_DESKTOP_SKIP_OPENCLAW_INSTALL=1` 构建不含 OpenClaw 的精简包。

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

若项目 `.venv` 不存在，该脚本会自动创建仅供剩余 hooks/notify 集成使用的 Python 3.12+ 环境并安装最小依赖，不会在宿主机重复构建 Vue/Nest 服务。Docker 启动脚本会把宿主机 Codex session、Qoder session 与 Qoder logs 目录只读挂载到 monitor 容器。

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

Codex CLI/Desktop、Claude CLI/Desktop 和 Qoder CLI 完成通知支持引用回复：在 QQ 中长按该通知并选择“回复”，输入纯文本后发送。所有新通知都由通知中心先渲染成同一条完整文本（标题、`[任务ID:...]` 和正文），再交给各渠道 provider 投递；服务端仍会在数据库中生成不透明 route token，用于保留 30 天有效期、投递状态与分支头校验，但不再把内部标记放进通知影响阅读。已经发出的 `[AI-MONITOR-REPLY:...]` 旧通知继续兼容。为与 QQ 消息格式保持一致，统一正文不附加开始时间、完成时间和总耗时字段。OpenClaw 只会认领“私聊 + 引用 + 有效任务 ID 或旧标记”的消息，普通 QQ 对话、群消息和引用其它通知都会继续走原 OpenClaw 行为。服务端会重新校验当前 QQ 绑定、route 有效期和 QQ message id 幂等。Codex 通过 [Codex App Server](https://developers.openai.com/codex/app-server/) 从最新 thread 执行 `thread/fork + turn/start`；Claude 和 Qoder CLI 优先从事件记录的项目 `cwd` 通过各自 CLI 执行 `--resume <session> --fork-session`，从 `stream-json` 的初始化事件取得新 session ID；历史事件缺少 cwd 时会回查本地 transcript。三者都原子推进该 delivery 的独立分支头，不直接写回或争抢可能被 Desktop 持有的源会话。远程执行使用非交互审批模式，插件确认语只表示后台任务已接收，完整回答会在完成后另发一条 QQ 消息。

当前回复范围覆盖 `openclaw-qq + Codex/Claude CLI/Desktop + Qoder CLI + 纯文本私聊引用回复`，不支持 Hermes、Cursor、Qoder Desktop/Quest、QQ群或图片/语音。Qoder Desktop 的 session transcript 位于独立存储，Qoder CLI 1.1.23 会将其拒绝为无效 session，因此不会伪装成可续接。服务端用任务 ID 定位同一条 QQ delivery，但仍要求后台 route 已生成且有效，并重新校验当前 QQ 绑定；不可续接任务会返回明确提示，不会落回 OpenClaw 模型。同一 delivery 的后续回复从已保存的最新 Codex thread、Claude session 或 Qoder CLI session 继续 fork，因此保留对话历史而不争抢源 writer。fork 可能被对应 Desktop 索引或打开，但是否立即显示在 Desktop UI 不属于 Monitor 的协议保证。route 默认 30 天过期，同一 QQ message id 只会提交一次；未知的跨进程执行结果不会自动重放，避免创建重复 turn。

源码部署并复用全局 OpenClaw Gateway 时，首次启用、升级回复插件或修改 reply token 后运行 `node scripts/ensure-openclaw-plugins.mjs`，再执行 `openclaw gateway restart`。安装脚本会读取仓库 `.env`、安装回复插件并把鉴权配置写入 OpenClaw 本地 state；否则引用消息会落回普通 OpenClaw agent 路由。

微信也可在通知中心点击“绑定”。服务调用腾讯插件官方 `openclaw channels login --channel openclaw-weixin` 流程，并把插件生成的二维码显示在页面中；扫码确认后，需要先在微信中给机器人发送任意一条消息，使腾讯协议签发主动回复所需的 context token。页面验证该 token 已由插件落盘后，才会读取当前账号 ID 和扫码用户 ID 作为通知路由并显示绑定成功。本项目自己的绑定文件不保存微信 token，也不会通过“最近私聊”猜测接收目标。

QQ 通知由 OpenClaw Gateway 的官方 `cron --announce` 路径投递，确保复用已运行的 QQ Bot 连接；微信通知使用标准 `message send --json` 直连接口；Apprise/PushPlus 使用 Apprise CLI。上述 provider 都只接收通知中心已经渲染好的完整文本，不再分别拼接标题或正文。正文不经过模型改写，Gateway/插件未确认时不会标记为成功。腾讯微信插件 2.4.6 的 direct-send 入口不会自动恢复已落盘的 context token，Docker 启动入口会校验固定插件版本并应用跨平台兼容补丁，防止 CLI 返回消息 ID 但微信未实际展示。OpenClaw 返回失败时，delivery 保持在 SQLite outbox 中指数退避；连续 10 次失败后进入死信，可通过 relay 重试 API 手工重试。

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

QQ 入站回复使用 `AIMONITOR_REPLY_TOKEN`，未单独配置时回退到 `AIMONITOR_INGEST_TOKEN`；两者均为空时 reply endpoint 必须拒绝请求。桌面 App 会在用户数据目录生成受限权限的本地回复令牌并同时注入 Gateway 与 server。可用 `AIMONITOR_REPLY_ROUTE_TTL_DAYS` 调整 route 有效天数，用 `AIMONITOR_CODEX_COMMAND`、`AIMONITOR_CLAUDE_COMMAND`、`AIMONITOR_QODER_COMMAND` 分别指定 Codex、Claude 和 Qoder CLI。Docker 默认会安装并加载引用回复插件，但 Compose 内的 Monitor 无法直接启动宿主机 CLI；若要在容器部署中续接会话，需要显式提供容器内可执行的 CLI、认证、项目目录和可写会话数据，否则 endpoint 会返回明确的启动错误。

Relay 收到事件后先写 SQLite outbox，再由 Apprise 投递；失败会指数退避，连续 10 次失败后进入 `dead` 状态。这个保证从 relay 成功接收事件开始，生产者到 relay 的短暂不可用会记录到 stderr，但当前没有跨进程的入口持久队列。

## 错误检测边界

- **Claude CLI**：本地也会生成 session transcript，但 CLI 的官方 hook 额外提供 `StopFailure`、`PostToolUseFailure` 和 runtime 事实，因此 CLI 仍以 hook 为权威，避免与 session 重复投递。
- **Claude Desktop**：读取 Desktop 内嵌 Claude Code 写入的 `~/.claude/projects/**/*.jsonl` session transcript；仅接受顶层 `entrypoint: "claude-desktop-3p"` 的会话，不把普通 Claude CLI、thinking 或工具回写归入 Desktop。
- **Qoder CLI**：只读监听 `~/.qoder/projects/**/*.jsonl`，仅接受顶层 `entrypoint: "cli"` 且 assistant `stop_reason: "end_turn"` 的完成记录。
- **Qoder Desktop**：transcript 只提供提问/回复上下文；完成必须同时由 Qoder 自身 `logs/**/window*/agent.log` 的 `chat_finish:success:200` 状态证明，普通 assistant 文本不会单独触发通知。
- **Qoder Quest**：通过 `.session.execution` 或 `blank_session_quest` session ID 归类，并只接受 `logs/**/questWindow/agent.log` 的成功完成状态。Qoder 文件未公开稳定的失败/中断终态，因此三类 Qoder 只声明完成能力。
- **QoderWork**：已检测到独立应用，但 GUI 当前没有稳定、公开且可由本项目订阅的完成/失败 hook；保持“已安装，未接入”，不会从日志猜测任务结果。
- **Hermes CLI**：官方 shell hook 覆盖 `on_session_end` 和 `api_request_error`；首次 hook consent 未完成时不会运行。
- **Hermes Desktop**：Desktop 的 `tui_gateway` 不加载 CLI shell hooks，因此服务只读监听官方 `state.db` 的终态回答、新生成的 `request_dump` 失败记录和 Desktop 日志中的新增中断标记；`finish_reason` 或日志可证明失败/中断时才按对应状态归类，不会读取请求 headers/body、thinking 或工具内容，验证状态和事件计数不与 CLI 合并。
- **Cursor CLI**：目前只有 `conversation-search.db` 索引和编辑历史，未确认稳定的 agent session transcript；官方 `stop` 可监测响应完成，`postToolUseFailure` 只代表工具失败，不等价于整个任务/API 失败。
- **Cursor Desktop**：独立平台条目；搜索数据库不保存可安全重放的完整终态，因此继续使用显式 runtime 的官方 hook，只报告官方能证明的“完成 + 工具失败”能力。
- **Codex CLI**：notify multiplexer 与 App Server proxy 归入 Codex CLI，负责 CLI 的完成和严格协议错误。
- **Codex Desktop**：结构化 session JSONL watcher 独立归入 Codex Desktop，补齐 Desktop 的完成、中断和带错误终态；Desktop 没有公开内部 App Server 事件订阅，不能承诺捕获每一次 API 失败。
- **Codex 严格错误终态**：只有通过 [Codex App Server 正式协议](https://learn.chatgpt.com/docs/app-server) 的客户端，才能可靠获得 `error`、`turn/completed` 的 `completed/interrupted/failed` 以及 `item/completed`。使用 `.\scripts\run-codex-app-server-proxy.ps1` 作为该客户端的 stdio server command。
- **Codex Desktop 限制**：Desktop 当前没有向第三方公开其内部 App Server 事件订阅，因此无法承诺外部监控能捕获每一次 Desktop API 失败。仅靠 `notify` 或猜测私有日志不能满足“错误必检”。
- **Claude Desktop**：本地 watcher 只监听 session transcript；启动时跳过已有历史，只监测后续新增消息。路径可通过 `AIMONITOR_CLAUDE_DESKTOP_TRANSCRIPTS_PATH` 覆盖。
- **Qoder sessions/logs**：默认监听 `~/.qoder/projects` 与 Qoder 应用数据目录下的 `logs`，路径可分别通过 `AIMONITOR_QODER_SESSIONS_PATH`、`AIMONITOR_QODER_LOGS_PATH` 覆盖；启动时读取已有文件建立上下文但不创建历史通知。

## v1.0.10 发布报告

发布日期：2026-08-18。该版本修复 Windows GitHub Actions hosted runner 上 Claude Desktop 文件监听回归测试触发 Node/libuv `fs-event` 进程崩溃的问题，并重新发布 `v1.0.8` 引入的 QQ 引用续接功能。

### CI 修复

- 原始 job 日志确认 25 个 server test files 已完成 24 个，唯一未完成的是包含真实 Chokidar 文件监听场景的 Claude Desktop watcher；故障发生在测试断言之外，由 Windows Server 2025 的原生 `fs.watch` 后端中止 worker。
- Windows CI 的 `Test workspaces` 步骤设置 Chokidar 内置环境开关 `CHOKIDAR_USEPOLLING=1`，使用 polling 后端验证相同的新增、变更和忽略文件行为；macOS runner 显式保持原生监听后端。
- `v1.0.9` 的单 worker 尝试未解决底层 `fs-event` 崩溃，因此 `v1.0.10` 恢复测试文件并行；没有删除、跳过或改写任何测试。
- `v1.0.8`、`v1.0.9` tag 保留失败流水线记录，不进行重写；安装包由 `v1.0.10` tag 构建和发布。

## v1.0.9 发布报告

发布日期：2026-08-18。该版本保留 `v1.0.8` 的 QQ 引用续接功能，并修复 Windows GitHub Actions 在全量测试阶段无法进入安装包构建的问题。

### CI 修复

- Vitest 4 默认并行 fork 多个 test file worker；Windows runner 上的文件监听测试会触发 Node/libuv `fs-event` 断言，导致 `Test workspaces` 失败，而本地 Windows 和 macOS runner 的同一测试集均可通过。
- 根 workspace 测试改为对 server/web 使用 `--no-file-parallelism`，在单个 fork worker 中顺序执行所有 test files；没有删除、跳过或改写任何测试，Node 工具链与 OpenClaw 插件测试仍按原顺序执行。
- `v1.0.8` tag 保留失败流水线记录，不进行重写；`v1.0.9` tag 用于验证单 worker 修复尝试。

## v1.0.8 发布报告

发布日期：2026-08-18。该版本发布 QQ 引用回复到原 Codex CLI 会话的完整链路，并统一根包、server、web、desktop、Tauri 与 lockfile 的版本号为 `1.0.8`。

### 主要变更

- 所有 outbox 通知正文都以稳定的 `[任务ID:<id>]` 开头；可续接的 QQ 通知同时携带不可猜测、对同一 delivery 稳定的回复路由令牌。
- QQ 私聊引用回复会在 OpenClaw 默认 agent 路由前被项目插件认领；引用预览丢失路由令牌时，可用任务 ID 定位原通知，但仍需通过 route 有效期、投递状态和 QQ sender/account 绑定校验。
- Codex CLI 回复通过官方 App Server 协议依次执行 `initialize`、`thread/resume` 和 `turn/start`，使用原 `thread_id`、幂等消息 ID 和 `approvalPolicy: never`；续接后的用户文本会成为下一轮完成通知的提问摘要。
- 修复 Windows 下 pnpm 裸 `codex` shim 启动 App Server 时的 `spawn EPERM`，改由 `codex.CMD` 与 `cmd.exe` 启动。
- 回复插件已接入 Docker 与桌面资源，补齐 Gateway 启动 capability、运行时 hook 校验和持久化 reply token/URL 配置，避免 Gateway 与 Monitor 独立重启后继续使用旧 token 导致 401。
- 不可续接的任务会被插件认领并返回明确错误，不再落回 OpenClaw provider；普通 QQ 消息、群消息和其他渠道不受影响。

### 安全与兼容边界

- 任务 ID 只是路由候选，不是授权凭据；服务端只允许已发送、已生成有效 route、未过期且属于 Codex CLI 的 QQ delivery 续接，并对同一 QQ message id 保证幂等。
- Codex Desktop 会话由 Desktop 内部 App Server 持有 active writer，当前无法由第三方进程安全续接；这类通知会明确提示不支持，不会绕过单写者约束。
- 入站接口使用 `AIMONITOR_REPLY_TOKEN`，未配置时可回退到 `AIMONITOR_INGEST_TOKEN`；二者都为空时 fail closed。内部 URL 和 token 不会写入通知正文或日志。

### 验证记录

- 根 workspace 测试、server/web 类型检查与构建、OpenClaw 回复插件测试、桌面工具链检查和 Tauri Rust 测试通过。
- `git diff --check` 通过；Windows/macOS 安装包继续由 `v*` tag 触发 GitHub Actions 构建和发布。

## v1.0.7 发布报告

发布日期：2026-08-15。该版本把桌面端生命周期和多平台监控支持一起发布，并统一根包、server、web、desktop 与 lockfile 的版本号为 `1.0.7`。

### 主要变更

- Claude Desktop 从旧版 `audit.jsonl` 切换为监听 `~/.claude/projects/**/*.jsonl` session transcript；只接受顶层 `entrypoint: "claude-desktop-3p"`，过滤普通 Claude CLI、thinking、工具回写和历史重复事件。
- Codex Desktop 使用 `~/.codex/sessions/**/*.jsonl`，支持启动回填、增量 tail、完成/中断/错误终态归类和去重。
- Hermes Desktop 使用只读 `state.db`、新生成的 `request_dump_*.json` 和 Desktop 日志；不读取请求 headers、body、thinking 或工具内容。
- Qoder CLI/Desktop/Quest 改为只读 session/log watcher：CLI 使用 `entrypoint + end_turn`，Desktop/Quest 使用各自窗口 `agent.log` 的成功终态并关联 transcript；Cursor CLI/Desktop 继续使用带 runtime 事实的官方 hooks。
- Tauri 桌面端新增托盘驻留、关闭窗口转隐藏、显式退出、单实例、自启动开关和终态原生通知；浏览器开发模式不会加载桌面专用 API。
- 扩展扫描、能力矩阵、前端展示和 README 同步上述数据源边界；QoderWork 保持“已检测、未接入”。

### 数据源决策

本版本遵循“平台提供稳定 session/数据库时优先使用，否则使用官方 hook”的原则：

| 平台 | 权威来源 | 当前边界 |
|---|---|---|
| Claude Desktop | `~/.claude/projects/**/*.jsonl` | 只监测 Desktop entrypoint，启动时跳过已有历史 |
| Codex Desktop | `~/.codex/sessions/**/*.jsonl` | 可识别完成、中断和结构化错误；私有 API 失败仍受限 |
| Hermes Desktop | `state.db`、request dump、Desktop log | 只采集官方数据能证明的完成、失败或中断 |
| Qoder CLI/Desktop/Quest | `~/.qoder/projects` JSONL + Qoder `logs/**/agent.log` | CLI 使用 `end_turn`；Desktop/Quest 使用窗口成功终态；仅报告完成 |
| Cursor CLI/Desktop | 官方 stop/postToolUseFailure hooks | 搜索数据库不是完整 agent session |

### 验证记录

- `npm test`：server `139 passed`、`1 skipped`；web `6 passed`；desktop toolchain `1 passed`。
- `npm run typecheck`、`npm run build`、`git diff --check`：通过。
- Python hooks/adapter 测试：`67 passed`；Tauri Rust 测试：`1 passed`。
- 本机冒烟验证：Claude transcript 识别到 `claude-desktop-3p` 与 `end_turn`；Codex rollout 解析到 13 个终态事件；Hermes `state.db`、Cursor conversation index 和 Qoder session 文件均已探测并按上述边界处理。
- relay 已重启并在 `http://127.0.0.1:8787` 健康运行；Claude Desktop 扫描状态为 `monitorConfigured=true`，监控来源为 `sessions`，不再依赖 `audit`。

### 发布边界

本版本不逆向第三方私有协议，不把缺少 runtime 的日志猜成平台事件，也不宣称覆盖 Desktop 未公开的每一次 API 失败。Windows/macOS 桌面安装包仍由 `v*` 标签触发构建；当前未配置代码签名或 macOS 公证。

## 服务

| 服务 | 地址 | 作用 |
|---|---|---|
| 通知中心 | `http://127.0.0.1:8787` | 默认入口、任务/消息概览、重试和通道状态 |
| OpenClaw Gateway | `127.0.0.1:18789` | 后台 QQ/微信机器人网关，不作为用户入口 |

可用 `.\scripts\install-task.ps1` 将通知 relay 注册为当前用户登录时启动项。脚本优先使用 Task Scheduler；权限不足时自动回退到当前用户 Startup 快捷方式，无需管理员权限。两种入口都会通过 supervisor 运行 relay，服务意外退出后等待 5 秒自动重启，运行日志写入 `data/relay-supervisor.log`。手工前台调试仍使用 `.\scripts\run-relay.ps1`；使用 `.\scripts\install-task.ps1 -Remove` 可移除自启动。

<!-- AIRULES:TRELLIS:START -->

## Trellis 工作流

本项目使用 Trellis 管理 AI 辅助开发流程。在本项目中使用 AI 编程助手时，可以直接发送以下提示词：

```text
请使用 Trellis 开始处理这个需求：<描述需求>
请使用 Trellis 继续当前任务。
请使用 Trellis 检查当前改动。
请使用 Trellis 完成本次工作。
```

AI 编程助手会根据当前宿主选择可用的命令或技能。项目的工作流、任务和规范状态位于 `.trellis/`。

将接口文档、业务说明等文本资料放入 `.trellis/knowledge/sources/`。AI 会在每次对话时检查内容差异，把资料按业务域和稳定实体整理到 `.trellis/knowledge/library/`，并更新 `.trellis/knowledge/index.md`；只有遇到会实质影响整理结果的歧义时才会询问。

<!-- AIRULES:TRELLIS:END -->
