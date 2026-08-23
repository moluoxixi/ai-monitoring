# QQ 引用续接 Codex Desktop 分支会话 - 实施计划

1. 扩展 deliveries schema、类型和投影，加入 nullable `reply_thread_id`；允许已完成的 Codex Desktop 通知生成路由，并提供 compare-and-swap 分支头推进。
2. 让 App Server 适配器和 dispatcher 对 Codex CLI/Desktop 统一使用持久 fork 协议，同时保持进程清理语义。
3. 让 watcher 和 Python session identity 优先识别结构化 `thread_source: "cli"`，确保 fork 完成事件按 Codex CLI 路由。
4. 更新 RepliesService、路由错误文本、README 和任务相关测试，支持 Desktop 分支续接。
5. 补充分支 schema 迁移、Desktop token 资格、fork-first 分发、连续分支头推进、CLI 兼容、watcher 分类和失败清理回归测试。
6. 以 compare-and-swap 推进 delivery 的分支头，并覆盖 CLI 来源 Desktop fork 通知再次 fork 的跨层回归场景。
7. 更新 QQ 同步确认语和 README，明确后台处理已开始且完整结果会在稍后另发。
8. 运行 server 定向/全量测试、Python 测试、typecheck、build、插件测试和 `git diff --check`，依赖可用时再运行 workspace 全量质量门禁。

## 验证命令

- `npm run test -w @ai-monitor/server -- database.service.spec.ts delivery-worker.service.spec.ts replies.service.spec.ts codex-app-server-reply.service.spec.ts codex-session-watcher.spec.ts`
- `python -m pytest tests/test_codex_session_identity.py`
- `npm run lint -w @ai-monitor/server`（仅当 package 提供 lint 脚本）
- `npm run typecheck -w @ai-monitor/server`
- `npm run build -w @ai-monitor/server`
- `git diff --check`

## 回滚点

本功能为增量变更。如果运行时验证发现持久 fork 分类错误，先回滚 Desktop 路由资格和 dispatcher 分支；保留 nullable 数据库列以支持向后兼容降级。
