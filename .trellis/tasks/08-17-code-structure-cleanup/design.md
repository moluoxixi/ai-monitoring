# 代码结构优化与清理：技术设计

## Architecture And Boundaries

### Event record normalization

新增 `apps/server/src/utils/event-record.ts`，仅负责把未知 JSON 节点归一化为 `Record<string, unknown>`。Codex、Claude Desktop transcript、Claude Desktop entrypoint 检测和 Hermes Desktop parser 均依赖该中立模块，不再各自维护相同实现。

该模块不负责 schema 校验，也不推断字段含义；非对象、数组和 `null` 仍统一返回空对象，以保持当前 parser 的降级语义。

### Event text normalization

将 `sanitizeFailureMessage` 和 `summarizeTask` 从 `codex-session-watcher.service.ts` 移入中立模块 `apps/server/src/utils/event-text.ts`。该模块同时承载 database、deliveries 和 events 共享的无状态文本处理，避免其他领域依赖 `events` 目录。Codex、Claude Desktop 和 Hermes Desktop 都直接从该工具模块导入。

Claude 的递归 content block 提取和 Hermes 的纯字符串提取仍保留在各自 watcher 内，因为二者输入契约不同，强行统一会扩大行为变更风险。

### Watcher ownership

本任务不拆分 watcher service 的生命周期、Chokidar 监听、增量读取、SQLite 轮询或事件投递逻辑。只去除跨 watcher helper 依赖，并在以下非直观位置补充理由注释：

- Claude content block 提取为何忽略 thinking/tool 等未知 typed block；
- Hermes 启动时为何只记录当前 terminal assistant 最大 ID，避免重放历史通知；
- 公共 JSON record 归一化为何对非法节点返回空对象。

### Vite configuration

保留 `apps/web/vite.config.ts` 作为唯一配置源，删除语义重复且当前优先级更高的 `apps/web/vite.config.js`。现有 `apps/web/tsconfig.json` 已包含 TypeScript 配置，无需改变脚本或编译设置。

`auto-imports.d.ts` 和 `components.d.ts` 由插件生成且可被 IDE/语言服务使用，不属于无用文件；零字节 `.gitkeep` 继续承担目录占位职责。

### Empty source directories

清理仅针对应用源码树中的空壳目录。删除 `apps/server/src/answer-summary/dto`、`apps/server/src/platforms/dto`、`apps/web/src/components/platforms`，并级联删除随之暴露且同样无引用的 `apps/server/src/answer-summary`、`apps/server/src/platforms`；`data/openclaw-outbound`、`.trellis/tasks/archive` 以及 `target`、`.venv`、`node_modules` 下的空目录分别由运行时、任务归档或工具链负责，不作为源码垃圾处理。

## Contracts And Compatibility

- `sanitizeFailureMessage(value, preserveAuthorizationScheme)` 的正则顺序、脱敏占位符、Windows 用户路径处理、空白归一化和 24,000 字符上限保持不变。
- `summarizeTask(value)` 的浏览器上下文移除、`## My request:` 移除、历史提示过滤和 2,000 字符上限保持不变。
- `recordValue(value)` 对对象、数组、`null` 和 primitive 的返回语义与现有四份实现一致。
- Codex watcher 继续 re-export 两个文本 helper，兼容仓库外可能存在的旧深层导入；仓库内消费者全部改用中立模块。
- watcher 公开 service、parser export、事件格式、source ID、状态和 metadata 不变。
- Vite host、port、插件列表和 `/api` proxy 不变。

## Testing Strategy

- 新增纯函数测试，直接覆盖 record 归一化、任务摘要边界和失败信息脱敏边界。
- 将 Codex spec 中针对公共 helper 的直接断言迁到公共模块 spec；Codex parser 的集成断言保留。
- 保留 Claude/Hermes 的 parser 与 watcher 测试，确保导入迁移没有改变结果。
- 执行全仓 `npm test`、`npm run typecheck`、`npm run build`。
- 构建后重启生产服务，检查 `/api/health` 和 `/`。

## Rollback

变更不涉及数据库或数据迁移。若公共 helper 抽取导致回归，可恢复原文件内定义和旧导入；若 Vite 配置解析异常，可恢复 `vite.config.js`。代码回滚不需要处理持久化数据。
