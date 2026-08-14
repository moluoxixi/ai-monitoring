from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


# Current Cursor releases emit both afterAgentResponse and stop for one turn.
# Relay only stop so a completed task produces one notification.
EVENTS = ("stop", "postToolUseFailure")
CLEANUP_EVENTS = ("afterAgentResponse", *EVENTS)


def configure(config_path: Path, command: str) -> None:
    try:
        document: dict[str, Any] = json.loads(config_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        document = {"version": 1}
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid Cursor hooks JSON: {config_path}") from exc
    hooks = document.setdefault("hooks", {})
    if not isinstance(hooks, dict):
        raise ValueError("Cursor hooks must be an object")
    for event in CLEANUP_EVENTS:
        entries = hooks.setdefault(event, [])
        if not isinstance(entries, list):
            raise ValueError(f"Cursor hook section must be an array: {event}")
        entries[:] = [
            item
            for item in entries
            if not (isinstance(item, dict) and "cursor_event_adapter.py" in str(item.get("command", "")))
        ]
        commands = {
            str(item.get("command"))
            for item in entries
            if isinstance(item, dict) and item.get("type") == "command"
        }
        if event in EVENTS and command not in commands:
            entries.append({"type": "command", "command": command})
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
