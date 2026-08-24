# 修复 Codex Desktop 客户端归属判断 - 实施计划

1. 修改 TypeScript `sessionIdentity()` 优先级：subagent -> Desktop runtime -> CLI runtime -> `thread_source=cli` fallback。
2. 修改 Python `session_kind()` 使用相同优先级。
3. 更新 TypeScript parser 与跨层 watcher/reply 测试，断言 Desktop 标签恢复但 dispatcher 仍 fork。
4. 更新 Python identity 测试，并补 multiplexer 使用真实 session 文件的所有权测试。
5. 运行定向 TypeScript/Python 测试、server/Python 全量测试、typecheck、build 和 `git diff --check`。
6. 使用 `trellis-check` 与独立只读审查核验字段语义、双实现一致性和回复路由未回归。
7. 重启受 supervisor 管理的服务，用测试通知或后续真实 Desktop fork 验证新事件分类。

## 预期修改文件

- `apps/server/src/events/codex-session-watcher.service.ts`
- `apps/server/test/codex-session-watcher.spec.ts`
- `apps/server/test/event-ingestion.service.spec.ts`
- `scripts/codex_session_identity.py`
- `tests/test_codex_session_identity.py`
- `tests/test_codex_notify_multiplexer.py`
- `tests/test_codex_app_server_proxy.py`
- `.trellis/spec/server/backend/quality-guidelines.md`

## 不修改

- 数据库 schema 与历史事件。
- reply dispatcher 的统一 fork 策略。
- fork owner/owned-turn 状态机。

## 验证命令

- `npm run test -w @ai-monitor/server -- codex-session-watcher.spec.ts`
- `.\.venv\Scripts\python.exe -m pytest tests/test_codex_session_identity.py tests/test_codex_notify_multiplexer.py`
- `npm run test -w @ai-monitor/server`
- `.\.venv\Scripts\python.exe -m pytest`
- `npm run typecheck -w @ai-monitor/server`
- `npm run build -w @ai-monitor/server`
- `git diff --check`

## 验证结果

- TypeScript 定向测试：watcher + ingestion 53/53 通过。
- Python 定向测试：identity + multiplexer + App Server proxy 26/26 通过。
- server 全量测试：27/27 文件通过，263 passed / 1 skipped。
- Python 全量测试：81/81 通过。
- server typecheck、build、`git diff --check`：通过；package 未定义 lint script。
- 独立审查发现并补齐：有效 unknown identity 的双实现所有权、空 `source.subagent={}`、解析后 `CODEX_HOME` 缓存键、Desktop 可见性与 App Server proxy 真实 rollout 覆盖。
- 编译后的 `parseCodexSessionLine()` 对 `vscode + Codex Desktop + thread_source=cli` 返回 `codex-desktop`。
- Python `session_kind()` 对真实 thread `01a0315b-6e85-77c1-951d-30a3e97887ef` 返回 `codex-desktop`。
- supervisor 已将服务从 PID `19248` 重启为 PID `24076`，父 PID 保持 `22756`，`/api/health` 返回 `ok=true`。
