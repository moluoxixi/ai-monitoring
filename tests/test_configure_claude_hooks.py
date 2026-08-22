import json

from scripts.configure_claude_hooks import configure, remove


def test_claude_hook_configuration_preserves_existing_and_is_idempotent(tmp_path):
    config = tmp_path / "settings.json"
    config.write_text(json.dumps({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "existing"}]}]}}))
    configure(config, "python claude_event_adapter.py")
    configure(config, "python claude_event_adapter.py")
    document = json.loads(config.read_text())
    assert len(document["hooks"]["Stop"]) == 2
    assert all(event in document["hooks"] for event in ("Stop", "StopFailure", "PostToolUseFailure"))


def test_claude_hook_configuration_replaces_stale_monitor_commands(tmp_path):
    config = tmp_path / "settings.json"
    config.write_text(json.dumps({"hooks": {"Stop": [
        {"hooks": [{"type": "command", "command": r"C:\\old\\claude_event_adapter.py"}]},
        {"hooks": [{"type": "command", "command": "existing"}]},
    ]}}))

    configure(config, "D:/new/claude_event_adapter.py")

    commands = [
        hook["command"]
        for entry in json.loads(config.read_text())["hooks"]["Stop"]
        for hook in entry["hooks"]
    ]
    assert commands == ["existing", "D:/new/claude_event_adapter.py"]


def test_remove_claude_hook_preserves_other_nested_commands_and_is_idempotent(tmp_path):
    config = tmp_path / "settings.json"
    config.write_text(json.dumps({"model": "keep", "hooks": {"Stop": [{"hooks": [
        {"type": "command", "command": "python claude_event_adapter.py"},
        {"type": "command", "command": "keep-me"},
    ]}], "PreToolUse": [{"hooks": [{"type": "command", "command": "guard"}]}]}}))

    assert remove(config) is True
    assert remove(config) is False

    document = json.loads(config.read_text())
    assert document["model"] == "keep"
    assert document["hooks"]["Stop"] == [{"hooks": [{"type": "command", "command": "keep-me"}]}]
    assert document["hooks"]["PreToolUse"] == [{"hooks": [{"type": "command", "command": "guard"}]}]


def test_remove_claude_hook_does_not_create_missing_config(tmp_path):
    config = tmp_path / "settings.json"
    assert remove(config) is False
    assert not config.exists()
