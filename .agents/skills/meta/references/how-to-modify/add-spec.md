# How To: Propose A Spec Category

Add a new spec category like `mobile/`.

**Platform**: All

---

## Formal Targets to Propose

| File | Action | Required |
|------|--------|----------|
| `.moluoxixi/spec/mobile/index.md` | Propose | Yes |
| `.moluoxixi/spec/mobile/*.md` | Propose | Yes |
| Current task JSONL | Update after promotion | As needed |
| `project-local/SKILL.md` | Update after promotion | Optional |

---

## Step 1: Create A Task-Local Candidate Directory

```bash
mkdir -p "$TASK_DIR/research/spec-mobile"
```

---

## Step 2: Prepare The Complete Index Candidate

Create `$TASK_DIR/research/spec-mobile/index.md` as the complete desired content
for `.moluoxixi/spec/mobile/index.md`:

```markdown
# Mobile Specifications

Guidelines for mobile development.

## Quick Reference

| Topic | Guideline |
|-------|-----------|
| Architecture | MVVM pattern |
| State | Use StateFlow |
| Navigation | Jetpack Navigation |

## Specifications

1. [Architecture Guidelines](./architecture.md)
2. [UI Guidelines](./ui-guidelines.md)
3. [State Management](./state-management.md)

## Key Principles

- Principle 1
- Principle 2
- Principle 3
```

---

## Step 3: Prepare Complete Spec Candidates

Create each desired spec under `$TASK_DIR/research/spec-mobile/`:

### Example: `architecture.md`

```markdown
# Mobile Architecture

## Overview

Description of architecture approach.

## Guidelines

### 1. Use MVVM Pattern

Explanation...

**Do:**
```kotlin
// Good example
```

**Don't:**
```kotlin
// Bad example
```

### 2. Another Guideline

...

## Related Specs

- [UI Guidelines](./ui-guidelines.md)
```

---

## Step 4: Submit And Review Every Target

Submit each complete candidate separately:

```bash
node ./.moluoxixi/scripts/spec-proposals.mjs propose \
  --target mobile/index.md \
  --content-file "$TASK_DIR/research/spec-mobile/index.md" \
  --source-task "$TASK_DIR" \
  --reason "Add mobile guideline index"
node ./.moluoxixi/scripts/spec-proposals.mjs propose \
  --target mobile/architecture.md \
  --content-file "$TASK_DIR/research/spec-mobile/architecture.md" \
  --source-task "$TASK_DIR" \
  --reason "Add mobile architecture guidance"
```

Report the proposal IDs and wait for explicit user approval through
`spec-review`. Only after promotion may a task reference the formal files:

```bash
python ./.moluoxixi/scripts/task.py add-context <task> implement ".moluoxixi/spec/mobile/index.md" "Mobile guidelines"
python ./.moluoxixi/scripts/task.py add-context <task> check ".moluoxixi/spec/mobile/architecture.md" "Architecture review rules"
```

---

## Step 5: Document The Promoted Category in project-local

Update `.claude/skills/project-local/SKILL.md`:

```markdown
## Specs Customized

### Added Categories

#### mobile/
- **Path**: `.moluoxixi/spec/mobile/`
- **Purpose**: Mobile development guidelines
- **Added**: 2026-01-31
- **Files**:
  - `index.md` - Overview
  - `architecture.md` - Architecture patterns
  - `ui-guidelines.md` - UI patterns
```

---

## Spec File Best Practices

### Structure

```markdown
# [Spec Title]

## Overview
Brief description.

## Guidelines

### 1. [Guideline Name]
Explanation with examples.

### 2. [Another Guideline]
...

## Related Specs
Links to related specs.
```

### Naming

- Use kebab-case: `ui-guidelines.md`
- Be descriptive: `state-management.md` not `state.md`

### Cross-References

Link between specs:

```markdown
See [State Management](./state-management.md) for more details.
```

---

## Testing

1. Verify index links work
2. After promotion, add the new specs to a task with `task.py add-context`
3. Verify specs are injected correctly (Claude Code)
4. Verify specs are readable (Cursor)

---

## Checklist

- [ ] Complete index candidate prepared
- [ ] Complete spec candidates prepared with proper format
- [ ] Every target submitted as a separate proposal
- [ ] Human reviewed promotion before context use
- [ ] Promoted category documented in project-local if needed
- [ ] Cross-references verified
