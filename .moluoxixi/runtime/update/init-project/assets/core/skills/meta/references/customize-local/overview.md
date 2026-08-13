# Local Customization Overview

This directory is for an AI working in a project initialized by the `init-project` skill. Modify generated `.moluoxixi/` and platform directories inside the project; do not install or edit an upstream Moluoxixi package.

## First Determine What The User Actually Wants To Change

| User wording | Read first |
| --- | --- |
| "Change the Moluoxixi flow / phases / next prompt" | `change-workflow.md` |
| "Change task creation, status, archive, or hooks" | `change-task-lifecycle.md` |
| "AI did not read context / change injected content" | `change-context-loading.md` |
| "A platform hook is not behaving as expected" | `change-hooks.md` |
| "Change implement/check/research agent behavior" | `change-agents.md` |
| "Add a skill/command/workflow/prompt" | `change-skills-or-commands.md` |
| "Adjust the project spec structure" | `change-spec-structure.md` |
| "Add team conventions and local notes" | `add-project-local-conventions.md` |

## General Operation Order

1. **Confirm platform and directories**: inspect which directories exist, such as `.claude/`, `.codex/`, `.cursor/`, `.zcode/`.
2. **Confirm the current active task**: run `python3 ./.moluoxixi/scripts/task.py current --source`.
3. **Read the local source of truth**: prefer `.moluoxixi/workflow.md`, `.moluoxixi/config.yaml`, and relevant platform files.
4. **Modify narrowly**: edit only files related to the user's request.
5. **Synchronize semantics**: if a shared flow changes, check whether platform entry points also need changes; if a platform entry changes, check whether `.moluoxixi/workflow.md` still agrees.

## Local File Priority

| Layer | Files |
| --- | --- |
| Workflow | `.moluoxixi/workflow.md` |
| Project configuration | `.moluoxixi/config.yaml` |
| Task material | `.moluoxixi/tasks/<task>/` |
| Project specs | `.moluoxixi/spec/` |
| Runtime scripts | `.moluoxixi/scripts/` |
| Platform integration | `.claude/`, `.codex/`, `.cursor/`, `.opencode/`, `.zcode/`, and similar directories |
| Shared skill | `.agents/skills/` |

## Things Not To Do By Default

- Do not edit `.moluoxixi/runtime/` unless the request is specifically about runtime implementation.
- Do not assume the user has the Moluoxixi GitHub repository.
- Do not overwrite local files already modified by the user with default templates.
- Do not put team project rules into public `meta`; project rules belong in `.moluoxixi/spec/` or a local skill.

## When To Inspect Role Source

Switch to an upstream source-code perspective only when the user explicitly expresses one of these goals:

- "I want to change the Moluoxixi role"
- "I want to modify init-project or update generation"
- "I want to change the migrated channel or memory runtime"

Otherwise, default to modifying local Moluoxixi files inside the user project.
