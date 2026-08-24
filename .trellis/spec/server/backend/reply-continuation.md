# Reply Continuation Contract

## 1. Scope / Trigger

This contract applies when an `openclaw-qq` completion notification can accept a quoted plain-text reply and continue an existing Codex or Claude conversation.

## 2. Signatures

- Notification marker: `[任务ID:<positive event id>]`
- Legacy marker accepted on input: `[AI-MONITOR-REPLY:<43 character base64url token>]`
- API: `POST /api/replies/inbound`
- Dispatch result: `{ threadId, turnId, writerReleased, cancel? }`
- Codex continuation: `thread/fork` followed by `turn/start`
- Claude continuation: `claude --print --verbose --output-format stream-json --resume <session> --fork-session --permission-mode dontAsk`
- Qoder continuation: `qodercli --print --verbose --output-format stream-json --resume <session> --fork-session --permission-mode dont_ask`

## 3. Contracts

- New notification bodies expose only the task ID. The delivery worker must still call `ensureDeliveryReplyRoute()` so token TTL, sent-state checks, and compare-and-set branch heads remain available in SQLite.
- The API requires the local reply bearer token, a private QQ quote, the bound sender/account, a unique QQ message ID, and a sent, unexpired delivery.
- Eligible clients are `codex-cli`, `codex-desktop`, `claude-cli`, `claude-desktop`, and `qoder-cli`. Codex requires `metadata.thread_id`; Claude and Qoder require a non-placeholder `metadata.session_id`.
- Claude/Qoder prompt text is written to stdin and must never be placed in argv or a shell command. Use event `metadata.cwd`; historical events may recover an absolute cwd from the matching local transcript before using the project-root compatibility fallback.
- `reply_thread_id` stores the latest continuation ID for both platforms and advances with compare-and-set semantics.
- When a new platform becomes eligible, upgrade backfill may create routes only for its already-sent completion deliveries whose original `sent_at + TTL` is still in the future. It must not reset the TTL from upgrade time or include unsupported sibling clients.
- `writerReleased` resolves only after the child writer actually exits or reports a process error. Sending a kill signal is not writer release. A compare-and-set loser must call `cancel`.
- Environment keys: `AIMONITOR_REPLY_ROUTE_TTL_DAYS`, `AIMONITOR_CODEX_COMMAND`, `AIMONITOR_CLAUDE_COMMAND`, and the platform-specific reply request/turn timeout keys.

## 4. Validation & Error Matrix

| Condition | Result |
|---|---|
| Missing task ID and legacy token | `400` invalid quoted route |
| Unsupported client or missing continuation ID | `400` unsupported continuation |
| Expired route | `410` |
| Delivery not sent | `409` |
| QQ sender/account mismatch | `403` |
| Duplicate QQ message ID | Return prior state without replay |
| Claude exits, times out, or emits invalid JSON before `system/init` | Reject dispatch and mark inbound reply failed |
| Persisted branch head differs from returned fork ID | Cancel the loser fork and fail the inbound reply |

## 5. Good / Base / Bad Cases

- Good: a Claude or Qoder CLI completion with `session_id` and `cwd` forks a new session, persists its ID, returns an immediate platform-neutral acknowledgement, and later produces a completion notification.
- Base: a historical Claude event without `cwd` recovers it from `~/.claude/projects/**/<session>.jsonl`.
- Bad: directly resume a Desktop-owned source session, interpolate QQ text into a command line, expose the opaque token in new notifications, or release serialization immediately after `child.kill()`.

## 6. Tests Required

- Delivery tests assert new bodies start with one task ID, omit `AI-MONITOR-REPLY`, and still call `ensureDeliveryReplyRoute()`.
- Database tests cover every eligible client, missing IDs, placeholder Claude IDs, stable token generation, TTL data, and branch-head compare-and-set behavior.
- Upgrade tests cover eligible sent-route backfill, expired deliveries, and unsupported sibling clients.
- Dispatcher/service tests cover consecutive forks, concurrent serialization, CAS loser cancellation, stdin-only prompt transport, Windows native/fallback invocation, transcript cwd recovery, invalid init records, synchronous stdin failure, and writer release after real exit.
- Plugin tests cover legacy token and task-ID extraction, platform-neutral acknowledgement, binding payload shape, and pass-through behavior for unrelated messages.

## 7. Wrong vs Correct

### Wrong

```typescript
child.kill();
releaseWriter();
```

### Correct

```typescript
child.kill();
child.once('exit', releaseWriter);
```

The kill request starts shutdown; only the process lifecycle event proves the single writer is gone.
