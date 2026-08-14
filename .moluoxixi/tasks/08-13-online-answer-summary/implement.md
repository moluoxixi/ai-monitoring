# 在线模型回答摘要与渠道回退 - Implementation Plan

1. 建立 `answer-summary` 模块、provider registry、版本化配置存储、DTO/controller 和 OpenAI-compatible 调用服务。
2. 扩展 AppConfigService、AppModule、`.env.example`、`.gitignore` 和 README，加入配置路径与官方 API Key 链接说明。
3. 扩展 Codex notify 与 session watcher，捕获最终回答为短生命周期的 `answer_source`；在事件入库前 enrichment 并删除原文。
4. 扩展事件去重补全和 delivery 文本组装，支持 `answer_summary` 以及任务/回答双摘要。
5. 新增前端设置视图、配置对话框、渠道顺序控制、API 类型和请求方法；保持现有主题与移动布局。
6. 添加后端 provider/config/fallback、watcher、数据库和通知正文回归测试；更新 Python notify 测试。
7. 运行 `python -m pytest`、`npm test`、`npm run typecheck`、`npm run build`，并用浏览器检查桌面与移动设置页。
8. 增加 `events.answer_text` 兼容迁移和详情专属投影；将消息点击改为任务详情弹窗，展示提问、完整回答/摘要回退、失败原因和投递状态。
9. 扩展 Claude/Qoder 成功 Stop 回答字段与缺失 turn ID 回退，保持失败事件回答隔离；验证列表、投递、通知和 trace 路由均不携带全文。

## Risk And Rollback Points

- 事件入库前的网络调用会增加完成事件延迟，因此设置短超时并吞掉摘要异常。
- 两条 Codex 来源可能重复上报；沿用 source event ID 去重，并允许迟到事件补全 `answer_summary`。
- 当前工作树包含用户未提交的通知渠道和主题修改；所有编辑基于现状增量进行，不恢复或覆盖这些修改。
