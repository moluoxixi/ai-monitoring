# Implementation plan

1. Add Tauri tray, notification, autostart, and single-instance dependencies;
   enable the `tray-icon` feature; add the `main` capability permissions.
2. Extend `lib.rs` with shared restore/focus behavior, tray menu/event wiring,
   close-to-hide interception, plugin registration, and non-fatal autostart
   initialization logging while preserving sidecar cleanup.
3. Add the Vue desktop-integration composable. Implement an opt-in autostart
   toggle in the existing settings popover and terminal-event native
   notification deduplication in `useMonitor`.
4. Update desktop documentation with tray, quit, autostart, notification, and
   unsigned-build behavior.
5. Run Rust tests, web tests/typecheck, desktop prerequisite checks, a desktop
   build check if the local toolchain permits it, and `git diff --check`.
6. Review the final diff for unrelated files and preserve all pre-existing dirty
   changes before staging or committing.

## Risk points

- Tauri plugin APIs and capability permission names must match the resolved v2
  crate versions.
- The notification module must remain dynamically loaded so `npm run build`
  still works in a normal browser.
- Tray callbacks run outside Vue; explicit quit must use `AppHandle::exit` so
  sidecars are not orphaned.
