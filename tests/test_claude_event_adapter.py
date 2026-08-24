import io
import json
from pathlib import Path
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
    assert event["client"] == "claude-cli"
    assert event["status"] == "failed"
    assert event["message"] == "rate limited"
    assert event["metadata"] == {"session_id": "session", "turn_id": "turn"}
    assert "sensitive" not in json.dumps(event)


def test_tool_failure_is_diagnostic_and_not_a_task_failure():
    payload = {"hook_event_name": "PostToolUseFailure", "session_id": "session", "turn_id": "turn", "error": {"message": "tool failed"}}
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(claude_event_adapter, "post", return_value=0) as post:
        assert claude_event_adapter.main() == 0
    event = post.call_args.args[0]
    assert event["status"] == "tool_failed"
    assert event["error_code"] == "tool failed"
    assert event["metadata"]["notification_state"] == "diagnostic"


def test_unrelated_hook_is_ignored():
    payload = {"hook_event_name": "PreToolUse", "session_id": "session"}
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(claude_event_adapter, "post") as post:
        assert claude_event_adapter.main() == 0
    post.assert_not_called()


def test_prompt_summary_and_successful_assistant_content_are_forwarded():
    payload = {
        "hook_event_name": "Stop",
        "session_id": "session",
        "cwd": "D:\\project-new\\claude-project",
        "prompt": "fix the login flow",
        "last_assistant_message": "answer",
    }
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(claude_event_adapter, "post", return_value=0) as post:
        assert claude_event_adapter.main() == 0
    event = post.call_args.args[0]
    assert event["metadata"]["task_summary"] == "fix the login flow"
    assert event["metadata"]["answer_source"] == "answer"
    assert event["metadata"]["cwd"] == "D:\\project-new\\claude-project"


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
    assert event["metadata"]["task_summary"] == "next prompt"
    assert "private tool input" not in json.dumps(event)


def test_transcript_summary_ignores_tool_result_user_records(tmp_path):
    transcript = tmp_path / "session.jsonl"
    transcript.write_text("\n".join([
        json.dumps({"type": "user", "message": {"role": "user", "content": "real question"}}),
        json.dumps({"type": "user", "parent_tool_use_id": "tool", "tool_use_result": {"content": "private"}, "message": {"role": "user", "content": "private tool output"}}),
        json.dumps({"type": "user", "isSynthetic": True, "message": {"role": "user", "content": "private synthetic prompt"}}),
        json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "final"}]}}),
    ]), encoding="utf-8")
    payload = {"hook_event_name": "Stop", "session_id": "session", "transcript_path": str(transcript)}
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(claude_event_adapter, "post", return_value=0) as post:
        assert claude_event_adapter.main() == 0
    metadata = post.call_args.args[0]["metadata"]
    assert metadata["task_summary"] == "real question"
    assert metadata["answer_source"] == "final"
    assert "private" not in json.dumps(metadata)


def test_stop_finds_transcript_by_session_id_when_hook_omits_path(tmp_path):
    transcript = tmp_path / ".claude" / "projects" / "workspace" / "session.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text("\n".join([
        json.dumps({"type": "user", "message": {"role": "user", "content": "real prompt"}}),
        json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "real answer"}]}}),
    ]), encoding="utf-8")
    payload = {"hook_event_name": "Stop", "session_id": "session"}

    with patch.object(Path, "home", return_value=tmp_path), patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(claude_event_adapter, "post", return_value=0) as post:
        assert claude_event_adapter.main() == 0

    metadata = post.call_args.args[0]["metadata"]
    assert metadata["task_summary"] == "real prompt"
    assert metadata["answer_source"] == "real answer"


def test_missing_turn_id_does_not_collapse_consecutive_stops():
    payload = {"hook_event_name": "Stop", "session_id": "session"}
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(claude_event_adapter, "post", return_value=0) as post:
        assert claude_event_adapter.main() == 0
    first = post.call_args.args[0]["event_id"]
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(claude_event_adapter, "post", return_value=0) as post:
        assert claude_event_adapter.main() == 0
    assert post.call_args.args[0]["event_id"] != first


