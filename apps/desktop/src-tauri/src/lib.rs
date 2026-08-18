#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::error::Error;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread::sleep;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, RunEvent, Url, WebviewWindow, WindowEvent};

type AppResult<T> = Result<T, Box<dyn Error>>;

struct RuntimeState {
    server: Mutex<Option<Child>>,
    gateway: Mutex<Option<Child>>,
}

struct ServerLaunch {
    child: Option<Child>,
    port: u16,
}

struct GatewayLaunch {
    child: Option<Child>,
    state_root: Option<PathBuf>,
}

fn load_or_create_reply_token(data_root: &Path) -> AppResult<String> {
    if let Some(token) = std::env::var("AIMONITOR_REPLY_TOKEN")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
    {
        return Ok(token);
    }
    let token_path = data_root.join("reply-token");
    if let Ok(value) = fs::read_to_string(&token_path) {
        let token = value.trim();
        if token.len() >= 32 {
            return Ok(token.to_owned());
        }
    }
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)?;
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        token.push(HEX[(byte >> 4) as usize] as char);
        token.push(HEX[(byte & 0x0f) as usize] as char);
    }
    fs::create_dir_all(data_root)?;
    fs::write(&token_path, format!("{token}\n"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&token_path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(token)
}

const MAIN_WINDOW_LABEL: &str = "main";
const SHOW_MAIN_MENU_ID: &str = "show-main";
const QUIT_MENU_ID: &str = "quit";

#[derive(Debug, PartialEq, Eq)]
enum TrayMenuAction {
    ShowMain,
    Quit,
    Ignore,
}

fn tray_menu_action(id: &str) -> TrayMenuAction {
    match id {
        SHOW_MAIN_MENU_ID => TrayMenuAction::ShowMain,
        QUIT_MENU_ID => TrayMenuAction::Quit,
        _ => TrayMenuAction::Ignore,
    }
}

fn restore_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return;
    };
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

fn create_tray(app: &tauri::AppHandle) -> AppResult<()> {
    let show_main = MenuItemBuilder::with_id(SHOW_MAIN_MENU_ID, "显示 AI Monitor").build(app)?;
    let quit = MenuItemBuilder::with_id(QUIT_MENU_ID, "退出 AI Monitor").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&show_main)
        .separator()
        .item(&quit)
        .build()?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .tooltip("AI Monitor")
        .icon_as_template(cfg!(target_os = "macos"))
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match tray_menu_action(event.id().as_ref()) {
            TrayMenuAction::ShowMain => restore_main_window(app),
            TrayMenuAction::Quit => app.exit(0),
            TrayMenuAction::Ignore => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            }
            | TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => restore_main_window(tray.app_handle()),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .to_path_buf()
}

fn writable_data_root(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    if cfg!(debug_assertions) {
        if let Some(configured) = std::env::var_os("AIMONITOR_DATA_ROOT") {
            let path = PathBuf::from(configured);
            fs::create_dir_all(&path)?;
            return Ok(path);
        }
        return Ok(repo_root().join("data"));
    }
    let path = app.path().app_data_dir()?;
    fs::create_dir_all(&path)?;
    Ok(path)
}

fn resource_root(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    if cfg!(debug_assertions) {
        return Ok(repo_root());
    }
    Ok(app.path().resource_dir()?)
}

fn node_command(resource_root: &Path) -> (String, PathBuf) {
    if cfg!(debug_assertions) {
        let configured = std::env::var_os("AIMONITOR_NODE_PATH").map(PathBuf::from);
        return (
            configured
                .as_deref()
                .and_then(Path::to_str)
                .unwrap_or("node")
                .to_owned(),
            resource_root.join("apps/server/dist/main.js"),
        );
    }

    let executable = if cfg!(target_os = "windows") {
        resource_root.join("runtime/node.exe")
    } else {
        resource_root.join("runtime/node")
    };
    (
        executable.to_string_lossy().into_owned(),
        resource_root.join("apps/server/dist/main.js"),
    )
}

fn monitor_port() -> u16 {
    std::env::var("AIMONITOR_DESKTOP_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(8787)
}

fn gateway_port() -> u16 {
    std::env::var("AIMONITOR_OPENCLAW_GATEWAY_PORT")
        .or_else(|_| std::env::var("OPENCLAW_GATEWAY_PORT"))
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port > 0)
        .unwrap_or(18789)
}

