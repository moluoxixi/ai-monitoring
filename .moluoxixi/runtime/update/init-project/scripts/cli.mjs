import process from 'node:process'
import { PLATFORM_ORDER } from './hosts/catalog.mjs'

export function parseArgs(argv) {
  const result = { createNew: false, dryRun: false, force: false, packageRegistries: {}, packages: [], packageTemplates: {}, platforms: [], project: '.', python: process.env.MOLUOXIXI_PYTHON_CMD, skipAll: false, withStatusline: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = { '-f': '--force', '-n': '--create-new', '-s': '--skip-all' }[argv[index]] ?? argv[index]
    if (arg === '--force')
      result.force = true
    else if (arg === '--create-new')
      result.createNew = true
    else if (arg === '--skip-all')
      result.skipAll = true
    else if (arg === '--dry-run')
      result.dryRun = true
    else if (arg === '--with-statusline')
      result.withStatusline = true
    else if (arg === '--monorepo')
      result.monorepo = true
    else if (arg === '--no-monorepo')
      result.monorepo = false
    else if (arg === '--project')
      result.project = requireValue(argv, ++index, arg)
    else if (arg === '--package')
      result.packages.push(parsePackage(requireValue(argv, ++index, arg)))
    else if (arg === '--package-template')
      setAssignment(result.packageTemplates, requireValue(argv, ++index, arg), arg)
    else if (arg === '--package-registry')
      setAssignment(result.packageRegistries, requireValue(argv, ++index, arg), arg)
    else if (arg === '--default-package')
      result.defaultPackage = requireValue(argv, ++index, arg)
    else if (arg === '--project-type')
      result.projectType = parseProjectType(requireValue(argv, ++index, arg))
    else if (arg === '--workflow')
      result.workflow = requireValue(argv, ++index, arg)
    else if (arg === '--workflow-source' || arg === '--marketplace')
      result.workflowSource = requireValue(argv, ++index, arg)
    else if (arg === '--template')
      result.template = requireValue(argv, ++index, arg)
    else if (arg === '--registry')
      result.registry = requireValue(argv, ++index, arg)
    else if (arg === '--overwrite')
      result.overwrite = true
    else if (arg === '--append')
      result.append = true
    else if (arg === '--migrate')
      result.migrate = true
    else if (arg === '--allow-downgrade')
      result.allowDowngrade = true
    else if (arg === '--platform')
      result.platforms.push(...requireValue(argv, ++index, arg).split(','))
    else if (arg === '--python')
      result.python = requireValue(argv, ++index, arg)
    else if (arg === '--developer')
      result.developer = requireValue(argv, ++index, arg)
    else if (arg === '--help' || arg === '-h')
      result.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (result.force && result.createNew)
    throw new Error('--force and --create-new cannot be combined')
  return result
}

export function printHelp() {
  process.stdout.write(`Usage: node init-project.mjs --project <path> --platform <id[,id...]> [options]\n\nPlatforms: ${PLATFORM_ORDER.join(', ')}, all\nOptions:\n  --developer <name>       Initialize local developer identity\n  --monorepo               Require and enable detected workspace packages\n  --no-monorepo            Force single-project mode\n  --package <name=path[:type]>  Override a detected monorepo package\n  --default-package <name> Set the default package\n  --project-type <type>    Override frontend/backend/fullstack/unknown detection\n  --python <command>       Python 3.9+ command (supports values such as "py -3")\n  --with-statusline        Add the optional Claude Code status line\n  --workflow <id>          Install a workflow template\n  --workflow-source <src>  Workflow marketplace source\n  --template <id>          Install one spec template for every project scope\n  --registry <src>         Default spec registry source\n  --package-template <name=id>  Override a monorepo package template\n  --package-registry <name=src> Override a monorepo package registry\n  --overwrite              Overwrite existing registry spec directories\n  --append                 Add only missing registry spec files\n  --migrate                Apply versioned file and directory migrations\n  --allow-downgrade        Allow an older template revision intentionally\n  --create-new             Write .new sidecars for conflicting managed files\n  --skip-all               Preserve every conflict (the default non-force behavior)\n  --force                  Replace conflicting managed files\n  --dry-run                Print the plan without writing\n`)
}

function parseProjectType(value) {
  if (!['frontend', 'backend', 'fullstack', 'unknown'].includes(value))
    throw new Error('--project-type must be frontend, backend, fullstack, or unknown')
  return value
}

function parseAssignment(value, flag) {
  const separator = value.indexOf('=')
  if (separator <= 0 || separator === value.length - 1)
    throw new Error(`${flag} must use package=value`)
  return [value.slice(0, separator), value.slice(separator + 1)]
}

function setAssignment(target, value, flag) {
  const [name, assigned] = parseAssignment(value, flag)
  target[name] = assigned
}

function parsePackage(value) {
  const match = /^([^=\0\r\n]{1,128})=([^:]+)(?::(frontend|backend|fullstack|unknown))?$/u.exec(value)
  if (!match)
    throw new Error('--package must use name=relative/path[:frontend|backend|fullstack|unknown]')
  const normalizedPath = match[2].replace(/\\/gu, '/').replace(/^\.\//u, '')
  if (!normalizedPath || pathIsUnsafe(normalizedPath))
    throw new Error(`Unsafe package path: ${match[2]}`)
  return { name: match[1], path: normalizedPath, type: match[3] ?? 'unknown' }
}

function pathIsUnsafe(value) {
  return value.startsWith('/') || value === '..' || value.startsWith('../') || value.includes('/../') || value.includes('\0')
}

function requireValue(argv, index, flag) {
  const value = argv[index]
  if (!value || value.startsWith('--'))
    throw new Error(`${flag} requires a value`)
  return value
}
