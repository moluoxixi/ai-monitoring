# 修复 Codex Desktop 客户端归属判断 - 技术设计

## 语义边界

```text
session_meta runtime markers -> client / notification ownership
session_meta thread_source    -> weak execution fallback
reply route client            -> display/ownership metadata
reply dispatcher              -> both CLI and Desktop use persistent fork
```

`client` 回答“用户在哪个 Codex 客户端看到并运行这条线程”；`thread_source` 回答“该线程由哪种 source 语义创建”。Desktop 通过 App Server 生成的持久 fork 可以同时满足 Desktop runtime marker 与 `thread_source=cli`，这不是字段矛盾，而是两个维度。

## 决策矩阵

1. 任一结构化 subagent 证据 -> subagent，停止用户通知。
2. 明确 Desktop/VSCode/IDE runtime marker -> `codex-desktop`。
3. 明确 CLI/TUI/command-line runtime marker -> `codex-cli`。
4. 缺少 runtime marker 且 `thread_source=cli` -> `codex-cli` fallback。
5. 有有效 identity 但无已知 marker -> `codex-desktop`，与 watcher 默认所有权一致；完全找不到 identity 时 Python 才返回 unknown。

首个有效 `session_meta` 仍锁定物理文件 owner；复制历史中的后续 meta 不参与重新分类。

## 双实现一致性

- TypeScript `sessionIdentity()` 负责 watcher 事件的 `client`。
- Python `session_kind()` 负责 notify multiplexer / App Server proxy 是否跳过 Desktop。
- 两边同时调整，并用相同冲突 fixture 验证；不抽取跨语言共享代码。

## 兼容与风险

- 真正 CLI 的 `source=cli` / `originator=codex-tui` 在 Desktop fallback 之前仍有明确结果。
- 仅有 `thread_source=cli` 的无 runtime marker session 保留 CLI fallback，兼容旧 App Server 形状。
- 回复 dispatcher 当前对 CLI/Desktop 都 fork，因此将 route 标签恢复为 Desktop 不改变 writer ownership 策略。
- 最大风险是只改 watcher 未改 Python，造成 hook 与 watcher 双报；通过 multiplexer 贯通测试封锁。

## 回滚

改动只影响新解析事件，无 schema 迁移。若观察到真实 CLI 被误标，可回滚判定器与测试；历史数据不受影响。
