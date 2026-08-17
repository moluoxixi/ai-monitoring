#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const RUNTIME_DIR = path.dirname(fileURLToPath(import.meta.url))
const VERSION = '0.2.0'
const PROJECT_ROOT_DIR = '.moluoxixi'

function findProjectRoot(start = process.cwd()) {
  let current = path.resolve(start)
  while (true) {
    if (fs.existsSync(path.join(current, PROJECT_ROOT_DIR)))
      return current
    const parent = path.dirname(current)
    if (parent === current)
      break
    current = parent
  }
  if (path.basename(path.dirname(RUNTIME_DIR)) === PROJECT_ROOT_DIR)
    return path.resolve(RUNTIME_DIR, '..', '..')
  throw new Error(`No ${PROJECT_ROOT_DIR} directory found from ${start}`)
}

function runNode(entry, args) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  })
  if (result.error)
    throw result.error
  process.exitCode = result.status ?? 1
}

function parseValue(args, index, flag) {
  const value = args[index + 1]
  if (!value || value.startsWith('-'))
    throw new Error(`${flag} requires a value`)
  return value
}

function update(args) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write('Usage: moluoxixi.mjs update [--platform <ids>] [--dry-run] [-f|--force] [-n|--create-new] [-s|--skip-all] [--migrate] [--allow-downgrade] [--with-statusline] [--python <command>]\n')
    return
  }
  const projectRoot = findProjectRoot()
  const manifestPath = path.join(projectRoot, PROJECT_ROOT_DIR, 'airules-init-manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const forwarded = ['--project', projectRoot]
  const platforms = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = { '-f': '--force', '-n': '--create-new', '-s': '--skip-all' }[args[index]] ?? args[index]
    if (arg === '--dry-run' || arg === '--force' || arg === '--with-statusline' || arg === '--create-new' || arg === '--skip-all' || arg === '--migrate' || arg === '--allow-downgrade' || arg === '--monorepo' || arg === '--no-monorepo' || arg === '--overwrite' || arg === '--append') {
      forwarded.push(arg)
    }
    else if (arg === '--platform') {
      platforms.push(...parseValue(args, index++, arg).split(','))
    }
    else if (arg === '--python' || arg === '--developer' || arg === '--default-package' || arg === '--package' || arg === '--package-template' || arg === '--package-registry' || arg === '--project-type' || arg === '--workflow' || arg === '--workflow-source' || arg === '--template' || arg === '--registry' || arg === '--marketplace') {
      forwarded.push(arg, parseValue(args, index++, arg))
    }
    else {
      throw new Error(`Unsupported AIRules update option: ${arg}`)
    }
  }

  const selected = platforms.length > 0 ? platforms : manifest.platforms
  if (!Array.isArray(selected) || selected.length === 0)
    throw new Error('Cannot infer initialized platforms; pass --platform')
  forwarded.push('--platform', selected.join(','))

  const projectUpdater = path.join(projectRoot, PROJECT_ROOT_DIR, 'runtime', 'update', 'init-project', 'scripts', 'init-project.mjs')
  const bundledUpdater = path.resolve(RUNTIME_DIR, '..', '..', 'scripts', 'init-project.mjs')
  const entry = fs.existsSync(projectUpdater) ? projectUpdater : bundledUpdater
  if (!fs.existsSync(entry))
    throw new Error('AIRules updater assets are missing; re-run the init-project skill')
  runNode(entry, forwarded)
}

function workflow(args) {
  if (args.includes('--help') || args.includes('-h')) {
    const bundledWorkflow = path.resolve(RUNTIME_DIR, '..', '..', 'scripts', 'workflow-project.mjs')
    if (!fs.existsSync(bundledWorkflow)) {
      process.stdout.write('Usage: moluoxixi.mjs workflow [-t|--template <id>] [-m|--marketplace <source>] [-f|--force] [-n|--create-new] [--list]\n')
      return
    }
    runNode(bundledWorkflow, args)
    return
  }
  const projectRoot = findProjectRoot()
  const projectWorkflow = path.join(projectRoot, PROJECT_ROOT_DIR, 'runtime', 'update', 'init-project', 'scripts', 'workflow-project.mjs')
  const bundledWorkflow = path.resolve(RUNTIME_DIR, '..', '..', 'scripts', 'workflow-project.mjs')
  const entry = fs.existsSync(projectWorkflow) ? projectWorkflow : bundledWorkflow
  if (!fs.existsSync(entry))
    throw new Error('AIRules workflow assets are missing; re-run the init-project skill')
  runNode(entry, ['--project', projectRoot, ...args])
}

function uninstall(args) {
  if (args.includes('--help') || args.includes('-h')) {
    const bundledUninstaller = path.resolve(RUNTIME_DIR, '..', '..', 'scripts', 'uninstall-project.mjs')
    if (!fs.existsSync(bundledUninstaller)) {
      process.stdout.write('Usage: moluoxixi.mjs uninstall [-y|--yes] [--dry-run] [--force]\n')
      return
    }
    runNode(bundledUninstaller, args)
    return
  }
  const projectRoot = findProjectRoot()
  const projectUninstaller = path.join(projectRoot, PROJECT_ROOT_DIR, 'runtime', 'update', 'init-project', 'scripts', 'uninstall-project.mjs')
  const bundledUninstaller = path.resolve(RUNTIME_DIR, '..', '..', 'scripts', 'uninstall-project.mjs')
  const entry = fs.existsSync(projectUninstaller) ? projectUninstaller : bundledUninstaller
  if (!fs.existsSync(entry))
    throw new Error('AIRules uninstaller assets are missing; re-run the init-project skill')
  runNode(entry, ['--project', projectRoot, ...args])
}

function spec(args) {
  const projectRoot = findProjectRoot()
  const entry = path.join(projectRoot, PROJECT_ROOT_DIR, 'scripts', 'spec-proposals.mjs')
  if (!fs.existsSync(entry))
    throw new Error('Spec proposal tooling is missing; re-run the init-project skill')
  runNode(entry, args)
}

function printHelp() {
  process.stdout.write(`Moluoxixi runtime ${VERSION}\n\nUsage: node moluoxixi.mjs <command> [options]\n       node moluoxixi.mjs -v|--version\n\nCommands:\n  channel    Durable local multi-agent channels and workers\n  mem        Search local Claude, Codex, and Pi conversation history\n  spec       Propose, review, audit, and promote project knowledge\n  workflow   List or replace the active project workflow\n  update     Refresh AIRules-owned project assets\n  uninstall  Remove manifest-owned project assets safely\n  version    Print the runtime version\n`)
}

try {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === '--help' || command === '-h' || command === 'help')
    printHelp()
  else if (command === '--version' || command === '-v' || command === '-V' || command === 'version')
    process.stdout.write(`${VERSION}\n`)
  else if (command === 'channel' || command === 'mem')
    runNode(path.join(RUNTIME_DIR, 'vendor', 'channel-mem.mjs'), [command, ...args])
  else if (command === 'update')
    update(args)
  else if (command === 'workflow')
    workflow(args)
  else if (command === 'spec')
    spec(args)
  else if (command === 'uninstall')
    uninstall(args)
  else throw new Error(`Unknown command: ${command}`)
}
catch (error) {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
