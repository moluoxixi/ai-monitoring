# Local Spec System

`.moluoxixi/spec/` is the user's project-specific engineering spec library. Moluoxixi is not about making AI memorize conventions; it injects relevant specs or requires the AI to read them at the right time.

Only reviewed knowledge belongs in this library. AI-discovered conventions first enter `.moluoxixi/spec-proposals/`; proposal files are not injected as active guidance.

## Directory Model

A common single-repository structure:

```text
.moluoxixi/spec/
├── backend/
│   ├── index.md
│   └── ...
├── frontend/
│   ├── index.md
│   └── ...
└── guides/
    ├── index.md
    └── ...
```

A common monorepo structure:

```text
.moluoxixi/spec/
├── cli/
│   ├── backend/
│   │   ├── index.md
│   │   └── ...
│   └── unit-test/
│       ├── index.md
│       └── ...
├── docs-site/
│   └── docs/
│       ├── index.md
│       └── ...
└── guides/
    ├── index.md
    └── ...
```

`index.md` is the entry point for each layer. It should list the Pre-Development Checklist and Quality Check. Specific guidelines live in other Markdown files in the same directory.

## Package Configuration

`.moluoxixi/config.yaml` can declare packages:

```yaml
packages:
  cli:
    path: packages/cli
  docs-site:
    path: docs-site
    type: submodule
default_package: cli
```

The AI can run:

```bash
python3 ./.moluoxixi/scripts/get_context.py --mode packages
```

This command lists packages and spec layers for the current project. Use this output as the reference when configuring context JSONL.

## How Specs Enter Tasks

Before a task enters implementation, planning may write relevant specs into `implement.jsonl` / `check.jsonl` when the task needs spec or research context beyond the task artifacts:

```jsonl
{"file": ".moluoxixi/spec/cli/backend/index.md", "reason": "CLI backend conventions"}
{"file": ".moluoxixi/spec/cli/unit-test/conventions.md", "reason": "Test expectations"}
```

Sub-agents or platform preludes read these JSONL files and load the referenced specs. On platforms without sub-agent support, the AI should read the relevant specs directly according to the workflow.

## What Specs Should Contain

Specs should contain executable engineering conventions for the project, not generic best practices:

- Where files should live.
- How error handling should be expressed.
- Input/output contracts for APIs, hooks, and commands.
- Patterns that are forbidden.
- Cases that require tests.
- Project-specific pitfalls and how to avoid them.

When the AI learns a new rule during implementation or debugging, it should use `moluoxixi-update-spec` to submit a complete desired-state candidate under `.moluoxixi/spec-proposals/`. A human reviews promote, merge, reject, deduplicate, and delete decisions through `moluoxixi-spec-review`; only approved application changes `.moluoxixi/spec/`.

The review audit is event-driven and read-only by default. It becomes due after 30 days without a reviewed audit or when at least 10 proposals are pending. The queue and formal spec are both user data and are preserved by project updates and uninstall.

## Local Customization Points

| Need | Edit location |
| --- | --- |
| Add a new spec layer | `.moluoxixi/spec/<package>/<layer>/index.md` and corresponding guideline files. |
| Change monorepo spec mapping | `packages` / `default_package` / `spec_scope` in `.moluoxixi/config.yaml`. |
| Change which specs AI reads before implementation | The task's `implement.jsonl`. |
| Change which specs AI reads during checking | The task's `check.jsonl`. |
| Change knowledge proposal or review timing | Phase 3.3 in `.moluoxixi/workflow.md`, `update-spec`, and `spec-review`. |

## Boundaries

`.moluoxixi/spec/` is the user's reviewed project specification, not a permanent copy of Moluoxixi built-in templates. `.moluoxixi/spec-proposals/` is the auditable pending layer. Neither directory belongs to the initializer manifest.
