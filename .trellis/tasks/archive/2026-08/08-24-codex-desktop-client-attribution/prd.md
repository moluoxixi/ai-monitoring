# 修复 Codex Desktop 客户端归属判断

## 目标

让事件 `client` 与通知所有权反映用户实际使用的 Codex Desktop 或独立 CLI/TUI，而不是把 `thread_source` 的执行/分支语义误当成客户端来源。

## 已确认事实

- 最近 100 条 `codex-session` 事件中有 12 条标为 `codex-cli`，仅来自两个 rollout；两者首个 `session_meta` 都是 `source="vscode"`、`originator="Codex Desktop"`、`thread_source="cli"`，并含 `forked_from_id`。
- 本机真正独立 CLI/TUI 样本为 `source="cli"`、`originator="codex-tui"`、`thread_source="user"`。
- 现有 TypeScript 与 Python 判定器都让 `thread_source="cli"` 覆盖 Desktop runtime marker，直接导致误标。
- 该覆盖最初用于让 Desktop fork 后续回复走 CLI resume；当前 Codex CLI/Desktop 已统一从最新分支头继续 fork，客户端标签不再需要承担路由模式选择。

## 需求

- R1. `client` 表示观察到该 rollout 的用户客户端/runtime 表面；`thread_source` 表示线程执行/创建语义，两者不得混为一谈。
- R2. subagent 结构证据保持最高优先级，内部子代理不得因 Desktop/CLI marker 产生用户通知。
- R3. 明确 Desktop runtime marker（如 `originator="Codex Desktop"`、`source="vscode"`）必须优先于 `thread_source="cli"`，冲突形状归类为 `codex-desktop`。
- R4. 明确 CLI/TUI runtime marker（如 `source="cli"`、`originator="codex-tui"`）继续归类为 `codex-cli`；只有缺少更强 runtime marker 时，`thread_source="cli"` 才作为 CLI fallback。
- R5. TypeScript watcher 与 Python `session_kind()` 必须采用同一优先级，避免 watcher 与 notify/proxy 对同一 session 争抢通知所有权。
- R6. 当 `codex-desktop` 扩展可见时，Desktop 冲突形状仍须生成可回复 delivery，回复 dispatcher 必须继续使用 `mode="fork"`，不得回退 resume；隐藏 Desktop 时仍只保留事件。
- R7. 首 meta owner 锁定、fork copied-history 边界、turn 归属、数据库 schema 和历史事件保持不变。

## 验收标准

- [x] AC1. TypeScript 单元测试证明 `vscode + Codex Desktop + thread_source=cli` 归类 Desktop，subagent 冲突仍被抑制，纯 CLI marker 与仅有 `thread_source=cli` 的 fallback 仍归类 CLI，有效未知 runtime 使用 watcher-owned Desktop fallback。
- [x] AC2. Python identity 测试覆盖同一决策矩阵与空 subagent 对象，并有 multiplexer/proxy 贯通测试证明该 Desktop session 不由 hook/proxy 重复 relay。
- [x] AC3. 在 Desktop 可见、CLI 隐藏的设置下，watcher -> database -> reply route -> dispatcher 贯通测试中事件与 route 为 `codex-desktop`，回复仍精确调用 `mode="fork"`。
- [x] AC4. 定向测试、server 全量测试、Python 全量测试、typecheck、build 和 `git diff --check` 通过。
- [x] AC5. 重建并重启服务后，编译产物和 Python helper 对真实误分类 rollout 均返回 `codex-desktop`，后续同类事件使用新分类；历史误分类记录不做破坏性改写。

## 范围外

- 不修改已入库事件 803-834 的历史 `client`。
- 不引入新的 `unknown` client 枚举或数据库迁移。
- 不修改 Codex App Server fork 请求、CAS 分支头或 QQ 回复协议。
