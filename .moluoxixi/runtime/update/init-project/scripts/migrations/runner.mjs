import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256 } from '../constants.mjs'
import { assertSafeTarget } from '../core/safety.mjs'

const MIGRATIONS_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'manifests')

export function runVersionMigrations(projectRoot, manifest, currentVersion, targetVersion, options = {}) {
  const manifests = [...(options.manifests ?? loadManifests())].sort((left, right) => compareVersions(left.version, right.version))
  const selected = manifests.filter(item => compareVersions(item.version, currentVersion) > 0 && compareVersions(item.version, targetVersion) <= 0)
  const candidates = selected.flatMap(release => (release.migrations ?? []).map(migration => normalizeMigration(migration, release.version)))
  candidates.push(...findOrphanMigrations(projectRoot, manifests, candidates))

  const currentTemplates = options.currentTemplates ?? new Map()
  const classified = classifyMigrations(projectRoot, manifest, candidates, currentTemplates)
  const configSections = selected.flatMap(release => (release.configSectionsAdded ?? []).map(section => ({
    file: normalizePath(section.file),
    release: release.version,
    sectionHeading: section.sectionHeading,
    sentinel: section.sentinel,
    type: 'config-section',
  })))
  const pending = [...classified.auto, ...classified.confirm, ...classified.safeDeletes, ...configSections]
  const result = {
    applied: [],
    configSections,
    conflicts: classified.conflict.map(item => item.to ?? item.from),
    pending,
    proposed: classified.confirm.map(item => item.from),
    skipped: classified.skip.map(item => item.from),
  }

  const needsBreakingMigration = selected.some(item => item.breaking && item.recommendMigrate)
    && (classified.auto.length > 0 || classified.confirm.length > 0 || classified.conflict.length > 0)
  if (needsBreakingMigration && !options.migrate && !options.dryRun)
    throw new Error(`A breaking Moluoxixi release requires --migrate: ${selected.filter(item => item.breaking && item.recommendMigrate).map(item => item.version).join(', ')}`)
  if (options.dryRun)
    return result

  if (options.migrate) {
    for (const migration of sortMigrationsForExecution(classified.auto))
      executeMigration(projectRoot, manifest, migration, false, result, currentTemplates)
    for (const migration of classified.confirm) {
      if (options.skipAll) {
        result.skipped.push(migration.from)
        continue
      }
      executeMigration(projectRoot, manifest, migration, !options.force, result, currentTemplates)
    }
  }
  for (const migration of classified.safeDeletes)
    executeSafeDelete(projectRoot, manifest, migration, result)
  return result
}

function loadManifests() {
  if (!fs.existsSync(MIGRATIONS_ROOT))
    return []
  const manifests = []
  for (const name of fs.readdirSync(MIGRATIONS_ROOT).filter(name => name.endsWith('.json')).sort()) {
    const source = path.join(MIGRATIONS_ROOT, name)
    try {
      manifests.push(JSON.parse(fs.readFileSync(source, 'utf8')))
    }
    catch (error) {
      process.emitWarning(`Skipping malformed migration manifest ${source}: ${String(error)}`)
    }
  }
  return manifests.sort((left, right) => compareVersions(left.version, right.version))
}

function normalizeMigration(migration, release) {
  return {
    ...migration,
    allowedHashes: migration.allowed_hashes ?? [],
    from: normalizePath(migration.from ?? migration.path),
    release,
    to: migration.to ? normalizePath(migration.to) : undefined,
  }
}

function findOrphanMigrations(projectRoot, manifests, selected) {
  const known = new Set(selected.map(item => `${item.from}\0${item.to ?? ''}`))
  const orphaned = []
  for (const release of manifests) {
    for (const raw of release.migrations ?? []) {
      if (!['rename', 'rename-dir'].includes(raw.type) || !raw.from || !raw.to)
        continue
      const migration = normalizeMigration(raw, release.version)
      const key = `${migration.from}\0${migration.to}`
      if (known.has(key))
        continue
      const source = assertSafeTarget(projectRoot, migration.from)
      const target = assertSafeTarget(projectRoot, migration.to)
      if (!fs.existsSync(source) || fs.existsSync(target))
        continue
      known.add(key)
      orphaned.push(migration)
    }
  }
  return orphaned
}