fn openclaw_cli_module(resource_root: &Path) -> Option<PathBuf> {
    let configured = std::env::var_os("AIMONITOR_OPENCLAW_CLI_PATH").map(PathBuf::from);
    let candidates = [
        configured,
        Some(resource_root.join("node_modules/openclaw/openclaw.mjs")),
        Some(resource_root.join("runtime/node_modules/openclaw/openclaw.mjs")),
        Some(
            repo_root().join("apps/desktop/src-tauri/resources/node_modules/openclaw/openclaw.mjs"),
        ),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|candidate| candidate.exists())
}

fn gateway_reachable(port: u16) -> bool {
    TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(250),
    )
    .is_ok()
}

fn gateway_healthy(
    node: &str,
    cli_module: &Path,
    resources: &Path,
    data_root: &Path,
    state_root: &Path,
    port: u16,
    gateway_token: Option<&str>,
) -> bool {
    let gateway_url = format!("ws://127.0.0.1:{port}");
    let mut command = Command::new(node);
    command
        .arg(cli_module)
        .args([
            "gateway",
            "status",
            "--json",
            "--require-rpc",
            "--timeout",
            "2000",
            "--url",
        ])
        .arg(&gateway_url)
        .current_dir(resources)
        .env("AIMONITOR_RESOURCE_ROOT", resources)
        .env("AIMONITOR_PROJECT_ROOT", resources)
        .env("AIMONITOR_DATA_ROOT", data_root)
        .env("AIMONITOR_OPENCLAW_CLI_PATH", cli_module)
        .env("OPENCLAW_STATE_DIR", state_root)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(token) = gateway_token {
        command.args(["--token", token]);
    }
    command.status().is_ok_and(|status| status.success())
}

