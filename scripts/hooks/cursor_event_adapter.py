"""Forward Cursor lifecycle hook payloads to the local notification relay."""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.request
import uuid
from pathlib import Path

from dotenv import load_dotenv


RELAY_EVENTS = {"stop", "postToolUseFailure"}
load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=False)


def _text(value: object, limit: int = 24_000) -> str:
    if isinstance(value, dict):
        value = value.get("text") or value.get("message") or value.get("error_message") or value.get("error") or value.get("content") or ""
    if isinstance(value, list):
        value = "\n".join(_text(item, limit) for item in value)
    return str(value or "").strip()[:limit]


def _first(item: dict[str, object], keys: tuple[str, ...], limit: int) -> str:
    for key in keys:
        value = _text(item.get(key), limit)
        if value:
            return value
    return ""


def _transcript_text(value: object) -> str:
    if isinstance(value, dict):
        value = value.get("text") or value.get("content") or value.get("message") or ""
    if isinstance(value, list):
        return "\n".join(_transcript_text(part) for part in value)
    return str(value or "").strip()


def _read_transcript(path_value: object) -> tuple[str, str]:
    """Read only the latest user/assistant text from Cursor's hook transcript."""
    path = _text(path_value, 1_000)
    if not path:
        return "", ""
    try:
        source = Path(path)
        if not source.is_file() or source.stat().st_size > 8 * 1024 * 1024:
            return "", ""
        user_text = ""
        assistant_text = ""
        for line in source.read_text(encoding="utf-8", errors="replace").splitlines():
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(record, dict):
                continue
            role = record.get("role")
            text = _transcript_text(record.get("message"))
            if role == "user" and text:
                match = re.search(r"<user_query>\s*([\s\S]*?)\s*</user_query>", text, flags=re.IGNORECASE)
                user_text = (match.group(1) if match else text).strip()
            elif role == "assistant" and text:
                assistant_text = text
        return user_text, assistant_text
    except (OSError, UnicodeError):
        return "", ""


def _post(event: dict[str, object]) -> int:
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


def _runtime_argument() -> str:
    for index, argument in enumerate(sys.argv):
        if argument == "--runtime" and index + 1 < len(sys.argv):
            return sys.argv[index + 1]
    return ""


def main() -> int:
    raw = sys.stdin.read().lstrip("\ufeff").strip()
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

    failed = name == "postToolUseFailure"
    session_id = _first(item, ("session_id", "sessionId", "conversation_id", "conversationId"), 200) or "unknown-session"
    turn_id = _first(item, ("turn_id", "turnId", "generation_id", "generationId", "request_id", "requestId", "timestamp"), 200) or uuid.uuid4().hex
    summary = _first(item, ("task_summary", "user_prompt", "prompt", "input"), 2_000)
    answer = _first(item, ("last_assistant_message", "assistant_message", "response", "result", "output", "text"), 24_000)
    transcript_summary, transcript_answer = _read_transcript(item.get("transcript_path"))
    summary = summary or transcript_summary
    answer = answer or transcript_answer
    failure = _first(item, ("error_message", "error", "message"), 24_000)
    requested_client = _runtime_argument().lower() or _first(item, ("client", "platform", "runtime"), 80).lower()
    if not requested_client:
        requested_client = os.getenv("CURSOR_RUNTIME", "").strip().lower()
    if "cli" in requested_client:
        client = "cursor-cli"
    elif "desktop" in requested_client:
        client = "cursor-desktop"
    else:
        # A shared hook without a runtime assertion must never be guessed as
        # Desktop (or CLI). The dedicated runtime watcher/config must assert it.
        return 0
    status = "tool_failed" if failed else "completed"
    message = failure if failed else "Cursor task completed"
    event = {
        "source": "cursor",
        "client": client,
        "event_id": str(item.get("event_id") or f"{session_id}:{name}:{turn_id}"),
        "kind": name,
        "status": status,
        "title": f"Cursor {'task failed' if failed else 'task completed'}",
        "message": message,
        "error_code": _first(item, ("error_code", "error_type"), 200) if failed else None,
        "metadata": {
            "session_id": session_id,
            "turn_id": turn_id,
            "hook_event_name": name,
            **({"task_summary": summary} if summary else {}),
            **({"answer_source": answer} if answer and not failed else {}),
            **({"failure_message": failure} if failure and failed else {}),
            **({"notification_state": "diagnostic"} if failed else {}),
        },
    }
    return _post(event)


if __name__ == "__main__":
    raise SystemExit(main())
