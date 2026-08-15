# Desktop integrations contract

## Scenario: Tauri desktop lifecycle and native integrations

### 1. Scope / Trigger

- Trigger: the desktop shell now owns tray lifecycle, single-instance routing,
  autostart registration, and native notifications while Vue continues polling
  the existing monitor API.
- Target: `frontend/desktop-integrations.md`.

### 2. Signatures

- Rust tray IDs: `show-main` and `quit`.
- Rust helper: `restore_main_window(app: &tauri::AppHandle<R>)` shows,
  unminimizes, and focuses the `main` webview window.
- Vue helper: `useDesktopIntegrations()` returns
  `setAutostart(enabled: boolean): Promise<void>` and
  `notifyTerminalEvent(event: MonitorEvent): Promise<void>`.
- Vue predicate: `isTerminalMonitorEvent(event)` returns true only for
  `completed`, `failed`, `interrupted`, and `tool_failed`.

### 3. Contracts

- `CloseRequested` on the `main` window calls `prevent_close()` then `hide()`;
  it does not terminate managed child processes.
- Tray `show-main` restores/focuses the window. Tray `quit` calls
  `AppHandle::exit(0)` so `RunEvent::Exit` performs child cleanup.
- A second process invokes the single-instance callback and must not start a
  second Node server or Gateway.
- Autostart is opt-in. The web UI calls the plugin's `isEnabled`, `enable`, and
  `disable` APIs only when `window.__TAURI_INTERNALS__` exists.
- Native notifications are sent only for new terminal event IDs after the
  initial event history has been seeded. Permission denial and plugin errors
  are swallowed by the notification path and must not fail polling.
- Capability `main` grants `core:default`, `notification:default`, and
  `autostart:default`; the Rust-only single-instance callback needs no frontend
  permission.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| Browser runtime | Hide desktop settings and do not dynamically load Tauri APIs |
| Main close request | Prevent close, hide window, keep sidecars alive |
| Tray quit | Exit app and run exactly-once sidecar cleanup |
| Secondary launch | Restore existing main window; no duplicate sidecar |
| Autostart enable/disable failure | Restore previous toggle value and show recoverable UI error |
| Notification permission denied | Do not send toast; keep refresh success state |
| Notification module unavailable | Ignore error; keep event polling and delivery UI working |

### 5. Good/Base/Bad Cases

- Good: the first poll seeds IDs, the next poll adds event 42 with
  `status=completed`, and exactly one native notification is emitted.
- Base: repeated polls contain event 42; no second notification is emitted.
- Bad: importing `@tauri-apps/plugin-notification` at module initialization in
  browser mode or treating its failure as a monitor API failure.

### 6. Tests Required

- Rust unit test maps `show-main`, `quit`, and unknown tray IDs to explicit
  actions.
- Vue unit tests cover terminal status filtering and browser runtime detection.
- CI must run `cargo test`, web/server tests, and typecheck. A desktop build
  must produce both Windows installer formats and the macOS workflow must keep
  its Intel/Apple Silicon artifacts.
- Manual smoke checks should close/restore/quit from the tray, launch twice,
  toggle autostart, and deny notification permission on Windows and macOS.

### 7. Wrong vs Correct

#### Wrong

```typescript
import { sendNotification } from '@tauri-apps/plugin-notification'

// Runs during browser development and can reject the monitor refresh.
sendNotification({ title: event.title, body: event.message })
```

#### Correct

```typescript
if (isTauriRuntime() && isTerminalMonitorEvent(event)) {
  try {
    const api = await import('@tauri-apps/plugin-notification')
    // Request permission and send only for a new event ID.
    api.sendNotification({ title: event.title, body: event.message })
  } catch {
    // Native notification is optional; polling must remain healthy.
  }
}
```
