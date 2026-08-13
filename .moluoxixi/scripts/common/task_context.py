#!/usr/bin/env python3
"""
Task JSONL context management.

Provides:
    cmd_add_context   - Add entry to JSONL context file
    cmd_validate      - Validate JSONL context files
    cmd_list_context  - List JSONL context entries

Note:
    ``cmd_init_context`` was removed in v0.5.0-beta.12. JSONL context files
    are now seeded at ``task.py create`` time with a self-describing
    ``_example`` line; the AI agent curates real entries during planning when
    the task needs sub-agent/spec context. See ``.moluoxixi/workflow.md`` for the
    current planning artifact contract.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path, PurePosixPath

from .log import Colors, colored
from .paths import get_repo_root
from .task_utils import resolve_task_dir


def _resolve_context_path(
    value: object,
    repo_root: Path,
    task_dir: Path,
) -> tuple[Path, str] | None:
    """Resolve a context path only when it is reviewed project knowledge."""
    if not isinstance(value, str) or not value.strip() or "\0" in value:
        return None
    normalized = value.strip().replace("\\", "/").rstrip("/")
    relative = PurePosixPath(normalized)
    if (
        not normalized
        or relative.is_absolute()
        or any(part in ("", ".", "..") for part in relative.parts)
        or (relative.parts and relative.parts[0].endswith(":"))
    ):
        return None

    unresolved = repo_root.joinpath(*relative.parts)
    current = repo_root
    for part in relative.parts:
        current = current / part
        if current.exists() and current.is_symlink():
            return None

    resolved = unresolved.resolve()
    allowed_roots = [
        (repo_root / ".moluoxixi" / "spec").resolve(),
        (task_dir / "research").resolve(),
    ]
    if not any(resolved == root or root in resolved.parents for root in allowed_roots):
        return None
    try:
        canonical = resolved.relative_to(repo_root.resolve()).as_posix()
    except ValueError:
        return None
    return resolved, canonical


def _inspect_context_file(
    jsonl_file: Path,
    repo_root: Path,
    task_dir: Path,
) -> tuple[list[tuple[dict, Path, str]], list[str]]:
    """Return validated real entries and line-specific errors."""
    entries: list[tuple[dict, Path, str]] = []
    errors: list[str] = []
    if not jsonl_file.is_file():
        return entries, errors
    for line_number, line in enumerate(
        jsonl_file.read_text(encoding="utf-8").splitlines(), start=1
    ):
        if not line.strip():
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            errors.append(f"line {line_number}: invalid JSON")
            continue
        if not isinstance(data, dict):
            errors.append(f"line {line_number}: entry must be a JSON object")
            continue
        if not data.get("file"):
            continue
        resolved = _resolve_context_path(data.get("file"), repo_root, task_dir)
        if resolved is None:
            errors.append(
                f"line {line_number}: path must be under .moluoxixi/spec/ "
                f"or {task_dir.relative_to(repo_root).as_posix()}/research/"
            )
            continue
        full_path, canonical = resolved
        entry_type = data.get("type", "file")
        if entry_type not in ("file", "directory"):
            errors.append(f"line {line_number}: type must be file or directory")
        elif entry_type == "directory" and not full_path.is_dir():
            errors.append(f"line {line_number}: directory not found: {canonical}")
        elif entry_type == "file" and not full_path.is_file():
            errors.append(f"line {line_number}: file not found: {canonical}")
        else:
            entries.append((data, full_path, canonical))
    return entries, errors


def planning_readiness_errors(
    task_dir: Path,
    repo_root: Path,
    task_data: dict,
    require_context: bool,
) -> list[str]:
    """Return deterministic planning gate failures without changing state."""
    errors: list[str] = []
    complexity = task_data.get("complexity")
    level = complexity.get("level") if isinstance(complexity, dict) else None
    if level not in ("lightweight", "complex"):
        errors.append(
            "complexity is unclassified; run task.py set-complexity <task> lightweight|complex"
        )

    prd_file = task_dir / "prd.md"
    if not prd_file.is_file() or not prd_file.read_text(encoding="utf-8").strip():
        errors.append("prd.md is required and must not be empty")

    if level == "complex":
        for artifact in ("design.md", "implement.md"):
            target = task_dir / artifact
            if not target.is_file() or not target.read_text(encoding="utf-8").strip():
                errors.append(f"{artifact} is required for complex tasks")
        if require_context:
            for context_name in ("implement.jsonl", "check.jsonl"):
                context_file = task_dir / context_name
                entries, context_errors = _inspect_context_file(
                    context_file, repo_root, task_dir
                )
                for error in context_errors:
                    errors.append(f"{context_name} {error}")
                if not any(data.get("type", "file") == "file" for data, _, _ in entries):
                    errors.append(
                        f"{context_name} requires at least one curated spec/research file entry"
                    )

    return errors


# =============================================================================
# Command: add-context
# =============================================================================

def cmd_add_context(args: argparse.Namespace) -> int:
    """Add entry to JSONL context file."""
    repo_root = get_repo_root()
    target_dir = resolve_task_dir(args.dir, repo_root)

    jsonl_name = args.file
    context_path = args.path
    reason = args.reason or "Added manually"

    if not target_dir.is_dir():
        print(colored(f"Error: Directory not found: {target_dir}", Colors.RED))
        return 1

    # Support shorthand
    if not jsonl_name.endswith(".jsonl"):
        jsonl_name = f"{jsonl_name}.jsonl"
    if jsonl_name not in ("implement.jsonl", "check.jsonl"):
        print(colored(
            "Error: Context manifest must be implement.jsonl or check.jsonl",
            Colors.RED,
        ))
        return 1

    jsonl_file = target_dir / jsonl_name
    resolved = _resolve_context_path(context_path, repo_root, target_dir)
    if resolved is None:
        print(colored(
            "Error: Context path must be under .moluoxixi/spec/ or the current task's research/ directory",
            Colors.RED,
        ))
        return 1
    full_path, path = resolved

    entry_type = "file"
    if full_path.is_dir():
        entry_type = "directory"
        if not path.endswith("/"):
            path = f"{path}/"
    elif not full_path.is_file():
        print(colored(f"Error: Path not found: {path}", Colors.RED))
        return 1

    # Check if already exists
    if jsonl_file.is_file():
        content = jsonl_file.read_text(encoding="utf-8")
        if f'"{path}"' in content:
            print(colored(f"Warning: Entry already exists for {path}", Colors.YELLOW))
            return 0

    # Add entry
    entry: dict
    if entry_type == "directory":
        entry = {"file": path, "type": "directory", "reason": reason}
    else:
        entry = {"file": path, "reason": reason}

    with jsonl_file.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    print(colored(f"Added {entry_type}: {path}", Colors.GREEN))
    return 0


# =============================================================================
# Command: validate
# =============================================================================

def cmd_validate(args: argparse.Namespace) -> int:
    """Validate JSONL context files."""
    repo_root = get_repo_root()
    target_dir = resolve_task_dir(args.dir, repo_root)

    if not target_dir.is_dir():
        print(colored("Error: task directory required", Colors.RED))
        return 1

    print(colored("=== Validating Context Files ===", Colors.BLUE))
    print(f"Target dir: {target_dir}")
    print()

    total_errors = 0
    for jsonl_name in ["implement.jsonl", "check.jsonl"]:
        jsonl_file = target_dir / jsonl_name
        errors = _validate_jsonl(jsonl_file, repo_root)
        total_errors += errors

    print()
    if total_errors == 0:
        print(colored("✓ All validations passed", Colors.GREEN))
        return 0
    else:
        print(colored(f"✗ Validation failed ({total_errors} errors)", Colors.RED))
        return 1


def _validate_jsonl(jsonl_file: Path, repo_root: Path) -> int:
    """Validate a single JSONL file.

    Seed rows (no ``file`` field — typically ``{"_example": "..."}``) are
    skipped silently; they are self-describing comments, not real entries.
    """
    file_name = jsonl_file.name
    errors = 0

    if not jsonl_file.is_file():
        print(f"  {colored(f'{file_name}: not found (skipped)', Colors.YELLOW)}")
        return 0

    entries, validation_errors = _inspect_context_file(
        jsonl_file, repo_root, jsonl_file.parent
    )
    errors = len(validation_errors)
    for error in validation_errors:
        print(f"  {colored(f'{file_name} {error}', Colors.RED)}")

    if errors == 0:
        print(f"  {colored(f'{file_name}: ✓ ({len(entries)} entries)', Colors.GREEN)}")
    else:
        print(f"  {colored(f'{file_name}: ✗ ({errors} errors)', Colors.RED)}")

    return errors


# =============================================================================
# Command: list-context
# =============================================================================

def cmd_list_context(args: argparse.Namespace) -> int:
    """List JSONL context entries."""
    repo_root = get_repo_root()
    target_dir = resolve_task_dir(args.dir, repo_root)

    if not target_dir.is_dir():
        print(colored("Error: task directory required", Colors.RED))
        return 1

    print(colored("=== Context Files ===", Colors.BLUE))
    print()

    for jsonl_name in ["implement.jsonl", "check.jsonl"]:
        jsonl_file = target_dir / jsonl_name
        if not jsonl_file.is_file():
            continue

        print(colored(f"[{jsonl_name}]", Colors.CYAN))

        count = 0
        seed_only = True
        for line in jsonl_file.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue

            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue

            file_path = data.get("file")
            if not file_path:
                # Seed / comment row — don't count as a real entry
                continue
            seed_only = False

            count += 1
            entry_type = data.get("type", "file")
            reason = data.get("reason", "-")

            if entry_type == "directory":
                print(f"  {colored(f'{count}.', Colors.GREEN)} [DIR] {file_path}")
            else:
                print(f"  {colored(f'{count}.', Colors.GREEN)} {file_path}")
            print(f"     {colored('→', Colors.YELLOW)} {reason}")

        if seed_only:
            print(f"  {colored('(no curated entries yet — only seed row)', Colors.YELLOW)}")

        print()

    return 0
