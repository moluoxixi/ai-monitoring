import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { PROJECT_ROOT_DIR } from '../constants.mjs'
import { sanitizePackageName } from './project-detector.mjs'

export function captureLifecycleState(projectRoot) {
  const workflowRoot = path.join(projectRoot, PROJECT_ROOT_DIR)
  const tasksRoot = path.join(workflowRoot, 'tasks')
  return {
    firstInit: !fs.existsSync(workflowRoot),
    hadDeveloper: fs.existsSync(path.join(workflowRoot, '.developer')),
    tasksEmpty: !fs.existsSync(tasksRoot) || fs.readdirSync(tasksRoot).every(name => name === '.gitkeep'),
  }
}

export function applyLifecycle(projectRoot, developer, pythonCommand, projectType, packages, before) {
  if (!developer)
    return { developerInitialized: false }
  const created = []
  try {
    const developerInitialized = initializeDeveloper(projectRoot, developer, created)
    let taskCreated
    if (before.firstInit || before.tasksEmpty)
      taskCreated = createBootstrapTask(projectRoot, developer, pythonCommand, projectType, packages, created)
    else if (!before.hadDeveloper)
      taskCreated = createJoinerTask(projectRoot, developer, pythonCommand, created)
    return { developerInitialized, ...(taskCreated ? { taskCreated } : {}) }
  }
  catch (error) {
    rollbackCreatedFiles(created, projectRoot)
    throw error
  }
}

export function readDeveloper(projectRoot) {
  try {
    const content = fs.readFileSync(path.join(projectRoot, PROJECT_ROOT_DIR, '.developer'), 'utf8')
    return /^name=(.+)$/mu.exec(content)?.[1]
  }
  catch {
    return undefined
  }
}

