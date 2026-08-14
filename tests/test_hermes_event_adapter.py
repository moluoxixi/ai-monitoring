import io
import json
import sqlite3
from unittest.mock import patch

from scripts.hooks import hermes_event_adapter


def test_completed_session_forwards_summary_and_answer():
    payload = {
        "hook_event_name": "on_session_end",
        "session_id": "session",
        "runtime": "cli",
        "extra": {"completed": True, "turn_id": "turn", "user_message": "fix the bug", "assistant_response": "done"},
    }
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(hermes_event_adapter, "_post", return_value=0) as post:
        assert hermes_event_adapter.main() == 0
    event = post.call_args.args[0]
    assert event["client"] == "hermes-cli"
    assert event["status"] == "completed"
    assert event["metadata"] == {"session_id": "session", "turn_id": "turn", "task_summary": "fix the bug", "answer_source": "done"}


def test_api_error_forwards_failure_metadata_without_request_body():
    payload = {
        "hook_event_name": "api_request_error",
        "session_id": "session",
        "runtime": "cli",
        "extra": {
            "turn_id": "turn",
            "api_request_id": "request",
            "error_type": "TimeoutError",
            "error_message": "upstream failed",
            "status_code": 502,
            "retry_count": 3,
            "request": {"messages": ["private"]},
        },
    }
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(hermes_event_adapter, "_post", return_value=0) as post:
        assert hermes_event_adapter.main() == 0
    event = post.call_args.args[0]
    assert event["event_id"] == "session:api_request_error:request"
    assert event["status"] == "tool_failed"
    assert event["metadata"]["notification_state"] == "diagnostic"
    assert event["error_code"] == "TimeoutError"
    assert event["metadata"]["status_code"] == 502
    assert "private" not in json.dumps(event)


def test_hermes_desktop_runtime_is_kept_separate():
    payload = {"hook_event_name": "on_session_end", "session_id": "session", "runtime": "desktop", "extra": {"completed": True}}
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(hermes_event_adapter, "_post", return_value=0) as post:
        assert hermes_event_adapter.main() == 0
    assert post.call_args.args[0]["client"] == "hermes-desktop"


def test_gateway_platform_in_official_extra_is_hermes_desktop():
    payload = {
        "hook_event_name": "on_session_end",
        "session_id": "session",
        "extra": {"completed": True, "platform": "gateway"},
    }
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(hermes_event_adapter, "_post", return_value=0) as post:
        assert hermes_event_adapter.main() == 0
    assert post.call_args.args[0]["client"] == "hermes-desktop"


def test_tui_session_source_is_hermes_desktop(tmp_path, monkeypatch):
    database = tmp_path / "state.db"
    connection = sqlite3.connect(database)
    connection.execute("CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL)")
    connection.execute("INSERT INTO sessions (id, source) VALUES ('session', 'tui')")
    connection.commit()
    connection.close()
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    payload = {"hook_event_name": "on_session_end", "session_id": "session", "runtime": "cli", "extra": {"completed": True}}

    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(hermes_event_adapter, "_post", return_value=0) as post:
        assert hermes_event_adapter.main() == 0

    assert post.call_args.args[0]["client"] == "hermes-desktop"


def test_windows_utf8_bom_does_not_drop_hermes_hook():
    payload = {"hook_event_name": "api_request_error", "session_id": "session", "runtime": "cli"}
    with patch("sys.stdin", io.StringIO("\ufeff" + json.dumps(payload))), patch.object(hermes_event_adapter, "_post", return_value=0) as post:
        assert hermes_event_adapter.main() == 0
    post.assert_called_once()


def test_persisted_answer_corrects_false_completed_flag_and_supplies_content(tmp_path, monkeypatch):
    database = tmp_path / "state.db"
    connection = sqlite3.connect(database)
    connection.executescript(
        """
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT,
          active INTEGER NOT NULL DEFAULT 1
        );
        INSERT INTO messages (session_id, role, content) VALUES
          ('session', 'user', '只回复 OK'),
          ('session', 'assistant', 'OK');
        """
    )
    connection.close()
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    payload = {
        "hook_event_name": "on_session_end",
        "session_id": "session",
        "runtime": "cli",
        "extra": {"completed": False, "interrupted": False, "platform": "cli"},
    }
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(hermes_event_adapter, "_post", return_value=0) as post:
        assert hermes_event_adapter.main() == 0
    event = post.call_args.args[0]
    assert event["status"] == "completed"
    assert event["metadata"]["task_summary"] == "只回复 OK"
    assert event["metadata"]["answer_source"] == "OK"


def test_interrupted_session_stays_interrupted_even_if_an_older_answer_exists(tmp_path, monkeypatch):
    database = tmp_path / "state.db"
    connection = sqlite3.connect(database)
    connection.executescript(
        """
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT,
          active INTEGER NOT NULL DEFAULT 1
        );
        INSERT INTO messages (session_id, role, content) VALUES
          ('session', 'assistant', 'older turn');
        """
    )
    connection.close()
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    payload = {
        "hook_event_name": "on_session_end",
        "session_id": "session",
        "runtime": "cli",
        "extra": {"completed": False, "interrupted": True},
    }
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(hermes_event_adapter, "_post", return_value=0) as post:
        assert hermes_event_adapter.main() == 0
    assert post.call_args.args[0]["status"] == "interrupted"


def test_previous_turn_answer_does_not_complete_a_new_unanswered_turn(tmp_path, monkeypatch):
    database = tmp_path / "state.db"
    connection = sqlite3.connect(database)
    connection.executescript(
        """
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT,
          active INTEGER NOT NULL DEFAULT 1
        );
        INSERT INTO messages (session_id, role, content) VALUES
          ('session', 'user', 'older question'),
          ('session', 'assistant', 'older answer'),
          ('session', 'user', 'current question');
        """
    )
    connection.close()
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    payload = {
        "hook_event_name": "on_session_end",
        "session_id": "session",
        "runtime": "cli",
        "extra": {"completed": False, "interrupted": False},
    }
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(hermes_event_adapter, "_post", return_value=0) as post:
        assert hermes_event_adapter.main() == 0
    event = post.call_args.args[0]
    assert event["status"] == "failed"
    assert event["metadata"]["task_summary"] == "current question"
    assert "answer_source" not in event["metadata"]


def test_unknown_or_finalize_hooks_are_not_reported_as_task_failure():
    payload = {"hook_event_name": "on_session_finalize", "session_id": "session"}
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(hermes_event_adapter, "_post") as post:
        assert hermes_event_adapter.main() == 0
    post.assert_not_called()


def test_unknown_runtime_is_ignored_instead_of_being_cli():
    payload = {"hook_event_name": "on_session_end", "session_id": "session", "extra": {"completed": True}}
    with patch("sys.stdin", io.StringIO(json.dumps(payload))), patch.object(hermes_event_adapter, "_post") as post:
        assert hermes_event_adapter.main() == 0
    post.assert_not_called()
