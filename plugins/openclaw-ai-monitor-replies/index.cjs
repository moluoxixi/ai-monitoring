"use strict";

const ROUTE_PATTERN = /\[AI-MONITOR-REPLY:([A-Za-z0-9_-]{43})\]/g;

const extractReplyToken = (body) => {
  const matches = [...String(body || "").matchAll(ROUTE_PATTERN)];
  return matches.length === 1 ? matches[0][1] : null;
};

const acknowledgement = (text) => ({ handled: true, reply: { text } });

const responseMessage = async (response) => {
  try {
    const payload = await response.json();
    return typeof payload?.message === "string" ? payload.message : "";
  } catch {
    return "";
  }
};

const createInboundClaimHandler = ({
  fetchImpl = globalThis.fetch,
  environment = process.env,
} = {}) => async (event, context) => {
  const channel = event.channel || context.channelId;
  if (channel !== "qqbot" || event.isGroup || event.replyToIsQuote !== true) return undefined;
  if (!extractReplyToken(event.replyToBody)) return undefined;

  const replyToken = String(environment.AIMONITOR_REPLY_TOKEN || "").trim()
    || String(environment.AIMONITOR_INGEST_TOKEN || "").trim();
  if (!replyToken) return acknowledgement("AI Monitor 回复入口未启用，请在本机配置回复令牌。");
  const senderId = String(event.senderId || context.senderId || "").trim();
  const messageId = String(event.messageId || context.messageId || "").trim();
  if (!senderId || !messageId) return acknowledgement("这条 QQ 回复缺少可验证的发送者或消息标识，未转交给 AI 会话。");
  // `content` is OpenClaw's command/raw-body projection and excludes the
  // structured quoted body; BodyForAgent may include the quoted notification.
  const text = String(event.content || event.bodyForAgent || event.body || "").trim();
  if (!text) return acknowledgement("回复内容为空，未转交给 AI 会话。");

  const url = String(environment.AIMONITOR_REPLY_URL || "http://127.0.0.1:8787/api/replies/inbound").trim();
  const configuredTimeout = Number(environment.AIMONITOR_REPLY_TIMEOUT_MS || 30_000);
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
        reply_to_body: event.replyToBody,
        reply_to_is_quote: true,
        is_group: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await responseMessage(response);
      return acknowledgement(detail || `AI Monitor 未接受这条回复（HTTP ${response.status}）。`);
    }
    return acknowledgement("已转交到原 Codex 会话。");
  } catch {
    return acknowledgement("AI Monitor 暂时无法接收回复，请稍后重新引用原通知发送。");
  } finally {
    clearTimeout(timer);
  }
};

const plugin = {
  id: "ai-monitor-replies",
  name: "AI Monitor Replies",
  description: "Routes quoted AI Monitor notifications to the original conversation.",
  register(api) {
    api.on("inbound_claim", createInboundClaimHandler(), { priority: 100, timeoutMs: 60_000 });
  },
};

module.exports = plugin;
module.exports.extractReplyToken = extractReplyToken;
module.exports.createInboundClaimHandler = createInboundClaimHandler;
