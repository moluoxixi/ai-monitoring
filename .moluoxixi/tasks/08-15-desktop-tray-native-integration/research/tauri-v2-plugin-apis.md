# Tauri v2 plugin research

Local crates.io sources for the resolved Tauri 2.11 toolchain confirm:

- `tauri` 2.11.5 exposes `TrayIconBuilder`, `TrayIconEvent`,
  `Builder::on_window_event`, and `CloseRequestApi::prevent_close()`.
- `tauri-plugin-autostart` 2.5.1 exposes
  `tauri_plugin_autostart::init(MacosLauncher, args)` and the `ManagerExt`
  `autolaunch().enable/disable/is_enabled` methods.
- `tauri-plugin-notification` 2.3.3 exposes the guest functions
  `isPermissionGranted`, `requestPermission`, and `sendNotification`; its
  default permission set is `notification:default`.
- `tauri-plugin-single-instance` 2.4.3 exposes `init(callback)` where the
  callback receives the existing `AppHandle`, arguments, and current working
  directory. It has no frontend permission requirement for a Rust-only use.

The tray's `DoubleClick` event is documented as Windows-only in the local Tauri
source, so macOS uses left-click restoration as the equivalent activation.
