## Scenario: External delivery uncertainty and Codex subagent filtering

### 1. Scope / Trigger

- Trigger: A channel provider can accept a message before its confirmation command or history query fails.
- Trigger: Codex notify and App Server adapters can observe Desktop child sessions even though their legacy payload names the client `codex-cli`.

### 2. Signatures

```ts
class DeliveryOutcomeUnknownError extends Error {}

interface ChannelProvider {
  send(channel: string, title: string, body: string): Promise<void>;
}
```

```py
def is_subagent_session(thread_id: str, codex_home: Path | None = None) -> bool: ...
```

### 3. Contracts

- A provider may throw `DeliveryOutcomeUnknownError` only after a remote job/request could have caused a side effect and local confirmation is unavailable.
- The delivery worker persists such a row as `dead`, keeps the diagnostic message, and does not schedule an automatic retry.
- Explicit remote failure with a structured “not delivered” result remains retryable.
- Codex adapters read only `session_meta` identity fields (`session_id`, `source`, `thread_source`, `originator`). They never return transcript content.
- A subagent completion is filtered before both the local relay POST and legacy notify-target fan-out.
- A session whose metadata identifies a normal user thread is not filtered merely because child rollouts share its parent id.

### 4. Validation & Error Matrix

| Condition | Provider result | Worker state | Retry |
|---|---|---|---|
| Cron creation fails before a job id exists | ordinary error | `retrying`/`dead` after limit | yes |
| Cron execution times out after job creation | `DeliveryOutcomeUnknownError` | `dead` | no |
| History query fails or is empty | `DeliveryOutcomeUnknownError` | `dead` | no |
| History says `status=error`, `delivered=false`, `deliveryStatus=failed` | ordinary error | `retrying`/`dead` after limit | yes |
| Session has `thread_source=subagent` or `source.subagent` | no relay event | no delivery | no |
| Session has `thread_source=user` | normal event | normal delivery | yes, subject to channel result |

### 5. Good / Base / Bad Cases

- Good: QQ Gateway accepts the message, `cron runs` times out, and the row becomes `dead` with “结果无法确认”; no second cron job is created.
- Base: QQ Gateway returns explicit failed/not-delivered status; normal exponential retry remains available.
- Bad: Treat every provider exception as retryable, or filter subagents only after sending to configured external targets.

### 6. Tests Required

- `openclaw.provider.spec.ts`: execution timeout, history query failure, pending history, and explicit failed/not-delivered history.
- `delivery-worker.service.spec.ts`: `DeliveryOutcomeUnknownError` marks `dead` with one attempt; ordinary errors remain retryable.
- `test_codex_session_identity.py`: object/string/typed source variants, filename collision, parent thread id in child rollout headers.
- `test_codex_notify_multiplexer.py`: subagent is excluded from both relay POST and legacy target fan-out.
- `test_codex_app_server_proxy.py`: subagent protocol event does not POST.
- `codex-session-watcher.spec.ts`: typed subagent metadata and explicit CLI metadata preserve the canonical client.

### 7. Wrong vs Correct

#### Wrong

```ts
try {
  await channels.send(channel, title, body);
} catch (error) {
  markRetrying(error);
}
```

#### Correct

```ts
try {
  await channels.send(channel, title, body);
} catch (error) {
  if (error instanceof DeliveryOutcomeUnknownError) {
    markDeadWithoutRetry(error.message);
  } else {
    markRetrying(error);
  }
}
```

