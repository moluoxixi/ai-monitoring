#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { parseArgs, printHelp } from './cli.mjs'
import { MANIFEST_PATH, MOLUOXIXI_VERSION } from './constants.mjs'
import { createPersistentBackup } from './core/backup.mjs'
import { applyLifecycle, captureLifecycleState, detectGitDeveloper, readDeveloper } from './core/lifecycle.mjs'
import { prepareOperations, readManifest } from './core/operations.mjs'
import { detectMonorepo, detectProjectType } from './core/project-detector.mjs'
import { runWithEnvProxy } from './core/proxy.mjs'
import { resolveSpecTemplate, resolveWorkflowTemplate } from './core/registry.mjs'
import { assertProjectIsNotHome, assertSafeProject } from './core/safety.mjs'
import { commit } from './core/transaction.mjs'
import { normalizePlatforms } from './hosts/catalog.mjs'
import { compareVersions, runVersionMigrations } from './migrations/runner.mjs'
import { buildPlan, requirePython } from './plan.mjs'
import { readTemplateFile } from './templates.mjs'

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    printHelp()
    return
  }
  const projectRoot = assertSafeProject(options.project)
  assertProjectIsNotHome(projectRoot)
  const pythonCommand = requirePython(options.python)
  const lifecycleBefore = captureLifecycleState(projectRoot)
  const manifest = readManifest(projectRoot)
  const currentVersion = readVersion(projectRoot)
  if (!options.allowDowngrade && currentVersion && compareVersions(currentVersion, MOLUOXIXI_VERSION) > 0)
    throw new Error(`Project version ${currentVersion} is newer than this updater; use --allow-downgrade to continue`)
  const migrationConfig = currentVersion
    ? runVersionMigrations(projectRoot, manifest, currentVersion, MOLUOXIXI_VERSION, { dryRun: true, force: options.force, migrate: options.migrate, skipAll: options.skipAll })
    : { applied: [], conflicts: [], pending: [], proposed: [] }
  const platforms = normalizePlatforms([...(manifest.platforms ?? []), ...options.platforms])
  const withStatusline = options.withStatusline || manifest.features?.claudeStatusline === true
  const detectedMonorepo = detectMonorepo(projectRoot)
  if (options.monorepo === true && (!detectedMonorepo || detectedMonorepo.length === 0) && options.packages.length === 0)
    throw new Error('--monorepo was requested but no workspace packages were detected; pass --package mappings or use --no-monorepo')
  const storedPackages = Array.isArray(manifest.project?.packages) ? manifest.project.packages : []
  const packages = options.monorepo === false
    ? []
    : options.packages.length > 0
      ? mergePackages(detectedMonorepo ?? storedPackages, options.packages)
      : options.monorepo === true
        ? mergePackages([], detectedMonorepo ?? [])
        : mergePackages([], storedPackages.length > 0 ? storedPackages : detectedMonorepo ?? [])
  const defaultPackage = packages.length === 0
    ? undefined
    : options.defaultPackage
      ?? manifest.project?.defaultPackage
      ?? packages.find(pkg => !pkg.isSubmodule)?.name
      ?? packages[0]?.name
  if (defaultPackage && !packages.some(pkg => pkg.name === defaultPackage))
    throw new Error(`Default package is not declared: ${defaultPackage}`)
  const detectedProjectType = detectProjectType(projectRoot)
  const projectType = options.projectType ?? (detectedProjectType === 'unknown' ? manifest.project?.type ?? 'fullstack' : detectedProjectType)
  const developer = options.developer ?? readDeveloper(projectRoot) ?? detectGitDeveloper(projectRoot)
  const workflowId = options.workflow ?? manifest.project?.workflow?.id
  const workflowSource = options.workflowSource ?? manifest.project?.workflow?.source
  const workflow = workflowId ? await resolveWorkflowTemplate(workflowId, workflowSource, readProjectWorkflow()) : undefined
  const strategy = options.overwrite ? 'overwrite' : options.append ? 'append' : manifest.project?.registry?.strategy ?? 'skip'
  const registrySelection = await resolveSpecSelections(packages, options, manifest.project?.registry, strategy)
  const plan = buildPlan(platforms, pythonCommand, withStatusline, packages, defaultPackage, projectType, {
    configSections: migrationConfig.configSections,
    projectRoot,
    specs: registrySelection.specs,
    workflow: workflow ? { ...workflow, force: options.force } : undefined,
  })
  const migrationPreview = currentVersion
    ? runVersionMigrations(projectRoot, manifest, currentVersion, MOLUOXIXI_VERSION, { currentTemplates: plan, dryRun: true, force: options.force, migrate: options.migrate, skipAll: options.skipAll })
    : migrationConfig
  let backup = !options.dryRun && currentVersion && migrationPreview.pending?.length > 0 ? createPersistentBackup(projectRoot, manifest) : undefined
  const migrations = options.dryRun || !currentVersion
    ? migrationPreview
    : runVersionMigrations(projectRoot, manifest, currentVersion, MOLUOXIXI_VERSION, { currentTemplates: plan, dryRun: false, force: options.force, migrate: options.migrate, skipAll: options.skipAll })
  const prepared = prepareOperations(projectRoot, plan, manifest, options.force, options.createNew && !options.skipAll)
  const registryConflict = prepared.result.conflicts.some(relativePath => [...(plan.externalSpecRoots ?? [])].some(root => relativePath === root || relativePath.startsWith(`${root}/`)))
  const effectiveRegistry = registryConflict ? manifest.project?.registry : registrySelection.metadata
  if (!options.dryRun && currentVersion && !backup && prepared.operations.some(operation => ['created', 'updated', 'removed', 'restored'].includes(operation.status)))
    backup = createPersistentBackup(projectRoot, manifest)
  for (const conflict of migrations.conflicts ?? [])
    prepared.result.conflicts.push(conflict)
  const summary = {
    projectRoot,
    platforms,
    dryRun: options.dryRun,
    createNew: options.createNew,
    force: options.force,
    skipAll: options.skipAll,
    withStatusline,
    developer,
    packages,
    defaultPackage,
    projectType,
    workflow: workflow?.id ?? manifest.project?.workflow?.id,
    registry: effectiveRegistry,
    migrations,
    ...(backup ? { backup } : {}),
    manifest: MANIFEST_PATH,
    warnings: platforms.includes('codex')
      ? ['Codex hooks require [features].hooks = true and one-time /hooks approval in the project.']
      : [],
    ...prepared.result,
  }
  if (!options.dryRun) {
    commit(projectRoot, prepared.operations, manifest, platforms, {
      defaultPackage,
      packages,
      projectType,
      withStatusline,
      workflow: workflow ? { id: workflow.id, source: workflowSource } : manifest.project?.workflow,
      registry: effectiveRegistry,
    })
    Object.assign(summary, applyLifecycle(projectRoot, developer, pythonCommand, projectType, packages, lifecycleBefore))
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  if (summary.conflicts.length > 0)
    process.exitCode = 2
}

