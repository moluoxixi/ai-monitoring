# Directory Structure

> How backend code is organized in this project.

---

## Overview

The server uses domain-first modules under `apps/server/src`. Business rules,
Nest services, controllers, DTOs, and protocol-specific parsers stay with the
domain that owns them. Stateless functions shared by multiple top-level domains
belong in `apps/server/src/utils` so consumers do not depend on an unrelated
domain merely to reuse a helper.

## Directory Layout

```text
apps/server/src/
|-- auth/          # Authentication guards and token handling
|-- channels/      # Notification channel providers
|-- config/        # Configuration loading and validation
|-- dashboard/     # Dashboard API endpoints
|-- database/      # Persistence services and migrations
|-- deliveries/    # Delivery orchestration and retry processing
|-- events/        # Event ingestion, normalization, and platform watchers
|-- extensions/    # Platform and extension discovery
|-- settings/      # Settings API and persistence
|-- utils/         # Stateless helpers shared across top-level domains
|-- app.module.ts
`-- main.ts
```

## Module Organization

### Domain-owned code

Keep code in its domain when it owns lifecycle, state, I/O, DTOs, protocol
semantics, or business decisions. A helper used only inside one domain stays
beside that domain even if it is implemented as a pure function.

### Shared utilities

Move a module to `src/utils` when all of the following are true:

- it is stateless and has no Nest lifecycle;
- it is shared by multiple top-level domains, or has no meaningful domain owner;
- it does not import services, controllers, DTOs, repositories, or other domain
  modules;
- its input and output behavior can be tested without application wiring.

`src/utils` must remain a leaf dependency. Domain modules may import utilities;
utilities must not import domain modules.

Current examples:

- `utils/event-record.ts` owns `recordValue(value: unknown): Record<string, unknown>`;
- `utils/event-text.ts` owns shared text truncation, sanitization, and summary
  functions used by events, deliveries, and database persistence.

When moving an existing helper, update every production and test consumer. If a
documented compatibility import already exists, keep a narrow re-export at the
old public owner while internal consumers use the new utility path directly.

## Naming Conventions

- Use kebab-case filenames that describe the data or operation, such as
  `event-text.ts`.
- Avoid generic catch-all files such as `helpers.ts` or `common.ts`.
- Keep one coherent responsibility per utility module.
- Put server tests in `apps/server/test/<source-basename>.spec.ts`.

## Empty Directories

Remove empty directories under application source trees only after confirming
that they contain no files or child directories and have no code or
configuration references. Do not treat runtime data locations, task/archive
directories, dependency trees, or build caches as source-code cleanup targets.

## Good, Base, And Bad Cases

- Good: `database` and `deliveries` both import stateless text normalization
  from `../utils/event-text`.
- Base: a parser helper used only by an event watcher remains under `events`.
- Bad: `database` imports `events/event-text` solely to reuse a generic text
  function, or a utility imports a Nest service from `events`.

## Tests Required

- Add direct unit coverage for utility boundary behavior, including `null`,
  arrays, primitive values, empty text, and length limits where applicable.
- Search for old import paths and duplicate definitions after a move.
- Run the server test suite and TypeScript type check.
- For runtime-visible refactors, rebuild and restart the production service,
  then verify `/api/health` and `/`.

## Wrong Vs Correct

```typescript
// Wrong: a domain depends on another domain only for a stateless helper.
import { cleanAnswerText } from '../events/event-text';

// Correct: both domains depend on a leaf utility module.
import { cleanAnswerText } from '../utils/event-text';
```

```typescript
// Wrong: utility code reaches back into a domain service.
import { EventIngestionService } from '../events/event-ingestion.service';

// Correct: utility modules depend only on platform or package primitives.
export function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
```

