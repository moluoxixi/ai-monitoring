# Active writer 续接问题复盘

## 1. 根因分类

- **B：跨层契约**。首次 Desktop 回复会 fork 出 `thread_source: "cli"` 的新会话，但 watcher、delivery 和 dispatcher 没有共同保留“这个 CLI 来源会话仍可能被 Desktop 加载”的 writer 语义。
- **D：测试覆盖缺口**。原有测试分别覆盖 watcher 分类和 dispatcher 模式，却没有贯通真实 JSONL、数据库路由和 QQ 入站回复，因此无法捕获“分类正确但后续直接 resume”的组合缺陷。

## 2. 先前修复为何失效

1. 仅为最初的 `codex-desktop` delivery 使用 fork：覆盖了第一次引用，但 fork 的完成通知被归类为 `codex-cli` 后又回到 resume 路径，修复范围不完整。
2. 以 delivery 为 writer 归属建模：新通知会产生新的 delivery，但 Codex writer 实际按 thread ID 归属，delivery 边界不能证明 resume 安全。
3. 依据前一 turn 已完成推断 thread 空闲：Desktop 可以继续加载或重新取得同一 thread 的 writer，因此完成状态不是 writer release 契约。

## 3. 预防机制

| 优先级 | 机制 | 具体措施 | 状态 |
|---|---|---|---|
| P0 | 架构 | CLI/Desktop QQ 回复统一从最新分支头 fork，禁止直接 resume 源 thread | DONE |
| P0 | 持久化 | 用 compare-and-swap 推进 `reply_thread_id`，过期实例失败关闭 | DONE |
| P0 | 测试 | 增加 watcher -> SQLite route -> RepliesService -> dispatcher 的贯通回归 | DONE |
| P1 | 规范 | 在 backend quality spec 固化外部 writer 所有权契约和错误矩阵 | DONE |

## 4. 系统性扩展

- 其他支持外部客户端加载同一会话的平台，不能仅凭 client label 或完成通知判断 resume 安全。
- 本地通知 delivery 是投递实体，不是外部 runtime writer 的所有权边界；跨 delivery 串行属于后续增强，而非本次 active-writer 根因的必要条件。
- 外部 adapter 的 RPC 单测与 watcher parser 单测不能替代跨层投影测试；产生新身份或新 delivery 的流程必须覆盖最终用户入口。

## 5. 知识沉淀

- 已更新 `.trellis/spec/server/backend/quality-guidelines.md` 的 External Thread Writer Ownership 场景。
- 已在任务研究中记录 active-turn ephemeral fork 与 persistent fork 的独立协议探测证据。
