import io
import json
from unittest.mock import patch

from scripts.hooks import cursor_event_adapter


def test_stop_forwards_prompt_and_answer():
    payload = {
        "hook_event_name": "stop",
        "session_id": "session",
        "turn_id": "turn",
        "runtime": "desktop",
        "prompt": "fix the login flow",
        "response": "done",
    }
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(cursor_event_adapter, "_post", return_value=0) as post:
        assert cursor_event_adapter.main() == 0
    event = post.call_args.args[0]
    assert event["client"] == "cursor-desktop"
    assert event["status"] == "completed"
    assert event["metadata"] == {
        "session_id": "session", "turn_id": "turn", "hook_event_name": "stop",
        "task_summary": "fix the login flow", "answer_source": "done",
    }


def test_windows_utf8_bom_does_not_silently_drop_hook_payload():
    payload = {"hook_event_name": "stop", "session_id": "session", "runtime": "desktop", "response": "done"}
    with patch("sys.stdin", io.StringIO("\ufeff" + json.dumps(payload))), patch.object(cursor_event_adapter, "_post", return_value=0) as post:
        assert cursor_event_adapter.main() == 0
    post.assert_called_once()


def test_tool_failure_does_not_forward_private_request():
    payload = {
        "hook_event_name": "postToolUseFailure",
        "session_id": "session",
        "runtime": "desktop",
        "error_message": "tool failed",
        "tool_input": {"secret": "private"},
    }
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(cursor_event_adapter, "_post", return_value=0) as post:
        assert cursor_event_adapter.main() == 0
    event = post.call_args.args[0]
    assert event["status"] == "tool_failed"
    assert event["metadata"]["notification_state"] == "diagnostic"
    assert "private" not in json.dumps(event)


def test_cursor_cli_runtime_is_kept_separate():
    payload = {"hook_event_name": "stop", "session_id": "session", "runtime": "cli"}
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(cursor_event_adapter, "_post", return_value=0) as post:
        assert cursor_event_adapter.main() == 0
    assert post.call_args.args[0]["client"] == "cursor-cli"


def test_cursor_unknown_runtime_is_ignored_instead_of_being_desktop():
    payload = {"hook_event_name": "stop", "session_id": "session", "response": "done"}
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(cursor_event_adapter, "_post", return_value=0) as post:
        assert cursor_event_adapter.main() == 0
    post.assert_not_called()


def test_stop_reads_prompt_and_answer_from_cursor_transcript(tmp_path):
    transcript = tmp_path / "conversation.jsonl"
    transcript.write_text(
        "\n".join([
            json.dumps({"role": "user", "message": {"content": [{"type": "text", "text": "<timestamp>x</timestamp>\n<user_query>检查登录流程</user_query>"}]}}),
            json.dumps({"role": "assistant", "message": {"content": [{"type": "text", "text": "已完成检查"}]}}),
            json.dumps({"type": "turn_ended", "status": "success"}),
        ]) + "\n",
        encoding="utf-8",
    )
    payload = {
        "hook_event_name": "stop",
        "conversation_id": "conversation",
        "generation_id": "generation",
        "runtime": "desktop",
        "transcript_path": str(transcript),
        "text": "已完成检查",
    }
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(cursor_event_adapter, "_post", return_value=0) as post:
        assert cursor_event_adapter.main() == 0
    event = post.call_args.args[0]
    assert event["event_id"] == "conversation:stop:generation"
    assert event["metadata"]["task_summary"] == "检查登录流程"
    assert event["metadata"]["answer_source"] == "已完成检查"
    assert event["metadata"]["hook_event_name"] == "stop"
