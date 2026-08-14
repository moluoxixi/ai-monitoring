# 在线模型回答摘要与渠道回退 - Design

## Boundaries

新增独立的 `answer-summary` 后端模块，职责包括配置、在线调用、渠道回退和只读状态 API。它不是通知投递渠道，也不进入 `ChannelsService`；通知渠道继续只负责发送已经组装好的文本。

前端新增顶层“设置”视图，回答摘要渠道在其中配置。现有“扩展”视图仍只管理 AI 客户端和通知渠道。

## Data Flow

1. Codex notify 从 `last-assistant-message` 提取最终回答；session watcher 跟踪最后一个 `agent_message`。
2. 终态事件写库前调用 `AnswerSummaryService.enrichEvent()`。
3. 服务只在完成态且回答非空时，截取最后 24,000 个字符并按配置顺序调用在线渠道。
4. 成功结果以 `metadata.answer_summary` 写入事件；清洗后的完整回答写入独立 `events.answer_text` 列，临时 `answer_source` 在入库前删除。
5. delivery worker 将任务摘要和回答摘要组装成两行通知。
6. 模型配置或所有调用失败时，事件照常入库和投递，仅省略回答摘要。
7. 事件列表和 delivery 查询不选择 `answer_text`；只有 `GET /api/events/:id` 显式读取并返回它，详情页优先展示完整回答并以摘要回退。

## Contracts

配置文档版本为 1，包含固定 provider ID 顺序和各渠道的 `enabled`、`apiKey`、`model`，自定义渠道额外包含 `baseUrl`。API 状态只返回 `configured`、`enabled`、模型、非敏感 Base URL、冷却时间及安全化错误类别。

内置端点：

- Groq: `https://api.groq.com/openai/v1`
- OpenRouter: `https://openrouter.ai/api/v1`
- Gemini: `https://generativelanguage.googleapis.com/v1beta/openai`

调用统一使用 `POST {baseUrl}/chat/completions`、Bearer 鉴权和最小字段集合：`model`、`messages`、`temperature`、`max_tokens`。响应读取 `choices[0].message.content`。

## Failure And Cooldown

- 429：立即回退并将渠道冷却至服务器本地次日零点，状态持久化。
- 401/403、402、498、5xx、超时、网络错误、无效响应：记录安全错误类别并立即回退；不把响应正文或请求密钥写入错误。
- 配置更新/解绑：清空该渠道 cooldown 和 last error。
- 全部失败：返回空摘要，不抛出到事件采集或通知投递链路。

## Security

- 事件生产者使用临时 `answer_source` 字段；只对 completed 事件保留最多 24,000 字符的清洗结果，并写入专用列。失败、中断和工具失败事件删除回答字段。
- 完整回答不进入列表、delivery、通知正文或日志；单任务详情是唯一前端读取入口。任务采集和通知链路不创建或依赖 Phoenix 生命周期 span。
- API Key 仅存于忽略提交的本地配置文件，写入采用临时文件、`0600` 和原子 rename。
- 状态 API 永不返回 API Key；错误只返回枚举化类别，不透传上游响应正文。
- Base URL 只允许 `http:`/`https:` 且必须含 hostname；内置渠道 URL 不可由前端覆盖。

## Compatibility And Rollback

没有配置回答摘要渠道时，事件与通知仍正常工作，详情仍可显示清洗后的完整回答。旧数据库通过可重复执行的 `ALTER TABLE events ADD COLUMN answer_text TEXT` 兼容迁移；旧事件没有回答时按摘要或空态展示。现有 Phoenix 数据、URL、追踪服务和追踪依赖均不属于产品运行时，并在迁移后移除。

## Docker Deployment

生产镜像使用多阶段 Node 构建并由单个 Nest 进程托管 Vue 静态文件。运行层安装 Apprise、OpenClaw 和固定版本的腾讯 QQ/微信插件；Compose 使用独立 Gateway 服务与通知中心共享 OpenClaw 具名卷。`data` 绑定挂载保存 SQLite 和通道配置，宿主 Codex sessions 只读挂载。AI 客户端 hooks 仍安装在宿主机并向 `127.0.0.1:8787` 上报。
