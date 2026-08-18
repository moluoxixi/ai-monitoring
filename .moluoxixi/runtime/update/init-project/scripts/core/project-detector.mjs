import fs from 'node:fs'
import path from 'node:path'

const FRONTEND_INDICATORS = [
  'package.json',
  'vite.config.ts',
  'vite.config.js',
  'next.config.js',
  'next.config.ts',
  'next.config.mjs',
  'nuxt.config.ts',
  'nuxt.config.js',
  'webpack.config.js',
  'rollup.config.js',
  'svelte.config.js',
  'astro.config.mjs',
  'angular.json',
  'vue.config.js',
  'src/App.tsx',
  'src/App.jsx',
  'src/App.vue',
  'src/app/page.tsx',
  'app/page.tsx',
  'pages/index.tsx',
  'pages/index.jsx',
]
const BACKEND_INDICATORS = [
  'go.mod',
  'go.sum',
  'Cargo.toml',
  'Cargo.lock',
  'requirements.txt',
  'pyproject.toml',
  'setup.py',
  'Pipfile',
  'poetry.lock',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
  'composer.json',
  'mix.exs',
  'server.ts',
  'server.js',
  'src/server.ts',
  'src/index.ts',
  '*.csproj',
  '*.fsproj',
]
const FRONTEND_DEPS = ['react', 'vue', 'svelte', 'angular', '@angular/core', 'next', 'nuxt', 'astro', 'solid-js', 'preact', 'lit', '@remix-run/react']
const BACKEND_DEPS = ['express', 'fastify', 'hono', 'koa', 'hapi', 'nest', '@nestjs/core', 'fastapi', 'flask', 'django']
const IGNORED_DIRS = new Set(['node_modules', 'target', 'dist', 'build', 'out', 'bin', 'obj', 'vendor', 'coverage', 'tmp', '__pycache__'])

export function detectProjectType(cwd) {
  const packageTypes = packageJsonTypes(cwd)
  const frontend = FRONTEND_INDICATORS.some(file => fileExists(cwd, file)) || packageTypes.frontend
  const backend = BACKEND_INDICATORS.some(file => fileExists(cwd, file)) || packageTypes.backend
  if (frontend && backend)
    return 'fullstack'
  if (frontend)
    return 'frontend'
  if (backend)
    return 'backend'
  return 'unknown'
}

export function detectMonorepo(cwd) {
  const packages = new Map()
  const submodules = parseGitmodules(cwd)
  let detected = submodules.size > 0
  let workspaceMatched = false
  const parserResults = [
    patternsResult(cwd, parsePnpmWorkspace(cwd)),
    patternsResult(cwd, parseNpmWorkspaces(cwd)),
    cargoResult(cwd),
    directResult(cwd, parseGoWork(cwd)),
    patternsResult(cwd, parseUvWorkspace(cwd)),
  ]
  for (const dirs of parserResults) {
    if (dirs === null)
      continue
    detected = true
    workspaceMatched = true
    for (const directory of dirs)
      addPackage(packages, cwd, directory, submodules.has(normalizePath(directory)), false)
  }
  for (const [directory, name] of submodules) {
    if (!packages.has(directory))
      addPackage(packages, cwd, directory, true, false, name)
  }
  if (!workspaceMatched && submodules.size === 0) {
    const polyrepo = parsePolyrepo(cwd)
    if (polyrepo) {
      detected = true
      for (const directory of polyrepo)
        addPackage(packages, cwd, directory, false, true)
    }
  }
  return detected ? [...packages.values()] : null
}

