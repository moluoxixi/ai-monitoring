import { spawnSync } from 'node:child_process'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const PROXY_VARIABLES = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']

export function reexecWithEnvProxy(moduleUrl) {
  const proxyConfigured = PROXY_VARIABLES.some(name => Boolean(process.env[name]))
  if (!proxyConfigured || process.env.MOLUOXIXI_ENV_PROXY_ACTIVE === '1')
    return false
  if (!process.allowedNodeEnvironmentFlags.has('--use-env-proxy'))
    throw new Error('This Node.js version cannot apply HTTP_PROXY/HTTPS_PROXY to registry downloads')
  const result = spawnSync(process.execPath, [
    '--use-env-proxy',
    fileURLToPath(moduleUrl),
    ...process.argv.slice(2),
  ], {
    env: { ...process.env, MOLUOXIXI_ENV_PROXY_ACTIVE: '1' },
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error)
    throw result.error
  process.exitCode = result.status ?? 1
  return true
}

export function runWithEnvProxy(moduleUrl, main) {
  try {
    if (reexecWithEnvProxy(moduleUrl))
      return
    Promise.resolve(main()).catch(reportError)
  }
  catch (error) {
    reportError(error)
  }
}

function reportError(error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
