import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  canonicalSkillName,
  MOLUOXIXI_VERSION,
  NAMESPACED_SKILL_RENAMES,
  OVERLAY_ROOT,
  PACKAGE_TEMPLATE_ROOT,
  projectPath,
  RUNTIME_ROOT,
  SKILL_ROOT,
  toPosix,
  UPSTREAM_BRAND,
} from './constants.mjs'
import { sanitizePackageName } from './core/project-detector.mjs'
import {
  commandTarget,
  CORE_HOOKS,
  HOOK_ROOTS,
  PLATFORM_CONTEXT,
  PLATFORM_DIRECT,
  PLATFORM_SKILLS_ROOT,
} from './hosts/catalog.mjs'
import {
  listTemplateFiles,
  readAddition,
  readTemplateFile,
  readTemplateOrAddition,
  verifyTemplateSource,
} from './templates.mjs'

export function requirePython(command) {
  const candidates = command
    ? [command]
    : process.platform === 'win32'
      ? ['python', 'python3', 'py -3']
      : ['python3', 'python']
  if (process.env.MOLUOXIXI_SKIP_PYTHON_CHECK === '1')
    return candidates[0]
  const failures = []
  for (const candidate of candidates) {
    const [executable, ...prefixArgs] = parseCommand(candidate)
    const probe = spawnSync(executable, [...prefixArgs, '--version'], { encoding: 'utf8', windowsHide: true })
    const output = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`
    const match = output.match(/Python\s+(\d+)\.(\d+)/u)
    if (!probe.error && probe.status === 0 && match) {
      const major = Number(match[1])
      const minor = Number(match[2])
      if (major > 3 || (major === 3 && minor >= 9))
        return candidate
      failures.push(`${candidate}: ${match[0]} is older than 3.9`)
      continue
    }
    if (command && ['EACCES', 'EPERM'].includes(probe.error?.code))
      return candidate
    failures.push(`${candidate}: unavailable`)
  }
  throw new Error(`Python 3.9+ is required; tried ${failures.join(', ')}`)
}

function parseCommand(value) {
  const tokens = []
  const expression = /"([^"]*)"|'([^']*)'|(\S+)/gu
  for (const match of String(value).matchAll(expression))
    tokens.push(match[1] ?? match[2] ?? match[3])
  if (tokens.length === 0 || /["']/u.test(String(value).replace(expression, '')))
    throw new Error(`Invalid Python command: ${value}`)
  return tokens
}

export function buildPlan(platforms, pythonCommand, withStatusline = false, packages = [], defaultPackage, projectType = 'fullstack', extras = {}) {
  verifyTemplateSource()
  const plan = new Map()
  const specs = Array.isArray(extras.specs)
    ? extras.specs
    : extras.spec?.files
      ? packages.length === 0
        ? [{ ...extras.spec }]
        : packages.map(pkg => ({ ...extras.spec, packageName: pkg.name }))
      : []
  const externalPackages = new Set(specs.map(spec => spec.packageName).filter(Boolean))
  const hasSingleProjectSpec = packages.length === 0 && specs.length > 0
  addProjectCore(plan, pythonCommand, packages, defaultPackage, projectType, extras.workflow, extras.configSections, { externalPackages, hasSingleProjectSpec })
  for (const spec of specs) {
    const packageName = spec.packageName ? sanitizePackageName(spec.packageName) : ''
    addExternalSpec(plan, spec.files, spec.strategy ?? 'skip', packageName, extras.projectRoot)
  }
  for (const platform of platforms)
    addPlatform(plan, platform, pythonCommand, platform === 'gemini' && platforms.includes('codex'), withStatusline)
  preserveCodexAgentModelKeys(plan, extras.projectRoot)
  return plan
}

export function extractCodexAgentModelKeys(content) {
  const result = {}
  let inMultilineString = false
  for (const rawLine of content.split(/\r?\n/u)) {
    const trimmed = rawLine.trim()
    if (inMultilineString) {
      if (trimmed.includes('"""'))
        inMultilineString = false
      continue
    }
    if (/^[A-Za-z_][\w-]*\s*=\s*"""/u.test(trimmed)) {
      if ((trimmed.match(/"""/gu) ?? []).length < 2)
        inMultilineString = true
      continue
    }
    const match = trimmed.match(/^(model|model_reasoning_effort)\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/u)
    if (match)
      result[match[1]] = match[2].replaceAll('\\"', '"').replaceAll('\\\\', '\\')
  }
  return result
}

export function applyCodexAgentModelKeys(content, preserved) {
  const lines = []
  for (const key of ['model', 'model_reasoning_effort']) {
    if (preserved[key])
      lines.push(`${key} = "${preserved[key].replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)
  }
  if (lines.length === 0)
    return content
  return content.replace(/^(sandbox_mode\s*=\s*".*"\r?\n)/mu, match => `${match}${lines.join('\n')}\n`)
}

