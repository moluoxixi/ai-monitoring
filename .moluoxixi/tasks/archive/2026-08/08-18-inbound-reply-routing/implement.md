# QQ inbound reply routing - Implementation Plan

1. 扩展 SQLite schema/types，加入 delivery reply route 与 inbound reply 幂等记录，并补迁移和查询测试。
2. 在所有 delivery 正文开头追加任务 ID；QQ delivery 发送前生成稳定 route token，且仅对可续接通知追加引用标记。
3. 新增 reply DTO/controller/service，落实 fail-closed bearer、quote/token/expiry/QQ binding/text 校验和幂等状态机。
4. 新增平台 dispatcher 和 Codex App Server adapter，封装 JSON-RPC 生命周期、超时、后台终态等待和进程清理。
5. 创建项目内 OpenClaw `before_dispatch` 插件及独立 Node 测试，接入 Docker 与桌面运行时安装/环境配置；测试必须模拟腾讯 QQ 2.0.1 的真实结构化引用字段和 OpenClaw 短路返回契约。
6. 更新环境示例和 README，说明令牌、引用回复用法、有效期、安全与仅 Codex CLI 的 MVP 边界。
7. 运行定向测试，再运行 server test/typecheck/build、插件测试和 `git diff --check`；检查与现有并发 delivery 改动的兼容性。

## Follow-up notification context correction

- App Server 续接的用户输入以 `response_item/message(role=user)` 写入 session JSONL，watcher 必须读取其中的 `input_text` 作为下一轮 `task_summary`。
- 新一轮用户输入同时清空上一轮回答与开始时间状态，防止完成通知出现空提问或串用旧上下文。

## Task ID quote fallback correction

- QQ 引用预览可能只保留通知开头的任务 ID；回复插件同时识别 route token 和任务 ID，匹配任一项即短路默认 OpenClaw agent。
- 服务端只允许任务 ID 回退到已存在有效 route 的 Codex CLI QQ delivery，并继续执行有效期、投递状态、QQ binding 和幂等校验；其它任务返回明确限制。

## Runtime activation correction

- 根因：插件缺少 `activation.onCapabilities: ["hook"]`，所以 `plugins inspect --runtime` 能手工导入并看到 `before_dispatch`，但 Gateway startup plan 不会选择该 hook-only 插件。
- 修复：插件 `1.0.3` 增加 startup capability，安装脚本同时校验 manifest capability 与 runtime hook，并让桌面 bootstrap 版本指纹触发重装。
- Live 证据：2026-08-18 15:24 Gateway 重启后，启动日志的 11 个插件中包含 `ai-monitor-replies`，QQ WebSocket 随后进入 READY。

## Rollback

- 停止配置/加载 inbound plugin 即可关闭 QQ 回复入口，不影响现有出站通知。
- 删除 `AIMONITOR_REPLY_TOKEN` 会让入站 endpoint fail closed。
- additive SQLite 列和表可以保留；旧代码会忽略它们，无需破坏性降级。
