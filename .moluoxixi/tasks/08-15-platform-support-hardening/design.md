# 补齐六个平台监控支持 - Design

## Boundaries

本任务覆盖后端事件生产者、平台能力目录/扫描、前端平台状态展示、Python hooks、测试和文档。Linux 原生 Tauri/UI、第三方通知真实网络投递和 QoderWork 事件猜测均不在边界内。

现有 `/api/events` 和 `EventIngestionService` 继续作为唯一事件入口；不新增第二套事件协议。平台 canonical key 继续使用 `codex-desktop`、`claude-desktop`、`qoder-desktop`、`qoder-quest`、`hermes-desktop`、`cursor-cli`、`cursor-desktop` 等带 runtime 的值。

## Data Flow

```text
official hook / desktop audit / session DB / session JSONL
  -> adapter or watcher normalizes client + kind + status
  -> POST /api/events or EventIngestionService
  -> canonical-source validation + database event
  -> delivery worker and extension status projection
  -> UI capability card / notification outbox
```

每条终态事件必须携带稳定的 `source_event_id`、canonical `client`、`kind`、`status`；缺少 runtime、session id 或 turn id 时拒绝、忽略或保留为未归类输入，不能按默认 Desktop/CLI 猜测。

## Platform Design

### Qoder

- Quest 只对官方可证明的 session suffix/runtime 做归类；`Stop` 继续表示 completed，`PostToolUseFailure` 只能表示 tool_failed。未公开的整轮失败/中断不新增为支持能力。
- Desktop 只接受显式 desktop runtime 或可靠的 Windows 进程祖先识别；扫描器检查本项目 hook 配置而不是永久返回 false。QoderWork 进程祖先必须继续被排除。

### Claude Desktop

保留 `audit.jsonl` watcher 的隐私边界，只解析 user、assistant 和官方 result/错误字段。根据官方字段映射 completed/failed；如果 fixture/真实样本证明 audit 提供 interrupted 终态，再加入 interrupted，否则能力保持 false。工具回写和 synthetic user 记录继续忽略。

### Hermes Desktop

继续使用 `state.db` 的 TUI assistant 终态和 `request_dump_*.json`。扩展查询/解析只到官方字段能证明的 failed/interrupted；不可见的 headers/body/thinking/tool 内容不加入事件。CLI hook 与 Desktop watcher 的 client/source 继续分离。

### Cursor

保留显式 runtime 约束，避免共享 hook 无法区分 CLI/Desktop 时静默误归类。根据官方 hook 字段补齐可证明的失败/中断；若 payload 没有对应信号，能力和文档保持 false，而不是把 stop 或工具失败升级为整轮失败。

### Codex Desktop

继续复用 session JSONL parser/watcher，保持 session/turn 去重、subagent 抑制和错误脱敏。完成、错误终态、中断只从结构化 `event_msg` 获得；Desktop 私有 API 失败仍记录为能力边界。正式 App Server 客户端继续使用已有 proxy 协议。

## State Contract

平台能力字段必须与事件事实一致：`active` 表示代码存在，`monitorConfigured` 表示 hook/watcher 配置完整，`monitorVerified`（若现有 API 已提供）只在真实 producer 事件成功进入 relay 后为真。能力矩阵只标记有代码和测试证据的 `completed`、`failed`、`interrupted`、`toolFailed`、`tracing`。

QoderWork 不进入 canonical supported keys、设置可选项、事件白名单或“已验证”状态。UI 可在检测结果中显示“不支持/未接入”说明，但不得提供绑定和通知测试入口。

## Compatibility and Rollback

- 保持旧数据库事件和通知 outbox 格式不变；新增字段使用后端默认值和前端缺省值向后兼容。
- 对未识别或缺少 runtime 的 hook 输入继续丢弃/记录诊断，不回退到错误的平台。
- 若某个上游 payload 版本不稳定，关闭该终态映射即可回到现有较窄能力；不影响其它平台事件。
- 不修改 Linux 构建矩阵，不改变 Docker 容器运行方式。

## Validation Strategy

- Python adapter tests：正常终态、失败/工具失败/中断字段、runtime 隔离、QoderWork 排除、BOM/空输入。
- Server tests：Claude audit、Hermes DB/dump、Codex JSONL、scanner/configuration、event ingestion canonical source 和去重。
- Frontend tests：能力字段、未配置/未验证状态、QoderWork 不可选、平台卡片文案。
- 运行既有 `npm test`、`npm run typecheck`、`npm run build`、Python pytest、桌面 Rust 测试；真实客户端验证只在用户环境执行，不发送真实通知。
