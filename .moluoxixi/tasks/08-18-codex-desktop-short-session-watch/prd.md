# 修复 Codex Desktop 短会话漏采集

## Goal

保证 Codex Desktop 新建的短会话即使文件系统漏发 `change` 事件，也能在终态写入后被监控服务发现、解析并持久化，避免已完成任务永久缺失。

## Background

- 目标会话 `01a0128f-a511-76f0-8140-6142e3b45d63` 已由 Codex Desktop 写入完整 `task_complete`，当前解析器可正确生成 `提问：你好`。
- `data/monitor.db` 中不存在该 thread，链路在 watcher 读取与 ingestion 之间中断，不是 UI、可见性或投递问题。
- Codex Desktop session 文件的 `LastWriteTime` 可能保持为创建时刻；当前定时发现逻辑对 `files.has(path)` 的文件直接跳过，已知文件后续只能依赖 chokidar 的 `change` 事件。
- 当前服务进程早于最近一次 server 构建启动，修复完成后需要重建并重启服务才能生效。

## Requirements

- 定时兜底机制必须重新检查已知且仍可能增长的 Codex JSONL 文件，不能只发现新路径。
- 增量读取必须继续使用现有 offset，不能重复解析已消费内容或重复创建事件/投递。
- 保留现有 120 分钟回填窗口、subagent 过滤、CLI/Desktop 分类和数据库去重行为。
- 对单个文件的暂时读取失败必须允许后续重试，不能因为路径已进入 `files` Map 而永久放弃。
- 修复范围限制在 Codex session watcher 及其测试；不调整通知文案、渠道策略、UI 或数据库 schema。

## Acceptance Criteria

- [x] 模拟新 JSONL 先写入非终态内容、未触发 `change`、之后追加 `task_complete` 时，定时兜底能够生成且仅生成一条 completed event。
- [x] 模拟首次读取失败后，后续定时检查能够成功重试并生成事件。
- [x] 已知且文件大小未变化时不重复读取、不重复入库或投递。
- [x] 现有 Codex watcher 定向测试、server typecheck 和 server build 通过。
- [x] 重建并重启本地 `8787` 服务后，目标“你好”会话由回填机制进入 `monitor.db`，同一 `source_event_id` 不重复。

## Out Of Scope

- 重构所有平台 watcher。
- 修改 Codex Desktop 的 session 文件写入方式。
- 修复或清理现有 QQ/微信失败投递。
- 同步 Desktop 打包 resources 中与本缺陷无关的其他未提交功能。
