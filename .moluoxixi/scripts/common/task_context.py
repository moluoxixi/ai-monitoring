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

from .config import get_context_injection_limits
from .git import branch_exists_locally
from .io import read_json
from .log import Colors, colored
from .paths import DIR_ARCHIVE, DIR_TASKS, DIR_WORKFLOW, FILE_TASK_JSON, get_repo_root
from .task_utils import resolve_task_dir


_CODE_FILE_EXTENSIONS = {
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".py",
    ".go",
    ".rs",
    ".java",
    ".rb",
    ".c",
    ".cc",
    ".cpp",
    ".h",
}


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
    archive_parts = task_dir.resolve().relative_to(repo_root.resolve()).parts
    archive_prefix = (DIR_WORKFLOW, DIR_TASKS, DIR_ARCHIVE)
    if len(archive_parts) == 5 and archive_parts[:3] == archive_prefix:
        historical_root = (DIR_WORKFLOW, DIR_TASKS, task_dir.name)
        if relative.parts[:3] == historical_root:
            unresolved = task_dir.joinpath(*relative.parts[3:])

    current = unresolved.anchor and Path(unresolved.anchor) or Path()
    for part in unresolved.parts[1:] if unresolved.anchor else unresolved.parts:
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

    if not target_dir or not target_dir.is_dir():
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

    if not target_dir or not target_dir.is_dir():
        print(colored("Error: task directory required", Colors.RED))
        return 1

    print(colored("=== Validating Context Files ===", Colors.BLUE))
    print(f"Target dir: {target_dir}")
    print()

    task_json_path = target_dir / FILE_TASK_JSON
    if task_json_path.is_file():
        task_data = read_json(task_json_path)
        stored_branch = task_data.get("branch") if task_data else None
        if stored_branch and not branch_exists_locally(stored_branch, repo_root):
            print(
                colored(
                    f"Warning: recorded branch '{stored_branch}' no longer exists locally "
                    "(likely merged and deleted).",
                    Colors.YELLOW,
                )
            )
            print()

    total_errors = 0
    for jsonl_name in ["implement.jsonl", "check.jsonl"]:
        jsonl_file = target_dir / jsonl_name
        errors = _validate_jsonl(jsonl_file, repo_root, target_dir)
        total_errors += errors

    print()
    if total_errors == 0:
        print(colored("✓ All validations passed", Colors.GREEN))
        return 0
    else:
        print(colored(f"✗ Validation failed ({total_errors} errors)", Colors.RED))
        return 1


def _is_exempt_from_code_file_warning(file_path: str, task_rel: str) -> bool:
    """Return whether a context entry is expected project knowledge."""
    posix_path = file_path.replace("\\", "/").lstrip("/")
    exempt_prefixes = (".moluoxixi/spec/", "docs/", "docs-site/")
    if posix_path.startswith(exempt_prefixes):
        return True
    return bool(
        task_rel
        and (posix_path == task_rel or posix_path.startswith(f"{task_rel}/"))
    )


def _resolve_context_entry_path(
    file_path: str, repo_root: Path, task_dir: Path | None
) -> Path | None:
    """Bind exact historical self-references to an archived task copy."""
    repo_path = repo_root / file_path
    if task_dir is None:
        return repo_path

    try:
        task_parts = task_dir.resolve().relative_to(repo_root.resolve()).parts
    except ValueError:
        return repo_path

    archive_prefix = (DIR_WORKFLOW, DIR_TASKS, DIR_ARCHIVE)
    if len(task_parts) != 5 or task_parts[:3] != archive_prefix:
        return repo_path

    year_month = task_parts[3]
    if (
        len(year_month) != 7
        or year_month[4] != "-"
        or not year_month[:4].isdigit()
        or not year_month[5:].isdigit()
    ):
        return repo_path

    historical_root = f"{DIR_WORKFLOW}/{DIR_TASKS}/{task_dir.name}"
    posix_path = file_path.replace("\\", "/")
    if posix_path == historical_root:
        relative_parts: tuple[str, ...] = ()
    elif posix_path.startswith(f"{historical_root}/"):
        relative_path = posix_path[len(historical_root) + 1 :]
        if relative_path.endswith("/"):
            relative_path = relative_path[:-1]
        relative_parts = tuple(relative_path.split("/")) if relative_path else ()
        if any(part in ("", ".", "..") for part in relative_parts):
            return None
    else:
        return repo_path

    try:
        archive_root = task_dir.resolve()
        resolved_path = task_dir.joinpath(*relative_parts).resolve()
        resolved_path.relative_to(archive_root)
    except (OSError, RuntimeError, ValueError):
        return None
    return resolved_path


def _validate_jsonl(jsonl_file: Path, repo_root: Path, task_dir: Path) -> int:
    """Validate a single JSONL file.

    Seed rows (no ``file`` field — typically ``{"_example": "..."}``) are
    skipped silently; they are self-describing comments, not real entries.

    Validation keeps repository-wide references compatible with existing
    manifests. The stricter spec/research-only policy remains in
    ``_inspect_context_file`` for task start readiness and ``add-context``.
    """
    file_name = jsonl_file.name
    errors = 0

    if not jsonl_file.is_file():
        print(f"  {colored(f'{file_name}: not found (skipped)', Colors.YELLOW)}")
        return 0

    try:
        task_rel = task_dir.resolve().relative_to(repo_root.resolve()).as_posix()
    except ValueError:
        task_rel = ""
    max_file_bytes = get_context_injection_limits(repo_root).get("max_file_bytes", 0)

    real_entries = 0
    for line_num, line in enumerate(
        jsonl_file.read_text(encoding="utf-8").splitlines(), start=1
    ):
        if not line.strip():
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            print(f"  {colored(f'{file_name}:{line_num}: Invalid JSON', Colors.RED)}")
            errors += 1
            continue

        file_path = data.get("file") if isinstance(data, dict) else None
        if not file_path:
            continue
        real_entries += 1

        full_path = _resolve_context_entry_path(file_path, repo_root, task_dir)
        entry_type = data.get("type", "file")
        if entry_type == "directory":
            if full_path is None or not full_path.is_dir():
                message = f"{file_name}:{line_num}: Directory not found: {file_path}"
                print(f"  {colored(message, Colors.RED)}")
                errors += 1
            continue

        if full_path is None or not full_path.is_file():
            message = f"{file_name}:{line_num}: File not found: {file_path}"
            print(f"  {colored(message, Colors.RED)}")
            errors += 1
            continue

        extension = Path(file_path).suffix.lower()
        if extension in _CODE_FILE_EXTENSIONS and not _is_exempt_from_code_file_warning(
            file_path, task_rel
        ):
            warning = (
                f"{file_name}:{line_num}: Warning: {file_path} looks like a code file — "
                "implement/check.jsonl should reference spec/research docs; "
                "agents read code themselves"
            )
            print(f"  {colored(warning, Colors.YELLOW)}")

        if max_file_bytes:
            size = full_path.stat().st_size
            if size > max_file_bytes:
                warning = (
                    f"{file_name}:{line_num}: Warning: {file_path} is {size} bytes, "
                    f"exceeds context_injection.max_file_bytes ({max_file_bytes}); "
                    "injection will truncate it"
                )
                print(f"  {colored(warning, Colors.YELLOW)}")

    if errors == 0:
        print(f"  {colored(f'{file_name}: ✓ ({real_entries} entries)', Colors.GREEN)}")
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

    if not target_dir or not target_dir.is_dir():
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
