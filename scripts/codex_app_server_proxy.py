"""Proxy a Codex App Server stdio session and relay terminal failures."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import urllib.request
from typing import Any

from dotenv import load_dotenv


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(ROOT, ".env"), override=False)


class ProtocolMonitor:
    """Convert public App Server terminal notifications into local events."""

    def __init__(self) -> None:
        self.turns: set[tuple[str, str]] = set()

    @staticmethod
    def _key(params: dict[str, Any]) -> tuple[str, str]:
        thread_id = str(params.get("threadId") or "unknown-thread")
        turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
        turn_id = str(params.get("turnId") or turn.get("id") or "unknown-turn")
        return thread_id, turn_id

    def consume(self, message: dict[str, Any]) -> None:
        method = str(message.get("method") or "")
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        key = self._key(params)
        if method == "turn/started":
            self.turns.add(key)
        elif method == "item/completed":
            self._complete_item(key, params)
        elif method == "error":
            self._record_error(key, params)
        elif method == "turn/completed":
            self._complete_turn(key, params)

    def _complete_item(self, key: tuple[str, str], params: dict[str, Any]) -> None:
        item = params.get("item") if isinstance(params.get("item"), dict) else {}
        item_id = str(item.get("id") or "unknown-item")
        status = str(item.get("status") or "unknown")
        error = item.get("error")
        if status in {"failed", "declined"} or error:
            message = error.get("message") if isinstance(error, dict) else str(error or status)
            self._relay(key, item_id, "tool_failed", str(message), item)

    def _record_error(self, key: tuple[str, str], params: dict[str, Any]) -> None:
        error = params.get("error") if isinstance(params.get("error"), dict) else {}
        message = str(error.get("message") or "Codex turn error")
        self._relay(key, "error", "api_failed", message, params)

    def _complete_turn(self, key: tuple[str, str], params: dict[str, Any]) -> None:
        turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
        status = str(turn.get("status") or "unknown")
        if status == "completed":
            message = "Codex turn completed"
        else:
            error = turn.get("error") if isinstance(turn.get("error"), dict) else {}
            message = str(error.get("message") or status)
        self._relay(key, turn.get("id", "turn"), status, message, turn)
        self.turns.discard(key)

    def close_open_turns(self, reason: str) -> int:
        open_count = len(self.turns)
        for key in list(self.turns):
            self._relay(key, "transport", "api_failed", reason, {})
        self.turns.clear()
        return open_count

    def record_process_exit(self, code: int) -> None:
        message = f"Codex App Server exited with code {code}"
        self._relay(("transport", "process"), "exit", "api_failed", message, {})

    @staticmethod
    def _relay(key: tuple[str, str], suffix: Any, kind: str, message: str, metadata: dict[str, Any]) -> None:
        url = os.getenv("AIMONITOR_URL", "http://127.0.0.1:8787/api/events")
        thread_id, turn_id = key
        event = {
            "source": "codex", "client": "codex-cli",
            "event_id": f"{thread_id}:{turn_id}:{suffix}:{kind}", "kind": kind,
            "status": "tool_failed" if kind == "tool_failed" else "failed" if kind == "api_failed" else kind,
            "title": f"Codex {kind}", "message": message[:24_000],
            "metadata": {"thread_id": thread_id, "turn_id": turn_id},
        }
        headers = {"Content-Type": "application/json"}
        token = os.getenv("AIMONITOR_INGEST_TOKEN")
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            request = urllib.request.Request(url, json.dumps(event).encode(), headers=headers, method="POST")
            with urllib.request.urlopen(request, timeout=2):
                pass
        except Exception as exc:
            print(f"AI monitor relay delivery failed: {exc}", file=sys.stderr)


def main() -> int:
    monitor = ProtocolMonitor()
    command = os.getenv("CODEX_COMMAND", "codex")
    process = subprocess.Popen(
        [command, "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=sys.stderr, text=True, encoding="utf-8", bufsize=1,
    )
    assert process.stdin is not None and process.stdout is not None

    def forward_stdin() -> None:
        assert process.stdin is not None
        for line in sys.stdin:
            process.stdin.write(line)
            process.stdin.flush()
        process.stdin.close()

    input_thread = threading.Thread(target=forward_stdin, daemon=True)
    input_thread.start()
    try:
        for line in process.stdout:
            sys.stdout.write(line)
            sys.stdout.flush()
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(message, dict):
                monitor.consume(message)
    finally:
        code = process.wait()
        input_thread.join(timeout=1)
        open_count = monitor.close_open_turns(f"Codex App Server exited with code {code}")
        if code != 0 and open_count == 0:
            monitor.record_process_exit(code)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
