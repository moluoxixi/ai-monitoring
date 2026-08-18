import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const plugin = require('./index.cjs')
const { createBeforeDispatchHandler, extractReplyToken, extractTaskId } = plugin
const token = 'A'.repeat(43)
const quoted = `任务结果：done\n\n[AI-MONITOR-REPLY:${token}]`
const taskOnlyQuote = '[任务ID:42]'

test('extracts exactly one route token', () => {
  assert.equal(extractReplyToken(quoted), token)
  assert.equal(extractReplyToken(`${quoted}\n${quoted}`), null)
  assert.equal(extractReplyToken('ordinary QQ message'), null)
})

test('extracts exactly one positive task ID', () => {
  assert.equal(extractTaskId(taskOnlyQuote), 42)
  assert.equal(extractTaskId(`${taskOnlyQuote}\n${taskOnlyQuote}`), null)
  assert.equal(extractTaskId('[任务ID:0]'), null)
  assert.equal(extractTaskId('[任务ID:not-a-number]'), null)
})

test('passes unrelated QQ messages through', async () => {
  let called = false
  const handler = createBeforeDispatchHandler({
    fetchImpl: async () => { called = true },
    environment: { AIMONITOR_REPLY_TOKEN: 'secret' },
  })
  const result = await handler({
    channel: 'qqbot', content: 'hello', isGroup: false,
  }, { channelId: 'qqbot' })
  assert.equal(result, undefined)
  assert.equal(called, false)
})

test('handles the QQBot 2.0.1 before_dispatch shape and posts normalized fields', async () => {
  let request
  const handler = createBeforeDispatchHandler({
    fetchImpl: async (url, options) => {
      request = { url, options }
      return { ok: true, status: 202, json: async () => ({ ok: true }) }
    },
    environment: { AIMONITOR_REPLY_TOKEN: 'reply-secret', AIMONITOR_REPLY_URL: 'http://monitor/reply' },
  })
  const result = await handler({
    channel: 'qqbot', senderId: 'user-1', replyToId: 'message-1',
    content: '继续修复', body: `${quoted}\n继续修复`, isGroup: false,
    replyToBody: quoted,
  }, { channelId: 'qqbot', accountId: 'default' })

  assert.deepEqual(result, { handled: true, text: '已转交到原 Codex 会话。' })
  assert.equal(request.url, 'http://monitor/reply')
  assert.equal(request.options.headers.authorization, 'Bearer reply-secret')
  assert.deepEqual(JSON.parse(request.options.body), {
    channel: 'openclaw-qq', account_id: 'default', sender_id: 'user-1', message_id: 'message-1',
    text: '继续修复', reply_to_body: quoted, reply_to_is_quote: true, is_group: false,
  })
})

test('claims a quoted task ID when QQ omits the opaque route token', async () => {
  let request
  const handler = createBeforeDispatchHandler({
    fetchImpl: async (url, options) => {
      request = { url, options }
      return { ok: true, status: 202, json: async () => ({ ok: true }) }
    },
    environment: { AIMONITOR_REPLY_TOKEN: 'reply-secret', AIMONITOR_REPLY_URL: 'http://monitor/reply' },
  })
  const result = await handler({
    channel: 'qqbot', senderId: 'user-1', replyToId: 'message-task-id',
    content: '继续修复', isGroup: false, replyToBody: taskOnlyQuote,
  }, { channelId: 'qqbot', accountId: 'default' })

  assert.deepEqual(result, { handled: true, text: '已转交到原 Codex 会话。' })
  assert.equal(JSON.parse(request.options.body).reply_to_body, taskOnlyQuote)
})

test('falls back to the ingest token when the reply token is blank', async () => {
  let authorization
  const handler = createBeforeDispatchHandler({
    fetchImpl: async (_url, options) => {
      authorization = options.headers.authorization
      return { ok: true, status: 202, json: async () => ({ ok: true }) }
    },
    environment: { AIMONITOR_REPLY_TOKEN: '   ', AIMONITOR_INGEST_TOKEN: 'ingest-secret' },
  })
  await handler({
    channel: 'qqbot', senderId: 'user-1', replyToId: 'message-1', content: 'continue',
    isGroup: false, replyToBody: quoted,
  }, { channelId: 'qqbot' })

  assert.equal(authorization, 'Bearer ingest-secret')
})

test('prefers persistent plugin config over stale process environment', async () => {
  let request
  const handler = createBeforeDispatchHandler({
    fetchImpl: async (url, options) => {
      request = { url, options }
      return { ok: true, status: 202, json: async () => ({ ok: true }) }
    },
    environment: {
      AIMONITOR_REPLY_TOKEN: 'stale-secret',
      AIMONITOR_REPLY_URL: 'http://stale/reply',
    },
    pluginConfig: {
      replyToken: 'current-secret',
      replyUrl: 'http://monitor/reply',
      timeoutMs: 1_000,
    },
  })
  await handler({
    channel: 'qqbot', senderId: 'user-1', replyToId: 'message-1', content: 'continue',
    isGroup: false, replyToBody: quoted,
  }, { channelId: 'qqbot' })

  assert.equal(request.url, 'http://monitor/reply')
  assert.equal(request.options.headers.authorization, 'Bearer current-secret')
})

test('claims matched messages when Monitor rejects them', async () => {
  const handler = createBeforeDispatchHandler({
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ message: 'sender mismatch' }) }),
    environment: { AIMONITOR_REPLY_TOKEN: 'reply-secret' },
  })
  const result = await handler({
    channel: 'qqbot', senderId: 'user-1', replyToId: 'message-1', content: 'continue',
    isGroup: false, replyToBody: quoted,
  }, { channelId: 'qqbot' })
  assert.deepEqual(result, { handled: true, text: 'sender mismatch' })
})

test('registers the global hook that ordinary QQ conversations actually execute', () => {
  let registration
  plugin.register({
    pluginConfig: { replyToken: 'secret' },
    on: (name, handler, options) => { registration = { name, handler, options } },
  })

  assert.equal(registration.name, 'before_dispatch')
  assert.equal(typeof registration.handler, 'function')
  assert.deepEqual(registration.options, { priority: 100, timeoutMs: 60_000 })
})

test('declares hook capability so Gateway startup loads the plugin', () => {
  const manifest = JSON.parse(readFileSync(new URL('./openclaw.plugin.json', import.meta.url), 'utf8'))
  assert.deepEqual(manifest.activation?.onCapabilities, ['hook'])
})
