# QQ 引用续接 Codex Desktop 分支会话 - Implementation Plan

1. Extend the deliveries schema/types/projections with nullable `reply_thread_id`; allow completed Codex Desktop routes and add first-writer-wins persistence.
2. Extend the App Server adapter and dispatcher with the Desktop fork protocol while preserving the existing CLI resume protocol and process cleanup.
3. Make watcher/Python session identity honor structured `thread_source: "cli"` so fork completions are routed as Codex CLI.
4. Update RepliesService, route error text, README and task-facing tests for Desktop branch continuation.
5. Add regression coverage for schema migration, Desktop token eligibility, fork-first dispatch, persisted fork reuse, CLI compatibility, watcher classification and failure cleanup.
6. Run targeted server tests, Python tests, server lint/typecheck/build and `git diff --check`; then run the full workspace quality gate if dependencies are available.

## Validation commands

- `npm run test -w @ai-monitor/server -- database.service.spec.ts delivery-worker.service.spec.ts replies.service.spec.ts codex-app-server-reply.service.spec.ts codex-session-watcher.spec.ts`
- `python -m pytest tests/test_codex_session_identity.py`
- `npm run lint -w @ai-monitor/server` (if the package exposes lint)
- `npm run typecheck -w @ai-monitor/server`
- `npm run build -w @ai-monitor/server`
- `git diff --check`

## Rollback point

The feature is additive. Roll back the reply eligibility and dispatcher branch first if runtime validation reveals that persisted forks are classified incorrectly; retain the nullable database column for backward-compatible downgrade.
