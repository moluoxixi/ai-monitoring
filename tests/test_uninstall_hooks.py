import json
from pathlib import Path

import pytest
import tomlkit
import yaml

from scripts.uninstall_hooks import MANIFEST_SCHEMA_VERSION, remove_integrations, restore_backup


def _write_manifest(backup_dir: Path, entries: list[dict[str, object]]) -> None:
    backup_dir.mkdir()
    (backup_dir / "manifest.json").write_text(json.dumps({
        "schemaVersion": MANIFEST_SCHEMA_VERSION,
        "createdAt": "2026-08-19T00:00:00Z",
        "files": entries,
    }), encoding="utf-8")


def _expected_paths(entries: list[dict[str, object]]) -> dict[str, set[Path]]:
    return {str(entry["id"]): {Path(str(entry["path"]))} for entry in entries}


def test_remove_integrations_is_idempotent_across_all_clients(tmp_path: Path):
    codex_config = tmp_path / "codex.toml"
    codex_targets = tmp_path / "targets.json"
    claude = tmp_path / "claude.json"
    qoder = tmp_path / "qoder.json"
    hermes = tmp_path / "hermes.yaml"
    cursor = tmp_path / "cursor.json"
    codex_config.write_text('notify = ["python", "codex_notify_multiplexer.py"]\n')
    codex_targets.write_text('{"targets": [["original.exe"]]}\n')
    claude.write_text(json.dumps({"hooks": {"Stop": [{"hooks": [
        {"type": "command", "command": "claude_event_adapter.py"},
    ]}]}}))
    qoder.write_text(json.dumps({"hooks": {"Stop": [{"hooks": [
        {"type": "command", "command": "qoder_event_adapter.py"},
    ]}]}}))
    hermes.write_text(yaml.safe_dump({"hooks": {"on_session_end": [
        {"command": "hermes_event_adapter.py"},
    ]}}))
    cursor.write_text(json.dumps({"hooks": {"stop": [
        {"type": "command", "command": "cursor_event_adapter.py"},
    ]}}))
    paths = {
        "codex_config": codex_config,
        "codex_targets": codex_targets,
        "claude_config": claude,
        "qoder_config": qoder,
        "hermes_config": hermes,
        "cursor_config": cursor,
    }

    assert remove_integrations(**paths) == {
        "codex": True,
        "claude": True,
        "qoder": True,
        "hermes": True,
        "cursor": True,
    }
    assert remove_integrations(**paths) == {
        "codex": False,
        "claude": False,
        "qoder": False,
        "hermes": False,
        "cursor": False,
    }


def test_restore_backup_restores_existing_and_cleans_new_managed_entries(tmp_path: Path):
    backup_dir = tmp_path / "backup"
    codex_config = tmp_path / "codex.toml"
    codex_targets = tmp_path / "targets.json"
    claude = tmp_path / "claude.json"
    qoder = tmp_path / "qoder.json"
    hermes = tmp_path / "hermes.yaml"
    cursor = tmp_path / "cursor.json"
    entries = [
        {"id": "codex-config", "path": str(codex_config), "existed": True, "backupFile": "codex-config.toml"},
        {"id": "codex-notify-targets", "path": str(codex_targets), "existed": False, "backupFile": "codex-notify-targets.json"},
        {"id": "claude-settings", "path": str(claude), "existed": False, "backupFile": "claude-settings.json"},
        {"id": "qoder-settings", "path": str(qoder), "existed": True, "backupFile": "qoder-settings.json"},
        {"id": "hermes-config", "path": str(hermes), "existed": False, "backupFile": "hermes-config.yaml"},
        {"id": "cursor-hooks", "path": str(cursor), "existed": False, "backupFile": "cursor-hooks.json"},
    ]
    _write_manifest(backup_dir, entries)
    (backup_dir / "codex-config.toml").write_text('model = "before"\nnotify = ["original.exe"]\n')
    (backup_dir / "qoder-settings.json").write_text('{"user": "before"}\n')

    codex_config.write_text('notify = ["python", "codex_notify_multiplexer.py"]\n')
    codex_targets.write_text('{"targets": [["original.exe"]]}\n')
    claude.write_text(json.dumps({"user": True, "hooks": {"Stop": [{"hooks": [
        {"type": "command", "command": "claude_event_adapter.py"},
        {"type": "command", "command": "keep"},
    ]}]}}))
    qoder.write_text('{"changed": true}\n')
    hermes.write_text(yaml.safe_dump({"user": True, "hooks": {"on_session_end": [
        {"command": "hermes_event_adapter.py"}, {"command": "keep"},
    ]}}))
    cursor.write_text(json.dumps({"version": 1, "user": True, "hooks": {"stop": [
        {"command": "cursor_event_adapter.py"}, {"command": "keep"},
    ]}}))

    results = restore_backup(backup_dir, _expected_paths(entries))

    assert tomlkit.parse(codex_config.read_text())["model"] == "before"
    assert list(tomlkit.parse(codex_config.read_text())["notify"]) == ["original.exe"]
    assert not codex_targets.exists()
    assert json.loads(claude.read_text())["hooks"]["Stop"][0]["hooks"] == [
        {"type": "command", "command": "keep"},
    ]
    assert json.loads(qoder.read_text()) == {"user": "before"}
    assert yaml.safe_load(hermes.read_text())["hooks"]["on_session_end"] == [{"command": "keep"}]
    assert json.loads(cursor.read_text())["hooks"]["stop"] == [{"command": "keep"}]
    assert results["codex-config"] == "restored"


