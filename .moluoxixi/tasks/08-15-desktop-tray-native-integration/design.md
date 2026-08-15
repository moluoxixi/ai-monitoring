# Technical design

## Boundaries

The Tauri shell owns process lifetime and OS integration. The Vue client owns
the user-facing autostart toggle and observes the existing event polling
stream. The server remains the source of monitor events and channel delivery.

## Runtime flow

1. Tauri registers single-instance, notification, and autostart plugins before
   setup. The single-instance callback restores the `main` window when a second
   process is attempted.
2. Setup creates a tray menu and icon, then starts/reuses the Gateway and Node
   server as it does today.
3. `CloseRequested` on `main` is prevented and converted to `window.hide()`.
   Tray show and activation call one shared restore/focus helper. Tray quit
   calls `AppHandle::exit(0)`, preserving the existing `RunEvent::Exit` child
   cleanup.
4. The Vue client dynamically loads Tauri notification/autostart guest APIs
   only after detecting `window.__TAURI_INTERNALS__`. Initial event IDs are
   seeded without notification; later newly observed terminal IDs produce one
   OS notification each.

## Contracts

- Tray menu IDs are stable: `show-main` and `quit`.
- Autostart state is read from the plugin's `isEnabled()` result. The toggle
  calls `enable()` or `disable()` and rolls back its local ref on failure.
- Native notification failures are intentionally isolated from the refresh
  promise. The event list and polling error state must remain unchanged.
- A capability file associates `main` with `core:default`,
  `notification:default`, and `autostart:default`. No single-instance
  permission is needed because its callback is Rust-only.

## Platform choices and trade-offs

- The macOS autostart plugin uses its LaunchAgent implementation, which works
  for an unsigned development bundle and does not require AppleScript prompts.
- Tray left-click restoration is enabled on both platforms. This gives macOS a
  usable equivalent to Tauri's Windows-only `DoubleClick` event.
- Autostart remains off until the user enables it; this avoids changing login
  behavior during an upgrade.
- Notifications are generated in the client polling layer rather than adding a
  new server-to-Tauri IPC channel. This keeps the existing web/server contract
  stable and lets browser development continue without native APIs.

## Compatibility and rollback

The feature is additive. Removing the three plugin registrations, capability
file, desktop composable, and tray handlers restores the previous foreground
window behavior. If an OS plugin cannot initialize, startup should log the
failure and continue wherever the plugin API allows it; autostart toggle errors
remain recoverable UI errors.
