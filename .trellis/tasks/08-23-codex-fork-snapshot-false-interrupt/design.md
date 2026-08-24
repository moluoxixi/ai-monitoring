# 修复 Codex fork 快照误报中断 - 技术设计

## 问题边界

最小行为缺口位于 Codex session watcher：一个持久 fork 文件同时包含“文件自己的首个 meta”“复制的父历史”和“fork 后续实时记录”，当前状态机却把三者视为同一条可变 session 流。

本次只修改 watcher 及其测试，不改变 App Server fork、数据库 schema、delivery worker 或回复分发协议。

## 数据流

```text
Codex thread/fork
  -> fork JSONL 首个 session_meta（文件 owner + forked_from_id）
  -> 复制父/祖先历史（foreign meta + historical turns）
  -> fork 自己的新 task_started / messages / terminal
  -> CodexSessionWatcher 文件级状态机
  -> 仅 owned turn 进入 EventIngestionService
```

## 文件身份契约

- 首个有效 `session_meta` 建立不可变的 `ownerSessionId`、owner client 和 owner subagent 身份。
- 后续相同 owner meta 可以被识别但不得重新初始化文件边界；后续 foreign meta 作为复制历史忽略，不能覆盖 owner。
- 首个 owner meta 含非空 `forked_from_id` 时，该文件进入 fork 模式。
- fork 创建时间优先取首个 meta 的 `payload.timestamp`，无法解析时回退顶层 `item.timestamp`；两者均不可用时保持 boundary unknown。`started_at` 为秒级而 meta 可为毫秒级，归属比较使用双方共同的秒级精度。

## Turn 归属契约

- 普通非 fork 文件沿用现有宽松规则。
- fork 文件中的 `task_started` 只有在其 `payload.started_at` 可解析且不早于 fork 创建时间时，才把 `turn_id` 加入 owned turns，并启用该 turn 的 summary/answer/timing 状态。
- fork 文件中的 copied prompt、agent message、task timing 和 provisional suppression 在没有 active owned turn 时全部忽略。
- fork terminal 只有在 `turn_id` 属于 owned turns 时才生成事件；copied 或无法证明归属的 terminal 不得清空 active owned turn 状态。
- owned terminal 消费后移除对应 turn，并按现有逻辑清理 turn-scoped state。

## 状态恢复

把 owner、fork boundary、owned turns 和现有 summary/answer/timing 组成统一文件上下文。`syncFile` 和 `readContextBefore` 使用同一个逐行状态迁移入口；后者重放大文件前缀时只恢复状态，不 ingestion。

这样可覆盖：

- watcher 在 fork 文件已写入大量快照后才观察到文件；
- 文件超过尾部读取窗口，需要从头恢复上下文；
- 服务重启后按现有 backfill 规则重新发现文件；
- copied terminal 与 fork 新 turn 位于同一初次读取批次。
- 超出 backfill 窗口的旧文件跳过历史投递时仍读取首个 meta，保证后续 append 可以使用已锁定 owner。

## 兼容与失败策略

- 非 fork session 不新增 started-turn 前置要求，避免丢失 notify/旧格式终态。
- subagent 判定由 owner meta 锁定，copied parent meta 不能把 subagent 改成普通 session，反之亦然。
- fork 边界或 started time 无效时宁可漏掉未证实终态，也不发送错误的完成/中断通知；记录调试日志仅在现有日志风格允许且不会形成高频噪声时加入。
- 不依赖顶层复制时间、文件名、扫描顺序、父文件仍存在或进程内全局 seen set。

## 测试策略

- 核心回归使用真实字段形状：首 meta 带 `forked_from_id`，复制段含多个 foreign meta 和父终态，追加段含 fork owned turn。
- 文件级测试必须经过 `syncFile` 和 mock ingestion，不能只测纯 parser。
- 增加大文件恢复和 malformed boundary 负例。
- 保留既有普通 CLI/Desktop/subagent 测试作为兼容防线。

## 回滚

修改集中在 watcher 状态机和测试，无 schema 迁移。若出现正常 fork 完成漏报，可回滚本任务提交；连续 fork 协议与已有数据库数据不受影响。
