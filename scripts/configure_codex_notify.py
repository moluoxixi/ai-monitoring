"""Configure one Codex notify command that safely fans out to multiple targets."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import tomlkit


def configure(
    config_path: Path,
    targets_path: Path,
    python_path: Path,
    wrapper_path: Path,
    arize_hook: Path,
) -> None:
    document = tomlkit.parse(config_path.read_text(encoding="utf-8")) if config_path.exists() else tomlkit.document()
    wrapper_command = [str(python_path.resolve()), str(wrapper_path.resolve())]
    current = [str(value) for value in document.get("notify", [])]

    saved_targets: list[list[str]] = []
    if targets_path.exists():
        loaded = json.loads(targets_path.read_text(encoding="utf-8"))
        saved_targets = [[str(arg) for arg in target] for target in loaded.get("targets", [])]

    resolved_arize_hook = str(arize_hook.resolve())
    if current != wrapper_command and not any("codex_notify_multiplexer.py" in arg for arg in current):
        original_targets = [current] if current and current != [resolved_arize_hook] else []
    else:
        original_targets = [target for target in saved_targets if resolved_arize_hook not in target]

    targets = original_targets + [[resolved_arize_hook]]
    targets_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = targets_path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"targets": targets}, indent=2) + "\n", encoding="utf-8")
    temporary.replace(targets_path)

    document["notify"] = wrapper_command
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(tomlkit.dumps(document), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--targets", type=Path, required=True)
    parser.add_argument("--python", type=Path, required=True)
    parser.add_argument("--wrapper", type=Path, required=True)
    parser.add_argument("--arize-hook", type=Path, required=True)
    args = parser.parse_args()
    configure(args.config, args.targets, args.python, args.wrapper, args.arize_hook)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
