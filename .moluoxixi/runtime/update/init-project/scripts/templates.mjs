import fs from 'node:fs'
import path from 'node:path'
import {
  OVERLAY_ADDITION_ROOT,
  OVERLAY_OVERRIDE_ROOT,
  OVERLAY_ROOT,
  PACKAGE_TEMPLATE_ROOT,
  sha256,
  toPosix,
} from './constants.mjs'

const MANIFEST_PATH = path.join(OVERLAY_ROOT, 'manifest.json')
let cachedState

function safeRelativePath(value, label) {
  const normalized = path.posix.normalize(String(value).replace(/\\/gu, '/'))
  if (!normalized || normalized === '.' || path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../') || normalized.includes('\0'))
    throw new Error(`Unsafe ${label} path: ${value}`)
  return normalized
}

function requireFile(root, relativePath, label) {
  const normalized = safeRelativePath(relativePath, label)
  const target = path.join(root, ...normalized.split('/'))
  if (!fs.statSync(target, { throwIfNoEntry: false })?.isFile())
    throw new Error(`Missing ${label}: ${normalized}`)
  return target
}

function walkRelativeFiles(root) {
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory())
    return []
  const files = []
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory())
        visit(target)
      else if (entry.isFile())
        files.push(toPosix(path.relative(root, target)))
      else throw new Error(`Unsupported overlay entry: ${target}`)
    }
  }
  visit(root)
  return files
}

function readState() {
  if (cachedState)
    return cachedState
  if (!fs.statSync(PACKAGE_TEMPLATE_ROOT, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`Upstream package templates are missing: ${PACKAGE_TEMPLATE_ROOT}`)
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'))
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.overrides) || !Array.isArray(manifest.additions))
    throw new Error(`Unsupported overlay manifest: ${MANIFEST_PATH}`)

  const overrides = new Map()
  const additions = new Map()
  for (const entry of manifest.overrides) {
    const source = safeRelativePath(entry.source, 'overlay source')
    const overlay = safeRelativePath(entry.overlay, 'overlay file')
    if (overrides.has(source))
      throw new Error(`Duplicate overlay source: ${source}`)
    const sourceFile = requireFile(PACKAGE_TEMPLATE_ROOT, source, 'upstream template')
    const overlayFile = requireFile(OVERLAY_ROOT, overlay, 'overlay')
    if (sha256(fs.readFileSync(sourceFile)) !== entry.sourceSha256)
      throw new Error(`Upstream template drifted before overlay replay: ${source}`)
    if (sha256(fs.readFileSync(overlayFile)) !== entry.overlaySha256)
      throw new Error(`Overlay content does not match its manifest: ${overlay}`)
    overrides.set(source, { ...entry, source, overlay, file: overlayFile })
  }
  for (const entry of manifest.additions) {
    const relativePath = safeRelativePath(entry.path, 'addition target')
    const overlay = safeRelativePath(entry.overlay, 'addition file')
    if (additions.has(relativePath))
      throw new Error(`Duplicate overlay addition: ${relativePath}`)
    const overlayFile = requireFile(OVERLAY_ROOT, overlay, 'overlay addition')
    if (sha256(fs.readFileSync(overlayFile)) !== entry.overlaySha256)
      throw new Error(`Overlay addition does not match its manifest: ${overlay}`)
    additions.set(relativePath, { ...entry, path: relativePath, overlay, file: overlayFile })
  }

  const declaredOverlayFiles = new Set([
    ...[...overrides.values()].map(entry => entry.overlay),
    ...[...additions.values()].map(entry => entry.overlay),
  ])
  const actualOverlayFiles = [
    ...walkRelativeFiles(OVERLAY_OVERRIDE_ROOT).map(relative => `packages/cli/src/templates/overrides/${relative}`),
    ...walkRelativeFiles(OVERLAY_ADDITION_ROOT).map(relative => `packages/cli/src/templates/additions/${relative}`),
  ]
  for (const relativePath of actualOverlayFiles) {
    if (!declaredOverlayFiles.has(relativePath))
      throw new Error(`Overlay file is not declared in manifest: ${relativePath}`)
  }
  if (actualOverlayFiles.length !== declaredOverlayFiles.size)
    throw new Error('Overlay manifest declares files outside packages/cli/src/templates/{overrides,additions}/')

  cachedState = { additions, manifest, overrides }
  return cachedState
}

export function verifyTemplateSource() {
  return readState().manifest
}

export function readTemplateFile(relativePath) {
  const normalized = safeRelativePath(relativePath, 'template')
  const override = readState().overrides.get(normalized)
  return fs.readFileSync(override?.file ?? requireFile(PACKAGE_TEMPLATE_ROOT, normalized, 'upstream template'), 'utf8')
}

export function listTemplateFiles(relativeRoot, options = {}) {
  const normalizedRoot = safeRelativePath(relativeRoot, 'template root')
  const sourceRoot = path.join(PACKAGE_TEMPLATE_ROOT, ...normalizedRoot.split('/'))
  const files = new Set(walkRelativeFiles(sourceRoot).map(relative => path.posix.join(normalizedRoot, relative)))
  if (options.additions) {
    for (const relativePath of readState().additions.keys()) {
      if (relativePath.startsWith(`${normalizedRoot}/`))
        files.add(relativePath)
    }
  }
  return [...files].sort((left, right) => left.localeCompare(right))
}

export function readTemplateOrAddition(relativePath) {
  const normalized = safeRelativePath(relativePath, 'template or addition')
  const addition = readState().additions.get(normalized)
  return addition ? fs.readFileSync(addition.file, 'utf8') : readTemplateFile(normalized)
}

export function readAddition(relativePath) {
  const normalized = safeRelativePath(relativePath, 'addition')
  const addition = readState().additions.get(normalized)
  if (!addition)
    throw new Error(`Missing declared overlay addition: ${normalized}`)
  return fs.readFileSync(addition.file, 'utf8')
}
