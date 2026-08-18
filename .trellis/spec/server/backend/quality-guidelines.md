# Quality Guidelines

> Code quality standards for backend development.

---

## Overview

<!--
Document your project's quality standards here.

Questions to answer:
- What patterns are forbidden?
- What linting rules do you enforce?
- What are your testing requirements?
- What code review standards apply?
-->

(To be filled by the team)

---

## Forbidden Patterns

<!-- Patterns that should never be used and why -->

(To be filled by the team)

---

## Required Patterns

- External runtime adapters and their downstream readers must share an explicit
  data-shape contract. A successful write or RPC response does not prove that a
  watcher can consume the runtime's persisted representation.
- JSONL/session watcher changes must include a regression fixture copied from
  the runtime's actual emitted shape, including top-level record type, payload
  discriminator, role, and content node type.
- A new user-turn record must reset all turn-scoped derived state together:
  task summary, prior answer source, start timestamp, and start turn ID.
- If a public correlation marker appears on more notifications than the subset
  that supports an inbound action, the inbound adapter must still claim that
  marker and return a deterministic unsupported response. It must not fall
  through to an unrelated generic agent or provider.

---

## Testing Requirements

- For a workflow that writes through one adapter and reads through another,
  test both boundary contracts and assert the final user-visible projection.
- Notification delivery tests must distinguish public correlation metadata
  (for example, a task/event ID) from capability-bearing routing tokens; the
  former may be shown on every channel, while the latter must remain limited to
  eligible channels and events.
- Runtime plugin tests must cover both an eligible marker and a public marker
  for an ineligible task, asserting that both are handled and that only the
  eligible case reaches the platform dispatcher.

---

## Code Review Checklist

<!-- What reviewers should check -->

(To be filled by the team)
