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
