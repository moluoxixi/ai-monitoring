"""Configure one Codex notify command that safely fans out to multiple targets."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import tomlkit


WRAPPER_MARKER = "codex_notify_multiplexer.py"


def _load_targets(targets_path: Path) -> list[list[str]]:
    if not targets_path.exists():
        return []
    try:
        loaded = json.loads(targets_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid Codex notify targets JSON: {targets_path}") from exc
    raw_targets = loaded.get("targets", []) if isinstance(loaded, dict) else None
    if not isinstance(raw_targets, list) or any(not isinstance(target, list) for target in raw_targets):
        raise ValueError(f"invalid Codex notify targets schema: {targets_path}")
    return [[str(arg) for arg in target] for target in raw_targets]


def _is_managed_notify(command: list[str]) -> bool:
    return any(WRAPPER_MARKER in argument.lower() for argument in command)


def configure(
    config_path: Path,
    targets_path: Path,
    python_path: Path,
    wrapper_path: Path,
) -> None:
    document = tomlkit.parse(config_path.read_text(encoding="utf-8")) if config_path.exists() else tomlkit.document()
    wrapper_command = [str(python_path.resolve()), str(wrapper_path.resolve())]
    current = [str(value) for value in document.get("notify", [])]

    saved_targets = _load_targets(targets_path)

    if current != wrapper_command and not _is_managed_notify(current):
        original_targets = [current] if current else []
    else:
        original_targets = saved_targets

    targets: list[list[str]] = []
    for target in original_targets:
        if not target or any(any(marker in argument.lower() for marker in ("arize", "phoenix")) for argument in target):
            continue
        if target not in targets:
            targets.append(target)
    targets_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = targets_path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"targets": targets}, indent=2) + "\n", encoding="utf-8")
    temporary.replace(targets_path)

    document["notify"] = wrapper_command
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(tomlkit.dumps(document), encoding="utf-8")


def remove(config_path: Path, targets_path: Path) -> bool:
    try:
        document = tomlkit.parse(config_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return False
    current = [str(value) for value in document.get("notify", [])]
    if not _is_managed_notify(current):
        return False
    saved_targets = _load_targets(targets_path)
    if len(saved_targets) > 1:
        raise ValueError("cannot restore multiple Codex notify targets to one notify command")
    if saved_targets:
        document["notify"] = saved_targets[0]
    else:
        document.pop("notify", None)
    config_path.write_text(tomlkit.dumps(document), encoding="utf-8")
    targets_path.unlink(missing_ok=True)
    return True


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--targets", type=Path, required=True)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--wrapper", type=Path, required=True)
    args = parser.parse_args()
    configure(args.config, args.targets, args.python, args.wrapper)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
