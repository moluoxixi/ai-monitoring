import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

const resourceRoot = resolve(process.env.AIMONITOR_RESOURCE_ROOT || resolve(import.meta.dirname, '..'))
const dataRoot = resolve(process.env.AIMONITOR_DATA_ROOT || join(resourceRoot, 'data'))
const stateRoot = resolve(process.env.OPENCLAW_STATE_DIR || join(dataRoot, 'openclaw-state'))
const templateRoot = join(resourceRoot, 'openclaw-state-template')
const openClawVersion = process.env.AIMONITOR_OPENCLAW_VERSION || '2026.7.1-2'
const qqPluginVersion = process.env.AI_MONITOR_QQBOT_PLUGIN_VERSION || '2.0.1'
const weixinPluginVersion = process.env.AI_MONITOR_WEIXIN_PLUGIN_VERSION || '2.4.6'
const replyPluginVersion = '1.0.4'
const replyToken = process.env.AIMONITOR_REPLY_TOKEN?.trim()
  || process.env.AIMONITOR_INGEST_TOKEN?.trim()
  || ''
const replyUrl = process.env.AIMONITOR_REPLY_URL?.trim()
  || 'http://127.0.0.1:8787/api/replies/inbound'
const configuredReplyTimeout = Number(process.env.AIMONITOR_REPLY_TIMEOUT_MS || 30_000)
const replyTimeoutMs = Number.isFinite(configuredReplyTimeout)
  ? Math.max(1_000, Math.min(configuredReplyTimeout, 60_000))
  : 30_000
const replyConfig = createHash('sha256')
  .update(JSON.stringify({ replyToken, replyUrl, replyTimeoutMs }))
  .digest('hex')
const markerPath = join(stateRoot, '.ai-monitor-openclaw')

const copyTemplate = () => {
  if (!existsSync(templateRoot)) return
  mkdirSync(stateRoot, { recursive: true })
  if (readdirSync(stateRoot).length > 0) return
  for (const entry of readdirSync(templateRoot)) {
    cpSync(join(templateRoot, entry), join(stateRoot, entry), { recursive: true })
  }
}

const readMarker = () => {
  if (!existsSync(markerPath)) return null
  try {
    return JSON.parse(readFileSync(markerPath, 'utf8'))
  } catch {
    return null
  }
}

const expected = {
  openclaw: openClawVersion,
  qqbot: qqPluginVersion,
  weixin: weixinPluginVersion,
  replies: replyPluginVersion,
  replyConfig,
}

copyTemplate()
mkdirSync(stateRoot, { recursive: true })
const current = readMarker()
if (current && Object.entries(expected).every(([key, value]) => current[key] === value)) {
  process.stdout.write(`OpenClaw state is ready at ${stateRoot}\n`)
  process.exit(0)
}

const env = {
  ...process.env,
  AIMONITOR_RESOURCE_ROOT: resourceRoot,
  AIMONITOR_PROJECT_ROOT: resourceRoot,
  AIMONITOR_DATA_ROOT: dataRoot,
  OPENCLAW_STATE_DIR: stateRoot,
  AI_MONITOR_QQBOT_PLUGIN_VERSION: qqPluginVersion,
  AI_MONITOR_WEIXIN_PLUGIN_VERSION: weixinPluginVersion,
}
const run = (script) => {
  const result = spawnSync(process.execPath, [join(resourceRoot, 'scripts', script)], {
    cwd: resourceRoot,
    env,
    encoding: 'utf8',
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`OpenClaw 初始化失败: ${script}${result.error ? ` (${result.error.message})` : ''}`)
  }
}

run('ensure-openclaw-plugins.mjs')
run('patch-openclaw-weixin.mjs')
writeFileSync(markerPath, `${JSON.stringify(expected, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
process.stdout.write(`OpenClaw plugins are ready at ${stateRoot}\n`)