def test_desktop_stop_uses_the_stable_terminal_identity(tmp_path):
    transcript = tmp_path / "desktop.jsonl"
    transcript.write_text("\n".join([
        json.dumps({
            "type": "user", "entrypoint": "claude-desktop-3p", "sessionId": "desktop-session",
            "message": {"role": "user", "content": "desktop question"},
        }),
        json.dumps({
            "type": "assistant", "entrypoint": "claude-desktop-3p", "sessionId": "desktop-session",
            "uuid": "assistant-record", "message": {
                "id": "message-1", "role": "assistant", "stop_reason": "end_turn",
                "content": [{"type": "text", "text": "desktop answer"}],
            },
        }),
    ]), encoding="utf-8")
    payload = {"hook_event_name": "Stop", "session_id": "desktop-session", "transcript_path": str(transcript)}

    captured = []
    for _ in range(2):
        with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(
            claude_event_adapter, "post", side_effect=lambda event: captured.append(event) or 0
        ):
            assert claude_event_adapter.main() == 0

    assert len(captured) == 2
    assert captured[0]["source"] == "claude-desktop"
    assert captured[0]["client"] == "claude-desktop"
    assert captured[0]["event_id"] == "claude-desktop:assistant:message-1:completed"
    assert captured[0]["event_id"] == captured[1]["event_id"]
    assert captured[0]["title"] == "Claude Desktop task completed"
    assert captured[0]["metadata"] == {
        "session_id": "desktop-session",
        "turn_id": "message-1",
        "task_summary": "desktop question",
        "answer_source": "desktop answer",
    }


def test_desktop_marker_in_message_content_does_not_change_cli_source(tmp_path):
    transcript = tmp_path / "cli.jsonl"
    transcript.write_text("\n".join([
        json.dumps({
            "type": "user", "entrypoint": "claude-code",
            "message": {"role": "user", "content": "mentions claude-desktop-3p"},
        }),
        json.dumps({
            "type": "assistant", "entrypoint": "claude-code",
            "message": {"id": "cli-message", "role": "assistant", "stop_reason": "end_turn", "content": "CLI answer"},
        }),
    ]), encoding="utf-8")
    payload = {"hook_event_name": "Stop", "session_id": "cli-session", "transcript_path": str(transcript)}

    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(
        claude_event_adapter, "post", return_value=0
    ) as post:
        assert claude_event_adapter.main() == 0

    event = post.call_args.args[0]
    assert event["source"] == "claude"
    assert event["client"] == "claude-cli"
    assert event["event_id"].startswith("cli-session:Stop:hook-")


def test_sidechain_desktop_marker_does_not_change_the_main_chain_source(tmp_path):
    transcript = tmp_path / "sidechain-marker.jsonl"
    transcript.write_text("\n".join([
        json.dumps({
            "type": "assistant", "entrypoint": "claude-desktop-3p", "isSidechain": True,
            "message": {"id": "sidechain-message", "role": "assistant", "stop_reason": "end_turn", "content": "sidechain"},
        }),
        json.dumps({
            "type": "user", "entrypoint": "claude-code",
            "message": {"role": "user", "content": "main question"},
        }),
        json.dumps({
            "type": "assistant", "entrypoint": "claude-code",
            "message": {"id": "main-message", "role": "assistant", "stop_reason": "end_turn", "content": "main answer"},
        }),
    ]), encoding="utf-8")
    payload = {"hook_event_name": "Stop", "session_id": "cli-session", "transcript_path": str(transcript)}

    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(
        claude_event_adapter, "post", return_value=0
    ) as post:
        assert claude_event_adapter.main() == 0

    event = post.call_args.args[0]
    assert event["source"] == "claude"
    assert event["client"] == "claude-cli"
    assert event["metadata"]["task_summary"] == "main question"
    assert event["metadata"]["answer_source"] == "main answer"


def test_desktop_terminal_uses_record_uuid_when_message_id_is_missing(tmp_path):
    transcript = tmp_path / "desktop-uuid.jsonl"
    transcript.write_text(json.dumps({
        "type": "assistant", "entrypoint": "claude-desktop-3p", "sessionId": "desktop-session",
        "uuid": "record-uuid", "message": {
            "role": "assistant", "stop_reason": "end_turn", "content": "desktop answer",
        },
    }), encoding="utf-8")
    payload = {"hook_event_name": "Stop", "session_id": "desktop-session", "transcript_path": str(transcript)}

    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(
        claude_event_adapter, "post", return_value=0
    ) as post:
        assert claude_event_adapter.main() == 0

    event = post.call_args.args[0]
    assert event["event_id"] == "claude-desktop:assistant:record-uuid:completed"
    assert event["metadata"]["turn_id"] == "record-uuid"


