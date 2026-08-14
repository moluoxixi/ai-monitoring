# Platform Detection Research

## Existing Boundaries

- Codex has notify, structured session watcher and App Server proxy.
- Claude Code and Qoder use lifecycle hooks; Desktop aliases alone do not prove monitoring support.
- Claude Desktop Cowork writes structured audit JSONL, but that watcher belongs to a separate implementation task.
- Qoder Quest logs are plain text without stable task IDs or final answers, so log scraping is not accepted as monitoring.
- Hermes v0.16.0 exposes official `on_session_finalize` / `on_session_end` hooks.
- Cursor has a version 1 hooks file with `stop`, `subagentStop` and `preToolUse`; the local `stop` command currently points to a missing script.

## Windows Signals

Use exact signals only: known process executable, PATH command, canonical config directory with a marker file, or canonical install path. Return signal enums rather than local paths. In containers, scanning describes the container and must not be presented as host detection.

## Local Findings

The current machine exposes Codex CLI, Codex Desktop processes, Claude Desktop, Qoder Desktop, Hermes CLI, Cursor configuration and their canonical state directories. Claude/Qoder/Cursor CLI commands are not currently available on PATH.
