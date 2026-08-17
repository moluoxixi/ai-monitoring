# Continue Current Task

Resume work on the current task — pick up at the right phase/step in `.moluoxixi/workflow.md`.

---

## Step 1: Load Current Context

```bash
{{PYTHON_CMD}} ./.moluoxixi/scripts/get_context.py
```

Confirms: current task, git state, recent commits.

## Step 2: Load the Phase Index

```bash
{{PYTHON_CMD}} ./.moluoxixi/scripts/get_context.py --mode phase
```

Shows the Phase Index (Plan / Execute / Finish) with routing + skill mapping.

## Step 3: Decide Where You Are

`get_context.py` shows the active task. Read `task.json` and route by persisted `status`, `complexity.level`, and `executionApproval.mode`; do not guess complexity from artifact presence. This command does not itself approve implementation.

- `status=planning` + no `prd.md` → **1.1** (load `moluoxixi-brainstorm`)
- `status=planning` + `complexity.level=unclassified` → classify and run `task.py set-complexity`.
- `status=planning` + `complexity.level=lightweight` → PRD-only can move to **1.4** review.
- `status=planning` + `complexity.level=complex` + missing design/implementation artifacts → **1.1**.
- `status=planning` + complex artifacts complete + sub-agent jsonl not curated (only the seed `_example` row) → **1.3**.
- `status=planning` + required artifacts complete → **1.4**. Manual mode requires user confirmation and `task.py start <task> --user-approved`; task-local auto mode may use plain `start` only when explicit user authorization is already recorded.
- `status=in_progress` + implementation not started → **2.1**
- `status=in_progress` + a frontend/backend/database/test/security specialty is materially involved → dispatch only the relevant professional Agent(s), then continue to **2.2**.
- `status=in_progress` + implementation done, not yet checked → **2.2**
- `status=in_progress` + check passed → **3.3** (spec proposal + read-only governance audit) → **3.4** (commit)
- `status=completed` (rare; usually archived immediately) → archive flow

Phase rules (full detail in `.moluoxixi/workflow.md`):

1. Run steps **in order** within a phase — `[required]` steps must not be skipped
2. `[once]` steps are already done if the required output exists. `prd.md` alone can be enough only for lightweight tasks; complex tasks also need `design.md` and `implement.md`.
3. You may go back to an earlier phase if discoveries require it

## Step 4: Load the Specific Step

Once you know which step to resume at:

```bash
{{PYTHON_CMD}} ./.moluoxixi/scripts/get_context.py --mode phase --step <X.X> --platform {{CLI_FLAG}}
```

Follow the loaded instructions. After each `[required]` step completes, move to the next.

---

## Reference

Full workflow and detailed phase steps live in `.moluoxixi/workflow.md`. This command is only an entry point — the canonical guidance is there.
