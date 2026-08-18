#!/usr/bin/env node

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { MANIFEST_PATH } from './constants.mjs'
import { readManifest } from './core/operations.mjs'
import { planOwnedRemoval } from './core/ownership.mjs'
import { assertProjectIsNotHome, assertSafeProject, assertSafeTarget } from './core/safety.mjs'

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write('Usage: node uninstall-project.mjs --project <path> [--dry-run] [-y|--yes] [--force]\n')
    return
  }
  const projectRoot = assertSafeProject(options.project)
  assertProjectIsNotHome(projectRoot)
  const workflowRoot = path.join(projectRoot, '.moluoxixi')
  if (!fs.existsSync(workflowRoot)) {
    process.stdout.write(`${JSON.stringify({ projectRoot, installed: false }, null, 2)}\n`)
    return
  }
  const manifestTarget = assertSafeTarget(projectRoot, MANIFEST_PATH)
  if (!fs.existsSync(manifestTarget))
    throw new Error(`Moluoxixi manifest is missing: ${MANIFEST_PATH}`)
  const manifest = readManifest(projectRoot)
  const operations = []
  const summary = { projectRoot, dryRun: options.dryRun, force: options.force, conflicts: [], removed: [], restored: [] }

  for (const [relativePath, entry] of Object.entries(manifest.entries)) {
    const target = assertSafeTarget(projectRoot, relativePath)
    const stats = fs.lstatSync(target, { throwIfNoEntry: false })
    if (!stats) {
      operations.push({ action: 'forget', relativePath, target })
      summary.removed.push(relativePath)
      continue
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      summary.conflicts.push(relativePath)
      continue
    }
    const removal = planOwnedRemoval(fs.readFileSync(target), entry, options.force)
    if (removal.action === 'conflict') {
      summary.conflicts.push(relativePath)
      continue
    }
    operations.push({ ...removal, relativePath, target })
    summary[removal.action === 'write' ? 'restored' : 'removed'].push(relativePath)
  }
  for (const key of ['conflicts', 'removed', 'restored'])
    summary[key].sort()

  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    if (summary.conflicts.length > 0)
      process.exitCode = 2
    return
  }
  if (!options.yes && !await confirmUninstall(summary))
    return
  if (!options.dryRun)
    commit(projectRoot, manifest, operations, summary.conflicts)
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  if (summary.conflicts.length > 0)
    process.exitCode = 2
}

function commit(projectRoot, manifest, operations, conflicts) {
  const journal = []
  const createdDirs = []
  const manifestTarget = assertSafeTarget(projectRoot, MANIFEST_PATH)
  try {
    for (const operation of operations) {
      if (operation.action === 'forget')
        continue
      if (operation.action === 'delete')
        moveToBackup(operation.target, journal)
      else transactionalWrite(operation.target, operation.content, projectRoot, createdDirs, journal)
    }
    if (conflicts.length > 0) {
      const nextEntries = { ...manifest.entries }
      for (const operation of operations)
        delete nextEntries[operation.relativePath]
      const nextManifest = Buffer.from(`${JSON.stringify({ ...manifest, schemaVersion: 2, entries: nextEntries }, null, 2)}\n`)
      transactionalWrite(manifestTarget, nextManifest, projectRoot, createdDirs, journal)
    }
    else {
      moveToBackup(manifestTarget, journal)
    }
  }
  catch (error) {
    rollback(journal, createdDirs)
    throw new Error(`Uninstall failed and was rolled back: ${String(error)}`)
  }
  for (const entry of journal) {
    if (entry.backup)
      removeBestEffort(entry.backup)
  }
  for (const operation of operations)
    removeEmptyParents(operation.target, projectRoot)
  if (conflicts.length === 0)
    removeEmptyParents(manifestTarget, projectRoot)
}

function transactionalWrite(target, content, projectRoot, createdDirs, journal) {
  ensureParent(target, projectRoot, createdDirs)
  const temporary = `${target}.airules-new-${randomUUID()}`
  fs.writeFileSync(temporary, content, { flag: 'wx' })
  const entry = moveToBackup(target, journal, false)
  entry.temporary = temporary
  fs.renameSync(temporary, target)
  entry.installed = true
}

function moveToBackup(target, journal, requireExisting = true) {
  const exists = fs.existsSync(target)
  if (requireExisting && !exists)
    return { target }
  const entry = { backup: exists ? `${target}.airules-old-${randomUUID()}` : undefined, installed: false, target }
  journal.push(entry)
  if (entry.backup)
    fs.renameSync(target, entry.backup)
  return entry
}

function rollback(journal, createdDirs) {
  for (const entry of [...journal].reverse()) {
    try {
      if (entry.installed)
        fs.rmSync(entry.target, { force: true })
      if (entry.temporary)
        fs.rmSync(entry.temporary, { force: true })
      if (entry.backup && fs.existsSync(entry.backup))
        fs.renameSync(entry.backup, entry.target)
    }
    catch {}
  }
  for (const directory of [...createdDirs].reverse()) {
    try {
      fs.rmdirSync(directory)
    }
    catch {}
  }
}

function ensureParent(target, projectRoot, createdDirs) {
  const parent = path.dirname(target)
  if (parent === projectRoot || fs.existsSync(parent))
    return
  ensureParent(parent, projectRoot, createdDirs)
  fs.mkdirSync(parent)
  createdDirs.push(parent)
}

function removeEmptyParents(target, projectRoot) {
  let current = path.dirname(target)
  while (current !== projectRoot) {
    try {
      fs.rmdirSync(current)
    }
    catch {
      break
    }
    current = path.dirname(current)
  }
}

function removeBestEffort(target) {
  try {
    fs.rmSync(target, { force: true })
  }
  catch {}
}

function parseArgs(argv) {
  const result = { dryRun: false, force: false, project: '.', yes: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run')
      result.dryRun = true
    else if (arg === '--force')
      result.force = true
    else if (arg === '--yes' || arg === '-y')
      result.yes = true
    else if (arg === '--project')
      result.project = requireValue(argv, ++index, arg)
    else if (arg === '--help' || arg === '-h')
      result.help = true
    else throw new Error(`Unknown uninstall option: ${arg}`)
  }
  return result
}

async function confirmUninstall(summary) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('Non-interactive uninstall requires --yes')
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await terminal.question('Proceed with uninstall? [y/N] ')).trim().toLowerCase()
    return answer === 'y' || answer === 'yes'
  }
  finally {
    terminal.close()
  }
}

function requireValue(argv, index, flag) {
  const value = argv[index]
  if (!value || value.startsWith('--'))
    throw new Error(`${flag} requires a value`)
  return value
}

try {
  await main()
}
catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