export function sanitizePackageName(name) {
  return name.replace(/^@[^/]+\//u, '')
}

function addPackage(packages, cwd, directory, isSubmodule, isGitRepo, fallbackName) {
  const normalized = normalizePath(directory)
  if (!normalized || normalized === '.' || packages.has(normalized) || !directoryExists(cwd, normalized))
    return
  packages.set(normalized, {
    name: readPackageName(cwd, normalized, fallbackName),
    path: normalized,
    type: detectProjectType(path.join(cwd, normalized)),
    isSubmodule,
    isGitRepo,
  })
}

function fileExists(cwd, filename) {
  if (!filename.includes('*'))
    return fs.existsSync(path.join(cwd, filename))
  const directory = path.join(cwd, path.dirname(filename))
  const pattern = new RegExp(`^${path.basename(filename).replace(/\./gu, '\\.').replace(/\*/gu, '.*')}$`, 'u')
  try {
    return fs.readdirSync(directory).some(file => pattern.test(file))
  }
  catch {
    return false
  }
}

function packageJsonTypes(cwd) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'))
    const dependencies = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) })
    return {
      frontend: FRONTEND_DEPS.some(dependency => dependencies.includes(dependency)),
      backend: BACKEND_DEPS.some(dependency => dependencies.includes(dependency)),
    }
  }
  catch {
    return { frontend: false, backend: false }
  }
}

function patternsResult(cwd, patterns) {
  return patterns === null ? null : expandPatterns(cwd, patterns)
}

function directResult(cwd, directories) {
  return directories === null ? null : directories.map(normalizePath).filter(directory => directory && directory !== '.' && directoryExists(cwd, directory))
}

function cargoResult(cwd) {
  const workspace = parseCargoWorkspace(cwd)
  if (!workspace)
    return null
  const excluded = new Set(expandPatterns(cwd, workspace.exclude))
  return expandPatterns(cwd, workspace.members).filter(directory => !excluded.has(directory))
}

function expandPatterns(cwd, patterns) {
  const included = []
  const excluded = new Set()
  for (const raw of patterns) {
    const isExclude = raw.startsWith('!')
    const pattern = normalizePath(isExclude ? raw.slice(1) : raw)
    const directories = pattern.includes('*') ? matchSegments(cwd, pattern.split('/'), 0, '') : directoryExists(cwd, pattern) ? [pattern] : []
    for (const directory of directories) {
      if (isExclude)
        excluded.add(directory)
      else included.push(directory)
    }
  }
  return [...new Set(included.filter(directory => !excluded.has(directory)))]
}

