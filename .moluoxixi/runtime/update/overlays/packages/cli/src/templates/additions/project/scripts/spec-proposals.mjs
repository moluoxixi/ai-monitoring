#!/usr/bin/env node

import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const WORKFLOW_ROOT = '.moluoxixi'
const SPEC_ROOT = 'spec'
const PROPOSAL_ROOT = 'spec-proposals'
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,127}$/u
const HASH_PATTERN = /^[a-f0-9]{64}$/u
const REVIEW_INTERVAL_DAYS = 30
const REVIEW_COUNT_THRESHOLD = 10

function findProjectRoot(start = process.cwd()) {
  let current = path.resolve(start)
  while (true) {
    if (fs.existsSync(path.join(current, WORKFLOW_ROOT)))
      return current
    const parent = path.dirname(current)
    if (parent === current)
      throw new Error(`No ${WORKFLOW_ROOT} directory found from ${start}`)
    current = parent
  }
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex')
}

function fileHash(file) {
  if (!fs.existsSync(file))
    return null
  const stats = fs.lstatSync(file)
  if (stats.isSymbolicLink() || !stats.isFile())
    throw new Error(`Refusing non-file or symlink target: ${file}`)
  return sha256(fs.readFileSync(file))
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx' })
    fs.renameSync(temporary, file)
  }
  finally {
    fs.rmSync(temporary, { force: true })
  }
}

