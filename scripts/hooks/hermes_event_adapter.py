"""Forward Hermes observer shell hooks to the local notification relay."""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
import urllib.request
import uuid
from pathlib import Path

from dotenv import load_dotenv


RELAY_EVENTS = {"on_session_end", "api_request_error"}
load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=False)


def _text(value: object, limit: int = 24_000) -> str:
    if isinstance(value, dict):
        value = value.get("message") or value.get("error_message") or value.get("type") or ""
    return str(value or "").strip()[:limit]


def _mapping(value: object) -> dict[str, object]:
    return value if isinstance(value, dict) else {}


def _hermes_home() -> Path:
    configured = os.getenv("HERMES_HOME", "").strip()
    if configured:
        return Path(configured).expanduser()
    local_app_data = os.getenv("LOCALAPPDATA", "").strip()
    if local_app_data:
        return Path(local_app_data) / "hermes"
    return Path.home() / ".hermes"


def _session_messages(session_id: str) -> tuple[str, str]:
    database = _hermes_home() / "state.db"
    if not database.is_file() or not session_id or session_id == "unknown-session":
        return "", ""
    for attempt in range(5):
        try:
            connection = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True, timeout=1)
            try:
                rows = connection.execute(
                    """
                    SELECT role, content
                    FROM messages
                    WHERE session_id = ? AND active = 1 AND role IN ('user', 'assistant')
                    ORDER BY id DESC
                    """,
                    (session_id,),
                ).fetchall()
            finally:
                connection.close()
            prompt = ""
            answer = ""
            for role, content in rows:
                if role == "assistant" and not answer:
                    answer = _text(content)
                elif role == "user":
                    prompt = _text(content, 2_000)
                    break
            if prompt or answer or attempt == 4:
                return prompt, answer
        except (OSError, sqlite3.Error):
            if attempt == 4:
                return "", ""
        time.sleep(0.1)
    return "", ""


def _session_source(session_id: str) -> str:
    database = _hermes_home() / "state.db"
    if not database.is_file() or not session_id or session_id == "unknown-session":
        return ""
    try:
        connection = sqlite3.connect(f"file:{database.as_posix()}?mode=ro", uri=True, timeout=1)
        try:
            row = connection.execute("SELECT source FROM sessions WHERE id = ?", (session_id,)).fetchone()
        finally:
            connection.close()
        return _text(row[0], 80).lower() if row else ""
    except (OSError, sqlite3.Error):
        return ""


def _client_for(item: dict[str, object], extra: dict[str, object], session_source: str = "") -> str:
    requested = _text(
        item.get("client")
        or item.get("runtime")
        or item.get("platform")
        or extra.get("client")
        or extra.get("runtime")
        or extra.get("platform"),
        80,
    ).lower()
    desktop_sources = {"desktop", "gateway", "tui"}
    return "hermes-desktop" if "desktop" in requested or requested in desktop_sources or session_source in desktop_sources else "hermes-cli"


def _event_id(item: dict[str, object], extra: dict[str, object], name: str, session_id: str) -> str:
    value = item.get("event_id") or extra.get("event_id") or extra.get("api_request_id")
    value = value or extra.get("turn_id") or extra.get("task_id") or item.get("timestamp")
    return str(value) if value else f"{session_id}:{name}:{uuid.uuid4().hex}"


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
    extra = _mapping(item.get("extra"))
    session_id = _text(item.get("session_id") or extra.get("session_id") or "unknown-session", 200)
    session_source = _session_source(session_id)
    stored_prompt, stored_answer = _session_messages(session_id) if name == "on_session_end" else ("", "")
    task_summary = _text(
        extra.get("task_summary")
        or extra.get("user_message")
        or item.get("user_message")
        or item.get("prompt")
        or stored_prompt,
        2_000,
    )
    if name == "api_request_error":
        status = "failed"
        error = _mapping(extra.get("error"))
        message = _text(extra.get("error_message") or error or extra.get("reason") or "Hermes API request failed")
        error_code = _text(extra.get("error_type") or extra.get("status_code") or "hermes_api_request_error", 200)
        metadata = {
            "session_id": session_id,
            "turn_id": _text(extra.get("turn_id"), 200),
            "api_request_id": _text(extra.get("api_request_id"), 200),
            "status_code": extra.get("status_code"),
            "retry_count": extra.get("retry_count"),
            "failure_message": message,
        }
    else:
        completed = extra.get("completed") is True or item.get("completed") is True or bool(stored_answer)
        interrupted = extra.get("interrupted") is True or item.get("interrupted") is True
        status = "interrupted" if interrupted else "completed" if completed else "failed"
        answer = _text(
            extra.get("assistant_response")
            or extra.get("result")
            or item.get("assistant_response")
            or stored_answer
        )
        message = _text(extra.get("reason") or extra.get("error_message") or ("Hermes session completed" if status == "completed" else "Hermes session ended"))
        error_code = _text(extra.get("error_type") or ("hermes_session_failed" if status == "failed" else ""), 200) or None
        metadata = {
            "session_id": session_id,
            "turn_id": _text(extra.get("turn_id"), 200),
            **({"task_summary": task_summary} if task_summary else {}),
            **({"answer_source": answer} if answer and status == "completed" else {}),
            **({"failure_message": message} if status == "failed" else {}),
    }
    metadata = {key: value for key, value in metadata.items() if value not in (None, "")}
    client = _client_for(item, extra, session_source)
    event = {
        "source": "hermes",
        "client": client,
        "event_id": _event_id(item, extra, name, session_id),
        "kind": name,
        "status": status,
        "title": f"Hermes {'task failed' if status == 'failed' else 'task completed' if status == 'completed' else 'task interrupted'}",
        "message": message,
        "error_code": error_code,
        "metadata": metadata,
    }
    return _post(event)


if __name__ == "__main__":
    raise SystemExit(main())
