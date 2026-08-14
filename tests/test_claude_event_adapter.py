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


def test_prompt_summary_and_successful_assistant_content_are_forwarded():
    payload = {"hook_event_name": "Stop", "session_id": "session", "prompt": "fix the login flow", "last_assistant_message": "answer"}
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(claude_event_adapter, "post", return_value=0) as post:
        assert claude_event_adapter.main() == 0
    event = post.call_args.args[0]
    assert event["metadata"]["task_summary"] == "fix the login flow"
    assert event["metadata"]["answer_source"] == "answer"


def test_legacy_stop_reads_only_assistant_text_from_the_transcript(tmp_path):
    transcript = tmp_path / "session.jsonl"
    transcript.write_text("\n".join([
        json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "first answer"}, {"type": "tool_use", "input": "private tool input"}]}}),
        json.dumps({"type": "user", "message": {"role": "user", "content": "next prompt"}}),
        json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "final answer"}]}}),
    ]), encoding="utf-8")
    payload = {"hook_event_name": "Stop", "session_id": "session", "transcript_path": str(transcript)}
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(claude_event_adapter, "post", return_value=0) as post:
        assert claude_event_adapter.main() == 0

    event = post.call_args.args[0]
    assert event["metadata"]["answer_source"] == "final answer"
    assert "private tool input" not in json.dumps(event)


def test_missing_turn_id_does_not_collapse_consecutive_stops():
    payload = {"hook_event_name": "Stop", "session_id": "session"}
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(claude_event_adapter, "post", return_value=0) as post:
        assert claude_event_adapter.main() == 0
    first = post.call_args.args[0]["event_id"]
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(claude_event_adapter, "post", return_value=0) as post:
        assert claude_event_adapter.main() == 0
    assert post.call_args.args[0]["event_id"] != first
