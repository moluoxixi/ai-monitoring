import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

const DEFAULT_SOURCE = 'gh:mindfold-ai/marketplace'
const INDEX_TIMEOUT = 5_000
const DOWNLOAD_TIMEOUT = 30_000
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 25_000
const PUBLIC_DOMAINS = new Map([
  ['github.com', 'gh'],
  ['gitlab.com', 'gitlab'],
  ['bitbucket.org', 'bitbucket'],
])

export class RegistryError extends Error {
  constructor(kind, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'RegistryError'
    this.kind = kind
    this.stage = options.stage
  }
}

export async function listWorkflowTemplates(source) {
  const registry = parseRegistrySource(source)
  const probe = await probeRegistryIndex(registry)
  const index = requireRegistryIndex(probe)
  return [nativeWorkflowListing(), ...index.templates
    .filter(template => template.type === 'workflow' && template.id !== 'native')
    .map(template => ({ ...template, source: 'marketplace' }))]
}

export async function resolveWorkflowTemplate(id, source, nativeContent) {
  if (id === 'native')
    return { ...nativeWorkflowListing(), content: nativeContent }
  const registry = parseRegistrySource(source)
  const probe = await probeRegistryIndex(registry)
  const index = requireRegistryIndex(probe)
  const entry = index.templates.find(template => template.type === 'workflow' && template.id === id)
  if (!entry) {
    const available = index.templates.filter(template => template.type === 'workflow').map(template => template.id)
    throw new RegistryError('not-found', `Workflow template "${id}" not found.${available.length > 0 ? ` Available: ${available.join(', ')}` : ''}`)
  }
  if (!entry.path.endsWith('.md'))
    throw new RegistryError('path-not-found', `Workflow template "${id}" must point to a Markdown file`)
  return { ...entry, content: await readRegistryFile(registry, entry.path, probe.backend), source: 'marketplace' }
}

export async function resolveSpecTemplate(templateId, source) {
  const registry = parseRegistrySource(source)
  const probe = await probeRegistryIndex(registry)
  let template
  let relativeRoot = registry.subdir
  if (probe.status === 'found') {
    if (!templateId)
      throw new RegistryError('invalid-json', 'Registry has index.json; --template is required')
    template = probe.index.templates.find(candidate => candidate.type === 'spec' && candidate.id === templateId)
    if (!template)
      throw new RegistryError('not-found', `Spec template "${templateId}" not found`)
    relativeRoot = joinRegistryPath(registry.subdir, template.path)
  }
  else if (templateId) {
    throw new RegistryError('not-found', 'Registry has no index.json; remove --template to use direct registry mode')
  }

  const checkout = probe.backend === 'http' ? await downloadRegistryArchive(registry) : checkoutRegistry(registry)
  try {
    const sourceRoot = resolveInside(checkout.directory, relativeRoot)
    if (!fs.statSync(sourceRoot, { throwIfNoEntry: false })?.isDirectory())
      throw new RegistryError('path-not-found', `Spec template path not found: ${relativeRoot || '.'}`)
    return {
      files: collectFiles(sourceRoot),
      registry: source ?? DEFAULT_SOURCE,
      template: template?.id,
    }
  }
  finally {
    checkout.cleanup()
  }
}

