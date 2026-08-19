# 统一 hook 卸载流程设计

## Boundary

安装与卸载的行为位于根目录 `scripts/`，不改变通知事件、消息路由或
OpenClaw Gateway 运行时。本任务只处理配置所有权与可逆性。

## Managed identities

- Codex: `codex_notify_multiplexer.py`
- Claude: `claude_event_adapter.py`
- Cursor: `cursor_event_adapter.py`
- Hermes: `hermes_event_adapter.py`
- Qoder legacy: `qoder_event_adapter.py`
- OpenClaw: plugin id `ai-monitor-replies`

## Removal flow

Python 配置器各自暴露 `remove(...) -> bool`，与安装时使用同一 marker。
`uninstall_hooks.py` 只负责跨配置编排和 manifest 恢复；PowerShell 入口解析标准用户路径、
选择 Python/Node 并调用核心脚本。

Codex 仅在当前 `notify` 仍是 multiplexer 时恢复 targets sidecar 中的唯一原命令。
如用户已改写 `notify`，卸载不触碰它。异常的多 target sidecar 无法表示为单个
Codex `notify` 数组，因此 fail closed。

## Backup restore

`install-hooks.ps1` 在写入前为六个受管对象写入 `manifest.json`，记录 schema 版本、
原绝对路径、原文件是否存在和备份文件名。`RestoreBackup` 必须显式传入备份目录。
恢复已存在的原文件会覆盖当前文件；原文件不存在时不盲目删除当前文件，
而是执行精确 marker 清理，保留安装后新增的用户配置。

## OpenClaw

独立 Node 脚本先查询 plugin registry。存在 `ai-monitor-replies` 时调用
`plugins uninstall ai-monitor-replies --force`；不存在时视为幂等成功。卸载命令自身会清理
plugin entry/config，因此不再无条件调用 `config unset`。已配置 state 路径时仅删除
`OPENCLAW_STATE_DIR/.ai-monitor-openclaw` marker，不递归删除 state 目录。

## Compatibility

所有文件 IO 显式使用 UTF-8；Python 路径处理使用 `pathlib.Path`。PowerShell 作为现有
Windows 安装入口的对称卸载入口。Python 核心保持可跨平台直接调用。
