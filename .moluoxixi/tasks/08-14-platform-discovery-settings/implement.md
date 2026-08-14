# 可配置通知长度与平台扫描展示 - Implementation Plan

1. 增加版本化用户配置服务、严格 DTO、原子持久化及通知设置 API。
2. 让 delivery worker 使用实时长度配置；提升 Codex/Claude/Qoder 生产者的提前截断上限并更新测试。
3. 将支持平台目录扩展为 Codex、Claude、Qoder、Hermes、Cursor，增加 Windows 安装/运行/接入状态检测器。
4. 扩展 extensions API：启动扫描、手动重扫、扫描状态和显示偏好保存；保持 alias/历史事件分类稳定。
5. 更新 Vue 类型、API、composable、扩展页和详情面板，加入扫描、视图切换、显示管理和长度设置。
6. 补服务端配置/检测/controller/通知测试，更新 Python 生产者回归测试。
7. 运行 `npm test`、`npm run typecheck`、`npm run build`、`.venv\\Scripts\\python.exe -m pytest -q`、`git diff --check`，重启 8787 并做健康检查。
8. 增加真实事件验证存储与 UI 状态，确保静态扫描不等于可用。
9. 接入 Claude Desktop audit watcher 与 Hermes 官方 hooks，并补隐私/错误/去重测试。
10. 升级 Codex CLI，安装 Claude CLI 和 Cursor，修复 Qoder CLI 启动入口；逐项做无外发真实任务验收。
11. 登录阻塞时暂停对应平台并通知用户接管，登录后继续完成验收矩阵。

## Rollback

- 删除用户配置文件即可回到默认 100/2,000 和三平台显示。
- 检测器异常按平台隔离；必要时可关闭启动扫描而不影响静态支持目录。
- UI 仍以 `GET /api/extensions` 聚合响应为单一来源，后端字段可向后兼容保留。