function writeJson(file, value) {
  atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`)
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function normalizeTarget(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0'))
    throw new Error('Spec target must be a non-empty relative file path')
  const normalized = value.trim().replace(/\\/gu, '/').replace(/^\.\//u, '')
  if (path.posix.isAbsolute(normalized) || normalized.split('/').some(part => part === '..' || part === '.' || !part))
    throw new Error(`Unsafe spec target: ${value}`)
  if (normalized.startsWith(`${WORKFLOW_ROOT}/`) || normalized.startsWith(`${SPEC_ROOT}/`))
    throw new Error('Spec target must be relative to .moluoxixi/spec/')
  return normalized
}

function assertSafeTarget(projectRoot, relativeTarget) {
  const specRoot = path.resolve(projectRoot, WORKFLOW_ROOT, SPEC_ROOT)
  const target = path.resolve(specRoot, ...relativeTarget.split('/'))
  if (target !== specRoot && !target.startsWith(`${specRoot}${path.sep}`))
    throw new Error(`Spec target escapes ${specRoot}: ${relativeTarget}`)
  let current = specRoot
  for (const segment of relativeTarget.split('/').slice(0, -1)) {
    current = path.join(current, segment)
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
      throw new Error(`Refusing spec path through symlink: ${current}`)
  }
  return target
}

function proposalPaths(projectRoot) {
  const root = path.join(projectRoot, WORKFLOW_ROOT, PROPOSAL_ROOT)
  const resolved = {
    root,
    inbox: path.join(root, 'inbox'),
    content: path.join(root, 'content'),
    approvals: path.join(root, 'approvals'),
    backups: path.join(root, 'backups'),
    events: path.join(root, 'history', 'events.jsonl'),
  }
  for (const candidate of [resolved.root, resolved.inbox, resolved.content, resolved.approvals, resolved.backups, path.dirname(resolved.events)]) {
    if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink())
      throw new Error(`Refusing spec proposal path through symlink: ${candidate}`)
  }
  return resolved
}

function option(args, name) {
  const index = args.indexOf(name)
  if (index === -1)
    return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--'))
    throw new Error(`${name} requires a value`)
  return value
}

function options(args, name) {
  const values = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name)
      continue
    const value = args[index + 1]
    if (!value || value.startsWith('--'))
      throw new Error(`${name} requires a value`)
    values.push(...value.split(',').map(item => item.trim()).filter(Boolean))
    index += 1
  }
  return values
}

function requireOption(args, name) {
  const value = option(args, name)
  if (!value)
    throw new Error(`${name} is required`)
  return value
}

function appendEvent(paths, event) {
  fs.mkdirSync(path.dirname(paths.events), { recursive: true })
  fs.appendFileSync(paths.events, `${JSON.stringify({ schemaVersion: 1, at: new Date().toISOString(), ...event })}\n`, 'utf8')
}

function loadEvents(paths) {
  if (!fs.existsSync(paths.events))
    return []
  return fs.readFileSync(paths.events, 'utf8').split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line)
    }
    catch (error) {
      throw new Error(`Invalid proposal history JSON at line ${index + 1}`, { cause: error })
    }
  })
}

function requireId(value) {
  if (!ID_PATTERN.test(value))
    throw new Error(`Invalid proposal id: ${value}`)
  return value
}

function loadProposal(paths, id) {
  requireId(id)
  const proposalFile = path.join(paths.inbox, `${id}.json`)
  if (!fs.existsSync(proposalFile))
    throw new Error(`Proposal not found: ${id}`)
  const proposal = readJson(proposalFile)
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal))
    throw new Error('Invalid proposal record')
  if (proposal.schemaVersion !== 1 || proposal.id !== id)
    throw new Error('Proposal identity or schema is invalid')
  if (proposal.target !== normalizeTarget(proposal.target))
    throw new Error('Proposal target is not canonical')
  if (!['file', 'delete'].includes(proposal.kind))
    throw new Error('Proposal kind must be file or delete')
  if (proposal.baseHash !== null && !HASH_PATTERN.test(proposal.baseHash))
    throw new Error('Proposal base hash is invalid')
  if (proposal.kind === 'file') {
    if (proposal.contentFile !== `content/${id}.md` || !HASH_PATTERN.test(proposal.contentHash))
      throw new Error('Proposal content metadata is invalid')
  }
  else if (proposal.contentFile !== null || proposal.contentHash !== null) {
    throw new Error('Delete proposal must not contain content metadata')
  }
  return { proposal, proposalFile, proposalHash: fileHash(proposalFile) }
}

function validatedProposalContent(paths, proposal) {
  if (proposal.kind !== 'file')
    return null
  const contentFile = path.join(paths.content, `${proposal.id}.md`)
  if (fileHash(contentFile) !== proposal.contentHash)
    throw new Error('Proposal content changed after creation')
  return contentFile
}

function proposalStatus(paths, id, events = loadEvents(paths)) {
  const terminal = [...events].reverse().find(event => event.proposalId === id && ['applied', 'rejected', 'superseded'].includes(event.type))
  if (terminal)
    return terminal.type
  const approvalFile = path.join(paths.approvals, `${id}.json`)
  const approved = [...events].reverse().find(event => event.proposalId === id && event.type === 'approved')
  return approved && fs.existsSync(approvalFile) ? 'approved' : 'pending'
}

function validateApproval(paths, id, proposal, proposalHash, approvalFile) {
  const approval = readJson(approvalFile)
  if (!approval || typeof approval !== 'object' || Array.isArray(approval))
    throw new Error('Invalid approval record')
  if (approval.schemaVersion !== 1)
    throw new Error('Unsupported approval schema version')
  if (approval.proposalId !== id)
    throw new Error('Approval record targets a different proposal')
  if (approval.proposalHash !== proposalHash)
    throw new Error('Proposal changed after approval')
  if (!['promote', 'reject'].includes(approval.decision))
    throw new Error('Approval decision must be promote or reject')
  if (typeof approval.approvedBy !== 'string' || !approval.approvedBy.trim())
    throw new Error('Approval record is missing the human reviewer')
  if (typeof approval.approvedAt !== 'string' || !Number.isFinite(Date.parse(approval.approvedAt)))
    throw new Error('Approval record has an invalid approval time')
  if (approval.expectedTargetHash !== null && !HASH_PATTERN.test(approval.expectedTargetHash))
    throw new Error('Approval record has an invalid target hash')
  if (!Array.isArray(approval.supersedes) || new Set(approval.supersedes).size !== approval.supersedes.length)
    throw new Error('Approval record has invalid supersedes entries')
  for (const superseded of approval.supersedes) {
    requireId(superseded)
    if (superseded === id)
      throw new Error('A proposal cannot supersede itself')
  }
  if (approval.decision === 'promote' && proposal.kind === 'file') {
    if (typeof approval.resolvedContent !== 'string' || !approval.resolvedContent.trim())
      throw new Error('Approved spec content must not be empty')
    const resolvedHash = sha256(Buffer.from(approval.resolvedContent, 'utf8'))
    if (!HASH_PATTERN.test(approval.resolvedHash) || approval.resolvedHash !== resolvedHash)
      throw new Error('Approved content does not match its recorded hash')
  }
  else if (approval.resolvedContent !== null || approval.resolvedHash !== null) {
    throw new Error('Delete and reject approvals must not contain resolved content')
  }
  if (approval.decision === 'reject' && approval.supersedes.length > 0)
    throw new Error('Rejected proposals cannot supersede other proposals')

  const events = loadEvents(paths)
  const approvalEvent = [...events].reverse().find(event => event.proposalId === id && event.type === 'approved')
  if (!approvalEvent)
    throw new Error(`Proposal ${id} has no recorded human approval event`)
  const approvalHash = fileHash(approvalFile)
  if (
    approvalEvent.approvalHash !== approvalHash
    || approvalEvent.decision !== approval.decision
    || approvalEvent.approvedBy !== approval.approvedBy
    || approvalEvent.approvedAt !== approval.approvedAt
  ) {
    throw new Error('Approval record changed after human review')
  }
  return approval
}

function listProposals(paths) {
  if (!fs.existsSync(paths.inbox))
    return []
  const events = loadEvents(paths)
  return fs.readdirSync(paths.inbox).filter(name => name.endsWith('.json')).sort().map((name) => {
    const proposal = readJson(path.join(paths.inbox, name))
    return { ...proposal, status: proposalStatus(paths, proposal.id, events) }
  })
}

function makeId(target) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/gu, '').slice(0, 14)
  const slug = path.posix.basename(target, '.md').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 32) || 'spec'
  return `${stamp}-${slug}-${crypto.randomBytes(3).toString('hex')}`
}

function commandPropose(projectRoot, args) {
  const paths = proposalPaths(projectRoot)
  const target = normalizeTarget(requireOption(args, '--target'))
  const deleteProposal = args.includes('--delete')
  const contentFile = option(args, '--content-file')
  if (deleteProposal === Boolean(contentFile))
    throw new Error('Choose exactly one of --content-file or --delete')

  const targetFile = assertSafeTarget(projectRoot, target)
  const id = makeId(target)
  const proposal = {
    schemaVersion: 1,
    id,
    createdAt: new Date().toISOString(),
    createdBy: option(args, '--by') ?? process.env.USERNAME ?? process.env.USER ?? 'unknown',
    sourceTask: option(args, '--source-task') ?? null,
    reason: option(args, '--reason') ?? '',
    target,
    kind: deleteProposal ? 'delete' : 'file',
    baseHash: fileHash(targetFile),
    contentFile: deleteProposal ? null : `content/${id}.md`,
    contentHash: null,
  }
  if (contentFile) {
    const content = fs.readFileSync(path.resolve(contentFile))
    if (content.length === 0)
      throw new Error('Proposed content must not be empty')
    proposal.contentHash = sha256(content)
    atomicWrite(path.join(paths.content, `${id}.md`), content)
  }
  writeJson(path.join(paths.inbox, `${id}.json`), proposal)
  appendEvent(paths, { type: 'proposed', proposalId: id, target })
  process.stdout.write(`${id}\n`)
}

function commandList(paths, args) {
  const proposals = listProposals(paths)
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(proposals, null, 2)}\n`)
    return
  }
  if (proposals.length === 0) {
    process.stdout.write('No spec proposals.\n')
    return
  }
  for (const proposal of proposals)
    process.stdout.write(`${proposal.id}\t${proposal.status}\t${proposal.kind}\t${proposal.target}\n`)
}

