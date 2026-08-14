"""Forward Qoder CLI lifecycle hooks to the local notification relay."""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
import uuid
from pathlib import Path

from dotenv import load_dotenv


RELAY_EVENTS = {"Stop", "PostToolUseFailure"}
load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=False)


def _text(value: object, limit: int = 24_000) -> str:
    if isinstance(value, dict):
        value = value.get("message") or value.get("error") or value.get("type") or ""
    return str(value or "")[:limit]


def _canonical_client(value: object) -> str | None:
    runtime = _text(value, 80).strip().lower()
    if runtime in {"quest", "qoder-quest"}:
        return "qoder-quest"
    if runtime in {"desktop", "qoder-desktop"}:
        return "qoder-desktop"
    if runtime in {"cli", "qoder-cli"}:
        return "qoder-cli"
    return None


def _windows_process_ancestors() -> tuple[str, ...]:
    if sys.platform != "win32":
        return ()
    import ctypes
    from ctypes import wintypes

    class ProcessEntry32(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", wintypes.LONG),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", wintypes.WCHAR * 260),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    create_snapshot = kernel32.CreateToolhelp32Snapshot
    create_snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    create_snapshot.restype = wintypes.HANDLE
    snapshot = create_snapshot(0x00000002, 0)
    if snapshot == wintypes.HANDLE(-1).value:
        return ()
    first = kernel32.Process32FirstW
    first.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry32)]
    first.restype = wintypes.BOOL
    next_entry = kernel32.Process32NextW
    next_entry.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry32)]
    next_entry.restype = wintypes.BOOL
    processes: dict[int, tuple[int, str]] = {}
    entry = ProcessEntry32()
    entry.dwSize = ctypes.sizeof(entry)
    try:
        available = first(snapshot, ctypes.byref(entry))
        while available:
            processes[int(entry.th32ProcessID)] = (int(entry.th32ParentProcessID), entry.szExeFile.lower())
            available = next_entry(snapshot, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snapshot)

    names: list[str] = []
    process_id = os.getppid()
    seen: set[int] = set()
    while process_id > 0 and process_id not in seen and len(names) < 12:
        seen.add(process_id)
        process = processes.get(process_id)
        if process is None:
            break
        process_id, name = process
        names.append(name)
    return tuple(names)


def _runtime_argument() -> str:
    for index, argument in enumerate(sys.argv):
        if argument == "--runtime" and index + 1 < len(sys.argv):
            return sys.argv[index + 1]
    return ""


def _client(item: dict, runtime_override: str = "") -> str | None:
    for value in (runtime_override, item.get("client"), item.get("platform"), item.get("runtime"), os.getenv("QODER_RUNTIME")):
        client = _canonical_client(value)
        if client:
            return client
    session_id = str(item.get("session_id") or item.get("sessionId") or "").strip().lower()
    if session_id.endswith(".session.execution"):
        return "qoder-quest"
    ancestors = _windows_process_ancestors()
    if "qoderwork.exe" in ancestors:
        return None
    if "qoder.exe" in ancestors:
        return "qoder-desktop"
    return None

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


def _user_content_text(value: object) -> str:
    if isinstance(value, dict) and value.get("type") in {"tool_result", "tool_use"}:
        return ""
    if isinstance(value, list):
        return "\n".join(filter(None, (_user_content_text(part) for part in value)))
    return _content_text(value)


def _transcript_path(item: dict) -> Path | None:
    value = item.get("transcript_path") or item.get("transcriptPath")
    if isinstance(value, str) and Path(value).is_file():
        return Path(value)
    session_id = str(item.get("session_id") or item.get("sessionId") or "").strip()
    cwd = str(item.get("cwd") or os.getcwd()).strip()
    if not session_id or not cwd:
        return None
    workspace = cwd.replace(":", "--").replace("\\", "-").replace("/", "-")
    candidate = Path.home() / ".qoder" / "projects" / workspace / f"{session_id}.jsonl"
    return candidate if candidate.is_file() else None


def _transcript_context(item: dict) -> tuple[str, str]:
    path = _transcript_path(item)
    if not path:
        return "", ""
    summary = ""
    answer = ""
    try:
        with path.open("r", encoding="utf-8") as transcript:
            for line in transcript:
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(record, dict):
                    continue
                if record.get("type") == "user":
                    message = record.get("message")
                    if isinstance(message, dict) and message.get("role") == "user":
                        text = _user_content_text(message.get("content")).strip()
                        if text:
                            summary = text[-2_000:]
                elif record.get("type") == "assistant":
                    message = record.get("message")
                    if isinstance(message, dict) and message.get("role") == "assistant":
                        text = _content_text(message.get("content")).strip()
                        if text:
                            answer = text[-24_000:]
    except OSError:
        return "", ""
    return summary, answer


def _transcript_context_retry(item: dict) -> tuple[str, str]:
    if _transcript_path(item) is None:
        return _transcript_context(item)
    for attempt in range(5):
        summary, answer = _transcript_context(item)
        if summary and answer or attempt == 4:
            return summary, answer
        time.sleep(0.1)
    return "", ""

def _assistant_answer(item: dict) -> str:
    for key in ("last_assistant_message", "last-assistant-message", "lastAssistantMessage", "assistant_message", "assistantMessage"):
        value = item.get(key)
        if isinstance(value, dict):
            value = value.get("content") or value.get("text") or value.get("message")
        if isinstance(value, str) and value.strip():
            return value[-24_000:]
    return _transcript_context(item)[1]

def _turn_id(item: dict) -> str:
    value = item.get("turn_id") or item.get("turnId") or item.get("tool_use_id") or item.get("timestamp")
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
    status = "completed" if name == "Stop" else "tool_failed"
    session_id = str(item.get("session_id") or item.get("sessionId") or "unknown-session")
    turn_id = _turn_id(item)
    event_id = str(item.get("event_id") or item.get("eventId") or f"{session_id}:{name}:{turn_id}")
    error = _text(item.get("error") or item.get("error_details") or item.get("error_type"))
    message = _text(item.get("message") or error or item.get("stop_reason") or name)
    task_summary = _summary(item)
    transcript_summary, transcript_answer = _transcript_context_retry(item)
    if not task_summary:
        task_summary = transcript_summary
    assistant_answer = _assistant_answer(item) if status == "completed" else ""
    assistant_answer = assistant_answer or transcript_answer
    client = _client(item, _runtime_argument())
    if client is None:
        return 0
    event = {
        "source": "qoder",
        "client": client,
        "event_id": event_id,
        "kind": name,
        "status": status,
        "title": f"Qoder {name}",
        "message": message,
        "error_code": _text(item.get("error_type") or (error if status in {"failed", "tool_failed"} else ""), 200) or None,
        "metadata": {
            "session_id": session_id,
            "turn_id": turn_id,
            **({"task_summary": task_summary} if task_summary else {}),
            **({"answer_source": assistant_answer} if assistant_answer else {}),
            **({"notification_state": "diagnostic"} if status == "tool_failed" else {}),
        },
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
