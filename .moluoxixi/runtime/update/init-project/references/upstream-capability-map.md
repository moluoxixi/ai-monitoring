# Trellis v0.6.15 Capability Map

Parity baseline: upstream revision `d8fff53ce4964ed1a3e52fea6b418b27eba093e4`.
The non-merge commit reconciliation from `v0.6.7` is recorded in [upstream-reconciliation-v0.6.15.json](upstream-reconciliation-v0.6.15.json).
Behaviors that future upstream synchronization must preserve are recorded in [sync-preservation-contracts.json](sync-preservation-contracts.json), including both local extensions and explicit upstream parity contracts.

| Upstream surface | Moluoxixi surface |
| --- | --- |
| `init` and re-init | `init-project` skill resolves the role-local `@moluoxixi/airules-moluoxixi-cli` package, which executes the bundled initializer without registry access; supports all 22 upstream hosts, developer identity, reviewed monorepo package maps, dry-run, conflict preservation, force, and optional Claude statusline |
| `update` | `.moluoxixi/runtime/moluoxixi.mjs update`; uses the embedded initializer, exact baseline hashes, JSON/block merging, and transactional rollback |
| `upgrade` | Global `airules sync --role moluoxixi`; SessionStart and text context compare the synchronized role version with the project version and direct stale projects to the current `init-project` skill; project runtime never installs an npm CLI |
| `uninstall` | `.moluoxixi/runtime/moluoxixi.mjs uninstall`; manifest-owned files only, with dry-run, interactive confirmation or `--yes`, force kept separate, and modified-file conflicts |
| `workflow` | Project runtime `workflow`; bundled native, local Markdown, or marketplace templates, with modified-file protection and missing-Agent warnings |
| `channel` | Project runtime `channel`; bundled local dispatcher and channel store, typed Codex sandbox overrides, trusted context roots, surfaced Codex turn failures, and post-turn idle shutdown |
| `mem` | Project runtime `mem`; bundled Claude, Codex, Grok, Pi, and ZCode history adapters with compaction-boundary recovery, ZCode read-only SQLite/WAL access, and environment/global/project-local Pi `sessionDir` discovery. The OpenCode reader remains explicitly unavailable in this build. |
| Remote workflow/spec registries | Project initializer `--workflow/--workflow-source` and `--template/--registry`; anonymous public HTTP archives, credential-aware self-hosted/SSH Git, backend-stable workflow reads, typed errors, direct registries, per-package monorepo templates, persisted metadata, and directory-level skip/overwrite/append |
| Versioned migrations | Moluoxixi keeps the complete migration engine: orphan detection, rename, owned rename-dir, delete, safe-file-delete, versioned config sections, complete managed-root snapshots, modified-file sidecar backups, breaking migration gate, and `--migrate` / `--allow-downgrade`. The upstream CLI package retains its historical manifests unchanged; the AIRules initializer uses Moluoxixi's independent migration line beginning at 0.1.0. |
| Bootstrap/onboarding | First-init `00-bootstrap-guidelines` and new-developer `00-join-<slug>` task creation after developer initialization |
| Global setup and MCP | Role-owned CodeGraph install/setup plus JSON/TOML MCP projection for supported hosts; absent during roleless sync |

## Intentional Omissions And Replacements

- AIRules installs the complete upstream core/CLI package trees under the Moluoxixi role with unique package names. Both packages are publishable under the AIRules namespace, while role installation and project initialization continue to run from the complete local role without registry access.
- Project initialization runs the role-local AIRules entry directly and never installs from a registry. Initialized projects receive the self-contained runtime, thin updater, package template subtree, and Moluoxixi overlays required for offline updates.
- Upstream migration manifests remain in the complete CLI package for source parity but are not applied by the AIRules initializer. Moluoxixi starts its own migration line at `0.1.0`.
- Repository-level CI, demos, docs sites, examples, marketplaces, and root release orchestration remain outside the role. Package-local release helpers are retained. Generated-role omissions still include `contribute`, `create-manifest`, `publish-skill`, the Claude `improve-ut` command, and the Claude `gitnexus` skill.
- The upstream marketplace repository payload is not distributed. Runtime workflow/spec marketplace sources remain supported through URLs and Git repositories.
- Worktree/Ralph automation is not an active Moluoxixi runtime surface: the initializer does not project `worktree.yaml` and no worktree/Ralph executor is shipped.

## Host Contract

The initializer reads the upstream package's `src/templates` tree as its sole template source, then applies the hashed Moluoxixi overlay manifest and host projection rules. See [asset-layout.md](asset-layout.md) for the source and output ownership contract.

Codex uses native sub-agent dispatch with `agents.max_depth = 1`, a `SubagentStart` context hook, and preservation of user-selected model keys during updates. Pi, dsh, and Kimi share neutral skills through `.agents/skills/`. OpenCode stores injected workflow/session context as synthetic parts outside user messages. Pull-based implement/check Agents for Gemini, Qoder, Copilot, Pi, ZCode, Trae, Grok, and Kimi receive an explicit active-task/context prelude. Copilot also receives native YAML tool-array frontmatter. Snow uses its native project hooks and agents without the class-2 pull prelude.

The supported host set is Claude, Cursor, OpenCode, Codex, Kilo, Kiro, Gemini, Antigravity, Devin, Qoder, CodeBuddy, GitHub Copilot, Factory Droid, dsh, Pi, Reasonix, ZCode, Trae, OMP, Grok, Kimi, and Snow.

## Project Runtime Contract

The project receives workflow scripts, task lifecycle commands, workspace journals, package-aware specs, channel runtime Agents, managed host assets, and an embedded updater. Unknown files are never adopted except when an explicit registry `--overwrite` replaces its selected spec directory. Modified owned files require explicit force, and project-local update/uninstall preserve user-owned data and managed merge boundaries.
