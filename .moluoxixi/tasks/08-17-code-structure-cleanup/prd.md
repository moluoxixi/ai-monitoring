# 代码结构优化与清理

## Goal

在不降低现有功能可靠性的前提下，降低服务端事件 watcher 的重复代码和模块耦合，统一前端构建配置来源，删除有充分证据证明冗余的文件，并为非直观逻辑补充少量说明性注释，使后续扩展和维护更容易。

## Background

- 本地生产服务已在 `127.0.0.1:8787` 完成重启并通过 `/api/health` 检查。
- 当前工作树在任务开始前是干净的；基线 `npm test`、`npm run typecheck`、`npm run build` 均通过。
- `apps/server/src/events/codex-session-watcher.service.ts:36`、`claude-desktop-audit-watcher.service.ts:21`、`hermes-desktop-state-watcher.service.ts:26` 和 `claude-desktop-transcript.ts:1` 重复定义了未知 JSON record 归一化逻辑。
- Claude 与 Hermes watcher 分别在 `apps/server/src/events/claude-desktop-audit-watcher.service.ts:9` 和 `hermes-desktop-state-watcher.service.ts:9` 从 Codex watcher 导入通用失败消息与任务摘要函数，形成不必要的 watcher 间依赖。
- `apps/web/vite.config.js` 与 `apps/web/vite.config.ts` 语义重复，当前 Vite 实际选择 JavaScript 配置，而 `apps/web/tsconfig.json:12` 只纳入 TypeScript 配置。
- 仓库中仅有的零字节跟踪文件是用于保留目录的 `.gitkeep`，不属于可删除垃圾文件。

## Requirements

- R1：将跨 watcher 共用的纯解析/格式化函数移动到中立模块，消除 Claude/Hermes 对 Codex watcher 实现文件的依赖。
- R2：严格保持现有事件解析、失败消息清洗、任务摘要、文件监听和投递行为不变；本任务不顺带调整 watcher 的解析或容错语义。
- R3：为抽出的公共工具补充聚焦于边界条件和非直观约束的单元测试，避免只验证实现细节。
- R4：将 Vite 配置收敛为一个权威来源，删除重复配置文件，并保持开发代理、插件和生产构建行为不变。
- R5：仅删除能够通过构建入口、引用关系或生成规则证明冗余的文件；保留 `.gitkeep`、IDE 类型声明和其他用途不确定的文件。
- R6：只在状态同步、增量文件读取或输入降级规则等难以从代码直接看出的地方补充简短注释，不添加逐行复述代码的注释。
- R7：变更后重新构建并重启本地生产服务，验证健康接口和静态页面仍可访问。
- R8：删除应用源码树中没有文件、没有子目录且没有代码/配置引用的空目录；保留运行时数据落点、任务归档目录以及可再生构建/依赖缓存目录。
- R9：将无领域状态、被多个服务端领域共享的纯函数模块放入 `apps/server/src/utils`，避免 `database`、`deliveries` 等领域反向依赖 `events` 工具路径。

## Acceptance Criteria

- [x] AC1：Claude、Codex、Hermes watcher 不再互相导入通用解析/格式化函数，公共依赖指向中立工具模块。
- [x] AC2：公共工具单元测试覆盖空值、数组、primitive、普通对象、失败消息清洗和任务摘要的既有语义；Claude 的嵌套文本提取仍由 parser 测试覆盖。
- [x] AC3：`apps/web` 只保留一份 Vite 配置，`npm run build` 明确加载该配置且 `/api` 代理仍指向 `127.0.0.1:8787`。
- [x] AC4：删除清单中的每个文件都有可核验的冗余证据；目录占位文件和仍可能被工具使用的声明文件不删除。
- [x] AC5：`npm test`、`npm run typecheck`、`npm run build` 全部通过。
- [x] AC6：重启后的 `http://127.0.0.1:8787/api/health` 返回 `ok: true`，主页请求成功。
- [x] AC7：`apps/server/src` 和 `apps/web/src` 中不再存在无引用的空目录；`target`、`.venv`、`node_modules`、`data/openclaw-outbound` 和 `.moluoxixi/tasks/archive` 等运行/工具目录按职责保留。
- [x] AC8：`event-record.ts`、`event-text.ts` 位于 `apps/server/src/utils`；所有生产和测试消费者使用新路径，Codex watcher 的兼容 re-export 保持可用。

## Out Of Scope

- 拆分 `OpenClawProvider`、`PlatformScannerService` 或 `DatabaseService` 等大模块；这些模块涉及独立状态机、事务或平台探测边界，应另设任务设计和验证。
- 改变事件 JSON 结构、数据库 schema、API 契约或前端交互。
- 删除 `node_modules`、`dist`、`target`、日志和虚拟环境等本地生成目录；它们已由 `.gitignore` 管理。


