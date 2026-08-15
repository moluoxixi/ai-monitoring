# Error Handling

## Scenario: Reliable terminal notifications across AI runtimes and message channels

### 1. Scope / Trigger

- Trigger: an AI runtime reports a tool/API/network error while the same task can retry or continue.
- Trigger: a provider may have delivered a message before local confirmation fails.
- Trigger: a shared session source can contain user turns, CLI/Desktop turns, and internal subagent turns.

### 2. Signatures

```ts
type NotificationState = 'diagnostic' | 'provisional' | 'suppressed';

function isRecoverableFailure(value: unknown): boolean;

class DatabaseService {
  suppressProvisionalFailures(client: string, sessionId: string): number;
  isClaimedDeliveryActive(id: number, leaseToken: string): boolean;
}

class DeliveryOutcomeUnknownError extends Error {}
```

```env
AIMONITOR_RECOVERABLE_FAILURE_GRACE_MS=600000
```

### 3. Contracts

- Tool-level failures use `status=tool_failed` and `metadata.notification_state=diagnostic`; they remain in history and never create deliveries.
- Recoverable task failures use `status=failed` and `metadata.notification_state=provisional`; their deliveries are delayed by the configured grace period.
- A later user turn, retry, completion, or interruption in the same canonical client/session marks pending, retrying, or claimed provisional deliveries `dead` and the event `suppressed`.
- The worker rechecks the claim immediately before external send so a stale claimed row cannot send after suppression.
- Non-recoverable terminal failures keep normal delivery behavior. A provisional failure with no later turn is delivered after the grace period.
- CLI, Desktop, and Quest use distinct canonical client keys. Unknown runtime identity is ignored rather than guessed.
- A provider throws `DeliveryOutcomeUnknownError` only when a remote side effect may already have happened; the worker marks that delivery `dead` without automatic retry.
- Producer event IDs are scoped by source and canonical runtime before entering the globally unique SQLite `source_event_id` column.

### 4. Validation & Error Matrix

| Input condition | Stored status/state | Delivery behavior |
|---|---|---|
| `PostToolUseFailure` / single API request error | `tool_failed` / `diagnostic` | none |
| Stream disconnect, overload, 429, 5xx, timeout, connection reset | `failed` / `provisional` | delayed |
| Same client/session starts a later turn | prior event becomes `suppressed` | pending/retrying/claimed rows become `dead` |
| Permanent terminal error | `failed` | normal immediate delivery |
| Remote send explicitly says not delivered | delivery `retrying` | exponential retry |
| Remote send outcome cannot be confirmed | delivery `dead` | no automatic retry |
| Runtime cannot be identified | no event | no delivery |

### 5. Good / Base / Bad Cases

- Good: a Codex stream disconnect is followed by `task_started` in the same file update; the failure remains visible but no QQ/WeChat message is sent.
- Good: a claimed provisional delivery is suppressed before `channels.send`; the lease check prevents the stale worker from sending it.
- Base: a real non-recoverable failure sends once through every bound channel.
- Base: a recoverable failure with no retry sends after the grace period so errors are not silently lost.
- Bad: every provider or tool error is mapped to task `failed` and sent immediately.
- Bad: an unknown runtime defaults to CLI/Desktop, or identical producer IDs from two runtimes share one database event.
- Bad: an uncertain remote outcome is retried automatically and creates duplicate QQ/WeChat messages.

### 6. Tests Required

- Event ingestion: diagnostic failures create zero deliveries; recoverable failures use the configured delay.
- Codex watcher: failure then `task_started` in one update invokes suppression after ingestion.
- Database: suppression covers pending and claimed deliveries and clears the claimed lease.
- Delivery worker: inactive claims never call `channels.send`; uncertain outcomes become `dead`.
- Adapters: Claude/Qoder/Cursor/Hermes tool/API failures are diagnostic and preserve error details.
- Runtime classification: CLI/Desktop/Quest stay distinct and unknown runtime payloads are ignored.
- Event normalization: equal producer IDs from different sources or runtimes produce distinct `source_event_id` values.

### 7. Wrong vs Correct

#### Wrong

```ts
if (event.status === 'failed') {
  database.insertEvent(event, channels, 0);
}
```

#### Correct

```ts
const diagnostic = event.status === 'tool_failed';
const provisional = event.status === 'failed' && isRecoverableFailure(failureText);

database.insertEvent(
  event,
  diagnostic ? [] : channels,
  provisional ? config.recoverableFailureGraceMs : 0,
);
```

