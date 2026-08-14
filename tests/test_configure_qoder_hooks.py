import json

from scripts.configure_qoder_hooks import configure


def test_qoder_hook_configuration_preserves_existing_and_is_idempotent(tmp_path):
    config = tmp_path / "settings.json"
    config.write_text(json.dumps({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "existing"}]}]}}))
    configure(config, "python qoder_event_adapter.py")
    configure(config, "python qoder_event_adapter.py")
    document = json.loads(config.read_text())
    assert len(document["hooks"]["Stop"]) == 2
    assert all(event in document["hooks"] for event in ("Stop", "PostToolUseFailure"))
    assert "StopFailure" not in document["hooks"]


def test_qoder_hook_configuration_removes_stale_stop_failure_monitor(tmp_path):
    config = tmp_path / "settings.json"
    config.write_text(json.dumps({"hooks": {"StopFailure": [
        {"hooks": [{"type": "command", "command": "python qoder_event_adapter.py"}]},
        {"hooks": [{"type": "command", "command": "existing"}]},
    ]}}))

    configure(config, "python qoder_event_adapter.py")

    document = json.loads(config.read_text())
    assert document["hooks"]["StopFailure"] == [{"hooks": [{"type": "command", "command": "existing"}]}]


def test_qoder_hook_configuration_replaces_stale_monitor_command(tmp_path):
    config = tmp_path / "settings.json"
    config.write_text(json.dumps({"hooks": {"Stop": [
        {"hooks": [{"type": "command", "command": r"D:\\old\\qoder_event_adapter.py"}]},
        {"hooks": [{"type": "command", "command": "existing"}]},
    ]}}))

    configure(config, "D:/new/qoder_event_adapter.py")

    commands = [
        hook["command"]
        for entry in json.loads(config.read_text())["hooks"]["Stop"]
        for hook in entry["hooks"]
    ]
    assert commands == ["existing", "D:/new/qoder_event_adapter.py"]
