# AI Monitor Desktop

The desktop client is a small Tauri 2 shell around the existing NestJS service.
It does not duplicate monitoring logic in Rust:

1. Tauri reuses a healthy monitor on `127.0.0.1:8787` or starts the Node sidecar on that fixed hook port.
2. The sidecar receives an isolated resource root and a writable user-data root.
3. Tauri waits for `/api/health`, then navigates the window to the sidecar.
4. On exit it terminates only the Node process started by this app.

## Tray and desktop behavior

The desktop window is intentionally a background application. Closing the
window hides it to the Windows notification area or the macOS menu bar and
leaves the monitor and Gateway running. Use the tray menu's **显示 AI Monitor**
entry to restore the window, or **退出 AI Monitor** to stop the sidecars and
exit cleanly. A Windows double-click restores the window; macOS uses a left
click because its native tray event does not expose the same double-click event
through Tauri.

Open the **扩展** settings popover in the desktop client to opt into launch at
login. The setting uses the native Windows startup registration or macOS
LaunchAgent and remains off until enabled. Removing the startup entry from the
same toggle is safe and does not affect an already running monitor.

Newly observed completed, failed, interrupted, or tool-failed events can also
produce native Windows/macOS notifications. The first notification may ask
for operating-system permission. Denying it only disables the desktop toast;
the event list and configured QQ/Weixin delivery channels continue to work.

## What is bundled

OpenClaw is bundled in the default desktop package because it is the local
delivery gateway for QQ and Weixin. The package contains a pinned OpenClaw
version and both Tencent channel plugins, so end users do not need to install
Node.js, OpenClaw, or the plugins separately. The first launch still requires
the user to scan the QQ/Weixin QR code; credentials cannot be shipped in an
installer and are stored only in the platform user-data directory.

Use `AIMONITOR_DESKTOP_SKIP_OPENCLAW_INSTALL=1` only when intentionally making
a monitor-only package for an already managed external Gateway.

## Development

Requirements on Windows:

- Node.js 24.15+ (or 22.22.3+ for the OpenClaw engine)
- Rust toolchain
- Visual Studio Build Tools with the MSVC toolchain and Windows SDK
- WebView2 Runtime

Run `npm run desktop:check` before compiling. If `link.exe` is missing, run
`npm run desktop:install-windows-runtime` in an elevated PowerShell window. The
script installs the official Visual Studio Build Tools C++ workload and the
Windows SDK; it does not install third-party toolchains. `desktop:dev` and
`desktop:build` automatically load `VsDevCmd.bat`, so a normal PowerShell or
Command Prompt is sufficient after installation.

On macOS, install Node.js 24.15+ (or 22.22.3+) and Rust. Run
`npm run desktop:install-macos-runtime` to open Apple's Command Line Tools
installer when required and verify the complete toolchain.

From the repository root:

```powershell
npm run desktop:dev
```

On macOS, use the same `npm run desktop:check`, `npm run desktop:dev` and
`npm run desktop:build` commands from a normal Terminal. The app uses the
native Node executable and native SQLite binding produced on that Mac.

The development command keeps the existing Vue dev server available on port 5173,
while the Nest sidecar serves the production page and API on the hook-compatible
loopback port `8787`. It also prepares the same bundled OpenClaw resources used
by release builds, so a clean checkout does not silently start without the QQ/
Weixin gateway. If a healthy AI Monitor is already running there, the app
reuses it instead of starting a duplicate service.

## Packaging

```powershell
npm run desktop:build
```

Windows and macOS packages must be built on their target operating system. The
resource step embeds the host Node executable and installs native
`better-sqlite3` for the host OS/architecture, so a Windows build cannot produce
a runnable macOS package. On macOS, run the same commands after installing
Xcode Command Line Tools. Build Intel and Apple Silicon artifacts separately
unless a universal build pipeline is configured.

The `desktop-build` GitHub Actions workflow builds Windows x64, macOS Intel and
macOS Apple Silicon packages. Manual runs retain the bundles as workflow
artifacts; a `v*` tag also publishes MSI/EXE/DMG files to the matching GitHub
Release. Signing and notarization are intentionally separate release secrets
and are not configured in this repository.

The build prepares `src-tauri/resources/` with the Vue/Nest output, runtime
scripts, a platform Node executable, and production server dependencies. This
directory is generated and ignored by Git. `better-sqlite3` is installed for the
target Node ABI during the resource preparation step.

The desktop process stores SQLite, bindings, settings, notification outbox and
OpenClaw login state under the platform user-data directory. AI client session
directories remain in their normal user locations. The default bundle includes
OpenClaw `2026.7.1-2`, Tencent QQ plugin `2.0.1` and Weixin plugin `2.4.6`.
The first launch prepares those plugins in the writable user-data directory and
starts the local Gateway on `127.0.0.1:18789`; an already healthy Gateway is
reused. QQ/Weixin credentials still require the user to scan the QR code.
Set `AIMONITOR_OPENCLAW_CLI_PATH` to use an external CLI, or
`AIMONITOR_DESKTOP_SKIP_OPENCLAW_INSTALL=1` for a monitor-only build.
For installer-only debugging after one successful resource preparation, set
`AIMONITOR_DESKTOP_REUSE_RESOURCES=1`; normal release builds should leave it
unset so all embedded dependencies are rebuilt and verified.