export function detectGitDeveloper(projectRoot) {
  const result = spawnSync('git', ['config', 'user.name'], { cwd: projectRoot, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0 || result.error)
    return undefined
  const value = result.stdout.trim()
  return value || undefined
}

function initializeDeveloper(projectRoot, developer, created) {
  if (typeof developer !== 'string' || !developer.trim() || developer.length > 128 || /[\0\r\n/\\]/u.test(developer))
    throw new Error('Developer name must be non-empty, at most 128 characters, and contain no path separators or control characters')
  const workflowRoot = path.join(projectRoot, PROJECT_ROOT_DIR)
  const developerFile = path.join(workflowRoot, '.developer')
  if (fs.existsSync(developerFile))
    return false
  const workspace = path.join(workflowRoot, 'workspace', developer)
  fs.mkdirSync(workspace, { recursive: true })
  const today = new Date().toISOString().slice(0, 10)
  writeIfMissing(path.join(workspace, 'journal-1.md'), `# Journal - ${developer} (Part 1)\n\n> AI development session journal\n> Started: ${today}\n\n---\n\n`, created)
  writeIfMissing(path.join(workspace, 'index.md'), workspaceIndex(developer), created)
  fs.writeFileSync(developerFile, `name=${developer}\ninitialized_at=${new Date().toISOString()}\n`, { flag: 'wx' })
  created.push(developerFile)
  return true
}

function createBootstrapTask(projectRoot, developer, pythonCommand, projectType, packages, created) {
  const name = '00-bootstrap-guidelines'
  const relatedFiles = packages.length > 0
    ? packages.map(pkg => `${PROJECT_ROOT_DIR}/spec/${sanitizePackageName(pkg.name)}/`)
    : projectType === 'frontend'
      ? [`${PROJECT_ROOT_DIR}/spec/frontend/`]
      : projectType === 'backend'
        ? [`${PROJECT_ROOT_DIR}/spec/backend/`]
        : [`${PROJECT_ROOT_DIR}/spec/backend/`, `${PROJECT_ROOT_DIR}/spec/frontend/`]
  const task = taskRecord({
    id: name,
    name,
    title: 'Bootstrap Guidelines',
    description: 'Fill in project development guidelines for AI agents',
    status: 'planning',
    complexity: { level: 'complex', signals: ['initializer', 'multi_deliverable'], reason: 'Repository-wide knowledge bootstrap requires reviewed proposals' },
    executionApproval: { mode: 'manual', granted: false, source: null, grantedAt: null, reason: '' },
    dev_type: 'docs',
    priority: 'P1',
    creator: developer,
    assignee: developer,
    relatedFiles,
    notes: `First-time setup task created by Moluoxixi init (${projectType} project)`,
  })
  return writeTask(projectRoot, name, task, bootstrapPrd(projectType, packages, pythonCommand), created)
}

function createJoinerTask(projectRoot, developer, pythonCommand, created) {
  const name = `00-join-${slugify(developer)}`
  const task = taskRecord({
    id: name,
    name,
    title: `Joining: Onboard to this Moluoxixi project (${developer})`,
    description: 'Onboard a new developer to an existing Moluoxixi project: learn the workflow, conventions, and find assigned work',
    status: 'planning',
    complexity: { level: 'lightweight', signals: ['initializer'], reason: 'Initializer-created onboarding task' },
    executionApproval: { mode: 'manual', granted: false, source: null, grantedAt: null, reason: '' },
    dev_type: 'docs',
    priority: 'P1',
    creator: developer,
    assignee: developer,
    notes: 'Generated by Moluoxixi init for a new developer joining an existing project',
  })
  return writeTask(projectRoot, name, task, joinerPrd(developer, pythonCommand), created)
}

function writeTask(projectRoot, name, task, prd, created) {
  const directory = path.join(projectRoot, PROJECT_ROOT_DIR, 'tasks', name)
  if (fs.existsSync(directory))
    return name
  fs.mkdirSync(directory, { recursive: true })
  const taskFile = path.join(directory, 'task.json')
  const prdFile = path.join(directory, 'prd.md')
  fs.writeFileSync(taskFile, `${JSON.stringify(task, null, 2)}\n`, { flag: 'wx' })
  created.push(taskFile)
  fs.writeFileSync(prdFile, prd, { flag: 'wx' })
  created.push(prdFile)
  return name
}

function writeIfMissing(target, content, created) {
  if (fs.existsSync(target))
    return
  fs.writeFileSync(target, content, { flag: 'wx' })
  created.push(target)
}

function rollbackCreatedFiles(created, projectRoot) {
  for (const target of [...created].reverse()) {
    try {
      fs.rmSync(target, { force: true })
      removeEmptyParents(target, projectRoot)
    }
    catch {}
  }
}

function removeEmptyParents(target, projectRoot) {
  let current = path.dirname(target)
  while (current !== projectRoot) {
    try {
      fs.rmdirSync(current)
    }
    catch {
      return
    }
    current = path.dirname(current)
  }
}

function taskRecord(overrides) {
  return {
    id: '',
    name: '',
    title: '',
    description: '',
    status: 'planning',
    complexity: { level: 'unclassified', signals: [], reason: '' },
    executionApproval: { mode: 'manual', granted: false, source: null, grantedAt: null, reason: '' },
    dev_type: null,
    scope: null,
    package: null,
    priority: 'P2',
    creator: '',
    assignee: '',
    createdAt: new Date().toISOString().slice(0, 10),
    completedAt: null,
    branch: null,
    base_branch: null,
    worktree_path: null,
    commit: null,
    pr_url: null,
    subtasks: [],
    children: [],
    parent: null,
    relatedFiles: [],
    notes: '',
    meta: {},
    ...overrides,
  }
}

function workspaceIndex(developer) {
  return `# Workspace Index - ${developer}\n\n> Journal tracking for AI development sessions.\n\n---\n\n## Current Status\n\n<!-- @@@auto:current-status -->\n- **Active File**: \`journal-1.md\`\n- **Total Sessions**: 0\n- **Last Active**: -\n<!-- @@@/auto:current-status -->\n\n---\n\n## Active Documents\n\n<!-- @@@auto:active-documents -->\n| File | Lines | Status |\n|------|-------|--------|\n| \`journal-1.md\` | ~0 | Active |\n<!-- @@@/auto:active-documents -->\n\n---\n\n## Session History\n\n<!-- @@@auto:session-history -->\n| # | Date | Title | Commits | Branch |\n|---|------|-------|---------|--------|\n<!-- @@@/auto:session-history -->\n\n---\n\n## Notes\n\n- Sessions are appended to journal files\n- New journal file created when current exceeds 2000 lines\n- Use \`add_session.py\` to record sessions\n`
}

function bootstrapPrd(projectType, packages, pythonCommand) {
  const targets = packages.length > 0
    ? packages.map(pkg => `- [ ] Prepare reviewed guideline proposals for ${pkg.name} targeting \`${PROJECT_ROOT_DIR}/spec/${sanitizePackageName(pkg.name)}/\``).join('\n')
    : projectType === 'frontend'
      ? '- [ ] Fill frontend guidelines\n- [ ] Add real code examples'
      : projectType === 'backend'
        ? '- [ ] Fill backend guidelines\n- [ ] Add real code examples'
        : '- [ ] Fill backend guidelines\n- [ ] Fill frontend guidelines\n- [ ] Add real code examples'
  return `# Bootstrap Task: Fill Project Development Guidelines

**You (the AI) are running this task. The developer does not read this file.**

The developer just initialized Moluoxixi for this project. Prepare
\`${PROJECT_ROOT_DIR}/spec-proposals/\` candidates for the team's real coding conventions.
Do not directly replace formal specs; a human reviews and promotes candidates first.

## Status

${targets}

## Spec files to populate

Backend projects should document directory structure, database access, error
handling, logging, review standards, and testing. Frontend projects should
document component organization, component and hook patterns, state ownership,
type safety, linting, testing, and accessibility. For a monorepo, do this under
each approved package scope. The pre-filled thinking guides should change only
when they clearly do not fit this repository.

## Process

1. Import existing convention files first: AGENTS.md, CLAUDE.md, Cursor rules,
   Copilot instructions, CONTRIBUTING.md, .editorconfig, and equivalent docs.
2. Scan real code for anything not covered. Find 2-3 real examples for every
   documented pattern and reference their paths.
3. Document current reality, including known debt; do not write aspirational rules.
4. Use \`moluoxixi-spec-bootstrap\` to prepare complete candidates and submit one proposal per target.
5. Present the proposal batch and use \`moluoxixi-spec-review\` only after explicit human approval.

## Runtime mechanics

- Every task carries implement.jsonl and check.jsonl context manifests.
- Project hooks inject those spec files plus the task PRD into implementation and
  verification prompts.
- The reviewed project spec directory is the convention source of truth; empty specs lead
  to generic output, while examples from real code reproduce team patterns.

When the proposal batch contains real examples and the human has reviewed the decisions, finish and archive this task:

\`\`\`bash
${pythonCommand} ./${PROJECT_ROOT_DIR}/scripts/task.py finish
${pythonCommand} ./${PROJECT_ROOT_DIR}/scripts/task.py archive 00-bootstrap-guidelines
\`\`\`

Future developers receive a \`00-join-<slug>\` onboarding task.
`
}

function joinerPrd(developer, pythonCommand) {
  const slug = slugify(developer)
  return `# Joiner Onboarding Task

**You (the AI) are running this task. The developer does not read this file.**

Welcome \`${developer}\` to this Moluoxixi project. Cover these topics
conversationally rather than dumping them all at once:

Explain that Plan creates the PRD, Execute performs implementation and checking,
and Finish captures and wraps the work. Tasks move from planning to in_progress,
done, and archive. Session-start hooks inject identity, git state, active tasks,
and phase; workflow-state refreshes that context on user messages; implementation
and check agents receive their JSONL spec context plus the PRD.

Point out the runtime session state, task context manifests, project specs, and
the developer journal under the Moluoxixi project directory. Show recent archived
tasks as examples only when the archive is non-empty; never invent examples for a
new project. Mention an existing developer workspace as a preserved journal from
another machine.

1. The Plan -> Execute -> Finish workflow and task lifecycle.
2. Session hooks, workflow state, implement/check context manifests, and spec injection.
3. This project's actual conventions from \`${PROJECT_ROOT_DIR}/spec/\` and recent archived tasks.
4. Assigned work from:
   \`${pythonCommand} ./${PROJECT_ROOT_DIR}/scripts/task.py list --assignee ${developer}\`.

Offer to walk through a small task end-to-end. When onboarding is complete:

\`\`\`bash
${pythonCommand} ./${PROJECT_ROOT_DIR}/scripts/task.py finish
${pythonCommand} ./${PROJECT_ROOT_DIR}/scripts/task.py archive 00-join-${slug}
\`\`\`
`
}

function slugify(value) {
  return value.toLowerCase().normalize('NFKD').replace(/[^\p{Letter}\p{Number}]+/gu, '-').replace(/^-+|-+$/gu, '') || 'user'
}
