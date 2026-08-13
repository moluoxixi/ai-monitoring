import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

export const SKILL_ROOT = path.resolve(SCRIPT_DIR, '..')
export const ASSET_ROOT = path.join(SKILL_ROOT, 'assets')
export const HOST_ASSET_ROOT = path.join(ASSET_ROOT, 'hosts')
export const PROJECT_ASSET_ROOT = path.join(ASSET_ROOT, 'project')
export const RUNTIME_ROOT = path.join(ASSET_ROOT, 'runtime')
export const CORE_ASSET_ROOT = path.join(ASSET_ROOT, 'core')
export const CORE_SKILLS_ROOT = path.join(CORE_ASSET_ROOT, 'skills')

export const PROJECT_ROOT_DIR = '.moluoxixi'
export const MANIFEST_PATH = projectPath('airules-init-manifest.json')
export const GENERATOR_VERSION = '0.1.0'
export const MOLUOXIXI_VERSION = '0.1.0'
export const UPSTREAM_BRAND = ['tre', 'llis'].join('')

export const NAMESPACED_SKILL_RENAMES = {
  'moluoxixi-before-dev': 'before-dev',
  'moluoxixi-brainstorm': 'brainstorm',
  'moluoxixi-break-loop': 'break-loop',
  'channel': 'channel',
  'moluoxixi-continue': 'continue',
  'moluoxixi-finish-work': 'finish-work',
  'meta': 'meta',
  'session-insight': 'session-insight',
  'spec-bootstrap': 'spec-bootstrap',
  'moluoxixi-start': 'start',
  'moluoxixi-update-spec': 'update-spec',
}

export function canonicalSkillName(name) {
  return name.replace(/^moluoxixi-/u, '')
}

export function projectPath(...segments) {
  return path.posix.join(PROJECT_ROOT_DIR, ...segments)
}

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

export function toPosix(value) {
  return value.split(path.sep).join('/')
}
