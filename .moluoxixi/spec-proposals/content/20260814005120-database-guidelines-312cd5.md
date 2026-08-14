## Scenario: Task Detail Conversation View

### 1. Scope / Trigger
- Trigger: The dashboard needs to show what was asked, the safe answer summary, failure reason, and notification delivery state without making Phoenix a required dependency.

### 2. Signatures
- `GET /api/events/:id` returns one persisted event and its deliveries.
- `DatabaseService.getDeliveriesForEvent(eventId: number): DeliveryRow[]` performs a parameterized event-scoped query.

### 3. Contracts
```json
{
  "id": 93,
  "message": "提问：修复登录失败",
  "status": "failed",
  "error_code": "codex_task_failed",
  "metadata": {
    "task_summary": "修复登录失败",
    "failure_message": "unexpected status 502 Bad Gateway"
  },
  "deliveries": [
    { "channel": "openclaw-qq", "state": "sent", "attempts": 1, "last_error": null }
  ]
}
```
- `metadata.answer_source` and raw assistant responses are transient and must not be returned or persisted.
- `metadata.answer_summary` is optional because online summarization is asynchronous or may be unavailable.
- The UI opens the task detail dialog first; Phoenix trace is an optional secondary link.

### 4. Validation & Error Matrix
| Case | API behavior |
|---|---|
| Existing event | HTTP 200 with event and zero or more deliveries |
| Unknown numeric ID | HTTP 404 `event not found` |
| Invalid ID | Nest `ParseIntPipe` validation error |
| Delivery lookup failure | Propagates as server error; no unbounded event query |

### 5. Good/Base/Bad Cases
- Good: Query uses `WHERE d.event_id = ?`, and the UI tolerates a missing `answer_summary`.
- Base: A completed event shows question, answer summary placeholder, and per-channel state.
- Bad: Making the Phoenix redirect the only message-row action, or exposing `answer_source` in JSON.

### 6. Tests Required
- Database test asserts deliveries from another event are excluded.
- Controller/integration coverage should assert HTTP 200/404 and the `deliveries` field.
- Frontend smoke coverage should assert clicking a row opens the task detail dialog and does not navigate away.

### 7. Wrong vs Correct
#### Wrong
```typescript
const href = `/api/events/${event.id}/trace`;
```

#### Correct
```typescript
const detail = await monitorApi.event(event.id);
selectedEvent.value = detail;
```