fn run_openclaw_bootstrap(resources: &Path, data_root: &Path) -> AppResult<()> {
    let Some(cli_module) = openclaw_cli_module(resources) else {
        return Ok(());
    };
    let (node, _) = node_command(resources);
    let state_root = std::env::var_os("AIMONITOR_OPENCLAW_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| data_root.join("openclaw-state"));
    fs::create_dir_all(&state_root)?;
    let script = resources.join("scripts/desktop-openclaw-bootstrap.mjs");
    if !script.exists() {
        return Err(format!("桌面版 OpenClaw 初始化脚本不存在: {}", script.display()).into());
    }
    let status = Command::new(node)
        .arg(script)
        .current_dir(resources)
        .env("AIMONITOR_RESOURCE_ROOT", resources)
        .env("AIMONITOR_PROJECT_ROOT", resources)
        .env("AIMONITOR_DATA_ROOT", data_root)
        .env("OPENCLAW_STATE_DIR", &state_root)
        .env("AIMONITOR_OPENCLAW_CLI_PATH", cli_module)
        .stdout(if cfg!(debug_assertions) {
            Stdio::inherit()
        } else {
            Stdio::null()
        })
        .stderr(if cfg!(debug_assertions) {
            Stdio::inherit()
        } else {
            Stdio::null()
        })
        .status()?;
    if !status.success() {
        return Err("OpenClaw 插件初始化失败，请检查网络后重启 AI Monitor".into());
    }
    Ok(())
}

fn launch_gateway(resources: &Path, data_root: &Path, reply_token: &str) -> AppResult<GatewayLaunch> {
    let port = gateway_port();
    let Some(cli_module) = openclaw_cli_module(resources) else {
        if cfg!(debug_assertions) {
            return Ok(GatewayLaunch {
                child: None,
                state_root: None,
            });
        }
        return Err("桌面包缺少 OpenClaw CLI，无法启动 QQ/微信 Gateway".into());
    };
    let (node, _) = node_command(resources);
    let state_root = std::env::var_os("AIMONITOR_OPENCLAW_STATE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| data_root.join("openclaw-state"));
    fs::create_dir_all(&state_root)?;
    let gateway_token = std::env::var("OPENCLAW_GATEWAY_TOKEN")
        .ok()
        .filter(|value| !value.is_empty());
    if gateway_reachable(port) {
        if gateway_healthy(
            &node,
            &cli_module,
            resources,
            data_root,
            &state_root,
            port,
            gateway_token.as_deref(),
        ) {
            return Ok(GatewayLaunch {
                child: None,
                state_root: Some(state_root),
            });
        }
        return Err(format!(
            "端口 {port} 已被占用，但未通过 OpenClaw Gateway RPC 健康检查。请停止占用程序，或提供正确的 OPENCLAW_GATEWAY_TOKEN 后重试。"
        )
        .into());
    }
    run_openclaw_bootstrap(resources, data_root)?;
    let mut gateway_args = vec![
        "gateway".to_owned(),
        "run".to_owned(),
        "--allow-unconfigured".to_owned(),
        "--bind".to_owned(),
        "loopback".to_owned(),
    ];
    if let Some(token) = gateway_token {
        gateway_args.extend([
            "--auth".to_owned(),
            "token".to_owned(),
            "--token".to_owned(),
            token,
        ]);
    } else {
        gateway_args.extend(["--auth".to_owned(), "none".to_owned()]);
    }
    let mut command = Command::new(node);
    command
        .arg(&cli_module)
        .args(gateway_args)
        .current_dir(resources)
        .env("AIMONITOR_RESOURCE_ROOT", resources)
        .env("AIMONITOR_PROJECT_ROOT", resources)
        .env("AIMONITOR_DATA_ROOT", data_root)
        .env("AIMONITOR_OPENCLAW_CLI_PATH", &cli_module)
        .env("OPENCLAW_STATE_DIR", &state_root)
        .env("OPENCLAW_GATEWAY_PORT", port.to_string())
        .env("OPENCLAW_GATEWAY_URL", format!("ws://127.0.0.1:{port}"))
        .env("AIMONITOR_REPLY_TOKEN", reply_token)
        .env(
            "AIMONITOR_REPLY_URL",
            format!("http://127.0.0.1:{}/api/replies/inbound", monitor_port()),
        )
        .stdout(if cfg!(debug_assertions) {
            Stdio::inherit()
        } else {
            Stdio::null()
        })
        .stderr(if cfg!(debug_assertions) {
            Stdio::inherit()
        } else {
            Stdio::null()
        });
    let child = command.spawn()?;
    Ok(GatewayLaunch {
        child: Some(child),
        state_root: Some(state_root),
    })
}

fn launch_server(
    app: &tauri::AppHandle,
    gateway_state_root: Option<&Path>,
    reply_token: &str,
) -> AppResult<ServerLaunch> {
    let resources = resource_root(app)?;
    let data_root = writable_data_root(app)?;
    let (node, entry) = node_command(&resources);
    let port = monitor_port();
    if health_check(port) {
        return Ok(ServerLaunch { child: None, port });
    }
    if TcpListener::bind(("127.0.0.1", port)).is_err() {
        return Err(format!(
            "端口 {port} 已被其它程序占用。AI 客户端 hooks 默认连接该端口，请先停止占用程序后再启动 AI Monitor。"
        )
        .into());
    }
    if !cfg!(debug_assertions) && !entry.exists() {
        return Err(format!("桌面版服务文件不存在: {}", entry.display()).into());
    }
    let mut command = Command::new(node);
    command
        .arg(entry)
        .current_dir(&resources)
        .env("AIMONITOR_HOST", "127.0.0.1")
        .env("AIMONITOR_PORT", port.to_string())
        .env("AIMONITOR_RESOURCE_ROOT", &resources)
        .env("AIMONITOR_PROJECT_ROOT", &resources)
        .env("AIMONITOR_DATA_ROOT", &data_root)
        .env("AIMONITOR_REPLY_TOKEN", reply_token)
        .env("AIMONITOR_WEB_DIST_PATH", resources.join("apps/web/dist"))
        .env(
            "OPENCLAW_GATEWAY_URL",
            format!("ws://127.0.0.1:{}", gateway_port()),
        )
        .stdin(Stdio::null())
        .stdout(if cfg!(debug_assertions) {
            Stdio::inherit()
        } else {
            Stdio::null()
        })
        .stderr(if cfg!(debug_assertions) {
            Stdio::inherit()
        } else {
            Stdio::null()
        });
    if let Some(state_root) = gateway_state_root {
        command.env("OPENCLAW_STATE_DIR", state_root);
    }
    let child = command.spawn()?;
    Ok(ServerLaunch {
        child: Some(child),
        port,
    })
}

fn health_check(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(250),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let request =
        format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }
    let Some((headers, body)) = response.split_once("\r\n\r\n") else {
        return false;
    };
    if !(headers.starts_with("HTTP/1.1 200") || headers.starts_with("HTTP/1.0 200")) {
        return false;
    }
    let Ok(payload) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    payload.get("ok") == Some(&serde_json::Value::Bool(true)) && payload.get("stats").is_some()
}

fn wait_for_health(port: u16, timeout: Duration) -> AppResult<()> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if health_check(port) {
            return Ok(());
        }
        sleep(Duration::from_millis(150));
    }
    Err(format!("AI Monitor 服务启动超时，端口 {port} 未通过健康检查").into())
}

