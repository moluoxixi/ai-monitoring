/* global process */
/**
 * Moluoxixi Workflow State Injection Plugin
 *
 * Per-turn UserPromptSubmit equivalent for OpenCode.
 *
 * On every chat.message, if a Moluoxixi task is active, inject a short
 * <workflow-state> breadcrumb reminding the main AI what task is
 * active and its expected flow. Breadcrumb text is pulled exclusively
 * from the project's workflow.md [workflow-state:STATUS] tag blocks —
 * workflow.md is the single source of truth. There are no fallback
 * tables in this plugin: when workflow.md is missing or a tag is
 * absent, the breadcrumb degrades to a generic
 * "Refer to workflow.md for current step." line so users see (and fix)
 * the broken state instead of the plugin silently masking it.
 *
 * Unlike session-start, this plugin does NOT dedupe — the breadcrumb
 * should surface on every turn so long conversations don't drift.
 *
 * Silently skips when:
 *   - No .moluoxixi/ directory
 *   - No active task in the session runtime context
 *   - task.json malformed or missing status
 */

import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { findUserTextPart, insertSyntheticTextPart } from "../lib/context-visibility.js"
import { MoluoxixiContext, debugLog, isMoluoxixiSubagent } from "../lib/moluoxixi-context.js"

// Supports STATUS values with letters, digits, underscores, hyphens
// (so "in-review" / "blocked-by-team" work alongside "in_progress").
const TAG_RE = /\[workflow-state:([A-Za-z0-9_-]+)\]\s*\n([\s\S]*?)\n\s*\[\/workflow-state:\1\]/g
const DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD = "no-moluoxixi"

function stripInlineComment(value) {
  let inQuote = null
  for (let idx = 0; idx < value.length; idx++) {
    const ch = value[idx]
    if (inQuote) {
      if (ch === inQuote) inQuote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch
      continue
    }
    if (ch === "#" && (idx === 0 || /\s/.test(value[idx - 1])))
      return value.slice(0, idx)
  }
  return value
}

function unquoteYaml(value) {
  if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'"))
    return value.slice(1, -1)
  return value
}

function readSkipKeyword(directory) {
  const configPath = join(directory, ".moluoxixi", "config.yaml")
  if (!existsSync(configPath)) return DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD
  let text
  try {
    text = readFileSync(configPath, "utf-8")
  } catch {
    return DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD
  }
  let inSection = false
  let sectionIndent = -1
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!inSection) {
      if (/^prompt_injection\s*:\s*(#.*)?$/.test(trimmed)) {
        inSection = true
        sectionIndent = rawLine.length - rawLine.trimStart().length
      }
      continue
    }
    if (!trimmed || trimmed.startsWith("#")) continue
    const indent = rawLine.length - rawLine.trimStart().length
    if (indent <= sectionIndent) break
    const match = trimmed.match(/^skip_keyword\s*:\s*(.*)$/)
    if (match)
      return unquoteYaml(stripInlineComment(match[1]).trim())
  }
  return DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD
}

function promptHasSkipKeyword(text, keyword) {
  if (!keyword || typeof text !== "string") return false
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "i").test(text)
}

/**
 * Parse workflow.md for [workflow-state:STATUS] blocks.
 *
 * Returns {status: body}. workflow.md is the single source of truth —
 * there are no fallback tables here. Missing tags (or a missing /
 * unreadable workflow.md) fall back to a generic line in
 * buildBreadcrumb so users see the broken state and fix workflow.md
 * rather than the plugin silently masking it.
 */
function loadBreadcrumbs(directory) {
  const workflowPath = join(directory, ".moluoxixi", "workflow.md")
  if (!existsSync(workflowPath)) return {}
  let content
  try {
    content = readFileSync(workflowPath, "utf-8")
  } catch {
    return {}
  }
  const result = {}
  for (const match of content.matchAll(TAG_RE)) {
    const status = match[1]
    const body = match[2].trim()
    if (body) result[status] = body
  }
  return result
}

