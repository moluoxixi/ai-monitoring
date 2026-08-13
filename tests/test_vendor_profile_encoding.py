import importlib.util
from pathlib import Path


VENDOR_MODULE = (
    Path(__file__).parents[1]
    / "data"
    / "vendor"
    / "coding-harness-tracing"
    / "tracing"
    / "codex"
    / "install_legacy.py"
)


def test_utf16_profile_without_marker_is_unchanged(tmp_path, monkeypatch):
    vendor_root = VENDOR_MODULE.parents[2]
    monkeypatch.syspath_prepend(str(vendor_root))
    spec = importlib.util.spec_from_file_location("vendor_install_legacy", VENDOR_MODULE)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    profile = tmp_path / ".bashrc"
    original = "export TEST=value\n"
    profile.write_text(original, encoding="utf-16")

    assert module._remove_profile_block(profile) is False
    assert profile.read_text(encoding="utf-16") == original


def test_utf16_profile_marker_is_removed_without_encoding_change(tmp_path, monkeypatch):
    vendor_root = VENDOR_MODULE.parents[2]
    monkeypatch.syspath_prepend(str(vendor_root))
    spec = importlib.util.spec_from_file_location("vendor_install_legacy_marked", VENDOR_MODULE)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    profile = tmp_path / ".bashrc"
    profile.write_text(
        "before\n# >>> arize codex tracing PATH >>>\nmanaged\n# <<< arize codex tracing PATH <<<\nafter\n",
        encoding="utf-16",
    )

    assert module._remove_profile_block(profile) is True
    assert profile.read_bytes().startswith(b"\xff\xfe")
    assert "arize codex tracing" not in profile.read_text(encoding="utf-16")
