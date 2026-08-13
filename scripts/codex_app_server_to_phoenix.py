"""Proxy a Codex App Server stdio session while exporting events to Phoenix.

This adapter consumes the public JSON-RPC notification contract. It does not parse
private desktop logs. The parent process owns stdin/stdout so transport failure and
process exit are observable alongside turn and item terminal states.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import urllib.request
from dataclasses import dataclass, field
from typing import Any

from dotenv import load_dotenv
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import Status, StatusCode


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(ROOT, ".env"), override=False)


def build_tracer() -> tuple[trace.Tracer, TracerProvider]:
    endpoint = os.getenv("PHOENIX_ENDPOINT", "http://127.0.0.1:6006").rstrip("/") + "/v1/traces"
    provider = TracerProvider(resource=Resource.create({
        "service.name": "codex-app-server",
        "openinference.project.name": os.getenv("PHOENIX_PROJECT", "codex"),
    }))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=endpoint)))
    trace.set_tracer_provider(provider)
    return trace.get_tracer("ai-monitoring.codex"), provider


@dataclass
class TurnState:
    span: trace.Span
    item_spans: dict[str, trace.Span] = field(default_factory=dict)


class ProtocolMonitor:
    def __init__(self, tracer: trace.Tracer) -> None:
        self.tracer = tracer
        self.turns: dict[tuple[str, str], TurnState] = {}

    def consume(self, message: dict[str, Any]) -> None:
        method = str(message.get("method") or "")
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        thread_id = str(params.get("threadId") or "unknown-thread")
        turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
        turn_id = str(params.get("turnId") or turn.get("id") or "unknown-turn")
        key = (thread_id, turn_id)

        if method == "turn/started":
            span = self.tracer.start_span("codex.turn", attributes={
                "openinference.span.kind": "AGENT", "session.id": thread_id,
                "codex.thread.id": thread_id, "codex.turn.id": turn_id,
            })
            self.turns[key] = TurnState(span)
        elif method == "item/started":
            self._start_item(key, params)
        elif method == "item/completed":
            self._complete_item(key, params)
        elif method == "error":
            self._record_error(key, params)
        elif method == "turn/completed":
            self._complete_turn(key, params)

    def _ensure_turn(self, key: tuple[str, str]) -> TurnState:
        state = self.turns.get(key)
        if state:
            return state
        thread_id, turn_id = key
        span = self.tracer.start_span("codex.turn", attributes={
            "openinference.span.kind": "AGENT", "session.id": thread_id,
            "codex.thread.id": thread_id, "codex.turn.id": turn_id,
        })
        state = TurnState(span)
        self.turns[key] = state
        return state

    def _start_item(self, key: tuple[str, str], params: dict[str, Any]) -> None:
        item = params.get("item") if isinstance(params.get("item"), dict) else {}
        item_id = str(item.get("id") or "unknown-item")
        state = self._ensure_turn(key)
        context = trace.set_span_in_context(state.span)
        span = self.tracer.start_span(
            f"codex.tool.{item.get('type', 'unknown')}", context=context,
            attributes={"openinference.span.kind": "TOOL", "codex.item.id": item_id},
        )
        state.item_spans[item_id] = span

    def _complete_item(self, key: tuple[str, str], params: dict[str, Any]) -> None:
        item = params.get("item") if isinstance(params.get("item"), dict) else {}
        item_id = str(item.get("id") or "unknown-item")
        state = self._ensure_turn(key)
        span = state.item_spans.pop(item_id, None)
        if span is None:
            span = self.tracer.start_span(
                f"codex.tool.{item.get('type', 'unknown')}",
                context=trace.set_span_in_context(state.span),
                attributes={"openinference.span.kind": "TOOL", "codex.item.id": item_id},
            )
        status = str(item.get("status") or "unknown")
        span.set_attribute("codex.item.status", status)
        error = item.get("error")
        if status in {"failed", "declined"} or error:
            message = error.get("message") if isinstance(error, dict) else str(error or status)
            span.set_status(Status(StatusCode.ERROR, message))
            span.set_attribute("error.type", f"codex.item.{status}")
            self._relay(key, item_id, "tool_failed", message, item)
        else:
            span.set_status(Status(StatusCode.OK))
        span.end()

    def _record_error(self, key: tuple[str, str], params: dict[str, Any]) -> None:
        state = self._ensure_turn(key)
        error = params.get("error") if isinstance(params.get("error"), dict) else {}
        message = str(error.get("message") or "Codex turn error")
        state.span.add_event("codex.error", {"error.message": message, "codex.will_retry": bool(params.get("willRetry"))})
        state.span.set_attribute("codex.last_error", message)
        self._relay(key, "error", "api_failed", message, params)

    def _complete_turn(self, key: tuple[str, str], params: dict[str, Any]) -> None:
        state = self._ensure_turn(key)
        turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
        status = str(turn.get("status") or "unknown")
        for span in state.item_spans.values():
            span.set_status(Status(StatusCode.ERROR, "turn ended before item terminal event"))
            span.end()
        state.span.set_attribute("codex.turn.status", status)
        if status == "completed":
            state.span.set_status(Status(StatusCode.OK))
        else:
            error = turn.get("error") if isinstance(turn.get("error"), dict) else {}
            message = str(error.get("message") or status)
            state.span.set_status(Status(StatusCode.ERROR, message))
            state.span.set_attribute("error.type", f"codex.turn.{status}")
        self._relay(key, turn.get("id", "turn"), status, message if status != "completed" else "Codex turn completed", turn)
        state.span.end()
        self.turns.pop(key, None)

    def close_open_turns(self, reason: str) -> int:
        open_count = len(self.turns)
        for key, state in self.turns.items():
            for span in state.item_spans.values():
                span.set_status(Status(StatusCode.ERROR, reason))
                span.end()
            state.span.set_status(Status(StatusCode.ERROR, reason))
            state.span.set_attribute("error.type", "codex.transport.closed")
            self._relay(key, "transport", "api_failed", reason, {})
            state.span.end()
        self.turns.clear()
        return open_count

    def record_process_exit(self, code: int) -> None:
        message = f"Codex App Server exited with code {code}"
        span = self.tracer.start_span(
            "codex.app_server",
            attributes={"openinference.span.kind": "AGENT", "error.type": "codex.transport.closed"},
        )
        span.set_status(Status(StatusCode.ERROR, message))
        span.end()
        self._relay(("transport", "process"), "exit", "api_failed", message, {})

    @staticmethod
    def _relay(key: tuple[str, str], suffix: Any, kind: str, message: str, metadata: dict[str, Any]) -> None:
        url = os.getenv("AIMONITOR_URL", "http://127.0.0.1:8787/api/events")
        thread_id, turn_id = key
        event = {
            "source": "codex", "client": "codex-app-server",
            "event_id": f"{thread_id}:{turn_id}:{suffix}:{kind}", "kind": kind,
            "status": "tool_failed" if kind == "tool_failed" else "failed" if kind == "api_failed" else kind,
            "title": f"Codex {kind}", "message": message[:2_000],
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
    tracer, provider = build_tracer()
    monitor = ProtocolMonitor(tracer)
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
        provider.force_flush()
        provider.shutdown()
    return code


if __name__ == "__main__":
    raise SystemExit(main())
