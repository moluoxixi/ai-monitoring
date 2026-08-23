# QQ 引用续接 Codex Desktop 分支会话 - Design

## Architecture

The existing inbound reply flow remains the entry point. A route still points at the original notification delivery, but deliveries gain a nullable `reply_thread_id` containing the persistent continuation target.

```text
QQ quote
  -> RepliesService validates token/task id + binding + idempotency
  -> PlatformReplyDispatcher selects codex-cli resume or codex-desktop fork
  -> Codex App Server subprocess
       cli:     initialize -> initialized -> thread/resume -> turn/start
       desktop: initialize -> initialized -> thread/fork -> turn/start
  -> persist fork id on the original delivery
  -> existing session watcher emits the next completion notification
```

The original Desktop thread is never resumed by the Monitor. The fork is persisted in the same Codex session store and is owned by the Monitor-launched App Server connection for the active turn.

## Route and persistence contract

- `deliveries.reply_thread_id TEXT NULL` is additive and only populated after a Desktop fork succeeds.
- `ReplyRoute.reply_thread_id` is returned by both token and task-id route projections.
- `ensureDeliveryReplyRoute` accepts `codex-cli` and `codex-desktop` completed events with a non-empty thread id. It continues to require `openclaw-qq`.
- `setReplyThreadId(deliveryId, threadId)` updates only a null value, so a later retry cannot replace the first successful continuation target.
- The first Desktop request forks from `metadata.thread_id`; later requests use `reply_thread_id` as the resume target. The original thread id remains available as the fork provenance and is never overwritten in event metadata.

## App Server protocol

`CodexAppServerReplyService.dispatch` receives the route client and optional persisted target.

- CLI route: existing `thread/resume` then `turn/start`.
- Desktop route without `reply_thread_id`: `thread/fork` with `ephemeral: false`, `threadSource: "cli"`, then `turn/start` using the returned fork id.
- Desktop route with `reply_thread_id`: `thread/resume` that id, then `turn/start`.
- All turns use `approvalPolicy: "never"`; no private Desktop stdio, process termination, or writer bypass is used.
- The adapter returns the actual target thread id and turn id. The caller persists the target only after `turn/start` is accepted.

## Runtime classification

Codex session metadata can preserve Desktop `source`/`originator` when a thread is forked. The watcher and Python session identity helper therefore give explicit `thread_source: "cli"` precedence over Desktop markers. This is limited to structured session metadata; message text and file paths remain non-authoritative.

## Failure and recovery

- A failed fork never writes `reply_thread_id`; the original Desktop route remains intact and a later QQ message can retry.
- Existing `(channel, external_message_id)` idempotency remains the first gate. Accepted duplicate QQ messages do not dispatch again.
- A concurrent first reply may race before the fork id is persisted; the database update is first-writer-wins. The MVP does not claim a cross-process lease for distinct QQ message ids; the follow-up hardening item is a per-delivery fork creation lease if real concurrent duplicates are observed.
- Fork-created completion notifications are classified as CLI so normal route generation and subsequent replies use the fork directly.

## Compatibility and rollback

- Existing CLI routes and schema are backward-compatible; old databases receive the new nullable column on startup.
- Removing Desktop eligibility from `ensureDeliveryReplyRoute` disables new Desktop routes without deleting existing fork ids.
- No Claude Desktop or UI automation behavior changes.
