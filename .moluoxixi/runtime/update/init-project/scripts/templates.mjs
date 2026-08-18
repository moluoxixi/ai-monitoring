import fs from 'node:fs'
import path from 'node:path'
import {
  PACKAGE_TEMPLATE_ROOT,
  toPosix,
} from './constants.mjs'

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
      else throw new Error(`Unsupported template entry: ${target}`)
    }
  }
  visit(root)
  return files
}

export function verifyTemplateSource() {
  if (!fs.statSync(PACKAGE_TEMPLATE_ROOT, { throwIfNoEntry: false })?.isDirectory())
    throw new Error(`Finalized package templates are missing: ${PACKAGE_TEMPLATE_ROOT}`)
}

export function readTemplateFile(relativePath) {
  const normalized = safeRelativePath(relativePath, 'template')
  return fs.readFileSync(requireFile(PACKAGE_TEMPLATE_ROOT, normalized, 'finalized template'), 'utf8')
}

export function listTemplateFiles(relativeRoot) {
  const normalizedRoot = safeRelativePath(relativeRoot, 'template root')
  const sourceRoot = path.join(PACKAGE_TEMPLATE_ROOT, ...normalizedRoot.split('/'))
  return walkRelativeFiles(sourceRoot)
    .map(relative => path.posix.join(normalizedRoot, relative))
    .sort((left, right) => left.localeCompare(right))
}

export function readTemplateOrAddition(relativePath) {
  return readTemplateFile(relativePath)
}

export function readAddition(relativePath) {
  return readTemplateFile(relativePath)
}
