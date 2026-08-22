# Implementation Plan

## Implementation

- [x] 1. 在 `event-normalizer.ts` 导出 scoped source event ID helper，并补充 helper/normalizer 单测，保证现有 ID 格式不变。
- [x] 2. 重构 `claude_event_adapter.py` 的 transcript projection，提取精确 Desktop entrypoint、稳定 completed terminal ID 和所需结构状态。
- [x] 3. 让 Desktop hook 使用正确 source/client 和 canonical producer ID；没有稳定 completed/failure ID 时静默交给 watcher；保持 CLI 随机 fallback 与 Desktop tool diagnostic。
- [x] 4. 在 Claude Desktop watcher 中使用同一 canonical scoped ID，并增加终态 identity 提取，不改变现有正文隐私过滤。
- [x] 5. 启动扫描已有 Desktop terminal identity；为新文件记录 birth watermark，并在 ingest 前过滤已见 identity 与创建前历史 terminal。
- [x] 6. 补充 Python adapter 测试：Desktop/CLI 分类、marker 仅顶层生效、canonical completed、无稳定 ID、CLI random fallback、tool diagnostic。
- [x] 7. 补充 watcher 测试：启动播种、新文件旧+新混合、旧源缺失 timestamp fallback、正常首轮、跨 session/重复 change/truncate 去重，以及启动枚举竞态与半行边界。
- [x] 8. 补充跨入口幂等测试：hook/watcher 两种到达顺序、单 event/单 delivery、后到 enrichment。

## Validation

```powershell
uv run --no-project --with "pytest>=8,<9" --with "python-dotenv>=1,<2" python -m pytest tests/test_claude_event_adapter.py
$env:CHOKIDAR_USEPOLLING='1'; npm run test -w @ai-monitor/server -- claude-desktop-audit-watcher.spec.ts event-normalizer.spec.ts database.service.spec.ts
npm run typecheck
npm test
npm run build
git diff --check
```

仓库当前未配置 lint script；不以虚构命令替代 lint 验证。

最后运行仓库现有全量测试入口（以根 `package.json` scripts 为准），确认 Claude CLI 与其它平台 watcher 未回归。

## Risk And Rollback Points

- 修改 canonical ID 前先保留现有 `v1` scoped 格式测试；任何格式漂移都会改变全局幂等语义。
- transcript parser 变更后先运行纯 parser 测试，再运行 watcher 文件系统测试，便于区分内容解析与监听时序问题。
- birth watermark 必须使用 birth/creation time 或首次观察时间，禁止使用会随 append 改变的 mtime。
- 不修改数据库 schema，不删除既有事件；回滚不需要数据恢复。

## Review Gates

- [x] PRD 所有 AC 均有对应测试或明确的只读验证。
- [x] 不以正文、answer hash、相似度或固定时间窗去重。
- [x] Desktop 与 CLI source/client 只由结构化 evidence 决定。
- [x] 没有稳定 ID 的 Desktop terminal 不生成随机重复事件。
- [x] 新文件首个真实完成未被首次扫描逻辑吞掉。
