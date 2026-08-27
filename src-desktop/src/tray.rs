//! Native desktop tray for the selected Station sidecar or attached service.

use crate::service_state::{
    discover_manifest_for_runtime, probe_service, resolve_station_home_for_channel, service_action,
    service_command_is_trusted, ResolvedLocalService, ServiceAction, ServiceHealth,
    ServiceManifest,
};
use crate::{BundledServerStatus, DesktopOwnerSnapshot, ServerOwnership};
use serde::Deserialize;
use std::fmt::Display;
use std::io::Read;
use std::net::IpAddr;
use std::process::Command;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::thread;
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_opener::OpenerExt;

const STATION_TRAY_ICON: &[u8] = include_bytes!("../icons/icon.png");
const BETA_TRAY_ICON: &[u8] = include_bytes!("../icons/beta/icon.png");
const NIGHTLY_TRAY_ICON: &[u8] = include_bytes!("../icons/nightly/icon.png");
const DEV_TRAY_ICON: &[u8] = include_bytes!("../icons/dev/icon.png");
const CORE_UPDATE_SETTINGS_PATH: &str = "/settings?view=system&highlight=core-app-updates";
const TRAY_NAVIGATION_EVENT: &str = "station://tray-navigation";

#[derive(Clone)]
struct TrayState {
    identity_text: String,
    icon_bytes: &'static [u8],
    backend: MenuItem<Wry>,
    connections: MenuItem<Wry>,
    connected_clients: MenuItem<Wry>,
    updates: MenuItem<Wry>,
    open: MenuItem<Wry>,
    service_action: MenuItem<Wry>,
    status: MenuItem<Wry>,
    tray: TrayIcon<Wry>,
}

/// Supervisor transitions wake this receiver; they never write a webview
/// event themselves. This keeps the tray poll as the sole event writer.
#[derive(Clone)]
pub(crate) struct TrayKick(pub Sender<()>);

pub(crate) fn kick(app: &AppHandle) {
    if let Some(kick) = app.try_state::<TrayKick>() {
        let _ = kick.0.send(());
    }
}

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let product_name = tray_product_name(app);
    let identity_text = tray_identity(app, &product_name);
    let icon_bytes = tray_icon_bytes(packaged_channel(app));
    let identity = MenuItem::with_id(
        app,
        "tray-identity",
        identity_text.clone(),
        false,
        None::<&str>,
    )?;
    let backend = MenuItem::with_id(
        app,
        "tray-backend",
        "Backend: unavailable",
        false,
        None::<&str>,
    )?;
    let status = MenuItem::with_id(
        app,
        "tray-status",
        "Station: checking…",
        false,
        None::<&str>,
    )?;
    let open = MenuItem::with_id(
        app,
        "tray-open",
        open_label(&product_name),
        false,
        None::<&str>,
    )?;
    let connections = MenuItem::with_id(
        app,
        "tray-connections",
        "Configure backends…",
        false,
        None::<&str>,
    )?;
    let connected_clients = MenuItem::with_id(
        app,
        "tray-connected-clients",
        "Connected clients: unavailable",
        false,
        None::<&str>,
    )?;
    let updates = MenuItem::with_id(
        app,
        "tray-updates",
        "Check for updates…",
        false,
        None::<&str>,
    )?;
    let service_action = MenuItem::with_id(
        app,
        "tray-service-action",
        "Service unavailable",
        false,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(
        app,
        "tray-quit",
        quit_label(&product_name),
        true,
        None::<&str>,
    )?;
    let menu = MenuBuilder::new(app)
        .item(&identity)
        .item(&backend)
        .item(&status)
        .separator()
        .item(&open)
        .item(&connections)
        .item(&connected_clients)
        .item(&updates)
        // A paired-devices tray command needs a native-to-webview route with a
        // fixed `initialPanel=devices`. The existing station:// association is
        // intentionally limited to reviewed pairing payloads, so do not turn
        // its caller-controlled path/query into a general UI router here.
        .item(&service_action)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&quit)
        .build()?;
    let icon = tray_icon(icon_bytes)?;
    let tray = TrayIconBuilder::with_id("station-service-tray")
        .menu(&menu)
        .icon(icon)
        .tooltip("Station service: checking…")
        .icon_as_template(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-open" => open_station_ui(app),
            "tray-connections" => open_station_connections(app),
            "tray-connected-clients" => open_paired_devices(app),
            "tray-updates" => open_core_update_settings(app),
            "tray-service-action" => run_contextual_service_action(app),
            "tray-quit" => {
                // The durable per-user service intentionally outlives Desktop.
                // A desktop-owned sidecar does not: its teardown is idempotent
                // and deliberately has no service-control path.
                crate::teardown_sidecar(app);
                app.exit(0)
            }
            _ => {}
        })
        .build(app)?;
    tray.set_icon_as_template(false)?;
    app.manage(TrayState {
        identity_text,
        icon_bytes,
        backend,
        connections,
        connected_clients,
        updates,
        open,
        service_action,
        status,
        tray,
    });
    let (kick, receiver) = channel();
    app.manage(TrayKick(kick));
    spawn_poll_thread(app.clone(), receiver);
    log::info!("Station tray initialized");
    Ok(())
}

