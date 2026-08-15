import { chmodSync, cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const projectRoot = resolve(desktopRoot, '../..')
const resourceRoot = join(desktopRoot, 'src-tauri', 'resources')
const serverDist = join(projectRoot, 'apps', 'server', 'dist')
const webDist = join(projectRoot, 'apps', 'web', 'dist')
const scriptsRoot = join(projectRoot, 'scripts')
const openClawVersion = process.env.AIMONITOR_OPENCLAW_VERSION || '2026.7.1-2'
const qqPluginVersion = process.env.AI_MONITOR_QQBOT_PLUGIN_VERSION || '2.0.1'
const weixinPluginVersion = process.env.AI_MONITOR_WEIXIN_PLUGIN_VERSION || '2.4.6'
const skipOpenClaw = process.env.AIMONITOR_DESKTOP_SKIP_OPENCLAW_INSTALL === '1'
const reuseResources = process.env.AIMONITOR_DESKTOP_REUSE_RESOURCES === '1'

for (const required of [serverDist, webDist, scriptsRoot]) {
  if (!existsSync(required)) throw new Error(`缺少桌面包资源，请先构建: ${required}`)
}

if (reuseResources) {
  const requiredResources = [
    join(resourceRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
    join(resourceRoot, 'apps', 'server', 'dist', 'main.js'),
    join(resourceRoot, 'apps', 'web', 'dist', 'index.html'),
    join(resourceRoot, 'node_modules', 'better-sqlite3'),
    join(resourceRoot, 'node_modules', 'openclaw', 'openclaw.mjs'),
  ]
  if (requiredResources.every((resource) => existsSync(resource))) {
    console.log(`Reusing prepared desktop resources at ${resourceRoot}`)
    process.exit(0)
  }
  throw new Error('AIMONITOR_DESKTOP_REUSE_RESOURCES=1 was set, but prepared resources are incomplete')
}

rmSync(resourceRoot, { recursive: true, force: true })
mkdirSync(resourceRoot, { recursive: true })
cpSync(serverDist, join(resourceRoot, 'apps', 'server', 'dist'), { recursive: true })
cpSync(webDist, join(resourceRoot, 'apps', 'web', 'dist'), { recursive: true })
cpSync(scriptsRoot, join(resourceRoot, 'scripts'), { recursive: true })

const runtimeDir = join(resourceRoot, 'runtime')
mkdirSync(runtimeDir, { recursive: true })
const runtimeName = process.platform === 'win32' ? 'node.exe' : 'node'
const runtimePath = join(runtimeDir, runtimeName)
copyFileSync(process.env.AIMONITOR_NODE_RUNTIME || process.execPath, runtimePath)
if (process.platform !== 'win32') chmodSync(runtimePath, 0o755)

const serverPackage = JSON.parse(readFileSync(join(projectRoot, 'apps', 'server', 'package.json'), 'utf8'))
const dependencies = {
  ...serverPackage.dependencies,
  ...(skipOpenClaw ? {} : {
    openclaw: openClawVersion,
    '@tencent-connect/openclaw-qqbot': qqPluginVersion,
    '@tencent-weixin/openclaw-weixin': weixinPluginVersion,
  }),
}
const packagePath = join(resourceRoot, 'package.json')
writeFileSync(packagePath, `${JSON.stringify({
  name: 'ai-monitor-runtime',
  private: true,
  version: serverPackage.version,
  dependencies,
}, null, 2)}\n`)

if (process.env.AIMONITOR_DESKTOP_SKIP_NPM_INSTALL !== '1') {
  const npmArguments = [
    'install',
    '--omit=dev',
    '--legacy-peer-deps',
    '--ignore-scripts=false',
    '--no-audit',
    '--no-fund',
    '--prefix',
    resourceRoot,
  ]
  const npmCli = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find((candidate) => candidate && existsSync(candidate))
  if (process.platform === 'win32' && !npmCli) {
    throw new Error('无法定位 npm CLI；请使用包含 npm 的官方 Node.js 发行版构建桌面包')
  }
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...npmArguments], { cwd: projectRoot, stdio: 'inherit' })
    : spawnSync('npm', npmArguments, { cwd: projectRoot, stdio: 'inherit' })
  if (result.error || result.status !== 0) {
    throw new Error(`桌面 sidecar 生产依赖安装失败${result.error ? `: ${result.error.message}` : ''}`)
  }
}

if (!skipOpenClaw) {
  const stateTemplate = join(resourceRoot, 'openclaw-state-template')
  rmSync(stateTemplate, { recursive: true, force: true })
  mkdirSync(stateTemplate, { recursive: true })
  const setupEnvironment = {
    ...process.env,
    AIMONITOR_RESOURCE_ROOT: resourceRoot,
    AIMONITOR_PROJECT_ROOT: resourceRoot,
    AIMONITOR_DATA_ROOT: stateTemplate,
    OPENCLAW_STATE_DIR: stateTemplate,
    AIMONITOR_OPENCLAW_CLI_PATH: join(resourceRoot, 'node_modules', 'openclaw', 'openclaw.mjs'),
    AIMONITOR_OPENCLAW_VERSION: openClawVersion,
    AI_MONITOR_QQBOT_PLUGIN_VERSION: qqPluginVersion,
    AI_MONITOR_WEIXIN_PLUGIN_VERSION: weixinPluginVersion,
  }
  for (const script of ['ensure-openclaw-plugins.mjs', 'patch-openclaw-weixin.mjs']) {
    const result = spawnSync(process.execPath, [join(resourceRoot, 'scripts', script)], {
      cwd: resourceRoot,
      env: setupEnvironment,
      stdio: 'inherit',
      windowsHide: true,
    })
    if (result.error || result.status !== 0) {
      throw new Error(`OpenClaw 插件准备失败: ${script}${result.error ? `: ${result.error.message}` : ''}`)
    }
  }
}

// Node resolves dependencies through resources/node_modules. The package metadata
// is only a build-time input and is intentionally omitted from the shipped bundle.
rmSync(packagePath, { force: true })
rmSync(join(resourceRoot, 'package-lock.json'), { force: true })
console.log(`Desktop resources prepared at ${resourceRoot}`)
