## Scenario: Task Detail Conversation View

### 1. Scope / Trigger
- Trigger: The dashboard needs to show what was asked, the cleaned final answer, failure reason, and notification delivery state without making Phoenix a required dependency.

### 2. Signatures
- `GET /api/events/:id` returns one persisted event and its deliveries.
- `DatabaseService.getEvent(id: number, includeAnswerText?: boolean): EventRow | null` returns `answer_text` only when the flag is `true`.
- `DatabaseService.getDeliveriesForEvent(eventId: number): DeliveryRow[]` performs a parameterized event-scoped query.
- `events.answer_text TEXT NULL` stores at most 24,000 cleaned characters for completed events.

### 3. Contracts
```json
{
  "id": 93,
  "message": "提问：修复登录失败",
  "status": "failed",
  "error_code": "codex_task_failed",
  "answer_text": null,
  "metadata": {
    "task_summary": "修复登录失败",
    "failure_message": "unexpected status 502 Bad Gateway"
  },
  "deliveries": [
    { "channel": "openclaw-qq", "state": "sent", "attempts": 1, "last_error": null }
  ]
}
```
- `metadata.answer_source` is transient and must never be persisted or returned.
- `answer_text` contains the cleaned final answer only for completed events. It is excluded from `GET /api/events`, delivery projections, notification text, trace inputs, and logs.
- `metadata.answer_summary` is optional because online summarization is asynchronous or may be unavailable.
- The UI opens the task detail dialog first; Phoenix trace is an optional secondary link.
- Existing databases inspect `PRAGMA table_info(events)` and add the nullable column without rebuilding the table.

### 4. Validation & Error Matrix
| Case | API behavior |
|---|---|
| Existing event | HTTP 200 with event and zero or more deliveries |
| Unknown numeric ID | HTTP 404 `event not found` |
| Invalid ID | Nest `ParseIntPipe` validation error |
| Delivery lookup failure | Propagates as server error; no unbounded event query |
| Failed/interrupted event carries an answer field | discard it; persist no `answer_text` |
| Existing database lacks `answer_text` | add the nullable column during initialization |

### 5. Good/Base/Bad Cases
- Good: Detail projection explicitly opts in to `answer_text`; list and delivery responses do not contain the field.
- Base: A completed event shows question, complete answer or summary fallback, and per-channel state.
- Bad: Using `SELECT *` plus an unfiltered row mapper for list responses, or storing `answer_source` in `metadata_json`.

### 6. Tests Required
- Database test asserts deliveries from another event are excluded.
- Database tests assert list/default lookup/delivery rows omit `answer_text`, detail lookup returns it, duplicates only fill an empty answer, and old schemas migrate without data loss.
- Ingestion tests assert failed/interrupted events discard answer fields.
- Controller/integration coverage should assert HTTP 200/404 and the `deliveries` field.
- Frontend smoke coverage should assert clicking a row opens the task detail dialog and does not navigate away.

### 7. Wrong vs Correct
#### Wrong
```typescript
const events = db.prepare('SELECT * FROM events').all();
return events;
```

#### Correct
```typescript
const event = database.getEvent(id, true);
return { ...event, deliveries: database.getDeliveriesForEvent(id) };
```
