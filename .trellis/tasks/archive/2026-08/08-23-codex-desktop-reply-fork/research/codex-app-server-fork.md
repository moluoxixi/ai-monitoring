# Codex App Server fork research

## Official documentation

Source: [Codex App Server](https://learn.chatgpt.com/docs/app-server), read 2026-08-23.

- `thread/read` reads a stored thread without resuming it.
- `thread/fork` copies stored history into a new thread id; `ephemeral: true` creates an in-memory fork, while the default persistent fork writes a new session.
- A client must initialize once, acknowledge `initialized`, then use thread and turn methods.
- App Server transports include stdio, WebSocket and Unix socket; WebSocket is experimental/unsupported for production workloads.

## Local protocol probe

- The completed test thread `01a02bc6-a5b8-7303-877c-7ee412e8ce85` returns successfully from `thread/read` in a separate App Server process even while Desktop holds its writer.
- The same thread successfully returns an `ephemeral: true` fork with `forkedFromId` and `canAcceptDirectInput: true`; no Desktop process was stopped and the original thread lock remained present.
- The generated 0.147.0 schema has no writer release, transfer, steal or close method. `thread/fork` is therefore the supported boundary for a safe continuation branch.

## Classification note

Fork responses can preserve Desktop `source`/`originator` markers. The implementation must use the structured `thread_source: "cli"` marker and make both the TypeScript watcher and Python session identity helper prefer that marker, so fork completion notifications route as Codex CLI.

## Active-writer fork probe

- On 2026-08-23, an independent App Server called `thread/fork` with `ephemeral: true` against Desktop thread `01a02de2-705c-7d70-b4e3-c7b7e472567e` while its latest turn was `inProgress`.
- The call succeeded with a new idle CLI-sourced fork and did not return `already has an active writer`; no `turn/start` was sent and no session or writer-lock file was persisted.
- A second independent probe called `thread/fork` with `ephemeral: false` against the same Desktop thread. The persistent fork also succeeded without an active-writer error and was then archived through `thread/archive`; no turn was started.
- The second App Server's `thread/read` exposed the source as `notLoaded` with an interrupted persisted latest turn, so that probe alone does not prove cross-process visibility of Desktop's live runtime state. The first probe provides the active-turn evidence; together they cover the active source and persistent-fork properties without assuming that independent App Server processes share runtime status.
- This isolates the writer-safe operation at the protocol boundary: Monitor replies must fork from the latest completed head instead of resuming a thread that another client may have loaded.
