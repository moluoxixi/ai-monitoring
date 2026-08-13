# Bundled Skills

Moluoxixi keeps role skills under `roles/moluoxixi/skills/<name>/`. AIRules discovers that canonical root through `role.yaml`, copies complete skill directories to the role vendor, and projects them to each supported host. A skill directory may contain `SKILL.md`, `scripts/`, `references/`, and `assets/`.

The `init-project` writer also places project-facing Moluoxixi skills into each selected platform root. It uses the same local `channel`, `meta`, and `session-insight` trees that AIRules distributes at role level, so their runtime commands and references stay aligned.

## Current Runtime Skills

| Skill | Purpose |
| --- | --- |
| `init-project` | Initialize or extend a project and install the self-contained runtime. |
| `channel` | Durable multi-agent channels, worker lifecycle, forum/thread boards, and debugging. |
| `session-insight` | Read-only search and extraction over local Claude, Codex, and Pi sessions. |
| `meta` | Explain and customize the generated architecture. |
| `spec-bootstrap` | Build or refresh `.moluoxixi/spec/` from the project codebase. |

Other workflow skills such as `start`, `before-dev`, and `finish-work` are also projected from the canonical role skill root.

## Project Destinations

The initializer selects the native skill directory for each platform. Important examples:

| Platform | Skill root |
| --- | --- |
| Claude Code | `.claude/skills/` |
| Cursor | `.cursor/skills/` |
| Codex and Gemini | `.agents/skills/` |
| OpenCode | `.opencode/skills/` |
| GitHub Copilot | `.github/skills/` |
| Pi | `.pi/skills/` |

All files written by AIRules are recorded in `.moluoxixi/airules-init-manifest.json`. A later `node "<skill-root>/scripts/moluoxixi.mjs" update` reruns the project-local initializer and preserves modified or unknown files unless `--force` is explicit.

## Add Or Change A Role Skill

1. Create or edit `roles/moluoxixi/skills/<name>/`.
2. Keep `SKILL.md` focused on triggering and procedure; put detailed material in directly linked `references/` files.
3. Put deterministic executable helpers under `scripts/` and output templates under `assets/`.
4. For a project-facing bundled runtime skill, add its directory to `addBundledSkills()` in `skills/init-project/scripts/init-project.mjs` or ensure the generic bundled-skill source selects it.
5. Put role-specific tests in `roles/moluoxixi/__test__/`.
6. Verify a fresh initialization and a second project-local update produce no changes or conflicts.

Do not edit the raw `.agents` copy to customize Moluoxixi behavior. That tree is retained as an upstream hash boundary. Make role-owned changes under `roles/moluoxixi/skills/`.

## Project-Local Overrides

Project teams may add a differently named skill directly under a platform skill root. AIRules does not claim ownership of unknown files. Editing an AIRules-managed bundled skill is also allowed, but the next update reports it as a conflict and preserves it by default.

Use `.moluoxixi/spec/` for durable project conventions. Use a project-local skill for project-specific procedures. Keep public role skills free of private project content.
