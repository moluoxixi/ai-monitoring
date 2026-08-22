from pathlib import Path

import yaml

from scripts.configure_hermes_hooks import configure, remove


def test_hermes_configuration_uses_exact_adapter_marker(tmp_path: Path):
    config = tmp_path / "config.yaml"
    config.write_text(yaml.safe_dump({"hooks": {"on_session_end": [
        {"command": "python user-ai-monitor-report.py", "timeout": 5},
        {"command": "python old/hermes_event_adapter.py", "timeout": 10},
    ]}}), encoding="utf-8")

    configure(config, "python new/hermes_event_adapter.py --runtime cli")

    entries = yaml.safe_load(config.read_text(encoding="utf-8"))["hooks"]["on_session_end"]
    assert entries == [
        {"command": "python user-ai-monitor-report.py", "timeout": 5},
        {"command": "python new/hermes_event_adapter.py --runtime cli", "timeout": 10},
    ]


def test_remove_hermes_hook_preserves_other_hooks_and_is_idempotent(tmp_path: Path):
    config = tmp_path / "config.yaml"
    config.write_text(yaml.safe_dump({"model": "keep", "hooks": {
        "on_session_end": [
            {"command": "python hermes_event_adapter.py", "timeout": 10},
            {"command": "python user-ai-monitor-report.py", "timeout": 5},
        ],
        "on_tool_call": [{"command": "guard"}],
    }}), encoding="utf-8")

    assert remove(config) is True
    assert remove(config) is False

    document = yaml.safe_load(config.read_text(encoding="utf-8"))
    assert document["model"] == "keep"
    assert document["hooks"]["on_session_end"] == [
        {"command": "python user-ai-monitor-report.py", "timeout": 5},
    ]
    assert document["hooks"]["on_tool_call"] == [{"command": "guard"}]


def test_remove_hermes_hook_does_not_create_missing_config(tmp_path: Path):
    config = tmp_path / "config.yaml"
    assert remove(config) is False
    assert not config.exists()
