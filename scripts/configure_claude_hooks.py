"""Install one idempotent copy of the AI Monitor Claude hooks."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


EVENTS = ("Stop", "StopFailure", "PostToolUseFailure")


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
        entries[:] = [
            entry
            for entry in entries
            if not (
                isinstance(entry, dict)
                and any(
                    isinstance(item, dict) and "claude_event_adapter.py" in str(item.get("command", ""))
                    for item in (entry.get("hooks") or [])
                )
            )
        ]
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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--command", required=True)
    args = parser.parse_args()
    configure(args.config, args.command)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
