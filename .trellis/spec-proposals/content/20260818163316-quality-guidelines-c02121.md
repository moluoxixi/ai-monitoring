# Quality Guidelines

> Code quality standards for backend and infrastructure integration development.

## Scenario: Managed Integration Lifecycle

### 1. Scope / Trigger

Apply this contract when a script installs, updates, or removes hooks, notify commands,
plugins, or other entries inside user-owned configuration files.

### 2. Signatures

```powershell
.\scripts\install-hooks.ps1 [-ConfigureNotifications]
.\scripts\uninstall-hooks.ps1 -RemoveOnly [-SkipOpenClaw]
.\scripts\uninstall-hooks.ps1 -RestoreBackup -BackupPath <directory> [-SkipOpenClaw]
```

Each format-specific configurator exposes an idempotent removal function:

```python
def remove(config_path: Path, ...) -> bool:
    """Remove only managed entries and report whether the file changed."""
```

### 3. Contracts

- Every managed entry has a stable, product-owned identity such as an adapter filename,
  plugin ID plus package name, or another exact marker.
- `RemoveOnly` removes only matching entries and preserves unrelated settings, hooks,
  comments where the parser supports them, and files that contain user additions.
- Installation backups write a versioned `manifest.json` before configuration changes.
  Each entry records a fixed ID, expected backup filename, absolute original path, and
  whether the original file existed.
- `RestoreBackup` accepts an explicit backup directory. Manifest target paths must match
  caller-provided canonical paths; manifest content cannot select arbitrary destinations.
- External plugin removal validates both the registry ID and package ownership before
  mutation. Channel plugins and shared state are outside the reply-plugin removal scope.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Config or managed entry is absent | Successful no-op |
| Config syntax is invalid | Fail before writing that config |
| Current value no longer has the managed marker | Preserve it unchanged |
| Manifest schema, ID, filename, or target path is invalid | Fail before any restore write |
| Any required backup file is absent or escapes the backup directory | Fail during preflight before any restore write |
| Saved state cannot map losslessly to the native config shape | Fail closed; do not guess |
| Plugin ID matches but package ownership does not | Refuse to uninstall |
| Optional external runtime is unavailable | Detect before local configuration mutation, or require an explicit skip flag |

### 5. Good/Base/Bad Cases

- Good: remove one managed nested hook while retaining the other commands in that same entry.
- Base: a second uninstall reports no changes and exits successfully.
- Bad: restore a manifest-provided path without checking it against canonical targets.
- Bad: identify a managed hook through a broad product-name substring that can match user commands.

### 6. Tests Required

- Unit-test installation replacement and removal idempotency for every config format.
- Assert that mixed user/managed hook entries retain the user commands.
- Assert that a user-replaced notify value is not overwritten during removal.
- Assert that malformed, incomplete, path-escaping, and target-mismatched manifests fail
  before the first destination changes.
- Assert that plugin removal targets only the owned ID/package pair and never channel IDs.
- Include the new lifecycle tests in the repository's default test command.

### 7. Wrong vs Correct

#### Wrong

```python
entries[:] = [entry for entry in entries if "ai-monitor" not in str(entry)]
destination = Path(manifest_entry["path"])
shutil.copy2(backup_file, destination)
```

#### Correct

```python
managed = ADAPTER_MARKER in str(command).lower()
allowed = Path(manifest_entry["path"]).resolve() in canonical_paths[file_id]
if not allowed:
    raise ValueError(f"unexpected restore target: {file_id}")
```
