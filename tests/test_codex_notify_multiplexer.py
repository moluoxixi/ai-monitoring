import json
from unittest.mock import Mock, patch

from scripts import codex_notify_multiplexer


def test_completion_relay_omits_prompt_content():
    payload = {
        "type": "agent-turn-complete",
        "thread-id": "thread",
        "turn-id": "turn",
        "last-assistant-message": "sensitive answer",
        "input-messages": ["sensitive prompt"],
    }
    response = Mock()
    response.__enter__ = Mock(return_value=response)
    response.__exit__ = Mock(return_value=False)
    with patch("urllib.request.urlopen", return_value=response), patch("urllib.request.Request") as request:
        codex_notify_multiplexer.relay_completion(payload)

    body = json.loads(request.call_args.args[1])
    assert body["status"] == "completed"
    assert body["metadata"] == {"thread_id": "thread", "turn_id": "turn"}
    assert "sensitive" not in json.dumps(body)


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
