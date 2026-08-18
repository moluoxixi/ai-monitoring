# Desktop tray and native integration

## Goal

Make the Windows and macOS desktop bundle behave like a background monitoring
application instead of a short-lived browser window. Users must be able to
close the window without stopping monitoring, restore it from the system tray,
receive important terminal-event notifications, opt into launch-at-login, and
avoid duplicate desktop processes.

## Confirmed facts and constraints

- The Tauri shell starts the Node monitor and optional OpenClaw Gateway in
  `apps/desktop/src-tauri/src/lib.rs` and currently stops them from
  `RunEvent::Exit`.
- Tauri is pinned to the 2.x line and the release workflow already builds
  Windows x64 plus macOS Intel and Apple Silicon bundles.
- Existing web notifications are delivery-channel notifications; they do not
  provide OS-native desktop notifications.
- Existing users must retain an explicit quit path. Hiding the main window may
  not terminate the managed sidecars.
- Autostart is opt-in and must not silently change a user's login behavior.

## Requirements

### R1. System tray lifecycle

- Create a tray icon using the existing application icon assets on Windows and
  macOS.
- Intercept the main window close request, prevent process exit, and hide the
  window while leaving both managed sidecars alive.
- Provide tray actions to show/focus the main window and explicitly quit the
  application.
- Restore/focus the window from a tray activation. Windows supports a
  double-click gesture; macOS must use the platform-supported left-click
  activation as the equivalent because Tauri's native double-click event is
  Windows-only.
- Explicit quit must flow through the existing exit cleanup so child processes
  are terminated exactly once.

### R2. Single instance

- Register the Tauri single-instance plugin for Windows and macOS.
- A secondary launch must not start another server or Gateway. It must forward
  activation to the existing instance and restore/focus its main window.

### R3. Autostart

- Register the Tauri autostart plugin using the native Windows and macOS
  mechanisms.
- Expose an opt-in toggle in the desktop settings surface. The browser
  development build must not show or invoke this control.
- Failed OS registration must be shown as a recoverable UI error and must not
  prevent the monitor from starting.

### R4. Native notifications

- Register the Tauri notification plugin and its capability permission.
- In a Tauri desktop runtime, notify only for newly observed terminal events:
  `completed`, `failed`, `interrupted`, or `tool_failed`.
- Request notification permission on first use. Permission denial or an
  unavailable notification API must not break polling or surface as a data
  loading error.
- Do not send notifications for the initial event history loaded at startup,
  duplicate refreshes, or browser development mode.

### R5. Cross-platform packaging and documentation

- Keep the existing Windows/macOS packaging commands and assets working.
- Document tray close/quit behavior, autostart opt-in, notification permission,
  and the platform-specific tray activation difference in
  `apps/desktop/README.md`.

## Acceptance criteria

- [ ] `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` passes with
      the tray and all three plugins enabled.
- [ ] `npm run typecheck` and `npm test` pass with the desktop-only composables
      and notification path included.
- [ ] `npm run desktop:check` and `git diff --check` pass.
- [ ] A close request hides the `main` window and does not call the sidecar
      cleanup path; an explicit tray quit does call `RunEvent::Exit` cleanup.
- [ ] Tray show/quit menu IDs, single-instance callback, and autostart default
      behavior are covered by focused Rust tests or deterministic helper tests.
- [ ] Browser mode builds without importing or invoking Tauri-only APIs.
- [ ] The README accurately describes Windows and macOS behavior and does not
      claim signing/notarization that the workflow does not provide.

## Out of scope

- Linux tray/autostart support, mobile targets, installer signing, and macOS
  notarization.
- A new backend event transport; the web client continues polling the existing
  `/api/events` endpoint.
- Replacing existing QQ/Weixin delivery notifications with native OS delivery.
