import json

from scripts.configure_qoder_hooks import configure


def test_qoder_hook_configuration_preserves_existing_and_is_idempotent(tmp_path):
    config = tmp_path / "settings.json"
    config.write_text(json.dumps({"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "existing"}]}]}}))
    configure(config, "python qoder_event_adapter.py")
    configure(config, "python qoder_event_adapter.py")
    document = json.loads(config.read_text())
    assert len(document["hooks"]["Stop"]) == 2
    assert all(event in document["hooks"] for event in ("Stop", "StopFailure", "PostToolUseFailure"))
