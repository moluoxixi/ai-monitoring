#!/usr/bin/env node

import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { MANIFEST_PATH, PROJECT_ROOT_DIR, sha256, UPSTREAM_BRAND } from './constants.mjs'
import { readManifest } from './core/operations.mjs'
import { runWithEnvProxy } from './core/proxy.mjs'
import { listWorkflowTemplates, resolveWorkflowTemplate } from './core/registry.mjs'
import { assertProjectIsNotHome, assertSafeProject, assertSafeTarget } from './core/safety.mjs'
import { readTemplateFile } from './templates.mjs'

const UPSTREAM_TITLE = `${UPSTREAM_BRAND[0].toUpperCase()}${UPSTREAM_BRAND.slice(1)}`
const UPSTREAM_UPPER = UPSTREAM_BRAND.toUpperCase()

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write('Usage: node workflow-project.mjs --project <path> [-t|--template <id>] [-m|--marketplace <source>] [--list] [-f|--force] [-n|--create-new]\n')
    return
  }
  const projectRoot = assertSafeProject(options.project)
  assertProjectIsNotHome(projectRoot)
  if (options.list) {
    process.stdout.write(`${JSON.stringify(await listWorkflowTemplates(options.marketplace), null, 2)}\n`)
    return
  }
  const manifestPath = assertSafeTarget(projectRoot, MANIFEST_PATH)
  const manifest = readManifest(projectRoot)
  const id = options.template ?? 'native'
  const source = options.marketplace ?? manifest.project?.workflow?.source
  const nativeContent = readTemplateFile('trellis/workflow.md')
  const resolved = fs.existsSync(path.resolve(projectRoot, id))
    ? { id, content: fs.readFileSync(path.resolve(projectRoot, id), 'utf8'), source: 'local' }
    : await resolveWorkflowTemplate(id, source, nativeContent)
  const desired = Buffer.from(localize(resolved.content))
  const target = assertSafeTarget(projectRoot, `${PROJECT_ROOT_DIR}/workflow.md`)
  const current = fs.readFileSync(target, 'utf8')
  const owned = manifest.entries[`${PROJECT_ROOT_DIR}/workflow.md`]
  const pristine = owned?.baselineHash === sha256(Buffer.from(current))
  if (!options.force && !options.createNew && !Buffer.from(current).equals(desired) && !pristine)
    throw new Error(`${PROJECT_ROOT_DIR}/workflow.md has local edits; use --force or --create-new`)
  const destination = options.createNew ? `${target}.new` : target
  atomicWrite(destination, desired)
  if (!options.createNew) {
    if (id === 'native') {
      manifest.entries[`${PROJECT_ROOT_DIR}/workflow.md`] = {
        baselineHash: sha256(desired),
        baselineContent: desired.toString('base64'),
        mode: 'replace',
        ownership: owned?.ownership ?? { type: current ? 'modified' : 'created', ...(current ? { originalContent: Buffer.from(current).toString('base64'), originalHash: sha256(Buffer.from(current)) } : {}) },
        platform: 'core',
        templateHash: sha256(desired),
      }
    }
    else {
      delete manifest.entries[`${PROJECT_ROOT_DIR}/workflow.md`]
    }
    manifest.schemaVersion = 2
    manifest.project = { ...(manifest.project ?? {}), workflow: { id, ...(source ? { source } : {}) } }
    atomicWrite(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`))
  }
  warnMissingAgents(desired.toString('utf8'), projectRoot)
  process.stdout.write(`${path.relative(projectRoot, destination)} written\n`)
}

function localize(content) {
  return content
    .replaceAll(`${UPSTREAM_BRAND} channel`, `node ${PROJECT_ROOT_DIR}/runtime/moluoxixi.mjs channel`)
    .replaceAll(`${UPSTREAM_BRAND} mem`, `node ${PROJECT_ROOT_DIR}/runtime/moluoxixi.mjs mem`)
    .replaceAll(`${UPSTREAM_BRAND} workflow`, `node ${PROJECT_ROOT_DIR}/runtime/moluoxixi.mjs workflow`)
    .replaceAll(`${UPSTREAM_BRAND} update`, `node ${PROJECT_ROOT_DIR}/runtime/moluoxixi.mjs update`)
    .replaceAll(`${UPSTREAM_BRAND}-`, 'moluoxixi-')
    .replaceAll(`.${UPSTREAM_BRAND}`, '.moluoxixi')
    .replaceAll(UPSTREAM_TITLE, 'Moluoxixi')
    .replaceAll(UPSTREAM_UPPER, 'MOLUOXIXI')
}

function warnMissingAgents(content, projectRoot) {
  const names = new Set()
  for (const match of content.matchAll(/(?:--agent\s+|\.moluoxixi\/agents\/)([A-Za-z0-9][\w-]*)(?:\.md)?/gu))
    names.add(match[1])
  const missing = [...names].filter(name => !fs.existsSync(path.join(projectRoot, PROJECT_ROOT_DIR, 'agents', `${name}.md`)))
  if (missing.length > 0)
    process.stderr.write(`Warning: workflow references missing Moluoxixi agents: ${missing.join(', ')}.\n`)
}

function atomicWrite(target, content) {
  const temporary = `${target}.airules-new-${Date.now()}`
  fs.writeFileSync(temporary, content, { flag: 'wx' })
  try {
    fs.renameSync(temporary, target)
  }
  catch (error) {
    fs.rmSync(temporary, { force: true })
    throw error
  }
}

function parseArgs(argv) {
  const result = { createNew: false, force: false, list: false, project: '.' }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--list')
      result.list = true
    else if (arg === '--force' || arg === '-f')
      result.force = true
    else if (arg === '--create-new' || arg === '-n')
      result.createNew = true
    else if (arg === '--project')
      result.project = value(argv, ++index, arg)
    else if (arg === '--template' || arg === '-t')
      result.template = value(argv, ++index, arg)
    else if (arg === '--marketplace' || arg === '-m')
      result.marketplace = value(argv, ++index, arg)
    else if (arg === '--help' || arg === '-h')
      result.help = true
    else throw new Error(`Unknown workflow option: ${arg}`)
  }
  return result
}

function value(argv, index, flag) {
  if (!argv[index] || argv[index].startsWith('-'))
    throw new Error(`${flag} requires a value`)
  return argv[index]
}

runWithEnvProxy(import.meta.url, main)
