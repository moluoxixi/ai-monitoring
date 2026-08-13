# Supported Platforms

Pass one or more IDs to `--platform`, separated by commas.

| ID | Primary output |
| --- | --- |
| `claude` | `.claude/` |
| `cursor` | `.cursor/` |
| `opencode` | `.opencode/` |
| `codex` | `.codex/` and `.agents/skills/` |
| `kilo` | `.kilocode/` |
| `kiro` | `.kiro/` |
| `gemini` | `.gemini/` and `.agents/skills/` |
| `antigravity` | `.agent/` |
| `devin` | `.devin/` |
| `qoder` | `.qoder/` |
| `codebuddy` | `.codebuddy/` |
| `copilot` | `.github/agents`, `.github/copilot`, `.github/hooks`, `.github/prompts`, `.github/skills` |
| `droid` | `.factory/` |
| `pi` | `.pi/` |
| `reasonix` | `.reasonix/` |
| `zcode` | `.zcode/` |
| `trae` | `.trae/` |
| `omp` | `.omp/` |

`claude-code` is accepted as an alias for `claude`. The deprecated upstream ID `windsurf` is accepted as an alias for `devin`. `all` expands to every ID above.

The initializer always creates the project-local `.moluoxixi/` runtime, root managed AI instructions, a managed Moluoxixi usage block in `README.md`, project specs, workspace index, and task root.
