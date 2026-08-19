# 统一 hook 卸载流程

## Goal

为 AI Monitor 安装的 Codex、Claude、Cursor、Hermes、Qoder hooks/notify 以及
OpenClaw 引用回复插件提供可识别、可幂等、不破坏用户其他配置的统一卸载流程。

## Requirements

- 默认卸载只删除 AI Monitor 管理的配置项，保留用户其他 hooks 和设置。
- 每个集成使用稳定、精确的 adapter/plugin 标识，重复安装和卸载均幂等。
- 安装前备份必须记录原路径、原文件是否存在和 Codex targets sidecar，
  以便显式的备份恢复模式能还原原始配置。
- OpenClaw 卸载只处理 `ai-monitor-replies`，不删除 QQ/微信插件、登录态或整个 state 目录。
- 缺失配置、已卸载状态和重复执行应当成功结束；无效配置或无法无损恢复的数据应当明确失败。

## Acceptance Criteria

- [x] `RemoveOnly` 从五类 AI 客户配置中只删除 AI Monitor 条目，并能重复执行。
- [x] Codex 卸载恢复安装前的单个 notify target，不覆盖安装后被用户改写的 notify。
- [x] `RestoreBackup` 使用有版本的 manifest 恢复指定备份，不隐式猜测备份目录。
- [x] OpenClaw 卸载不会构造删除 `openclaw-qqbot` 或 `openclaw-weixin` 的命令。
- [x] 自动化测试覆盖幂等性、用户 hook 保留、Codex 恢复和 OpenClaw 插件边界。
- [x] README 文档说明卸载命令、备份恢复语义和 OpenClaw 保留范围。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
