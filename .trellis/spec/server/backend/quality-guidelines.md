# Quality Guidelines

> Code quality standards for backend development.

---

## Overview

<!--
Document your project's quality standards here.

Questions to answer:
- What patterns are forbidden?
- What linting rules do you enforce?
- What are your testing requirements?
- What code review standards apply?
-->

(To be filled by the team)

---

## Forbidden Patterns

<!-- Patterns that should never be used and why -->

(To be filled by the team)

---

## Required Patterns

- External runtime adapters and their downstream readers must share an explicit
  data-shape contract. A successful write or RPC response does not prove that a
  watcher can consume the runtime's persisted representation.
- JSONL/session watcher changes must include a regression fixture copied from
  the runtime's actual emitted shape, including top-level record type, payload
  discriminator, role, and content node type.
- A new user-turn record must reset all turn-scoped derived state together:
  task summary, prior answer source, start timestamp, and start turn ID.
- If a public correlation marker appears on more notifications than the subset
  that supports an inbound action, the inbound adapter must still claim that
  marker and return a deterministic unsupported response. It must not fall
  through to an unrelated generic agent or provider.

---

## Testing Requirements

- For a workflow that writes through one adapter and reads through another,
  test both boundary contracts and assert the final user-visible projection.
- Notification delivery tests must distinguish public correlation metadata
  (for example, a task/event ID) from capability-bearing routing tokens; the
  former may be shown on every channel, while the latter must remain limited to
  eligible channels and events.
- Runtime plugin tests must cover both an eligible marker and a public marker
  for an ineligible task, asserting that both are handled and that only the
  eligible case reaches the platform dispatcher.

## Scenario: Windows Hosted Runner File Watcher Tests

### 1. Scope / Trigger

- Apply this contract when GitHub Actions runs the server watcher integration
  tests on a hosted Windows runner.
- Windows Server 2025 can abort Node 24 inside libuv `fs-event.c` while a
  Chokidar test exercises the native `fs.watch` backend. This is a process
  crash outside Vitest assertions, not a failed product behavior assertion.

### 2. Signatures

- Workflow step: `.github/workflows/desktop-build.yml` -> `Test workspaces`.
- Command: `npm test`.
- Environment:
  `CHOKIDAR_USEPOLLING=${{ runner.os == 'Windows' && '1' || '0' }}`.

### 3. Contracts

- Windows CI must set `CHOKIDAR_USEPOLLING=1` for the complete workspace test
  command so every Chokidar instance uses its polling backend.
- Non-Windows CI must set the value to `0` and continue testing the native
  filesystem-event backend.
- Production watcher construction must not be changed solely to accommodate a
  hosted-runner defect. The workaround belongs to the CI test environment.
- The same watcher test files and assertions must run on every platform.

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Windows hosted runner with polling enabled | All watcher test files execute; no `fs-event.c` process abort |
| macOS runner | Native watcher backend remains enabled and all tests execute |
| A watcher assertion fails | The test job fails normally with the assertion details |
| A watcher test is skipped or removed to make CI green | Reject the change |

### 5. Good/Base/Bad Cases

- Good: Windows runs all Claude, Codex, Hermes, and Qoder watcher tests with
  polling and validates file creation and append behavior.
- Base: macOS and local development use Chokidar's normal native backend.
- Bad: disabling a watcher spec, swallowing a worker crash, or forcing polling
  in the production service without evidence of a production defect.

### 6. Tests Required

- Run `npm test` with `CHOKIDAR_USEPOLLING=1` on Windows and assert all server
  test files complete, including `claude-desktop-audit-watcher.spec.ts`.
- Parse `desktop-build.yml` and assert the `Test workspaces` step owns the
  runner-conditional environment expression.
- Verify the Windows Actions job passes `Test workspaces`; macOS jobs must also
  pass the unchanged test command.

### 7. Wrong vs Correct

#### Wrong

```yaml
- name: Test workspaces
  run: npm test -- --no-file-parallelism
```

Serializing Vitest files does not change Chokidar's native Windows backend and
does not prevent the libuv process abort.

#### Correct

```yaml
- name: Test workspaces
  run: npm test
  env:
    CHOKIDAR_USEPOLLING: ${{ runner.os == 'Windows' && '1' || '0' }}
```

---

## Code Review Checklist

<!-- What reviewers should check -->

(To be filled by the team)
