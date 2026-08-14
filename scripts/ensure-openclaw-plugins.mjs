import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const definitions = [
  {
    id: 'openclaw-qqbot',
    packageName: '@tencent-connect/openclaw-qqbot',
    version: process.env.AI_MONITOR_QQBOT_PLUGIN_VERSION,
  },
  {
    id: 'openclaw-weixin',
    packageName: '@tencent-weixin/openclaw-weixin',
    version: process.env.AI_MONITOR_WEIXIN_PLUGIN_VERSION,
  },
]

for (const definition of definitions) {
  if (!definition.version) {
    throw new Error(`Missing required plugin version for ${definition.id}`)
  }
}

const runOpenClaw = (args, stdio = 'pipe') => {
  const command = process.platform === 'win32' ? process.execPath : 'openclaw'
  const commandArgs = process.platform === 'win32'
    ? [join(dirname(process.execPath), 'node_modules', 'openclaw', 'openclaw.mjs'), ...args]
    : args
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

let registry = loadRegistry()
for (const definition of definitions) {
  const plugin = registry.plugins?.find((item) => item.id === definition.id)
  const installedVersion = readPluginVersion(plugin)
  if (plugin?.status === 'loaded' && installedVersion === definition.version) continue

  console.log(`Installing ${definition.id} ${definition.version} into the OpenClaw state volume.`)
  const installArgs = [
    'plugins',
    'install',
    `${definition.packageName}@${definition.version}`,
    '--pin',
  ]
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
}
