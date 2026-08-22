import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPLY_PLUGIN_ID = 'ai-monitor-replies'
export const REPLY_PACKAGE_NAME = '@ai-monitor/openclaw-replies'

const resourceRoot = resolve(process.env.AIMONITOR_RESOURCE_ROOT?.trim() || resolve(dirname(fileURLToPath(import.meta.url)), '..'))
const envPath = join(resourceRoot, '.env')
if (existsSync(envPath)) process.loadEnvFile(envPath)
const configuredStateRoot = process.env.OPENCLAW_STATE_DIR?.trim()
const stateRoot = configuredStateRoot ? resolve(configuredStateRoot) : undefined

const openClawCliModule = () => {
  const candidates = [
    process.env.AIMONITOR_OPENCLAW_CLI_PATH?.trim(),
    process.env.AIMONITOR_RESOURCE_ROOT?.trim()
      ? join(process.env.AIMONITOR_RESOURCE_ROOT.trim(), 'node_modules', 'openclaw', 'openclaw.mjs')
      : undefined,
    join(resourceRoot, 'node_modules', 'openclaw', 'openclaw.mjs'),
    join(dirname(process.execPath), 'node_modules', 'openclaw', 'openclaw.mjs'),
  ].filter(Boolean)
  return candidates.find((candidate) => existsSync(candidate))
}

const runOpenClaw = (args, options = {}) => {
  const cliModule = openClawCliModule()
  const command = cliModule ? process.execPath : 'openclaw'
  const commandArgs = cliModule ? [cliModule, ...args] : args
  const env = {
    ...process.env,
    AIMONITOR_RESOURCE_ROOT: resourceRoot,
  }
  if (stateRoot) env.OPENCLAW_STATE_DIR = stateRoot
  const result = spawnSync(command, commandArgs, {
    encoding: 'utf8',
    env,
    stdio: options.stdio || 'pipe',
    windowsHide: true,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`OpenClaw command failed: openclaw ${args.slice(0, 3).join(' ')}`)
  }
  return result
}

export const markerPathFor = (root) => join(root, '.ai-monitor-openclaw')

const readPluginPackageName = (plugin) => {
  if (!plugin?.rootDir) return undefined
  try {
    return JSON.parse(readFileSync(join(plugin.rootDir, 'package.json'), 'utf8')).name
  } catch {
    return undefined
  }
}

export const uninstallReplyPlugin = ({
  run = runOpenClaw,
  root = stateRoot,
  fileExists = existsSync,
  removeFile = (path) => rmSync(path, { force: true }),
  packageNameFor = readPluginPackageName,
} = {}) => {
  const listResult = run(['plugins', 'list', '--json'])
  let registry
  try {
    registry = JSON.parse(listResult.stdout)
  } catch {
    throw new Error('OpenClaw returned invalid plugin metadata')
  }
  const installed = registry.plugins?.find((plugin) => plugin?.id === REPLY_PLUGIN_ID)
  if (installed && packageNameFor(installed) !== REPLY_PACKAGE_NAME) {
    throw new Error(`Refusing to uninstall unowned OpenClaw plugin id: ${REPLY_PLUGIN_ID}`)
  }
  if (installed) {
    run(['plugins', 'uninstall', REPLY_PLUGIN_ID, '--force'], { stdio: 'inherit' })
  }

  if (root) {
    const markerPath = markerPathFor(root)
    if (fileExists(markerPath)) removeFile(markerPath)
  }
  return installed ? 'uninstalled' : 'already-absent'
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    const result = uninstallReplyPlugin()
    process.stdout.write(`OpenClaw ${REPLY_PLUGIN_ID}: ${result}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
