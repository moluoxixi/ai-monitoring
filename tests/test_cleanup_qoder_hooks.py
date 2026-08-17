import json

from scripts.cleanup_qoder_hooks import cleanup


def test_cleanup_preserves_unrelated_hooks_and_is_idempotent(tmp_path):
    config = tmp_path / "settings.json"
    config.write_text(json.dumps({"hooks": {
        "Stop": [
            {"hooks": [
                {"type": "command", "command": "python qoder_event_adapter.py --runtime cli"},
                {"type": "command", "command": "existing"},
            ]},
            {"hooks": [{"type": "command", "command": "another"}]},
        ],
        "PreToolUse": [{"hooks": [{"type": "command", "command": "guard"}]}],
    }}), encoding="utf-8")

    assert cleanup(config) is True
    assert cleanup(config) is False

    document = json.loads(config.read_text(encoding="utf-8"))
    assert document["hooks"]["Stop"] == [
        {"hooks": [{"type": "command", "command": "existing"}]},
        {"hooks": [{"type": "command", "command": "another"}]},
    ]
    assert document["hooks"]["PreToolUse"] == [{"hooks": [{"type": "command", "command": "guard"}]}]


def test_cleanup_removes_all_legacy_event_variants(tmp_path):
    config = tmp_path / "settings.json"
    config.write_text(json.dumps({"hooks": {
        event: [{"hooks": [{"type": "command", "command": r"D:\\old\\qoder_event_adapter.py"}]}]
        for event in ("Stop", "PostToolUseFailure", "StopFailure")
    }}), encoding="utf-8")

    assert cleanup(config) is True
    assert json.loads(config.read_text(encoding="utf-8")) == {}


def test_cleanup_does_not_create_missing_settings(tmp_path):
    config = tmp_path / "settings.json"

    assert cleanup(config) is False
    assert not config.exists()