export function parseRegistrySource(source = DEFAULT_SOURCE) {
  if (typeof source !== 'string' || !source.trim())
    throw new RegistryError('unknown', 'Invalid registry source: expected a non-empty string')
  const ssh = parseSshSource(source)
  if (ssh)
    return ssh

  const normalized = normalizeRegistrySource(source)
  const prefixed = /^(gh|github|gitlab|bitbucket):([^#]+)(?:#(.+))?$/u.exec(normalized)
  if (prefixed) {
    const provider = prefixed[1] === 'github' ? 'gh' : prefixed[1]
    const segments = prefixed[2].replace(/\.git$/u, '').split('/').filter(Boolean)
    if (segments.length < 2)
      throw new RegistryError('unknown', `Invalid registry source: ${source}`)
    const repo = segments.slice(0, 2).join('/')
    return createRegistry({
      provider,
      repo,
      subdir: segments.slice(2).join('/'),
      ref: prefixed[3] ?? 'main',
      source,
      sourceKind: normalized === source ? 'prefixed' : 'https',
    })
  }

  let url
  try {
    url = new URL(source)
  }
  catch (error) {
    throw new RegistryError('unknown', `Invalid registry source: ${source}`, { cause: error })
  }
  if (!['http:', 'https:'].includes(url.protocol))
    throw new RegistryError('unknown', `Unsupported registry protocol: ${url.protocol}`)
  const browse = /^\/([^/]+\/[^/]+)(?:\/-)?\/tree\/([^/]+)(?:\/(.*))?$/u.exec(url.pathname)
  const segments = url.pathname.replace(/^\//u, '').replace(/\.git\/?$/u, '').split('/').filter(Boolean)
  if (!browse && segments.length < 2)
    throw new RegistryError('unknown', `Invalid registry source: ${source}`)
  return createRegistry({
    provider: 'gitlab',
    repo: browse ? browse[1] : segments.slice(0, 2).join('/'),
    subdir: browse ? browse[3] ?? '' : segments.slice(2).join('/'),
    ref: url.hash ? decodeURIComponent(url.hash.slice(1)) : browse?.[2] ?? 'main',
    source,
    sourceKind: 'https',
    host: url.host,
  })
}

export async function probeRegistryIndex(registry) {
  if (registry.preferGit)
    return probeGitIndex(registry)
  const httpProbe = await probeHttpIndex(registry)
  if (registry.provider === 'gitlab' && httpProbe.status === 'error' && ['auth', 'invalid-json'].includes(httpProbe.error.kind))
    return probeGitIndex(registry)
  if (httpProbe.status === 'error')
    throw httpProbe.error
  return httpProbe
}

function parseSshSource(source) {
  const hashIndex = source.lastIndexOf('#')
  const sourceWithoutRef = hashIndex >= 0 ? source.slice(0, hashIndex) : source
  const ref = hashIndex >= 0 ? source.slice(hashIndex + 1) : 'main'
  const scp = /^git@([^:]+):(.+?)\/?$/u.exec(sourceWithoutRef)
  const protocol = /^ssh:\/\/git@([^/:]+)(?::(\d+))?\/(.+?)\/?$/u.exec(sourceWithoutRef)
  if (!scp && !protocol)
    return undefined
  const host = scp?.[1] ?? protocol[1]
  const repositoryPath = (scp?.[2] ?? protocol[3]).replace(/\.git$/u, '')
  const segments = repositoryPath.split('/').filter(Boolean)
  if (segments.length < 2)
    throw new RegistryError('unknown', `Invalid registry source: ${source}`)
  const repo = segments.slice(0, 2).join('/')
  const provider = PUBLIC_DOMAINS.get(host) ?? 'gitlab'
  const port = protocol?.[2] ? `:${protocol[2]}` : ''
  const gitUrl = protocol ? `ssh://git@${host}${port}/${repo}.git` : `git@${host}:${repo}.git`
  return createRegistry({
    provider,
    repo,
    subdir: segments.slice(2).join('/'),
    ref: ref || 'main',
    source,
    sourceKind: 'ssh',
    host: PUBLIC_DOMAINS.has(host) ? undefined : host,
    gitUrl,
  })
}

function normalizeRegistrySource(source) {
  for (const [host, provider] of PUBLIC_DOMAINS) {
    const expression = new RegExp(`^https?://${escapeRegExp(host)}/`, 'u')
    if (!expression.test(source))
      continue
    const value = source.replace(expression, '')
    const hashIndex = value.lastIndexOf('#')
    const ref = hashIndex >= 0 ? value.slice(hashIndex + 1) : undefined
    const pathPart = (hashIndex >= 0 ? value.slice(0, hashIndex) : value).replace(/\.git\/?$/u, '').replace(/\/$/u, '')
    const segments = pathPart.split('/').filter(Boolean)
    if (segments.length >= 4 && segments[2] === 'tree') {
      const repo = segments.slice(0, 2).join('/')
      const subdir = segments.slice(4).join('/')
      return `${provider}:${repo}${subdir ? `/${subdir}` : ''}#${ref ?? segments[3]}`
    }
    return `${provider}:${pathPart}${ref ? `#${ref}` : ''}`
  }
  return source
}

function createRegistry({ provider, repo, subdir, ref, source, sourceKind, host, gitUrl }) {
  assertRelative(repo)
  assertRelative(subdir || '.')
  if (!ref || /[\0\r\n]/u.test(ref))
    throw new RegistryError('ref-not-found', `Invalid registry ref: ${ref}`)
  const publicHost = provider === 'gh' ? 'github.com' : provider === 'gitlab' ? 'gitlab.com' : 'bitbucket.org'
  const effectiveHost = host ?? publicHost
  const rawBaseUrl = provider === 'gh'
    ? `https://raw.githubusercontent.com/${repo}/${ref}/${subdir}`
    : provider === 'gitlab'
      ? `https://${effectiveHost}/${repo}/-/raw/${ref}/${subdir}`
      : `https://bitbucket.org/${repo}/raw/${ref}/${subdir}`
  return {
    provider,
    repo,
    subdir,
    ref,
    source,
    sourceKind,
    host,
    preferGit: sourceKind === 'ssh' || host !== undefined,
    gitUrl: gitUrl ?? `https://${effectiveHost}/${repo}.git`,
    rawBaseUrl: rawBaseUrl.replace(/\/$/u, ''),
    indexUrl: `${rawBaseUrl.replace(/\/$/u, '')}/index.json`,
  }
}

async function probeHttpIndex(registry) {
  try {
    const response = await fetch(registry.indexUrl, { signal: AbortSignal.timeout(INDEX_TIMEOUT) })
    if (response.status === 404)
      return { status: 'missing', backend: 'http' }
    if (!response.ok)
      return { status: 'error', backend: 'http', error: httpStatusError(response.status, 'registry index') }
    return { status: 'found', backend: 'http', index: parseIndex(await response.text()) }
  }
  catch (error) {
    return { status: 'error', backend: 'http', error: normalizeNetworkError(error, 'registry index') }
  }
}

function probeGitIndex(registry) {
  const checkout = checkoutRegistry(registry)
  try {
    const indexPath = resolveInside(checkout.directory, joinRegistryPath(registry.subdir, 'index.json'))
    const stats = fs.lstatSync(indexPath, { throwIfNoEntry: false })
    if (!stats)
      return { status: 'missing', backend: 'git' }
    if (!stats.isFile() || stats.isSymbolicLink())
      throw new RegistryError('path-not-found', 'Registry index.json is not a regular file')
    return { status: 'found', backend: 'git', index: parseIndex(fs.readFileSync(indexPath, 'utf8')) }
  }
  finally {
    checkout.cleanup()
  }
}

function requireRegistryIndex(probe) {
  if (probe.status === 'missing')
    throw new RegistryError('not-found', 'Registry has no index.json')
  return probe.index
}

function parseIndex(content) {
  let parsed
  try {
    parsed = JSON.parse(content)
  }
  catch (error) {
    throw new RegistryError('invalid-json', 'Registry index.json contains invalid JSON', { cause: error })
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.templates))
    throw new RegistryError('invalid-json', 'Registry index.json is malformed')
  const templates = parsed.templates.map((template) => {
    if (!template || typeof template.id !== 'string' || typeof template.type !== 'string' || typeof template.name !== 'string' || typeof template.path !== 'string')
      throw new RegistryError('invalid-json', 'Registry index contains a malformed template')
    assertRelative(template.path)
    return template
  })
  return { version: parsed.version, templates }
}

async function readRegistryFile(registry, relativePath, backend) {
  assertRelative(relativePath)
  if (backend === 'http') {
    const url = `${registry.rawBaseUrl}/${relativePath}`
    let response
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT) })
    }
    catch (error) {
      throw normalizeNetworkError(error, `registry file ${relativePath}`)
    }
    if (!response.ok)
      throw httpStatusError(response.status, `registry file ${relativePath}`)
    return response.text()
  }
  const checkout = checkoutRegistry(registry)
  try {
    const target = resolveInside(checkout.directory, joinRegistryPath(registry.subdir, relativePath))
    const stats = fs.lstatSync(target, { throwIfNoEntry: false })
    if (!stats?.isFile() || stats.isSymbolicLink())
      throw new RegistryError('path-not-found', `Registry file not found: ${relativePath}`)
    return fs.readFileSync(target, 'utf8')
  }
  finally {
    checkout.cleanup()
  }
}

