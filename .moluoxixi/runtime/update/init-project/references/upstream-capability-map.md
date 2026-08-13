# Trellis v0.6.7 Capability Map

Parity baseline: upstream revision `e7c5ead4d0dfd717d11a40b6bc0c80d8af94c49a`.

| Upstream surface | Moluoxixi surface |
| --- | --- |
| `init` and re-init | `init-project` skill plus `scripts/init-project.mjs`; supports 18 hosts, developer identity, reviewed monorepo package maps, dry-run, conflict preservation, force, and optional Claude statusline |
| `update` | `.moluoxixi/runtime/moluoxixi.mjs update`; uses the embedded initializer, exact baseline hashes, JSON/block merging, and transactional rollback |
| `upgrade` | Global `airules sync --role moluoxixi`; project runtime never installs an npm CLI |
| `uninstall` | `.moluoxixi/runtime/moluoxixi.mjs uninstall`; manifest-owned files only, with dry-run, interactive confirmation or `--yes`, force kept separate, and modified-file conflicts |
| `workflow` | Project runtime `workflow`; bundled native, local Markdown, or marketplace templates, with modified-file protection and missing-Agent warnings |
| `channel` | Project runtime `channel`; bundled local dispatcher and channel store |
| `mem` | Project runtime `mem`; bundled Claude, Codex, and Pi history adapters, including environment/global/project-local Pi `sessionDir` discovery |
| Remote workflow/spec registries | Project initializer `--workflow/--workflow-source` and `--template/--registry`; anonymous public HTTP archives, credential-aware self-hosted/SSH Git, backend-stable workflow reads, typed errors, direct registries, per-package monorepo templates, persisted metadata, and directory-level skip/overwrite/append |
| Versioned migrations | Moluoxixi keeps the complete migration engine: orphan detection, rename, owned rename-dir, delete, safe-file-delete, versioned config sections, complete managed-root snapshots, modified-file sidecar backups, breaking migration gate, and `--migrate` / `--allow-downgrade`. Version 0.1.0 is the initial baseline, so no upstream release manifests are inherited. |
| Bootstrap/onboarding | First-init `00-bootstrap-guidelines` and new-developer `00-join-<slug>` task creation after developer initialization |
| Global setup and MCP | Role-owned CodeGraph install/setup plus JSON/TOML MCP projection for supported hosts; absent during roleless sync |

## Intentional Omissions And Replacements

- The official npm CLI and package workspace are not distributed. AIRules owns global role upgrades, while the embedded initializer and project-local runtime own project operations.
- Upstream release-specific migration manifests and historical project-state transitions are not inherited. Moluoxixi starts its own migration line at `0.1.0` while retaining the migration engine.
- Repository and maintainer tooling is omitted, including upstream CI/release assets, demos, docs sites, examples, package workspaces, `contribute`, `create-manifest`, `publish-skill`, the Claude `improve-ut` command, and the Claude `gitnexus` skill.
- The upstream marketplace repository payload is not distributed. Runtime workflow/spec marketplace sources remain supported through URLs and Git repositories.
- Worktree/Ralph automation is not an active Moluoxixi runtime surface: the initializer does not project `worktree.yaml` and no worktree/Ralph executor is shipped.

## Host Contract

The initializer maintains native templates independently under `assets/hosts/<host>` and reusable projection sources under `assets/core`. See [asset-layout.md](asset-layout.md) for the source and output ownership contract.

Pull-based implement/check Agents for Codex, Gemini, Qoder, Copilot, Pi, ZCode, and Trae receive an explicit active-task/context prelude. Copilot also receives native YAML tool-array frontmatter. Hook-based hosts retain their native hook or plugin context injection.

The supported host set is Claude, Cursor, OpenCode, Codex, Kilo, Kiro, Gemini, Antigravity, Devin, Qoder, CodeBuddy, GitHub Copilot, Factory Droid, Pi, Reasonix, ZCode, Trae, and OMP.

## Project Runtime Contract

The project receives workflow scripts, task lifecycle commands, workspace journals, package-aware specs, channel runtime Agents, managed host assets, and an embedded updater. Unknown files are never adopted except when an explicit registry `--overwrite` replaces its selected spec directory. Modified owned files require explicit force, and project-local update/uninstall preserve user-owned data and managed merge boundaries.
