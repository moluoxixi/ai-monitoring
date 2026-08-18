# Runtime Integration Guidelines

> Executable contracts for local runtime plugins whose configuration and process lifecycle are managed separately.

---

## Scenario: OpenClaw Inbound Hook Dispatch And Runtime Synchronization

### 1. Scope / Trigger

- Trigger: a local service depends on an OpenClaw plugin to intercept a normal channel message before the default agent and call an authenticated local API.
- Apply this contract when adding or changing the typed hook, channel payload mapping, plugin package, `plugins.entries.<id>.config`, environment fallbacks, desktop bootstrap, Docker entrypoint, or a source deployment that reuses a global Gateway.
- Hook registration, hook dispatch reachability, channel field mapping, installation state, persisted configuration state, and live Gateway process state are independent. Verifying only one does not prove the integration is active.

### 2. Signatures

- Install and configure: `node scripts/ensure-openclaw-plugins.mjs`
- Activate installed code: `openclaw gateway restart`
- Plugin registration: `api.on("before_dispatch", handler, options)`
- Handler result: `{ handled: true, text: string } | undefined`
- QQ 2.0.1 inputs: `event.content`, `event.channel`, `event.senderId`, `event.replyToId`, `event.replyToBody`, `event.isGroup`, and `context.accountId`
- Persistent config path: `plugins.entries.ai-monitor-replies.config`
- Runtime config input: `api.pluginConfig: Record<string, unknown> | undefined`

### 3. Contracts

- `replyToken: string` is required for authenticated callbacks. Persist it in OpenClaw state and never write it to logs or notification bodies.
- `replyUrl: string` defaults to `http://127.0.0.1:8787/api/replies/inbound` for local deployments and uses the service-network URL in Docker.
- `timeoutMs: number` is normalized to the inclusive range `1000..60000`.
- On OpenClaw 2026.7.1-2, `inbound_claim` is dispatched only for plugin-owned conversation bindings. A normal QQ direct conversation must use the global `before_dispatch` hook to intercept before the default agent.
- Tencent QQBot 2.0.1 supplies the structured quote in `replyToBody` and the current inbound message id in `replyToId`, but does not set `replyToIsQuote`. Match exactly one AI Monitor token in `replyToBody`; do not parse the flattened agent body and do not require `replyToIsQuote === true`.
- `before_dispatch.content` is the raw user text without the structured quote. A matched handler returns `{ handled: true, text }`; the `inbound_claim` shape `{ handled: true, reply: { text } }` is invalid for this hook.
- The handler reads non-empty persistent plugin config first, then falls back to `AIMONITOR_REPLY_TOKEN`, then `AIMONITOR_INGEST_TOKEN` for backward compatibility.
- The installer may load the repository `.env`, but already supplied process environment values retain deployment-specific authority.
- A plugin package version change must update every runtime marker that controls whether installation is skipped.
- A desktop process must not reuse an arbitrary Gateway solely because its port and RPC health check succeed. The Gateway state and authentication configuration must be proven compatible; otherwise fail with an actionable error.

### 4. Validation & Error Matrix

- Plugin missing from the active state -> install it; require a Gateway restart before claiming inbound messages.
- Hook is registered as `inbound_claim` for an ordinary QQ conversation -> reject the integration: the hook will not run and the message will fall through to the default agent.
- `replyToBody` has no unique valid Monitor token, channel is not `qqbot`, or the message is a group message -> return `undefined` so normal routing continues.
- A valid structured quote has no sender/current message id -> return a handled explanatory reply; do not call Monitor and do not fall through to the agent.
- Installed package version differs from the expected version -> force reinstall, verify the typed hook, then restart the Gateway.
- `replyToken` and ingest fallback are both empty -> keep the endpoint fail-closed and return an explicit local configuration error.
- Persisted token differs from the Monitor token -> resynchronize config before restart; do not accept both secrets indefinitely.
- External Gateway occupies the desktop port but its state identity is unknown -> refuse reuse and explain how to stop it or use its existing Monitor.
- Configuration CLI returns redacted secret placeholders -> never use CLI display output as runtime secret input; compare local structured state by hash when diagnostics require it.

### 5. Good/Base/Bad Cases

- Good: installer writes the current token and URL, runtime inspection reports `before_dispatch`, Gateway restarts, and a real QQ quote creates an `inbound_replies` row without a new `session:agent:main:qqbot:direct` 401 route.
- Base: no dedicated reply token is set; the installer and Monitor both use the same non-empty ingest-token fallback.
- Bad: `inbound_claim` appears in runtime inspection, but the normal QQ conversation has no plugin-owned binding. The handler is never called and the message reaches the default agent.
- Bad: the plugin exists in a temporary or desktop state, while the active global Gateway uses a different state. A QQ quote then falls through to the ordinary agent even though an isolated plugin inspection passed.
- Bad: configuration is updated on disk but the process still runs an older plugin module after installation.
- Bad: a synthetic HTTP probe passes authentication and is reported as end-to-end success even though no channel message exercised OpenClaw dispatch.

### 6. Tests Required

- Unit: persistent `pluginConfig` overrides stale process environment values for token and URL.
- Unit: blank dedicated token falls back to the ingest token.
- Contract: the plugin registers `before_dispatch`, accepts QQ 2.0.1 with `replyToIsQuote` absent, posts `content` as reply text and `replyToId` as the idempotency message id, and returns `{ handled: true, text }`.
- Pass-through: an ordinary QQ message, group message, or quote without a unique Monitor token returns `undefined` and does not call Monitor.
- Packaging: expected package version and desktop marker version change together.
- Runtime integration: plugin registry reports `loaded`, runtime inspection contains `before_dispatch`, and the persisted token hash matches the Monitor token hash.
- HTTP probe: a well-formed fake route with the synchronized bearer reaches `reply route was not found`, not `401`.
- Channel E2E: send a real QQ structured quote; assert a new `inbound_replies` row, Codex turn acceptance, the QQ acknowledgement, and no default-agent 401 for that message. Runtime inspection and HTTP probes are prerequisites, not substitutes.
- Desktop: an already occupied Gateway port with unknown state returns an actionable error instead of silently reusing the process.

### 7. Wrong vs Correct

#### Wrong

```javascript
register(api) {
  api.on("inbound_claim", createHandler({
    pluginConfig: api.pluginConfig,
    environment: process.env,
  }));
}
```

This hook is not dispatched for an ordinary QQ conversation on OpenClaw 2026.7.1-2. Runtime inspection can still report it as loaded, creating a false positive.

#### Correct

```javascript
register(api) {
  api.on("before_dispatch", createHandler({
    pluginConfig: api.pluginConfig,
    environment: process.env,
  }));
}
```

The handler matches only the structured QQ quote token and returns `{ handled: true, text }`. The managed installer writes shared config to the active OpenClaw state, verifies `before_dispatch`, and coordinates the required Gateway restart. A real channel E2E remains mandatory before reporting success.
