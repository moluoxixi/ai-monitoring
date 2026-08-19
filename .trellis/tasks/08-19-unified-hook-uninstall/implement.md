# 统一 hook 卸载流程实施计划

1. 为 Codex、Claude、Cursor、Hermes 配置器增加基于稳定 marker 的幂等删除函数。
2. 新增 Python 统一卸载/备份恢复编排器和 PowerShell 入口。
3. 新增 OpenClaw `ai-monitor-replies` 精确卸载脚本，保留 QQ/微信插件与 state。
4. 扩展安装备份为带 manifest 的六文件快照。
5. 增加 pytest 与 node:test 回归，更新 README 和根测试命令。
6. 运行定向测试、全量 Python 测试、Node 工具测试和静态语法检查。

## Rollback points

- 配置删除函数可独立回退，不改变安装入口。
- manifest 新格式仅影响新安装，旧备份仍可人工恢复。
- OpenClaw 卸载是显式入口，不会在桌面应用普通启动或更新时触发。
