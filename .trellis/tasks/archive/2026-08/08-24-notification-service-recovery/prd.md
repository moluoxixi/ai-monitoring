# 修复通知服务退出与自动恢复

## 目标

修复通知中心因 Codex 会话文件在扫描期间消失而退出的问题，并让 Windows 登录启动入口具备进程监督能力，使服务意外退出后可以自动恢复投递。

## 已确认事实

- `127.0.0.1:8787` 停止监听时，OpenClaw Gateway `127.0.0.1:18789` 仍正常，故障位于 Monitor/relay 服务本身。
- 最新事件已写入数据库，但 delivery 保持 `pending`、`attempts=0`，证明 delivery worker 在计划投递前已经停止。
- 历史崩溃日志显示 `CodexSessionWatcherService.captureStartupFiles` 在 `readdirSync` 后执行 `statSync` 时遇到 `ENOENT`，异常从裸定时器回调逃逸并终止 Node 进程。
- `run-relay.ps1` 与 `run.ps1` 都是单次前台启动；`install-task.ps1` 只在登录时触发一次，没有重启策略。Startup 快捷方式或计划任务拉起的进程一旦退出，不会自行恢复。
- 本机仍有已删除 Phoenix 脚本对应的历史 Startup 快捷方式，现有卸载路径不会清理该遗留项。

## 需求

- R1. Codex watcher 枚举目录时，单个文件或目录在枚举后消失不得向事件循环抛出异常，也不得终止服务。
- R2. 对预期的瞬时文件系统竞态，应跳过当前消失项并继续处理同轮其他文件；非预期扫描错误应被记录并由下一轮轮询恢复。
- R3. 启动扫描和周期 discovery 必须共享相同的容错边界，避免只修运行期而启动期仍失败。
- R4. 手工执行 `run-relay.ps1` 的前台语义保持不变；仅 Windows 自启动入口使用 supervisor。
- R5. supervisor 在服务意外退出后等待固定时间再重启，记录退出码与重启等待，且允许通过正常终止 supervisor 停止整个循环。
- R6. `install-task.ps1` 创建的计划任务和 Startup fallback 必须统一指向 supervisor；卸载/重装时必须清理历史 `AI Monitor - Phoenix` 计划任务和快捷方式。
- R7. 不修改 delivery schema、事件幂等协议、QQ/OpenClaw 发送协议或 Desktop sidecar 生命周期。

## 验收标准

- [x] AC1. 定向测试稳定复现“枚举后文件消失”，证明扫描不抛异常、同轮其他文件仍被发现，并可在后续轮询恢复。
- [x] AC2. 现有 Codex watcher 测试全部通过，普通 CLI、Desktop、fork、partial-line、startup/backfill 行为不回归。
- [x] AC3. supervisor 测试证明子服务非零退出后按配置延迟重启，并可在测试边界内停止，不形成紧密重启循环。
- [x] AC4. 安装脚本测试或静态契约验证计划任务与 Startup shortcut 均指向 supervisor，并清理 legacy Phoenix 项。
- [x] AC5. server 定向测试、全量测试、typecheck、build、PowerShell 语法检查和 `git diff --check` 通过；无 lint script 时如实记录。
- [x] AC6. 本机安装更新后，`8787` 健康检查通过，积压 delivery 离开 `pending/attempts=0`；终止受监督的 Node 子进程后，服务可自动恢复。

## 范围外

- 不补发服务停机期间生产端未能提交到 relay 的事件。
- 不重构其他平台 watcher；只有发现与本次相同且会终止进程的直接风险时，才记录后续任务，不在本次扩面。
- 不改变 Docker 的 `restart: unless-stopped` 或 Tauri Desktop sidecar 的生命周期。