def test_restore_backup_rejects_incomplete_manifest(tmp_path: Path):
    backup_dir = tmp_path / "backup"
    _write_manifest(backup_dir, [])

    with pytest.raises(ValueError, match="missing managed files"):
        restore_backup(backup_dir, {})


def test_restore_backup_rejects_manifest_target_outside_expected_paths(tmp_path: Path):
    backup_dir = tmp_path / "backup"
    target = tmp_path / "unexpected.toml"
    entries = [
        {"id": "codex-config", "path": str(target), "existed": False, "backupFile": "codex-config.toml"},
        {"id": "codex-notify-targets", "path": str(tmp_path / "targets.json"), "existed": False, "backupFile": "codex-notify-targets.json"},
        {"id": "claude-settings", "path": str(tmp_path / "claude.json"), "existed": False, "backupFile": "claude-settings.json"},
        {"id": "qoder-settings", "path": str(tmp_path / "qoder.json"), "existed": False, "backupFile": "qoder-settings.json"},
        {"id": "hermes-config", "path": str(tmp_path / "hermes.yaml"), "existed": False, "backupFile": "hermes-config.yaml"},
        {"id": "cursor-hooks", "path": str(tmp_path / "cursor.json"), "existed": False, "backupFile": "cursor-hooks.json"},
    ]
    _write_manifest(backup_dir, entries)
    expected = _expected_paths(entries)
    expected["codex-config"] = {tmp_path / "allowed.toml"}

    with pytest.raises(ValueError, match="unexpected path"):
        restore_backup(backup_dir, expected)

    assert not target.exists()


def test_restore_backup_preflights_all_required_backup_files(tmp_path: Path):
    backup_dir = tmp_path / "backup"
    codex_config = tmp_path / "codex.toml"
    entries = [
        {"id": "codex-config", "path": str(codex_config), "existed": True, "backupFile": "codex-config.toml"},
        {"id": "codex-notify-targets", "path": str(tmp_path / "targets.json"), "existed": False, "backupFile": "codex-notify-targets.json"},
        {"id": "claude-settings", "path": str(tmp_path / "claude.json"), "existed": False, "backupFile": "claude-settings.json"},
        {"id": "qoder-settings", "path": str(tmp_path / "qoder.json"), "existed": True, "backupFile": "qoder-settings.json"},
        {"id": "hermes-config", "path": str(tmp_path / "hermes.yaml"), "existed": False, "backupFile": "hermes-config.yaml"},
        {"id": "cursor-hooks", "path": str(tmp_path / "cursor.json"), "existed": False, "backupFile": "cursor-hooks.json"},
    ]
    _write_manifest(backup_dir, entries)
    (backup_dir / "codex-config.toml").write_text('model = "backup"\n')
    codex_config.write_text('model = "current"\n')

    with pytest.raises(ValueError, match="backup file not found"):
        restore_backup(backup_dir, _expected_paths(entries))

    assert codex_config.read_text() == 'model = "current"\n'
