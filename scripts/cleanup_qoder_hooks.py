from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


EVENTS = ("Stop", "PostToolUseFailure", "StopFailure")
ADAPTER_MARKER = "qoder_event_adapter.py"


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


def cleanup(config_path: Path) -> bool:
    try:
        original = config_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return False
    try:
        document: dict[str, Any] = json.loads(original)
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid Qoder settings JSON: {config_path}") from exc

    hooks = document.get("hooks")
    if not isinstance(hooks, dict):
        return False
    changed = False
    for event in EVENTS:
        entries = hooks.get(event)
        if not isinstance(entries, list):
            continue
        cleaned = [value for entry in entries if (value := _clean_entry(entry)) is not None]
        if cleaned != entries:
            changed = True
            if cleaned:
                hooks[event] = cleaned
            else:
                hooks.pop(event, None)
    if not hooks:
        document.pop("hooks", None)
    if changed:
        config_path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return changed


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    args = parser.parse_args()
    changed = cleanup(args.config)
    print("Removed legacy AI Monitor Qoder hooks." if changed else "No legacy AI Monitor Qoder hooks found.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
