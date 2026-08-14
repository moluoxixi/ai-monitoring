import json
from unittest.mock import Mock, patch

from scripts import codex_notify_multiplexer


def test_completion_relay_includes_task_and_temporary_answer_source():
    payload = {
        "type": "agent-turn-complete",
        "thread-id": "thread",
        "turn-id": "turn",
        "last-assistant-message": "private answer",
        "input-messages": ["<in-app-browser-context>ignore</in-app-browser-context> ## My request:  explain   the failing build  "],
    }
    response = Mock()
    response.__enter__ = Mock(return_value=response)
    response.__exit__ = Mock(return_value=False)
    with patch("urllib.request.urlopen", return_value=response), patch("urllib.request.Request") as request:
        assert codex_notify_multiplexer.relay_completion(payload) is True

    body = json.loads(request.call_args.args[1])
    assert body["status"] == "completed"
    assert body["message"] == "提问：explain the failing build"
    assert body["metadata"] == {
        "thread_id": "thread", "turn_id": "turn", "task_summary": "explain the failing build",
        "answer_source": "private answer",
    }


def test_completion_without_a_task_summary_is_left_to_the_session_watcher():
    payload = {
        "type": "agent-turn-complete",
        "thread-id": "thread",
        "turn-id": "turn",
        "last-assistant-message": "private answer",
    }
    with patch("urllib.request.urlopen") as post:
        assert codex_notify_multiplexer.relay_completion(payload) is False
    post.assert_not_called()


def test_subagent_completion_is_not_relayed():
    payload = {
        "type": "agent-turn-complete",
        "thread-id": "subagent-thread",
        "turn-id": "turn",
        "input-messages": ["internal review"],
    }
    with patch.object(codex_notify_multiplexer, "is_subagent_session", return_value=True), patch.object(codex_notify_multiplexer, "session_kind", return_value="subagent"), patch("urllib.request.urlopen") as post:
        assert codex_notify_multiplexer.relay_completion(payload) is False
    post.assert_not_called()


def test_subagent_completion_is_not_fanned_out_to_legacy_targets(monkeypatch):
    payload = json.dumps({
        "type": "agent-turn-complete",
        "thread-id": "subagent-thread",
        "turn-id": "turn",
    })
    monkeypatch.setattr(codex_notify_multiplexer, "is_subagent_session", lambda thread_id: True)
    monkeypatch.setattr(codex_notify_multiplexer, "session_kind", lambda thread_id: "subagent")
    monkeypatch.setattr(codex_notify_multiplexer, "load_targets", lambda: [["target.exe"]])
    monkeypatch.setattr(codex_notify_multiplexer.sys, "argv", ["wrapper", payload])
    with patch.object(codex_notify_multiplexer.subprocess, "run") as run, patch.object(codex_notify_multiplexer, "relay_completion") as relay:
        assert codex_notify_multiplexer.main() == 0
    run.assert_not_called()
    relay.assert_not_called()


def test_desktop_completion_is_owned_by_the_session_watcher(monkeypatch):
    payload = {
        "type": "agent-turn-complete",
        "thread-id": "desktop-thread",
        "turn-id": "turn",
        "input-messages": ["desktop task"],
    }
    monkeypatch.setattr(codex_notify_multiplexer, "is_subagent_session", lambda thread_id: False)
    monkeypatch.setattr(codex_notify_multiplexer, "session_kind", lambda thread_id: "codex-desktop")
    with patch("urllib.request.urlopen") as post:
        assert codex_notify_multiplexer.relay_completion(payload) is False
    post.assert_not_called()


def test_task_summary_has_a_strict_length_limit():
    assert len(codex_notify_multiplexer.summarize_task("a" * 2_100)) == 2_000
    assert codex_notify_multiplexer.summarize_task(
        "The following is the Codex agent history whose request action you are assessing."
    ) == ""


def test_answer_source_keeps_only_the_last_24000_characters():
    assert codex_notify_multiplexer.answer_source("a" * 25000) == "a" * 24000
    assert codex_notify_multiplexer.answer_source(None) == ""


def test_main_isolates_target_failure(monkeypatch, capsys):
    payload = json.dumps({"type": "agent-turn-complete", "thread-id": "thread", "turn-id": "turn"})
    monkeypatch.setattr(codex_notify_multiplexer, "load_targets", lambda: [["missing.exe"], ["ok.exe"]])
    monkeypatch.setattr(codex_notify_multiplexer.subprocess, "run", Mock(side_effect=[OSError("missing"), None]))
    monkeypatch.setattr(codex_notify_multiplexer, "relay_completion", Mock())
    monkeypatch.setattr(codex_notify_multiplexer.sys, "argv", ["wrapper", payload])

    assert codex_notify_multiplexer.main() == 0
    assert codex_notify_multiplexer.subprocess.run.call_count == 2
    codex_notify_multiplexer.relay_completion.assert_called_once()
    assert "missing" in capsys.readouterr().err
