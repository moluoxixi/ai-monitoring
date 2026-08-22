"""Forward one Claude lifecycle event to the local Apprise relay."""
from __future__ import annotations
import json
import os
import sys
import time
import urllib.request
import uuid
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


RELAY_EVENTS = {"Stop", "StopFailure", "PostToolUseFailure"}
load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=False)


@dataclass(frozen=True)
class TranscriptProjection:
    summary: str = ""
    answer: str = ""
    desktop_transcript: bool = False
    terminal_id: str = ""
    error_id: str = ""


def _text(value: object, limit: int = 24_000) -> str:
    if isinstance(value, dict):
        value = value.get("message") or value.get("type") or ""
    return str(value or "")[:limit]

def _summary(item: dict) -> str:
    return _text(item.get("task_summary") or item.get("user_prompt") or item.get("prompt"), 2_000)

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


def _transcript_path(item: dict) -> Path | None:
    value = item.get("transcript_path") or item.get("transcriptPath")
    if isinstance(value, str):
        path = Path(value)
        if path.suffix.lower() == ".jsonl" and path.is_file():
            return path
    session_id = str(item.get("session_id") or item.get("agent_id") or "").strip()
    if not session_id or any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_." for character in session_id):
        return None
    projects_root = Path.home() / ".claude" / "projects"
    try:
        for project in projects_root.iterdir():
            candidate = project / f"{session_id}.jsonl"
            if project.is_dir() and candidate.is_file():
                return candidate
    except OSError:
        return None
    return None

def _transcript_context(value: object) -> TranscriptProjection:
    if not isinstance(value, str):
        return TranscriptProjection()
    path = Path(value)
    if path.suffix.lower() != ".jsonl" or not path.is_file():
        return TranscriptProjection()
    summary = ""
    answer = ""
    desktop_transcript = False
    terminal_id = ""
    error_id = ""
    try:
        with path.open("r", encoding="utf-8") as transcript:
            for line in transcript:
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(record, dict):
                    continue
                if record.get("isSidechain") is True:
                    continue
                if record.get("entrypoint") == "claude-desktop-3p":
                    desktop_transcript = True
                if record.get("type") == "user":
                    # Claude Code writes tool results as user-shaped records. They
                    # are not prompts and must never replace the task summary.
                    if any(record.get(key) is True for key in ("isReplay", "is_replay", "isSynthetic", "is_synthetic")):
                        continue
                    if record.get("tool_use_result") is not None or record.get("parent_tool_use_id"):
                        continue
                    message = record.get("message")
                    if isinstance(message, dict) and message.get("role") == "user":
                        text = _content_text(message.get("content")).strip()
                        if text:
                            summary = text[-2_000:]
                            answer = ""
                            terminal_id = ""
                            error_id = ""
                    continue
                if record.get("type") == "system" and record.get("subtype") == "api_error":
                    stable_error_id = str(record.get("uuid") or "").strip()
                    if stable_error_id:
                        error_id = stable_error_id
                        answer = ""
                    continue
                if record.get("type") != "assistant":
                    continue
                message = record.get("message")
                if not isinstance(message, dict) or message.get("role") != "assistant":
                    continue
                text = _content_text(message.get("content")).strip()
                if text:
                    answer = text[-24_000:]
                if str(message.get("stop_reason") or "").lower() == "end_turn":
                    stable_terminal_id = str(message.get("id") or record.get("uuid") or "").strip()
                    if stable_terminal_id and answer:
                        terminal_id = stable_terminal_id
                        error_id = ""
    except OSError:
        return TranscriptProjection()
    return TranscriptProjection(summary, answer, desktop_transcript, terminal_id, error_id)


def _transcript_context_retry(value: object, event_name: str, expected_error_ids: set[str]) -> TranscriptProjection:
    if not isinstance(value, str) or not Path(value).is_file():
        return _transcript_context(value)
    for attempt in range(5):
        projection = _transcript_context(value)
        ready = projection.summary and projection.answer
        if projection.desktop_transcript:
            if event_name == "Stop":
                ready = bool(projection.terminal_id and projection.answer)
            elif event_name == "StopFailure":
                ready = bool(projection.error_id and projection.error_id in expected_error_ids)
            else:
                ready = True
        if ready or attempt == 4:
            return projection
        time.sleep(0.1)
    return TranscriptProjection()

def _assistant_answer(item: dict) -> str:
    for key in ("last_assistant_message", "last-assistant-message", "lastAssistantMessage", "assistant_message", "assistantMessage"):
        value = item.get(key)
        text = _content_text(value).strip()
        if text:
            return text[-24_000:]
    return ""

def _turn_id(item: dict) -> str:
    value = item.get("turn_id") or item.get("tool_use_id") or item.get("uuid") or item.get("timestamp")
    return str(value) if value else f"hook-{uuid.uuid4().hex}"


def _explicit_turn_ids(item: dict) -> set[str]:
    return {
        str(value).strip()
        for key in ("turn_id", "tool_use_id", "uuid", "timestamp")
        if (value := item.get(key)) is not None and str(value).strip()
    }


def _desktop_terminal_event_id(kind: str, stable_id: str, status: str) -> str:
    return f"claude-desktop:{kind}:{stable_id}:{status}"

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
    status = "tool_failed" if name == "PostToolUseFailure" else "failed" if name != "Stop" else "completed"
    session_id = str(item.get("session_id") or item.get("agent_id") or "unknown-session")
    error = _text(item.get("error") or item.get("error_details"))
    task_summary = _summary(item)
    transcript_path = _transcript_path(item)
    explicit_turn_ids = _explicit_turn_ids(item)
    transcript = _transcript_context_retry(
        str(transcript_path) if transcript_path else None,
        name,
        explicit_turn_ids,
    )
    if not task_summary:
        task_summary = transcript.summary

    desktop = transcript.desktop_transcript
    source = "claude-desktop" if desktop else "claude"
    client = "claude-desktop" if desktop else "claude-cli"
    if desktop and name == "Stop":
        if not transcript.terminal_id:
            return 0
        turn_id = transcript.terminal_id
        event_id = _desktop_terminal_event_id("assistant", turn_id, "completed")
        title = "Claude Desktop task completed"
        message = title
    elif desktop and name == "StopFailure":
        if not transcript.error_id or transcript.error_id not in explicit_turn_ids:
            return 0
        turn_id = transcript.error_id
        event_id = _desktop_terminal_event_id("system", turn_id, "failed")
        title = "Claude Desktop task failed"
        message = _text(item.get("message") or error or title)
    else:
        turn_id = _turn_id(item)
        event_id = str(item.get("event_id") or f"{session_id}:{name}:{turn_id}")
        title = f"Claude Desktop {name}" if desktop else f"Claude {name}"
        message = _text(item.get("message") or error or item.get("stop_reason") or name)

    assistant_answer = ""
    if status == "completed":
        assistant_answer = _assistant_answer(item) or transcript.answer
    event = {
        "source": source,
        "client": client,
        "event_id": event_id,
        "kind": name,
        "status": status,
        "title": title,
        "message": message,
        "error_code": _text(item.get("error_code") or (error if status in {"failed", "tool_failed"} else ""), 200) or None,
        "metadata": {
            "session_id": session_id,
            "turn_id": turn_id,
            **({"task_summary": task_summary} if task_summary else {}),
            **({"answer_source": assistant_answer} if assistant_answer else {}),
            **({"notification_state": "diagnostic"} if status == "tool_failed" else {}),
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
