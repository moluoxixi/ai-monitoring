import { TextDecoder } from 'node:util'
import { sha256 } from '../constants.mjs'

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

export class InvalidUtf8Error extends Error {}

export function decodeUtf8(content) {
  if (content.includes(0))
    throw new InvalidUtf8Error('Managed block target is not UTF-8 text')
  try {
    return UTF8_DECODER.decode(content)
  }
  catch (error) {
    throw new InvalidUtf8Error('Managed block target is not UTF-8 text', { cause: error })
  }
}

export function mergeJson(current, template) {
  if (Array.isArray(current) && Array.isArray(template)) {
    const result = [...current]
    const known = new Set(result.map(value => JSON.stringify(value)))
    for (const value of template) {
      const key = JSON.stringify(value)
      if (!known.has(key))
        result.push(value)
    }
    return result
  }
  if (isObject(current) && isObject(template)) {
    const result = { ...current }
    for (const [key, value] of Object.entries(template))
      result[key] = key in current ? mergeJson(current[key], value) : value
    return result
  }
  return current
}

export function upgradeJson(current, previousTemplate, nextTemplate) {
  if (Array.isArray(current) && Array.isArray(nextTemplate))
    return mergeJson(current, nextTemplate)
  if (isObject(current) && isObject(nextTemplate)) {
    const previous = isObject(previousTemplate) ? previousTemplate : {}
    const result = { ...current }
    for (const [key, value] of Object.entries(nextTemplate)) {
      if (!(key in current)) {
        result[key] = value
        continue
      }
      result[key] = upgradeJson(current[key], previous[key], value)
    }
    return result
  }
  return previousTemplate !== undefined && jsonEqual(current, previousTemplate) ? nextTemplate : current
}

export function restoreJson(original, baseline, current) {
  const result = restoreJsonValue(original, true, baseline, true, current, true)
  return result.conflict ? { conflict: true } : { conflict: false, value: result.present ? result.value : undefined }
}

export function mergeConfig(current, template, owned, configSections) {
  if (owned && owned.baselineHash && sha256Text(current) === owned.baselineHash)
    return template
  let result = current.replace(/\r\n/gu, '\n')
  const available = extractConfigSections(template)
  const sections = Array.isArray(configSections)
    ? configSections.map((requested) => {
        const section = available.find(candidate => candidate.heading === `# ${requested.sectionHeading}`)
        return section ? { ...section, sentinel: requested.sentinel } : undefined
      }).filter(Boolean)
    : available
  for (const section of sections) {
    if (!result.includes(section.sentinel))
      result = `${result.replace(/\s*$/u, '')}\n\n${section.content.trim()}\n`
  }
  return result
}

export function upsertBlock(current, template, kind) {
  const effectiveKind = kind === 'block-hash' && !template.trimStart().startsWith('#') ? 'block-html' : kind
  const markers = blockMarkers(effectiveKind, 'MOLUOXIXI')
  const managed = kind === 'block-moluoxixi' ? template.trim() : `${markers[0]}\n${template.trim()}\n${markers[1]}`
  const start = current.indexOf(markers[0])
  const end = current.indexOf(markers[1])
  if ((start >= 0) !== (end >= 0) || (start >= 0 && current.includes(markers[0], start + markers[0].length)))
    throw new Error('Malformed or duplicate managed block')
  if (start < 0)
    return current.trim() ? `${trimTrailingBlockBoundary(current)}\n\n${managed}\n` : `${managed}\n`
  if (end < start)
    throw new Error('Malformed managed block order')
  const updated = `${current.slice(0, start)}${managed}${current.slice(end + markers[1].length)}`
  return /\r?\n$/u.test(updated) ? updated : `${updated}\n`
}

export function removeManagedBlock(current, kind, baseline, force = false) {
  const currentRange = managedBlockRange(current, kind)
  if (!currentRange)
    return { conflict: !force, content: current }
  if (!force && baseline !== undefined) {
    const baselineRange = managedBlockRange(baseline, kind)
    if (!baselineRange || current.slice(currentRange.start, currentRange.end) !== baseline.slice(baselineRange.start, baselineRange.end))
      return { conflict: true, content: current }
  }
  const newline = current.includes('\r\n') ? '\r\n' : '\n'
  const before = trimTrailingBlockBoundary(current.slice(0, currentRange.start))
  const after = current.slice(currentRange.end).replace(/^(?:[ \t]*\r?\n)+/u, '')
  const joined = before && after ? `${before}${newline}${newline}${after}` : before || after
  const content = joined && !/\r?\n$/u.test(joined) ? `${joined}${newline}` : joined
  return { conflict: false, content }
}

function trimTrailingBlockBoundary(content) {
  return content.replace(/(?:\r?\n[ \t]*)+$/u, '')
}

function blockMarkers(kind, brand) {
  if (kind === 'block-moluoxixi')
    return [`<!-- ${brand}:START -->`, `<!-- ${brand}:END -->`]
  if (kind === 'block-hash')
    return [`# AIRULES:${brand}:START`, `# AIRULES:${brand}:END`]
  return [`<!-- AIRULES:${brand}:START -->`, `<!-- AIRULES:${brand}:END -->`]
}

function managedBlockRange(content, kind) {
  const candidates = kind === 'block-hash' ? ['block-hash', 'block-html'] : [kind]
  const matches = candidates
    .map(candidate => blockMarkers(candidate, 'MOLUOXIXI'))
    .filter(markers => content.includes(markers[0]) || content.includes(markers[1]))
  if (matches.length === 0)
    return undefined
  if (matches.length > 1)
    throw new Error('Multiple managed block marker styles exist')
  const markers = matches[0]
  const start = content.indexOf(markers[0])
  const markerEnd = content.indexOf(markers[1])
  if (start < 0 && markerEnd < 0)
    return undefined
  if (start < 0 || markerEnd < start || content.includes(markers[0], start + markers[0].length))
    throw new Error('Malformed or duplicate managed block')
  return { start, end: markerEnd + markers[1].length }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function extractConfigSections(content) {
  const lines = content.split('\n')
  const starts = []
  for (let index = 0; index < lines.length; index += 1) {
    if (/^#-+$/u.test(lines[index].trim()) && index + 1 < lines.length)
      starts.push(index)
  }
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? lines.length
    const content = lines.slice(start, end).join('\n')
    const heading = lines[start + 1]?.trim() ?? ''
    return { heading, sentinel: heading, content }
  })
}

function sha256Text(value) {
  return sha256(value)
}

function restoreJsonValue(original, originalPresent, baseline, baselinePresent, current, currentPresent) {
  if (originalPresent === baselinePresent && (!originalPresent || jsonEqual(original, baseline)))
    return { conflict: false, present: currentPresent, value: current }
  if (currentPresent === baselinePresent && (!currentPresent || jsonEqual(current, baseline)))
    return { conflict: false, present: originalPresent, value: original }
  if (isObject(original) && isObject(baseline) && isObject(current)) {
    const value = { ...current }
    let conflict = false
    const keys = new Set([...Object.keys(original), ...Object.keys(baseline)])
    for (const key of keys) {
      const restored = restoreJsonValue(original[key], key in original, baseline[key], key in baseline, current[key], key in current)
      conflict ||= restored.conflict
      if (restored.present)
        value[key] = restored.value
      else delete value[key]
    }
    return { conflict, present: true, value }
  }
  return { conflict: true, present: currentPresent, value: current }
}
