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
- Notification text is rendered exactly once before channel selection. The
  delivery worker owns the complete user-visible string (including title,
  task ID, and body); `ChannelProvider` implementations are transport adapters
  and must not compose, prepend, or otherwise rewrite it.

---

## Testing Requirements

- For a workflow that writes through one adapter and reads through another,
  test both boundary contracts and assert the final user-visible projection.
- Notification delivery tests must distinguish public correlation metadata
  (for example, a task/event ID) from capability-bearing routing tokens; the
  former may be shown on every channel, while the latter must remain limited to
  eligible channels and events.
- Cross-channel delivery tests must assert that QQ and at least one non-QQ
  provider receive the exact same rendered message string.
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
| Fork completion has Desktop runtime markers and `thread_source: "cli"` | Preserve `codex-desktop`; make its QQ notification fork-capable independently |

### 5. Good / Base / Bad Cases

- Good: two replies to one delivery wait for each writer release and advance
  `original -> fork-1 -> fork-2`.
- Base: a CLI-sourced Desktop fork completion creates a Desktop delivery whose
  first reply forks from that completion thread.
- Bad: use the client label to choose `thread/resume`; a Desktop-loaded fork can
  then fail with `already has an active writer` regardless of its label.

### 6. Tests Required

- Cover two consecutive replies to one delivery and assert the second waits for
  writer release, refreshes the route, forks from the first result, and advances
  the head.
- Cover a completion notification produced by a CLI-sourced Desktop fork;
  assert the event and route remain Desktop and the reply still forks.
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

## Scenario: Codex Persistent Fork Snapshot Ownership

### 1. Scope / Trigger

- Apply this contract when `CodexSessionWatcherService` reads a persisted
  `thread/fork` JSONL file.
- A fork file contains its own first `session_meta`, a copied parent/ancestor
  transcript, and later records owned by the fork. Copied records are history,
  even when Codex rewrites their top-level timestamps to the fork creation time.

### 2. Signatures

Relevant persisted fields:

```typescript
type ForkSessionMeta = {
  type: 'session_meta';
  timestamp?: string;
  payload: {
    id?: string;
    session_id?: string;
    forked_from_id: string;
    timestamp?: string;
    thread_source?: string;
  };
};

type CodexTaskStarted = {
  type: 'event_msg';
  payload: { type: 'task_started'; turn_id: string; started_at: number | string };
};
```

- `started_at` can be Unix seconds while meta timestamps are ISO strings with
  milliseconds. Compare at the coarsest precision shared by both values.
- `task_complete` and `turn_aborted` carry `turn_id`, but no session/thread ID.

### 3. Contracts

- The first valid `session_meta` owns the physical JSONL file. Lock its session
  ID, client classification, and subagent classification for the file lifetime.
- A non-empty `forked_from_id` on the owner meta marks the file as a fork.
  Later parent/ancestor meta records never replace the owner.
- In a fork file, accept a `task_started` only when its normalized `started_at`
  is not earlier than the owner fork timestamp at shared timestamp precision.
- Only an accepted `task_started.turn_id` can authorize prompt, answer,
  provisional-failure suppression, timing, or a terminal event for that fork.
- `syncFile` and prefix recovery must replay the same state transition. Backfill
  skips may suppress historical ingestion, but must still retain the first
  owner meta so future appends remain observable.
- If ownership or the time boundary cannot be proved, fail closed by skipping
  that fork terminal. Do not infer ownership from top-level copied timestamps,
  file names, parent-file availability, process state, or scan order.
- Ordinary non-fork sessions retain their legacy terminal behavior, including
  terminals observed without a preceding `task_started`.

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| First meta has `forked_from_id` | Lock fork owner and boundary |
| Later meta has a parent/ancestor ID | Ignore it for file identity |
| Copied turn starts before fork boundary | Do not update state or ingest its terminal |
| Fork turn starts in the same second as a millisecond meta timestamp | Compare at seconds precision and accept it |
| Fork boundary or `started_at` is missing/invalid | Do not ingest the unproven terminal |
| File exceeds the tail window | Recover owner, boundary, owned turns, summary, answer, and timing from the prefix |
| Old file is outside the backfill window, then receives a new append | Skip old terminals, retain owner, ingest the new turn |
| Ordinary non-fork terminal has no observed start | Preserve existing ingestion behavior |

