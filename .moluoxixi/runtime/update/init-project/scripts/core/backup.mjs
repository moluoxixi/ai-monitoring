import fs from 'node:fs'
import path from 'node:path'
import { PROJECT_ROOT_DIR } from '../constants.mjs'
import { assertSafeTarget } from './safety.mjs'

const MANAGED_PATHS = [
  PROJECT_ROOT_DIR,
  '.claude',
  '.cursor',
  '.opencode',
  '.codex',
  '.kilocode',
  '.kiro/skills',
  '.kiro/agents',
  '.kiro/hooks',
  '.gemini',
  '.agents/skills',
  '.agent/workflows',
  '.agent/skills',
  '.devin/workflows',
  '.devin/skills',
  '.qoder',
  '.codebuddy',
  '.github/copilot',
  '.github/agents',
  '.github/copilot-instructions.md',
  '.github/hooks',
  '.github/prompts',
  '.github/skills',
  '.factory',
  '.pi',
  '.reasonix',
  '.zcode',
  '.zcode/cli/agents',
  '.zcode/agents',
  '.zcode/commands',
  '.zcode/skills',
  '.trae',
  '.omp',
  'AGENTS.md',
]

const EXCLUDED = [
  '.backup-',
  '/node_modules',
  '/workspace/',
  '/tasks/',
  '/spec/',
  '/spec-proposals/',
  '/backlog/',
  '/agent-traces/',
  '/worktrees/',
  '/worktree/',
]

export function createPersistentBackup(projectRoot) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)
  const relativeRoot = `${PROJECT_ROOT_DIR}/.backup-${stamp}`
  const backupRoot = assertSafeTarget(projectRoot, relativeRoot)
  const files = new Set()
  for (const managedPath of MANAGED_PATHS) {
    const source = assertSafeTarget(projectRoot, managedPath)
    collectFiles(source, projectRoot, files)
  }
  let copied = 0
  for (const relativePath of [...files].sort()) {
    if (shouldExcludeFromBackup(relativePath))
      continue
    const source = assertSafeTarget(projectRoot, relativePath)
    const target = path.join(backupRoot, ...relativePath.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
    copied += 1
  }
  if (copied === 0)
    return undefined
  return relativeRoot
}

export function shouldExcludeFromBackup(relativePath) {
  const normalized = relativePath.replace(/\\/gu, '/')
  return EXCLUDED.some(pattern => normalized.includes(pattern))
}

function collectFiles(target, projectRoot, files) {
  const relativePath = path.relative(projectRoot, target).split(path.sep).join('/')
  if (relativePath && shouldExcludeFromBackup(`${relativePath}/`))
    return
  const stats = fs.lstatSync(target, { throwIfNoEntry: false })
  if (!stats || stats.isSymbolicLink())
    return
  if (stats.isFile()) {
    files.add(relativePath)
    return
  }
  if (!stats.isDirectory())
    return
  for (const entry of fs.readdirSync(target))
    collectFiles(path.join(target, entry), projectRoot, files)
}
