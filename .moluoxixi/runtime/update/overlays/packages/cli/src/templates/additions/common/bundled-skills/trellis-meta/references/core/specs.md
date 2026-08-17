# Spec System

Maintain coding standards that guide AI development.

---

## Directory Structure

```
.moluoxixi/spec/
├── cli/                        # Per-package specs (e.g. packages/cli/)
│   ├── frontend/               # Frontend guidelines
│   │   ├── index.md
│   │   ├── component-guidelines.md
│   │   ├── hook-guidelines.md
│   │   ├── state-management.md
│   │   └── ...
│   │
│   ├── backend/                # Backend guidelines
│   │   ├── index.md
│   │   ├── directory-structure.md
│   │   ├── error-handling.md
│   │   ├── api-patterns.md
│   │   └── ...
│   │
│   └── unit-test/              # Unit test guidelines
│       ├── index.md
│       └── ...
│
└── guides/                     # Thinking guides (cross-package)
    ├── index.md
    ├── cross-layer-thinking-guide.md
    ├── code-reuse-thinking-guide.md
    └── cross-platform-thinking-guide.md
```

---

## Spec Categories

### Frontend (`cli/frontend/`)

UI and client-side patterns:
- Component structure
- React hooks usage
- State management
- Styling conventions
- Accessibility

### Backend (`cli/backend/`)

Server-side patterns:
- Directory structure
- API design
- Error handling
- Database access
- Security

### Guides (`guides/`)

Cross-cutting thinking guides:
- How to think about cross-layer changes
- Code reuse strategies
- Platform considerations

---

## Index Files

Each category has an `index.md` that:
1. Provides category overview
2. Lists all specs in the category
3. Gives quick reference for common patterns

### Example: `frontend/index.md`

```markdown
# Frontend Specifications

## Quick Reference

| Topic | Guideline |
|-------|-----------|
| Components | Functional components only |
| State | Use React Query for server state |
| Styling | Tailwind CSS |

## Specifications

1. [Component Guidelines](./component-guidelines.md)
2. [Hook Guidelines](./hook-guidelines.md)
3. [State Management](./state-management.md)
```

---

## Spec File Format

```markdown
# [Spec Title]

## Overview
Brief description of what this spec covers.

## Guidelines

### 1. [Guideline Name]
Detailed explanation...

**Do:**
```typescript
// Good example
```

**Don't:**
```typescript
// Bad example
```

### 2. [Another Guideline]
...

## Related Specs
- [Related Spec 1](./related-spec.md)
```

---

## Using Specs

### In JSONL Context Files

Reference specs in task context:

```jsonl
{"file": ".moluoxixi/spec/cli/frontend/index.md", "reason": "Frontend overview"}
{"file": ".moluoxixi/spec/cli/frontend/component-guidelines.md", "reason": "Component patterns"}
```

### Manual Reading (Cursor)

Read specs at session start:
```
1. Read .moluoxixi/spec/{category}/index.md
2. Read specific guidelines as needed
3. Follow patterns in your code
```

---

## Proposing New Specs

### 1. Choose Category

- Frontend UI patterns → `frontend/`
- Backend/API patterns → `backend/`
- Cross-cutting guides → `guides/`

### 2. Prepare A Task-Local Candidate

Prepare the complete desired file under the active task's `research/` directory.

### 3. Follow Format

Use the spec file format above.

### 4. Prepare The Complete Index Candidate

Include the new entry in a complete candidate for the category's `index.md`:

```markdown
## Specifications
...
N. [New Pattern](./new-pattern.md)
```

### 5. Submit, Review, Then Reference

Submit each target with `update-spec`. Only after explicit human promotion with
`spec-review` may the formal spec be added to relevant task context files.

---

## Adding New Categories

### 1. Prepare Candidates

Prepare the complete desired category files under the active task's `research/`
directory. Do not create the formal spec directory yet.

### 2. Prepare Index

### 3. Prepare Category Specs

Create individual spec files.

### 4. Submit And Review

Submit every formal target separately. After human-reviewed promotion, use
`task.py add-context` for tasks that need the new category.

---

## Best Practices

1. **Keep specs focused** - One topic per file
2. **Use examples** - Show do/don't patterns
3. **Link related specs** - Cross-reference
4. **Review proposals regularly** - Specs evolve only through human-approved promotion
5. **Index everything** - Keep index files current
