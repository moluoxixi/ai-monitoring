/**
 * Path constants for Moluoxixi workflow structure
 *
 * Change these values to rename directories across the entire project.
 * All paths should be relative to the project root.
 */

// Directory names (can be renamed)
export const DIR_NAMES = {
  /** Root workflow directory */
  WORKFLOW: ".moluoxixi",
  /** Workspace directory (under .moluoxixi/) - developer work areas */
  WORKSPACE: "workspace",
  /** Tasks directory (under .moluoxixi/) - unified task storage */
  TASKS: "tasks",
  /** Archive directory (under tasks/) */
  ARCHIVE: "archive",
  /** Spec/guidelines directory (under .moluoxixi/) */
  SPEC: "spec",
  /** Scripts directory (under .moluoxixi/) */
  SCRIPTS: "scripts",
  /** Channel runtime agent definitions (under .moluoxixi/) */
  AGENTS: "agents",
} as const;

// File names
export const FILE_NAMES = {
  /** Root agent instructions file */
  AGENTS: "AGENTS.md",
  /** Developer identity file */
  DEVELOPER: ".developer",
  /** Current task pointer */
  CURRENT_TASK: ".current-task",
  /** Task metadata */
  TASK_JSON: "task.json",
  /** Requirements document */
  PRD: "prd.md",
  /** Workflow guide */
  WORKFLOW_GUIDE: "workflow.md",
  /** Journal file prefix */
  JOURNAL_PREFIX: "journal-",
} as const;

// Constructed paths (relative to project root)
export const PATHS = {
  /** .moluoxixi/ */
  WORKFLOW: DIR_NAMES.WORKFLOW,
  /** .moluoxixi/workspace/ */
  WORKSPACE: `${DIR_NAMES.WORKFLOW}/${DIR_NAMES.WORKSPACE}`,
  /** .moluoxixi/tasks/ */
  TASKS: `${DIR_NAMES.WORKFLOW}/${DIR_NAMES.TASKS}`,
  /** .moluoxixi/spec/ */
  SPEC: `${DIR_NAMES.WORKFLOW}/${DIR_NAMES.SPEC}`,
  /** .moluoxixi/scripts/ */
  SCRIPTS: `${DIR_NAMES.WORKFLOW}/${DIR_NAMES.SCRIPTS}`,
  /** .moluoxixi/agents/ */
  AGENTS: `${DIR_NAMES.WORKFLOW}/${DIR_NAMES.AGENTS}`,
  /** .moluoxixi/.developer */
  DEVELOPER_FILE: `${DIR_NAMES.WORKFLOW}/${FILE_NAMES.DEVELOPER}`,
  /** .moluoxixi/.current-task */
  CURRENT_TASK_FILE: `${DIR_NAMES.WORKFLOW}/${FILE_NAMES.CURRENT_TASK}`,
  /** .moluoxixi/workflow.md */
  WORKFLOW_GUIDE_FILE: `${DIR_NAMES.WORKFLOW}/${FILE_NAMES.WORKFLOW_GUIDE}`,
} as const;

/**
 * Get developer's workspace directory path
 * @example getWorkspaceDir("john") => ".moluoxixi/workspace/john"
 */
export function getWorkspaceDir(developer: string): string {
  return `${PATHS.WORKSPACE}/${developer}`;
}

/**
 * Get task directory path
 * @example getTaskDir("01-21-my-task") => ".moluoxixi/tasks/01-21-my-task"
 */
export function getTaskDir(taskName: string): string {
  return `${PATHS.TASKS}/${taskName}`;
}

/**
 * Get archive directory path
 * @example getArchiveDir() => ".moluoxixi/tasks/archive"
 */
export function getArchiveDir(): string {
  return `${PATHS.TASKS}/${DIR_NAMES.ARCHIVE}`;
}
