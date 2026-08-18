# 补齐六个平台监控支持

## Goal

把 Qoder Quest、Qoder Desktop、Claude Desktop、Hermes Desktop、Cursor CLI/Desktop、Codex Desktop 的监控支持从“有适配器/有界面条目”提升为可验证、能力声明准确的端到端支持。平台只有在真实事件链路可安装并通过冒烟验证后，才显示为已验证。

## Requirements

- 保留 QoderWork 为不支持状态：不采集其私有日志、不通过进程猜测任务结果，不在支持平台列表中宣称已接入。
- Qoder Quest：正确识别 Quest session runtime，接收并归类已验证的完成事件；对未公开的失败终态保持未支持/未验证，不伪造失败结果。
- Qoder Desktop：独立于 CLI 和 Quest 归类；扫描器能准确报告 hook/监控配置状态，不能把未配置显示为已验证。
- Claude Desktop：独立读取 Desktop audit 数据，保留 CLI/Desktop 隔离；对完成、失败和可从官方数据证明的工具错误进行准确归类。
- Hermes Desktop：从官方 Desktop 状态数据和 request dump 归类完成、失败及可证明的错误；不把不可见的 headers、thinking 或工具内容标记为已采集。
- Cursor CLI/Desktop：根据显式 runtime 隔离两个平台，补齐官方 hook 能证明的完成、工具失败以及整轮/API 失败或中断；缺少 runtime 的事件必须拒绝或进入未归类路径。
- Codex Desktop：继续使用结构化 session JSONL，准确归类完成、中断和错误终态；明确记录无法从 Desktop 私有实现获得的 API 失败边界，并支持正式 App Server 客户端的可靠错误事件。
- 平台能力定义、扫描状态、事件归类、前端展示和通知投递使用同一套能力事实，不能出现“适配器 active 但 UI 显示完整支持”的矛盾。
- 为每个平台增加或完善 fixture/单元测试，并为事件链路增加可重复的本地冒烟验证；测试必须覆盖正常终态、失败/工具失败/中断边界、runtime 隔离和未配置状态。
- Linux 原生桌面构建和 Linux UI 不在本任务范围内；Docker/Linux 容器运行保持现状。

## Acceptance Criteria

- [x] Qoder Quest、Qoder Desktop、Claude Desktop、Hermes Desktop、Cursor CLI/Desktop、Codex Desktop 的平台卡片状态与后端真实扫描/配置状态一致。
- [x] QoderWork 在扫描、事件归类、设置和文档中均不被当作已支持平台。
- [x] 每个平台的能力字段只标记代码和测试实际证明的能力；不支持的能力在 UI/API 中明确为 false 或受限。
- [x] 事件从 hook/watcher/proxy 进入 `/api/events` 后，client/runtime/source_event_id 归类正确，且不会跨平台重复投递。
- [x] 失败、中断、工具失败和完成事件的测试通过；未公开 schema 或缺少 runtime 的输入不会生成错误的完整支持结论。
- [x] 运行项目既有 typecheck、单元测试和桌面 Rust 测试通过；现有 fixture 测试可在无真实客户端时重复验证事件链路，真实客户端验证前提保留在 README 边界说明中。
- [x] README、平台能力说明和 UI 文案与实现一致，明确 QoderWork 未支持和各桌面平台的能力边界。

## Out Of Scope

- Linux 原生 Tauri/桌面 UI、Linux 桌面打包和发布矩阵。
- 逆向 QoderWork、Claude Desktop、Hermes Desktop、Cursor Desktop 或 Codex Desktop 私有协议以猜测未公开事件。
- 对第三方通知服务做 CI 中的真实网络投递；通知渠道只需保持现有 Apprise/OpenClaw 边界准确。

## Notes

- 已确认的现状证据：平台注册与能力字段位于 `apps/server/src/extensions/extensions.service.ts:6-106`；Qoder Desktop/Quest 配置扫描目前在 `apps/server/src/extensions/platform-scanner.service.ts:345-360` 直接返回 false；桌面 watcher 注册位于 `apps/server/src/events/events.module.ts:6-19`；文档边界位于 `README.md:184-198`。
- 当前任务目标是硬化真实支持和能力声明，不扩大到 Linux，也不把 QoderWork 作为实现目标。

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
