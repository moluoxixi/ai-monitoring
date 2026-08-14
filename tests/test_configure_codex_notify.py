import json

import tomlkit

from scripts.configure_codex_notify import configure


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
