<!-- MOLUOXIXI:COPILOT-GUIDANCE:START -->
# Moluoxixi Review Guidance

When reviewing a Moluoxixi-enabled repository:

- Treat Moluoxixi-generated runtime and platform payloads as copied integration files in consumer repositories. Examples include `.moluoxixi/scripts/**`, `.moluoxixi/agents/**`, `.moluoxixi/workflow.md`, and platform Moluoxixi files under `.agents/**`, `.claude/**`, `.codex/**`, `.cursor/**`, `.gemini/**`, `.github/**`, `.opencode/**`, `.qoder/**`, `.codebuddy/**`, `.factory/**`, `.pi/**`, `.reasonix/**`, `.trae/**`, and `.zcode/**`.
- Do not leave line-by-line style, wording, or local refactor comments on those copied files unless the PR explicitly changes Moluoxixi integration, the copied file is the primary subject, it leaks secrets, it has syntax or wiring breakage, or it contradicts the PR goal.
- If a Moluoxixi-generated file needs a behavior change, leave one handoff comment asking for an upstream Moluoxixi fix. Include the affected path, expected behavior, observed evidence or reproduction steps, and why the fix belongs upstream.
- Continue reviewing repo-owned `.moluoxixi/spec/**`, `.moluoxixi/tasks/**`, application code, migrations, tests, docs, and non-Moluoxixi scripts normally.
- Group duplicate root-cause findings into one comment and point to a deterministic local check when one already covers the issue class.
<!-- MOLUOXIXI:COPILOT-GUIDANCE:END -->
