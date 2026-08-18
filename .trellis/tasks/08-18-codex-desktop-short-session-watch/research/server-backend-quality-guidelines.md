# Quality Guidelines

> Code quality standards for backend development.

---

## Scenario: Incremental JSONL Watchers With Polling Fallback

### 1. Scope / Trigger

- Apply this contract when a backend service incrementally consumes append-only JSONL files and uses filesystem notifications plus periodic discovery.
- Filesystem `add` and `change` events are hints, not a reliable source of truth. Writers may keep a file open, preserve its modification time, or finish between watcher callbacks.

### 2. Signatures

- Watcher lifecycle: `onModuleInit(): void`, `onModuleDestroy(): Promise<void>`.
- Incremental reader: `syncFile(path: string, createDeliveries?: boolean, readLimit?: number): Promise<void>`.
- Per-file state must include a stable identity and the byte `offset` of the last fully consumed newline.
- Polling discovery must observe both `path` and current byte `size`.

### 3. Contracts

- A discovered file is eligible for synchronization when it is unknown, its size differs from the consumed offset, or it has been truncated.
- A stable file with `size === offset` must not be enqueued again.
- At most one polling-fallback synchronization per path may be pending. The pending marker must be cleared after both success and failure.
- A read failure must leave the file eligible for a later polling retry.
- Only newline-terminated JSON records advance the offset. A partial trailing record remains pending until it is completed.
- Event persistence must retain a stable source event ID so replayed bytes cannot create duplicate events or deliveries.
- Existing backfill windows, source classification, and subagent filtering remain authoritative unless a separate contract changes them.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Unknown path with bytes | Enqueue one synchronization. |
| Known path where `size > offset` | Enqueue one incremental synchronization even without a filesystem event. |
| Known path where `size === offset` | Do nothing. |
| Known path where `size < offset` | Reinitialize through the existing truncation/identity path. |
| Synchronization throws | Log through the watcher boundary, clear pending state, and allow the next discovery scan to retry. |
| Trailing record has no newline | Do not advance offset; retry after growth. |
| The same terminal record is replayed | Database uniqueness prevents another event or delivery. |

### 5. Good / Base / Bad Cases

- Good: a short session is first read before `task_complete`; polling sees `size > offset` after completion and ingests exactly one terminal event.
- Base: a stable fully consumed file is scanned repeatedly without new reads or events.
- Bad: discovery skips every path already present in the state map, making a missed `change` event permanent.
- Bad: each timer tick enqueues the same still-running read, allowing an unbounded serial queue backlog.

### 6. Tests Required

- Simulate an initial non-terminal read, append a terminal record without invoking the filesystem callback, run discovery, and assert one event with the expected stable ID.
- Run discovery again without growth and assert the ingestion count remains one.
- Suspend a real incremental read below `syncFile`, invoke discovery twice, and assert only one pending read.
- Fail that read, run discovery again, and assert the retry succeeds exactly once.
- Keep existing startup snapshot, partial-line, truncation, backfill, and database uniqueness tests green.

### 7. Wrong vs Correct

#### Wrong

```ts
for (const path of discoveredPaths) {
  if (files.has(path)) continue;
  enqueue(path);
}
```

#### Correct

```ts
for (const [path, size] of discoveredFiles) {
  const state = files.get(path);
  if (state?.offset === size || pending.has(path)) continue;
  pending.add(path);
  enqueue(path).finally(() => pending.delete(path));
}
```