def test_desktop_stop_without_a_current_stable_terminal_is_left_to_the_watcher(tmp_path):
    transcript = tmp_path / "desktop-incomplete.jsonl"
    transcript.write_text("\n".join([
        json.dumps({
            "type": "assistant", "entrypoint": "claude-desktop-3p", "sessionId": "desktop-session",
            "message": {"id": "old-message", "role": "assistant", "stop_reason": "end_turn", "content": "old answer"},
        }),
        json.dumps({
            "type": "user", "entrypoint": "claude-desktop-3p", "sessionId": "desktop-session",
            "message": {"role": "user", "content": "new question"},
        }),
        json.dumps({
            "type": "assistant", "entrypoint": "claude-desktop-3p", "sessionId": "desktop-session",
            "message": {"role": "assistant", "stop_reason": "end_turn", "content": "answer without stable id"},
        }),
    ]), encoding="utf-8")
    payload = {"hook_event_name": "Stop", "session_id": "desktop-session", "transcript_path": str(transcript)}

    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(
        claude_event_adapter.time, "sleep"
    ), patch.object(claude_event_adapter, "post") as post:
        assert claude_event_adapter.main() == 0
    post.assert_not_called()


def test_desktop_tool_failure_remains_an_independent_diagnostic(tmp_path):
    transcript = tmp_path / "desktop-tool.jsonl"
    transcript.write_text(json.dumps({
        "type": "user", "entrypoint": "claude-desktop-3p", "sessionId": "desktop-session",
        "message": {"role": "user", "content": "desktop question"},
    }), encoding="utf-8")
    payload = {
        "hook_event_name": "PostToolUseFailure",
        "session_id": "desktop-session",
        "turn_id": "tool-turn",
        "transcript_path": str(transcript),
        "error": {"message": "tool failed"},
    }

    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(
        claude_event_adapter, "post", return_value=0
    ) as post:
        assert claude_event_adapter.main() == 0

    event = post.call_args.args[0]
    assert event["source"] == "claude-desktop"
    assert event["client"] == "claude-desktop"
    assert event["status"] == "tool_failed"
    assert event["metadata"]["notification_state"] == "diagnostic"
    assert "answer_source" not in event["metadata"]


def test_desktop_stop_failure_only_uses_an_exact_transcript_error_identity(tmp_path):
    transcript = tmp_path / "desktop-failure.jsonl"
    transcript.write_text(json.dumps({
        "type": "system", "subtype": "api_error", "entrypoint": "claude-desktop-3p",
        "sessionId": "desktop-session", "uuid": "error-1", "error": {"message": "upstream failed"},
    }), encoding="utf-8")
    payload = {
        "hook_event_name": "StopFailure",
        "session_id": "desktop-session",
        "turn_id": "error-1",
        "transcript_path": str(transcript),
        "error": {"message": "upstream failed"},
    }

    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(
        claude_event_adapter, "post", return_value=0
    ) as post:
        assert claude_event_adapter.main() == 0

    event = post.call_args.args[0]
    assert event["source"] == "claude-desktop"
    assert event["client"] == "claude-desktop"
    assert event["event_id"] == "claude-desktop:system:error-1:failed"
    assert event["metadata"]["turn_id"] == "error-1"

    mismatched = {**payload, "turn_id": "another-error"}
    with patch("sys.stdin", io.StringIO(json.dumps(mismatched))), patch.object(
        claude_event_adapter.time, "sleep"
    ), patch.object(claude_event_adapter, "post") as post:
        assert claude_event_adapter.main() == 0
    post.assert_not_called()


def test_long_prompt_and_answer_preserve_notification_maximums():
    payload = {
        "hook_event_name": "Stop",
        "session_id": "session",
        "prompt": "q" * 2_100,
        "last_assistant_message": "a" * 25_000,
    }
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(claude_event_adapter, "post", return_value=0) as post:
        assert claude_event_adapter.main() == 0

    metadata = post.call_args.args[0]["metadata"]
    assert len(metadata["task_summary"]) == 2_000
    assert len(metadata["answer_source"]) == 24_000
