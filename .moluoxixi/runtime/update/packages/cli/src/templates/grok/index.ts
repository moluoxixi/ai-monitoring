/**
 * Grok Build template module.
 *
 * Grok Build (xAI) is a class-2 pull-based platform:
 * - Skills under `.grok/skills/<name>/SKILL.md`
 * - Flat slash commands under `.grok/commands/moluoxixi-*.md`
 * - Sub-agents under `.grok/agents/<name>.md`
 *
 * SessionStart/UserPromptSubmit do not inject additionalContext (Grok 0.2.x).
 * moluoxixi-implement / moluoxixi-check use pull-based context loading.
 * moluoxixi-research is standalone (no implement/check prelude).
 */

import { createTemplateReader, type AgentTemplate } from "../template-utils.js";

const { listMdAgents } = createTemplateReader(import.meta.url);

/** Sub-agent definitions (moluoxixi-implement, moluoxixi-check, moluoxixi-research). */
export function getAllAgents(): AgentTemplate[] {
  return listMdAgents();
}
