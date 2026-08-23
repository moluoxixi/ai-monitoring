# QQ 引用续接 Codex Desktop 分支会话 - 技术设计

## 架构

现有入站回复流程继续作为唯一入口。回复路由仍指向被引用通知的 delivery，nullable `reply_thread_id` 则作为该 delivery 持久分支链的 compare-and-swap 最新头。

```text
QQ 引用回复
  -> RepliesService 校验 token/任务 ID、QQ 绑定和幂等
  -> PlatformReplyDispatcher 选择 metadata.thread_id 或已持久化的分支头
  -> Codex App Server 子进程
       CLI/Desktop: initialize -> initialized -> thread/fork -> turn/start
  -> 原子推进 delivery 的分支头
  -> 现有 session watcher 发送下一条完成通知
```

Monitor 不 resume 任何源 thread。每次 fork 都持久化到同一 Codex session store，其活动 turn 仅由 Monitor 启动的 App Server 连接持有。后续回复等待前一个 writer 释放，再从已保存的最新头继续 fork。

## 路由与持久化契约

- `deliveries.reply_thread_id TEXT NULL` 是增量字段，在 Codex CLI/Desktop fork 成功后保存最新分支头。
- `ReplyRoute.reply_thread_id` 同时由 token 和任务 ID 路由投影返回。
- `ensureDeliveryReplyRoute` 接受带有非空 thread id 的 `codex-cli`、`codex-desktop` completed 事件，并继续限定为 `openclaw-qq`。
- `advanceReplyThreadId(deliveryId, expectedThreadId, nextThreadId)` 使用 compare-and-swap：首次从 null 创建分支头，之后仅在当前值仍等于调用方观察值时推进。
- 每次 CLI/Desktop 请求都从 `reply_thread_id ?? metadata.thread_id` fork；事件 metadata 作为不可变的分支来源保留。

## App Server 协议

`CodexAppServerReplyService.dispatch` 接收路由 client 和可选持久化目标。

- CLI 和 Desktop 路由统一调用 `thread/fork`，参数为 `ephemeral: false`、`threadSource: "cli"`，然后以返回的 fork id 调用 `turn/start`。
- 没有 `reply_thread_id` 时从事件 metadata fork；已有分支头时从该分支头继续 fork。
- 所有 turn 使用 `approvalPolicy: "never"`；不接入 Desktop 私有 stdio，不终止进程，也不绕过 writer。
- 适配器返回实际目标 thread id 和 turn id；调用方仅在 `turn/start` 被接受后推进分支头。

## 运行时分类

Codex fork 的 session metadata 可能保留 Desktop 的 `source`/`originator`。因此 watcher 和 Python session identity helper 必须让显式 `thread_source: "cli"` 优先于 Desktop 标记。该判断只信任结构化 session metadata，不使用消息文本或文件路径推断来源。

## 失败与恢复

- fork 失败时不推进 `reply_thread_id`；原分支头保持不变，用户可以使用新的 QQ message id 重试。
- 现有 `(channel, external_message_id)` 幂等检查仍是第一道关口；已接受的重复 QQ 消息不会再次分发。
- 单进程内同一 delivery 的并发回复通过 writer release 串行。跨 Monitor 进程时，compare-and-swap 会检测过期分支头并失败关闭；当前 MVP 不承诺为不同 QQ message id 提供跨进程 lease。
- fork 产生的完成通知按 CLI 分类，正常生成下一条路由；再次回复时从该通知对应的 thread 继续 fork。

## 兼容与回滚

- 路由 schema 保持向后兼容；现有 null 或已持久化分支头都能作为下一次 fork 的基线。CLI 回复有意停止写回源 thread。
- 从 `ensureDeliveryReplyRoute` 移除 Desktop 资格即可禁用新的 Desktop 路由，无需删除已有 fork id。
- 本次不改变 Claude Desktop 或 UI 自动化行为。
