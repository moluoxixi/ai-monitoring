"""Forward one Claude lifecycle event to the local Apprise relay."""
from __future__ import annotations
import json
import os
import sys
import urllib.request
import uuid
from pathlib import Path

from dotenv import load_dotenv


RELAY_EVENTS = {"Stop", "StopFailure", "PostToolUseFailure"}
load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=False)


def _text(value: object, limit: int = 2_000) -> str:
    if isinstance(value, dict):
        value = value.get("message") or value.get("type") or ""
    return str(value or "")[:limit]

def _summary(item: dict) -> str:
    return _text(item.get("task_summary") or item.get("user_prompt") or item.get("prompt"), 160)

def _content_text(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(filter(None, (_content_text(part) for part in value)))
    if isinstance(value, dict):
        if value.get("type") == "text" and isinstance(value.get("text"), str):
            return value["text"]
        for key in ("content", "text", "message"):
            text = _content_text(value.get(key))
            if text:
                return text
    return ""

def _transcript_answer(value: object) -> str:
    if not isinstance(value, str):
        return ""
    path = Path(value)
    if path.suffix.lower() != ".jsonl" or not path.is_file():
        return ""
    answer = ""
    try:
        with path.open("r", encoding="utf-8") as transcript:
            for line in transcript:
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(record, dict) or record.get("type") != "assistant":
                    continue
                message = record.get("message")
                if not isinstance(message, dict) or message.get("role") != "assistant":
                    continue
                text = _content_text(message.get("content")).strip()
                if text:
                    answer = text[-24_000:]
    except OSError:
        return ""
    return answer

def _assistant_answer(item: dict) -> str:
    for key in ("last_assistant_message", "last-assistant-message", "lastAssistantMessage", "assistant_message", "assistantMessage"):
        value = item.get(key)
        text = _content_text(value).strip()
        if text:
            return text[-24_000:]
    return _transcript_answer(item.get("transcript_path"))

def _turn_id(item: dict) -> str:
    value = item.get("turn_id") or item.get("tool_use_id") or item.get("uuid") or item.get("timestamp")
    return str(value) if value else f"hook-{uuid.uuid4().hex}"

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
    status = "failed" if name != "Stop" else "completed"
    session_id = str(item.get("session_id") or item.get("agent_id") or "unknown-session")
    turn_id = _turn_id(item)
    event_id = str(item.get("event_id") or f"{session_id}:{name}:{turn_id}")
    error = _text(item.get("error") or item.get("error_details"))
    message = _text(item.get("message") or error or item.get("stop_reason") or name)
    task_summary = _summary(item)
    assistant_answer = _assistant_answer(item) if status == "completed" else ""
    event = {
        "source": "claude",
        "client": "claude-code",
        "event_id": event_id,
        "kind": name,
        "status": status,
        "title": f"Claude {name}",
        "message": message,
        "error_code": _text(item.get("error_code") or (error if status == "failed" else ""), 200) or None,
        "metadata": {
            "session_id": session_id,
            "turn_id": turn_id,
            **({"task_summary": task_summary} if task_summary else {}),
            **({"answer_source": assistant_answer} if assistant_answer else {}),
        },
    }
    return post(event)


def post(event: dict) -> int:
    url = os.getenv("AIMONITOR_URL", "http://127.0.0.1:8787/api/events")
    data = json.dumps(event).encode()
    headers = {"Content-Type":"application/json"}
    token = os.getenv("AIMONITOR_INGEST_TOKEN")
    if token: headers["Authorization"] = "Bearer " + token
    try:
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=5):
            pass
    except Exception as exc:
        print(f"AI monitor relay delivery failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