fn navigate_to_server(window: &WebviewWindow, port: u16) -> AppResult<()> {
    let url = Url::parse(&format!("http://127.0.0.1:{port}/"))?;
    window.navigate(url)?;
    Ok(())
}

fn stop_child(child: &mut Child) {
    #[cfg(target_os = "windows")]
    {
        let pid = child.id();
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = child.kill();
    }
    let _ = child.wait();
}

fn append_startup_log(app: &tauri::AppHandle, message: &str) {
    let Ok(data_root) = app.path().app_data_dir() else {
        return;
    };
    if fs::create_dir_all(&data_root).is_err() {
        return;
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default();
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_root.join("desktop-startup.log"))
    {
        let _ = writeln!(file, "{timestamp} {message}");
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            restore_main_window(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(RuntimeState {
            server: Mutex::new(None),
            gateway: Mutex::new(None),
        })
        .on_window_event(|window, event| {
            if window.label() != MAIN_WINDOW_LABEL {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let result: AppResult<()> = (|| {
                append_startup_log(app.handle(), "startup begin");
                create_tray(app.handle())?;
                let resources = resource_root(app.handle())?;
                let data_root = writable_data_root(app.handle())?;
                let reply_token = load_or_create_reply_token(&data_root)?;
                append_startup_log(
                    app.handle(),
                    &format!(
                        "resources={} data={} monitor_port={} gateway_port={}",
                        resources.display(),
                        data_root.display(),
                        monitor_port(),
                        gateway_port()
                    ),
                );
                let existing_monitor = health_check(monitor_port());
                let mut gateway = if existing_monitor {
                    GatewayLaunch {
                        child: None,
                        state_root: None,
                    }
                } else {
                    launch_gateway(&resources, &data_root, &reply_token)?
                };
                let mut launch = match launch_server(app.handle(), gateway.state_root.as_deref(), &reply_token) {
                    Ok(value) => value,
                    Err(error) => {
                        if let Some(child) = gateway.child.as_mut() {
                            stop_child(child);
                        }
                        return Err(error);
                    }
                };
                if let Err(error) = wait_for_health(launch.port, Duration::from_secs(20)) {
                    if let Some(child) = launch.child.as_mut() {
                        stop_child(child);
                    }
                    if let Some(child) = gateway.child.as_mut() {
                        stop_child(child);
                    }
                    return Err(error);
                }
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(error) = navigate_to_server(&window, launch.port) {
                        if let Some(child) = launch.child.as_mut() {
                            stop_child(child);
                        }
                        if let Some(child) = gateway.child.as_mut() {
                            stop_child(child);
                        }
                        return Err(error);
                    }
                }
                let runtime_state = app.state::<RuntimeState>();
                {
                    let mut server = runtime_state
                        .server
                        .lock()
                        .map_err(|_| std::io::Error::other("桌面运行状态锁已损坏"))?;
                    *server = launch.child;
                }
                let mut gateway_state = runtime_state
                    .gateway
                    .lock()
                    .map_err(|_| std::io::Error::other("桌面 Gateway 状态锁已损坏"))?;
                *gateway_state = gateway.child;
                append_startup_log(app.handle(), "startup ready");
                Ok(())
            })();
            if let Err(error) = &result {
                append_startup_log(app.handle(), &format!("startup failed: {error}"));
            }
            result
        })
        .build(tauri::generate_context!())
        .expect("error while building AI Monitor desktop application")
        .run(|app, event| {
            if matches!(event, RunEvent::Exit) {
                if let Ok(mut state) = app.state::<RuntimeState>().server.lock() {
                    if let Some(mut child) = state.take() {
                        stop_child(&mut child);
                    }
                }
                if let Ok(mut state) = app.state::<RuntimeState>().gateway.lock() {
                    if let Some(mut child) = state.take() {
                        stop_child(&mut child);
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{tray_menu_action, TrayMenuAction, QUIT_MENU_ID, SHOW_MAIN_MENU_ID};

    #[test]
    fn tray_menu_ids_map_to_explicit_actions() {
        assert_eq!(
            tray_menu_action(SHOW_MAIN_MENU_ID),
            TrayMenuAction::ShowMain
        );
        assert_eq!(tray_menu_action(QUIT_MENU_ID), TrayMenuAction::Quit);
        assert_eq!(tray_menu_action("unknown"), TrayMenuAction::Ignore);
    }
}
