# 修复 Codex fork 快照误报中断

## 目标

防止 Codex 持久 `thread/fork` 复制出的父线程历史被 session watcher 当作新产生的实时事件，避免仍在运行的父任务收到“任务已中断 / 未采集到最终回答”误报，同时保留 fork 自己后续 turn 的正常完成通知。

## 已确认事实

- 任务事件 805 来自一个持久 fork 快照中的 `event_msg/turn_aborted`，但父 turn 在该事件之后仍持续写入成功的 `patch_apply_end`，因此该通知是误报。
- 真实 fork JSONL 首行是 fork 自己的 `session_meta`，包含 `forked_from_id`；后续紧跟完整父级/祖先历史，其中可以出现多个旧 `session_meta`、`task_started`、`task_complete` 和 `turn_aborted`。
- 复制历史的顶层时间戳会被重写为 fork 创建时刻，不能用顶层 `timestamp` 判断新旧；`session_meta.payload.timestamp` 与 `task_started.payload.started_at` 保留原始时间。
- 当前 parser 对每个 `session_meta` 都覆盖文件状态，并接受任意带 `turn_id` 的终态，见 `apps/server/src/events/codex-session-watcher.service.ts:102`、`:162`、`:193`。
- 当前 `syncFile` 与 `readContextBefore` 分别重放相同状态，但都没有文件 owner、fork 边界或 owned turn 概念，见同文件 `:315`、`:387`。

## 需求

- R1. 一个 JSONL 文件的逻辑 session owner、client 和 subagent 身份必须由首个有效 `session_meta` 锁定；复制历史中的后续 foreign `session_meta` 不得改变文件身份。
- R2. 首个 meta 含 `forked_from_id` 时，watcher 必须把该文件识别为 fork，并阻止复制历史中的 prompt、started timing、provisional suppression、answer 和 terminal event 污染 fork 状态或产生 delivery。
- R3. fork 文件只允许采集由该文件明确认领的 turn：其 `task_started.payload.started_at` 不早于 fork 创建时间，且终态 `turn_id` 与已认领 turn 相同。
- R4. fork 自己的新 turn 必须继续产生原有 `codex-cli` / `codex-desktop` 分类、问题摘要、最终回答、timing、provisional suppression 和完成通知。
- R5. 普通非 fork session 保持兼容：即使终态之前没有观察到 `task_started`，仍按当前规则处理；现有 CLI、Desktop、subagent、partial-line、backfill 和大文件恢复行为不得回归。
- R6. `syncFile` 与 `readContextBefore` 必须共享同一套文件身份和 turn 归属状态迁移，避免实时路径修好但重启/大文件恢复路径仍误报。
- R7. 当 fork 创建时间或 turn 开始时间缺失/非法、无法证明终态属于 fork 时，采用保守策略跳过该终态，不发送可能错误的通知。

## 验收标准

- [x] AC1. 使用真实持久 fork 形状的文件级测试证明：fork meta 后复制的多个父/祖先 meta、父 prompt、父 `task_complete` 和父 `turn_aborted` 均不调用 ingestion。
- [x] AC2. 同一 fixture 追加 fork 自己的新 `task_started`、用户消息、agent message 和 `task_complete` 后，只产生一条属于 fork session/turn 的 completed 事件，并保留 CLI source、摘要和答案。
- [x] AC3. 超过 1 MiB、需要 `readContextBefore` 恢复 fork owner/boundary 的 fixture 仍只采集 fork 自己的终态。
- [x] AC4. 缺失或非法 fork/turn 时间时不会投递未证实归属的终态。
- [x] AC5. 现有普通 CLI、Desktop、subagent、mismatched timing、startup backfill 和 partial JSONL 测试全部通过。
- [x] AC6. server 定向测试、全量测试、typecheck、build 和 `git diff --check` 通过；若 package 没有 lint script，明确记录而不伪造 lint 结果。

## 范围外

- 不删除或改写已发送的事件 805、delivery 或历史数据库记录。
- 不撤回已经发出的 QQ/微信通知。
- 不修改 `thread/fork`、连续分支头、CAS 或入站回复协议。
- 不通过进程探测推断 turn 状态，也不终止 Codex Desktop/App Server。
- 不为 Codex JSONL 增加运行时本身不存在的显式 history-boundary 字段。