async function downloadRegistryArchive(registry) {
  const archiveUrl = registryArchiveUrl(registry)
  let response
  try {
    response = await fetch(archiveUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT) })
  }
  catch (error) {
    throw normalizeNetworkError(error, 'registry archive')
  }
  if (!response.ok)
    throw httpStatusError(response.status, 'registry archive')
  const declaredSize = Number(response.headers.get('content-length') ?? 0)
  if (declaredSize > MAX_ARCHIVE_BYTES)
    throw new RegistryError('network', `Registry archive exceeds ${MAX_ARCHIVE_BYTES} bytes`)
  const archive = Buffer.from(await response.arrayBuffer())
  if (archive.byteLength > MAX_ARCHIVE_BYTES)
    throw new RegistryError('network', `Registry archive exceeds ${MAX_ARCHIVE_BYTES} bytes`)

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'moluoxixi-registry-http-'))
  try {
    extractTarGzip(archive, temporaryRoot)
    const roots = fs.readdirSync(temporaryRoot, { withFileTypes: true })
    if (roots.length !== 1 || !roots[0].isDirectory())
      throw new RegistryError('invalid-json', 'Registry archive must contain one repository root directory')
    const directory = path.join(temporaryRoot, roots[0].name)
    return { directory, cleanup: () => removeBestEffort(temporaryRoot) }
  }
  catch (error) {
    removeBestEffort(temporaryRoot)
    if (error instanceof RegistryError)
      throw error
    throw new RegistryError('network', 'Could not extract registry archive', { cause: error })
  }
}

