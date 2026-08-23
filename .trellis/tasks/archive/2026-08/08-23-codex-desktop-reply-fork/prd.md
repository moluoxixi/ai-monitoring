# QQ 引用续接 Codex Desktop 分支会话

## Goal

让 QQ 引用回复能够安全续接 Codex CLI/Desktop 完成通知，同时不争抢任何可能被 Desktop 或其他客户端持有的 thread writer；每条回复从最新会话头创建持久分支并推进分支头。

## Background and confirmed constraints

- Codex Desktop 的原 thread 由 Desktop App Server 持有 writer，即使最后一个 turn 已完成，第三方 `thread/resume` 仍会返回 `already has an active writer`。
- 当前 Desktop App Server 通过 stdio 启动，公开 App Server 协议没有按 thread 的 writer release/transfer/steal 方法；终止进程会影响所有打开的 Desktop 会话。
- 公开 App Server 协议支持不恢复 writer 的 `thread/read` 和复制历史的 `thread/fork`。一次 `ephemeral` fork 探测已证明原 Desktop writer 不受影响。
- 运行时回归证明，首次 Desktop fork 生成的 `thread_source: "cli"` 会话可被 Desktop 再次加载；它的后续完成通知会作为 `codex-cli` 创建新的 delivery，旧实现因直接 `thread/resume` 而触发 `already has an active writer`。
- 实时协议探测证明，源 Desktop thread 正有 active turn/writer 时，独立 App Server 的 `thread/fork` 仍能成功创建隔离分支。
- 现有 QQ 回复链路只允许 `codex-cli`，路由 token、QQ 身份校验、入站幂等和通知 watcher 已经存在。

## Requirements

- R1. `openclaw-qq` 的 Codex Desktop completed delivery 必须生成稳定回复路由 token；其他渠道、非 completed 事件和无 `metadata.thread_id` 的事件不得生成 token。
- R2. 每次引用 Codex CLI/Desktop 通知时，服务端必须通过 App Server `initialize → initialized → thread/fork → turn/start`，从该 delivery 的最新 thread 创建持久化分支并将 QQ 文本作为新 turn 输入；不得对源 thread 调用 `thread/resume` 或终止 Desktop 进程。
- R3. 分支必须携带可识别的 CLI thread source，使现有 Codex watcher 将分支完成事件归类为 `codex-cli`，从而后续通知可以继续使用普通 CLI 路由。
- R4. 每次分支创建成功后必须以 compare-and-swap 推进该 delivery 的 `reply_thread_id`；同一 delivery 的后续引用必须等待前一 writer 释放，再从最新分支继续 fork。
- R5. Codex CLI 引用回复也必须使用连续 fork，不再写回可能被其他客户端持有的原 CLI thread；`approvalPolicy: never`、外部消息幂等和后台完成等待保持不变。
- R6. Desktop 分支创建失败时，原 Desktop thread 和已完成通知保持不变；QQ 入站返回明确错误，不能静默落入 OpenClaw agent，也不能把原 thread 当作可续接目标。
- R7. 路由 token、任务 ID 回退、QQ sender/account 绑定、过期校验和入站幂等语义保持现有安全边界。
- R8. Claude Desktop、Codex Desktop 原 thread 写回、UI 自动化和强制终止 Desktop App Server 不在本次范围内。
- R9. QQ 同步确认语必须明确表示后台处理已经开始、完整回答稍后另发，不得声称写入“原 Codex 会话”。

## Acceptance Criteria

- [x] AC1. Codex Desktop completed QQ delivery 具有稳定 token；Codex CLI 行为与 token 生成回归保持通过。
- [x] AC2. CLI/Desktop 的每次引用只发送一次 `thread/fork` 和一次 `turn/start`，fork 参数为持久化分支且显式标记 CLI source；源 thread 不执行 `thread/resume`。
- [x] AC3. Desktop 分支的完成事件被 watcher 归类为 `codex-cli`，并能产生下一条可回复通知。
- [x] AC4. 同一 delivery 的第二次合法引用等待前一 writer 完成，从持久化 fork thread id 再次 fork，并原子保存新的分支头。
- [x] AC5. Desktop fork 失败会清理子进程、记录失败幂等状态并返回明确服务错误；原路由仍可重复尝试而不破坏原会话。
- [x] AC6. 现有 QQ token/task-id 回退、sender/account 校验、外部 message id 幂等和非支持平台拒绝测试继续通过。
- [x] AC7. server 定向测试、typecheck、build、Python adapter/identity 测试以及 `git diff --check` 通过；server package 当前未提供 lint script。
- [x] AC8. QQ 同步确认语明确提示后台处理和稍后另发结果；CLI 来源的 Desktop 分支通知不会再因直接 resume 而触发 active-writer 错误。
