from unittest.mock import Mock, patch

from scripts.codex_app_server_proxy import ProtocolMonitor


@patch.object(ProtocolMonitor, "_relay")
def test_failed_turn_is_relayed(relay):
    monitor = ProtocolMonitor()

    monitor.consume({"method": "turn/started", "params": {"threadId": "thread", "turn": {"id": "turn"}}})
    monitor.consume({
        "method": "turn/completed",
        "params": {"threadId": "thread", "turn": {"id": "turn", "status": "failed", "error": {"message": "rate limit"}}},
    })

    relay.assert_called_once()
    assert relay.call_args.args[:4] == (("thread", "turn"), "turn", "failed", "rate limit")


@patch.object(ProtocolMonitor, "_relay")
def test_failed_tool_is_relayed_but_turn_can_complete(relay):
    monitor = ProtocolMonitor()
    monitor.consume({"method": "turn/started", "params": {"threadId": "thread", "turn": {"id": "turn"}}})
    monitor.consume({"method": "item/completed", "params": {
        "threadId": "thread", "turnId": "turn",
        "item": {"id": "tool", "type": "commandExecution", "status": "failed"},
    }})

    relay.assert_called_once_with(
        ("thread", "turn"), "tool", "tool_failed", "failed",
        {"id": "tool", "type": "commandExecution", "status": "failed"},
    )


@patch.object(ProtocolMonitor, "_relay")
def test_transport_close_relays_open_turn_failure(relay):
    monitor = ProtocolMonitor()
    monitor.consume({"method": "turn/started", "params": {"threadId": "thread", "turn": {"id": "turn"}}})

    assert monitor.close_open_turns("transport closed") == 1
    relay.assert_called_once_with(("thread", "turn"), "transport", "api_failed", "transport closed", {})


@patch.object(ProtocolMonitor, "_relay")
def test_nonzero_process_exit_without_turn_is_relayed(relay):
    monitor = ProtocolMonitor()

    monitor.record_process_exit(7)

    relay.assert_called_once_with(
        ("transport", "process"), "exit", "api_failed", "Codex App Server exited with code 7", {},
    )


def test_subagent_protocol_event_is_filtered_before_network_post(monkeypatch):
    monkeypatch.setattr("scripts.codex_app_server_proxy.is_subagent_session", lambda thread_id: thread_id == "subagent")
    monkeypatch.setattr("scripts.codex_app_server_proxy.session_kind", lambda thread_id: None)
    request = Mock()
    request.__enter__ = Mock(return_value=request)
    request.__exit__ = Mock(return_value=False)
    with patch("urllib.request.urlopen", return_value=request) as post:
        ProtocolMonitor._relay(("subagent", "turn"), "turn", "failed", "internal", {})
    post.assert_not_called()
