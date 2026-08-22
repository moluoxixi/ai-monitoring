"""Remove AI Monitor integrations or restore an explicit installation backup."""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path
from typing import Any, Callable, Collection, Mapping

if __package__:
    from .cleanup_qoder_hooks import cleanup as remove_qoder
    from .configure_claude_hooks import remove as remove_claude
    from .configure_codex_notify import remove as remove_codex
    from .configure_cursor_hooks import remove as remove_cursor
    from .configure_hermes_hooks import remove as remove_hermes
else:
    from cleanup_qoder_hooks import cleanup as remove_qoder
    from configure_claude_hooks import remove as remove_claude
    from configure_codex_notify import remove as remove_codex
    from configure_cursor_hooks import remove as remove_cursor
    from configure_hermes_hooks import remove as remove_hermes


MANIFEST_SCHEMA_VERSION = 1
MANAGED_BACKUP_FILES = {
    "codex-config": "codex-config.toml",
    "codex-notify-targets": "codex-notify-targets.json",
    "claude-settings": "claude-settings.json",
    "qoder-settings": "qoder-settings.json",
    "hermes-config": "hermes-config.yaml",
    "cursor-hooks": "cursor-hooks.json",
}
MANAGED_FILE_IDS = set(MANAGED_BACKUP_FILES)


def remove_integrations(
    *,
    codex_config: Path,
    codex_targets: Path,
    claude_config: Path,
    qoder_config: Path,
    hermes_config: Path,
    cursor_config: Path,
) -> dict[str, bool]:
    return {
        "codex": remove_codex(codex_config, codex_targets),
        "claude": remove_claude(claude_config),
        "qoder": remove_qoder(qoder_config),
        "hermes": remove_hermes(hermes_config),
        "cursor": remove_cursor(cursor_config),
    }


def _resolved_paths(paths: Collection[Path]) -> set[Path]:
    return {path.expanduser().resolve() for path in paths}


def _load_manifest(
    backup_dir: Path,
    expected_paths: Mapping[str, Collection[Path]],
) -> dict[str, dict[str, Any]]:
    manifest_path = backup_dir / "manifest.json"
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError as exc:
        raise ValueError(f"backup manifest not found: {manifest_path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid backup manifest JSON: {manifest_path}") from exc
    if not isinstance(payload, dict) or payload.get("schemaVersion") != MANIFEST_SCHEMA_VERSION:
        raise ValueError(f"unsupported backup manifest schema: {manifest_path}")
    files = payload.get("files")
    if not isinstance(files, list):
        raise ValueError(f"backup manifest files must be an array: {manifest_path}")

    entries: dict[str, dict[str, Any]] = {}
    for entry in files:
        if not isinstance(entry, dict):
            raise ValueError(f"invalid backup manifest entry: {manifest_path}")
        file_id = entry.get("id")
        if file_id not in MANAGED_FILE_IDS or file_id in entries:
            raise ValueError(f"invalid or duplicate backup file id: {file_id}")
        if not isinstance(entry.get("path"), str) or not entry["path"]:
            raise ValueError(f"backup entry has no path: {file_id}")
        if not isinstance(entry.get("existed"), bool):
            raise ValueError(f"backup entry has invalid existed flag: {file_id}")
        if entry.get("backupFile") != MANAGED_BACKUP_FILES[file_id]:
            raise ValueError(f"backup entry has an unexpected backup file: {file_id}")
        allowed_paths = expected_paths.get(file_id)
        if not allowed_paths or Path(entry["path"]).expanduser().resolve() not in _resolved_paths(allowed_paths):
            raise ValueError(f"backup entry targets an unexpected path: {file_id}")
        entries[file_id] = entry
    missing = MANAGED_FILE_IDS.difference(entries)
    if missing:
        raise ValueError(f"backup manifest is missing managed files: {', '.join(sorted(missing))}")
    return entries


def _entry_path(entry: dict[str, Any]) -> Path:
    return Path(entry["path"]).expanduser().resolve()


