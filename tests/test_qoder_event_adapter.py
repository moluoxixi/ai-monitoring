import io
import json
from pathlib import Path
from unittest.mock import patch

from scripts.hooks import qoder_event_adapter


def test_qoder_failure_is_minimal_and_failed():
    payload = {
        "hook_event_name": "PostToolUseFailure",
        "session_id": "session",
        "turn_id": "turn",
        "runtime": "cli",
        "error_type": "authentication_failed",
        "error": {"message": "auth failed"},
        "tool_output": "sensitive output",
    }
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(qoder_event_adapter, "post") as post:
        post.return_value = 0
        assert qoder_event_adapter.main() == 0
    event = post.call_args.args[0]
    assert event["client"] == "qoder-cli"
    assert event["status"] == "tool_failed"
    assert event["metadata"]["notification_state"] == "diagnostic"
    assert event["error_code"] == "authentication_failed"
    assert "sensitive" not in json.dumps(event)


def test_qoder_stop_is_completed():
    with patch("sys.stdin", io.StringIO(json.dumps({"hook_event_name": "Stop", "session_id": "s", "runtime": "cli"}))), patch.object(qoder_event_adapter, "post", return_value=0) as post:
        assert qoder_event_adapter.main() == 0
    assert post.call_args.args[0]["status"] == "completed"


def test_qoder_desktop_runtime_is_kept_separate():
    payload = {"hook_event_name": "Stop", "session_id": "s", "runtime": "desktop"}
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(qoder_event_adapter, "post", return_value=0) as post:
        assert qoder_event_adapter.main() == 0
    assert post.call_args.args[0]["client"] == "qoder-desktop"


def test_qoder_desktop_is_detected_from_process_ancestry_when_payload_omits_runtime():
    payload = {"hook_event_name": "Stop", "session_id": "s"}
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), \
            patch.object(qoder_event_adapter, "_windows_process_ancestors", return_value=("bash.exe", "qoder.exe")), \
            patch.object(qoder_event_adapter, "post", return_value=0) as post:
        assert qoder_event_adapter.main() == 0
    assert post.call_args.args[0]["client"] == "qoder-desktop"


def test_qoder_runtime_environment_precedes_process_ancestry(monkeypatch):
    monkeypatch.setenv("QODER_RUNTIME", "cli")
    payload = {"hook_event_name": "Stop", "session_id": "s"}
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), \
            patch.object(qoder_event_adapter, "_windows_process_ancestors", return_value=("qoder.exe",)), \
            patch.object(qoder_event_adapter, "post", return_value=0) as post:
        assert qoder_event_adapter.main() == 0
    assert post.call_args.args[0]["client"] == "qoder-cli"


def test_qoder_quest_session_is_kept_separate_from_desktop():
    payload = {"hook_event_name": "Stop", "session_id": "task-123.session.execution"}
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), \
            patch.object(qoder_event_adapter, "_windows_process_ancestors", return_value=("bash.exe", "qoder.exe")), \
            patch.object(qoder_event_adapter, "post", return_value=0) as post:
        assert qoder_event_adapter.main() == 0
    assert post.call_args.args[0]["client"] == "qoder-quest"


def test_explicit_qoder_runtime_precedes_quest_session_shape():
    payload = {"hook_event_name": "Stop", "session_id": "task-123.session.execution", "runtime": "desktop"}
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(qoder_event_adapter, "post", return_value=0) as post:
        assert qoder_event_adapter.main() == 0
    assert post.call_args.args[0]["client"] == "qoder-desktop"


def test_qoderwork_process_is_not_misclassified_as_qoder_cli():
    payload = {"hook_event_name": "Stop", "session_id": "s"}
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), \
            patch.object(qoder_event_adapter, "_windows_process_ancestors", return_value=("bash.exe", "qoderwork.exe")), \
            patch.object(qoder_event_adapter, "post", return_value=0) as post:
        assert qoder_event_adapter.main() == 0
    post.assert_not_called()


def test_qoder_unknown_runtime_is_not_guessed_as_cli():
    payload = {"hook_event_name": "Stop", "session_id": "s"}
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(qoder_event_adapter, "_windows_process_ancestors", return_value=("bash.exe",)), patch.object(qoder_event_adapter, "post", return_value=0) as post:
        assert qoder_event_adapter.main() == 0
    post.assert_not_called()


