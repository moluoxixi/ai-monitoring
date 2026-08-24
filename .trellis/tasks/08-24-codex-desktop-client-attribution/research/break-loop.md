# Bug Analysis: Desktop fork 反复误标为 CLI

## 1. Root Cause Category

- **Category B - Cross-Layer Contract**：`client` 同时被当作用户客户端标签、通知所有权和旧回复路由开关，语义不单一。
- **Category C - Change Propagation Failure**：回复架构已经统一为 persistent fork，但为旧 resume/fork 分支增加的 `thread_source=cli` 分类覆盖没有随之删除。
- **Category E - Implicit Assumption**：把 `thread_source` 当成启动客户端来源；真实 rollout 证明 Desktop fork 会保留 Desktop runtime marker 并同时写 `thread_source=cli`。
- **Category D - Test Coverage Gap**：旧测试验证了当时的 workaround，却没有断言最终用户看到的客户端标签和双生产者通知所有权。

## 2. Why Fixes Failed

1. 首次修复 active writer 时，让 Desktop fork 伪装成 CLI 以进入 CLI resume 路由，只修了当时的路由症状。
2. 后续把 CLI/Desktop dispatcher 统一改为 fork 时，分类器与其测试仍保留旧 workaround，形成已失效的耦合。
3. TypeScript watcher 与 Python hook/proxy 各自判断 identity，缺少真实冲突 fixture 的双实现贯通，容易一边改对、一边继续抢通知。

## 3. Prevention Mechanisms

| Priority | Mechanism | Specific Action | Status |
|---|---|---|---|
| P0 | Architecture | 将 runtime client attribution 与 thread execution source 分离；路由不再由 client 选择 resume/fork | DONE |
| P0 | Test Coverage | 真实 Desktop 冲突 shape 贯通 watcher、DB、route、dispatcher、multiplexer 和 proxy | DONE |
| P0 | Cross-language | TS/Python 使用相同优先级、unknown fallback 与空 subagent 语义 | DONE |
| P1 | Documentation | 在 backend quality spec 固化七段客户端归属契约 | DONE |
| P1 | Runtime | 用编译产物和真实 rollout 直接验证，并重启 supervisor 子进程加载 build | DONE |

## 4. Systematic Expansion

- **Similar Issues**：任何平台的“用户客户端”“线程来源”“生产者类型”都可能是不同维度；不能为路由方便而改写展示/所有权字段。
- **Design Improvement**：回复 writer ownership 由 thread/fork + CAS 管理，客户端标签只承载归属与展示。
- **Process Improvement**：架构消除一个分支后，必须反查曾为该分支服务的分类规则和测试，不能只删 dispatcher 分支。

## 5. Knowledge Capture

- [x] 更新 `.trellis/spec/server/backend/quality-guidelines.md` 的旧 fork 断言。
- [x] 新增完整的 Codex Client Attribution vs Thread Source 契约。
- [x] 增加双语言、可见性与跨层回归。
- [x] 项目不存在 `src/templates/markdown/spec/`，无模板副本需要同步。