function commandShow(projectRoot, paths, id) {
  const { proposal } = loadProposal(paths, id)
  const targetFile = assertSafeTarget(projectRoot, proposal.target)
  process.stdout.write(`${JSON.stringify({ ...proposal, status: proposalStatus(paths, id), currentTargetHash: fileHash(targetFile) }, null, 2)}\n`)
  if (fs.existsSync(targetFile))
    process.stdout.write(`\n--- CURRENT ${proposal.target} ---\n${fs.readFileSync(targetFile, 'utf8')}\n`)
  if (proposal.kind === 'file')
    process.stdout.write(`\n--- PROPOSED ${proposal.target} ---\n${fs.readFileSync(validatedProposalContent(paths, proposal), 'utf8')}\n`)
}

function commandReview(projectRoot, paths, id, args) {
  if (!args.includes('--user-approved'))
    throw new Error('Review requires --user-approved after the human reviews the proposal')
  const decision = requireOption(args, '--decision')
  if (!['promote', 'reject'].includes(decision))
    throw new Error('--decision must be promote or reject')
  const approvedBy = requireOption(args, '--by')
  const { proposal, proposalHash } = loadProposal(paths, id)
  const status = proposalStatus(paths, id)
  if (!['pending', 'approved'].includes(status))
    throw new Error(`Proposal ${id} is already ${status}`)
  const targetFile = assertSafeTarget(projectRoot, proposal.target)
  const currentTargetHash = fileHash(targetFile)
  if (currentTargetHash !== proposal.baseHash)
    throw new Error('Target spec changed since proposal creation; create a new proposal against the current spec')

  let resolvedContent = null
  let resolvedHash = null
  if (decision === 'promote' && proposal.kind === 'file') {
    const proposalContent = validatedProposalContent(paths, proposal)
    const resolvedFile = option(args, '--content-file')
    resolvedContent = resolvedFile
      ? fs.readFileSync(path.resolve(resolvedFile), 'utf8')
      : fs.readFileSync(proposalContent, 'utf8')
    if (!resolvedContent.trim())
      throw new Error('Approved spec content must not be empty')
    resolvedHash = sha256(Buffer.from(resolvedContent, 'utf8'))
  }
  const supersedes = options(args, '--supersedes').map(requireId)
  for (const superseded of supersedes) {
    if (superseded === id)
      throw new Error('A proposal cannot supersede itself')
    const { proposal: previous } = loadProposal(paths, superseded)
    if (previous.target !== proposal.target)
      throw new Error(`Superseded proposal ${superseded} targets a different spec file`)
    if (!['pending', 'approved'].includes(proposalStatus(paths, superseded)))
      throw new Error(`Superseded proposal ${superseded} is already resolved`)
  }
  const approval = {
    schemaVersion: 1,
    proposalId: id,
    proposalHash,
    decision,
    approvedBy,
    approvedAt: new Date().toISOString(),
    expectedTargetHash: currentTargetHash,
    resolvedContent,
    resolvedHash,
    supersedes,
    reason: option(args, '--reason') ?? '',
  }
  const approvalFile = path.join(paths.approvals, `${id}.json`)
  writeJson(approvalFile, approval)
  appendEvent(paths, {
    type: 'approved',
    proposalId: id,
    decision,
    approvedBy,
    approvedAt: approval.approvedAt,
    approvalHash: fileHash(approvalFile),
  })
  process.stdout.write(`Approved ${id} for ${decision}. Run apply --user-approved only within the explicitly approved review action.\n`)
}

