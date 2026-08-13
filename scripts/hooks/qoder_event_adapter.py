"""Forward Qoder CLI lifecycle hooks to the local notification relay."""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

from dotenv import load_dotenv


RELAY_EVENTS = {"Stop", "StopFailure", "PostToolUseFailure"}
load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=False)


def _text(value: object, limit: int = 2_000) -> str:
    if isinstance(value, dict):
        value = value.get("message") or value.get("error") or value.get("type") or ""
    return str(value or "")[:limit]


def main() -> int:
    raw = sys.stdin.read().strip()
    if not raw:
        return 0
    try:
        item = json.loads(raw)
    except json.JSONDecodeError:
        return 0
    if not isinstance(item, dict):
        return 0
    name = str(item.get("hook_event_name") or item.get("event") or "unknown")
    if name not in RELAY_EVENTS:
        return 0
    status = "completed" if name == "Stop" else "failed"
    session_id = str(item.get("session_id") or item.get("sessionId") or "unknown-session")
    turn_id = str(item.get("turn_id") or item.get("turnId") or item.get("tool_use_id") or "unknown-turn")
    event_id = str(item.get("event_id") or item.get("eventId") or f"{session_id}:{name}:{turn_id}")
    error = _text(item.get("error") or item.get("error_details") or item.get("error_type"))
    message = _text(item.get("message") or error or item.get("stop_reason") or name)
    event = {
        "source": "qoder",
        "client": "qoder",
        "event_id": event_id,
        "kind": name,
        "status": status,
        "title": f"Qoder {name}",
        "message": message,
        "error_code": _text(item.get("error_type") or (error if status == "failed" else ""), 200) or None,
        "metadata": {"session_id": session_id, "turn_id": turn_id},
    }
    return post(event)


def post(event: dict[str, object]) -> int:
    url = os.getenv("AIMONITOR_URL", "http://127.0.0.1:8787/api/events")
    headers = {"Content-Type": "application/json"}
    token = os.getenv("AIMONITOR_INGEST_TOKEN")
    if token:
        headers["Authorization"] = "Bearer " + token
    try:
        request = urllib.request.Request(url, data=json.dumps(event).encode(), headers=headers, method="POST")
        with urllib.request.urlopen(request, timeout=5):
            pass
    except Exception as exc:
        print(f"AI monitor relay delivery failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