### 5. Good / Base / Bad Cases

- Good: fork meta -> copied parent abort -> owned fork start/prompt/answer/complete;
  only the fork completion is delivered with the fork ID.
- Base: ordinary CLI/Desktop JSONL continues to accept its current terminal
  shapes and classification rules.
- Bad: each copied `session_meta` overwrites `currentSessionId`, or a copied
  `turn_aborted` is accepted merely because it has a `turn_id`.
- Bad: compare second-resolution `started_at` directly against millisecond
  fork time and drop a valid same-second fork turn.

### 6. Tests Required

- File-level fixture with owner fork meta, multiple foreign meta records,
  copied prompts, copied `task_complete`, copied `turn_aborted`, and one owned
  completion. Assert exactly one ingest with fork session/turn/client/answer.
- Large-file fixture where owner/boundary/owned start are before the last 1 MiB
  and the owned terminal is in the tail.
- Same-second seconds-vs-milliseconds fixture copied from a real persisted fork.
- Missing/invalid boundary fixture that asserts no ingest or provisional
  suppression.
- Old-file backfill fixture that appends a new terminal after the historical
  offset was skipped.
- Run the existing ordinary CLI, Desktop, subagent, partial-line, timing, and
  startup recovery watcher suite unchanged.

### 7. Wrong vs Correct

#### Wrong

```typescript
if (record.type === 'session_meta') currentSessionId = record.payload.session_id;
if (record.payload.type === 'turn_aborted') ingestInterrupted(currentSessionId);
```

#### Correct

```typescript
if (!state.ownerEstablished && record.type === 'session_meta') lockOwner(state, record);
if (state.isFork && isOwnedStart(state, record)) state.ownedTurnIds.add(record.payload.turn_id);
if (isTerminal(record) && (!state.isFork || state.ownedTurnIds.has(record.payload.turn_id))) {
  ingestTerminal(state.sessionId, record);
}
```

---

## Scenario: Codex Client Attribution vs Thread Source

### 1. Scope / Trigger

- Apply when Codex `session_meta` is projected to the public event `client`, or
  when Python notify/proxy adapters decide whether the session watcher owns a
  completion.
- A persistent App Server fork can retain `source: "vscode"` and
  `originator: "Codex Desktop"` while setting `thread_source: "cli"`.

### 2. Signatures

```typescript
sessionIdentity(payload, currentClient): {
  isSubagent: boolean;
  client: 'codex-cli' | 'codex-desktop';
}
```

```python
session_kind(thread_id: str, codex_home: Path | None = None) -> str | None
```

Relevant persisted fields are `source`, `originator`, `thread_source`, and
`forked_from_id` from the first valid `session_meta` that owns the file.

### 3. Contracts

- `client` identifies the observed user runtime surface; `thread_source`
  describes thread creation/execution semantics. Do not treat them as the same
  dimension.
- Structured subagent evidence has highest priority and suppresses user
  notifications.
- Explicit Desktop/VSCode/IDE runtime markers classify `codex-desktop`, even
  when `thread_source` is `cli`.
- Explicit CLI/TUI/command-line runtime markers classify `codex-cli`.
- Use `thread_source: "cli"` as a CLI fallback only when no stronger runtime
  marker exists.
- A valid identity with no known runtime marker remains watcher-owned Desktop;
  Python returns unknown only when no identity can be found. This keeps hook,
  proxy, and watcher ownership mutually exclusive.
- A structured `source.subagent` object is subagent evidence even when the
  object is empty; JavaScript and Python truthiness must not diverge here.
- TypeScript watcher and Python identity helpers must implement the same
  priority. Otherwise the watcher and hook/proxy can both claim one completion.
- Client attribution never selects resume versus fork. Both public Codex
  clients continue through a persistent fork from the latest branch head.

### 4. Validation & Error Matrix

