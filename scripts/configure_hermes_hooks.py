"""Install the AI Monitor observer hooks into Hermes' YAML configuration."""
from __future__ import annotations

import argparse
import os
from pathlib import Path

import yaml


EVENTS = ("on_session_end", "api_request_error")
ADAPTER_MARKER = "hermes_event_adapter.py"


def _is_monitor_command(value: object) -> bool:
    return ADAPTER_MARKER in str(value or "").lower()


def _write_document(config_path: Path, document: dict[object, object]) -> None:
    config_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = config_path.with_suffix(config_path.suffix + ".tmp")
    temporary.write_text(yaml.safe_dump(document, allow_unicode=True, sort_keys=False), encoding="utf-8")
    temporary.replace(config_path)


def default_config_path() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA", "").strip()
    if local_app_data:
        return Path(local_app_data) / "hermes" / "config.yaml"
    return Path.home() / ".hermes" / "config.yaml"


def configure(config_path: Path, command: str) -> bool:
    document = yaml.safe_load(config_path.read_text(encoding="utf-8")) if config_path.exists() else {}
    if not isinstance(document, dict):
        document = {}
    hooks = document.get("hooks")
    if not isinstance(hooks, dict):
        hooks = {}
    changed = False
    for event in EVENTS:
        entries = hooks.get(event)
        if not isinstance(entries, list):
            entries = []
        filtered = [
            entry
            for entry in entries
            if not (isinstance(entry, dict) and _is_monitor_command(entry.get("command")))
        ]
        desired = {"command": command, "timeout": 10}
        if desired not in filtered:
            filtered.append(desired)
        if filtered != entries:
            hooks[event] = filtered
            changed = True
    if document.get("hooks") != hooks:
        document["hooks"] = hooks
        changed = True
    if changed:
        _write_document(config_path, document)
    return changed


def remove(config_path: Path) -> bool:
    try:
        document = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return False
    except yaml.YAMLError as exc:
        raise ValueError(f"invalid Hermes config YAML: {config_path}") from exc
    if not isinstance(document, dict):
        return False
    hooks = document.get("hooks")
    if not isinstance(hooks, dict):
        return False
    changed = False
    for event in EVENTS:
        entries = hooks.get(event)
        if not isinstance(entries, list):
            continue
        filtered = [
            entry
            for entry in entries
            if not (isinstance(entry, dict) and _is_monitor_command(entry.get("command")))
        ]
        if filtered == entries:
            continue
        changed = True
        if filtered:
            hooks[event] = filtered
        else:
            hooks.pop(event, None)
    if not changed:
        return False
    if not hooks:
        document.pop("hooks", None)
    _write_document(config_path, document)
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=default_config_path())
    parser.add_argument("--command", required=True)
    args = parser.parse_args()
    configure(args.config, args.command)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