fn spawn_poll_thread(app: AppHandle, kicks: Receiver<()>) {
    thread::Builder::new()
        .name("station-service-tray-poll".into())
        .spawn(move || {
            // Keep the Rust tray and the Desktop webview on the same polling
            // path. In particular, an external service crash or recovery must
            // emit the status event even though no tray action was clicked.
            let mut update = || update_once(&app);
            while poll_step(&kicks, &mut update) {}
        })
        .expect("failed to start Station tray poll thread");
}

/// Run one tray/webview convergence update and wait for either its normal
/// cadence or a supervisor kick. A disconnected kick channel is application
/// teardown, not a reason to spin indefinitely.
fn poll_step<F>(kicks: &Receiver<()>, update: &mut F) -> bool
where
    F: FnMut() -> ServiceHealth,
{
    let health = update();
    !matches!(
        kicks.recv_timeout(health.poll_interval()),
        Err(RecvTimeoutError::Disconnected)
    )
}

fn packaged_channel(app: &AppHandle) -> Option<&'static str> {
    if cfg!(debug_assertions) {
        None
    } else {
        crate::channel_ports_generated::desktop_channel_from_identifier(&app.config().identifier)
    }
}

fn station_home(app: &AppHandle) -> std::path::PathBuf {
    resolve_station_home_for_channel(packaged_channel(app).map(std::ffi::OsStr::new))
}