function registryArchiveUrl(registry) {
  const encodedRef = encodeURIComponent(registry.ref)
  if (registry.provider === 'gh')
    return `https://codeload.github.com/${registry.repo}/tar.gz/${encodedRef}`
  if (registry.provider === 'gitlab') {
    const repoName = registry.repo.split('/').at(-1)
    const fileName = encodeURIComponent(`${repoName}-${registry.ref.replaceAll('/', '-')}`)
    return `https://gitlab.com/${registry.repo}/-/archive/${encodedRef}/${fileName}.tar.gz`
  }
  return `https://bitbucket.org/${registry.repo}/get/${encodedRef}.tar.gz`
}

export function extractTarGzip(archive, outputRoot) {
  let tar
  try {
    tar = gunzipSync(archive, { maxOutputLength: MAX_EXTRACTED_BYTES })
  }
  catch (error) {
    throw new RegistryError('network', 'Registry archive is not a valid bounded gzip stream', { cause: error })
  }
  let offset = 0
  let entries = 0
  let extractedBytes = 0
  let nextPath
  let nextPax = {}
  while (offset + 512 <= tar.byteLength) {
    const header = tar.subarray(offset, offset + 512)
    offset += 512
    if (header.every(byte => byte === 0))
      break
    verifyTarChecksum(header)
    entries += 1
    if (entries > MAX_ARCHIVE_ENTRIES)
      throw new RegistryError('network', 'Registry archive contains too many entries')
    const size = readTarOctal(header.subarray(124, 136))
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_EXTRACTED_BYTES || offset + size > tar.byteLength)
      throw new RegistryError('network', 'Registry archive contains an invalid entry size')
    const body = tar.subarray(offset, offset + size)
    offset += Math.ceil(size / 512) * 512
    const type = String.fromCharCode(header[156] || 48)
    if (type === 'x' || type === 'g') {
      const pax = parsePax(body)
      if (type === 'x')
        nextPax = pax
      continue
    }
    if (type === 'L') {
      nextPath = readTarString(body)
      continue
    }
    const headerPath = [readTarString(header.subarray(345, 500)), readTarString(header.subarray(0, 100))].filter(Boolean).join('/')
    const relativePath = nextPax.path ?? nextPath ?? headerPath
    nextPath = undefined
    nextPax = {}
    assertRelative(relativePath)
    const target = resolveInside(outputRoot, relativePath)
    if (type === '5') {
      fs.mkdirSync(target, { recursive: true })
      continue
    }
    if (type !== '0' && type !== '\0')
      throw new RegistryError('path-not-found', `Registry archive contains an unsupported entry type: ${relativePath}`)
    extractedBytes += size
    if (extractedBytes > MAX_EXTRACTED_BYTES)
      throw new RegistryError('network', 'Registry archive expands beyond its safety limit')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, body)
  }
}

