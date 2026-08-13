import json
import os
import subprocess
from pathlib import Path


VENDOR_ROOT = Path(__file__).parents[1] / "data" / "vendor" / "coding-harness-tracing"


def _run_handler(code: str) -> dict:
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(VENDOR_ROOT)
    result = subprocess.run(
        [os.sys.executable, "-c", code],
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=environment,
        check=True,
    )
    return json.loads(result.stdout)


def test_stop_failure_builds_error_status():
    span = _run_handler(
        """
import json
from unittest.mock import patch
from tracing.claude_code.hooks import handlers

class State:
    values = {
        'session_id': 'session', 'current_trace_id': '1' * 32,
        'current_trace_span_id': '2' * 16, 'current_trace_start_time': '1',
        'current_trace_prompt': 'prompt', 'project_name': 'project',
        'trace_count': '1', 'user_id': ''
    }
    def get(self, key): return self.values.get(key)
    def delete(self, key): self.values.pop(key, None)

with patch.object(handlers, 'resolve_session', return_value=State()), \
     patch.object(handlers, 'send_span') as send:
    send.return_value = False
    handlers._handle_stop_failure({'error': 'api', 'error_details': 'rate limit'})
    print(json.dumps(send.call_args.args[0]))
"""
    )
    inner = span["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
    assert inner["status"]["code"] == 2


def test_post_tool_failure_builds_error_status():
    span = _run_handler(
        """
import json
from unittest.mock import patch
from tracing.claude_code.hooks import handlers

class State:
    values = {'session_id': 'session', 'current_trace_id': '1' * 32, 'current_trace_span_id': '2' * 16, 'user_id': ''}
    def get(self, key): return self.values.get(key)
    def delete(self, key): self.values.pop(key, None)
    def increment(self, key): self.values[key] = str(int(self.values.get(key, '0')) + 1)

with patch.object(handlers, 'resolve_session', return_value=State()), \
     patch.object(handlers, '_has_live_transcript', return_value=False), \
     patch.object(handlers, 'send_span') as send:
    handlers._handle_post_tool_use_failure({'tool_use_id': 'tool', 'tool_name': 'Bash', 'error': 'exit 1'})
    print(json.dumps(send.call_args.args[0]))
"""
    )
    inner = span["resourceSpans"][0]["scopeSpans"][0]["spans"][0]
    assert inner["status"]["code"] == 2