function classifyMigrations(projectRoot, manifest, migrations, currentTemplates) {
  const result = { auto: [], confirm: [], conflict: [], safeDeletes: [], skip: [] }
  for (const migration of migrations) {
    if (!migration.from)
      continue
    const source = assertSafeTarget(projectRoot, migration.from)
    if (migration.type === 'safe-file-delete') {
      if (currentTemplates.has(migration.from))
        continue
      if (fs.existsSync(source) && isSafeDelete(projectRoot, manifest, migration.from, migration.allowedHashes))
        result.safeDeletes.push(migration)
      continue
    }
    if (!['rename', 'rename-dir', 'delete'].includes(migration.type) || !fs.existsSync(source)) {
      result.skip.push(migration)
      continue
    }
    if (migration.type === 'rename-dir') {
      if (!migration.to || !dirHasManifestEntries(migration.from, manifest)) {
        result.skip.push(migration)
        continue
      }
      const target = assertSafeTarget(projectRoot, migration.to)
      if (fs.existsSync(target) && !isDirectorySafeToReplace(projectRoot, migration.to, manifest))
        result.conflict.push(migration)
      else result.auto.push(migration)
      continue
    }
    if (migration.type === 'rename' && migration.to) {
      const target = assertSafeTarget(projectRoot, migration.to)
      if (fs.existsSync(target) && !isPristine(projectRoot, manifest, migration.to)) {
        result.conflict.push(migration)
        continue
      }
    }
    if (isPristine(projectRoot, manifest, migration.from))
      result.auto.push(migration)
    else result.confirm.push(migration)
  }
  return result
}

function executeMigration(projectRoot, manifest, migration, inlineBackup, result, currentTemplates) {
  const source = assertSafeTarget(projectRoot, migration.from)
  if (!fs.existsSync(source))
    return
  if (migration.type === 'delete') {
    if (inlineBackup)
      fs.copyFileSync(source, `${source}.backup`)
    fs.unlinkSync(source)
    delete manifest.entries[migration.from]
    cleanupEmptyParents(source, projectRoot)
  }
  else if (migration.type === 'rename' && migration.to) {
    const target = assertSafeTarget(projectRoot, migration.to)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (inlineBackup)
      fs.copyFileSync(source, `${target}.backup`)
    if (fs.existsSync(target))
      fs.rmSync(target, { force: true })
    fs.renameSync(source, target)
    transferManifestEntry(manifest, migration.from, migration.to)
    if (/\.(?:py|sh)$/u.test(migration.to))
      fs.chmodSync(target, 0o755)
    cleanupEmptyParents(source, projectRoot)
  }
  else if (migration.type === 'rename-dir' && migration.to) {
    const target = assertSafeTarget(projectRoot, migration.to)
    if (fs.existsSync(target) && dirMatchesCurrentTemplates(projectRoot, migration.to, currentTemplates)) {
      fs.rmSync(source, { recursive: true, force: true })
      dropManifestDirectory(manifest, migration.from)
      result.applied.push(migration.from)
      return
    }
    if (fs.existsSync(target))
      fs.rmSync(target, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.renameSync(source, target)
    transferManifestDirectory(manifest, migration.from, migration.to)
  }
  result.applied.push(migration.from)
}

function executeSafeDelete(projectRoot, manifest, migration, result) {
  const source = assertSafeTarget(projectRoot, migration.from)
  if (!fs.existsSync(source))
    return
  if (!isSafeDelete(projectRoot, manifest, migration.from, migration.allowedHashes))
    return
  fs.rmSync(source, { force: true })
  delete manifest.entries[migration.from]
  cleanupEmptyParents(source, projectRoot)
  result.applied.push(migration.from)
}

export function isSafeDelete(projectRoot, manifest, relativePath, allowedHashes) {
  const target = assertSafeTarget(projectRoot, relativePath)
  if (!fs.statSync(target, { throwIfNoEntry: false })?.isFile())
    return false
  if (isPristine(projectRoot, manifest, relativePath))
    return true
  return allowedHashes.includes(sha256(fs.readFileSync(target)))
}

function isPristine(projectRoot, manifest, relativePath) {
  const target = assertSafeTarget(projectRoot, relativePath)
  const stats = fs.lstatSync(target, { throwIfNoEntry: false })
  if (!stats?.isFile() || stats.isSymbolicLink())
    return false
  const hash = sha256(fs.readFileSync(target))
  const entry = manifest.entries?.[relativePath]
  return Boolean(entry?.baselineHash && entry.baselineHash === hash)
}

function dirHasManifestEntries(relativePath, manifest) {
  const prefix = `${relativePath.replace(/\/$/u, '')}/`
  return Object.keys(manifest.entries ?? {}).some(key => key === relativePath || key.startsWith(prefix))
}

function isDirectorySafeToReplace(projectRoot, relativePath, manifest) {
  const target = assertSafeTarget(projectRoot, relativePath)
  const entries = collectDirectoryFiles(target)
  return entries !== undefined && entries.every(file => isPristine(projectRoot, manifest, normalizeRelative(projectRoot, file)))
}

function collectDirectoryFiles(root) {
  const files = []
  const pending = [root]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      const stats = fs.lstatSync(target)
      if (stats.isSymbolicLink())
        return undefined
      if (stats.isDirectory())
        pending.push(target)
      else if (stats.isFile())
        files.push(target)
      else return undefined
    }
  }
  return files
}

