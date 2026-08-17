# Add Project-Local Conventions

Often the user does not need to change Moluoxixi mechanics; they need local AI to understand their team's conventions. In that case, prefer `.moluoxixi/spec/` or a project-local skill instead of editing `meta`.

## Where To Put Things

| Content type | Location |
| --- | --- |
| Rules code must follow | `.moluoxixi/spec/<layer>/` |
| Cross-layer thinking methods | `.moluoxixi/spec/guides/` |
| AI capability for a project-specific flow | Platform-local skill |
| One-off task material | `.moluoxixi/tasks/<task>/` |
| Session summary | `.moluoxixi/workspace/<developer>/journal-N.md` |

## Create A Project-Local Skill

If the user wants AI to know "how this project customizes Moluoxixi," create a local skill:

```text
.claude/skills/project-local/
└── SKILL.md
```

Example:

```md
---
name: project-local
description: "Project-local Moluoxixi customizations for this repository. Use when changing this project's Moluoxixi workflow, hooks, local agents, or team-specific conventions."
---

# Moluoxixi Local

## Local Scope

This skill documents this repository's Moluoxixi customizations only.

## Custom Workflow Rules

- ...

## Local Hook Changes

- ...

## Local Agent Changes

- ...
```

For multi-platform projects, place equivalent versions in other platform skill directories, or use `.agents/skills/` for platforms that support the shared layer.

## Propose Knowledge For `.moluoxixi/spec/`

If the content is a coding convention, prepare its complete desired target and
submit it through `update-spec`. Examples:

```text
.moluoxixi/spec/backend/error-handling.md
.moluoxixi/spec/frontend/components.md
.moluoxixi/spec/guides/cross-platform-thinking-guide.md
```

Submit a separate complete candidate for the corresponding `index.md`. Do not
modify the formal targets until the user explicitly approves them through
`spec-review`.

## Make The Current Task Use New Conventions

After the user approves and promotes a spec, add it to the current task context:

```bash
python3 ./.moluoxixi/scripts/task.py add-context <task> implement ".moluoxixi/spec/backend/error-handling.md" "Error handling conventions"
python3 ./.moluoxixi/scripts/task.py add-context <task> check ".moluoxixi/spec/backend/error-handling.md" "Review error handling"
```

## Do Not Store Project-Private Rules In `meta`

`meta` is a public skill for understanding Moluoxixi architecture and local customization entry points. Put project-private content in:

- `.moluoxixi/spec/`
- a project-local skill
- the current task
- workspace journal

This prevents future updates to Moluoxixi's built-in `meta` from overwriting the team's own conventions.