/**
 * Get (taskId, status) from active task, or null if no active task.
 */
function getActiveTask(ctx, platformInput = null) {
  const active = ctx.getActiveTask(platformInput)
  const taskRef = active.taskPath
  if (!taskRef) return null
  const taskDir = ctx.resolveTaskDir(taskRef)
  if (active.stale || !taskDir || !existsSync(taskDir)) {
    return { id: taskRef.split("/").pop(), status: "stale", source: active.source, complexity: "unknown", executionMode: "manual" }
  }
  const taskJsonPath = join(taskDir, "task.json")
  if (!existsSync(taskJsonPath)) return null
  try {
    const data = JSON.parse(readFileSync(taskJsonPath, "utf-8"))
    const status = typeof data.status === "string" ? data.status : ""
    if (!status) return null
    const id = data.id || taskRef.split("/").pop()
    const complexity = data.complexity && typeof data.complexity === "object" ? data.complexity.level || "unclassified" : "legacy"
    const executionMode = data.executionApproval && typeof data.executionApproval === "object" ? data.executionApproval.mode || "manual" : "legacy"
    return { id, status, source: active.source, complexity, executionMode }
  } catch {
    return null
  }
}

/**
 * Build the <workflow-state>...</workflow-state> block.
 * - Known status (tag present in workflow.md) → detailed body
 * - Unknown status (no tag, or workflow.md missing) → generic
 *   "Refer to workflow.md for current step." line
 * - no_task pseudo-status (id === null) → header omits task info
 */
function buildBreadcrumb(id, status, templates, complexity = null, executionMode = null) {
  let body = templates[status]
  if (body === undefined) {
    body = "Refer to workflow.md for current step."
  }
  let header = id === null ? `Status: ${status}` : `Task: ${id} (${status})`
  if (id !== null && complexity && executionMode)
    header += `; complexity=${complexity}; execution=${executionMode}`
  return `<workflow-state>\n${header}\n${body}\n</workflow-state>`
}

// OpenCode 1.2.x expects plugins to be factory functions (see inject-subagent-context.js comment).
export default async ({ directory }) => {
  const ctx = new MoluoxixiContext(directory)
  debugLog("workflow-state", "Plugin loaded, directory:", directory)

  return {
      // Persist a synthetic breadcrumb without changing the user prompt.
      "chat.message": async (input, output) => {
        try {
          // Skip Moluoxixi sub-agent turns — the per-turn breadcrumb is for the
          // main session only; sub-agent context comes from the parent's
          // tool.execute.before injection.
          if (isMoluoxixiSubagent(input)) {
            debugLog("workflow-state", "Skipping moluoxixi subagent turn:", input?.agent)
            return
          }
          if (process.env.MOLUOXIXI_HOOKS === "0" || process.env.MOLUOXIXI_DISABLE_HOOKS === "1") {
            return
          }
          if (process.env.OPENCODE_NON_INTERACTIVE === "1") {
            return
          }
          if (!ctx.isMoluoxixiProject()) {
            return
          }
          const parts = output?.parts || []
          const originalText = findUserTextPart(parts)?.text || ""
          if (promptHasSkipKeyword(originalText, readSkipKeyword(directory))) {
            debugLog("workflow-state", "Skipping turn: skip keyword present in prompt")
            return
          }
          const templates = loadBreadcrumbs(directory)
          const task = getActiveTask(ctx, input)
          const breadcrumb = task
            ? buildBreadcrumb(task.id, task.status, templates, task.complexity, task.executionMode)
            : buildBreadcrumb(null, "no_task", templates)

          insertSyntheticTextPart(parts, breadcrumb, "workflowState")
          debugLog(
            "workflow-state",
            "Injected breadcrumb for task",
            task ? task.id : "none",
            "status",
            task ? task.status : "no_task",
          )
        } catch (error) {
          debugLog(
            "workflow-state",
            "Error in chat.message:",
            error instanceof Error ? error.message : String(error),
          )
        }
      },
  }
}