function readProjectWorkflow() {
  return readTemplateFile('moluoxixi/workflow.md')
}

function readVersion(projectRoot) {
  try {
    return fs.readFileSync(path.join(projectRoot, '.moluoxixi', '.version'), 'utf8').trim() || undefined
  }
  catch {
    return undefined
  }
}

function mergePackages(stored, requested) {
  const merged = new Map()
  for (const pkg of Array.isArray(stored) ? stored.map(validateStoredPackage) : [])
    merged.set(pkg.name, pkg)
  for (const pkg of requested)
    merged.set(pkg.name, pkg)
  return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function validateStoredPackage(pkg) {
  const validType = ['frontend', 'backend', 'fullstack', 'unknown'].includes(pkg?.type)
  const validName = typeof pkg?.name === 'string' && pkg.name.length > 0 && pkg.name.length <= 128 && !/[\0\r\n]/u.test(pkg.name)
  const validPath = typeof pkg?.path === 'string' && pkg.path !== '..' && !pkg.path.startsWith('/') && !pkg.path.startsWith('../') && !pkg.path.includes('/../') && !pkg.path.includes('\0')
  if (!validType || !validName || !validPath)
    throw new Error('Malformed package mapping in initializer manifest')
  return {
    name: pkg.name,
    path: pkg.path,
    type: pkg.type,
    isSubmodule: pkg.isSubmodule === true,
    isGitRepo: pkg.isGitRepo === true,
  }
}

async function resolveSpecSelections(packages, options, storedRegistry = {}, strategy) {
  const packageNames = new Set(packages.map(pkg => pkg.name))
  for (const name of [...Object.keys(options.packageTemplates), ...Object.keys(options.packageRegistries)]) {
    if (!packageNames.has(name))
      throw new Error(`Spec override references an undeclared package: ${name}`)
  }
  const defaultSource = options.registry ?? storedRegistry?.source
  const defaultTemplate = options.template ?? storedRegistry?.template
  const cache = new Map()
  const resolveCached = async (template, source) => {
    const key = `${source ?? ''}\0${template ?? ''}`
    if (!cache.has(key))
      cache.set(key, resolveSpecTemplate(template, source))
    return cache.get(key)
  }

  if (packages.length === 0) {
    if (!defaultSource && !defaultTemplate)
      return { metadata: undefined, specs: [] }
    const resolved = await resolveCached(defaultTemplate, defaultSource)
    return {
      metadata: { source: resolved.registry, ...(resolved.template ? { template: resolved.template } : {}), strategy },
      specs: [{ ...resolved, strategy }],
    }
  }

  const packageMetadata = {}
  const specs = []
  const strategyWasExplicit = options.overwrite || options.append
  for (const pkg of packages) {
    const storedPackage = storedRegistry?.packages?.[pkg.name]
    const source = options.packageRegistries[pkg.name] ?? storedPackage?.source ?? defaultSource
    const template = options.packageTemplates[pkg.name] ?? storedPackage?.template ?? defaultTemplate
    if (!source && !template)
      continue
    const resolved = await resolveCached(template, source)
    const packageStrategy = strategyWasExplicit ? strategy : storedPackage?.strategy ?? strategy
    packageMetadata[pkg.name] = {
      source: resolved.registry,
      ...(resolved.template ? { template: resolved.template } : {}),
      strategy: packageStrategy,
    }
    specs.push({ ...resolved, packageName: pkg.name, strategy: packageStrategy })
  }
  if (specs.length === 0)
    return { metadata: undefined, specs }
  return {
    metadata: {
      ...(defaultSource ? { source: defaultSource } : {}),
      ...(defaultTemplate ? { template: defaultTemplate } : {}),
      packages: packageMetadata,
      strategy,
    },
    specs,
  }
}

runWithEnvProxy(import.meta.url, main)
