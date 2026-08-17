# Review Proposed Project Knowledge

Load `moluoxixi-spec-review` and review `.moluoxixi/spec-proposals/` as a human-controlled batch.

Start with the read-only commands:

```bash
node ./.moluoxixi/scripts/spec-proposals.mjs audit
node ./.moluoxixi/scripts/spec-proposals.mjs list
```

Show the user the proposed promote, merge, reject, deduplicate, and delete decisions. Do not record approval or modify `.moluoxixi/spec/` until the user explicitly approves the batch. Then use the skill's `review` and `apply` sequence.