## Scenario: One-shot notification payloads across server and gateway processes

### 1. Scope / Trigger

- Trigger: a provider passes a temporary notification payload to another process by file path.
- Trigger: the server and consumer can run with different inherited environments or data roots.
- Trigger: both processes may attempt best-effort cleanup after an uncertain remote delivery.

### 2. Signatures

```text
command-argv = [nodeExecutable, emitterPath, outboundDir, messagePath]

emitter exit 0 = payload emitted
emitter exit 1 = payload read failed
emitter exit 2 = argument/path validation failed
emitter exit 3 = payload no longer exists
```

```env
AIMONITOR_DATA_ROOT=<backward-compatible default only>
```

### 3. Contracts

- The producer creates `openclaw-outbound/notification-<uuid>.txt` with mode `0600` and passes both the controlled outbound directory and absolute payload path in `command-argv`.
- The consumer does not rely on a Gateway inheriting `AIMONITOR_DATA_ROOT`; the explicit directory is the primary cross-process contract.
- The consumer accepts only a direct child named `notification-*`, rejects symbolic links, and verifies canonical parent containment before reading.
- A valid payload is read once. Consumer and producer cleanup are both idempotent so either side may remove the file without masking the delivery result.
- Missing payloads emit `AI_MONITOR_NOTIFICATION_PAYLOAD_MISSING` and exit `3` without a Node internal stack. Permission and other I/O errors remain failures and are not treated as missing.
- A remote execution whose side effect cannot be confirmed remains `DeliveryOutcomeUnknownError`; a missing local payload is never converted to successful delivery.
- Desktop launchers pass the same resource root, data root, CLI path, and OpenClaw state root to the server and Gateway. An occupied Gateway port is reusable only after the official RPC health probe succeeds.

### 4. Validation & Error Matrix

| Condition | Emitter result | Provider behavior |
|---|---|---|
| Valid direct payload | exact stdout, exit `0`, payload removed | verify remote delivery history |
| Payload already removed | stable missing marker, exit `3` | preserve uncertain/failed delivery semantics |
| Path outside outbound directory | argument marker, exit `2`, external file untouched | fail execution |
| Payload or outbound directory is a symlink | argument marker, exit `2` | fail execution |
| `EACCES` / other read error | read-failed marker with error code, exit `1` | fail execution; do not classify as missing |
| Port accepts TCP but fails OpenClaw RPC probe | launcher error | do not reuse the process |

### 5. Good / Base / Bad Cases

- Good: desktop server writes under its user-data root while Gateway has a different inherited environment; explicit argv still resolves the same payload.
- Good: emitter removes the file first and provider cleanup uses force/idempotent removal without replacing the original outcome with `ENOENT`.
- Base: a normal payload is emitted exactly once, remote history confirms delivery, and the one-shot cron is removed.
- Bad: infer the allowed directory only from the consumer process environment.
- Bad: catch every `readFile` error as success or ignore every `ENOENT` globally, including missing executables and configuration files.
- Bad: reuse any process that merely accepts TCP on the configured Gateway port.

### 6. Tests Required

- Provider unit test: parse `--command-argv` and assert executable, emitter, explicit outbound directory, and absolute `notification-*` path.
- Emitter process tests: exact output and removal; stable exit `3` for missing; exit `2` with no external read/delete for traversal and symlink inputs.
- Cleanup regression: assert provider cleanup succeeds when the consumer already removed the payload.
- Desktop verification: Rust check/test on Windows and macOS runners, followed by real MSI/EXE/DMG packaging.
- Release workflow: type-check and run Node/Rust tests before packaging each target architecture.

### 7. Wrong vs Correct

#### Wrong

```ts
const allowed = join(process.env.AIMONITOR_DATA_ROOT ?? projectRoot, 'openclaw-outbound');
await readFile(messagePath, 'utf8'); // uncaught ENOENT prints a runtime stack
```

#### Correct

```ts
const commandArgv = [process.execPath, emitterPath, outboundDir, messagePath];
rmSync(messagePath, { force: true });
```

```js
if (error.code === 'ENOENT') {
  process.stderr.write('AI_MONITOR_NOTIFICATION_PAYLOAD_MISSING\n')
  process.exitCode = 3
}
```
