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

## Scenario: External Thread Writer Ownership

### 1. Scope / Trigger

- Apply this contract when a notification reply continues an external runtime
  thread and another client can retain or reacquire that thread's writer.
- Treat a new completion notification as a new local delivery, not as evidence
  that the referenced external thread is safe to resume.

### 2. Signatures

```typescript
advanceReplyThreadId(
  deliveryId: number,
  expectedThreadId: string | null,
  nextThreadId: string,
): string | null
```

- Reply routes project `metadata.thread_id` as immutable provenance and
  nullable `reply_thread_id` as the latest persistent fork-chain head.
- Codex continuation dispatch uses `thread/fork(ephemeral: false,
  threadSource: "cli")`, followed by `turn/start` on the returned thread ID.

### 3. Contracts

- Treat runtime writer ownership as scoped to the external thread ID, not to a
  local delivery, request, or service instance.
- A new notification for an existing thread creates a new local delivery; this
  must not erase the thread lineage or make direct resume safe.
- When an external client can retain or reacquire the writer, continue work by
  forking from the latest persisted head. Do not retry `thread/resume` against
  the occupied thread or infer availability from the previous turn completing.
- Advance a persisted fork head with compare-and-swap so stale service
  instances fail closed instead of silently replacing newer lineage.
- Serialize replies for one delivery through writer release, then refresh the
  route before dispatching the next fork.

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Source thread is loaded by Desktop or another client | Fork from the observed head; never retry direct resume |
| `thread/fork` or `turn/start` fails | Do not advance the persisted head; mark the inbound reply failed |
| Compare-and-swap sees a different current head | Fail closed and retain the winning head |
| Duplicate external message ID was already accepted | Return the stored accepted result without another dispatch |
| Fork completion inherits Desktop markers but has `thread_source: "cli"` | Classify it as Codex CLI and make its QQ notification fork-capable |

### 5. Good / Base / Bad Cases

- Good: two replies to one delivery wait for each writer release and advance
  `original -> fork-1 -> fork-2`.
- Base: a CLI-sourced Desktop fork completion creates a new CLI delivery whose
  first reply forks from that completion thread.
- Bad: classify the new delivery as ordinary CLI and call `thread/resume`; a
  Desktop-loaded fork can then fail with `already has an active writer`.

### 6. Tests Required

- Cover two consecutive replies to one delivery and assert the second waits for
  writer release, refreshes the route, forks from the first result, and advances
  the head.
- Cover a completion notification produced by a CLI-sourced Desktop fork and
  assert it forks again rather than resuming the externally visible thread.
- Cover stale compare-and-swap state and assert the inbound reply fails without
  replacing the winning branch head.
- The CLI-sourced Desktop completion regression must cross the watcher, event
  ingestion, database delivery/token projection, inbound reply service, and
  platform dispatcher. Adapter-only and parser-only tests are insufficient.

### 7. Wrong vs Correct

#### Wrong

```typescript
const mode = route.client === 'codex-desktop' ? 'fork' : 'resume';
await database.setReplyThreadId(route.delivery_id, result.threadId);
```

The client label does not describe current writer ownership, and first-write
storage cannot advance an append-only continuation chain.

#### Correct

```typescript
const sourceThreadId = route.reply_thread_id ?? route.metadata.thread_id;
const result = await codex.dispatch({ mode: 'fork', threadId: sourceThreadId, text });
const stored = database.advanceReplyThreadId(
  route.delivery_id,
  route.reply_thread_id,
  result.threadId,
);
```

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

## Scenario: Cross-Producer Transcript Event Idempotency

### 1. Scope / Trigger

- Apply this contract when an external-runtime hook and a server transcript
  watcher can report the same terminal event, or when transcript files can be
  copied, truncated, rewritten, or appended while watcher startup is in flight.
- The goal is one database event and one delivery per channel without relying
  on timing windows or user-visible text.

### 2. Signatures

```typescript
scopedSourceEventId(source: string, client: string, producerEventId: string): string
claudeDesktopTerminalEventId(kind: string, stableId: string, status: string): string
```

- Completed producer ID:
  `claude-desktop:assistant:<message.id-or-record-uuid>:completed`.
- Persisted ID:
  `v1:<encoded-source>:<encoded-client>:<producer-event-id>`.
- Database barrier: `events.source_event_id UNIQUE`.

### 3. Contracts

- Hook and watcher must derive the same producer ID from the stable terminal
  identity. Do not include session ID: copied branches can preserve terminal
  IDs while rewriting session ID.
- Runtime classification uses only exact structured evidence from a non-
  sidechain record. For Claude Desktop that evidence is top-level
  `entrypoint === 'claude-desktop-3p'`; message text and paths are not evidence.
- Sidechain and synthetic/tool-result records must not mutate main-chain source
  or turn state.
- A watcher must retain a digest of the bytes already consumed. Length checks
  alone do not detect equal-size or growth rewrites.
- Startup enumeration must snapshot each file's byte size. Seed identities and
  parser state only through the last complete newline at or before that size;
  bytes appended afterward, including the completion of a split JSONL record,
  are live input.
- Startup seeding never ingests. Runtime parsing adds every stable terminal ID
  to the process-level seen set, including skipped copied history.

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Hook and watcher race on one stable terminal ID | SQLite retains one event and one delivery per channel |
| Same terminal ID appears under a different session ID | Treat as copied history; do not deliver again |
| Desktop `Stop` has no stable assistant ID | Hook skips it; watcher remains authoritative |
| Transcript prefix digest changes at the consumed offset | Reset file parser state and rescan; keep the global seen-ID set |
| Startup snapshot ends inside a JSONL record | Keep offset at the preceding newline and consume the completed record later |
| Sidechain carries a Desktop marker | Ignore it without changing main-chain classification |
| Terminal timestamp is strictly before file birth watermark | Skip as copied-history fallback and remember its stable ID |

### 5. Good/Base/Bad Cases

- Good: hook-first and watcher-first paths converge on one scoped ID, while the
  later arrival may enrich the existing summary or answer.
- Base: a new transcript containing prompt and terminal in its first write is
  parsed from byte zero and delivers once.
- Bad: IDs include session ID, source is inferred from text, startup `add`
  silently seeds bytes written after enumeration, or rewrite detection checks
  only `bytes.length < offset`.

### 6. Tests Required

- Unit-test exact producer/scoped ID equality, including record UUID fallback.
- Integration-test hook-first and watcher-first arrival: one event, one
  delivery per channel, and enrichment after the second arrival.
- Watcher-test startup history seeding, copied history, multiple old terminals
  followed by a new terminal, equal/growth rewrite, and cross-session replay.
- Deterministically append after startup enumeration but before Chokidar `add`;
  assert only the appended terminal is ingested.
- Split one terminal across the startup byte snapshot; assert it is not lost.
- Test sidechain and synthetic/tool-result records as state-contamination
  negatives, not only as non-emitting records.

### 7. Wrong vs Correct

#### Wrong

```typescript
const eventId = `${sessionId}:${message.id}`;
if (bytes.length < state.offset) resetParser();
state.offset = startupFileSize;
```

#### Correct

```typescript
const eventId = claudeDesktopTerminalEventId('assistant', message.id, 'completed');
if (prefixDigest(bytes, state.offset) !== state.prefixDigest) resetParser();
state.offset = lastCompleteNewlineAtOrBefore(startupSnapshotSize);
```

---

## Code Review Checklist

<!-- What reviewers should check -->

(To be filled by the team)
