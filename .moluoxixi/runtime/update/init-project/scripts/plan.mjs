import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  canonicalSkillName,
  CORE_ASSET_ROOT,
  CORE_SKILLS_ROOT,
  HOST_ASSET_ROOT,
  MOLUOXIXI_VERSION,
  NAMESPACED_SKILL_RENAMES,
  PROJECT_ASSET_ROOT,
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
  return plan
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

function wrapCommand(name, content) {
  const description = {
    'start': 'Initialize a Moluoxixi development session.',
    'continue': 'Resume work on the current task at the correct phase.',
    'finish-work': 'Wrap up the current session: quality gate, commit reminder, archive, journal.',
  }[name.replace(/^moluoxixi-/u, '')]
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${content}`
}

function wrapOmpCommand(name, content) {
  const base = name.replace(/^moluoxixi-/u, '')
  const description = {
    'start': 'Initialize a Moluoxixi development session.',
    'continue': 'Resume work on the current task at the correct phase.',
    'finish-work': 'Wrap up the current session: quality gate, commit reminder, archive, journal.',
  }[base]
  const hint = base === 'finish-work' ? '\nargument-hint: [task-name]' : ''
  return `---\ndescription: ${description}${hint}\n---\n\n${content.replace(/^# [^\n]+\n\n/u, '')}`
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

function localizeProjectRuntime(relativePath, content) {
  let localized = content
    .replaceAll('moluoxixi channel', `node ${projectPath('runtime', 'moluoxixi.mjs')} channel`)
    .replaceAll('moluoxixi mem', `node ${projectPath('runtime', 'moluoxixi.mjs')} mem`)
    .replaceAll('moluoxixi workflow', `node ${projectPath('runtime', 'moluoxixi.mjs')} workflow`)
    .replaceAll('moluoxixi update', `node ${projectPath('runtime', 'moluoxixi.mjs')} update`)
    .replaceAll('.moluoxixi', '.moluoxixi')
    .replaceAll(UPSTREAM_BRAND, 'moluoxixi')
    .replaceAll(`${UPSTREAM_BRAND[0].toUpperCase()}${UPSTREAM_BRAND.slice(1)}`, 'Moluoxixi')
    .replaceAll(UPSTREAM_BRAND.toUpperCase(), 'MOLUOXIXI')
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
  if (relativePath === 'common/session_context.py') {
    localized = localized.replace(
      /def _fetch_moluoxixi_version_output\(\) -> str \| None:\n[\s\S]*?\n\ndef _extract_available_update_version/u,
      'def _fetch_moluoxixi_version_output() -> str | None:\n    # AIRules updates are driven by the project-local runtime, never a global CLI.\n    return None\n\n\ndef _extract_available_update_version',
    )
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
  if (!['codex', 'gemini', 'qoder', 'copilot', 'pi', 'reasonix', 'zcode', 'trae'].includes(platform)) {
    return platform === 'kiro'
      ? injectJsonAgentPrelude(transformed, knowledgeBoundary)
      : injectPullBasedPreludeMarkdown(transformed, knowledgeBoundary)
  }
  if (platform === 'copilot')
    transformed = normalizeCopilotAgentFrontmatter(transformed)
  const prelude = `${knowledgeBoundary}${buildPullBasedPrelude(agentType, pythonCommand)}`
  return platform === 'codex'
    ? injectPullBasedPreludeToml(transformed, prelude)
    : injectPullBasedPreludeMarkdown(transformed, prelude)
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
  const name = path.basename(relativePath).replace(/(?:\.agent)?\.(?:md|toml|json)$/u, '')
  if (['moluoxixi-implement', 'moluoxixi-frontend', 'moluoxixi-backend', 'moluoxixi-database'].includes(name))
    return 'implement'
  if (['moluoxixi-check', 'moluoxixi-test', 'moluoxixi-security'].includes(name))
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
  addTree(plan, path.join(PROJECT_ASSET_ROOT, 'scripts'), projectPath('scripts'), { python: pythonCommand, transform: localizeProjectRuntime })
  addTree(plan, path.join(PROJECT_ASSET_ROOT, 'agents'), projectPath('agents'), { python: pythonCommand, transform: localizeProjectRuntime })
  addTree(plan, RUNTIME_ROOT, projectPath('runtime'), { merge: 'replace' })
  addTree(plan, SKILL_ROOT, projectPath('runtime', 'update', 'init-project'), { merge: 'replace' })
  const workflowContent = workflow?.content ?? readProjectText('workflow.md')
  addPlan(plan, projectPath('workflow.md'), resolveTemplate(localizeProjectRuntime('workflow.md', workflowContent), undefined, pythonCommand), {
    managed: workflow?.id === undefined || workflow.id === 'native',
    force: workflow?.force === true,
  })
  addPlan(plan, projectPath('config.yaml'), buildProjectConfig(packages, defaultPackage), { configSections, merge: 'config' })
  addPlan(plan, projectPath('.version'), `${MOLUOXIXI_VERSION}\n`)
  addPlan(plan, projectPath('.gitignore'), readProjectText('gitignore.txt'))
  addPlan(plan, projectPath('workspace', 'index.md'), resolveTemplate(localizeProjectRuntime('workspace-index.md', readProjectText('workspace-index.md')), undefined, pythonCommand), { managed: false, preserveExisting: true })
  addPlan(plan, projectPath('tasks', '.gitkeep'), '', { managed: false, preserveExisting: true })
  if (!specSelection.hasSingleProjectSpec)
    addTree(plan, path.join(PROJECT_ASSET_ROOT, 'spec', 'guides'), projectPath('spec', 'guides'), { managed: false, preserveExisting: true, rename: relative => relative.replace(/\.txt$/u, ''), transform: localizeProjectRuntime })
  if (packages.length === 0 && !specSelection.hasSingleProjectSpec) {
    const sections = projectType === 'frontend' ? ['frontend'] : projectType === 'backend' ? ['backend'] : ['backend', 'frontend']
    for (const section of sections) {
      addTree(plan, path.join(PROJECT_ASSET_ROOT, 'spec', section), projectPath('spec', section), {
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
      addTree(plan, path.join(PROJECT_ASSET_ROOT, 'spec', section), projectPath('spec', sanitizePackageName(pkg.name), section), {
        rename: relative => relative.replace(/\.txt$/u, ''),
        managed: false,
        preserveExisting: true,
        transform: localizeProjectRuntime,
      })
    }
  }
  addPlan(plan, 'AGENTS.md', fs.readFileSync(path.join(PROJECT_ASSET_ROOT, 'AGENTS.md')), { merge: 'block-moluoxixi' })
  addPlan(plan, 'README.md', readProjectText('readme-usage.md'), { merge: 'block-html' })
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
  let content = localizeProjectRuntime('config.yaml', readProjectText('config.yaml'))
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

function coreTemplates(platform, pythonCommand) {
  const ctx = PLATFORM_CONTEXT[platform]
  const commands = walkFiles(path.join(CORE_ASSET_ROOT, 'commands')).map(file => ({ name: path.basename(file, '.md'), content: localizeProjectRuntime(path.basename(file), resolveTemplate(fs.readFileSync(file, 'utf8'), ctx, pythonCommand)) }))
  return ctx.agentCapable && ctx.hasHooks && platform !== 'pi' ? commands.filter(command => command.name !== 'start') : commands
}

function addCoreSkills(plan, platform, root, pythonCommand) {
  for (const entry of fs.readdirSync(CORE_SKILLS_ROOT, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    const skillName = canonicalSkillName(entry.name)
    addTree(plan, path.join(CORE_SKILLS_ROOT, entry.name), path.posix.join(root, skillName), {
      context: PLATFORM_CONTEXT[platform],
      platform,
      python: pythonCommand,
      transform: (relativePath, content) => localizeProjectRuntime(`skills/${skillName}/${relativePath}`, content),
    })
  }
}

function addDirectPlatformAssets(plan, platform, pythonCommand, withStatusline) {
  if (platform === 'copilot') {
    const root = path.join(HOST_ASSET_ROOT, 'copilot')
    addPlan(plan, '.github/copilot-instructions.md', localizeProjectRuntime('copilot-instructions.md', resolveTemplate(fs.readFileSync(path.join(root, 'copilot-instructions.md'), 'utf8'), PLATFORM_CONTEXT.copilot, pythonCommand)), { merge: 'block-hash', platform })
    addTree(plan, path.join(root, 'hooks'), '.github/copilot/hooks', { python: pythonCommand, context: PLATFORM_CONTEXT.copilot, platform, transform: localizeProjectRuntime })
    const hookConfig = localizeProjectRuntime('hooks.json', resolveTemplate(fs.readFileSync(path.join(root, 'hooks.json'), 'utf8'), PLATFORM_CONTEXT.copilot, pythonCommand))
    addPlan(plan, '.github/copilot/hooks.json', hookConfig, { merge: 'json', platform })
    addPlan(plan, '.github/hooks/moluoxixi.json', hookConfig, { merge: 'json', platform })
    addTree(plan, path.join(root, 'agents'), '.github/agents', { python: pythonCommand, context: PLATFORM_CONTEXT.copilot, platform, rename: relative => relative.replace(/\.md$/u, '.agent.md'), transform: (relativePath, content) => transformHostAsset('copilot', relativePath, content, pythonCommand) })
    return
  }
  if (platform === 'reasonix') {
    const agents = path.join(HOST_ASSET_ROOT, 'reasonix', 'agents')
    for (const source of walkFiles(agents)) {
      const name = path.basename(source, '.md')
      const sourceContent = resolveTemplate(fs.readFileSync(source, 'utf8'), PLATFORM_CONTEXT.reasonix, pythonCommand)
      const content = transformHostAsset('reasonix', `agents/${name}.md`, sourceContent, pythonCommand)
      addPlan(plan, `.reasonix/skills/${name}/SKILL.md`, content, { platform })
    }
    return
  }
  const direct = PLATFORM_DIRECT[platform]
  if (!direct)
    return
  addTree(plan, path.join(HOST_ASSET_ROOT, direct[0]), direct[1], {
    python: pythonCommand,
    context: PLATFORM_CONTEXT[platform],
    platform,
    transform: (relativePath, content) => transformHostAsset(platform, relativePath, content, pythonCommand, withStatusline),
    filter: relative => platform !== 'claude' || relative !== 'hooks/statusline.py' || withStatusline,
    rename: relative => renameProjectedSkillPath(relative.endsWith('.ts.txt') ? relative.slice(0, -4) : relative),
  })
}

function addPlatform(plan, platform, pythonCommand, skipCoreSkills = false, withStatusline = false) {
  addDirectPlatformAssets(plan, platform, pythonCommand, withStatusline)
  const ctx = PLATFORM_CONTEXT[platform]
  const commands = coreTemplates(platform, pythonCommand)
  if (platform === 'codex' || platform === 'kiro' || platform === 'reasonix') {
    const root = platform === 'codex' ? '.agents/skills' : platform === 'kiro' ? '.kiro/skills' : '.reasonix/skills'
    addCoreSkills(plan, platform, root, pythonCommand)
  }
  else {
    const skillsRoot = PLATFORM_SKILLS_ROOT[platform]
    if (skillsRoot && !skipCoreSkills)
      addCoreSkills(plan, platform, skillsRoot, pythonCommand)
    for (const command of commands) {
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
    const hook = fs.readFileSync(path.join(CORE_ASSET_ROOT, 'hooks', hookName), 'utf8')
    addPlan(plan, `${HOOK_ROOTS[platform]}/${hookName}`, localizeProjectRuntime(hookName, resolveTemplate(hook, ctx, pythonCommand)), { executable: true, platform })
  }
}

function readProjectText(...segments) {
  return fs.readFileSync(path.join(PROJECT_ASSET_ROOT, ...segments), 'utf8')
}

function renameProjectedSkillPath(relativePath) {
  const segments = relativePath.split('/')
  const skillsIndex = segments.indexOf('skills')
  if (skillsIndex >= 0 && segments[skillsIndex + 1])
    segments[skillsIndex + 1] = canonicalSkillName(segments[skillsIndex + 1])
  return segments.join('/')
}
