---
name: start
description: "Initialize a Moluoxixi development session, classify the incoming task, and route it to the appropriate workflow."
---

# Start Session

Initialize a Moluoxixi-managed development session. This platform has no session-start hook, so manually load the equivalent compact context by following these steps.

---

## Step 1: Current state
Identity, git status, current task, active tasks, journal location.

```bash
python ./.moluoxixi/scripts/get_context.py
```

If this output includes a line beginning `Moluoxixi update available:`, copy the full line verbatim when summarizing session context. Do not shorten operational command hints.

## Step 2: Workflow overview
Compact Phase Index, request triage rules, planning artifact contract, and the step-detail command.

```bash
python ./.moluoxixi/scripts/get_context.py --mode phase
```

Full guide in `.moluoxixi/workflow.md` (read on demand).

## Step 3: Guideline indexes
Discover packages + spec layers, then read each relevant index file.

```bash
python ./.moluoxixi/scripts/get_context.py --mode packages
cat .moluoxixi/spec/guides/index.md
cat .moluoxixi/spec/<package>/<layer>/index.md   # for each relevant layer
```

Index files list the specific guideline docs to read when you actually start coding.

## Step 4: Decide next action
From Step 1 you know the current task and status. Check the task directory:

- **Active task status `planning` + no `prd.md`** → Phase 1.1. Load the `brainstorm` skill.
- **Active task status `planning`** → read `task.json`. Persist `complexity.level` if unclassified. Lightweight tasks can be PRD-only; complex tasks need `design.md` + `implement.md` and curated sub-agent context. Manual mode uses `task.py start <task> --user-approved` only after review; auto mode must already contain explicit task-local user authorization.
- **Active task status `in_progress`** → Phase 2 step 2.1. Load the step detail:
  ```bash
  python ./.moluoxixi/scripts/get_context.py --mode phase --step 2.1 --platform codex
  ```
- **No active task** → classify first. For simple conversation / small task, ask only whether this turn should create a Moluoxixi task. For complex work, ask whether you may create a Moluoxixi task and enter planning. If the user says no, skip Moluoxixi for this session.

---

## Skill routing (quick reference)

| User intent | Skill |
|---|---|
| New feature / unclear requirements | `brainstorm` |
| About to write code | `before-dev` |
| Done coding / quality check | `check` |
| Stuck / fixed same bug multiple times | `break-loop` |
| Learned something worth capturing | `update-spec` |
| Review or govern pending knowledge | `spec-review` |

Full rules + anti-rationalization table in `.moluoxixi/workflow.md`.
