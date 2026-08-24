# Bug Analysis: 通知服务退出后长期静默

## 1. Root Cause Category

- **Category D - Test Coverage Gap**：没有覆盖 `readdirSync` 返回条目后、`statSync` 前文件被删除的确定性竞态，裸定时器中的同步异常可以终止 Node。
- **Category E - Implicit Assumption**：watcher 假设枚举出的路径在下一次文件系统调用时仍存在；部署脚本假设登录触发等价于进程监督。
- **Category A - Missing Spec**：项目没有规定 watcher discovery 的 TOCTOU 容错边界，也没有规定 Windows 登录启动项必须通过 supervisor 运行。

## 2. Why Fixes Failed

1. 之前只恢复服务：解决了当下的端口不可用，但没有减少进程崩溃，也没有在下一次退出后自动恢复。
2. 之前的 watcher 修复集中在 JSONL 状态、短会话和 Promise queue：`captureStartupFiles` 发生在 queue 之前，既有 read failure 测试覆盖不到这个同步异常边界。
3. 自启动只验证“登录后能拉起”，没有验证“数小时后子进程退出能恢复”，把 trigger 与 supervisor 混为一谈。

## 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
|---|---|---|---|
| P0 | Architecture | 对 discovery 的逐目录/逐文件调用建立局部容错，timer 外层再做兜底 | DONE |
| P0 | Runtime | Windows 自启动统一进入单实例 supervisor，退出后延迟重启并写日志 | DONE |
| P0 | Test Coverage | 确定性注入文件/目录消失，验证同轮继续与后续恢复 | DONE |
| P1 | Test Coverage | PowerShell 5.1 验证退出码、非零延迟、UTF-8 日志和有限次数停止 | DONE |
| P1 | Documentation | 在 backend quality spec 固化 discovery 与 supervision 七段契约 | DONE |

## 4. Systematic Expansion

- **Similar Issues**：Claude Desktop watcher 的新 root discovery、Hermes 启动枚举也存在类似的目录消失窗口；本次不扩面，后续修改这些 watcher 时应套用新规范。
- **Design Improvement**：所有周期扫描必须保证同步异常不逃出 timer；单项竞态不应丢弃同轮其他扫描结果。
- **Process Improvement**：自启动验收必须包含“杀死受监督子进程后恢复”，不能只检查注册项存在或登录时启动成功。

## 5. Knowledge Capture

- [x] 更新 `.trellis/spec/server/backend/quality-guidelines.md`。
- [x] 将 Quality Guidelines 在 backend index 标记为 Active。
- [x] 增加 watcher 与 supervisor 回归并纳入根测试命令。
- [x] 项目不存在 `src/templates/markdown/spec/`，无模板副本需要同步。
