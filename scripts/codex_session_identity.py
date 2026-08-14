"""Read the small identity header of a Codex session without reading its transcript."""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any


_IDENTITY_CACHE: dict[tuple[str, str], dict[str, Any]] = {}
_INDEX_CACHE: dict[str, dict[str, dict[str, Any]]] = {}


def _text(value: Any) -> str:
    return value.strip().lower() if isinstance(value, str) else ""


def _is_subagent_source(value: Any) -> bool:
    if isinstance(value, dict):
        if value.get("subagent"):
            return True
        return _text(value.get("type")) == "subagent" or _text(value.get("kind")) == "subagent"
    return _text(value) == "subagent"


def _session_roots(codex_home: Path | None = None) -> tuple[Path, ...]:
    configured = os.getenv("CODEX_HOME", "").strip()
    root = codex_home or (Path(configured).expanduser() if configured else Path.home() / ".codex")
    return tuple(root / name for name in ("sessions", "archived_sessions"))


def _candidate_paths(thread_id: str, codex_home: Path | None = None) -> list[Path]:
    if not thread_id or not re.fullmatch(r"[A-Za-z0-9._:-]{1,200}", thread_id):
        return []
    paths: list[Path] = []
    for root in _session_roots(codex_home):
        if not root.is_dir():
            continue
        try:
            paths.extend(path for path in root.rglob("*.jsonl") if thread_id in path.name)
        except OSError:
            continue
    usable: list[tuple[float, Path]] = []
    for path in paths:
        try:
            if path.is_file():
                usable.append((path.stat().st_mtime, path))
        except OSError:
            continue
    usable.sort(key=lambda item: item[0], reverse=True)
    return [path for _, path in usable]


def _all_session_paths(codex_home: Path | None = None) -> list[Path]:
    paths: list[Path] = []
    for root in _session_roots(codex_home):
        if not root.is_dir():
            continue
        try:
            for path in root.rglob("*.jsonl"):
                try:
                    if path.is_file():
                        paths.append(path)
                except OSError:
                    continue
        except OSError:
            continue
    return paths


def _decode_session_meta(item: Any) -> tuple[str, dict[str, Any]] | None:
    if not isinstance(item, dict) or item.get("type") != "session_meta":
        return None
    payload = item.get("payload") if isinstance(item.get("payload"), dict) else {}
    session_id = str(payload.get("session_id") or payload.get("id") or "")
    source = payload.get("source")
    thread_source = _text(payload.get("thread_source") or item.get("thread_source"))
    originator = _text(payload.get("originator") or item.get("originator"))
    return session_id, {
        "is_subagent": _is_subagent_source(source) or thread_source == "subagent",
        "source": source if isinstance(source, str) else "",
        "thread_source": thread_source,
        "originator": originator,
    }


def _session_index(codex_home: Path | None = None) -> dict[str, dict[str, Any]]:
    roots = _session_roots(codex_home)
    cache_key = str(roots[0].parent)
    if cache_key in _INDEX_CACHE:
        return _INDEX_CACHE[cache_key]
    index: dict[str, dict[str, Any]] = {}
    for path in _all_session_paths(codex_home):
        try:
            with path.open("r", encoding="utf-8", errors="replace") as session:
                for line in session:
                    try:
                        decoded = _decode_session_meta(json.loads(line))
                    except json.JSONDecodeError:
                        continue
                    if decoded is None:
                        continue
                    session_id, identity = decoded
                    if not session_id:
                        break
                    previous = index.get(session_id)
                    if previous is None or (previous.get("is_subagent") and not identity.get("is_subagent")):
                        index[session_id] = identity
                    break
        except (OSError, UnicodeError):
            continue
    _INDEX_CACHE[cache_key] = index
    return index


def read_session_identity(thread_id: str, codex_home: Path | None = None) -> dict[str, Any]:
    """Return safe session metadata fields; never return instructions or transcript content."""
    cache_key = (str(codex_home or ""), thread_id)
    if cache_key in _IDENTITY_CACHE:
        return dict(_IDENTITY_CACHE[cache_key])
    candidates = _candidate_paths(thread_id, codex_home)
    paths = candidates
    for path in paths:
        try:
            with path.open("r", encoding="utf-8", errors="replace") as session:
                for line in session:
                    try:
                        item = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(item, dict) or item.get("type") != "session_meta":
                        continue
                    decoded = _decode_session_meta(item)
                    if decoded is None:
                        continue
                    session_id, identity = decoded
                    if session_id and session_id != thread_id:
                        continue
                    _IDENTITY_CACHE[cache_key] = identity
                    return dict(identity)
        except (OSError, UnicodeError):
            continue
    identity = _session_index(codex_home).get(thread_id, {})
    _IDENTITY_CACHE[cache_key] = identity
    return dict(identity)


def is_subagent_session(thread_id: str, codex_home: Path | None = None) -> bool:
    return bool(read_session_identity(thread_id, codex_home).get("is_subagent"))


def session_kind(thread_id: str, codex_home: Path | None = None) -> str | None:
    """Return the known runtime for a session, or None when attribution is unavailable."""
    identity = read_session_identity(thread_id, codex_home)
    if not identity:
        return None
    if identity.get("is_subagent"):
        return "subagent"
    runtime = f"{identity.get('source', '')} {identity.get('originator', '')}".lower()
    if any(marker in runtime for marker in ("desktop", "vscode", "ide")):
        return "codex-desktop"
    if any(marker in runtime for marker in ("cli", "command-line", "command_line")):
        return "codex-cli"
    return None
