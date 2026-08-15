import { execFileSync } from 'node:child_process'
import { platform } from 'node:os'
import { findWindowsDevCommand, findWindowsLinker } from './desktop-toolchain.mjs'

const currentPlatform = platform()
const isWindows = currentPlatform === 'win32'
const isMac = currentPlatform === 'darwin'
const errors = []
const warnings = []

function commandExists(command, args = ['--version']) {
  try {
    execFileSync(command, args, { stdio: 'pipe', windowsHide: true })
    return true
  } catch {
    return false
  }
}

function versionMajor(version) {
  const match = String(version).match(/v?(\d+)/)
  return match ? Number(match[1]) : 0
}

function nodeVersion() {
  try {
    return execFileSync(process.execPath, ['--version'], { encoding: 'utf8' }).trim()
  } catch {
    return process.version
  }
}

function checkCommon() {
  const node = nodeVersion()
  if (versionMajor(node) < 22) {
    errors.push(`Node.js ${node} 不满足要求，需要 Node 22.22.3+（推荐 24.15+）`)
  }
  if (!commandExists('cargo')) errors.push('缺少 Rust Cargo，请安装 rustup 和 stable toolchain')
  if (!commandExists('rustc')) errors.push('缺少 Rust 编译器 rustc，请安装 rustup 和 stable toolchain')
}

function checkWindows() {
  const linker = findWindowsLinker()
  const devCommand = findWindowsDevCommand()
  if (!linker && !devCommand) {
    errors.push('缺少 MSVC link.exe；请运行 scripts\\install-windows-desktop-runtime.ps1，并勾选 C++ 工作负载与 Windows SDK')
  } else if (!linker) {
    warnings.push('MSVC 已安装但未加载到当前终端；桌面构建脚本会自动加载 Visual Studio 环境。')
  }
  if (!commandExists('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'])) {
    errors.push('缺少 PowerShell，无法运行 Windows 桌面安装脚本')
  }
  warnings.push('WebView2 在 Windows 安装包中使用 embedBootstrapper；开发机若未安装，构建后的安装包会联网安装。')
}

function checkMac() {
  if (!commandExists('xcode-select', ['-p'])) {
    errors.push('缺少 Xcode Command Line Tools，请执行 xcode-select --install')
  }
  warnings.push('macOS 包必须在 macOS 本机生成；Intel 与 Apple Silicon 需要分别构建对应架构。')
}

checkCommon()
if (isWindows) checkWindows()
else if (isMac) checkMac()
else warnings.push(`当前平台 ${currentPlatform} 未提供原生桌面打包检查；请在 Windows 或 macOS 构建。`)

console.log(`AI Monitor desktop prerequisites (${currentPlatform})`)
console.log(`- Node: ${nodeVersion()}`)
console.log(`- Rust: ${commandExists('rustc') ? 'available' : 'missing'}`)
if (isWindows) {
  console.log(`- MSVC linker: ${findWindowsLinker() ?? (findWindowsDevCommand() ? 'installed (auto-load)' : 'missing')}`)
}
if (isMac) console.log(`- Xcode CLI tools: ${commandExists('xcode-select', ['-p']) ? 'available' : 'missing'}`)

for (const warning of warnings) console.warn(`WARN: ${warning}`)
if (errors.length > 0) {
  for (const error of errors) console.error(`ERROR: ${error}`)
  if (isWindows) {
    console.error('官方安装地址: https://aka.ms/vs/17/release/vs_BuildTools.exe')
  }
  process.exitCode = 1
} else {
  console.log('Desktop build prerequisites are ready.')
}
