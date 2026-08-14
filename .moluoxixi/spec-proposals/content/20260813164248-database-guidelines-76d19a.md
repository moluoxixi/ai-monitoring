# Database Guidelines

> Executable contracts for SQLite event persistence and notification delivery claims.

## Scenario: SQLite outbox delivery claims and leases

### 1. Scope / Trigger

Apply this contract whenever a worker reads due notification deliveries, performs an external send, retries a delivery, or changes the `deliveries` schema. Multiple server processes may share the same SQLite database.

### 2. Signatures

```ts
DatabaseService.claimDueDeliveries(
  now: string,
  limit?: number,
  leaseMs?: number,
): DeliveryRow[]

DatabaseService.renewClaimedDelivery(
  id: number,
  leaseToken: string,
  now: string,
  leaseMs?: number,
): boolean

DatabaseService.markClaimedDelivery(
  id: number,
  leaseToken: string,
  update: DeliveryUpdate,
): boolean
```

```sql
deliveries.state            TEXT NOT NULL
deliveries.lease_token      TEXT NULL
deliveries.lease_expires_at TEXT NULL
UNIQUE(deliveries.event_id, deliveries.channel)
```

### 3. Contracts

- Claiming must be a single synchronous SQLite transaction: choose eligible rows, update them to `claimed` with one random token and expiry, then read back only that token.
- Eligibility is `(pending|retrying and due) OR (claimed and lease expired)`.
- A claim batch contains one event's due channels so its channels may send concurrently without making later events wait on an aging lease.
- The worker must confirm or renew ownership immediately before starting an external send and periodically during long sends.
- Completion, retry, and dead-letter updates must match `id`, `state = 'claimed'`, and `lease_token`; every terminal update clears lease fields.
- Manual retry must reject `claimed` rows. It may reset only a non-active delivery.
- Schema initialization must inspect `PRAGMA table_info(deliveries)` and add missing lease columns for existing databases; `CREATE TABLE IF NOT EXISTS` alone is not a migration.
- Delivery is at-least-once. A process can crash after the remote channel accepts a notification but before SQLite records success. Strict exactly-once requires channel-side idempotency and is not promised by a lease.

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Two processes claim the same due row | exactly one receives the row |
| Lease expires before completion | a new token may reclaim it; the stale token cannot update state |
| Worker loses ownership before send starts | do not call the channel |
| Manual retry targets `claimed` | return `false`; preserve active lease |
| Send succeeds | mark `sent`, increment attempts, clear lease |
| Send fails below max attempts | mark `retrying`, set next attempt, clear lease |
| Send reaches max attempts | mark `dead`, clear lease |
| Existing database lacks lease columns | add columns before creating lease index |

### 5. Good / Base / Bad Cases

- Good: two `DatabaseService` instances share one file; only the first claim returns the delivery, and the second returns an empty list.
- Base: a single worker renews its token during a slow provider call and finalizes normally.
- Bad: `SELECT due rows` followed by an unconditional `UPDATE ... WHERE id = ?`; two processes can both perform the external send.

### 6. Tests Required

- Real SQLite integration test with two connections: assert a due row is returned once.
- Reclaim test: advance past expiry, assert the new token differs, stale completion returns `false`, and current completion returns `true`.
- Active retry test: assert `retryDelivery(id)` returns `false` for `claimed`.
- Worker test: assert all channels for one event start concurrently and every state update includes the row's lease token.
- Schema upgrade test when migration logic changes: open a database created without lease columns and assert initialization adds both columns and the lease index.

### 7. Wrong vs Correct

#### Wrong

```ts
const rows = database.dueDeliveries(now);
for (const row of rows) {
  await channels.send(row.channel, title, body);
  database.markDelivery(row.id, { state: 'sent' });
}
```

#### Correct

```ts
const rows = database.claimDueDeliveries(now, 20, LEASE_MS);
await Promise.all(rows.map(async (row) => {
  if (!row.lease_token) return;
  if (!database.renewClaimedDelivery(row.id, row.lease_token, utcNow(), LEASE_MS)) return;
  await channels.send(row.channel, title, body);
  database.markClaimedDelivery(row.id, row.lease_token, sentUpdate);
}));
```

## Common Mistakes

- Treating an in-process `processing` flag as cross-process mutual exclusion.
- Claiming many different events under one lease and processing the event groups sequentially.
- Extending a `CREATE TABLE IF NOT EXISTS` definition without migrating already-created tables.
- Claiming that a lease makes an external side effect exactly-once.
