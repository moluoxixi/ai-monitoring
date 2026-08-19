# （已废弃）在线模型回答摘要与渠道回退 - Implementation Plan

> 历史实施计划。在线摘要模块已删除，当前通知链路不依赖任何在线模型。

1. 建立 `answer-summary` 模块、provider registry、版本化配置存储、DTO/controller 和 OpenAI-compatible 调用服务。
2. 扩展 AppConfigService、AppModule、`.env.example`、`.gitignore` 和 README，加入配置路径与官方 API Key 链接说明。
3. 扩展 Codex notify 与 session watcher，捕获最终回答为短生命周期的 `answer_source`；在事件入库前 enrichment 并删除原文。
4. 扩展事件去重补全和 delivery 文本组装，支持 `answer_summary` 以及任务/回答双摘要。
5. 新增前端设置视图、配置对话框、渠道顺序控制、API 类型和请求方法；保持现有主题与移动布局。
6. 添加后端 provider/config/fallback、watcher、数据库和通知正文回归测试；更新 Python notify 测试。
7. 运行 `python -m pytest`、`npm test`、`npm run typecheck`、`npm run build`，并用浏览器检查桌面与移动设置页。
8. 增加 `events.answer_text` 兼容迁移和详情专属投影；将消息点击改为任务详情弹窗，展示提问、完整回答/摘要回退、失败原因和投递状态。
9. 扩展 Claude/Qoder 成功 Stop 回答字段与缺失 turn ID 回退，保持失败事件回答隔离；验证列表、投递和通知均不携带全文。
10. 按最新产品决策移除 Phoenix 追踪导出、跳转 API、前端技术详情入口、Phoenix 安装/自启动、专属依赖和运行数据；保留 Codex/Claude/Qoder 的完成与失败通知能力，并将 vendor 本地改动全部纳入可重放补丁。
11. 将 `data` 统一为忽略提交的运行目录；增加多阶段 Dockerfile、Compose、OpenClaw/Apprise 运行层、持久化卷、健康检查和 Windows 快速启动脚本，并保持宿主 hooks 接入方式。

## Risk And Rollback Points

- 事件入库前的网络调用会增加完成事件延迟，因此设置短超时并吞掉摘要异常。
- 两条 Codex 来源可能重复上报；沿用 source event ID 去重，并允许迟到事件补全 `answer_summary`。
- 当前工作树包含用户未提交的通知渠道和主题修改；所有编辑基于现状增量进行，不恢复或覆盖这些修改。
