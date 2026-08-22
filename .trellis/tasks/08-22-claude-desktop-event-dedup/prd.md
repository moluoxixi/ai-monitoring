# 修复 Claude Desktop 来源与重复通知

## Goal

让 Claude Desktop 产生的通知稳定显示为 `Claude Desktop`，同一轮完成只通知一次，并阻止 Desktop 新会话携带的复制历史被误报为新完成事件。

## Background

- Claude hook 当前固定发送 `source=claude`、`client=claude-cli`，即使 hook 来自 Claude Desktop；见 `scripts/hooks/claude_event_adapter.py:155-170`。
- Desktop transcript watcher 依据顶层 `entrypoint === 'claude-desktop-3p'` 生成 `claude-desktop` 事件；见 `apps/server/src/events/claude-desktop-audit-watcher.service.ts:76-80,126-140`。
- 本机最近 7 天的只读数据核验发现 7 个 session 同时出现 CLI/Desktop 标签，并有 44 组两秒内邻近的双路终态；典型标题为 `Claude Desktop task completed` 与 `Claude Stop`。
- Claude Desktop 创建新 transcript 时可能复制旧分支历史，保留原 assistant `message.id`、UUID 和 timestamp，只改顶层 session ID。运行中新文件当前从 offset 0 全量 ingest；见 `apps/server/src/events/claude-desktop-audit-watcher.service.ts:238-257,287-329`。
- SQLite 目前只按完整 `source_event_id` 幂等；见 `apps/server/src/database/database.service.ts:52-117,436-451`。现有 hook 与 watcher 使用不同 ID，复制历史又包含新 session ID，因此都不能被现有唯一键合并。

## Requirements

- R1. Claude hook 必须从结构化 transcript 顶层 `entrypoint` 判断 Desktop；正文中出现 `claude-desktop-3p` 不得触发 Desktop 分类。不能仅凭 transcript 路径、进程名、回答文本或 session ID 猜测来源。
- R2. Desktop 的 `Stop`、`StopFailure` 与 `PostToolUseFailure` 必须标记为 `source=claude-desktop`、`client=claude-desktop`；普通 Claude CLI 行为保持为 `source=claude`、`client=claude-cli`。
- R3. Desktop completed 事件只有在 transcript 提供稳定 assistant terminal ID 时才由 hook 上报；若稳定 ID 尚不可见，hook 静默交给 watcher，不能使用随机 ID 制造不可去重的 Desktop completed 事件。CLI 缺少 turn ID 时继续使用随机 fallback，避免连续 CLI Stop 被错误合并。
- R4. hook 与 watcher 对同一 Desktop completed terminal 必须生成逐字相同的 canonical `source_event_id`，由数据库唯一约束原子去重，并允许后到事件补齐缺失的任务摘要或答案。
- R5. canonical completed 身份必须以稳定 assistant `message.id` 为主且不包含可被分支重写的 session ID，使同一 assistant terminal 跨 transcript 复制后仍视为同一事件。UUID 仅在 message ID 缺失时作为结构化 fallback。
- R6. watcher 启动时必须静默扫描枚举快照内已有 Desktop transcripts 的完整 JSONL 终态身份，并将 offset 置于快照内最后一个完整换行；历史终态不得产生通知，但必须参与之后的跨文件复制去重。枚举后新增字节以及跨快照边界补齐的半行必须作为 live 输入处理。
- R7. 运行中新 transcript 必须逐条处理：已经见过的 terminal ID 静默跳过；timestamp 严格早于首次发现文件的 birth/creation watermark 时，作为源文件缺失情况下的复制历史兜底跳过；其余未见终态正常 ingest。
- R8. 正常新建 transcript 中首个真实完成必须通知，包括 prompt 与 terminal 一次性写入、以及 terminal timestamp 等于或晚于文件创建时间的短会话。
- R9. truncate、rewrite、重复 change、同一 message ID 跨文件或同文件重现均不得产生额外完成通知；非 Desktop transcript、sidechain、synthetic/tool-result user 记录保持现有过滤语义。
- R10. Desktop tool failure 仍可作为独立 diagnostic 上报，因为 watcher 没有等价终态；不得错误绑定到最后一个 assistant terminal。Desktop failure 只有存在可证明稳定的 transcript error ID 时才与 watcher 共用 canonical ID，否则应由 watcher 负责，不做基于“最近错误”的猜测。
- R11. 不迁移或删除数据库中的既有重复历史记录。本次只保证升级后的新事件行为。

## Acceptance Criteria

- [x] AC1. 同一 Claude Desktop completed 由 hook 先到或 watcher 先到时，数据库均只有一个 event、每个 channel 只有一个 delivery，最终 client 为 `claude-desktop`。
- [x] AC2. Desktop hook 输入没有 hook turn ID 时仍使用 transcript assistant message ID 生成稳定事件 ID；重复执行得到相同 ID。CLI 对应场景仍得到不同随机 ID。
- [x] AC3. transcript 正文提及 Desktop marker 的 Claude CLI session 仍分类为 CLI；仅顶层精确 entrypoint 分类为 Desktop。
- [x] AC4. 服务启动已有 transcript 不通知；之后新文件复制其历史终态也不通知。
- [x] AC5. 运行中新文件包含多个旧 terminal 和一个新 terminal 时，只 ingest 新 terminal 一次；旧源已删除时 timestamp 兜底仍能阻止回放。
- [x] AC6. 正常新文件一次写入 prompt 与首个 terminal 时仍产生一条完成事件，不被“首次 add”规则误吞。
- [x] AC7. 同一 terminal 在跨 session 文件、truncate/rewrite 和重复 change 后重现，完成通知总数不增加。
- [x] AC8. 现有 Claude CLI、Desktop API error、tool-result/synthetic user、legacy audit 排除和启动后 append 行为测试继续通过。
- [x] AC9. 相关 Python 测试、server 测试、server/root 类型检查、build 与 `git diff --check` 通过；仓库未配置 lint script，因此没有可执行的 lint 命令。

## Out Of Scope

- QQ 引用续接 Codex Desktop 或 Claude Desktop 会话。
- 清理当前数据库里已经存在的重复事件或通知。
- 放宽 Claude Desktop transcript 的 `entrypoint` 识别条件。
- 通过回答文本 hash、相似度或固定时间窗做语义去重。