function parsePax(content) {
  const result = {}
  let offset = 0
  while (offset < content.byteLength) {
    const space = content.indexOf(0x20, offset)
    if (space < 0)
      break
    const length = Number(content.subarray(offset, space).toString('ascii'))
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > content.byteLength)
      throw new RegistryError('network', 'Registry archive contains malformed PAX metadata')
    const record = content.subarray(space + 1, offset + length).toString('utf8').replace(/\n$/u, '')
    const separator = record.indexOf('=')
    if (separator > 0)
      result[record.slice(0, separator)] = record.slice(separator + 1)
    offset += length
  }
  return result
}

function verifyTarChecksum(header) {
  const expected = readTarOctal(header.subarray(148, 156))
  let actual = 0
  for (let index = 0; index < header.byteLength; index += 1)
    actual += index >= 148 && index < 156 ? 0x20 : header[index]
  if (expected !== actual)
    throw new RegistryError('network', 'Registry archive failed its TAR checksum')
}

function readTarOctal(value) {
  const text = readTarString(value).trim()
  return text ? Number.parseInt(text, 8) : 0
}

function readTarString(value) {
  const zero = value.indexOf(0)
  return value.subarray(0, zero < 0 ? value.byteLength : zero).toString('utf8').trim()
}

function checkoutRegistry(registry) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'moluoxixi-registry-git-'))
  const clone = spawnSync('git', ['clone', '--filter=blob:none', '--no-checkout', registry.gitUrl, directory], {
    encoding: 'utf8',
    timeout: DOWNLOAD_TIMEOUT,
    windowsHide: true,
  })
  if (clone.error || clone.status !== 0) {
    removeBestEffort(directory)
    throw classifyGitError('clone', clone, registry)
  }
  const fetchResult = spawnSync('git', ['-C', directory, 'fetch', '--depth', '1', 'origin', registry.ref], {
    encoding: 'utf8',
    timeout: DOWNLOAD_TIMEOUT,
    windowsHide: true,
  })
  if (fetchResult.error || fetchResult.status !== 0) {
    removeBestEffort(directory)
    throw classifyGitError('fetch', fetchResult, registry)
  }
  const checkout = spawnSync('git', ['-C', directory, 'checkout', '--detach', 'FETCH_HEAD'], {
    encoding: 'utf8',
    timeout: DOWNLOAD_TIMEOUT,
    windowsHide: true,
  })
  if (checkout.error || checkout.status !== 0) {
    removeBestEffort(directory)
    throw classifyGitError('checkout', checkout, registry)
  }
  return { directory, cleanup: () => removeBestEffort(directory) }
}

