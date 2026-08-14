# 可配置通知长度与平台扫描展示 - Design

## Boundaries

新增 `UserSettingsService` 负责通知长度和平台显示偏好，文件默认位于 `data/user-settings.json`。新增平台检测器只读取进程、PATH 和 canonical 配置/安装路径，不读取会话正文、缓存数据库或凭据。

`ExtensionsService` 只接受带运行端的 canonical key；旧 client 值仅在服务启动迁移历史数据库和设置文件时使用，迁移完成后不再作为 API 入口。扫描只向定义附加运行时状态，不改变事件归类。`GET /api/extensions` 仍是页面聚合入口，增加扫描状态和用户偏好；新增 `POST /api/extensions/scan`、`PUT /api/extensions/preferences`、`GET/PUT /api/notification-settings`。

## Data Contracts

用户配置版本 1：

```json
{
  "version": 1,
  "notification": { "taskLimit": 100, "resultLimit": 2000 },
  "visibleExtensions": ["codex", "claude", "qoder"],
  "visibleExtensionsConfigured": false
}
```

平台卡片增加：

```text
detected, cliAvailable, running, monitorConfigured, detectionSignals[]
monitorVerified, lastVerifiedAt
```

`visibleExtensionsConfigured` 仅在用户主动保存平台集合后变为 `true`，避免只保存通知长度时意外固定默认平台。`detected` 表示存在至少一个高可信安装/运行信号；`monitorConfigured` 仅在通知/Hook/Watcher 所需配置存在时为真。信号只返回安全枚举，不回显本机绝对路径。

`monitorVerified` 只由真实 producer 事件成功写入 relay 后更新；dashboard 测试事件和静态扫描不能更新。验证状态持久化到独立版本化 JSON，保存平台 key、最近验证时间与事件来源，不保存提问、回答、路径或凭据。

平台 key 必须包含运行端：`<product>-cli` 与 `<product>-desktop` 是两个独立扩展。旧的无运行端 client 值只在启动迁移阶段改写为新的 canonical key，之后事件接口拒绝旧值，避免把 Desktop 静默归入 CLI。Qoder、Hermes、Cursor 事件必须由适配器直接提交对应的 `*-cli` 或 `*-desktop` key；不能依赖缺失 runtime 的短名推断。

## Detection

Windows 检测优先级：精确进程名和可执行路径、PATH 命令、canonical 配置/安装路径组合。Codex、Claude、Qoder、Hermes、Cursor 各自定义探针，不使用模糊目录名。非 Windows 或容器环境返回支持目录和空检测状态，并带 `scanScope=unsupported`。

扫描在服务启动时执行一次；重新扫描由 API 显式触发。扫描异常按平台隔离并返回空信号，不能让扩展 API 失败。

## Real adapters

- Claude Desktop 使用官方客户端生成的 `local-agent-mode-sessions/**/audit.jsonl` 结构化终态，只读取 user 文本、最终 result 和 error，不读取 thinking/tool/system/account 内容。
- Hermes 使用官方 shell hook 的 `on_session_end` 与 `api_request_error` stdin JSON；终态字段从 `extra` 读取。
- Cursor 只有在安装后通过真实 capture 确认 payload 能区分终态时才启用完成/失败映射。
- Codex、Claude Code、Qoder 继续使用现有 notify/hook/session 适配器，但安装检查必须精确匹配本项目命令。

## Notification Limits

delivery worker 每次组装正文时读取内存中的当前配置。生产者保留现有安全存储上限：提问至少保留 2,000 字，失败消息和最终回答最多保留 24,000 字；真正的用户上限只在最终投递处应用，避免设置高于旧固定 160/2,000 时失效。

## Compatibility

用户配置缺失时保持 100/2,000 和现有三平台默认显示。旧事件、通道配置和数据库结构不迁移。Hermes/Cursor 先进入支持目录；是否已接入由 `monitorConfigured` 准确表示，不能只因目录存在显示为已启用。
