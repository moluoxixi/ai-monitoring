# Error Handling

> Executable contracts for terminal AI events and notification delivery failures.

## Scenario: Terminal event normalization and notification delivery

### 1. Scope / Trigger

Apply this contract whenever a Codex, Claude, Qoder, or future adapter converts a terminal task event into `NormalizedEvent`, and whenever a notification provider delivers that event to one or more channels.

### 2. Signatures

```ts
interface NormalizedEvent {
  source_event_id: string;
  status: string;
  message: string;
  error_code: string | null;
  metadata: {
    task_summary?: string;
    failure_message?: string;
    [key: string]: unknown;
  };
}

DatabaseService.insertEvent(event: NormalizedEvent, channels: string[]): [number, boolean]
notificationContent(row: DeliveryRow): { title: string; body: string }
```

### 3. Contracts

- `source_event_id` must identify one terminal task, not one producer. A producer without enough information to construct a useful event must defer to the authoritative producer instead of emitting an empty duplicate.
- A completed event may store a sanitized `metadata.task_summary`.
- A failed event must keep the machine category in `error_code` and the sanitized human-readable cause in `metadata.failure_message`.
- Sanitization must redact bearer credentials, named secrets, secret query parameters, and local user-profile names. It must not replace an otherwise useful failure with a generic category such as `other`.
- Re-inserting an existing `source_event_id` must remain idempotent while enriching missing `task_summary` and `failure_message`. Existing non-empty values must not be overwritten.
- Every bound channel receives an independent delivery row. Success on one channel must not hide retry/dead state on another channel.

### 4. Validation & Error Matrix

| Input | Stored contract | Notification contract |
|---|---|---|
| Completed task with prompt | `task_summary` | `任务摘要：...`, max 100 characters |
| Completed task without prompt from secondary producer | no event | authoritative watcher emits the event |
| Failed task with detailed error | `error_code` plus redacted `failure_message` | `失败消息：...`, max 100 characters |
| Failed task with category only | `error_code` | category is the final fallback |
| Channel returns retryable error | delivery `retrying` | other channels continue independently |
| Channel reaches 10 failed attempts | delivery `dead` | event remains visible with failed channel state |

### 5. Good / Base / Bad Cases

```ts
// Good: useful cause survives with secrets redacted.
metadata: { failure_message: 'unexpected status 502; Authorization: <redacted>' }

// Base: no detailed cause was provided.
error_code: 'server_overloaded'

// Bad: loses the only actionable diagnosis.
metadata: {}
error_code: 'other'
```

### 6. Tests Required

- Adapter/parser test: assert the detailed failure survives and credentials do not.
- Notification test: assert `failure_message` wins over `task_summary` and `error_code`.
- Idempotency test: insert the same `source_event_id` twice and assert one event enriched with both fields.
- Producer test: assert a secondary completion producer with no task summary does not POST.
- Multi-channel test: assert one failed channel does not block another successful channel.
- Provider diagnostic test: map stable upstream errors to actionable local messages without changing the underlying binding.

### 7. Wrong vs Correct

#### Wrong

```ts
metadata: { task_summary }
error_code: String(error.codex_error_info || 'other')
```

#### Correct

```ts
metadata: {
  task_summary,
  failure_message: sanitizeFailureMessage(error.message),
}
error_code: safeErrorCode(error)
```

## Common Mistakes

- Treating a configured channel as proof of successful delivery.
- Testing only aggregate event state instead of each delivery row.
- Adding a second producer without reconciling its identity and payload completeness with the authoritative producer.
- Dropping human-readable errors in the name of privacy instead of redacting explicit credential patterns.