| Persisted evidence | Required result |
|---|---|
| Structured subagent + any runtime/thread markers | subagent; no user delivery |
| `source=vscode`, `originator=Codex Desktop`, `thread_source=cli` | `codex-desktop`; watcher owns completion |
| `source=cli`, `originator=codex-tui`, `thread_source=user` | `codex-cli` |
| No runtime marker, `thread_source=cli` | `codex-cli` fallback |
| Valid identity, no known runtime/thread marker | `codex-desktop` watcher-owned fallback |
| `source.subagent={}` | subagent; no user delivery |
| Desktop fork is replied to from QQ | Route remains Desktop; dispatcher uses `mode=fork` |
| Desktop extension hidden, CLI visible | Persist event; create no delivery |
| Later copied `session_meta` conflicts with the file owner | Ignore it; keep first-owner attribution |

### 5. Good / Base / Bad Cases

- Good: a Desktop-created persistent fork is displayed as Desktop, skipped by
  the notify multiplexer, and remains reply-capable through another fork.
- Base: an independent `codex-tui` rollout stays CLI.
- Bad: `thread_source=cli` runs before runtime markers and relabels every
  Desktop App Server fork as CLI.
- Bad: fix only TypeScript; Python then relays the same Desktop completion that
  the watcher also ingests.

### 6. Tests Required

- Use the real conflict shape in TypeScript parser and file-level watcher
  tests; assert Desktop client and subagent precedence.
- Keep explicit CLI and marker-free `thread_source=cli` fallback fixtures.
- Cover valid unknown runtime fallback and an empty structured subagent object
  in both language implementations.
- Cross watcher -> ingestion -> database delivery/reply route -> inbound reply
  -> dispatcher; assert Desktop attribution and `mode=fork` together.
- Use an actual temporary rollout in Python multiplexer tests; do not mock
  `session_kind`. Assert neither relay POST nor legacy target fan-out occurs.
- Exercise App Server proxy ownership with the same real rollout shape and
  assert it performs no network POST.
- Run complete server and Python suites so notification ownership and reply
  routing changes are checked together.

### 7. Wrong vs Correct

#### Wrong

```typescript
if (threadSource === 'cli') return { client: 'codex-cli' };
if (desktopRuntimeMarker) return { client: 'codex-desktop' };
```

#### Correct

```typescript
if (isSubagent) return subagentIdentity;
if (desktopRuntimeMarker) return { client: 'codex-desktop' };
if (cliRuntimeMarker) return { client: 'codex-cli' };
if (threadSource === 'cli') return { client: 'codex-cli' };
```

---

## Scenario: Filesystem Discovery and Windows Relay Supervision

### 1. Scope / Trigger

- Apply the discovery contract when a session watcher enumerates directories
  periodically or during startup and then performs a second filesystem
  operation on an enumerated path.
- Apply the supervision contract when Windows starts the source-deployed relay
  from Task Scheduler or the current-user Startup folder.
- The two contracts are complementary: discovery reduces process exits;
  supervision restores the service after any remaining unexpected exit.

### 2. Signatures

```typescript
captureStartupFiles(root: string): Map<string, number>
discoverFiles(): void
```

```powershell
.\scripts\run-relay-supervisor.ps1 `
  [-BindHost <string>] [-Port <int>] `
  [-RestartDelaySeconds <0..3600>] [-MaxRuns <int>] `
  [-RelayScript <path>] [-LogPath <path>] [-MutexName <name>]

