import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import path from 'node:path'
import { GENERATOR_VERSION, MANIFEST_PATH, MOLUOXIXI_VERSION, sha256 } from '../constants.mjs'
import { decodeUtf8, InvalidUtf8Error, mergeConfig, mergeJson, upgradeJson, upsertBlock } from './migration.mjs'
import { decodeEntryContent, emptyManifest, normalizeManifest, ownershipFor, planOwnedRemoval } from './ownership.mjs'
import { assertSafeTarget } from './safety.mjs'

export function readManifest(projectRoot) {
  const file = path.join(projectRoot, ...MANIFEST_PATH.split('/'))
  if (!fs.existsSync(file))
    return { ...emptyManifest(), generatorVersion: GENERATOR_VERSION, moluoxixiVersion: MOLUOXIXI_VERSION }
  return normalizeManifest(JSON.parse(fs.readFileSync(file, 'utf8')), file)
}

export function prepareOperations(projectRoot, plan, manifest, force, createNew = false) {
  const operations = []
  const result = { conflicts: [], created: [], preserved: [], proposed: [], removed: [], restored: [], unchanged: [], updated: [] }
  const recordConflict = (relativePath, item, desired = item.content) => {
    result.conflicts.push(relativePath)
    if (!createNew)
      return
    const proposalPath = `${relativePath}.new`
    const proposalTarget = assertSafeTarget(projectRoot, proposalPath)
    const proposalStats = fs.lstatSync(proposalTarget, { throwIfNoEntry: false })
    if (proposalStats) {
      if (!proposalStats.isFile() || proposalStats.isSymbolicLink() || !fs.readFileSync(proposalTarget).equals(desired))
        result.conflicts.push(proposalPath)
      return
    }
    operations.push({ ...item, desired, managed: false, relativePath: proposalPath, status: 'proposed', target: proposalTarget })
    result.proposed.push(proposalPath)
  }
  for (const [relativePath, item] of [...plan.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    const target = assertSafeTarget(projectRoot, relativePath)
    const stats = fs.lstatSync(target, { throwIfNoEntry: false })
    if (stats && (!stats.isFile() || stats.isSymbolicLink())) {
      recordConflict(relativePath, item)
      continue
    }
    const current = stats ? fs.readFileSync(target) : undefined
    const owned = manifest.entries[relativePath]
    if (item.preserveExisting && current) {
      operations.push({ ...item, current, desired: current, relativePath, target, status: owned ? 'released' : 'preserved' })
      result.preserved.push(relativePath)
      continue
    }
    if (item.skipExisting && current && !owned) {
      operations.push({ ...item, current, desired: current, relativePath, target, status: 'preserved' })
      result.preserved.push(relativePath)
      continue
    }
    let desired = item.content
    try {
      if (current && item.merge === 'json') {
        const template = JSON.parse(item.content.toString('utf8'))
        const currentJson = JSON.parse(current.toString('utf8'))
        const previousTemplate = decodeEntryContent(owned, 'templateContent')
        const merged = previousTemplate
          ? upgradeJson(currentJson, JSON.parse(previousTemplate.toString('utf8')), template)
          : mergeJson(currentJson, template)
        desired = JSON.stringify(merged) === JSON.stringify(currentJson)
          ? current
          : Buffer.from(`${JSON.stringify(merged, null, 2)}\n`)
      }
      else if (current && item.merge === 'config') {
        desired = Buffer.from(mergeConfig(current.toString('utf8'), item.content.toString('utf8'), owned, item.configSections))
      }
      else if (item.merge.startsWith('block-')) {
        desired = Buffer.from(upsertBlock(current ? decodeUtf8(current) : '', decodeUtf8(item.content), item.merge))
      }
    }
    catch (error) {
      if (error instanceof InvalidUtf8Error || (!force && !item.force)) {
        recordConflict(relativePath, item, desired)
        continue
      }
    }
    if (!current && owned) {
      operations.push({ ...item, current, desired, ownership: ownershipFor(owned, current), relativePath, target, status: 'preserved' })
      result.preserved.push(relativePath)
    }
    else if (!current) {
      operations.push({ ...item, current, desired, ownership: ownershipFor(owned, current), relativePath, target, status: 'created' })
      result.created.push(relativePath)
    }
    else if (current.equals(desired)) {
      const remainsOwned = owned && (owned.baselineHash === sha256(current) || current.equals(item.content))
      const status = remainsOwned ? 'unchanged' : 'preserved'
      result[status].push(relativePath)
      operations.push({ ...item, current, desired, ownership: ownershipFor(owned, current), relativePath, target, status })
    }
    else if (item.merge === 'json' || item.merge === 'config' || item.merge.startsWith('block-') || force || item.force || (owned && owned.baselineHash === sha256(current))) {
      operations.push({ ...item, current, desired, ownership: ownershipFor(owned, current), relativePath, target, status: 'updated' })
      result.updated.push(relativePath)
    }
    else {
      recordConflict(relativePath, item, desired)
    }
  }
  const replacementRemovals = collectSpecReplacementRemovals(projectRoot, plan.specReplacements, plan, result)
  for (const relativePath of replacementRemovals) {
    const target = assertSafeTarget(projectRoot, relativePath)
    operations.push({ relativePath, target, status: 'removed' })
    result.removed.push(relativePath)
  }
  for (const [relativePath, owned] of Object.entries(manifest.entries)) {
    if (plan.has(relativePath) || replacementRemovals.has(relativePath))
      continue
    const target = assertSafeTarget(projectRoot, relativePath)
    if (isUserDataPath(relativePath)) {
      operations.push({ relativePath, target, status: 'released' })
      result.preserved.push(relativePath)
      continue
    }
    const stats = fs.lstatSync(target, { throwIfNoEntry: false })
    if (!stats) {
      operations.push({ relativePath, target, status: 'removed' })
      result.removed.push(relativePath)
    }
    else if (!stats.isFile() || stats.isSymbolicLink()) {
      result.conflicts.push(relativePath)
    }
    else {
      const current = fs.readFileSync(target)
      const removal = planOwnedRemoval(current, owned, force)
      if (removal.action === 'delete') {
        operations.push({ relativePath, target, status: 'removed' })
        result.removed.push(relativePath)
      }
      else if (removal.action === 'write') {
        operations.push({ desired: removal.content, relativePath, target, status: 'restored' })
        result.restored.push(relativePath)
      }
      else {
        result.conflicts.push(relativePath)
      }
    }
  }
  return { operations, result }
}

function collectSpecReplacementRemovals(projectRoot, roots, plan, result) {
  const removals = new Set()
  for (const relativeRoot of roots ?? []) {
    const root = assertSafeTarget(projectRoot, relativeRoot)
    const stats = fs.lstatSync(root, { throwIfNoEntry: false })
    if (!stats)
      continue
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      result.conflicts.push(relativeRoot)
      continue
    }
    visit(root)
  }
  return removals

  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      const relativePath = path.relative(projectRoot, target).split(path.sep).join('/')
      const stats = fs.lstatSync(target)
      if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
        result.conflicts.push(relativePath)
        continue
      }
      if (stats.isDirectory())
        visit(target)
      else if (!plan.has(relativePath))
        removals.add(relativePath)
    }
  }
}

function isUserDataPath(relativePath) {
  return relativePath === '.moluoxixi/.developer'
    || relativePath.startsWith('.moluoxixi/workspace/')
    || relativePath.startsWith('.moluoxixi/tasks/')
    || relativePath.startsWith('.moluoxixi/spec/')
    || relativePath.startsWith('.moluoxixi/spec-proposals/')
}
