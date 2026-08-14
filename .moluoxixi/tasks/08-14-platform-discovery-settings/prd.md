# 可配置通知长度与平台扫描展示

## Goal

让用户可以在线配置通知中提问与结果的最大长度，并让扩展页依据本机检测结果和用户显示偏好展示 AI 平台，同时保留全部已支持平台作为可靠回退。

## Requirements

- R1. 提问长度默认 100 个 Unicode 字符，结果/失败消息默认 2,000 个字符；用户可通过界面修改，后续投递立即生效。
- R2. 长度配置持久化到 `data` 下的专用版本化 JSON，使用严格校验、受限权限和原子替换；不得与通知凭据文件混用。
- R3. 提问上限范围为 1..2,000，结果上限为 1..24,000；上游采集不得在更小固定值处提前截断。
- R4. 服务启动时扫描当前运行环境中已安装、可执行、运行中及已配置监控的平台，并缓存扫描时间。
- R5. 支持用户手动重新扫描；扫描失败时仍返回全部受支持平台，不影响事件分类或历史数据。
- R6. 平台目录至少包含 Codex、Claude、Qoder、Hermes、Cursor，并能继续增加新适配器。
- R7. 用户可以持久化选择要展示的平台；显示偏好只影响界面，不影响事件采集、数据库归类和通知投递。
- R8. 扫描结果必须区分 `detected`、`cliAvailable`、`running`、`monitorConfigured`，不得把配置残留或别名误报为已接入。
- R9. Docker 内无法观察宿主进程时必须明确降级为“支持平台目录 + 用户显示偏好”，不得把容器扫描结果冒充宿主扫描。
- R10. 扩展页提供重新扫描、检测平台/全部支持平台切换、平台显示管理和通知长度设置，保持简洁及移动端可用。
- R11. `monitorConfigured` 只表示本项目适配器配置完整；新增 `monitorVerified` 表示平台产生的真实事件已成功进入本地 relay。界面不得把安装目录或任意第三方 hook 标为真实可用。
- R12. Codex CLI/Desktop、Claude CLI/Desktop、Qoder CLI/Desktop、Hermes CLI/Desktop 和 Cursor 的可用性必须逐项验证；缺失的软件允许安装，认证必须由用户完成。
- R13. 新平台适配器必须覆盖公开可获得的完成与错误终态；官方未提供稳定错误事件时必须明确显示能力缺失，不得伪造“失败可监测”。
- R14. 真实验证默认使用隔离数据库或无通知通道，不能因验收任务向 QQ/微信等已绑定通道发送测试消息。

## Acceptance Criteria

- [x] AC1. 默认通知仍按 100/2,000 截断，保存自定义值后无需重启即可按新值投递，重启后配置仍存在。
- [x] AC2. 非整数、越界、错误版本或损坏配置不会覆盖上一份有效配置，并通过 API 返回明确错误。
- [x] AC3. 完成与失败通知、Unicode 边界测试、Codex/Claude/Qoder 上游长文本回归均通过。
- [x] AC4. `GET /api/extensions` 返回全部支持平台、显示选择、检测状态与扫描时间；`POST /api/extensions/scan` 触发重新扫描。
- [x] AC5. 用户可保存显示平台集合；刷新或重启后保持，且不能选择未知平台。
- [x] AC6. Windows 扫描能识别本机现有 Codex、Claude Desktop、Qoder、Hermes 与 Cursor 状态信号，不读取对话正文或凭据。
- [x] AC7. 扩展页在无检测结果、部分检测和全部支持视图下都有清晰空态及选择回退，无文本溢出。
- [x] AC8. 服务端测试、前端类型检查、Python 测试和生产构建通过。
- [ ] AC9. 平台卡片区分“已检测”“已配置”“已验证可用”，测试通知和静态目录不会写入真实验证状态。
- [ ] AC10. Hermes 官方 hooks 与 Claude Desktop 审计终态接入完成，并通过真实完成/失败或官方同形 payload 验证。
- [ ] AC11. 已安装/升级的 Codex、Claude、Qoder、Cursor 命令能正常启动；需要登录的平台在用户登录后完成真实任务验收。
- [ ] AC12. 每个平台保留一份可重复执行的无外发验收脚本或明确验证步骤，扫描结果只报告经验证能力。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