function preserveCodexAgentModelKeys(plan, projectRoot) {
  if (!projectRoot)
    return
  for (const [target, entry] of plan) {
    if (!target.startsWith('.codex/agents/moluoxixi-') || !target.endsWith('.toml'))
      continue
    try {
      const existing = fs.readFileSync(path.join(projectRoot, target), 'utf8')
      const preserved = extractCodexAgentModelKeys(existing)
      entry.content = Buffer.from(applyCodexAgentModelKeys(entry.content.toString('utf8'), preserved))
    }
    catch {}
  }
}

function walkFiles(root) {
  const files = []
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory())
        visit(target)
      else if (entry.isFile())
        files.push(target)
      else throw new Error(`Unsupported template entry: ${target}`)
    }
  }
  visit(root)
  return files
}

function resolveTemplate(content, ctx, pythonCommand, neutral = false) {
  let result = content.replaceAll('{{PYTHON_CMD}}', pythonCommand)
  if (ctx) {
    result = result.replace(/\{\{CMD_REF:(\w[\w-]*)\}\}/gu, (_match, name) => neutral ? `\`${name}\` (Moluoxixi command)` : `${ctx.cmdRefPrefix}${name}`)
    result = result.replaceAll('{{EXECUTOR_AI}}', ctx.executorAI)
    result = result.replaceAll('{{USER_ACTION_LABEL}}', ctx.userActionLabel)
    result = result.replaceAll('{{CLI_FLAG}}', ctx.cliFlag)
    for (const flag of ['AGENT_CAPABLE', 'HAS_HOOKS']) {
      const enabled = flag === 'AGENT_CAPABLE' ? ctx.agentCapable : ctx.hasHooks
      result = result.replace(new RegExp(`\\{\\{#${flag}\\}\\}([\\s\\S]*?)\\{\\{/${flag}\\}\\}`, 'gu'), enabled ? '$1' : '')
      result = result.replace(new RegExp(`\\{\\{\\^${flag}\\}\\}([\\s\\S]*?)\\{\\{/${flag}\\}\\}`, 'gu'), enabled ? '' : '$1')
    }
    result = result.replace(/\n{3,}/gu, '\n\n')
  }
  if (pythonCommand !== 'python3')
    result = result.split('\n').map(line => line.startsWith('#!') ? line : line.replaceAll('python3', pythonCommand)).join('\n')
  return result
}

const COMMAND_DESCRIPTIONS = {
  'continue': 'Resume work on the current task at the correct phase.',
  'finish-work': 'Wrap up the current session: quality gate, commit reminder, archive, journal.',
  'spec-review': 'Review proposed project knowledge before promoting it into formal specs.',
  'start': 'Initialize a Moluoxixi development session.',
}

const SKILL_DESCRIPTIONS = {
  'before-dev': 'Discovers and injects project-specific coding guidelines from .moluoxixi/spec/ before implementation begins. Reads spec indexes, pre-development checklists, and shared thinking guides for the target package. Use before writing code or when project conventions need to be refreshed.',
  'brainstorm': 'Guides collaborative requirements discovery before implementation. Creates task artifacts, asks high-value questions, researches technical choices, and converges on an approved MVP scope.',
  'break-loop': 'Deep bug analysis to break the fix-forget-repeat cycle. Analyzes root cause, failed fixes, prevention mechanisms, and prepares reusable knowledge for human review.',
  'check': 'Comprehensive quality verification covering spec compliance, lint, type-checking, tests, cross-layer data flow, reuse, and consistency.',
  'continue': 'Resume work on the current task at the correct workflow phase and load its step-level context.',
  'finish-work': 'Wrap up the current session by verifying quality, archiving completed tasks, and recording progress.',
  'spec-review': 'Review pending project knowledge proposals before they enter .moluoxixi/spec/.',
  'start': 'Initialize a Moluoxixi development session, classify the incoming task, and route it to the appropriate workflow.',
  'update-spec': 'Capture executable contracts and coding conventions as human-reviewable proposals without bypassing knowledge approval.',
}

