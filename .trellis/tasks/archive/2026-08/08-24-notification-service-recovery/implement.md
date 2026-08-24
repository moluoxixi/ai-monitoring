# 修复通知服务退出与自动恢复 - 实施计划

1. 读取 Codex watcher、测试、`run-relay.ps1`、`install-task.ps1` 及现有 PowerShell 测试模式，确认最小改动点与可复用约定。
2. 为 Codex 文件枚举增加逐项容错和 discovery 外层兜底，保留同轮其他文件并记录非预期错误。
3. 增加确定性 watcher 回归，覆盖文件/目录消失和后续扫描恢复。
4. 新增自启动专用 supervisor，提供重启延迟与有限次数测试参数；保持手工 `run-relay.ps1` 不变。
5. 更新安装/卸载脚本，使计划任务和 Startup fallback 统一指向 supervisor，并清理 legacy Phoenix 项。
6. 增加 PowerShell/安装契约验证并更新 README 的 Windows 自启动说明。
7. 运行定向测试、server 全量测试、typecheck、build、PowerShell 语法检查和 `git diff --check`。
8. 使用 `trellis-check` 做独立质量核验；通过后安装本机自启动入口，验证健康状态与一次受控自动恢复。

## 预期修改文件

- `apps/server/src/events/codex-session-watcher.service.ts`：扫描容错与 discovery 防御边界。
- `apps/server/test/codex-session-watcher.spec.ts`：文件消失竞态回归。
- `scripts/run-relay-supervisor.ps1`：Windows 自启动监督入口。
- `scripts/install-task.ps1`：统一监督入口并清理 legacy 项。
- `scripts/tests/*` 或现有等价位置：supervisor 与安装契约测试。
- `README.md`：说明手工入口与自启动监督的区别。

## 不修改

- 数据库、delivery worker、渠道 provider 和 OpenClaw Gateway。
- Docker Compose 与 Tauri sidecar 生命周期。
- Codex fork ownership 状态机及回复路由协议。

## 验证命令

- `npm run test -w @ai-monitor/server -- codex-session-watcher.spec.ts`
- `npm run test -w @ai-monitor/server`
- `npm run typecheck -w @ai-monitor/server`
- `npm run build -w @ai-monitor/server`
- PowerShell supervisor/安装脚本定向测试与 parser 语法检查
- `git diff --check`

## 验证结果

- Codex watcher 定向测试：38/38 通过。
- 根全量测试：根脚本 16/16、server 260 passed / 1 skipped、web 7/7 通过。
- 全量 typecheck 与生产 build：通过。
- PowerShell 5.1 parser：`run-relay-supervisor.ps1` 与 `install-task.ps1` 通过。
- supervisor 动态测试：非零退出码、1 秒实际退避、UTF-8 子输出、两次运行与有限停止均通过。
- `git diff --check`：通过；仅有工作区既有 LF/CRLF 转换提示。
- package 未定义 lint script，因此未运行或声称 lint 通过。
- 本机安装走 Startup fallback，快捷方式已指向 supervisor；legacy Phoenix 快捷方式和计划任务均已清理。
- 受监督 Node PID `25632` 被终止后，supervisor PID `22756` 记录退出码 `-1`、等待 5 秒并拉起 PID `19248`；`/api/health` 返回 `ok=true`。
- 事件 822 的 QQ delivery 由 `pending/attempts=0` 变为 `sent/attempts=1`；微信 delivery 已执行 8 次并因会话不可用处于 `retrying`，证明 worker 已恢复。
