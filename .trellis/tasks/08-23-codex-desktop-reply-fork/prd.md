# QQ 引用续接 Codex Desktop 分支会话

## Goal

让 QQ 引用回复能够安全续接已经完成的 Codex Desktop 通知，同时保留 Desktop 原会话和 writer 不变；首次回复创建一个持久化 Codex 分支，后续回复继续写入该分支。

## Background and confirmed constraints

- Codex Desktop 的原 thread 由 Desktop App Server 持有 writer，即使最后一个 turn 已完成，第三方 `thread/resume` 仍会返回 `already has an active writer`。
- 当前 Desktop App Server 通过 stdio 启动，公开 App Server 协议没有按 thread 的 writer release/transfer/steal 方法；终止进程会影响所有打开的 Desktop 会话。
- 公开 App Server 协议支持不恢复 writer 的 `thread/read` 和复制历史的 `thread/fork`。一次 `ephemeral` fork 探测已证明原 Desktop writer 不受影响。
- 现有 QQ 回复链路只允许 `codex-cli`，路由 token、QQ 身份校验、入站幂等和通知 watcher 已经存在。

## Requirements

- R1. `openclaw-qq` 的 Codex Desktop completed delivery 必须生成稳定回复路由 token；其他渠道、非 completed 事件和无 `metadata.thread_id` 的事件不得生成 token。
- R2. 首次引用 Codex Desktop 通知时，服务端必须通过 App Server `initialize → initialized → thread/fork → turn/start`，从原 thread 创建持久化分支并将 QQ 文本作为新 turn 输入；不得调用原 Desktop thread 的 `thread/resume` 或终止 Desktop 进程。
- R3. 分支必须携带可识别的 CLI thread source，使现有 Codex watcher 将分支完成事件归类为 `codex-cli`，从而后续通知可以继续使用普通 CLI 路由。
- R4. 首次分支创建成功后必须持久化分支 thread id；同一原 delivery 的后续引用必须直接 `thread/resume` 该分支，不得重复创建分支。
- R5. 现有 `codex-cli` 引用回复行为保持不变：`initialize → initialized → thread/resume → turn/start`，`approvalPolicy: never`、外部消息幂等和后台完成等待保持不变。
- R6. Desktop 分支创建失败时，原 Desktop thread 和已完成通知保持不变；QQ 入站返回明确错误，不能静默落入 OpenClaw agent，也不能把原 thread 当作可续接目标。
- R7. 路由 token、任务 ID 回退、QQ sender/account 绑定、过期校验和入站幂等语义保持现有安全边界。
- R8. Claude Desktop、Codex Desktop 原 thread 写回、UI 自动化和强制终止 Desktop App Server 不在本次范围内。

## Acceptance Criteria

- [ ] AC1. Codex Desktop completed QQ delivery 具有稳定 token；Codex CLI 行为与 token 生成回归保持通过。
- [ ] AC2. 首次 Desktop 引用只发送一次 `thread/fork` 和一次 `turn/start`，fork 参数为持久化分支且显式标记 CLI source；原 thread 不执行 `thread/resume`。
- [ ] AC3. Desktop 分支的完成事件被 watcher 归类为 `codex-cli`，并能产生下一条可回复通知。
- [ ] AC4. 同一 delivery 的第二次合法引用使用持久化 fork thread id 执行 `thread/resume`，不再次 fork。
- [ ] AC5. Desktop fork 失败会清理子进程、记录失败幂等状态并返回明确服务错误；原路由仍可重复尝试而不破坏原会话。
- [ ] AC6. 现有 QQ token/task-id 回退、sender/account 校验、外部 message id 幂等和非支持平台拒绝测试继续通过。
- [ ] AC7. server 定向测试、lint、typecheck、build、Python adapter/identity 测试以及 `git diff --check` 通过。
