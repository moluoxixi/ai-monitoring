# Codex fork 快照误报根因

## 现场证据

- 数据库事件 805：`source=codex-session`、`kind=turn_aborted`、`status=interrupted`，父 thread 为 `01a02de2-705c-7d70-b4e3-c7b7e472567e`，turn 为 `01a02df3-8935-7510-a4f5-3c1b4a6825cd`。
- 父 session 在误报时间之后仍写入成功的 `patch_apply_end`，且没有该 turn 的真实终态。
- 误报来自持久 fork `01a02e04-17cd-7312-a6d1-2532ac2df292` 的归档 JSONL：首行是 fork meta，第二行起复制父/祖先历史，末尾含父 active turn 的 synthetic `turn_aborted`。
- 该 fork 由受控 `persistent-fork-probe` 调用 `thread/fork(ephemeral=false, threadSource=cli)` 后立即归档产生，证明持久 fork 会把复制历史暴露给 watcher。

## 真实格式要点

- 首行 `session_meta.payload.id/session_id` 是新 fork ID，并含 `forked_from_id`。
- 后续 copied `session_meta` 可以反复出现并携带父/祖先 ID。
- copied 记录的顶层时间被重写到 fork 创建时刻，不能作为 history boundary。
- `session_meta.payload.timestamp` 与 `task_started.payload.started_at` 保留原始时间，可用于认领 fork 创建之后的新 turn。
- terminal payload 只有 `turn_id`，没有 session/thread ID，因此终态必须与已认领 `task_started` 关联。

## 根因链

```text
持久 fork 创建复制快照
  -> watcher 逐行接受每个 session_meta
  -> currentSessionId 被 copied parent meta 覆盖
  -> copied/synthetic turn_aborted 无 turn ownership 校验
  -> 生成父 session interrupted 事件
  -> interrupted 强制 answerSource 为空
  -> 用户收到“任务已中断 / 未采集到最终回答”
```

## 排除项

- 不是父 Codex turn 真实停止：父文件之后仍持续产生工具和补丁事件。
- 不是 delivery worker 自行判断中断：它只格式化 watcher 已入库的 status。
- 不是监控协程退出：watcher 只对 JSONL terminal payload 生成终态。

## Bug Analysis: Codex 持久 fork 快照误报中断

### 1. Root Cause Category

- **Category B - Cross-Layer Contract**：`thread/fork` 的成功 RPC 没有说明持久 JSONL 会包含完整父/祖先历史，writer 与 watcher 缺少共享的数据形状契约。
- **Category D - Test Coverage Gap**：原测试只有单 meta 的 fork completion，没有真实 copied snapshot、foreign meta 或 synthetic abort。
- **Category E - Implicit Assumption**：实现曾隐含假设每个 `session_meta` 都代表当前文件、顶层时间可以区分新旧、秒级与毫秒级时间可直接比较。

### 2. Why Fixes Failed

1. 仅锁定首个 meta 会阻止父 ID 覆盖，却仍可能把 copied terminal 改挂到 fork ID，属于不完整范围。
2. 初版 owned-turn 时间门槛使用毫秒严格比较，会漏掉真实的同秒秒级 `started_at`；独立审查用实际 fork 文件在提交前捕获。
3. 初版删除 `readSessionId` 后没有保留旧 backfill 文件的 owner，会让后续 append 永久不可见；兼容审查在全量提交前捕获。

### 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
|---|---|---|---|
| P0 | Architecture | 文件 owner 由首 meta 锁定；fork terminal 必须关联 owned `task_started` | DONE |
| P0 | Test Coverage | 使用真实 copied snapshot、同秒精度、大文件恢复和旧文件 append fixture | DONE |
| P0 | Documentation | 在 backend quality spec 固化 payload 字段、状态契约和错误矩阵 | DONE |
| P1 | Code Review | watcher 变更必须检查 owner、history boundary、timestamp precision 和 backfill continuation | DONE |

### 4. Systematic Expansion

- **Similar Issues**：任何会复制、分支或重写 transcript 的外部 runtime 都不能把文件内重复 metadata 当作当前 owner。
- **Design Improvement**：文件级 reducer 必须统一服务实时读取和 prefix recovery，不能维护两套状态恢复逻辑。
- **Process Improvement**：外部 writer/reader 跨层改动必须保存真实 persisted fixture，并针对字段精度做独立核验。

### 5. Knowledge Capture

- [x] 更新 `.trellis/spec/server/backend/quality-guidelines.md`。
- [x] 更新 `.trellis/spec/guides/cross-layer-thinking-guide.md`。
- [x] 在本任务保留事件 805 与真实 fork JSONL 的根因证据。
