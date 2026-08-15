import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function isWindowsMsvcLinkerPath(candidate) {
  const normalized = String(candidate ?? '').replaceAll('/', '\\').toLowerCase()
  return normalized.endsWith('\\link.exe') && normalized.includes('\\vc\\tools\\msvc\\')
}

function linkerFromOutput(output) {
  return String(output)
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => isWindowsMsvcLinkerPath(value) && existsSync(value)) ?? null
}

export function findWindowsLinker() {
  if (process.platform !== 'win32') return null
  try {
    const powershellPath = linkerFromOutput(execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command', '(Get-Command link.exe -ErrorAction SilentlyContinue).Source'],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    ))
    if (powershellPath) return powershellPath
  } catch {
    // Fall through to where.exe for shells that do not expose Get-Command.
  }
  try {
    return linkerFromOutput(execFileSync('where.exe', ['link.exe'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }))
  } catch {
    return null
  }
}

export function findWindowsDevCommand() {
  if (process.platform !== 'win32') return null
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const vsWhere = join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  if (existsSync(vsWhere)) {
    try {
      const installationPath = execFileSync(
        vsWhere,
        [
          '-latest',
          '-products',
          '*',
          '-requires',
          'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
          '-property',
          'installationPath',
        ],
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim()
      const devCommand = join(installationPath, 'Common7', 'Tools', 'VsDevCmd.bat')
      if (installationPath && existsSync(devCommand)) return devCommand
    } catch {
      // Fall through to the standard Build Tools path.
    }
  }
  const standardPath = join(
    programFilesX86,
    'Microsoft Visual Studio',
    '2022',
    'BuildTools',
    'Common7',
    'Tools',
    'VsDevCmd.bat',
  )
  return existsSync(standardPath) ? standardPath : null
}