function commandApply(projectRoot, paths, id, args) {
  if (!args.includes('--user-approved'))
    throw new Error('Apply requires --user-approved after the human approves promotion or rejection')
  const { proposal, proposalHash } = loadProposal(paths, id)
  const approvalFile = path.join(paths.approvals, `${id}.json`)
  if (!fs.existsSync(approvalFile))
    throw new Error(`Proposal ${id} has no human approval record`)
  const approval = validateApproval(paths, id, proposal, proposalHash, approvalFile)
  const targetFile = assertSafeTarget(projectRoot, proposal.target)
  const currentTargetHash = fileHash(targetFile)
  const desiredHash = approval.decision === 'promote' && proposal.kind === 'file' ? approval.resolvedHash : null
  const status = proposalStatus(paths, id)
  if (status === 'rejected') {
    process.stdout.write(`Proposal ${id} already rejected.\n`)
    return
  }
  if (status === 'applied' && currentTargetHash === desiredHash) {
    process.stdout.write(`Proposal ${id} already applied.\n`)
    return
  }
  if (currentTargetHash !== approval.expectedTargetHash)
    throw new Error('Target spec changed after approval; refusing to apply stale knowledge')

  if (approval.decision === 'promote') {
    const assertTargetUnchanged = () => {
      const checkedTarget = assertSafeTarget(projectRoot, proposal.target)
      if (checkedTarget !== targetFile || fileHash(checkedTarget) !== approval.expectedTargetHash)
        throw new Error('Target spec changed during apply; refusing to overwrite concurrent knowledge')
    }
    assertTargetUnchanged()
    if (currentTargetHash !== null) {
      const backupFile = path.join(paths.backups, id, ...proposal.target.split('/'))
      fs.mkdirSync(path.dirname(backupFile), { recursive: true })
      fs.copyFileSync(targetFile, backupFile, fs.constants.COPYFILE_EXCL)
    }
    assertTargetUnchanged()
    if (proposal.kind === 'delete') {
      if (fs.existsSync(targetFile))
        fs.rmSync(targetFile)
    }
    else {
      if (sha256(Buffer.from(approval.resolvedContent, 'utf8')) !== approval.resolvedHash)
        throw new Error('Approved content changed before apply')
      atomicWrite(targetFile, approval.resolvedContent)
      if (fileHash(targetFile) !== approval.resolvedHash)
        throw new Error('Applied spec hash does not match the approved content')
    }
    appendEvent(paths, { type: 'applied', proposalId: id, target: proposal.target, approvedBy: approval.approvedBy })
    for (const superseded of approval.supersedes) {
      if (superseded !== id)
        appendEvent(paths, { type: 'superseded', proposalId: superseded, byProposalId: id })
    }
    process.stdout.write(`Applied ${id} to .moluoxixi/spec/${proposal.target}.\n`)
  }
  else {
    appendEvent(paths, { type: 'rejected', proposalId: id, approvedBy: approval.approvedBy })
    process.stdout.write(`Rejected ${id}; formal spec was not changed.\n`)
  }
}