.\scripts\install-task.ps1 [-RelayTaskName <string>] [-Remove]
```

- `MaxRuns=0` means unlimited supervision; positive values are for bounded
  diagnostics and deterministic tests.
- `run-relay.ps1` remains the manual foreground entry point. Login startup
  entries invoke `run-relay-supervisor.ps1` instead.

### 3. Contracts

- Treat `readdir` followed by `stat`, recursive `readdir`, or stream open as a
  time-of-check/time-of-use boundary. An enumerated path is not proof that the
  path still exists for the next operation.
- `ENOENT` and `ENOTDIR` during discovery are expected races: skip only the
  affected item or subtree and continue the same scan. Log unexpected errors,
  but no synchronous discovery exception may escape a polling timer callback.
- Startup enumeration and periodic discovery must share the same guarded scan;
  do not maintain a safe runtime path and a separate unsafe startup path.
- Keep session parsing errors in the existing per-file Promise queue. Discovery
  guards must not suppress parser, ingestion, or delivery failures.
- Windows login entries provide a trigger, not process supervision. Both the
  scheduled-task action and Startup shortcut must invoke the supervisor.
- The supervisor owns at most one relay per Windows user across login sessions,
  using a user-SID-qualified `Global\\` mutex. It runs one child synchronously,
  records the exit code in UTF-8, waits before retrying, and never creates a
  tight restart loop.
- Install, fallback, upgrade, and remove paths must converge: a successful
  scheduled-task install removes a stale shortcut, fallback removes a stale
  task, and legacy Phoenix task/shortcut entries are always removed.

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| JSONL file disappears between enumeration and `stat` | Skip that file; continue siblings; retry on a later scan |
| Nested directory disappears before recursive `readdir` | Skip that subtree; continue siblings |
| Discovery sees an unexpected filesystem error | Warn and keep the Node process alive |
| Per-file read fails after enqueue | Existing queue logs it, clears the pending marker, and retries later |
| Relay child exits with any code | Log the code, wait `RestartDelaySeconds`, then start one replacement |
| Second supervisor starts for the same Windows user | Fail the mutex acquisition and exit without launching a relay |
| Task Scheduler creation succeeds | Remove stale Startup shortcut; use supervisor action |
| Task Scheduler creation fails | Remove stale task; create supervisor shortcut |
| Installer runs after Phoenix removal | Delete legacy Phoenix task and shortcut idempotently |

### 5. Good / Base / Bad Cases

- Good: one rollout file is deleted during `stat`; another file in the same
  directory is ingested, and the deleted path is handled if it reappears.
- Base: a stable directory produces the same startup sizes and delivery
  behavior as before the guards were added.
- Good: Node exits unexpectedly; the hidden supervisor logs the exit, waits
  five seconds, and restores `/api/health` without requiring another login.
- Bad: wrap the entire directory walk in one catch and discard already found
  siblings after one race.
- Bad: register `run-relay.ps1` directly under `ONLOGON` and assume Task
  Scheduler will restart a process that exits hours later.

### 6. Tests Required

- Deterministically inject `ENOENT` between enumeration and file-size lookup;
  assert no throw, same-scan sibling ingestion, and later recovery.
- Force a disappearing directory to be visited before a stable sibling; assert
  the sibling is still ingested so traversal order cannot make the test pass.
- Run the complete watcher suite to preserve CLI, Desktop, fork, partial-line,
  startup, backfill, and polling behavior.
- On Windows PowerShell 5.1, run a bounded supervisor against a stub relay;
  assert two runs, a non-zero exit code, a real non-zero delay, UTF-8 child
  output, and clean termination at `MaxRuns`.
- Validate that install-task source routes both scheduled and shortcut actions
  through the supervisor and that the shared cleanup removes task and shortcut
  forms of current and legacy entries.
- Finish with full tests, type-check, build, PowerShell parser validation, and
  a local smoke test that kills the supervised Node child and observes health
  recovery.

### 7. Wrong vs Correct

#### Wrong

```typescript
for (const entry of readdirSync(directory, { withFileTypes: true })) {
  if (entry.isFile()) files.set(entry.name, statSync(entry.name).size);
}
setInterval(() => discoverFiles(), 2_000);
```

```powershell
schtasks.exe /Create /SC ONLOGON /TR "powershell -File run-relay.ps1"
```

#### Correct

```typescript
for (const entry of safeReadDirectory(directory)) {
  try {
    files.set(path, fileSize(path));
  } catch (error) {
    if (!isTransientDiscoveryError(error)) logger.warn(error);
  }
}
```

```powershell
schtasks.exe /Create /SC ONLOGON /TR `
  "powershell -File run-relay-supervisor.ps1"
```

---

## Code Review Checklist

<!-- What reviewers should check -->

(To be filled by the team)
