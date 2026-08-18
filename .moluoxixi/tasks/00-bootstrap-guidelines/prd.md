# Bootstrap Task: Fill Project Development Guidelines

**You (the AI) are running this task. The developer does not read this file.**

The developer just ran `moluoxixi init` on this project. Populate
`.moluoxixi/spec/` with the team's real coding conventions.
Document current repository conventions directly in the matching spec files.

## Status

- [ ] Fill backend guidelines
- [ ] Fill frontend guidelines
- [ ] Add real code examples

## Spec files to populate

Backend projects should document directory structure, database access, error
handling, logging, review standards, and testing. Frontend projects should
document component organization, component and hook patterns, state ownership,
type safety, linting, testing, and accessibility. For a monorepo, do this under
each approved package scope. The pre-filled thinking guides should change only
when they clearly do not fit this repository.

## Process

1. Import existing convention files first: AGENTS.md, CLAUDE.md, Cursor rules,
   Copilot instructions, CONTRIBUTING.md, .editorconfig, and equivalent docs.
2. Scan real code for anything not covered. Find 2-3 real examples for every
   documented pattern and reference their paths.
3. Document current reality, including known debt; do not write aspirational rules.
4. Use `moluoxixi-spec-bootstrap` to analyze the repository and fill each target spec with real examples.
5. Review the resulting specs with the developer and revise rules that do not match the repository.

## Runtime mechanics

- Every task carries implement.jsonl and check.jsonl context manifests.
- Project hooks inject those spec files plus the task PRD into implementation and
  verification prompts.
- The project spec directory is the convention source of truth; empty specs lead
  to generic output, while examples from real code reproduce team patterns.

When the spec files contain real examples and the developer confirms the checklist, finish and archive this task:

```bash
python ./.moluoxixi/scripts/task.py finish
python ./.moluoxixi/scripts/task.py archive 00-bootstrap-guidelines
```

Future developers receive a `00-join-<slug>` onboarding task.
