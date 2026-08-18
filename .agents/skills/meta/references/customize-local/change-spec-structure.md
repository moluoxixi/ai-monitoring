# Change Local Spec Structure

When the user wants to change the engineering conventions AI follows or add
new spec layers, prepare complete target proposals and use `spec-review` for
promotion. Change `.moluoxixi/config.yaml` only when the user also requested a
package-map or scanning change.

## Read These Files First

1. `.moluoxixi/config.yaml`
2. `.moluoxixi/spec/`
3. `.moluoxixi/workflow.md` planning artifact guidance and Phase 3.3
4. Current task `implement.jsonl` / `check.jsonl`

## Common Needs

| Need | Reviewed target |
| --- | --- |
| Add backend/frontend/docs/test spec layer | `.moluoxixi/spec/<layer>/` or `.moluoxixi/spec/<package>/<layer>/` |
| Add shared thinking guides | `.moluoxixi/spec/guides/` |
| Adjust monorepo packages | `packages` in `.moluoxixi/config.yaml` |
| Change default package | `default_package` in `.moluoxixi/config.yaml` |
| Control spec scanning scope | `spec_scope` in `.moluoxixi/config.yaml` |
| Make a task read a new spec | Task `implement.jsonl` / `check.jsonl` |

## Propose A Spec Layer

Single-repository example:

```text
.moluoxixi/spec/security/
├── index.md
└── auth.md
```

Monorepo example:

```text
.moluoxixi/spec/webapp/security/
├── index.md
└── auth.md
```

`index.md` should include:

- What code this layer applies to.
- Pre-Development Checklist.
- Quality Check.
- Links to specific guideline files.

Submit every new target, including the layer `index.md`, through `update-spec`.
Do not create the formal directory or files before human approval.

## Update Context After Promotion

Promoting a spec does not mean every task automatically reads it. The current task must reference it in JSONL:

```bash
python ./.moluoxixi/scripts/task.py add-context <task> implement ".moluoxixi/spec/webapp/security/index.md" "Security conventions"
python ./.moluoxixi/scripts/task.py add-context <task> check ".moluoxixi/spec/webapp/security/index.md" "Security review rules"
```

## Change Monorepo Packages

Example `.moluoxixi/config.yaml`:

```yaml
packages:
  webapp:
    path: apps/web
  api:
    path: apps/api
default_package: webapp
```

After editing, run:

```bash
python ./.moluoxixi/scripts/get_context.py --mode packages
```

Use this output to confirm AI can see the correct packages and spec layers.

## Notes

- Specs are user project conventions, but AI-prepared changes remain proposals until human review.
- Do not put temporary task information into specs; put temporary information in the task.
- Do not put long-term conventions only in agents or commands; preserve them in specs.
- After changing spec structure, check whether existing task JSONL files still point to files that exist.
