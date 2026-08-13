# Agents

Moluoxixi agent files define specialized roles. Common Moluoxixi agents in a user project are:

- `moluoxixi-research`
- `moluoxixi-implement`
- `moluoxixi-check`
- `moluoxixi-frontend`
- `moluoxixi-backend`
- `moluoxixi-test`
- `moluoxixi-security`
- `moluoxixi-database`

File locations and formats differ by platform, but responsibility boundaries should stay consistent.

## Agent Responsibilities

| Agent | Responsibility |
| --- | --- |
| `moluoxixi-research` | Investigate the question and write findings into the current task's `research/`. |
| `moluoxixi-implement` | Implement against `prd.md`, optional `design.md` / `implement.md`, `implement.jsonl`, and related spec/research. |
| `moluoxixi-check` | Review changes, fix discovered issues, and run necessary checks. |
| `moluoxixi-frontend` | Own an approved frontend slice: UI boundaries, client state, accessibility, and browser validation. |
| `moluoxixi-backend` | Own an approved backend slice: APIs, domain logic, reliability, and contract validation. |
| `moluoxixi-test` | Independently add or improve tests and report production defects without changing production code. |
| `moluoxixi-security` | Independently review trust boundaries and persist severity-ranked findings under task research. |
| `moluoxixi-database` | Own approved schema, migration, query, rollout, rollback, and data-safety work. |

Agent files should not become generic chat prompts. They should define input sources, write boundaries, whether code may be changed, and how results are reported.

## Common Paths

| Platform | Agent path |
| --- | --- |
| Claude Code | `.claude/agents/moluoxixi-*.md` |
| Cursor | `.cursor/agents/moluoxixi-*.md` |
| OpenCode | `.opencode/agents/moluoxixi-*.md` |
| Codex | `.codex/agents/moluoxixi-*.toml` |
| Kiro | `.kiro/agents/moluoxixi-*.json` |
| Gemini CLI | `.gemini/agents/moluoxixi-*.md` |
| Qoder | `.qoder/agents/moluoxixi-*.md` |
| CodeBuddy | `.codebuddy/agents/moluoxixi-*.md` |
| Factory Droid | `.factory/droids/moluoxixi-*.md` |
| Pi Agent | `.pi/agents/moluoxixi-*.md` |
| Reasonix | `.reasonix/skills/moluoxixi-*/SKILL.md` (subagent frontmatter) |
| ZCode | `.zcode/agents/moluoxixi-*.md` |
| Trae | `.trae/agents/moluoxixi-*.md` |
| Oh My Pi | `.omp/agents/moluoxixi-*.md` |

GitHub Copilot agent/prompt support is provided by a combination of directories such as `.github/agents/`, `.github/prompts/`, and `.github/skills/`; inspect the files actually generated in the user project.

Main-session workflow platforms such as Kilo, Antigravity, and Devin may not have Moluoxixi sub-agent files. They usually rely on workflows/skills to guide the main session.

Professional agents are optional and scope-driven. Keep `research / implement / check` as the workflow backbone. Dispatch frontend, backend, database, test, or security only when the approved task materially needs that boundary. Language expertise remains in skills loaded by the selected agent rather than multiplying agents per language.

## Two Context Loading Modes

### hook push

The platform hook injects task context before the agent starts. The agent file itself can focus more on responsibilities and boundaries.

Common on platforms that support agent hooks.

### agent pull

The agent file instructs the agent to read after startup:

- `python ./.moluoxixi/scripts/task.py current --source`
- `implement.jsonl` or `check.jsonl`
- spec/research files referenced by JSONL
- current task `prd.md`
- `design.md` if present
- `implement.md` if present

This mode fits platforms whose hooks cannot reliably rewrite sub-agent prompts.

## Local Change Scenarios

| User need | Edit location |
| --- | --- |
| Implement agent must follow extra restrictions | The platform's `moluoxixi-implement` agent file. |
| Check agent must run project-specific commands | `moluoxixi-check` agent file, and `.moluoxixi/spec/` if needed. |
| Research agent must output a fixed format | `moluoxixi-research` agent file. |
| Agent cannot read task context | Agent prelude or `inject-subagent-context` hook. |
| Add a project-specific agent | Platform agent directory + related workflow/command/skill entry point. |

## Modification Principles

1. **Keep responsibilities single-purpose**. Do not mix research, implement, and check responsibilities into one agent.
2. **Specify the read order**. Agents must know to start from the active task, read jsonl/spec context, then read `prd.md`, `design.md` if present, and `implement.md` if present.
3. **Specify write boundaries**. Research usually only writes `research/`; implement can write code; check can fix issues.
4. **Keep semantics synchronized in multi-platform projects**. If the user configured Claude, Codex, and Cursor together, decide whether changes to one platform's agent also need to be applied to others.

## Do Not Default To Editing Upstream Templates

Local AI should default to modifying platform agent files inside the user project. Discuss upstream template source only when the user explicitly wants to contribute the change back to Moluoxixi.