function matchSegments(cwd, segments, index, current) {
  if (index === segments.length)
    return directoryExists(cwd, current) ? [current] : []
  if (segments[index] !== '*')
    return matchSegments(cwd, segments, index + 1, current ? `${current}/${segments[index]}` : segments[index])
  try {
    return fs.readdirSync(path.join(cwd, current), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .flatMap(entry => matchSegments(cwd, segments, index + 1, current ? `${current}/${entry.name}` : entry.name))
  }
  catch {
    return []
  }
}

function parsePnpmWorkspace(cwd) {
  try {
    const content = fs.readFileSync(path.join(cwd, 'pnpm-workspace.yaml'), 'utf8')
    const patterns = []
    let inPackages = false
    for (const line of content.split('\n')) {
      const value = line.trim()
      if (/^packages\s*:/u.test(value)) {
        inPackages = true
        continue
      }
      if (inPackages && value.startsWith('- '))
        patterns.push(value.slice(2).trim().replace(/^['"]|['"]$/gu, ''))
      else if (inPackages && value && !value.startsWith('#'))
        break
    }
    return patterns.length > 0 ? patterns : null
  }
  catch {
    return null
  }
}

function parseNpmWorkspaces(cwd) {
  try {
    const workspaces = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).workspaces
    if (Array.isArray(workspaces))
      return workspaces
    return Array.isArray(workspaces?.packages) ? workspaces.packages : null
  }
  catch {
    return null
  }
}

function parseCargoWorkspace(cwd) {
  try {
    const content = fs.readFileSync(path.join(cwd, 'Cargo.toml'), 'utf8')
    if (!/^\[workspace\]\s*$/mu.test(content))
      return null
    const members = parseTomlArray(content, 'members', '[workspace]')
    return members ? { members, exclude: parseTomlArray(content, 'exclude', '[workspace]') ?? [] } : null
  }
  catch {
    return null
  }
}

function parseGoWork(cwd) {
  try {
    const content = fs.readFileSync(path.join(cwd, 'go.work'), 'utf8')
    const paths = []
    const block = /use\s*\(([\s\S]*?)\)/u.exec(content)
    if (block)
      paths.push(...block[1].split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('//')))
    for (const match of content.matchAll(/^use\s+(\S+)\s*$/gmu)) {
      if (!match[1].startsWith('('))
        paths.push(match[1])
    }
    return paths.length > 0 ? paths : null
  }
  catch {
    return null
  }
}

function parseUvWorkspace(cwd) {
  try {
    const content = fs.readFileSync(path.join(cwd, 'pyproject.toml'), 'utf8')
    return content.includes('[tool.uv.workspace]') ? parseTomlArray(content, 'members', '[tool.uv.workspace]') : null
  }
  catch {
    return null
  }
}

function parseTomlArray(content, key, section) {
  const sectionIndex = content.indexOf(section)
  if (sectionIndex < 0)
    return null
  const tail = content.slice(sectionIndex + section.length)
  const nextSection = tail.search(/^\[[^[]/mu)
  const body = nextSection < 0 ? tail : tail.slice(0, nextSection)
  const match = new RegExp(`${key}\\s*=\\s*\\[`, 'u').exec(body)
  if (!match)
    return null
  const end = body.indexOf(']', match.index + match[0].length)
  if (end < 0)
    return null
  return body.slice(match.index + match[0].length, end).split(/[,\n]/u).map(value => value.trim().replace(/^['"]|['"]$/gu, '')).filter(value => value && !value.startsWith('#'))
}

function parseGitmodules(cwd) {
  const result = new Map()
  try {
    const content = fs.readFileSync(path.join(cwd, '.gitmodules'), 'utf8')
    let name
    for (const line of content.split('\n')) {
      const header = /^\[submodule\s+"([^"]+)"\]/u.exec(line.trim())
      if (header) {
        name = header[1]
        continue
      }
      const setting = /^path\s*=\s*(.+)/u.exec(line.trim())
      if (setting && name)
        result.set(normalizePath(setting[1]), name)
    }
  }
  catch {}
  return result
}

function parsePolyrepo(cwd) {
  const found = []
  function scan(relative, depth) {
    if (depth >= 2)
      return
    try {
      for (const entry of fs.readdirSync(path.join(cwd, relative), { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name))
          continue
        const child = relative ? `${relative}/${entry.name}` : entry.name
        if (fs.existsSync(path.join(cwd, child, '.git')))
          found.push(child)
        else scan(child, depth + 1)
      }
    }
    catch {}
  }
  scan('', 0)
  return found.length >= 2 ? found : null
}

function readPackageName(cwd, packagePath, fallback) {
  const root = path.join(cwd, packagePath)
  try {
    const name = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name
    if (name)
      return name
  }
  catch {}
  for (const [file, expression] of [
    ['Cargo.toml', /\[package\][\s\S]*?name\s*=\s*"([^"]+)"/u],
    ['pyproject.toml', /\[project\][\s\S]*?name\s*=\s*"([^"]+)"/u],
    ['go.mod', /^module\s+(\S+)/mu],
  ]) {
    try {
      const match = expression.exec(fs.readFileSync(path.join(root, file), 'utf8'))
      if (match)
        return file === 'go.mod' ? match[1].split('/').at(-1) : match[1]
    }
    catch {}
  }
  return fallback ?? path.basename(packagePath)
}

function normalizePath(value) {
  return String(value).replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/+$/u, '')
}

function directoryExists(cwd, relativePath) {
  try {
    return fs.statSync(path.join(cwd, relativePath)).isDirectory()
  }
  catch {
    return false
  }
}