function classifyGitError(stage, result, registry) {
  const message = `${result.stderr ?? ''}\n${result.stdout ?? ''}\n${result.error?.message ?? ''}`.trim()
  const normalized = message.toLowerCase()
  if (result.error?.code === 'ENOENT')
    return new RegistryError('git-unavailable', 'Git is required for this registry source but is unavailable', { cause: result.error, stage })
  if (result.error?.code === 'ETIMEDOUT' || /timed? out|could not resolve host|failed to connect|network is unreachable/u.test(normalized))
    return new RegistryError('network', `Could not ${stage} registry ${registry.gitUrl}: ${message}`, { cause: result.error, stage })
  if (/authentication|permission denied|publickey|access denied|terminal prompts disabled|http basic: access denied|\b401\b|\b403\b/u.test(normalized))
    return new RegistryError('auth', `Registry authentication failed for ${registry.gitUrl}: ${message}`, { cause: result.error, stage })
  if (/couldn't find remote ref|invalid refspec|not a valid object name|pathspec .* did not match/u.test(normalized))
    return new RegistryError('ref-not-found', `Registry ref not found: ${registry.ref}`, { cause: result.error, stage })
  if (/repository .* not found|does not appear to be a git repository|not found/u.test(normalized))
    return new RegistryError('not-found', `Registry repository not found: ${registry.gitUrl}`, { cause: result.error, stage })
  return new RegistryError('unknown', `Could not ${stage} registry ${registry.gitUrl}: ${message}`, { cause: result.error, stage })
}

function collectFiles(root) {
  const files = new Map()
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === '.git')
        continue
      const target = path.join(current, entry.name)
      const stats = fs.lstatSync(target)
      if (stats.isSymbolicLink())
        throw new RegistryError('path-not-found', `Registry template contains an unsupported symbolic link: ${target}`)
      if (stats.isDirectory()) {
        visit(target)
      }
      else if (stats.isFile()) {
        const relative = path.relative(root, target).split(path.sep).join('/')
        assertRelative(relative)
        files.set(relative, fs.readFileSync(target))
      }
      else {
        throw new RegistryError('path-not-found', `Registry template contains an unsupported entry: ${target}`)
      }
    }
  }
  visit(root)
  return files
}

function resolveInside(root, relativePath) {
  assertRelative(relativePath || '.')
  const absoluteRoot = path.resolve(root)
  const target = path.resolve(absoluteRoot, relativePath || '.')
  const relation = path.relative(absoluteRoot, target)
  if (relation === '..' || relation.startsWith(`..${path.sep}`) || path.isAbsolute(relation))
    throw new RegistryError('path-not-found', `Registry path escapes its root: ${relativePath}`)
  let current = absoluteRoot
  for (const segment of relation.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    const stats = fs.lstatSync(current, { throwIfNoEntry: false })
    if (stats?.isSymbolicLink())
      throw new RegistryError('path-not-found', `Registry path contains a symbolic link: ${relativePath}`)
  }
  return target
}

function assertRelative(value) {
  const normalized = String(value).replace(/\\/gu, '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized) || normalized.split('/').includes('..') || normalized.includes('\0'))
    throw new RegistryError('path-not-found', `Unsafe registry path: ${value}`)
}

function joinRegistryPath(...values) {
  return values.filter(Boolean).join('/').replace(/\/+/gu, '/')
}

function httpStatusError(status, label) {
  if (status === 401 || status === 403)
    return new RegistryError('auth', `Registry authentication failed while fetching ${label} (HTTP ${status})`)
  if (status === 404)
    return new RegistryError('not-found', `Registry ${label} was not found (HTTP 404)`)
  return new RegistryError('network', `Could not fetch ${label} (HTTP ${status})`)
}

function normalizeNetworkError(error, label) {
  if (error instanceof RegistryError)
    return error
  const timedOut = error?.name === 'AbortError' || error?.name === 'TimeoutError'
  return new RegistryError('network', timedOut ? `Timed out while fetching ${label}` : `Could not fetch ${label}: ${String(error)}`, { cause: error })
}

function removeBestEffort(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true })
  }
  catch {
    // Cleanup cannot change the completed semantic result.
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function nativeWorkflowListing() {
  return {
    id: 'native',
    type: 'workflow',
    name: 'Native Moluoxixi Workflow',
    description: 'Default Moluoxixi Plan / Execute / Finish workflow bundled with the role',
    path: 'bundled:moluoxixi/workflow.md',
    source: 'bundled',
  }
}
