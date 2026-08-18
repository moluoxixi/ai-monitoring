# 补齐六个平台监控支持 - Implementation Plan

1. [x] 建立当前平台能力矩阵和事件字段基线，定位现有测试/fixture，确认 QoderWork 已从 canonical 支持集合排除。
2. [x] 修正 Qoder hook/runtime 归类与 scanner 配置检测；补 Quest/Desktop 的失败边界和 QoderWork 回归测试。
3. [x] 完善 Claude Desktop audit parser/watcher 的官方终态映射和隐私边界测试。
4. [x] 完善 Hermes Desktop `state.db`/request dump 的失败、中断和去重解析；补 fixture 测试。
5. [x] 复核 Cursor CLI/Desktop hook 的 runtime 校验与可证明终态映射；保留缺少 runtime 时拒绝输入的能力声明和 Python 测试。
6. [x] 复核 Codex Desktop JSONL parser 的完成、失败、中断、错误脱敏和 App Server 边界；同步能力矩阵。
7. [x] 统一 `extensions.service.ts`、scanner、event ingestion、前端卡片和文档中的能力声明；QoderWork 只保留未接入说明。
8. [x] 使用现有 fixture 重放/单元测试作为可重复的无外发冒烟验证，不连接真实通知通道；README 保留真实客户端验收前提。
9. [x] 运行 backend/frontend/Python/Rust 全量质量门禁，执行 `git diff --check`，修复回归。
10. [x] 复核 PRD acceptance criteria、跨层字段流转和 Linux 非目标，准备任务完成检查。

## Validation Commands

- `npm test`
- `npm run typecheck`
- `npm run build`
- `.venv\\Scripts\\python.exe -m pytest -q`
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
- `git diff --check`

## Risk and Rollback

- 上游字段不稳定时，保留旧终态映射并将新增能力标为 false。
- watcher 查询错误按平台隔离并记录 warn，不阻塞事件 API。
- 不修改数据库 schema；回滚仅需恢复相应 parser/能力矩阵和文档变更。
