import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { createInboundClaimHandler, extractReplyToken } = require('./index.cjs')
const token = 'A'.repeat(43)
const quoted = `任务结果：done\n\n[AI-MONITOR-REPLY:${token}]`

test('extracts exactly one route token', () => {
  assert.equal(extractReplyToken(quoted), token)
  assert.equal(extractReplyToken(`${quoted}\n${quoted}`), null)
  assert.equal(extractReplyToken('ordinary QQ message'), null)
})

test('passes unrelated QQ messages through', async () => {
  let called = false
  const handler = createInboundClaimHandler({
    fetchImpl: async () => { called = true },
    environment: { AIMONITOR_REPLY_TOKEN: 'secret' },
  })
  const result = await handler({
    channel: 'qqbot', content: 'hello', isGroup: false, replyToIsQuote: false,
  }, { channelId: 'qqbot' })
  assert.equal(result, undefined)
  assert.equal(called, false)
})

test('claims a quoted notification and posts normalized fields', async () => {
  let request
  const handler = createInboundClaimHandler({
    fetchImpl: async (url, options) => {
      request = { url, options }
      return { ok: true, status: 202, json: async () => ({ ok: true }) }
    },
    environment: { AIMONITOR_REPLY_TOKEN: 'reply-secret', AIMONITOR_REPLY_URL: 'http://monitor/reply' },
  })
  const result = await handler({
    channel: 'qqbot', accountId: 'default', senderId: 'user-1', messageId: 'message-1',
    content: '继续修复', bodyForAgent: `${quoted}\n继续修复`, isGroup: false,
    replyToIsQuote: true, replyToBody: quoted,
  }, { channelId: 'qqbot' })

  assert.deepEqual(result, { handled: true, reply: { text: '已转交到原 Codex 会话。' } })
  assert.equal(request.url, 'http://monitor/reply')
  assert.equal(request.options.headers.authorization, 'Bearer reply-secret')
  assert.deepEqual(JSON.parse(request.options.body), {
    channel: 'openclaw-qq', account_id: 'default', sender_id: 'user-1', message_id: 'message-1',
    text: '继续修复', reply_to_body: quoted, reply_to_is_quote: true, is_group: false,
  })
})

test('falls back to the ingest token when the reply token is blank', async () => {
  let authorization
  const handler = createInboundClaimHandler({
    fetchImpl: async (_url, options) => {
      authorization = options.headers.authorization
      return { ok: true, status: 202, json: async () => ({ ok: true }) }
    },
    environment: { AIMONITOR_REPLY_TOKEN: '   ', AIMONITOR_INGEST_TOKEN: 'ingest-secret' },
  })
  await handler({
    channel: 'qqbot', senderId: 'user-1', messageId: 'message-1', content: 'continue',
    isGroup: false, replyToIsQuote: true, replyToBody: quoted,
  }, { channelId: 'qqbot' })

  assert.equal(authorization, 'Bearer ingest-secret')
})

test('claims matched messages when Monitor rejects them', async () => {
  const handler = createInboundClaimHandler({
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ message: 'sender mismatch' }) }),
    environment: { AIMONITOR_REPLY_TOKEN: 'reply-secret' },
  })
  const result = await handler({
    channel: 'qqbot', senderId: 'user-1', messageId: 'message-1', content: 'continue',
    isGroup: false, replyToIsQuote: true, replyToBody: quoted,
  }, { channelId: 'qqbot' })
  assert.deepEqual(result, { handled: true, reply: { text: 'sender mismatch' } })
})
