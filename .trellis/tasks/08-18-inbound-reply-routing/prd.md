# QQ inbound reply routing

## Goal

让用户在 QQ 中引用回复 AI Monitor 发出的 Codex 任务完成通知，并将纯文本回复安全地续接到产生该通知的原 Codex 会话。

## Requirements

- R1. MVP 仅支持 `openclaw-qq` 渠道、Codex CLI 会话和纯文本引用回复；普通 QQ 消息、群消息、非 Codex 通知及其他渠道不得被认领。
- R2. 每条可回复通知必须携带不可猜测、持久化且对同一 delivery 稳定的路由令牌；令牌只关联 delivery/event，不在消息中暴露 thread id。
- R3. OpenClaw 插件必须使用普通 QQ 会话实际执行的 `before_dispatch` 在 agent 路由前识别引用消息，只从结构化 `replyToBody` 提取本项目令牌；不解析扁平化 prompt envelope，也不得要求腾讯 QQ 插件 2.0.1 未提供的 `replyToIsQuote=true`。
- R4. 入站接口使用独立 `AIMONITOR_REPLY_TOKEN`，允许回退到已配置的 `AIMONITOR_INGEST_TOKEN`；二者均缺失时必须拒绝请求。
- R5. 服务端必须验证消息确为引用回复、QQ sender/account 与原通知绑定一致、令牌有效且未过期、文本非空且不超过 4,000 字符。
- R6. `(channel, external_message_id)` 必须幂等；同一 QQ 消息重复投递不得创建第二个 Codex turn。
- R7. Codex 续接必须通过官方 App Server 协议，顺序执行 `initialize`、`initialized`、`thread/resume`、`turn/start`，并以原事件 `metadata.thread_id` 作为 thread id。
- R8. 远程续接 turn 使用 `approvalPolicy: never`，避免停在无人可操作的审批上；不绕过 Codex 自身的安全限制。
- R9. `turn/start` 被 Codex 接受后即可确认 QQ 回复已转交；后台进程继续存活到 turn 终态，之后由现有 watcher/notify 链路产生下一条完成通知。
- R10. 不支持的平台、过期/伪造令牌、身份不匹配、Codex 不可执行或协议失败必须返回明确错误，且不得静默转发到其他会话。
- R11. Docker 与桌面资源必须包含并启用 AI Monitor OpenClaw 回复插件；配置中的内部 Monitor 地址和 reply token 不得出现在通知正文或日志中。

## Acceptance Criteria

- [x] AC1. QQ 完成通知包含唯一回复标记，同一 delivery 重试时标记保持不变，其他渠道通知不包含该标记。
- [x] AC2. 引用该通知回复文本时，服务端解析到原 `client + thread_id` 并只创建一个 Codex turn。
- [x] AC3. 非引用消息、普通 QQ 对话、群消息、错误 sender/account、无效或过期令牌均不会被路由。
- [x] AC4. 入站 endpoint 在 reply/ingest token 均未配置时拒绝访问，错误 bearer token 也被拒绝。
- [x] AC5. 同一 external message id 重放得到幂等结果，不会二次调用 Codex。
- [x] AC6. Codex adapter 测试验证完整 JSON-RPC 顺序、原 thread id、文本 input 和 `approvalPolicy: never`。
- [x] AC7. OpenClaw 插件测试覆盖令牌提取、真实 QQ `before_dispatch` 事件形状、认领成功、失败回复、hook 注册契约和无关消息 pass-through。
- [x] AC8. 服务端测试、类型检查、构建、插件测试及 `git diff --check` 通过。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