fn apply_health(state: &TrayState, snapshot: TrayBackendSnapshot, connected_clients: String) {
    let label = snapshot.health.label();
    let _ = state.status.set_text(format!("Station service: {label}"));
    let _ = state.backend.set_text(&snapshot.label);
    let _ = state.open.set_enabled(snapshot.can_open());
    let _ = state.connections.set_enabled(snapshot.can_navigate());
    let _ = state.connected_clients.set_text(connected_clients);
    let _ = state.connected_clients.set_enabled(snapshot.can_navigate());
    let _ = state.updates.set_enabled(snapshot.can_navigate());
    let _ = state.service_action.set_text(snapshot.action.label);
    let _ = state.service_action.set_enabled(snapshot.action.enabled);
    let _ = state.tray.set_tooltip(Some(tray_tooltip(
        &state.identity_text,
        &snapshot.label,
        snapshot.health,
    )));
    if let Ok(icon) = tray_icon(state.icon_bytes) {
        let _ = state.tray.set_icon(Some(icon));
        let _ = state.tray.set_icon_as_template(false);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ContextualServiceAction {
    label: &'static str,
    action: Option<ServiceAction>,
    enabled: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrayBackendKind {
    Service,
    Sidecar,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct TrayBackendSnapshot {
    kind: TrayBackendKind,
    health: ServiceHealth,
    label: String,
    action: ContextualServiceAction,
}

impl TrayBackendSnapshot {
    fn can_open(&self) -> bool {
        self.kind != TrayBackendKind::Unavailable
    }

    fn can_navigate(&self) -> bool {
        self.kind != TrayBackendKind::Unavailable
    }
}

struct TrayContext {
    snapshot: TrayBackendSnapshot,
    service: Option<ResolvedLocalService>,
    api_origin: Option<String>,
}

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
enum TrayNavigationDestination {
    Connections,
    PairedDevices,
    CoreUpdates,
}

fn trusted_service_manifest<'a>(
    status: &BundledServerStatus,
    owner: &DesktopOwnerSnapshot,
    manifest: Option<&'a ServiceManifest>,
) -> Option<&'a ServiceManifest> {
    let manifest = manifest?;
    display_port(manifest.server_port)?;
    display_port(manifest.ui_port)?;
    match owner {
        DesktopOwnerSnapshot::Service {
            instance_id,
            api_port,
        } if status.ownership == ServerOwnership::Service
            && manifest.instance_id == *instance_id
            && manifest.server_port == *api_port =>
        {
            Some(manifest)
        }
        DesktopOwnerSnapshot::Unowned
            if status.ownership == ServerOwnership::None && !status.fail_closed =>
        {
            Some(manifest)
        }
        DesktopOwnerSnapshot::Sidecar
        | DesktopOwnerSnapshot::Service { .. }
        | DesktopOwnerSnapshot::Unowned
        | DesktopOwnerSnapshot::Unavailable => None,
    }
}

fn sidecar_is_current(status: &BundledServerStatus, owner: &DesktopOwnerSnapshot) -> bool {
    status.ownership == ServerOwnership::Sidecar && matches!(owner, DesktopOwnerSnapshot::Sidecar)
}

fn status_health(status: &BundledServerStatus) -> ServiceHealth {
    match status.phase {
        crate::bundled_server_state::ServerPhase::Running => ServiceHealth::Running,
        crate::bundled_server_state::ServerPhase::Failed => ServiceHealth::Unhealthy,
        _ => ServiceHealth::Stopped,
    }
}

fn tray_backend_snapshot(
    status: &BundledServerStatus,
    owner: &DesktopOwnerSnapshot,
    manifest: Option<&ServiceManifest>,
    endpoint_health: Option<ServiceHealth>,
) -> TrayBackendSnapshot {
    let trusted_manifest = trusted_service_manifest(status, owner, manifest);
    if let Some(manifest) = trusted_manifest {
        let health = endpoint_health.unwrap_or(ServiceHealth::NotInstalled);
        let action = match owner {
            DesktopOwnerSnapshot::Service { .. } => Some(ServiceAction::Stop),
            DesktopOwnerSnapshot::Unowned if health == ServiceHealth::Stopped => {
                Some(ServiceAction::Start)
            }
            DesktopOwnerSnapshot::Sidecar | DesktopOwnerSnapshot::Unavailable => None,
            DesktopOwnerSnapshot::Unowned => None,
        };
        let action = contextual_service_action(health, action);
        return TrayBackendSnapshot {
            kind: TrayBackendKind::Service,
            health,
            label: format!(
                "Backend: local service {} · API {} · UI {}",
                safe_instance(&manifest.instance_id),
                manifest.server_port,
                manifest.ui_port
            ),
            action,
        };
    }

    if sidecar_is_current(status, owner) {
        let health = status_health(status);
        let label = match status.port.and_then(display_port) {
            Some(api_port) => format!("Backend: Built-in · API {api_port}"),
            None => "Backend: Built-in · API unavailable".into(),
        };
        return TrayBackendSnapshot {
            kind: TrayBackendKind::Sidecar,
            health,
            label,
            action: ContextualServiceAction {
                label: "Built-in service",
                action: None,
                enabled: false,
            },
        };
    }

    let health = if status.fail_closed {
        ServiceHealth::Unhealthy
    } else {
        ServiceHealth::NotInstalled
    };
    TrayBackendSnapshot {
        kind: TrayBackendKind::Unavailable,
        health,
        label: "Backend: unavailable".into(),
        action: contextual_service_action(health, None),
    }
}

fn contextual_service_action(
    health: ServiceHealth,
    action: Option<ServiceAction>,
) -> ContextualServiceAction {
    let label = match (health, action) {
        (_, Some(ServiceAction::Start)) => "Start service",
        (_, Some(ServiceAction::Stop)) => "Stop service",
        (_, None) if health == ServiceHealth::Unhealthy => "Service unhealthy",
        (_, None) => "Service unavailable",
    };
    ContextualServiceAction {
        label,
        action,
        enabled: service_actions_supported() && action.is_some(),
    }
}

fn tray_product_name(app: &AppHandle) -> String {
    let package = app.package_info();
    product_name_label(&package.name).into()
}

fn tray_identity(app: &AppHandle, product_name: &str) -> String {
    identity_label(product_name, &app.package_info().version.to_string())
}

fn identity_label(product_name: &str, version: &str) -> String {
    format!("{} v{version}", product_name_label(product_name))
}

fn product_name_label(product_name: &str) -> &str {
    let product_name = product_name.trim();
    if product_name.is_empty() {
        "Station"
    } else {
        product_name
    }
}

fn open_label(product_name: &str) -> String {
    format!("Open {}", product_name_label(product_name))
}

fn quit_label(product_name: &str) -> String {
    format!("Quit {}", product_name_label(product_name))
}

fn safe_instance(value: &str) -> &str {
    if !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        value
    } else {
        "custom"
    }
}

fn display_port(port: u16) -> Option<u16> {
    (port != 0).then_some(port)
}

fn tray_tooltip(identity: &str, backend: &str, health: ServiceHealth) -> String {
    format!("{identity}\n{backend}\nHealth: {}", health.label())
}

fn tray_context(app: &AppHandle) -> TrayContext {
    let status = crate::unified_server_status(app);
    let owner = crate::desktop_owner_snapshot(app);
    let service = discover_manifest_for_runtime(
        &crate::service_state::resolve_station_root(),
        &station_home(app),
    );
    let trusted_manifest = trusted_service_manifest(
        &status,
        &owner,
        service.as_ref().map(|service| &service.manifest),
    );
    let has_trusted_manifest = trusted_manifest.is_some();
    let endpoint_health = trusted_manifest.map(|manifest| probe_service(Some(manifest)));
    let snapshot = tray_backend_snapshot(&status, &owner, trusted_manifest, endpoint_health);
    let api_origin = match snapshot.kind {
        TrayBackendKind::Service => {
            trusted_manifest.and_then(|manifest| station_api_origin(manifest).ok())
        }
        TrayBackendKind::Sidecar => status
            .api_base
            .as_deref()
            .and_then(|base| crate::exact_origin(base).ok()),
        TrayBackendKind::Unavailable => None,
    };
    TrayContext {
        snapshot,
        service: has_trusted_manifest
            .then_some(service.expect("trusted manifest came from service")),
        api_origin,
    }
}

fn open_station_connections(app: &AppHandle) {
    open_station_destination(
        app,
        TrayNavigationDestination::Connections,
        station_connections_url,
    );
}

fn open_paired_devices(app: &AppHandle) {
    open_station_destination(
        app,
        TrayNavigationDestination::PairedDevices,
        station_paired_devices_url,
    );
}

fn open_core_update_settings(app: &AppHandle) {
    // Settings' CoreUpdateCheck is the sole update authority: it owns the
    // check/recheck/apply/restart lifecycle. The tray only opens its fixed UI.
    open_station_destination(
        app,
        TrayNavigationDestination::CoreUpdates,
        station_core_update_url,
    );
}

fn open_station_destination(
    app: &AppHandle,
    destination_kind: TrayNavigationDestination,
    destination: fn(&ServiceManifest) -> Result<String, String>,
) {
    let context = tray_context(app);
    match context.snapshot.kind {
        TrayBackendKind::Service => {
            if let Some(service) = context.service {
                if let Ok(url) = destination(&service.manifest) {
                    let _ = app.opener().open_url(url, None::<&str>);
                }
            }
        }
        TrayBackendKind::Sidecar => {
            if let Some(label) = focus_station_window(app) {
                let _ = app.emit_to(label, TRAY_NAVIGATION_EVENT, destination_kind);
            }
        }
        TrayBackendKind::Unavailable => {}
    }
}

fn focus_station_window(app: &AppHandle) -> Option<String> {
    let label = app.get_webview_window("main")?.label().to_string();
    crate::request_main_window_activation(app);
    Some(label)
}

fn tray_icon_bytes(channel: Option<&str>) -> &'static [u8] {
    match channel {
        Some("stable") => STATION_TRAY_ICON,
        Some("beta") => BETA_TRAY_ICON,
        Some("nightly") => NIGHTLY_TRAY_ICON,
        // An unpackaged debug build is Dev; production config only maps the
        // reviewed stable, beta, and nightly identifiers above.
        Some(_) | None => DEV_TRAY_ICON,
    }
}

