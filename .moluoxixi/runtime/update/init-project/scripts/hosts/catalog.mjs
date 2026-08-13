export const PLATFORM_ORDER = [
  'claude',
  'cursor',
  'opencode',
  'codex',
  'kilo',
  'kiro',
  'gemini',
  'antigravity',
  'devin',
  'qoder',
  'codebuddy',
  'copilot',
  'droid',
  'pi',
  'reasonix',
  'zcode',
  'trae',
  'omp',
]

export const PLATFORM_CONTEXT = {
  claude: context('/moluoxixi:', 'Bash scripts or Task calls', 'Slash commands', true, true, 'claude'),
  cursor: context('/moluoxixi-', 'Bash scripts or Task calls', 'Slash commands', true, true, 'cursor'),
  opencode: context('/moluoxixi:', 'Bash scripts or Task calls', 'Slash commands', true, false, 'opencode'),
  codex: context('$', 'Bash scripts or tool calls', 'Skills', true, false, 'codex'),
  kilo: context('/moluoxixi:', 'Bash scripts or file reads', 'Workflows', false, false, 'kilo'),
  kiro: context('$', 'Bash scripts or tool calls', 'Skills', true, true, 'kiro'),
  gemini: context('/moluoxixi:', 'Bash scripts or tool calls', 'Slash commands', true, true, 'gemini'),
  antigravity: context('/', 'Bash scripts or file reads', 'Workflows', false, false, 'antigravity'),
  devin: context('/moluoxixi-', 'Bash scripts or file reads', 'Workflows', false, false, 'devin'),
  qoder: context('$', 'Bash scripts or tool calls', 'Skills', true, true, 'qoder'),
  codebuddy: context('/moluoxixi:', 'Bash scripts or Task calls', 'Slash commands', true, true, 'codebuddy'),
  copilot: context('/', 'Bash scripts or tool calls', 'Prompts', true, true, 'copilot'),
  droid: context('/moluoxixi-', 'Bash scripts or Task calls', 'Slash commands', true, true, 'droid'),
  pi: context('/moluoxixi-', 'Bash scripts or tool calls', 'Slash commands', true, true, 'pi'),
  reasonix: context('/skill ', 'Bash scripts or tool calls', 'Skills', true, false, 'reasonix'),
  zcode: context('/moluoxixi:', 'Bash scripts or Agent calls', 'Skills', true, false, 'zcode'),
  trae: context('/moluoxixi-', 'Bash scripts or tool calls', 'Commands', true, true, 'trae'),
  omp: context('/moluoxixi:', 'Bash scripts or Task calls', 'Slash commands', true, true, 'omp'),
}

export const PLATFORM_DIRECT = {
  claude: ['claude', '.claude'],
  cursor: ['cursor', '.cursor'],
  opencode: ['opencode', '.opencode'],
  codex: ['codex', '.codex'],
  kiro: ['kiro', '.kiro'],
  gemini: ['gemini', '.gemini'],
  qoder: ['qoder', '.qoder'],
  codebuddy: ['codebuddy', '.codebuddy'],
  droid: ['droid', '.factory'],
  pi: ['pi', '.pi'],
  zcode: ['zcode', '.zcode'],
  trae: ['trae', '.trae'],
  omp: ['omp', '.omp'],
}

export const PLATFORM_SKILLS_ROOT = {
  claude: '.claude/skills',
  cursor: '.cursor/skills',
  opencode: '.opencode/skills',
  kilo: '.kilocode/skills',
  gemini: '.agents/skills',
  antigravity: '.agent/skills',
  devin: '.devin/skills',
  qoder: '.qoder/skills',
  codebuddy: '.codebuddy/skills',
  copilot: '.github/skills',
  droid: '.factory/skills',
  pi: '.pi/skills',
  zcode: '.zcode/skills',
  trae: '.trae/skills',
  omp: '.omp/skills',
}

export const CORE_HOOKS = {
  claude: ['session-start.py', 'inject-workflow-state.py', 'inject-subagent-context.py'],
  cursor: ['session-start.py', 'inject-shell-session-context.py', 'inject-subagent-context.py'],
  codex: ['inject-workflow-state.py'],
  gemini: ['session-start.py', 'inject-workflow-state.py'],
  qoder: ['session-start.py', 'inject-workflow-state.py'],
  copilot: ['inject-workflow-state.py'],
  codebuddy: ['session-start.py', 'inject-workflow-state.py', 'inject-subagent-context.py'],
  droid: ['session-start.py', 'inject-workflow-state.py', 'inject-subagent-context.py'],
  kiro: ['session-start.py', 'inject-workflow-state.py', 'inject-subagent-context.py'],
  trae: ['session-start.py', 'inject-workflow-state.py'],
}

export const HOOK_ROOTS = {
  claude: '.claude/hooks',
  cursor: '.cursor/hooks',
  codex: '.codex/hooks',
  gemini: '.gemini/hooks',
  qoder: '.qoder/hooks',
  copilot: '.github/copilot/hooks',
  codebuddy: '.codebuddy/hooks',
  droid: '.factory/hooks',
  kiro: '.kiro/hooks',
  trae: '.trae/hooks',
}

function context(cmdRefPrefix, executorAI, userActionLabel, agentCapable, hasHooks, cliFlag) {
  return { cmdRefPrefix, executorAI, userActionLabel, agentCapable, hasHooks, cliFlag }
}

export function commandTarget(platform, name) {
  return {
    claude: `.claude/commands/moluoxixi/${name}.md`,
    cursor: `.cursor/commands/moluoxixi-${name}.md`,
    opencode: `.opencode/commands/moluoxixi/${name}.md`,
    kilo: `.kilocode/workflows/${name}.md`,
    antigravity: `.agent/workflows/${name}.md`,
    devin: `.devin/workflows/moluoxixi-${name}.md`,
    gemini: `.gemini/commands/moluoxixi/${name}.toml`,
    qoder: `.qoder/commands/moluoxixi-${name}.md`,
    codebuddy: `.codebuddy/commands/moluoxixi/${name}.md`,
    copilot: `.github/prompts/${name}.prompt.md`,
    droid: `.factory/commands/moluoxixi/${name}.md`,
    pi: `.pi/prompts/moluoxixi-${name}.md`,
    zcode: `.zcode/commands/moluoxixi/${name}.md`,
    trae: `.trae/commands/moluoxixi-${name}.md`,
    omp: `.omp/commands/moluoxixi-${name}.md`,
  }[platform]
}

export function normalizePlatforms(values) {
  const aliases = { 'claude-code': 'claude', 'windsurf': 'devin' }
  const expanded = values.flatMap(value => value === 'all' ? PLATFORM_ORDER : [aliases[value] ?? value])
  const unique = [...new Set(expanded.filter(Boolean))]
  if (unique.length === 0)
    throw new Error('At least one --platform value is required')
  for (const platform of unique) {
    if (!PLATFORM_ORDER.includes(platform))
      throw new Error(`Unsupported platform: ${platform}`)
  }
  return PLATFORM_ORDER.filter(platform => unique.includes(platform))
}
