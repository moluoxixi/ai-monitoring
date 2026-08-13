from unittest.mock import Mock, patch

from opentelemetry.trace import StatusCode

from scripts.codex_app_server_to_phoenix import ProtocolMonitor


@patch.object(ProtocolMonitor, "_relay")
def test_failed_turn_sets_error_status(relay):
    tracer = Mock()
    span = Mock()
    tracer.start_span.return_value = span
    monitor = ProtocolMonitor(tracer)

    monitor.consume({"method": "turn/started", "params": {"threadId": "thread", "turn": {"id": "turn"}}})
    monitor.consume({
        "method": "turn/completed",
        "params": {"threadId": "thread", "turn": {"id": "turn", "status": "failed", "error": {"message": "rate limit"}}},
    })

    status = span.set_status.call_args.args[0]
    assert status.status_code is StatusCode.ERROR
    assert status.description == "rate limit"
    span.end.assert_called_once()
    relay.assert_called_once()


@patch.object(ProtocolMonitor, "_relay")
def test_failed_tool_sets_error_but_turn_can_complete(relay):
    tracer = Mock()
    turn_span = Mock()
    tool_span = Mock()
    tracer.start_span.side_effect = [turn_span, tool_span]
    monitor = ProtocolMonitor(tracer)
    monitor.consume({"method": "turn/started", "params": {"threadId": "thread", "turn": {"id": "turn"}}})
    monitor.consume({"method": "item/started", "params": {"threadId": "thread", "turnId": "turn", "item": {"id": "tool", "type": "commandExecution"}}})
    monitor.consume({"method": "item/completed", "params": {"threadId": "thread", "turnId": "turn", "item": {"id": "tool", "type": "commandExecution", "status": "failed"}}})

    tool_status = tool_span.set_status.call_args.args[0]
    assert tool_status.status_code is StatusCode.ERROR
    relay.assert_called_once()


@patch.object(ProtocolMonitor, "_relay")
def test_transport_close_marks_open_turn_and_relays_failure(relay):
    tracer = Mock()
    span = Mock()
    tracer.start_span.return_value = span
    monitor = ProtocolMonitor(tracer)
    monitor.consume({"method": "turn/started", "params": {"threadId": "thread", "turn": {"id": "turn"}}})

    assert monitor.close_open_turns("transport closed") == 1

    status = span.set_status.call_args.args[0]
    assert status.status_code is StatusCode.ERROR
    relay.assert_called_once_with(("thread", "turn"), "transport", "api_failed", "transport closed", {})


@patch.object(ProtocolMonitor, "_relay")
def test_nonzero_process_exit_without_turn_creates_error_span(relay):
    tracer = Mock()
    span = Mock()
    tracer.start_span.return_value = span
    monitor = ProtocolMonitor(tracer)

    monitor.record_process_exit(7)

    status = span.set_status.call_args.args[0]
    assert status.status_code is StatusCode.ERROR
    relay.assert_called_once()
