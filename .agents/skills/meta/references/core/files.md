# Moluoxixi File Reference

Complete reference of all files in the `.moluoxixi/` directory.

---

## Directory Structure

```
.moluoxixi/
├── .developer              # Developer identity (gitignored)
├── .runtime/               # Session-scoped runtime state (gitignored)
├── .current-task           # Legacy ignored pointer; not an active-task source
├── .ralph-state.json       # Ralph Loop state (gitignored)
├── airules-init-manifest.json # Managed-file ownership and template hashes
├── .version                # Installed Moluoxixi version
├── .gitignore              # Git ignore rules
├── workflow.md             # Main workflow documentation
├── worktree.yaml           # Multi-session configuration
│
├── workspace/              # Developer workspaces
├── tasks/                  # Task tracking
├── spec/                   # Coding guidelines
└── scripts/                # Automation scripts
```

---

## Root Files

### `.developer`

**Purpose**: Store current developer identity.

**Created by**: `init_developer.py`

**Format**: Plain text, single line with developer name.

```
taosu
```

**Gitignored**: Yes - each machine has its own identity.

---

### `.runtime/sessions/<session-key>.json`

**Purpose**: Store active task state for one AI session/window.

**Created by**: `task.py start <task-dir>`

**Format**: JSON runtime context.

```json
{
  "current_task": ".moluoxixi/tasks/01-31-add-login-taosu",
  "current_run": null,
  "platform": "claude",
  "last_seen_at": "2026-04-27T00:00:00Z"
}
```

**Gitignored**: Yes - each session/window has its own active task.

**Used by**:
- Hooks resolve this through `common.active_task`
- Scripts use this for active task operations

### `.current-task`

**Purpose**: Legacy ignored pointer from older Moluoxixi versions.

**Active-task behavior**: Not read or written as a fallback. Current Moluoxixi
uses `.runtime/sessions/<session-key>.json` only.

---

### `.ralph-state.json`

**Purpose**: Track Ralph Loop iteration state.

**Created by**: `ralph-loop.py` (Claude Code only)

**Format**: JSON

```json
{
  "task": ".moluoxixi/tasks/01-31-add-login",
  "iteration": 2,
  "started_at": "2026-01-31T10:30:00"
}
```

**Gitignored**: Yes - runtime state.

**Fields**:
| Field | Type | Description |
|-------|------|-------------|
| `task` | string | Task directory path |
| `iteration` | number | Current iteration (1-5) |
| `started_at` | ISO date | When loop started |

---

### `airules-init-manifest.json`

**Purpose**: Track AIRules-owned files and their installed template hashes.

**Created by**: the `init-project` skill and refreshed by the project-local updater.

**Format**: JSON manifest containing the initialized hosts and one ownership entry per managed path.

```json
{
  "platforms": ["claude", "codex"],
  "entries": {
    ".moluoxixi/workflow.md": {
      "baselineHash": "028891d1fe839a266...",
      "templateHash": "028891d1fe839a266..."
    }
  }
}
```

**Used by**:
- `node .moluoxixi/runtime/moluoxixi.mjs update` - Detect which files have been modified
- Determines if files can be auto-updated or need conflict resolution

**Behavior**:
- File hash matches template → Safe to update
- File hash differs → User modified, needs manual merge

---

### `.version`

**Purpose**: Track installed Moluoxixi CLI version.

**Created by**: the `init-project` skill or project-local updater.

**Format**: Plain text, semver version string.

```
0.3.0-beta.5
```

**Used by**:
- Project-local updater - Determine if update is needed
- Version mismatch detection

---

### `.gitignore`

**Purpose**: Define which files to exclude from git.

**Default content**:
```gitignore
# Developer identity (local only)
.developer

# Legacy current task pointer
.current-task

# Session runtime state
.runtime/

# Ralph Loop state
.ralph-state.json

# Agent runtime files
.agents/
.agent-log
.agent-runner.sh
.session-id

# Task directory runtime files
.plan-log

# Atomic update temp files
*.tmp
.backup-*
*.new

# Python cache
**/__pycache__/
**/*.pyc
```

---

### `workflow.md`

**Purpose**: Main workflow documentation for developers and AI.

**Created by**: the `init-project` skill

**Content sections**:
1. Quick Start guide
2. Workflow overview
3. Session start process
4. Development process
5. Session end
6. File descriptions
7. Best practices

**Injected by**: `session-start.py` hook (Claude Code)

**For Cursor**: Read manually at session start.

---

### `worktree.yaml`

**Purpose**: Configure Multi-Session and Ralph Loop.

**Created by**: the `init-project` skill

**Format**: YAML

```yaml
worktree_dir: ../worktrees
copy:
  - .moluoxixi/.developer
  - .env
post_create:
  - npm install
verify:
  - pnpm lint
  - pnpm typecheck
```

→ See `claude-code/worktree-config.md` for details.

---

## Runtime Files (Gitignored)

### `.agents/`

**Purpose**: Agent registry for Multi-Session.

**Location**: `.moluoxixi/workspace/{developer}/.agents/`

**Content**: `registry.json` tracking running agents.

---

### `.session-id`

**Purpose**: Store Claude Code session ID for resume.

**Created by**: Multi-Session `start.py`

**Format**: UUID string.

---

### `.agent-log`

**Purpose**: Agent execution log.

**Created by**: Multi-Session scripts.

---

### `.plan-log`

**Purpose**: Plan Agent execution log.

**Location**: Task directory.

---

## Directories

### `workspace/`

Developer workspaces with journals and indexes.

→ See `core/workspace.md`

### `tasks/`

Task directories with PRDs and session files.

→ See `core/tasks.md`

### `spec/`

Coding guidelines and specifications.

→ See `core/specs.md`

### `scripts/`

Automation scripts.

→ See `core/scripts.md` and `claude-code/scripts.md`

---

## Template Files

These files are managed by `node .moluoxixi/runtime/moluoxixi.mjs update`:

| File | Purpose |
|------|---------|
| `.moluoxixi/workflow.md` | Workflow documentation |
| `.moluoxixi/worktree.yaml` | Multi-session config |
| `.moluoxixi/.gitignore` | Git ignore rules |
| `.claude/hooks/*.py` | Hook scripts |
| `.claude/commands/*.md` | Slash commands |
| `.claude/agents/*.md` | Agent definitions |
| `.cursor/commands/*.md` | Cursor commands (mirror) |

**Update behavior**:
1. Compare the file hash with its `airules-init-manifest.json` ownership entry
2. If unchanged → Auto-update
3. If modified → Create `.new` file for manual merge
4. Update hashes after successful update

---

## File Lifecycle

### Created by the `init-project` skill

```
.moluoxixi/
├── airules-init-manifest.json
├── .version
├── .gitignore
├── workflow.md
├── worktree.yaml
├── spec/
│   ├── frontend/
│   ├── backend/
│   └── guides/
└── scripts/
```

### Created at runtime

```
.moluoxixi/
├── .developer           # init_developer.py
├── .runtime/sessions/   # task.py start
├── .current-task        # legacy ignored file, not active-task source
├── .ralph-state.json    # ralph-loop.py
├── workspace/{dev}/     # init_developer.py
│   ├── index.md
│   ├── journal-1.md
│   └── .agents/
└── tasks/{task}/        # task.py create
    ├── task.json
    ├── prd.md
    └── *.jsonl
```

### Cleaned up

```
# After task completion
.moluoxixi/tasks/{task}/ → .moluoxixi/tasks/archive/YYYY-MM/

# After worktree removal
.agents/registry.json entries removed
```
