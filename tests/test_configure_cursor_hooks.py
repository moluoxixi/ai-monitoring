import json

from scripts.configure_cursor_hooks import configure


def test_cursor_hook_configuration_preserves_existing_and_replaces_stale_monitor(tmp_path):
    config = tmp_path / "hooks.json"
    config.write_text(json.dumps({"version": 1, "hooks": {"stop": [
        {"command": "node existing.mjs"},
        {"type": "command", "command": r"D:\\old\\cursor_event_adapter.py"},
    ]}}))

    configure(config, "D:/new/cursor_event_adapter.py")
    configure(config, "D:/new/cursor_event_adapter.py")

    document = json.loads(config.read_text())
    assert [entry["command"] for entry in document["hooks"]["stop"]] == [
        "node existing.mjs", "D:/new/cursor_event_adapter.py",
    ]
    assert document["hooks"]["postToolUseFailure"] == [
        {"type": "command", "command": "D:/new/cursor_event_adapter.py"},
    ]
    assert document["hooks"]["afterAgentResponse"] == []
