# Claude Desktop event classification and deduplication - Design

## Boundaries

来源判定发生在事件生产边界。Python hook 读取其明确的 transcript 文件，只接受 JSONL 顶层 `entrypoint == "claude-desktop-3p"`；server 不从消息正文或路径反推运行时。

数据库继续以 `events.source_event_id UNIQUE` 作为跨 HTTP hook 与 watcher 队列的最终竞态屏障，不增加基于时间窗或正文 hash 的语义查询。既有事件表和投递表不迁移。

## Canonical Terminal Identity

Desktop completed terminal 的 producer ID 使用以下稳定格式：

```text
claude-desktop:assistant:<message-id-or-uuid>:completed
```

该 ID 故意不包含 session ID。真实样本证明 Claude Desktop 分支复制会保留 assistant `message.id`、UUID 与 timestamp，只重写顶层 session ID；包含 session ID 会让复制历史绕过去重。

server 导出统一的 scoped ID helper：

```text
v1:<encoded-source>:<encoded-client>:<producer-id>
```

HTTP hook 保持提交 producer `event_id`，由 `normalizeEvent` scope；watcher 调用同一 helper 构造最终 `source_event_id`。两路因此逐字相同，SQLite 负责原子合并。后到事件继续复用现有 `DatabaseService.insertEvent` 的 enrichment 逻辑补齐 `task_summary` / `answer_text`。

assistant `message.id` 优先，缺失时使用 assistant record UUID。timestamp 只用于历史判断，不作为常规 canonical ID，避免精度或格式变化引入碰撞。没有稳定 terminal ID 的 Desktop completed hook 不上报，由 transcript watcher 兜底。CLI 保留现有随机 hook ID fallback。

Desktop `PostToolUseFailure` 没有 watcher 对偶，继续使用 hook 自身 ID 并标为 desktop diagnostic。`StopFailure` 只有能从 transcript 当前结构明确定位同一 `api_error.uuid` 时才共享失败 canonical ID；本次不使用“最后一个错误”猜关联，没有稳定映射时由 watcher 的 `api_error` 事件负责。

## Transcript State And Replay Protection

watcher 增加生命周期级 terminal identity set。它只保存结构化 ID，不保存 prompt 或 answer。

启动流程：

1. 枚举启动时已存在的 JSONL。
2. 只对具有 Desktop entrypoint、非 sidechain 的 terminal 记录提取稳定身份并播种 set。
3. 枚举时记录文件 byte-size watermark；`add` 时只解析 watermark 内最后一个完整换行之前的历史并播种 identity，不 ingest。
4. watermark 后追加的字节作为 live 输入；watermark 若截在半条 JSONL 中，offset 保留在上一完整换行，待该行补齐后完整解析。

运行中新文件首次发现时记录 `birthtimeMs`；birthtime 不可用时退化为 watcher 首次发现时间。文件仍从 offset 0 解析，不能整文件静默，因为正常短会话可能在第一次 add 时已经包含 prompt 与 terminal。

每个 parsed terminal 在 ingest 前执行：

1. 若 canonical identity 已在 set，视为复制/rewrite，跳过。
2. 若记录 timestamp 可解析且严格早于文件 birth watermark，视为复制历史，跳过，即使原始文件已被删除。
3. 其余终态先加入 set，再 ingest。

被跳过的 identity 也加入 set。单线程 watcher queue 保证 set 的检查与写入顺序；SQLite UNIQUE 解决 hook 与 watcher 的跨进程竞态。文件 truncate 后 parser state 重置，但全局 set 不清空。等长或增长 rewrite 通过已消费前缀的 SHA-256 digest 变化检测，不能只依赖文件变短。

失败终态使用独立 identity namespace，避免 completed 与 failed 相互吞并。非 Desktop entrypoint 和 sidechain 不播种 identity，也不 ingest。

## Hook Transcript Projection

Python adapter 将当前只返回 summary/answer 的 transcript 读取结果扩展为内部结构，至少包含：

- `desktop_transcript`
- 最后一个可见 `end_turn` assistant 的 answer
- 该 terminal 的 `message.id` 或 record UUID
- 可证明匹配时的 error identity

重试条件对 Desktop Stop 同时要求稳定 terminal ID；不能只等到文本出现。结构扫描继续忽略 synthetic/tool-result user，且只从已知 message content 容器读取可见文本。

## Compatibility And Rollback

- 普通 Claude CLI 的 source/client、随机 fallback 与事件字段保持不变。
- watcher 的通知内容、metadata session ID/turn ID 以及 provisional failure suppression 保持现有接口。
- canonical ID 变化不会重写旧事件；部署前的重复记录原样保留。
- 回滚只需恢复 adapter、normalizer、watcher及对应测试；无 schema/data migration 回滚。

## Risks

- 若 Claude 未来将同一 `message.id` 用于真正独立的新生成，跨 session canonical ID 会过度去重。现有样本中跨文件重复同时保留 message ID、UUID、timestamp，支持其为稳定响应身份；回归测试固定该假设。
- Windows 复制时 birthtime 行为可能变化，因此 birthtime 只是第二证据；稳定 identity set 和数据库 canonical ID 是主路径。
- hook stdin 没有可靠 runtime 字段；任何新字段在有真实样本和测试前都不能替代 transcript entrypoint。