function wrapSkill(name, content) {
  const description = SKILL_DESCRIPTIONS[name]
  if (!description)
    throw new Error(`Missing skill description: ${name}`)
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${content}`
}

function wrapCommand(name, content) {
  const base = canonicalSkillName(name)
  const description = COMMAND_DESCRIPTIONS[base]
  if (!description)
    throw new Error(`Missing command description: ${base}`)
  return `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n\n${content}`
}

function wrapOmpCommand(name, content) {
  const base = canonicalSkillName(name)
  const description = COMMAND_DESCRIPTIONS[base]
  if (!description)
    throw new Error(`Missing OMP command description: ${base}`)
  const hint = base === 'finish-work' ? `\nargument-hint: ${JSON.stringify('[task-name]')}` : ''
  return `---\ndescription: ${JSON.stringify(description)}${hint}\n---\n\n${content.replace(/^# [^\n]+\n\n/u, '')}`
}

function addPlan(plan, relativePath, content, options = {}) {
  const normalized = path.posix.normalize(relativePath.replace(/\\/gu, '/'))
  if (!normalized || normalized === '.' || path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../') || normalized.includes('\0'))
    throw new Error(`Unsafe output path: ${relativePath}`)
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
  const existing = plan.get(normalized)
  if (existing && !existing.content.equals(buffer)) {
    if (!options.override)
      throw new Error(`Conflicting templates target ${normalized}`)
  }
  plan.set(normalized, {
    content: buffer,
    configSections: options.configSections,
    executable: options.executable === true,
    force: options.force === true,
    managed: options.managed !== false,
    merge: options.merge ?? 'replace',
    platform: options.platform ?? 'core',
    preserveExisting: options.preserveExisting === true,
    override: options.override === true,
    skipExisting: options.skipExisting === true,
  })
}

function addTree(plan, sourceRoot, targetRoot, options = {}) {
  if (!fs.existsSync(sourceRoot))
    return
  for (const source of walkFiles(sourceRoot)) {
    let relative = toPosix(path.relative(sourceRoot, source))
    if (options.filter && !options.filter(relative))
      continue
    if (options.rename)
      relative = options.rename(relative)
    const target = path.posix.join(targetRoot, relative)
    const merge = options.merge ?? (/(^|\/)(settings|hooks)\.json$/u.test(target) || target.endsWith('/package.json') ? 'json' : target.endsWith('/config.toml') ? 'block-hash' : 'replace')
    const sourceContent = fs.readFileSync(source, 'utf8')
    const transformed = options.transform ? options.transform(relative, sourceContent) : sourceContent
    const resolved = options.context || options.python ? resolveTemplate(transformed, options.context, options.python) : transformed
    addPlan(plan, target, resolved, {
      executable: target.endsWith('.py') || target.endsWith('.mjs'),
      force: options.force,
      managed: options.managed,
      merge,
      platform: options.platform,
      preserveExisting: options.preserveExisting,
      skipExisting: options.skipExisting,
    })
  }
}

function addTemplateTree(plan, sourceRoot, targetRoot, options = {}) {
  for (const sourcePath of listTemplateFiles(sourceRoot, { additions: options.additions })) {
    let relative = path.posix.relative(sourceRoot, sourcePath)
    if (options.filter && !options.filter(relative))
      continue
    if (options.rename)
      relative = options.rename(relative)
    const target = path.posix.join(targetRoot, relative)
    const merge = options.merge ?? (/(^|\/)(settings|hooks)\.json$/u.test(target) || target.endsWith('/package.json') ? 'json' : target.endsWith('/config.toml') ? 'block-hash' : 'replace')
    const sourceContent = readTemplateOrAddition(sourcePath)
    const transformed = options.transform ? options.transform(path.posix.relative(sourceRoot, sourcePath), sourceContent) : sourceContent
    const resolved = options.context || options.python ? resolveTemplate(transformed, options.context, options.python, options.neutral) : transformed
    addPlan(plan, target, resolved, {
      executable: target.endsWith('.py') || target.endsWith('.mjs'),
      force: options.force,
      managed: options.managed,
      merge,
      platform: options.platform,
      preserveExisting: options.preserveExisting,
      skipExisting: options.skipExisting,
    })
  }
}

function localizeTemplatePath(relativePath) {
  return relativePath.replaceAll(UPSTREAM_BRAND, 'moluoxixi')
}

export function localizeProjectRuntime(relativePath, content) {
  let localized = content
    .replaceAll(`${UPSTREAM_BRAND[0].toUpperCase()}${UPSTREAM_BRAND.slice(1)}`, 'Moluoxixi')
    .replaceAll(UPSTREAM_BRAND.toUpperCase(), 'MOLUOXIXI')
    .replaceAll(UPSTREAM_BRAND, 'moluoxixi')
    .replaceAll('"run moluoxixi update"', '"run the current init-project skill"')
    .replaceAll('moluoxixi channel', `node ${projectPath('runtime', 'moluoxixi.mjs')} channel`)
    .replaceAll('moluoxixi mem', `node ${projectPath('runtime', 'moluoxixi.mjs')} mem`)
    .replaceAll('moluoxixi workflow', `node ${projectPath('runtime', 'moluoxixi.mjs')} workflow`)
    .replaceAll('moluoxixi update', `node ${projectPath('runtime', 'moluoxixi.mjs')} update`)
  for (const [namespacedName, canonicalName] of Object.entries(NAMESPACED_SKILL_RENAMES))
    localized = localized.replaceAll(namespacedName, canonicalName)
  localized = localized
    .replaceAll('| Done coding / quality check | `moluoxixi-check` |', '| Done coding / quality check | `check` |')
    .replaceAll('Load the `moluoxixi-check` skill', 'Load the `check` skill')
    .replaceAll('load the `moluoxixi-check` skill', 'load the `check` skill')
    .replaceAll('skills, such as `brainstorm` and `moluoxixi-check`', 'skills, such as `brainstorm` and `check`')
    .replaceAll('`before-dev` -> edit -> `moluoxixi-check` -> validation', '`before-dev` -> edit -> `check` -> validation')
    .replaceAll('- Before editing -> `before-dev`; after editing -> `moluoxixi-check`.', '- Before editing -> `before-dev`; after editing -> `check`.')
    .replaceAll('`moluoxixi-check` exists as both; prefer the Agent form when verifying after code changes.', '`moluoxixi-check` is the verification Agent; use `check` when the workflow calls for the inline skill.')
  const segments = relativePath.split('/')
  const skillsIndex = segments.indexOf('skills')
  if (relativePath.endsWith('/SKILL.md') && skillsIndex >= 0 && segments[skillsIndex + 1]) {
    const lines = localized.split('\n')
    const nameLine = lines.findIndex(line => line.startsWith('name:'))
    if (nameLine >= 0) {
      lines[nameLine] = `name: ${segments[skillsIndex + 1]}`
      localized = lines.join('\n')
    }
  }
  return localized
}

function transformHostAsset(platform, relativePath, content, pythonCommand, withStatusline = false) {
  let transformed = localizeProjectRuntime(relativePath, content)
  if (platform === 'claude' && relativePath === 'settings.json' && withStatusline) {
    const settings = JSON.parse(transformed)
    settings.statusLine = {
      type: 'command',
      command: '{{PYTHON_CMD}} .claude/hooks/statusline.py',
    }
    transformed = `${JSON.stringify(settings, null, 2)}\n`
  }
  const agentType = detectPullAgentType(relativePath)
  if (!agentType)
    return transformed
  const knowledgeBoundary = `## Formal Knowledge Boundary

You may self-fix production code within the assigned scope. Do not edit \`.moluoxixi/spec/\`, approve or apply knowledge proposals, or commit changes. Return reusable findings to the main session so it can create an \`update-spec\` proposal for human review.

---

`
  if (!['codex', 'gemini', 'qoder', 'copilot', 'grok', 'kimi', 'pi', 'reasonix', 'zcode', 'trae'].includes(platform)) {
    return platform === 'kiro'
      ? injectJsonAgentPrelude(transformed, knowledgeBoundary)
      : injectPullBasedPreludeMarkdown(transformed, knowledgeBoundary)
  }
  if (platform === 'codex')
    return injectPullBasedPreludeToml(transformed, knowledgeBoundary)
  if (platform === 'copilot')
    transformed = normalizeCopilotAgentFrontmatter(transformed)
  const prelude = `${knowledgeBoundary}${buildPullBasedPrelude(agentType, pythonCommand)}`
  return injectPullBasedPreludeMarkdown(transformed, prelude)
}

function buildPullBasedPrelude(agentType, pythonCommand) {
  const jsonl = agentType === 'check' ? 'check.jsonl' : 'implement.jsonl'
  return `## Required: Load Moluoxixi Context First

This host does not auto-inject task context into sub-agents. Before doing anything else, load it yourself.

1. Resolve the active task path. Prefer the first dispatch line \`Active task: <path>\`. Otherwise run \`${pythonCommand} ./.moluoxixi/scripts/task.py current --source\`. If neither yields a task, ask the user; do not guess.
2. Run \`${pythonCommand} ./.moluoxixi/scripts/task.py validate <task-path>\`. Stop and report the invalid manifest if validation fails.
3. Read \`<task-path>/${jsonl}\`. Read only validated entries under \`.moluoxixi/spec/\` or \`<task-path>/research/\`; never load \`.moluoxixi/spec-proposals/\` as active guidance. Ignore seed rows without \`file\`.
4. Read \`<task-path>/prd.md\`, then \`design.md\` and \`implement.md\` when present.
5. If ${jsonl} has no curated files, read the task artifacts, run \`${pythonCommand} ./.moluoxixi/scripts/get_context.py --mode packages\`, and select relevant formal specs yourself. Do not block merely because a lightweight task has no curated JSONL rows.

Do not proceed without a task PRD or equivalent user-confirmed requirements.

---

`
}

function detectPullAgentType(relativePath) {
  const name = path.basename(relativePath).replace(/(?:\.agent)?\.(?:md|toml|json)$/u, '').replace(/^(?:moluoxixi|trellis)-/u, '')
  if (['implement', 'frontend', 'backend', 'database'].includes(name))
    return 'implement'
  if (['check', 'test', 'security'].includes(name))
    return 'check'
  return undefined
}

function injectJsonAgentPrelude(content, prelude) {
  const agent = JSON.parse(content)
  agent.prompt = `${prelude}${agent.prompt ?? ''}`
  return `${JSON.stringify(agent, null, 2)}\n`
}

function injectPullBasedPreludeMarkdown(content, prelude) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u)
  if (!match)
    return prelude + content
  return `---\n${match[1]}\n---\n\n${prelude}${content.slice(match[0].length).replace(/^(?:\r?\n)+/u, '')}`
}

function injectPullBasedPreludeToml(content, prelude) {
  return content.replace(/(developer_instructions\s*=\s*""")(\r?\n)/u, `$1$2${prelude}`)
}

function normalizeCopilotAgentFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u)
  if (!match)
    return content
  const normalized = []
  for (const line of match[1].split(/\r?\n/u)) {
    if (!line.startsWith('tools:')) {
      normalized.push(line)
      continue
    }
    const legacy = line.slice('tools:'.length).split(',').map(tool => tool.trim()).filter(Boolean)
    const tools = [...new Set(legacy.flatMap(mapCopilotTool))]
    normalized.push('tools:', ...tools.map(tool => `  - ${tool}`))
  }
  return `---\n${normalized.join('\n')}\n---\n${content.slice(match[0].length)}`
}

function mapCopilotTool(tool) {
  return {
    'Read': ['read'],
    'Write': ['edit'],
    'Edit': ['edit'],
    'Glob': ['search'],
    'Grep': ['search'],
    'Bash': ['execute'],
    'mcp__*': ['web', 'exa/*', 'chrome-devtools/*'],
    'mcp__exa__web_search_exa': ['web', 'exa/*'],
    'mcp__exa__get_code_context_exa': ['web', 'exa/*'],
    'mcp__chrome-devtools__*': ['chrome-devtools/*'],
    'Skill': [],
  }[tool] ?? []
}

function addProjectCore(plan, pythonCommand, packages, defaultPackage, projectType, workflow, configSections, specSelection) {
  addTemplateTree(plan, 'trellis/scripts', projectPath('scripts'), {
    python: pythonCommand,
    rename: localizeTemplatePath,
    transform: localizeProjectRuntime,
  })
  addTemplateTree(plan, 'project/scripts', projectPath('scripts'), {
    additions: true,
    python: pythonCommand,
    transform: localizeProjectRuntime,
  })
  addTemplateTree(plan, 'trellis/agents', projectPath('agents'), {
    python: pythonCommand,
    rename: localizeTemplatePath,
    transform: localizeProjectRuntime,
  })
  addTree(plan, RUNTIME_ROOT, projectPath('runtime'), { merge: 'replace' })
  addTree(plan, SKILL_ROOT, projectPath('runtime', 'update', 'init-project'), { merge: 'replace' })
  addTree(plan, PACKAGE_TEMPLATE_ROOT, projectPath('runtime', 'update', 'packages', 'cli', 'src', 'templates'), { merge: 'replace' })
  addTree(plan, OVERLAY_ROOT, projectPath('runtime', 'update', 'overlays'), { merge: 'replace' })
  const workflowContent = workflow?.content ?? readTemplateFile('trellis/workflow.md')
  addPlan(plan, projectPath('workflow.md'), resolveTemplate(localizeProjectRuntime('workflow.md', workflowContent), undefined, pythonCommand), {
    managed: workflow?.id === undefined || workflow.id === 'native',
    force: workflow?.force === true,
  })
  addPlan(plan, projectPath('config.yaml'), buildProjectConfig(packages, defaultPackage), { configSections, merge: 'config' })
  addPlan(plan, projectPath('.version'), `${MOLUOXIXI_VERSION}\n`)
  addPlan(plan, projectPath('.gitignore'), localizeProjectRuntime('gitignore.txt', readTemplateFile('trellis/gitignore.txt')))
  addPlan(plan, '.gitattributes', localizeProjectRuntime('gitattributes.txt', readTemplateFile('trellis/gitattributes.txt')), { merge: 'block-hash' })
  addPlan(plan, projectPath('workspace', 'index.md'), resolveTemplate(localizeProjectRuntime('workspace-index.md', readTemplateFile('markdown/workspace-index.md')), undefined, pythonCommand), { managed: false, preserveExisting: true })
  addPlan(plan, projectPath('tasks', '.gitkeep'), '', { managed: false, preserveExisting: true })
  if (!specSelection.hasSingleProjectSpec)
    addTemplateTree(plan, 'markdown/spec/guides', projectPath('spec', 'guides'), { managed: false, preserveExisting: true, rename: relative => relative.replace(/\.txt$/u, ''), transform: localizeProjectRuntime })
  if (packages.length === 0 && !specSelection.hasSingleProjectSpec) {
    const sections = projectType === 'frontend' ? ['frontend'] : projectType === 'backend' ? ['backend'] : ['backend', 'frontend']
    for (const section of sections) {
      addTemplateTree(plan, `markdown/spec/${section}`, projectPath('spec', section), {
        rename: relative => relative.replace(/\.txt$/u, ''),
        managed: false,
        preserveExisting: true,
        transform: localizeProjectRuntime,
      })
    }
  }
  for (const pkg of packages) {
    if (specSelection.externalPackages.has(pkg.name))
      continue
    const sections = pkg.type === 'frontend' ? ['frontend'] : pkg.type === 'backend' ? ['backend'] : ['backend', 'frontend']
    for (const section of sections) {
      addTemplateTree(plan, `markdown/spec/${section}`, projectPath('spec', sanitizePackageName(pkg.name), section), {
        rename: relative => relative.replace(/\.txt$/u, ''),
        managed: false,
        preserveExisting: true,
        transform: localizeProjectRuntime,
      })
    }
  }
  addPlan(plan, 'AGENTS.md', localizeProjectRuntime('agents.md', readTemplateFile('markdown/agents.md')), { merge: 'block-moluoxixi' })
  addPlan(plan, 'README.md', readAddition('project/readme-usage.md'), { merge: 'block-html' })
}

function addExternalSpec(plan, files, strategy, packageName, projectRoot) {
  const targetRoot = projectPath('spec', ...(packageName ? [packageName] : []))
  plan.externalSpecRoots ??= new Set()
  plan.externalSpecRoots.add(targetRoot)
  if (strategy === 'skip' && projectRoot && fs.existsSync(path.join(projectRoot, ...targetRoot.split('/'))))
    return
  if (strategy === 'overwrite') {
    plan.specReplacements ??= new Set()
    plan.specReplacements.add(targetRoot)
  }
  for (const [relativePath, content] of files) {
    const normalized = relativePath.replace(/\\/gu, '/').replace(new RegExp(`^\\.?(?:moluoxixi|${UPSTREAM_BRAND})/spec/`, 'u'), '').replace(/^spec\//u, '')
    if (!normalized || normalized.startsWith('../') || normalized.includes('\0'))
      throw new Error(`Unsafe registry spec path: ${relativePath}`)
    const source = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')
    const decoded = source.toString('utf8')
    const projected = Buffer.from(decoded, 'utf8').equals(source) ? localizeProjectRuntime(normalized, decoded) : source
    addPlan(plan, path.posix.join(targetRoot, normalized), projected, {
      managed: false,
      force: strategy === 'overwrite',
      preserveExisting: strategy === 'append',
      override: true,
    })
  }
}

function buildProjectConfig(packages, defaultPackage) {
  let content = localizeProjectRuntime('config.yaml', readTemplateFile('trellis/config.yaml'))
  if (packages.length === 0)
    return content
  content = `${content.replace(/\s*$/u, '')}\n\n# Reviewed package map generated by AIRules init-project.\npackages:\n`
  for (const pkg of packages) {
    content += `  ${JSON.stringify(sanitizePackageName(pkg.name))}:\n    path: ${JSON.stringify(pkg.path)}\n`
    if (pkg.isSubmodule)
      content += '    type: submodule\n'
    else if (pkg.isGitRepo)
      content += '    git: true\n'
  }
  if (defaultPackage)
    content += `default_package: ${JSON.stringify(defaultPackage)}\n`
  return content
}

function commonTemplates(kind) {
  const root = `common/${kind}`
  return listTemplateFiles(root, { additions: true })
    .filter(sourcePath => path.posix.dirname(path.posix.relative(root, sourcePath)) === '.' && sourcePath.endsWith('.md'))
    .map(sourcePath => ({
      content: readTemplateOrAddition(sourcePath),
      name: path.posix.basename(sourcePath, '.md'),
      sourcePath,
    }))
}

function commonCommands(platform, pythonCommand, options = {}) {
  const ctx = PLATFORM_CONTEXT[platform]
  const templates = !options.forceStart && ctx.agentCapable && ctx.hasHooks
    ? commonTemplates('commands').filter(command => command.name !== 'start')
    : commonTemplates('commands')
  return templates.map(command => ({
    ...command,
    content: resolveTemplate(localizeProjectRuntime(command.sourcePath, command.content), ctx, pythonCommand, options.neutral),
  }))
}

function canonicalTemplateSkillName(name) {
  return canonicalSkillName(localizeTemplatePath(name))
}

function bundledSkillNames() {
  return new Set(listTemplateFiles('common/bundled-skills', { additions: true })
    .map(sourcePath => path.posix.relative('common/bundled-skills', sourcePath).split('/')[0])
    .filter(Boolean)
    .map(canonicalTemplateSkillName))
}

function addCommonSkills(plan, platform, root, pythonCommand, options = {}) {
  const ctx = PLATFORM_CONTEXT[platform]
  const bundledNames = bundledSkillNames()
  const templates = [...commonTemplates('skills')]
  if (options.commands) {
    templates.push(...commonCommands(platform, pythonCommand, { neutral: options.neutral })
      .filter(command => !bundledNames.has(canonicalTemplateSkillName(command.name))))
  }
  for (const template of templates) {
    const skillName = canonicalTemplateSkillName(template.name)
    if (options.excludeNames?.has(skillName))
      continue
    const content = template.sourcePath.startsWith('common/commands/')
      ? template.content
      : resolveTemplate(localizeProjectRuntime(template.sourcePath, template.content), ctx, pythonCommand, options.neutral)
    addPlan(plan, path.posix.join(root, skillName, 'SKILL.md'), wrapSkill(skillName, content), { platform })
  }

  for (const sourcePath of listTemplateFiles('common/bundled-skills', { additions: true })) {
    const relative = path.posix.relative('common/bundled-skills', sourcePath)
    const [sourceSkillName, ...segments] = relative.split('/')
    if (!sourceSkillName || segments.length === 0)
      continue
    const skillName = canonicalTemplateSkillName(sourceSkillName)
    const target = path.posix.join(root, skillName, localizeTemplatePath(segments.join('/')))
    const content = resolveTemplate(localizeProjectRuntime(sourcePath, readTemplateOrAddition(sourcePath)), ctx, pythonCommand, options.neutral)
    addPlan(plan, target, content, { executable: target.endsWith('.py') || target.endsWith('.mjs'), platform })
  }
}

function addDirectPlatformAssets(plan, platform, pythonCommand, withStatusline) {
  if (platform === 'copilot') {
    addPlan(plan, '.github/copilot-instructions.md', localizeProjectRuntime('copilot-instructions.md', resolveTemplate(readTemplateFile('copilot/copilot-instructions.md'), PLATFORM_CONTEXT.copilot, pythonCommand)), { merge: 'block-hash', platform })
    addTemplateTree(plan, 'copilot/hooks', '.github/copilot/hooks', { python: pythonCommand, context: PLATFORM_CONTEXT.copilot, platform, transform: localizeProjectRuntime })
    const hookConfig = localizeProjectRuntime('hooks.json', resolveTemplate(readTemplateFile('copilot/hooks.json'), PLATFORM_CONTEXT.copilot, pythonCommand))
    addPlan(plan, '.github/copilot/hooks.json', hookConfig, { merge: 'json', platform })
    addPlan(plan, '.github/hooks/moluoxixi.json', hookConfig, { merge: 'json', platform })
    addTemplateTree(plan, 'cursor/agents', '.github/agents', { python: pythonCommand, context: PLATFORM_CONTEXT.copilot, platform, rename: relative => localizeTemplatePath(relative).replace(/\.md$/u, '.agent.md'), transform: (relativePath, content) => transformHostAsset('copilot', relativePath, content, pythonCommand) })
    return
  }
  if (platform === 'reasonix') {
    for (const sourcePath of listTemplateFiles('reasonix/agents')) {
      const relative = path.posix.relative('reasonix/agents', sourcePath)
      const name = canonicalTemplateSkillName(path.posix.basename(relative, '.md'))
      const sourceContent = resolveTemplate(readTemplateFile(sourcePath), PLATFORM_CONTEXT.reasonix, pythonCommand)
      const content = transformHostAsset('reasonix', relative, sourceContent, pythonCommand)
      addPlan(plan, `.reasonix/skills/${name}/SKILL.md`, content, { platform })
    }
    return
  }
  const direct = PLATFORM_DIRECT[platform]
  if (!direct)
    return
  addTemplateTree(plan, direct[0], direct[1], {
    python: pythonCommand,
    context: PLATFORM_CONTEXT[platform],
    platform,
    transform: (relativePath, content) => transformHostAsset(platform, relativePath, content, pythonCommand, withStatusline),
    filter: relative => relative !== 'index.ts' && (platform !== 'claude' || relative !== 'hooks/statusline.py' || withStatusline),
    rename: relative => localizeTemplatePath(relative.endsWith('.ts.txt') ? relative.slice(0, -4) : relative),
  })
}

function addBoundaryCommandSkills(plan, platform, root, pythonCommand) {
  for (const command of commonCommands(platform, pythonCommand).filter(entry => ['start', 'continue', 'finish-work'].includes(entry.name)))
    addPlan(plan, path.posix.join(root, command.name, 'SKILL.md'), wrapSkill(command.name, command.content), { platform })
}

function addKimiAgentSkills(plan, pythonCommand) {
  for (const sourcePath of listTemplateFiles('kimi/agents')) {
    const relative = path.posix.relative('kimi/agents', sourcePath)
    const name = canonicalTemplateSkillName(path.posix.basename(relative, '.md'))
    const sourceContent = resolveTemplate(readTemplateFile(sourcePath), PLATFORM_CONTEXT.kimi, pythonCommand)
    const content = transformHostAsset('kimi', relative, sourceContent, pythonCommand)
    addPlan(plan, `.kimi-code/skills/${name}/SKILL.md`, content, { platform: 'kimi' })
  }
}

function addSnowCommands(plan, pythonCommand) {
  for (const command of commonCommands('snow', pythonCommand)) {
    const description = command.name === 'continue'
      ? 'Resume the current Moluoxixi task at the right workflow phase.'
      : command.name === 'finish-work'
        ? 'Wrap up the current Moluoxixi session: archive tasks and record journal.'
        : `Moluoxixi: ${command.name}`
    const content = `${JSON.stringify({ type: 'prompt', description, command: command.content, location: 'project' }, null, 2)}\n`
    addPlan(plan, `.snow/commands/moluoxixi-${command.name}.json`, content, { platform: 'snow' })
  }
}

function addPlatform(plan, platform, pythonCommand, skipSharedSkills = false, withStatusline = false) {
  addDirectPlatformAssets(plan, platform, pythonCommand, withStatusline)
  const ctx = PLATFORM_CONTEXT[platform]
  if (platform === 'dsh') {
    addCommonSkills(plan, platform, '.agents/skills', pythonCommand, { neutral: true })
    addBoundaryCommandSkills(plan, platform, '.dsh/skills', pythonCommand)
    return
  }
  if (platform === 'kimi') {
    addCommonSkills(plan, platform, '.agents/skills', pythonCommand, { neutral: true })
    addBoundaryCommandSkills(plan, platform, '.kimi-code/skills', pythonCommand)
    addKimiAgentSkills(plan, pythonCommand)
    return
  }
  if (platform === 'snow') {
    addCommonSkills(plan, platform, '.snow/skills', pythonCommand, { commands: true })
    addSnowCommands(plan, pythonCommand)
    return
  }
  if (platform === 'codex' || platform === 'kiro' || platform === 'reasonix') {
    const root = platform === 'codex' ? '.agents/skills' : platform === 'kiro' ? '.kiro/skills' : '.reasonix/skills'
    addCommonSkills(plan, platform, root, pythonCommand, {
      commands: true,
      excludeNames: platform === 'reasonix' ? new Set(['check', 'implement']) : undefined,
      neutral: platform === 'codex',
    })
  }
  else {
    const skillsRoot = PLATFORM_SKILLS_ROOT[platform]
    if (skillsRoot && !skipSharedSkills)
      addCommonSkills(plan, platform, skillsRoot, pythonCommand, { neutral: platform === 'gemini' || platform === 'pi' })
    for (const command of commonCommands(platform, pythonCommand, { forceStart: platform === 'pi' })) {
      const target = commandTarget(platform, command.name)
      if (!target)
        continue
      let content = command.content
      if (platform === 'gemini')
        content = `description = "Moluoxixi: ${command.name}"\n\nprompt = """\n${content}\n"""\n`
      else if (platform === 'qoder' || platform === 'trae')
        content = wrapCommand(`moluoxixi-${command.name}`, content)
      else if (platform === 'omp')
        content = wrapOmpCommand(command.name, content)
      addPlan(plan, target, content, { platform })
    }
  }
  const hookNames = CORE_HOOKS[platform] ?? []
  for (const hookName of hookNames) {
    const hook = readTemplateFile(`shared-hooks/${hookName}`)
    addPlan(plan, `${HOOK_ROOTS[platform]}/${hookName}`, localizeProjectRuntime(hookName, resolveTemplate(hook, ctx, pythonCommand)), { executable: true, platform })
  }
}
