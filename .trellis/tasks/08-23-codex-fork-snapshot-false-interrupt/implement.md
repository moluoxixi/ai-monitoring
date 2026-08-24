# 修复 Codex fork 快照误报中断 - 实施计划

1. 在 watcher 文件状态中加入不可变 owner、fork 创建时间、fork 模式和 owned turn 集合，并提供统一的时间规范化与逐行状态迁移。
2. 调整 `session_meta` 处理：首个 meta 建立 owner，后续 foreign meta 不再覆盖 session/client/subagent。
3. 调整 fork 文件的 turn 状态：只让创建时间之后的 owned `task_started` 驱动摘要、答案、timing、provisional suppression 和 terminal ingestion。
4. 让 `syncFile` 与 `readContextBefore` 共享新的状态迁移，覆盖实时读取、初次 backfill 和大文件前缀恢复。
5. 在 `codex-session-watcher.spec.ts` 加入真实 fork 快照、父 completed/aborted 混合、fork 后续完成、大文件恢复和 malformed boundary 回归。
6. 运行定向 watcher 测试并检查失败是否暴露现有兼容契约；随后运行 server 全量测试、typecheck、build 和 `git diff --check`。
7. 使用 `trellis-check` 做规范、数据流、测试和未提交差异核验；通过后更新 backend quality spec，记录 fork snapshot owner/owned-turn 契约。

## 预期修改文件

- `apps/server/src/events/codex-session-watcher.service.ts`：修复文件身份与 turn 归属状态机。
- `apps/server/test/codex-session-watcher.spec.ts`：补真实 fork 快照和恢复路径回归。
- `.trellis/spec/server/backend/quality-guidelines.md`：质量门禁通过后沉淀 watcher 契约。

## 不修改

- 数据库 schema 和历史事件。
- `CodexAppServerReplyService`、dispatcher、RepliesService 和 OpenClaw 插件。
- Codex session 文件及正在运行的 Codex 进程。

## 验证命令

- `npm run test -w @ai-monitor/server -- codex-session-watcher.spec.ts`
- `npm run test -w @ai-monitor/server`
- `npm run typecheck -w @ai-monitor/server`
- `npm run build -w @ai-monitor/server`
- `git diff --check`

## 验证结果

- watcher 定向测试：36/36 通过。
- server 全量测试：26/26 文件通过，246 passed，1 skipped。
- server typecheck：通过。
- server build：通过。
- `git diff --check`：通过，仅有工作区既有 CRLF 转换提示。
- server package 未定义 lint script，因此未运行或声称 lint 通过。

## 风险与回滚点

- 最大风险是 fork boundary 判定过严导致合法 fork terminal 漏报；通过真实 shape、同批初读和大文件恢复测试覆盖。
- 若运行时字段与 fixture 不一致，先回滚 watcher 改动，保留测试/研究证据后重新设计，不放宽为可能误报的猜测路径。
