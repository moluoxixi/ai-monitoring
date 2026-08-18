import { Buffer } from 'node:buffer'
import path from 'node:path'
import { sha256 } from '../constants.mjs'
import { decodeUtf8, removeManagedBlock, restoreJson, upsertBlock } from './migration.mjs'

const HASH = /^[a-f0-9]{64}$/u
const MODES = new Set(['replace', 'json', 'config', 'block-hash', 'block-html', 'block-moluoxixi'])

export function emptyManifest() {
  return { schemaVersion: 2, entries: {} }
}

export function normalizeManifest(parsed, file) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.schemaVersion !== 2)
    throw new Error(`Unsupported or malformed manifest: ${file}`)
  if (!parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries))
    throw new Error(`Unsupported or malformed manifest: ${file}`)
  const entries = {}
  for (const [relativePath, candidate] of Object.entries(parsed.entries)) {
    assertManifestPath(relativePath, file)
    entries[relativePath] = normalizeEntry(candidate, file)
  }
  return { ...parsed, schemaVersion: 2, entries }
}

export function ownershipFor(existing, current) {
  if (existing?.ownership)
    return existing.ownership
  if (existing)
    throw new Error('Manifest entry is missing ownership metadata')
  if (current === undefined)
    return { type: 'created' }
  return {
    type: 'modified',
    originalContent: current.toString('base64'),
    originalHash: sha256(current),
  }
}

export function createManifestEntry(operation, existing) {
  const ownership = operation.ownership ?? ownershipFor(existing, operation.current)
  const entry = {
    baselineHash: sha256(operation.desired),
    mode: operation.merge,
    ownership,
    platform: operation.platform,
    templateHash: sha256(operation.content),
  }
  if (ownership.type !== 'created' || operation.merge?.startsWith('block-'))
    entry.baselineContent = operation.desired.toString('base64')
  if (operation.merge === 'json' || operation.merge === 'config' || operation.merge?.startsWith('block-'))
    entry.templateContent = operation.content.toString('base64')
  return entry
}

export function decodeEntryContent(entry, field) {
  const value = entry?.[field]
  return typeof value === 'string' ? Buffer.from(value, 'base64') : undefined
}

export function planOwnedRemoval(current, entry, force = false) {
  const pristine = entry.baselineHash === sha256(current)
  const original = decodeEntryContent(entry.ownership, 'originalContent')
  const baseline = blockBaseline(entry)
  if (entry.ownership.type === 'created') {
    if (pristine)
      return { action: 'delete' }
    if (entry.mode.startsWith('block-') && baseline) {
      try {
        const restored = removeManagedBlock(decodeUtf8(current), entry.mode, decodeUtf8(baseline), force)
        if (!restored.conflict)
          return restored.content ? { action: 'write', content: Buffer.from(restored.content) } : { action: 'delete' }
      }
      catch {}
    }
    return force ? { action: 'delete' } : { action: 'conflict' }
  }

  if (entry.ownership.type === 'modified' && original) {
    if (pristine || force)
      return { action: 'write', content: original }
    if (entry.mode === 'json' && baseline) {
      try {
        const restored = restoreJson(
          JSON.parse(original.toString('utf8')),
          JSON.parse(baseline.toString('utf8')),
          JSON.parse(current.toString('utf8')),
        )
        if (!restored.conflict)
          return { action: 'write', content: Buffer.from(`${JSON.stringify(restored.value, null, 2)}\n`) }
      }
      catch {}
    }
    if (entry.mode.startsWith('block-') && baseline) {
      try {
        const restored = removeManagedBlock(decodeUtf8(current), entry.mode, decodeUtf8(baseline), false)
        if (!restored.conflict)
          return restored.content ? { action: 'write', content: Buffer.from(restored.content) } : { action: 'delete' }
      }
      catch {}
    }
    return { action: 'conflict' }
  }

  if (entry.mode.startsWith('block-')) {
    try {
      const restored = removeManagedBlock(decodeUtf8(current), entry.mode, baseline ? decodeUtf8(baseline) : undefined, force)
      if (!restored.conflict)
        return restored.content ? { action: 'write', content: Buffer.from(restored.content) } : { action: 'delete' }
    }
    catch {}
  }
  return pristine || force ? { action: 'delete' } : { action: 'conflict' }
}

function blockBaseline(entry) {
  const baseline = decodeEntryContent(entry, 'baselineContent')
  if (baseline || !entry.mode?.startsWith('block-'))
    return baseline
  const template = decodeEntryContent(entry, 'templateContent')
  if (!template)
    return undefined
  try {
    return Buffer.from(upsertBlock('', decodeUtf8(template), entry.mode))
  }
  catch {
    return undefined
  }
}

function normalizeEntry(candidate, file) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
    throw new Error(`Unsupported or malformed manifest entry: ${file}`)
  if (!HASH.test(candidate.baselineHash) || !HASH.test(candidate.templateHash))
    throw new Error(`Unsupported or malformed manifest entry: ${file}`)
  if (!MODES.has(candidate.mode) || typeof candidate.platform !== 'string' || !candidate.platform)
    throw new Error(`Unsupported or malformed manifest entry: ${file}`)
  const ownership = normalizeOwnership(candidate.ownership, file)
  for (const field of ['baselineContent', 'templateContent']) {
    if (candidate[field] !== undefined && typeof candidate[field] !== 'string')
      throw new Error(`Unsupported or malformed manifest entry: ${file}`)
  }
  return {
    baselineHash: candidate.baselineHash,
    mode: candidate.mode,
    ownership,
    platform: candidate.platform,
    templateHash: candidate.templateHash,
    ...(candidate.baselineContent === undefined ? {} : { baselineContent: candidate.baselineContent }),
    ...(candidate.templateContent === undefined ? {} : { templateContent: candidate.templateContent }),
  }
}

function normalizeOwnership(candidate, file) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
    throw new Error(`Unsupported or malformed manifest ownership: ${file}`)
  if (candidate.type === 'created')
    return { type: 'created' }
  if (candidate.type !== 'modified' || typeof candidate.originalContent !== 'string' || !HASH.test(candidate.originalHash))
    throw new Error(`Unsupported or malformed manifest ownership: ${file}`)
  const original = Buffer.from(candidate.originalContent, 'base64')
  if (sha256(original) !== candidate.originalHash)
    throw new Error(`Manifest ownership checksum mismatch: ${file}`)
  return { type: 'modified', originalContent: candidate.originalContent, originalHash: candidate.originalHash }
}

function assertManifestPath(value, file) {
  const normalized = path.posix.normalize(value)
  if (!value || value.includes('\\') || value.includes('\0') || normalized !== value || path.posix.isAbsolute(value) || value === '..' || value.startsWith('../'))
    throw new Error(`Unsafe manifest path in ${file}: ${value}`)
}
