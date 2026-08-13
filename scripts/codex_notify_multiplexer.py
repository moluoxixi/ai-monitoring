"""Fan out a Codex agent-turn-complete payload without coupling notify targets."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request
from pathlib import Path
from typing import Any

from dotenv import load_dotenv


ROOT = Path(__file__).resolve().parent.parent
TARGETS_PATH = ROOT / "data" / "codex-notify-targets.json"
load_dotenv(ROOT / ".env", override=False)


def load_targets() -> list[list[str]]:
    if not TARGETS_PATH.exists():
        return []
    document = json.loads(TARGETS_PATH.read_text(encoding="utf-8"))
    return [[str(argument) for argument in target] for target in document.get("targets", []) if target]


def relay_completion(payload: dict[str, Any]) -> None:
    thread_id = str(payload.get("thread-id") or payload.get("thread_id") or payload.get("threadId") or "unknown-thread")
    turn_id = str(payload.get("turn-id") or payload.get("turn_id") or payload.get("turnId") or "unknown-turn")
    event = {
        "source": "codex",
        "client": "codex-notify",
        "event_id": f"{thread_id}:{turn_id}:completed",
        "kind": "agent-turn-complete",
        "status": "completed",
        "title": "Codex task completed",
        "message": "Codex turn completed",
        "metadata": {"thread_id": thread_id, "turn_id": turn_id},
    }
    headers = {"Content-Type": "application/json"}
    token = os.getenv("AIMONITOR_INGEST_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        os.getenv("AIMONITOR_URL", "http://127.0.0.1:8787/api/events"),
        json.dumps(event).encode(),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=5):
        pass


def main() -> int:
    if len(sys.argv) < 2:
        return 0
    raw_payload = sys.argv[1]
    try:
        payload = json.loads(raw_payload)
    except json.JSONDecodeError:
        payload = {}

    for target in load_targets():
        try:
            subprocess.run([*target, raw_payload], check=False, timeout=30)
        except Exception as exc:
            print(f"Codex notify target failed ({target[0]}): {exc}", file=sys.stderr)

    if isinstance(payload, dict) and payload.get("type") == "agent-turn-complete":
        try:
            relay_completion(payload)
        except Exception as exc:
            print(f"AI monitor relay delivery failed: {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
