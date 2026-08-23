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
