import json

import pytest
import tomlkit

from scripts.configure_codex_notify import configure, remove


def test_configure_preserves_existing_notify_and_toml(tmp_path):
    config = tmp_path / "config.toml"
    config.write_text('# keep this comment\nmodel = "gpt-test"\nnotify = ["existing.exe", "turn-ended"]\n')
    targets = tmp_path / "targets.json"
    python = tmp_path / "python.exe"
    wrapper = tmp_path / "codex_notify_multiplexer.py"
    configure(config, targets, python, wrapper)

    parsed = tomlkit.parse(config.read_text())
    assert parsed["model"] == "gpt-test"
    assert list(parsed["notify"]) == [str(python.resolve()), str(wrapper.resolve())]
    assert "# keep this comment" in config.read_text()
    assert json.loads(targets.read_text())["targets"] == [["existing.exe", "turn-ended"]]


def test_configure_is_idempotent(tmp_path):
    config = tmp_path / "config.toml"
    config.write_text('notify = ["existing.exe"]\n')
    targets = tmp_path / "targets.json"
    python = tmp_path / "python.exe"
    wrapper = tmp_path / "codex_notify_multiplexer.py"
    configure(config, targets, python, wrapper)
    configure(config, targets, python, wrapper)

    assert json.loads(targets.read_text())["targets"] == [["existing.exe"]]


def test_remove_restores_original_notify_and_preserves_toml(tmp_path):
    config = tmp_path / "config.toml"
    config.write_text('# keep\nmodel = "gpt-test"\nnotify = ["python", "codex_notify_multiplexer.py"]\n')
    targets = tmp_path / "targets.json"
    targets.write_text(json.dumps({"targets": [["existing.exe", "done"]]}))

    assert remove(config, targets) is True
    assert remove(config, targets) is False

    document = tomlkit.parse(config.read_text())
    assert list(document["notify"]) == ["existing.exe", "done"]
    assert document["model"] == "gpt-test"
    assert "# keep" in config.read_text()
    assert not targets.exists()


def test_remove_does_not_override_user_replaced_notify(tmp_path):
    config = tmp_path / "config.toml"
    config.write_text('notify = ["user-new.exe"]\n')
    targets = tmp_path / "targets.json"
    targets.write_text(json.dumps({"targets": [["user-old.exe"]]}))

    assert remove(config, targets) is False
    assert list(tomlkit.parse(config.read_text())["notify"]) == ["user-new.exe"]
    assert targets.exists()


def test_remove_rejects_multiple_saved_targets_without_writing(tmp_path):
    config = tmp_path / "config.toml"
    original = 'notify = ["python", "codex_notify_multiplexer.py"]\n'
    config.write_text(original)
    targets = tmp_path / "targets.json"
    targets.write_text(json.dumps({"targets": [["one"], ["two"]]}))

    with pytest.raises(ValueError, match="multiple Codex notify targets"):
        remove(config, targets)

    assert config.read_text() == original
    assert targets.exists()
