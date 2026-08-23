#!/usr/bin/env python3
"""Inject bounded project knowledge context without performing organization."""

from __future__ import annotations

import argparse
import json
import os
import queue
import sys
import threading
from pathlib import Path
from typing import Any, Dict, Optional

from common.knowledge import load_context


def _read_input() -> Dict[str, Any]:
    result_queue: "queue.Queue[str | Exception]" = queue.Queue(maxsize=1)

    def read() -> None:
        try:
            result_queue.put(sys.stdin.read())
        except Exception as exc:
            result_queue.put(exc)

    threading.Thread(target=read, daemon=True).start()
    try:
        raw = result_queue.get(timeout=0.2)
    except queue.Empty:
        return {}
    if isinstance(raw, Exception):
        return {}
    try:
        value = json.loads(raw) if raw.strip() else {}
    except (json.JSONDecodeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _find_root(start: Path) -> Optional[Path]:
    current = start.resolve()
    while True:
        if (current / ".trellis" / "knowledge").is_dir():
            return current
        if current.parent == current:
            return None
        current = current.parent


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", required=True)
    parser.add_argument("--event", choices=("prompt", "session"), default="prompt")
    parser.add_argument("--airules-trellis-knowledge-hook", action="store_true")
    return parser


def main() -> int:
    args = _parser().parse_args()
    if os.environ.get("TRELLIS_HOOKS") == "0" or os.environ.get("TRELLIS_DISABLE_HOOKS") == "1":
        return 0
    data = _read_input()
    start = Path(str(data.get("cwd") or os.getcwd()))
    root = _find_root(start)
    if root is None:
        return 0
    context = load_context(root)
    if not context:
        return 0
    if args.platform == "kiro":
        print(context)
        return 0
    if args.platform == "cursor":
        print(json.dumps({"additional_context": context}, ensure_ascii=False))
        return 0
    if args.platform == "snow":
        print(json.dumps({
            "additionalContext": context,
            "display": "Trellis knowledge context refreshed",
        }, ensure_ascii=False))
        return 0
    event = "SessionStart" if args.event == "session" else (
        "BeforeAgent" if args.platform == "gemini" else "UserPromptSubmit"
    )
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": event,
            "additionalContext": context,
        }
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
