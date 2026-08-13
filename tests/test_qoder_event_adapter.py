import io
import json
from unittest.mock import patch

from scripts.hooks import qoder_event_adapter


def test_qoder_failure_is_minimal_and_failed():
    payload = {
        "hook_event_name": "PostToolUseFailure",
        "session_id": "session",
        "turn_id": "turn",
        "error_type": "authentication_failed",
        "error": {"message": "auth failed"},
        "tool_output": "sensitive output",
    }
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(qoder_event_adapter, "post") as post:
        post.return_value = 0
        assert qoder_event_adapter.main() == 0
    event = post.call_args.args[0]
    assert event["client"] == "qoder"
    assert event["status"] == "failed"
    assert event["error_code"] == "authentication_failed"
    assert "sensitive" not in json.dumps(event)


def test_qoder_stop_is_completed():
    with patch("sys.stdin", io.StringIO(json.dumps({"hook_event_name": "Stop", "session_id": "s"}))), patch.object(qoder_event_adapter, "post", return_value=0) as post:
        assert qoder_event_adapter.main() == 0
    assert post.call_args.args[0]["status"] == "completed"
