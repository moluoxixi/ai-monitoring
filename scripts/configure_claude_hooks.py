"""Install one idempotent copy of the AI Monitor Claude hooks."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


EVENTS = ("Stop", "StopFailure", "PostToolUseFailure")
ADAPTER_MARKER = "claude_event_adapter.py"


def _is_monitor_command(value: object) -> bool:
    return ADAPTER_MARKER in str(value or "").lower()


def _clean_entry(entry: object) -> object | None:
    if not isinstance(entry, dict):
        return entry
    if entry.get("type") == "command" and _is_monitor_command(entry.get("command")):
        return None
    nested = entry.get("hooks")
    if not isinstance(nested, list):
        return entry
    cleaned = [
        hook
        for hook in nested
        if not (
            isinstance(hook, dict)
            and hook.get("type") == "command"
            and _is_monitor_command(hook.get("command"))
        )
    ]
    if not cleaned:
        return None
    result = dict(entry)
    result["hooks"] = cleaned
    return result


def configure(config_path: Path, command: str) -> None:
    try:
        document: dict[str, Any] = json.loads(config_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        document = {}
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid Claude settings JSON: {config_path}") from exc
    hooks = document.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise ValueError("Claude hooks must be an object")
    for event in EVENTS:
        entries = hooks.setdefault(event, [])
        if not isinstance(entries, list):
            raise ValueError(f"Claude hook section must be an array: {event}")
        entries[:] = [value for entry in entries if (value := _clean_entry(entry)) is not None]
        commands = {
            str(item.get("command"))
            for entry in entries
            if isinstance(entry, dict)
            for item in (entry.get("hooks") or [])
            if isinstance(item, dict) and item.get("type") == "command"
        }
        if command not in commands:
            entries.append({"hooks": [{"type": "command", "command": command}]})
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def remove(config_path: Path) -> bool:
    try:
        document: dict[str, Any] = json.loads(config_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return False
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid Claude settings JSON: {config_path}") from exc
    hooks = document.get("hooks")
    if not isinstance(hooks, dict):
        return False
    changed = False
    for event in EVENTS:
        entries = hooks.get(event)
        if not isinstance(entries, list):
            continue
        cleaned = [value for entry in entries if (value := _clean_entry(entry)) is not None]
        if cleaned == entries:
            continue
        changed = True
        if cleaned:
            hooks[event] = cleaned
        else:
            hooks.pop(event, None)
    if not changed:
        return False
    if not hooks:
        document.pop("hooks", None)
    config_path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--command", required=True)
    args = parser.parse_args()
    configure(args.config, args.command)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
