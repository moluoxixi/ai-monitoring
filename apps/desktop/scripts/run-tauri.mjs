import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findWindowsDevCommand, findWindowsLinker } from '../../../scripts/desktop-toolchain.mjs'

const mode = process.argv[2]
if (!['dev', 'build'].includes(mode)) {
  throw new Error('Usage: node scripts/run-tauri.mjs <dev|build>')
}

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const projectRoot = resolve(desktopRoot, '../..')
const tauriCommand = join(projectRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tauri.cmd' : 'tauri')
if (!existsSync(tauriCommand)) {
  throw new Error('Tauri CLI is not installed. Run npm install from the repository root.')
}

let result
if (process.platform === 'win32' && !findWindowsLinker()) {
  const devCommand = findWindowsDevCommand()
  if (!devCommand) {
    throw new Error('Visual Studio C++ Build Tools are not installed. Run npm run desktop:install-windows-runtime.')
  }
  const architecture = process.arch === 'arm64' ? 'arm64' : 'amd64'
  const scriptsRoot = dirname(fileURLToPath(import.meta.url))
  result = spawnSync('cmd.exe', ['/d', '/c', 'run-tauri-windows.cmd'], {
    cwd: scriptsRoot,
    env: {
      ...process.env,
      AIMONITOR_DESKTOP_ROOT: desktopRoot,
      AIMONITOR_TAURI_CMD: tauriCommand,
      AIMONITOR_TAURI_MODE: mode,
      AIMONITOR_VSDEVCMD: devCommand,
      AIMONITOR_VS_ARCH: architecture,
    },
    stdio: 'inherit',
    windowsHide: false,
  })
} else {
  result = spawnSync(tauriCommand, [mode], {
    cwd: desktopRoot,
    env: process.env,
    stdio: 'inherit',
  })
}

if (result.error) throw result.error
process.exitCode = result.status ?? 1