function dirMatchesCurrentTemplates(projectRoot, relativePath, currentTemplates) {
  const target = assertSafeTarget(projectRoot, relativePath)
  const files = collectDirectoryFiles(target)
  if (!files || files.length === 0)
    return false
  return files.every((file) => {
    const relativeFile = normalizeRelative(projectRoot, file)
    const template = currentTemplates.get(relativeFile)
    const content = Buffer.isBuffer(template)
      ? template
      : Buffer.isBuffer(template?.content)
        ? template.content
        : typeof template === 'string'
          ? Buffer.from(template)
          : undefined
    return content !== undefined && fs.readFileSync(file).equals(content)
  })
}

function transferManifestEntry(manifest, from, to) {
  if (!manifest.entries)
    return
  delete manifest.entries[to]
  if (manifest.entries[from]) {
    manifest.entries[to] = manifest.entries[from]
    delete manifest.entries[from]
  }
}

function transferManifestDirectory(manifest, from, to) {
  if (!manifest.entries)
    return
  const sourcePrefix = `${from.replace(/\/$/u, '')}/`
  const targetPrefix = `${to.replace(/\/$/u, '')}/`
  for (const key of Object.keys(manifest.entries)) {
    if (key === to || key.startsWith(targetPrefix))
      delete manifest.entries[key]
  }
  for (const [key, value] of Object.entries({ ...manifest.entries })) {
    if (key === from || key.startsWith(sourcePrefix)) {
      const suffix = key === from ? '' : key.slice(sourcePrefix.length)
      manifest.entries[suffix ? `${targetPrefix}${suffix}` : to] = value
      delete manifest.entries[key]
    }
  }
}

function dropManifestDirectory(manifest, relativePath) {
  if (!manifest.entries)
    return
  const prefix = `${relativePath.replace(/\/$/u, '')}/`
  for (const key of Object.keys(manifest.entries)) {
    if (key === relativePath || key.startsWith(prefix))
      delete manifest.entries[key]
  }
}

function sortMigrationsForExecution(migrations) {
  return [...migrations].sort((left, right) => {
    if (left.type === 'rename-dir' && right.type === 'rename-dir')
      return right.from.split('/').length - left.from.split('/').length
    if (left.type === 'rename-dir')
      return -1
    if (right.type === 'rename-dir')
      return 1
    return 0
  })
}

function cleanupEmptyParents(target, projectRoot) {
  let current = path.dirname(target)
  while (current !== projectRoot) {
    try {
      fs.rmdirSync(current)
    }
    catch {
      return
    }
    current = path.dirname(current)
  }
}

function normalizeRelative(projectRoot, target) {
  return path.relative(projectRoot, target).split(path.sep).join('/')
}

function normalizePath(value) {
  return String(value ?? '').replace(/\\/gu, '/').replace(/^\.\//u, '')
}

export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index += 1) {
    if (a.numbers[index] !== b.numbers[index])
      return a.numbers[index] - b.numbers[index]
  }
  if (a.pre === b.pre)
    return 0
  if (!a.pre)
    return 1
  if (!b.pre)
    return -1
  return a.pre.localeCompare(b.pre, undefined, { numeric: true })
}

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/u.exec(String(value))
  return match ? { numbers: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? '' } : { numbers: [0, 0, 0], pre: '' }
}
