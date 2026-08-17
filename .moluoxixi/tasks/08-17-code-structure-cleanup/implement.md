# 代码结构优化与清理：实施计划

## Implementation Checklist

- [x] 新增 `event-record.ts` 并为未知 JSON record 归一化添加边界测试。
- [x] 将 `sanitizeFailureMessage`、`summarizeTask` 移到 `event-text.ts`，迁移并扩展纯函数测试。
- [x] 更新 Codex、Claude Desktop、Hermes Desktop 和 entrypoint 检测的导入，删除重复 helper 定义。
- [x] 在 Claude content block 过滤和 Hermes 启动基线处补充理由注释。
- [x] 删除重复的 `apps/web/vite.config.js`，确认 Vite 加载 `vite.config.ts`。
- [x] 删除 3 个无引用的应用源码空叶目录及随之暴露的 2 个空父目录，保留运行时和构建工具所需的空目录。
- [x] 将 `event-record.ts`、`event-text.ts` 迁移到 `apps/server/src/utils`，更新全部生产、测试和兼容导出路径。
- [x] 搜索旧 helper 定义和跨 watcher 导入，确认无遗漏。
- [x] 执行测试、类型检查和生产构建。
- [x] 重启本地生产服务并检查健康接口和主页。

## Validation Results

- `npm test`：desktop 1/1；server 146 passed、1 skipped；web 6/6。
- `npm run typecheck`：server 与 web 均通过。
- `npm run build`：web 与 server 均通过；仅保留第三方 `@vueuse/core` PURE 注释 warning。
- Vite debug config：加载 `apps/web/vite.config.ts`，`/api` proxy 为 `http://127.0.0.1:8787`。
- 重启检查：`/api/health` 返回 `ok: true`，`/` 返回 HTTP 200，监听 PID `22200`。
- 空目录检查：应用源码树不再包含无引用空目录；保留目录均有运行时或工具链引用证据。

## Validation Commands

```powershell
npm test
npm run typecheck
npm run build
npm exec --workspace=@ai-monitor/web vite -- build --debug config
Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 10
Invoke-WebRequest -Uri 'http://127.0.0.1:8787/' -TimeoutSec 10 -UseBasicParsing
```

## Risk And Rollback Points

- 公共正则或截断逻辑只移动、不重写；在导入迁移后先运行 server watcher tests。
- `recordValue` 的行为以数组、`null`、primitive 和普通对象测试锁定。
- 删除 Vite JavaScript 配置后立即用 debug config 输出核对 `configFile`；若未选择 TypeScript 配置则停止并恢复该文件。
- 服务重启前必须先完成构建，避免运行旧的 `dist`。

## Review Gates

- 公共模块不能导入任何 watcher service。
- watcher service 之间不能再为通用 helper 互相导入。
- 不新增事件字段、数据库迁移或 UI 行为变化。
- 只删除已证明冗余的重复 Vite 配置，不删除生成声明或目录占位文件。
