import json

from scripts.configure_cursor_hooks import configure, remove


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


def test_remove_cursor_hook_preserves_user_entries_and_root_fields(tmp_path):
    config = tmp_path / "hooks.json"
    config.write_text(json.dumps({"version": 1, "custom": True, "hooks": {
        "afterAgentResponse": [{"type": "command", "command": "old cursor_event_adapter.py"}],
        "stop": [
            {"type": "command", "command": "cursor_event_adapter.py"},
            {"type": "command", "command": "keep"},
        ],
        "beforeSubmitPrompt": [{"type": "command", "command": "guard"}],
    }}))

    assert remove(config) is True
    assert remove(config) is False

    document = json.loads(config.read_text())
    assert document["custom"] is True
    assert document["hooks"]["stop"] == [{"type": "command", "command": "keep"}]
    assert "afterAgentResponse" not in document["hooks"]
    assert document["hooks"]["beforeSubmitPrompt"] == [{"type": "command", "command": "guard"}]
