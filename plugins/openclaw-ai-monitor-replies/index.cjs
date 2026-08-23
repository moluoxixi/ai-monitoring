"use strict";

const ROUTE_PATTERN = /\[AI-MONITOR-REPLY:([A-Za-z0-9_-]{43})\]/g;
const TASK_ID_PATTERN = /\[任务ID:([1-9][0-9]*)\]/g;

const extractReplyToken = (body) => {
  const matches = [...String(body || "").matchAll(ROUTE_PATTERN)];
  return matches.length === 1 ? matches[0][1] : null;
};

const extractTaskId = (body) => {
  const matches = [...String(body || "").matchAll(TASK_ID_PATTERN)];
  if (matches.length !== 1) return null;
  const value = Number(matches[0][1]);
  return Number.isSafeInteger(value) ? value : null;
};

const acknowledgement = (text) => ({ handled: true, text });

const responseMessage = async (response) => {
  try {
    const payload = await response.json();
    return typeof payload?.message === "string" ? payload.message : "";
  } catch {
    return "";
  }
};

const createBeforeDispatchHandler = ({
  fetchImpl = globalThis.fetch,
  environment = process.env,
  pluginConfig = {},
} = {}) => async (event, context = {}) => {
  const channel = event.channel || context.channelId;
  const quotedBody = String(event.replyToBody || context.replyToBody || "");
  const hasReplyRoute = Boolean(extractReplyToken(quotedBody) || extractTaskId(quotedBody));
  if (channel !== "qqbot" || event.isGroup || !hasReplyRoute) return undefined;

  const replyToken = String(pluginConfig.replyToken || "").trim()
    || String(environment.AIMONITOR_REPLY_TOKEN || "").trim()
    || String(environment.AIMONITOR_INGEST_TOKEN || "").trim();
  if (!replyToken) return acknowledgement("AI Monitor 回复入口未启用，请在本机配置回复令牌。");
  const senderId = String(event.senderId || context.senderId || "").trim();
  // QQBot 2.0.1 exposes the current inbound message id as ReplyToId so the
  // dispatcher can reply to it; before_dispatch does not carry MessageSid.
  const messageId = String(
    event.messageId
      || context.messageId
      || event.replyToIdFull
      || context.replyToIdFull
      || event.replyToId
      || context.replyToId
      || "",
  ).trim();
  if (!senderId || !messageId) return acknowledgement("这条 QQ 回复缺少可验证的发送者或消息标识，未转交给 AI 会话。");
  // before_dispatch.content is OpenClaw's command/raw-body projection and
  // excludes the structured quoted body.
  const text = String(event.content || "").trim();
  if (!text) return acknowledgement("回复内容为空，未转交给 AI 会话。");

  const url = String(
    pluginConfig.replyUrl
      || environment.AIMONITOR_REPLY_URL
      || "http://127.0.0.1:8787/api/replies/inbound",
  ).trim();
  const configuredTimeout = Number(pluginConfig.timeoutMs ?? environment.AIMONITOR_REPLY_TIMEOUT_MS ?? 30_000);
  const timeoutMs = Number.isFinite(configuredTimeout)
    ? Math.max(1_000, Math.min(configuredTimeout, 60_000))
    : 30_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${replyToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        channel: "openclaw-qq",
        account_id: String(event.accountId || context.accountId || "default"),
        sender_id: senderId,
        message_id: messageId,
        text,
        reply_to_body: quotedBody,
        reply_to_is_quote: true,
        is_group: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await responseMessage(response);
      return acknowledgement(detail || `AI Monitor 未接受这条回复（HTTP ${response.status}）。`);
    }
    return acknowledgement("已接收，Codex 正在后台处理；完成后会另发一条 QQ 消息。");
  } catch {
    return acknowledgement("AI Monitor 暂时无法接收回复，请稍后重新引用原通知发送。");
  } finally {
    clearTimeout(timer);
  }
};

const plugin = {
  id: "ai-monitor-replies",
  name: "AI Monitor Replies",
  description: "Routes quoted AI Monitor notifications to a background Codex branch.",
  register(api) {
    api.on("before_dispatch", createBeforeDispatchHandler({ pluginConfig: api.pluginConfig }), {
      priority: 100,
      timeoutMs: 60_000,
    });
  },
};

module.exports = plugin;
module.exports.extractReplyToken = extractReplyToken;
module.exports.extractTaskId = extractTaskId;
module.exports.createBeforeDispatchHandler = createBeforeDispatchHandler;
