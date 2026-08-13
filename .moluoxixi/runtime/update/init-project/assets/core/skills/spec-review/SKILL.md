---
name: spec-review
description: "Reviews pending project knowledge proposals before they enter .moluoxixi/spec/. Use when a task produces reusable conventions, when proposals are due for periodic governance, or when duplicate, stale, conflicting, merge, rejection, or deletion decisions need explicit human approval."
---

# Spec Review

Keep `.moluoxixi/spec/` limited to reviewed knowledge. Treat `.moluoxixi/spec-proposals/` as an inbox, not as active implementation guidance.

## Review Flow

1. Run the read-only audit:

```bash
node ./.moluoxixi/scripts/spec-proposals.mjs audit
node ./.moluoxixi/scripts/spec-proposals.mjs list
```

2. Inspect each candidate and compare it with the current spec:

```bash
node ./.moluoxixi/scripts/spec-proposals.mjs show <proposal-id>
```

Classify it as promote, reject, merge, exact duplicate, stale, or delete. Check evidence, scope, executable contracts, conflicts, and whether the knowledge is still true.

3. Present one review batch to the user. Show target paths, decisions, material changes, and any merged result. Do not approve on the user's behalf.

4. Only after explicit approval, record the decision:

```bash
node ./.moluoxixi/scripts/spec-proposals.mjs review <proposal-id> \
  --decision promote \
  --by <reviewer> \
  --user-approved
```

For a merge, write the reviewed result to a task-local file and add `--content-file <file> --supersedes <id,id>`. For rejection, use `--decision reject`.

5. Apply only the recorded approval:

```bash
node ./.moluoxixi/scripts/spec-proposals.mjs apply <proposal-id> --user-approved
```

Use `--user-approved` only as part of the exact batch the user just approved.
The apply command rejects proposal drift and target-spec drift. Never bypass it
by directly editing `.moluoxixi/spec/` as part of knowledge capture.

## Periodic Governance

Run `audit` at task completion. A review is due after 30 days without a reviewed audit or when at least 10 proposals are pending. The audit is read-only. After the user reviews the batch, record completion with:

```bash
node ./.moluoxixi/scripts/spec-proposals.mjs audit \
  --mark-reviewed \
  --by <reviewer> \
  --user-approved
```

Do not delete proposal history during routine review. Reject or supersede proposals so decisions remain auditable.
