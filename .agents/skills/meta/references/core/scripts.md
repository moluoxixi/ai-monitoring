# Core Scripts

Platform-independent Python scripts for Moluoxixi automation.

---

## Overview

These scripts work on all platforms - they only read/write files and don't require Claude Code's hook system.

```
.moluoxixi/scripts/
├── common/                 # Shared utilities
│   ├── paths.py
│   ├── developer.py
│   ├── task_utils.py
│   ├── phase.py
│   └── git_context.py
│
├── init_developer.py       # Initialize developer
├── get_developer.py        # Get developer name
├── get_context.py          # Get session runtime
├── task.py                 # Task management CLI
└── add_session.py          # Record session
```

---

## Developer Scripts

### `init_developer.py`

Initialize developer identity.

```bash
python .moluoxixi/scripts/init_developer.py <name>
```

**Creates:**
- `.moluoxixi/.developer`
- `.moluoxixi/workspace/<name>/`
- `.moluoxixi/workspace/<name>/index.md`
- `.moluoxixi/workspace/<name>/journal-1.md`

---

### `get_developer.py`

Get current developer name.

```bash
python .moluoxixi/scripts/get_developer.py
# Output: taosu
```

**Exit codes:**
- `0` - Success
- `1` - Not initialized

---

## Context Scripts

### `get_context.py`

Get session runtime for AI consumption.

```bash
python .moluoxixi/scripts/get_context.py
```

**Output includes:**
- Developer identity
- Git status and recent commits
- Current task (if any)
- Workspace summary

---

### `add_session.py`

Record session entry to journal.

```bash
python .moluoxixi/scripts/add_session.py "Session summary"
```

**Actions:**
1. Appends to current journal
2. Updates index markers
3. Rotates journal if needed

---

## Task Scripts

### `task.py`

Task management CLI.

#### Create Task

```bash
python .moluoxixi/scripts/task.py create "Task name" --slug task-slug
```

**Options:**
- `--slug` - URL-safe identifier
- `--assignee` - Developer name (default: current)
- `--type` - Dev type: frontend, backend, fullstack

#### List Tasks

```bash
python .moluoxixi/scripts/task.py list
```

**Output:**
```
Active Tasks:
  01-31-add-login-taosu (active)
  01-30-fix-api-cursor-agent (paused)
```

#### Start Task

```bash
python .moluoxixi/scripts/task.py start <task-dir>
```

Sets the active task in `.moluoxixi/.runtime/sessions/<session-key>.json`.
Without a session identity or `MOLUOXIXI_CONTEXT_ID`, this command fails and
does not create `.moluoxixi/.current-task`.

#### Finish Task

```bash
python .moluoxixi/scripts/task.py finish
```

Clears the active task for the current session runtime only.

#### Initialize Context

```bash
python .moluoxixi/scripts/task.py init-context <task-dir> <dev-type>
```

**Dev types:** `frontend`, `backend`, `fullstack`

Creates JSONL files with appropriate spec references.

#### Set Branch

```bash
python .moluoxixi/scripts/task.py set-branch <task-dir> <branch-name>
```

Updates `branch` field in task.json.

#### Archive Task

```bash
python .moluoxixi/scripts/task.py archive <task-dir>
```

Moves task to `.moluoxixi/tasks/archive/YYYY-MM/`.

#### List Archive

```bash
python .moluoxixi/scripts/task.py list-archive [month]
```

---

## Common Utilities

### `common/paths.py`

Path constants and utilities.

```python
from common.paths import (
    MOLUOXIXI_DIR,      # .moluoxixi/
    WORKSPACE_DIR,    # .moluoxixi/workspace/
    TASKS_DIR,        # .moluoxixi/tasks/
    SPEC_DIR,         # .moluoxixi/spec/
)
```

### `common/developer.py`

Developer management.

```python
from common.developer import (
    get_developer,     # Get current developer name
    get_workspace_dir, # Get developer's workspace directory
)
```

### `common/task_utils.py`

Task lookup functions.

```python
from common.task_utils import (
    get_current_task,  # Get active task directory
    load_task_json,    # Load task.json
    save_task_json,    # Save task.json
)
```

### `common/phase.py`

Phase tracking.

```python
from common.phase import (
    get_current_phase,  # Get current phase number
    advance_phase,      # Move to next phase
)
```

### `common/git_context.py`

Git context generation.

```python
from common.git_context import (
    get_git_status,     # Get git status
    get_recent_commits, # Get recent commit messages
    get_branch_name,    # Get current branch
)
```

---

## Usage Examples

### Initialize New Developer

```bash
cd /path/to/project
python .moluoxixi/scripts/init_developer.py john-doe
```

### Create and Start Task

```bash
# Create task
python .moluoxixi/scripts/task.py create "Add user login" --slug add-login

# Initialize context for fullstack work
python .moluoxixi/scripts/task.py init-context \
  .moluoxixi/tasks/01-31-add-login-john-doe fullstack

# Start task
python .moluoxixi/scripts/task.py start \
  .moluoxixi/tasks/01-31-add-login-john-doe
```

### Record Session

```bash
python .moluoxixi/scripts/add_session.py "Implemented login form, pending API integration"
```

### Archive Completed Task

```bash
python .moluoxixi/scripts/task.py archive \
  .moluoxixi/tasks/01-31-add-login-john-doe
```
