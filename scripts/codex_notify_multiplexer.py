"""Fan out a Codex agent-turn-complete payload without coupling notify targets."""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from scripts.codex_session_identity import is_subagent_session, session_kind


ROOT = Path(__file__).resolve().parent.parent
TARGETS_PATH = ROOT / "data" / "codex-notify-targets.json"
load_dotenv(ROOT / ".env", override=False)


def summarize_task(value: Any) -> str:
    messages = value if isinstance(value, list) else [value]
    text = next((item for item in messages if isinstance(item, str) and item.strip()), "")
    text = re.sub(r"<in-app-browser-context\b[^>]*>[\s\S]*?</in-app-browser-context>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"##\s*My request:\s*", " ", text, flags=re.IGNORECASE)
    summary = " ".join(text.split()).strip()
    if re.match(r"^The following is the Codex agent history whose request action you are assessing\.", summary, flags=re.IGNORECASE):
        return ""
    if len(summary) > 2_000:
        summary = summary[:1_997].rstrip() + "..."
    return summary


def answer_source(value: Any) -> str:
    return value[-24_000:] if isinstance(value, str) else ""


def payload_thread_id(payload: dict[str, Any]) -> str:
    return str(payload.get("thread-id") or payload.get("thread_id") or payload.get("threadId") or "unknown-thread")


def load_targets() -> list[list[str]]:
    if not TARGETS_PATH.exists():
        return []
    document = json.loads(TARGETS_PATH.read_text(encoding="utf-8"))
    return [[str(argument) for argument in target] for target in document.get("targets", []) if target]


def relay_completion(payload: dict[str, Any]) -> bool:
    thread_id = payload_thread_id(payload)
    turn_id = str(payload.get("turn-id") or payload.get("turn_id") or payload.get("turnId") or "unknown-turn")
    kind = session_kind(thread_id)
    if is_subagent_session(thread_id) or kind == "codex-desktop":
        return False
    task_summary = summarize_task(payload.get("input-messages") or payload.get("input_messages"))
    if not task_summary:
        return False
    event = {
        "source": "codex",
        "client": "codex-cli" if kind in (None, "codex-cli") else kind,
        "event_id": f"{thread_id}:{turn_id}:completed",
        "kind": "agent-turn-complete",
        "status": "completed",
        "title": "Codex task completed",
        "message": f"提问：{task_summary}" if task_summary else "Codex turn completed",
        "metadata": {
            "thread_id": thread_id,
            "turn_id": turn_id,
            **({"task_summary": task_summary} if task_summary else {}),
            **(
                {"answer_source": answer_source(payload.get("last-assistant-message"))}
                if answer_source(payload.get("last-assistant-message"))
                else {}
            ),
        },
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
    return True


def main() -> int:
    if len(sys.argv) < 2:
        return 0
    raw_payload = sys.argv[1]
    try:
        payload = json.loads(raw_payload)
    except json.JSONDecodeError:
        payload = {}

    is_completion = isinstance(payload, dict) and payload.get("type") == "agent-turn-complete"
    thread_kind = session_kind(payload_thread_id(payload)) if is_completion else None
    is_suppressed = is_completion and (is_subagent_session(payload_thread_id(payload)) or thread_kind == "codex-desktop")
    if not is_suppressed:
        for target in load_targets():
            try:
                subprocess.run([*target, raw_payload], check=False, timeout=30)
            except Exception as exc:
                print(f"Codex notify target failed ({target[0]}): {exc}", file=sys.stderr)

    if is_completion and not is_suppressed:
        try:
            relay_completion(payload)
        except Exception as exc:
            print(f"AI monitor relay delivery failed: {exc}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