def test_prompt_summary_is_forwarded():
    payload = {"hook_event_name": "Stop", "session_id": "s", "runtime": "cli", "user_prompt": "update the dashboard", "assistant_message": {"content": "dashboard updated"}}
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(qoder_event_adapter, "post", return_value=0) as post:
        assert qoder_event_adapter.main() == 0
    assert post.call_args.args[0]["metadata"]["task_summary"] == "update the dashboard"
    assert post.call_args.args[0]["metadata"]["answer_source"] == "dashboard updated"


def test_stop_reads_prompt_and_answer_from_qoder_transcript(tmp_path):
    transcript = tmp_path / "qoder-session.jsonl"
    transcript.write_text("\n".join([
        json.dumps({"type": "user", "message": {"role": "user", "content": "real qoder prompt"}}),
        json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "private"}]}}),
        json.dumps({"type": "assistant", "message": {"role": "assistant", "content": [{"type": "text", "text": "real qoder answer"}]}}),
    ]), encoding="utf-8")
    payload = {"hook_event_name": "Stop", "session_id": "s", "runtime": "cli", "transcript_path": str(transcript)}
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(qoder_event_adapter, "post", return_value=0) as post:
        assert qoder_event_adapter.main() == 0
    metadata = post.call_args.args[0]["metadata"]
    assert metadata["task_summary"] == "real qoder prompt"
    assert metadata["answer_source"] == "real qoder answer"
    assert "private" not in json.dumps(metadata)


def test_tool_result_does_not_replace_qoder_prompt(tmp_path):
    transcript = tmp_path / "qoder-session.jsonl"
    transcript.write_text("\n".join([
        json.dumps({"type": "user", "message": {"role": "user", "content": "real qoder prompt"}}),
        json.dumps({"type": "user", "message": {"role": "user", "content": {
            "type": "tool_result", "tool_use_id": "call-1", "content": "file missing", "is_error": True,
        }}}),
        json.dumps({"type": "assistant", "message": {"role": "assistant", "content": "failure reported"}}),
    ]), encoding="utf-8")
    payload = {"hook_event_name": "Stop", "session_id": "s", "runtime": "cli", "transcript_path": str(transcript)}

    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(qoder_event_adapter, "post", return_value=0) as post:
        assert qoder_event_adapter.main() == 0

    metadata = post.call_args.args[0]["metadata"]
    assert metadata["task_summary"] == "real qoder prompt"
    assert metadata["answer_source"] == "failure reported"


def test_stop_uses_hook_working_directory_when_cwd_is_not_in_payload(tmp_path, monkeypatch):
    project = tmp_path / "project"
    project.mkdir()
    encoded = str(project).replace(":", "--").replace("\\", "-").replace("/", "-")
    transcript = Path.home() / ".qoder" / "projects" / encoded / "session.jsonl"
    transcript.parent.mkdir(parents=True, exist_ok=True)
    transcript.write_text(json.dumps({"type": "user", "message": {"role": "user", "content": "from cwd"}}) + "\n", encoding="utf-8")
    monkeypatch.chdir(project)
    try:
        payload = {"hook_event_name": "Stop", "session_id": "session", "runtime": "cli"}
        with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(qoder_event_adapter, "post", return_value=0) as post:
            assert qoder_event_adapter.main() == 0
        assert post.call_args.args[0]["metadata"]["task_summary"] == "from cwd"
    finally:
        transcript.unlink(missing_ok=True)
        try:
            transcript.parent.rmdir()
            transcript.parent.parent.rmdir()
        except OSError:
            pass


def test_missing_turn_id_does_not_collapse_consecutive_stops():
    payload = {"hook_event_name": "Stop", "session_id": "session", "runtime": "cli"}
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(qoder_event_adapter, "post", return_value=0) as post:
        assert qoder_event_adapter.main() == 0
    first = post.call_args.args[0]["event_id"]
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(qoder_event_adapter, "post", return_value=0) as post:
        assert qoder_event_adapter.main() == 0
    assert post.call_args.args[0]["event_id"] != first


def test_long_prompt_and_answer_preserve_notification_maximums():
    payload = {
        "hook_event_name": "Stop",
        "session_id": "session",
        "runtime": "cli",
        "user_prompt": "q" * 2_100,
        "assistant_message": "a" * 25_000,
    }
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(qoder_event_adapter, "post", return_value=0) as post:
        assert qoder_event_adapter.main() == 0

    metadata = post.call_args.args[0]["metadata"]
    assert len(metadata["task_summary"]) == 2_000
    assert len(metadata["answer_source"]) == 24_000
