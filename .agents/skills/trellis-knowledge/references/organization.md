# Knowledge Organization

## Ownership

`sources/` is the immutable inbox. `library/` and `index.md` are derived project
knowledge. `.state.json` records the exact source bytes successfully organized;
timestamps do not define identity.

## Boundaries

Choose the first directory by stable business domain, service, package, or
product module. Within a domain, split by stable entity:

- `apis`: resources and coherent operation groups.
- `models`: schemas and domain objects.
- `events`: messages, topics, and lifecycle events.
- `processes`: multi-step business flows.
- `concepts`: terminology and explanatory material.
- `decisions`: factual architectural decisions and rationale.

Use `shared/` only for genuinely cross-domain material such as authentication
or a common error model. Tags are metadata, not duplicate pages.

Keep a coherent CRUD or lifecycle surface together. Split a page when it has an
independent version, owner, lifecycle, or enough internal structure that one
concept is hard to locate. Prefer semantic cohesion over fixed size thresholds.

## Canonical Pages

Each stable entity has one canonical page. Prefer source identifiers such as
OpenAPI `operationId`; otherwise derive an ID from domain, kind, version, and
stable name. For an API without `operationId`, use version plus method and path.
Link aliases to the canonical page instead of copying content.

Start each page with compact metadata:

```yaml
---
id: api:payments:v1:create-payment
kind: api
domain: payments
sources:
  - .trellis/knowledge/sources/payments.yaml#/paths/~1payments/post
---
```

Record purpose, contract or behavior, data and error semantics, lifecycle,
relationships, deprecation state, and unresolved conflicts. Preserve exact
names and values from authoritative sources.

## Source Changes

- Addition or modification: update only affected entities and indexes.
- Duplicate: merge evidence into the canonical page when identity is certain.
- Conflict: preserve both claims and ask which source is authoritative.
- Deletion: remove a claim only when no remaining source supports it; ask when
  other references or ownership are unclear.
- Rename: update the source path when identity is certain; otherwise retain
  delete-plus-add semantics.

## Index

Keep `index.md` compact: list domains and canonical pages with a one-line purpose
plus pending or conflict status. It is navigation, not a copy of the library.
Avoid generated timestamps so unchanged knowledge stays diff-stable.
