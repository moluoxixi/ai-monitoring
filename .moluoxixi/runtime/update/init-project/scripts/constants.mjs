import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))

export const SKILL_ROOT = path.resolve(SCRIPT_DIR, '..')
const ROLE_ROOT_CANDIDATES = [path.resolve(SKILL_ROOT, '..'), path.resolve(SKILL_ROOT, '..', '..')]
export const ROLE_ROOT = ROLE_ROOT_CANDIDATES.find(candidate => fs.statSync(path.join(candidate, 'packages', 'cli', 'src', 'templates'), { throwIfNoEntry: false })?.isDirectory()) ?? ROLE_ROOT_CANDIDATES.at(-1)
export const ASSET_ROOT = path.join(SKILL_ROOT, 'assets')
export const RUNTIME_ROOT = path.join(ASSET_ROOT, 'runtime')
export const PACKAGE_TEMPLATE_ROOT = path.join(ROLE_ROOT, 'packages', 'cli', 'src', 'templates')
export const OVERLAY_ROOT = path.join(ROLE_ROOT, 'overlays')
export const OVERLAY_TEMPLATE_ROOT = path.join(OVERLAY_ROOT, 'packages', 'cli', 'src', 'templates')
export const OVERLAY_OVERRIDE_ROOT = path.join(OVERLAY_TEMPLATE_ROOT, 'overrides')
export const OVERLAY_ADDITION_ROOT = path.join(OVERLAY_TEMPLATE_ROOT, 'additions')

export const PROJECT_ROOT_DIR = '.moluoxixi'
export const MANIFEST_PATH = projectPath('airules-init-manifest.json')
export const GENERATOR_VERSION = '0.2.0'
export const MOLUOXIXI_VERSION = '0.2.0'
export const UPSTREAM_BRAND = ['tre', 'llis'].join('')

export const NAMESPACED_SKILL_RENAMES = {
  'moluoxixi-before-dev': 'before-dev',
  'moluoxixi-brainstorm': 'brainstorm',
  'moluoxixi-break-loop': 'break-loop',
  'moluoxixi-channel': 'channel',
  'moluoxixi-check': 'check',
  'moluoxixi-continue': 'continue',
  'moluoxixi-finish-work': 'finish-work',
  'moluoxixi-meta': 'meta',
  'moluoxixi-session-insight': 'session-insight',
  'moluoxixi-spec-bootstrap': 'spec-bootstrap',
  'moluoxixi-spec-review': 'spec-review',
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