def _restore_file(backup_dir: Path, entry: dict[str, Any]) -> None:
    source = (backup_dir / entry["backupFile"]).resolve()
    resolved_backup_dir = backup_dir.resolve()
    if not source.is_relative_to(resolved_backup_dir):
        raise ValueError(f"backup file escapes its backup directory: {source}")
    if not source.is_file():
        raise ValueError(f"backup file not found: {source}")
    destination = _entry_path(entry)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f"{destination.name}.ai-monitor-restore.tmp")
    shutil.copy2(source, temporary)
    temporary.replace(destination)


def restore_backup(
    backup_dir: Path,
    expected_paths: Mapping[str, Collection[Path]],
) -> dict[str, str]:
    backup_dir = backup_dir.expanduser().resolve()
    entries = _load_manifest(backup_dir, expected_paths)
    for entry in entries.values():
        if not entry["existed"]:
            continue
        source = (backup_dir / entry["backupFile"]).resolve()
        if not source.is_relative_to(backup_dir) or not source.is_file():
            raise ValueError(f"backup file not found or outside its backup directory: {source}")
    results: dict[str, str] = {}

    codex_config = entries["codex-config"]
    codex_targets = entries["codex-notify-targets"]
    if codex_config["existed"]:
        _restore_file(backup_dir, codex_config)
        results["codex-config"] = "restored"
    else:
        changed = remove_codex(_entry_path(codex_config), _entry_path(codex_targets))
        results["codex-config"] = "removed-managed" if changed else "unchanged"
    if codex_targets["existed"]:
        _restore_file(backup_dir, codex_targets)
        results["codex-notify-targets"] = "restored"
    elif codex_config["existed"]:
        _entry_path(codex_targets).unlink(missing_ok=True)
        results["codex-notify-targets"] = "removed-generated"
    else:
        results["codex-notify-targets"] = "handled-with-codex"

    removers: dict[str, Callable[[Path], bool]] = {
        "claude-settings": remove_claude,
        "qoder-settings": remove_qoder,
        "hermes-config": remove_hermes,
        "cursor-hooks": remove_cursor,
    }
    for file_id, remover in removers.items():
        entry = entries[file_id]
        if entry["existed"]:
            _restore_file(backup_dir, entry)
            results[file_id] = "restored"
        else:
            results[file_id] = "removed-managed" if remover(_entry_path(entry)) else "unchanged"
    return results


def _add_remove_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--codex-config", type=Path, required=True)
    parser.add_argument("--codex-targets", type=Path, required=True)
    parser.add_argument("--claude-config", type=Path, required=True)
    parser.add_argument("--qoder-config", type=Path, required=True)
    parser.add_argument("--hermes-config", type=Path, required=True)
    parser.add_argument("--cursor-config", type=Path, required=True)


def _add_restore_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--codex-config", type=Path, required=True)
    parser.add_argument("--codex-targets", type=Path, required=True)
    parser.add_argument("--claude-config", type=Path, required=True)
    parser.add_argument("--qoder-config", type=Path, required=True)
    parser.add_argument("--hermes-config", type=Path, action="append", required=True)
    parser.add_argument("--cursor-config", type=Path, required=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    remove_parser = subparsers.add_parser("remove", help="remove only AI Monitor-managed entries")
    _add_remove_arguments(remove_parser)
    restore_parser = subparsers.add_parser("restore-backup", help="restore one explicit install backup")
    restore_parser.add_argument("--backup-dir", type=Path, required=True)
    _add_restore_arguments(restore_parser)
    args = parser.parse_args()

    if args.command == "restore-backup":
        results = restore_backup(args.backup_dir, {
            "codex-config": {args.codex_config},
            "codex-notify-targets": {args.codex_targets},
            "claude-settings": {args.claude_config},
            "qoder-settings": {args.qoder_config},
            "hermes-config": set(args.hermes_config),
            "cursor-hooks": {args.cursor_config},
        })
    else:
        results = remove_integrations(
            codex_config=args.codex_config,
            codex_targets=args.codex_targets,
            claude_config=args.claude_config,
            qoder_config=args.qoder_config,
            hermes_config=args.hermes_config,
            cursor_config=args.cursor_config,
        )
    for integration, result in results.items():
        print(f"{integration}: {result}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