function commandAudit(paths, args) {
  const pending = listProposals(paths).filter(proposal => ['pending', 'approved'].includes(proposal.status))
  const events = loadEvents(paths)
  const lastAudit = [...events].reverse().find(event => event.type === 'audit-reviewed')
  const intervalMs = REVIEW_INTERVAL_DAYS * 24 * 60 * 60 * 1000
  const dueByTime = !lastAudit || Date.now() - Date.parse(lastAudit.at) >= intervalMs
  const due = pending.length > 0 && (dueByTime || pending.length >= REVIEW_COUNT_THRESHOLD)
  const duplicates = new Map()
  const byTarget = new Map()
  for (const proposal of pending) {
    const duplicateKey = `${proposal.target}\0${proposal.kind}\0${proposal.contentHash ?? ''}`
    duplicates.set(duplicateKey, [...(duplicates.get(duplicateKey) ?? []), proposal.id])
    byTarget.set(proposal.target, [...(byTarget.get(proposal.target) ?? []), proposal.id])
  }
  const report = {
    due,
    reviewIntervalDays: REVIEW_INTERVAL_DAYS,
    reviewCountThreshold: REVIEW_COUNT_THRESHOLD,
    lastReviewedAt: lastAudit?.at ?? null,
    pendingCount: pending.length,
    duplicateSets: [...duplicates.values()].filter(ids => ids.length > 1),
    targetsWithMultipleProposals: [...byTarget.entries()].filter(([, ids]) => ids.length > 1).map(([target, proposals]) => ({ target, proposals })),
  }
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  }
  else {
    process.stdout.write(`Spec proposal audit: ${due ? 'DUE' : 'not due'}\n`)
    process.stdout.write(`Pending: ${pending.length}; exact duplicate sets: ${report.duplicateSets.length}\n`)
    for (const group of report.targetsWithMultipleProposals)
      process.stdout.write(`Merge review needed: ${group.target} <- ${group.proposals.join(', ')}\n`)
  }
  if (args.includes('--mark-reviewed')) {
    if (!args.includes('--user-approved'))
      throw new Error('--mark-reviewed requires --user-approved')
    appendEvent(paths, { type: 'audit-reviewed', approvedBy: requireOption(args, '--by'), pendingCount: pending.length })
  }
}

function printHelp() {
  process.stdout.write(`Usage: node .moluoxixi/scripts/spec-proposals.mjs <command> [options]\n\nCommands:\n  propose --target <relative-spec-file> (--content-file <file> | --delete) [--reason <text>] [--source-task <path>]\n  list [--json]\n  show <proposal-id>\n  review <proposal-id> --decision promote|reject --by <actor> --user-approved [--content-file <merged>] [--supersedes <ids>]\n  apply <proposal-id> --user-approved\n  audit [--json] [--mark-reviewed --by <actor> --user-approved]\n`)
}

try {
  const projectRoot = findProjectRoot()
  const paths = proposalPaths(projectRoot)
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === 'help' || command === '--help' || command === '-h')
    printHelp()
  else if (command === 'propose')
    commandPropose(projectRoot, args)
  else if (command === 'list')
    commandList(paths, args)
  else if (command === 'show')
    commandShow(projectRoot, paths, requireId(args[0] ?? ''))
  else if (command === 'review')
    commandReview(projectRoot, paths, requireId(args[0] ?? ''), args.slice(1))
  else if (command === 'apply')
    commandApply(projectRoot, paths, requireId(args[0] ?? ''), args.slice(1))
  else if (command === 'audit')
    commandAudit(paths, args)
  else
    throw new Error(`Unknown spec proposal command: ${command}`)
}
catch (error) {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
