import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const resourceRoot = resolve(process.env.AIMONITOR_RESOURCE_ROOT?.trim() || resolve(dirname(fileURLToPath(import.meta.url)), '..'))
const envPath = join(resourceRoot, '.env')
if (existsSync(envPath)) process.loadEnvFile(envPath)

const definitions = [
  {
    id: 'openclaw-qqbot',
    packageName: '@tencent-connect/openclaw-qqbot',
    version: process.env.AI_MONITOR_QQBOT_PLUGIN_VERSION || '2.0.1',
  },
  {
    id: 'openclaw-weixin',
    packageName: '@tencent-weixin/openclaw-weixin',
    version: process.env.AI_MONITOR_WEIXIN_PLUGIN_VERSION || '2.4.6',
  },
  {
    id: 'ai-monitor-replies',
    localPath: process.env.AIMONITOR_REPLY_PLUGIN_PATH?.trim()
      || join(resourceRoot, 'plugins', 'openclaw-ai-monitor-replies'),
    version: '1.0.5',
    requiredHook: 'before_dispatch',
    requiredStartupCapability: 'hook',
  },
]

const openClawCliModule = () => {
  const candidates = [
    process.env.AIMONITOR_OPENCLAW_CLI_PATH?.trim(),
    process.env.AIMONITOR_RESOURCE_ROOT?.trim()
      ? join(process.env.AIMONITOR_RESOURCE_ROOT.trim(), 'node_modules', 'openclaw', 'openclaw.mjs')
      : undefined,
    join(dirname(process.execPath), 'node_modules', 'openclaw', 'openclaw.mjs'),
  ].filter(Boolean)
  return candidates.find((candidate) => existsSync(candidate))
}

for (const definition of definitions) {
  if (!definition.version) {
    throw new Error(`Missing required plugin version for ${definition.id}`)
  }
}

const runOpenClaw = (args, stdio = 'pipe') => {
  const cliModule = openClawCliModule()
  const command = cliModule ? process.execPath : 'openclaw'
  const commandArgs = cliModule ? [cliModule, ...args] : args
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    stdio,
    windowsHide: true,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`OpenClaw command failed: openclaw ${args.slice(0, 2).join(' ')}`)
  }
  return result
}

const loadRegistry = () => {
  const result = runOpenClaw(['plugins', 'list', '--json'])
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error('OpenClaw returned invalid plugin metadata')
  }
}

const readPluginVersion = (plugin) => {
  if (!plugin?.rootDir) return undefined
  try {
    return JSON.parse(readFileSync(join(plugin.rootDir, 'package.json'), 'utf8')).version
  } catch {
    return undefined
  }
}

const verifyStartupCapability = (definition, plugin) => {
  if (!definition.requiredStartupCapability) return
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(plugin.rootDir, 'openclaw.plugin.json'), 'utf8'))
  } catch {
    throw new Error(`OpenClaw plugin ${definition.id} has no readable manifest`)
  }
  const capabilities = manifest?.activation?.onCapabilities
  if (!Array.isArray(capabilities) || !capabilities.includes(definition.requiredStartupCapability)) {
    throw new Error(
      `OpenClaw plugin ${definition.id} is not eligible for Gateway startup capability ${definition.requiredStartupCapability}`,
    )
  }
}

const verifyRuntimeHook = (definition) => {
  if (!definition.requiredHook) return
  const result = runOpenClaw(['plugins', 'inspect', definition.id, '--runtime', '--json'])
  let payload
  try {
    payload = JSON.parse(result.stdout)
  } catch {
    throw new Error(`OpenClaw returned invalid runtime metadata for ${definition.id}`)
  }
  const hooks = Array.isArray(payload?.typedHooks) ? payload.typedHooks : []
  if (!hooks.some((hook) => hook?.name === definition.requiredHook)) {
    throw new Error(`OpenClaw plugin ${definition.id} did not register ${definition.requiredHook}`)
  }
}

const configureReplyPlugin = () => {
  const replyToken = process.env.AIMONITOR_REPLY_TOKEN?.trim()
    || process.env.AIMONITOR_INGEST_TOKEN?.trim()
  if (!replyToken) return
  const replyUrl = process.env.AIMONITOR_REPLY_URL?.trim()
    || 'http://127.0.0.1:8787/api/replies/inbound'
  const configuredTimeout = Number(process.env.AIMONITOR_REPLY_TIMEOUT_MS || 30_000)
  const timeoutMs = Number.isFinite(configuredTimeout)
    ? Math.max(1_000, Math.min(configuredTimeout, 60_000))
    : 30_000
  runOpenClaw([
    'config',
    'set',
    'plugins.entries.ai-monitor-replies.config',
    JSON.stringify({ replyToken, replyUrl, timeoutMs }),
    '--strict-json',
  ])
}

let registry = loadRegistry()
for (const definition of definitions) {
  const plugin = registry.plugins?.find((item) => item.id === definition.id)
  const installedVersion = readPluginVersion(plugin)
  if (plugin?.status === 'loaded' && installedVersion === definition.version) {
    verifyStartupCapability(definition, plugin)
    verifyRuntimeHook(definition)
    continue
  }

  console.log(`Installing ${definition.id} ${definition.version} into the OpenClaw state volume.`)
  const installArgs = [
    'plugins',
    'install',
    definition.localPath || `${definition.packageName}@${definition.version}`,
  ]
  if (!definition.localPath) installArgs.push('--pin')
  if (plugin) installArgs.push('--force')
  runOpenClaw(
    installArgs,
    'inherit',
  )
  registry = loadRegistry()

  const installed = registry.plugins?.find((item) => item.id === definition.id)
  if (installed?.status !== 'loaded' || readPluginVersion(installed) !== definition.version) {
    throw new Error(`OpenClaw plugin ${definition.id} did not load at version ${definition.version}`)
  }
  verifyStartupCapability(definition, installed)
  verifyRuntimeHook(definition)
}

configureReplyPlugin()
