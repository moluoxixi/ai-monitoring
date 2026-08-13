# Spec Task Planning

Use a single agent as the default execution model. The agent may create Moluoxixi tasks for traceability, but the skill should not require a specific platform, CLI, or parallel worker model.

## Decomposition

Create spec work units around real ownership boundaries:

- One package when a package has its own conventions.
- One layer when the same package has distinct frontend, backend, CLI, worker, or shared-library rules.
- One cross-cutting guide when a pattern spans packages and is not owned by one layer.

Avoid artificial decomposition. A small library usually needs one focused spec pass, not several tasks.

## Task Shape

When a Moluoxixi task is useful, write a concise PRD with these sections:

```markdown
# Propose <package-or-layer> Moluoxixi Specs

## Goal
Prepare project-specific guidance candidates for <scope> and submit them for human review.

## Scope
- Spec directory:
- Source directories to inspect:
- Tests to inspect:
- Out of scope:

## Architecture Context
Summarize the concrete findings from repository analysis.

## Formal Targets To Propose
- `.moluoxixi/spec/.../index.md`
- `.moluoxixi/spec/.../<topic>.md`

## Rules
- Adapt the spec file set to the real codebase.
- Use real source examples with file paths.
- Remove template-only sections that do not apply.
- Do not modify product source code unless the task explicitly asks for it.
- Do not modify `.moluoxixi/spec/` directly; submit complete targets to `.moluoxixi/spec-proposals/`.

## Acceptance Criteria
- [ ] Candidates contain concrete examples and anti-patterns from the repository.
- [ ] No placeholder text remains.
- [ ] Proposed index files match the proposed target set.
- [ ] Claims are backed by source files, tests, or project docs.
```

## Optional Helper Agents

If the host supports subagents, helpers can inspect independent packages or run verification. They are optional. The main agent still owns integration and final quality.

Helper tasks must have clear ownership:

- Read-only research tasks may inspect any source needed for the assigned scope.
- Candidate-writing tasks should own disjoint task-local research paths.
- Verification tasks should check placeholder removal, broken links, and consistency.

Do not encode helper-agent names, vendor-specific commands, or platform-specific routing in the skill. Put only the required work and acceptance criteria in the task.