fn tray_icon(icon_bytes: &'static [u8]) -> tauri::Result<Image<'static>> {
    Image::from_bytes(icon_bytes).map(Image::to_owned)
}

fn open_station_ui(app: &AppHandle) {
    let context = tray_context(app);
    match context.snapshot.kind {
        TrayBackendKind::Service => {
            if let Some(service) = context.service {
                if let Err(error) = open_manifest_ui(&service.manifest, |url| {
                    app.opener().open_url(url.to_owned(), None::<&str>)
                }) {
                    log::error!("Station tray could not open the UI: {error}");
                }
            }
        }
        TrayBackendKind::Sidecar => {
            let _ = focus_station_window(app);
        }
        TrayBackendKind::Unavailable => {}
    }
}

fn open_manifest_ui<E>(
    manifest: &ServiceManifest,
    opener: impl FnOnce(&str) -> Result<(), E>,
) -> Result<(), String>
where
    E: Display,
{
    let url = station_ui_url(manifest)?;
    opener(&url).map_err(|error| format!("native opener rejected {url}: {error}"))
}

fn station_ui_url(manifest: &ServiceManifest) -> Result<String, String> {
    let raw_host = manifest.host.as_str();
    if raw_host.is_empty() || raw_host.trim() != raw_host {
        return Err("service host must be a non-empty canonical host".into());
    }

    let host = match raw_host {
        // A wildcard listener is reachable from this device through loopback.
        "0.0.0.0" | "::" => "127.0.0.1".to_string(),
        "localhost" => raw_host.to_string(),
        bracketed if bracketed.starts_with('[') && bracketed.ends_with(']') => {
            let unbracketed = &bracketed[1..bracketed.len() - 1];
            match unbracketed.parse::<IpAddr>() {
                Ok(IpAddr::V6(_)) => bracketed.to_string(),
                _ => return Err("service host is not a supported IP address or localhost".into()),
            }
        }
        address => match address.parse::<IpAddr>() {
            Ok(IpAddr::V4(_)) => address.to_string(),
            Ok(IpAddr::V6(_)) => format!("[{address}]"),
            Err(_) => {
                return Err("service host is not a supported IP address or localhost".into());
            }
        },
    };

    Ok(format!("http://{host}:{}", manifest.ui_port))
}

fn station_connections_url(manifest: &ServiceManifest) -> Result<String, String> {
    Ok(format!("{}/connections", station_ui_url(manifest)?))
}

fn station_paired_devices_url(manifest: &ServiceManifest) -> Result<String, String> {
    Ok(format!(
        "{}/?station-connect=devices",
        station_ui_url(manifest)?
    ))
}

fn station_api_origin(manifest: &ServiceManifest) -> Result<String, String> {
    let mut url = url::Url::parse(&station_ui_url(manifest)?)
        .map_err(|_| "invalid Station URL".to_string())?;
    url.set_port(Some(manifest.server_port))
        .map_err(|_| "invalid Station API port".to_string())?;
    Ok(url.origin().ascii_serialization())
}

const CONNECTED_CLIENTS_BODY_LIMIT: u64 = 64 * 1024;
const CONNECTED_CLIENTS_DEVICE_LIMIT: usize = 1_024;
const CONNECTED_CLIENTS_TOTAL_LIMIT: u64 = 256;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectedClientsResponse {
    connected_clients: u64,
    connected_devices: u64,
    observed_at: u64,
}

/// Reads only the bounded aggregate projection. The bearer remains native and
/// every unavailable authority/transport/shape path stays explicitly unknown.
fn connected_clients_label(app: &AppHandle, context: &TrayContext) -> String {
    let Some(origin) = context.api_origin.as_deref() else {
        return "Connected clients: unavailable".to_string();
    };
    let Ok(credential) = crate::native_credential_for_origin(app, &origin) else {
        return "Connected clients: unavailable".to_string();
    };
    let endpoint = format!("{origin}/api/client-presence/summary");
    let request = match ureq::http::Request::builder()
        .method("GET")
        .uri(endpoint)
        .header("Authorization", format!("Bearer {credential}"))
        .body(Vec::new())
    {
        Ok(request) => request,
        Err(_) => return "Connected clients: unavailable".to_string(),
    };
    let mut response = match crate::native_http_agent().run(request) {
        Ok(response) if response.status().as_u16() == 200 => response,
        _ => return "Connected clients: unavailable".to_string(),
    };
    let mut body = String::new();
    if response
        .body_mut()
        .as_reader()
        .take(CONNECTED_CLIENTS_BODY_LIMIT + 1)
        .read_to_string(&mut body)
        .is_err()
        || body.len() as u64 > CONNECTED_CLIENTS_BODY_LIMIT
    {
        return "Connected clients: unavailable".to_string();
    }
    connected_clients_label_from_body(&body)
        .unwrap_or_else(|| "Connected clients: unavailable".to_string())
}

fn connected_clients_label_from_body(body: &str) -> Option<String> {
    let parsed = serde_json::from_str::<ConnectedClientsResponse>(body).ok()?;
    if parsed.connected_devices as usize > CONNECTED_CLIENTS_DEVICE_LIMIT
        || parsed.connected_clients > CONNECTED_CLIENTS_TOTAL_LIMIT
        || parsed.observed_at == 0
    {
        return None;
    }
    Some(match parsed.connected_clients {
        0 => "No clients connected".to_string(),
        1 => "1 client connected".to_string(),
        count => format!("{count} clients connected"),
    })
}

fn station_core_update_url(manifest: &ServiceManifest) -> Result<String, String> {
    Ok(format!(
        "{}{}",
        station_ui_url(manifest)?,
        CORE_UPDATE_SETTINGS_PATH
    ))
}

fn service_actions_supported() -> bool {
    true
}

fn run_contextual_service_action(app: &AppHandle) {
    let context = tray_context(app);
    if let (Some(action), Some(service)) = (context.snapshot.action.action, context.service) {
        run_service_action(app, action, service);
    }
}

fn run_service_action(app: &AppHandle, action: ServiceAction, service: ResolvedLocalService) {
    let app = app.clone();
    thread::spawn(move || {
        let command = match service_action(&service.base_dir, &service.manifest, action) {
            Ok(command) => command,
            Err(error) => {
                log::error!(
                    "Station tray service {} action failed: {error}",
                    action.as_str()
                );
                let _ = update_once(&app);
                return;
            }
        };
        if !service_command_is_trusted(&command) {
            log::warn!(
                "Station tray service {} action refused because manifest paths changed or are no longer trusted",
                action.as_str()
            );
            let _ = update_once(&app);
            return;
        }
        let result = Command::new(command.program)
            .args(command.args)
            .env("PATH", command.path)
            .output();
        match result {
            Ok(output) if output.status.success() => {
                log::info!("Station tray service {} action succeeded", action.as_str());
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let tail = stderr.lines().rev().take(4).collect::<Vec<_>>();
                let tail = tail.into_iter().rev().collect::<Vec<_>>().join(" | ");
                log::error!(
                    "Station tray service {} action failed ({}): {}",
                    action.as_str(),
                    output.status,
                    tail
                );
            }
            Err(error) => {
                log::error!(
                    "Station tray service {} action failed: {error}",
                    action.as_str()
                );
            }
        }
        // Actions immediately refresh, then use three short convergence polls
        // before returning to the normal state-specific cadence.
        for attempt in 0..4 {
            let _ = update_once(&app);
            if attempt < 3 {
                thread::sleep(Duration::from_secs(2));
            }
        }
    });
}

fn update_once(app: &AppHandle) -> ServiceHealth {
    let state = app.state::<TrayState>().inner().clone();
    let context = tray_context(app);
    let health = context.snapshot.health;
    let connected_clients = connected_clients_label(app, &context);
    record_dispatch_result(
        app.run_on_main_thread(move || apply_health(&state, context.snapshot, connected_clients)),
    );
    crate::emit_service_status(app);
    health
}

/// A rejected main-thread dispatch is transient host state. The poller retains
/// ownership of retries so tray and webview reconverge from one fresh snapshot.
fn record_dispatch_result<E: Display>(result: Result<(), E>) {
    if let Err(error) = result {
        log::debug!("Station tray update deferred: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn manifest(host: &str) -> ServiceManifest {
        manifest_with(host, "default", 3141, 3000)
    }

    fn manifest_with(
        host: &str,
        instance_id: &str,
        server_port: u16,
        ui_port: u16,
    ) -> ServiceManifest {
        ServiceManifest {
            host: host.into(),
            instance_id: instance_id.into(),
            node_path: "/opt/node/bin/node".into(),
            platform: "darwin".into(),
            repo_path: "/opt/station".into(),
            server_port,
            ui_port,
        }
    }

    fn status(ownership: ServerOwnership, port: Option<u16>) -> BundledServerStatus {
        let mut status = BundledServerStatus::initial("out.log".into(), "err.log".into());
        status.ownership = ownership;
        status.port = port;
        status
    }

    fn service_owner(instance_id: &str, api_port: u16) -> DesktopOwnerSnapshot {
        DesktopOwnerSnapshot::Service {
            instance_id: instance_id.into(),
            api_port,
        }
    }

    #[test]
    fn formats_stable_and_nightly_product_identity_with_versions() {
        assert_eq!(identity_label("Station", "0.1.0"), "Station v0.1.0");
        assert_eq!(
            identity_label("Station Nightly", "0.1.0-nightly.4"),
            "Station Nightly v0.1.0-nightly.4"
        );
        assert_eq!(identity_label("   ", "2.0.0"), "Station v2.0.0");
        assert_eq!(open_label("Station Nightly"), "Open Station Nightly");
        assert_eq!(quit_label("Station Nightly"), "Quit Station Nightly");
    }

    #[test]
    fn labels_backends_from_ownership_and_validated_ports() {
        let service = manifest_with("127.0.0.1", "alpha_1.2", 3141, 3000);
        let service_status = status(ServerOwnership::Service, Some(3141));
        assert_eq!(
            tray_backend_snapshot(
                &service_status,
                &service_owner("alpha_1.2", 3141),
                Some(&service),
                Some(ServiceHealth::Running),
            )
            .label,
            "Backend: local service alpha_1.2 · API 3141 · UI 3000",
        );
        assert_eq!(
            tray_backend_snapshot(
                &status(ServerOwnership::Sidecar, Some(4310)),
                &DesktopOwnerSnapshot::Sidecar,
                None,
                None,
            )
            .label,
            "Backend: Built-in · API 4310",
        );
        assert_eq!(
            tray_backend_snapshot(
                &status(ServerOwnership::None, None),
                &DesktopOwnerSnapshot::Unowned,
                Some(&service),
                Some(ServiceHealth::Stopped),
            )
            .label,
            "Backend: local service alpha_1.2 · API 3141 · UI 3000",
        );
        assert_eq!(
            tray_backend_snapshot(
                &status(ServerOwnership::Sidecar, None),
                &DesktopOwnerSnapshot::Sidecar,
                None,
                None,
            )
            .label,
            "Backend: Built-in · API unavailable",
        );
        assert_eq!(
            tray_backend_snapshot(
                &status(ServerOwnership::Sidecar, Some(0)),
                &DesktopOwnerSnapshot::Sidecar,
                None,
                None,
            )
            .label,
            "Backend: Built-in · API unavailable",
        );
        let zero_port_service = manifest_with("127.0.0.1", "alpha", 0, 3000);
        assert_eq!(
            tray_backend_snapshot(
                &status(ServerOwnership::Service, Some(3141)),
                &service_owner("alpha", 3141),
                Some(&zero_port_service),
                Some(ServiceHealth::Stopped),
            )
            .label,
            "Backend: unavailable",
        );
    }

    #[test]
    fn replaces_unsafe_service_instances_without_showing_untrusted_text() {
        assert_eq!(safe_instance("alpha.1_beta-2"), "alpha.1_beta-2");
        for instance in ["", "contains space", "<token>", "é", &"a".repeat(65)] {
            assert_eq!(safe_instance(instance), "custom", "{instance:?}");
        }

        let unsafe_service = manifest_with("127.0.0.1", "secret/path", 3141, 3000);
        assert_eq!(
            tray_backend_snapshot(
                &status(ServerOwnership::Service, Some(3141)),
                &service_owner("secret/path", 3141),
                Some(&unsafe_service),
                Some(ServiceHealth::Running),
            )
            .label,
            "Backend: local service custom · API 3141 · UI 3000",
        );
    }

    #[test]
    fn selects_the_tray_icon_from_the_packaged_channel() {
        assert_eq!(tray_icon_bytes(Some("stable")), STATION_TRAY_ICON);
        assert_eq!(tray_icon_bytes(Some("beta")), BETA_TRAY_ICON);
        assert_eq!(tray_icon_bytes(Some("nightly")), NIGHTLY_TRAY_ICON);
        assert_eq!(tray_icon_bytes(None), DEV_TRAY_ICON);
        assert_eq!(tray_icon_bytes(Some("unrecognized")), DEV_TRAY_ICON);
        assert_ne!(NIGHTLY_TRAY_ICON, STATION_TRAY_ICON);
    }

    #[test]
    fn nightly_sidecar_snapshot_converges_from_starting_to_running_on_its_channel_port() {
        let starting = status(ServerOwnership::Sidecar, Some(38_141));
        let mut running = starting.clone();
        running.phase = crate::bundled_server_state::ServerPhase::Running;

        let starting_snapshot =
            tray_backend_snapshot(&starting, &DesktopOwnerSnapshot::Sidecar, None, None);
        let running_snapshot =
            tray_backend_snapshot(&running, &DesktopOwnerSnapshot::Sidecar, None, None);

        assert_eq!(starting_snapshot.label, "Backend: Built-in · API 38141");
        assert_eq!(starting_snapshot.health, ServiceHealth::Stopped);
        assert_eq!(running_snapshot.label, "Backend: Built-in · API 38141");
        assert_eq!(running_snapshot.health, ServiceHealth::Running);
        assert!(running_snapshot.can_open());
        assert!(running_snapshot.can_navigate());
        assert!(!running_snapshot.action.enabled);
    }

    #[test]
    fn prepared_stable_legacy_context_reports_the_healthy_sidecar_not_the_old_service() {
        // The legacy Stable binding was rooted at the shared home on
        // 3141/3000. Runtime preparation removes its manifest, so the tray
        // receives no trusted service and must report the actual 18141
        // sidecar selected for ~/.station/instances/stable.
        let mut sidecar = status(ServerOwnership::Sidecar, Some(18_141));
        sidecar.phase = crate::bundled_server_state::ServerPhase::Running;
        let snapshot = tray_backend_snapshot(&sidecar, &DesktopOwnerSnapshot::Sidecar, None, None);
        assert_eq!(snapshot.kind, TrayBackendKind::Sidecar);
        assert_eq!(snapshot.label, "Backend: Built-in · API 18141");
        assert_eq!(snapshot.health, ServiceHealth::Running);

        let attached = manifest_with("127.0.0.1", "stable-service", 18_141, 18_000);
        let attached_snapshot = tray_backend_snapshot(
            &status(ServerOwnership::Service, Some(18_141)),
            &service_owner("stable-service", 18_141),
            Some(&attached),
            Some(ServiceHealth::Running),
        );
        assert_eq!(attached_snapshot.kind, TrayBackendKind::Service);

        let ambiguous_snapshot = tray_backend_snapshot(
            &status(ServerOwnership::None, None),
            &DesktopOwnerSnapshot::Unavailable,
            Some(&attached),
            Some(ServiceHealth::Running),
        );
        assert_eq!(ambiguous_snapshot.kind, TrayBackendKind::Unavailable);
        assert_eq!(ambiguous_snapshot.label, "Backend: unavailable");
    }

    #[test]
    fn rejected_dispatch_retries_on_a_later_supervisor_kick() {
        let (kick, receiver) = channel();
        kick.send(()).expect("queue supervisor kick");
        drop(kick);
        let mut dispatches = [Err("event loop is not ready"), Ok(())].into_iter();
        let mut attempts = 0;
        let mut update = || {
            attempts += 1;
            record_dispatch_result(dispatches.next().expect("dispatch fixture"));
            ServiceHealth::Running
        };

        assert!(poll_step(&receiver, &mut update));
        assert!(!poll_step(&receiver, &mut update));
        assert_eq!(attempts, 2);
    }

    #[test]
    fn durable_service_health_comes_from_the_endpoint_not_attached_phase() {
        let service = manifest("127.0.0.1");
        let attached_status = status(ServerOwnership::Service, Some(3141));
        // Attached-service status is intentionally Stopped; a live endpoint
        // must still render Running.
        assert_eq!(
            tray_backend_snapshot(
                &attached_status,
                &service_owner("default", 3141),
                Some(&service),
                Some(ServiceHealth::Running),
            )
            .health,
            ServiceHealth::Running,
        );
        assert_eq!(
            tray_backend_snapshot(
                &attached_status,
                &service_owner("default", 3141),
                Some(&service),
                Some(ServiceHealth::Unhealthy),
            )
            .health,
            ServiceHealth::Unhealthy,
        );
        assert_eq!(
            tray_backend_snapshot(
                &status(ServerOwnership::None, None),
                &DesktopOwnerSnapshot::Unowned,
                Some(&service),
                Some(ServiceHealth::Running),
            )
            .health,
            ServiceHealth::Running,
        );
    }

    #[test]
    fn uses_one_honest_contextual_service_action() {
        let service_manifest = manifest("127.0.0.1");
        let service = status(ServerOwnership::Service, Some(3141));
        assert_eq!(
            tray_backend_snapshot(
                &service,
                &service_owner("default", 3141),
                Some(&service_manifest),
                Some(ServiceHealth::Running),
            )
            .action,
            ContextualServiceAction {
                label: "Stop service",
                action: Some(ServiceAction::Stop),
                enabled: true,
            }
        );
        let unowned = status(ServerOwnership::None, None);
        assert_eq!(
            tray_backend_snapshot(
                &unowned,
                &DesktopOwnerSnapshot::Unowned,
                Some(&service_manifest),
                Some(ServiceHealth::Stopped),
            )
            .action,
            ContextualServiceAction {
                label: "Start service",
                action: Some(ServiceAction::Start),
                enabled: true,
            }
        );
        assert_eq!(
            tray_backend_snapshot(
                &status(ServerOwnership::Sidecar, Some(4310)),
                &DesktopOwnerSnapshot::Sidecar,
                None,
                None,
            )
            .action,
            ContextualServiceAction {
                label: "Built-in service",
                action: None,
                enabled: false,
            }
        );
        assert_eq!(
            tray_backend_snapshot(&unowned, &DesktopOwnerSnapshot::Unavailable, None, None,).action,
            ContextualServiceAction {
                label: "Service unavailable",
                action: None,
                enabled: false,
            }
        );
    }

    #[test]
    fn refuses_a_manifest_that_does_not_match_the_registry_owner() {
        let service = manifest("127.0.0.1");
        for owner in [service_owner("other", 3141), service_owner("default", 4310)] {
            let snapshot = tray_backend_snapshot(
                &status(ServerOwnership::Service, Some(3141)),
                &owner,
                Some(&service),
                Some(ServiceHealth::Running),
            );
            assert_eq!(snapshot.kind, TrayBackendKind::Unavailable);
            assert_eq!(snapshot.label, "Backend: unavailable");
            assert!(!snapshot.action.enabled);
        }
    }

    #[test]
    fn tooltip_combines_identity_backend_and_explicit_health() {
        assert_eq!(
            tray_tooltip(
                "Station Nightly v0.1.0-nightly.4",
                "Backend: Built-in · API 4310",
                ServiceHealth::Running
            ),
            "Station Nightly v0.1.0-nightly.4\nBackend: Built-in · API 4310\nHealth: Running"
        );
    }

    #[test]
    fn builds_only_canonical_http_station_urls() {
        assert_eq!(
            station_ui_url(&manifest("127.0.0.1")).unwrap(),
            "http://127.0.0.1:3000"
        );
        assert_eq!(
            station_ui_url(&manifest("0.0.0.0")).unwrap(),
            "http://127.0.0.1:3000"
        );
        assert_eq!(
            station_ui_url(&manifest("::")).unwrap(),
            "http://127.0.0.1:3000"
        );
        assert_eq!(
            station_ui_url(&manifest("::1")).unwrap(),
            "http://[::1]:3000"
        );
        assert_eq!(
            station_ui_url(&manifest("[::1]")).unwrap(),
            "http://[::1]:3000"
        );
        assert_eq!(
            station_ui_url(&manifest("localhost")).unwrap(),
            "http://localhost:3000"
        );
    }

    #[test]
    fn appends_the_fixed_connections_path_to_the_validated_station_root() {
        assert_eq!(
            station_connections_url(&manifest("127.0.0.1")).unwrap(),
            "http://127.0.0.1:3000/connections"
        );
        assert!(station_connections_url(&manifest("https://example.com")).is_err());
    }

    #[test]
    fn opens_updates_only_at_the_fixed_core_update_settings_path() {
        assert_eq!(
            station_core_update_url(&manifest("127.0.0.1")).unwrap(),
            "http://127.0.0.1:3000/settings?view=system&highlight=core-app-updates"
        );
        assert!(station_core_update_url(&manifest("https://example.com")).is_err());
    }

    #[test]
    fn serializes_only_closed_sidecar_navigation_destinations() {
        assert_eq!(
            serde_json::to_value(TrayNavigationDestination::Connections).unwrap(),
            "connections"
        );
        assert_eq!(
            serde_json::to_value(TrayNavigationDestination::CoreUpdates).unwrap(),
            "coreUpdates"
        );
        assert_eq!(
            serde_json::to_value(TrayNavigationDestination::PairedDevices).unwrap(),
            "pairedDevices"
        );
    }

    #[test]
    fn parses_only_bounded_connected_client_aggregates() {
        assert_eq!(
            connected_clients_label_from_body(
                r#"{"connectedClients":0,"connectedDevices":0,"observedAt":1}"#
            )
            .as_deref(),
            Some("No clients connected")
        );
        assert_eq!(
            connected_clients_label_from_body(
                r#"{"connectedClients":1,"connectedDevices":1,"observedAt":1}"#
            )
            .as_deref(),
            Some("1 client connected")
        );
        assert_eq!(
            connected_clients_label_from_body(
                r#"{"connectedClients":5,"connectedDevices":2,"observedAt":1}"#
            )
            .as_deref(),
            Some("5 clients connected")
        );
        assert!(connected_clients_label_from_body("not-json").is_none());
        assert!(connected_clients_label_from_body(
            r#"{"connectedClients":257,"connectedDevices":1,"observedAt":1}"#
        )
        .is_none());
    }

    #[test]
    fn paired_devices_url_is_one_fixed_safe_destination() {
        assert_eq!(
            station_paired_devices_url(&manifest("127.0.0.1")).unwrap(),
            "http://127.0.0.1:3000/?station-connect=devices"
        );
    }

    #[test]
    fn rejects_schemes_paths_and_noncanonical_hosts() {
        for host in [
            "",
            " localhost",
            "localhost ",
            "https://example.com",
            "example.com/path",
            "example.com",
            "[127.0.0.1]",
        ] {
            assert!(station_ui_url(&manifest(host)).is_err(), "{host}");
        }
    }

    #[test]
    fn invokes_the_opener_with_the_validated_url() {
        let opened = RefCell::new(None);
        open_manifest_ui(&manifest("127.0.0.1"), |url| {
            opened.replace(Some(url.to_string()));
            Ok::<(), &str>(())
        })
        .unwrap();

        assert_eq!(
            opened.into_inner().as_deref(),
            Some("http://127.0.0.1:3000")
        );
    }

    #[test]
    fn reports_native_opener_failures() {
        let error =
            open_manifest_ui(&manifest("127.0.0.1"), |_| Err("OS opener unavailable")).unwrap_err();

        assert_eq!(
            error,
            "native opener rejected http://127.0.0.1:3000: OS opener unavailable"
        );
    }
}
