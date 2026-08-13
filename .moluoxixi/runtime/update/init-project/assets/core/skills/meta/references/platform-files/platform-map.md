# Platform File Map

This page lists common Moluoxixi file locations in a user project by platform. Whether a platform directory exists in an actual project depends on which `init-project --platform <id>` selections the user ran.

## Matrix

| Platform | Selection | Main directory | Skill directory | Agent directory | Hooks/extensions |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `--platform claude` | `.claude/` | `.claude/skills/` | `.claude/agents/` | `.claude/hooks/` + `.claude/settings.json` |
| Cursor | `--platform cursor` | `.cursor/` | `.cursor/skills/` | `.cursor/agents/` | `.cursor/hooks.json` + `.cursor/hooks/` |
| OpenCode | `--platform opencode` | `.opencode/` | `.opencode/skills/` | `.opencode/agents/` | `.opencode/plugins/` |
| Codex | `--platform codex` | `.codex/` | `.agents/skills/` and `.codex/skills/` | `.codex/agents/` | `.codex/hooks/` + `.codex/hooks.json` |
| Kilo | `--platform kilo` | `.kilocode/` | `.kilocode/skills/` | None | `.kilocode/workflows/` |
| Kiro | `--platform kiro` | `.kiro/` | `.kiro/skills/` | `.kiro/agents/` | `.kiro/hooks/` |
| Gemini CLI | `--platform gemini` | `.gemini/` | `.agents/skills/` | `.gemini/agents/` | `.gemini/settings.json` + `.gemini/hooks/` |
| Antigravity | `--platform antigravity` | `.agent/` | `.agent/skills/` | None | `.agent/workflows/` |
| Devin | `--platform devin` | `.devin/` | `.devin/skills/` | None | `.devin/workflows/` |
| Qoder | `--platform qoder` | `.qoder/` | `.qoder/skills/` | `.qoder/agents/` | `.qoder/hooks/` + `.qoder/settings.json` |
| CodeBuddy | `--platform codebuddy` | `.codebuddy/` | `.codebuddy/skills/` | `.codebuddy/agents/` | `.codebuddy/hooks/` + `.codebuddy/settings.json` |
| GitHub Copilot | `--platform copilot` | `.github/` | `.github/skills/` | `.github/agents/` | `.github/copilot/hooks/` + `.github/prompts/` |
| Factory Droid | `--platform droid` | `.factory/` | `.factory/skills/` | `.factory/droids/` | `.factory/hooks/` + settings |
| Pi Agent | `--platform pi` | `.pi/` | `.pi/skills/` | `.pi/agents/` | `.pi/extensions/moluoxixi/` + `.pi/settings.json` |
| Reasonix | `--platform reasonix` | `.reasonix/` | `.reasonix/skills/` | Sub-agents are skills with `runAs: subagent` | None |
| ZCode | `--platform zcode` | `.zcode/` | `.zcode/skills/` | `.zcode/agents/` | Pull-based context prelude |
| Trae | `--platform trae` | `.trae/` | `.trae/skills/` | `.trae/agents/` | `.trae/hooks/` + `.trae/hooks.json` |
| OMP | `--platform omp` | `.omp/` | `.omp/skills/` | `.omp/agents/` | `.omp/extensions/moluoxixi/` |

## Capability Groups

### Moluoxixi Sub-Agent Support

These platforms usually have `moluoxixi-research`, `moluoxixi-implement`, and `moluoxixi-check` files:

- Claude Code
- Cursor
- OpenCode
- Codex
- Kiro
- Gemini CLI
- Qoder
- CodeBuddy
- GitHub Copilot
- Factory Droid
- Pi Agent
- Reasonix (delivered as skills with `runAs: subagent` under `.reasonix/skills/`, not as a separate `agents/` directory)
- ZCode

When changing implementation/check/research behavior, look for the corresponding platform agent files first.

### Native Moluoxixi Sub-Agent Tool

Some platforms expose a first-class tool that the host runtime understands. The model calls it like any other tool and the host renders progress cards, validates the agent name against `.<platform>/agents/`, and enforces dispatch modes.

- Pi Agent — `moluoxixi_subagent` tool, defined in `.pi/extensions/moluoxixi/index.ts`. Supports `single` / `parallel` / `chain` dispatch modes and emits live `moluoxixi-subagent-progress` events.

When changing sub-agent dispatch behavior on these platforms, edit the extension file, **not** the agent markdown — the agent markdown defines responsibilities, but the host extension owns dispatch, validation, and progress rendering.

### Main-Session Workflow Platforms

These platforms rely more on workflows/skills to guide the main session:

- Kilo
- Antigravity
- Devin

When changing behavior, inspect workflows and skills first. Do not assume Moluoxixi sub-agents exist.

### Core `.agents/skills/`

Codex writes the shared `.agents/skills/` layer. Some tools that support agentskills.io can also read this directory. If the user wants multiple compatible tools to share one skill, consider `.agents/skills/` first, but do not assume every platform reads it.

## Decision Rules When Modifying Platform Files

1. User specified a platform: modify only that platform directory unless shared workflow/spec files must also change.
2. User says "all platforms should do this": synchronize equivalent entry points platform by platform; do not modify only one directory.
3. User only says "my AI": inspect the configuration directories that actually exist in the project and infer the current AI platform.
4. User wants project rules: prefer `.moluoxixi/spec/` or a project-local skill.
5. User wants Moluoxixi behavior: edit `.moluoxixi/workflow.md` plus platform hooks/agents/skills/commands.

## When Paths Differ

Platform ecosystems change, and user projects may already be customized. If this table disagrees with local files, use the actual settings/config in the user project as authoritative:

- Check the hook that settings registers.
- Check the script that a command/prompt/workflow points to.
- Judge behavior by the read rules currently written in the agent file.

Do not delete a custom file just because it is not listed in this path table.
