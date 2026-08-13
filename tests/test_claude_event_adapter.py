import io
import json
from unittest.mock import patch

from scripts.hooks import claude_event_adapter


def test_stop_failure_forwards_only_minimal_metadata():
    payload = {
        "hook_event_name": "StopFailure",
        "session_id": "session",
        "turn_id": "turn",
        "error": {"message": "rate limited"},
        "last_assistant_message": "sensitive response",
        "tool_response": "sensitive tool output",
    }
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(claude_event_adapter, "post") as post:
        post.return_value = 0
        assert claude_event_adapter.main() == 0

    event = post.call_args.args[0]
    assert event["status"] == "failed"
    assert event["message"] == "rate limited"
    assert event["metadata"] == {"session_id": "session", "turn_id": "turn"}
    assert "sensitive" not in json.dumps(event)


def test_unrelated_hook_is_ignored():
    payload = {"hook_event_name": "PreToolUse", "session_id": "session"}
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(claude_event_adapter, "post") as post:
        assert claude_event_adapter.main() == 0
    post.assert_not_called()
