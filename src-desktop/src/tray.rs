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
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
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
    connected_clients_in_flight: Arc<AtomicBool>,
    connected_clients_generation: Arc<AtomicU64>,
}

/// Supervisor transitions wake this receiver; they never write a webview
/// event themselves. This keeps the tray poll as the sole event writer.
///
/// The sender and worker handle are managed by Tauri for the entire primary
/// app lifetime. A detached worker whose last sender was accidentally dropped
/// used to exit after its first update and leave the native menu at its setup
/// placeholders without any diagnostic.
struct TrayPoll {
    wake: Sender<TrayWake>,
    shutting_down: Arc<AtomicBool>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrayWake {
    Kick,
    Shutdown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrayPollExit {
    Shutdown,
    WakeChannelDisconnected,
}

pub(crate) fn kick(app: &AppHandle) {
    if let Some(poll) = app.try_state::<TrayPoll>() {
        let _ = poll.wake.send(TrayWake::Kick);
    }
}

/// Stops and joins the app-owned tray poll during native teardown. A missing
/// poll is deliberately harmless: setup can fail before tray initialization.
pub(crate) fn shutdown(app: &AppHandle) {
    let Some(poll) = app.try_state::<TrayPoll>() else {
        return;
    };
    if poll.shutting_down.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = poll.wake.send(TrayWake::Shutdown);
    let worker = {
        let mut worker = poll
            .worker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        worker.take()
    };
    if let Some(worker) = worker {
        let _ = worker.join();
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
    if !app.manage(TrayState {
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
        connected_clients_in_flight: Arc::new(AtomicBool::new(false)),
        connected_clients_generation: Arc::new(AtomicU64::new(0)),
    }) {
        return Err(std::io::Error::other("Station tray state was already initialized").into());
    }
    let (wake, receiver) = channel();
    let shutting_down = Arc::new(AtomicBool::new(false));
    if !app.manage(TrayPoll {
        wake,
        shutting_down: shutting_down.clone(),
        worker: Mutex::new(None),
    }) {
        return Err(
            std::io::Error::other("Station tray poll state was already initialized").into(),
        );
    }
    let worker = spawn_poll_thread(app.clone(), receiver, shutting_down)?;
    *app.state::<TrayPoll>()
        .worker
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(worker);
    log::info!("Station tray initialized");
    Ok(())
}

fn spawn_poll_thread(
    app: AppHandle,
    wakes: Receiver<TrayWake>,
    shutting_down: Arc<AtomicBool>,
) -> std::io::Result<thread::JoinHandle<()>> {
    thread::Builder::new()
        .name("station-service-tray-poll".into())
        .spawn(move || {
            // Keep the Rust tray and the Desktop webview on the same polling
            // path. In particular, an external service crash or recovery must
            // emit the status event even though no tray action was clicked.
            let result = catch_unwind(AssertUnwindSafe(|| {
                let mut update = || update_once(&app);
                run_poll_loop(&wakes, &mut update)
            }));
            match result {
                Ok(TrayPollExit::Shutdown) if shutting_down.load(Ordering::SeqCst) => {
                    log::debug!("Station tray poll stopped during desktop teardown");
                }
                Ok(TrayPollExit::Shutdown) => {
                    log::error!("Station tray poll received shutdown outside desktop teardown");
                    apply_poller_failure(&app);
                }
                Ok(TrayPollExit::WakeChannelDisconnected) => {
                    log::error!("Station tray poll wake channel disconnected unexpectedly");
                    apply_poller_failure(&app);
                }
                Err(_) => {
                    log::error!("Station tray poll panicked; marking native tray unavailable");
                    apply_poller_failure(&app);
                }
            }
        })
}

fn run_poll_loop<F>(wakes: &Receiver<TrayWake>, update: &mut F) -> TrayPollExit
where
    F: FnMut() -> ServiceHealth,
{
    loop {
        match poll_step(wakes, update) {
            TrayPollStep::Continue => {}
            TrayPollStep::Shutdown => return TrayPollExit::Shutdown,
            TrayPollStep::WakeChannelDisconnected => return TrayPollExit::WakeChannelDisconnected,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrayPollStep {
    Continue,
    Shutdown,
    WakeChannelDisconnected,
}

/// Run one tray/webview convergence update and wait for either its normal
/// cadence or a supervisor kick. The managed sender stays alive until explicit
/// desktop teardown, so a disconnected channel is an observable fault rather
/// than an implied teardown.
fn poll_step<F>(wakes: &Receiver<TrayWake>, update: &mut F) -> TrayPollStep
where
    F: FnMut() -> ServiceHealth,
{
    let health = update();
    match wakes.recv_timeout(health.poll_interval()) {
        Ok(TrayWake::Kick) | Err(RecvTimeoutError::Timeout) => TrayPollStep::Continue,
        Ok(TrayWake::Shutdown) => TrayPollStep::Shutdown,
        Err(RecvTimeoutError::Disconnected) => TrayPollStep::WakeChannelDisconnected,
    }
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

fn apply_primary_health(state: &TrayState, snapshot: TrayBackendSnapshot) {
    let label = snapshot.health.label();
    let _ = state.status.set_text(format!("Station service: {label}"));
    let _ = state.backend.set_text(&snapshot.label);
    let _ = state.open.set_enabled(snapshot.can_open());
    let _ = state.connections.set_enabled(snapshot.can_navigate());
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

fn apply_connected_clients(state: &TrayState, connected_clients: String) {
    let _ = state.connected_clients.set_text(connected_clients);
}

/// A tray poll fault must not leave a healthy-looking but indefinitely stale
/// menu. This disables native actions without changing service ownership or
/// issuing any service command.
fn apply_poller_failure_ui(state: &TrayState) {
    let _ = state.status.set_text("Station service: unavailable");
    let _ = state.backend.set_text("Backend: unavailable");
    let _ = state.open.set_enabled(false);
    let _ = state.connections.set_enabled(false);
    let _ = state
        .connected_clients
        .set_text("Connected clients: unavailable");
    let _ = state.connected_clients.set_enabled(false);
    let _ = state.updates.set_enabled(false);
    let _ = state.service_action.set_text("Service unavailable");
    let _ = state.service_action.set_enabled(false);
    let _ = state.tray.set_tooltip(Some(tray_tooltip(
        &state.identity_text,
        "Backend: unavailable",
        ServiceHealth::Unhealthy,
    )));
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
    let snapshot = context.snapshot.clone();
    // Advance for every primary context, including when the previous optional
    // projection is still waiting on Keychain or HTTP. Its eventual result
    // must never overwrite a newer owner/backend presentation.
    let projection_generation =
        advance_connected_clients_generation(&state.connected_clients_generation);
    let primary_app = app.clone();
    let primary_state = state.clone();
    let projection_app = app.clone();
    // A supervisor Listening kick must publish backend ownership, health, and
    // native actions immediately. The paired-client aggregate is useful but
    // optional: it may need a locked Keychain item or an unavailable HTTP
    // endpoint, neither of which may hold the primary tray state hostage.
    dispatch_primary_then_schedule_projection(
        move || {
            record_dispatch_result(primary_app.run_on_main_thread({
                let state = primary_state;
                move || apply_primary_health(&state, snapshot)
            }));
            crate::emit_service_status(&primary_app);
        },
        move || {
            schedule_connected_clients_projection(
                projection_app,
                state,
                context,
                projection_generation,
            )
        },
    );
    health
}

/// Keep the primary dispatch on the supervisor/poll path and schedule the
/// optional projection only afterwards. This small seam is deliberately
/// synchronous at the boundary: its optional closure must return promptly,
/// while the Keychain/HTTP work itself runs on its own worker.
fn dispatch_primary_then_schedule_projection<P, C>(primary: P, projection: C)
where
    P: FnOnce(),
    C: FnOnce(),
{
    primary();
    projection();
}

fn advance_connected_clients_generation(generation: &AtomicU64) -> u64 {
    generation.fetch_add(1, Ordering::SeqCst).wrapping_add(1)
}

fn projection_is_current(generation: &AtomicU64, expected: u64) -> bool {
    generation.load(Ordering::SeqCst) == expected
}

fn schedule_connected_clients_projection(
    app: AppHandle,
    state: TrayState,
    context: TrayContext,
    generation: u64,
) {
    if state
        .connected_clients_in_flight
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    let in_flight = state.connected_clients_in_flight.clone();
    let worker_in_flight = in_flight.clone();
    let worker_generation = state.connected_clients_generation.clone();
    let spawn = thread::Builder::new()
        .name("station-tray-connected-clients".into())
        .spawn(move || {
            let result = catch_unwind(AssertUnwindSafe(|| connected_clients_label(&app, &context)));
            let connected_clients = match result {
                Ok(label) => label,
                Err(_) => {
                    log::error!("Station tray connected-client projection panicked");
                    "Connected clients: unavailable".to_string()
                }
            };
            let schedule = schedule_projection_callback(
                move |callback| app.run_on_main_thread(callback),
                worker_in_flight,
                move || {
                    if projection_is_current(&worker_generation, generation) {
                        apply_connected_clients(&state, connected_clients);
                    } else {
                        log::debug!(
                            "Station tray discarded stale connected-client projection generation {generation}"
                        );
                    }
                },
            );
            if let Err(error) = schedule {
                log::debug!("Station tray connected-client projection deferred: {error}");
            }
        });
    if let Err(error) = spawn {
        in_flight.store(false, Ordering::SeqCst);
        log::error!("Station tray connected-client projection could not start: {error}");
    }
}

/// The in-flight bit remains set until the main-thread callback applies or
/// discards its generation. That admits one worker and one queued callback at
/// a time; if native scheduling rejects it, clear the bit so a later primary
/// convergence can recover instead of wedging the optional projection.
fn schedule_projection_callback<E, S, C>(
    schedule: S,
    in_flight: Arc<AtomicBool>,
    callback: C,
) -> Result<(), E>
where
    S: FnOnce(Box<dyn FnOnce() + Send>) -> Result<(), E>,
    C: FnOnce() + Send + 'static,
{
    let callback_in_flight = in_flight.clone();
    let result = schedule(Box::new(move || {
        callback();
        callback_in_flight.store(false, Ordering::SeqCst);
    }));
    if result.is_err() {
        in_flight.store(false, Ordering::SeqCst);
    }
    result
}

fn apply_poller_failure(app: &AppHandle) {
    if let Some(state) = app.try_state::<TrayState>() {
        let state = state.inner().clone();
        record_dispatch_result(app.run_on_main_thread(move || apply_poller_failure_ui(&state)));
    }
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
        let (wake, receiver) = channel();
        wake.send(TrayWake::Kick).expect("queue supervisor kick");
        wake.send(TrayWake::Shutdown)
            .expect("queue desktop teardown");
        let mut dispatches = [Err("event loop is not ready"), Ok(())].into_iter();
        let mut attempts = 0;
        let mut update = || {
            attempts += 1;
            record_dispatch_result(dispatches.next().expect("dispatch fixture"));
            ServiceHealth::Running
        };

        assert_eq!(poll_step(&receiver, &mut update), TrayPollStep::Continue);
        assert_eq!(poll_step(&receiver, &mut update), TrayPollStep::Shutdown);
        assert_eq!(attempts, 2);
    }

    #[test]
    fn managed_poll_lifetime_distinguishes_shutdown_from_sender_loss() {
        let (wake, receiver) = channel::<TrayWake>();
        wake.send(TrayWake::Shutdown)
            .expect("queue desktop teardown");
        let mut update = || ServiceHealth::Running;
        assert_eq!(
            run_poll_loop(&receiver, &mut update),
            TrayPollExit::Shutdown
        );

        let (wake, receiver) = channel::<TrayWake>();
        drop(wake);
        assert_eq!(
            run_poll_loop(&receiver, &mut update),
            TrayPollExit::WakeChannelDisconnected
        );
    }

    #[test]
    fn primary_main_thread_dispatch_precedes_a_blocked_clients_projection() {
        use std::sync::mpsc::sync_channel;

        let (primary_done, primary_observed) = sync_channel(1);
        let (projection_started, projection_observed) = sync_channel(1);
        let (release_projection, projection_release) = sync_channel(1);
        let worker = thread::spawn(move || {
            dispatch_primary_then_schedule_projection(
                || {
                    primary_done
                        .send(())
                        .expect("record primary main-thread dispatch")
                },
                || {
                    projection_started
                        .send(())
                        .expect("record optional projection start");
                    projection_release
                        .recv()
                        .expect("release blocked optional projection");
                },
            );
        });

        primary_observed
            .recv_timeout(Duration::from_millis(100))
            .expect("primary backend/status dispatch happens before optional work");
        projection_observed
            .recv_timeout(Duration::from_millis(100))
            .expect("optional projection may now block without delaying primary state");
        release_projection
            .send(())
            .expect("unblock optional projection");
        worker.join().expect("projection worker exits");
    }

    #[test]
    fn blocked_projection_cannot_overwrite_a_newer_primary_context() {
        let generation = Arc::new(AtomicU64::new(0));
        let in_flight = Arc::new(AtomicBool::new(true));
        let rendered_label = Arc::new(Mutex::new("Connected clients: context B".to_string()));
        let generation_a = advance_connected_clients_generation(&generation);
        let (projection_started, worker_started) = channel();
        let (release_worker, worker_release) = channel();
        let worker_generation = generation.clone();
        let worker_in_flight = in_flight.clone();
        let worker_label = rendered_label.clone();
        let worker = thread::spawn(move || {
            projection_started
                .send(())
                .expect("A projection reaches its blocked dependency");
            worker_release
                .recv()
                .expect("release the old projection result");
            schedule_projection_callback(
                |callback| {
                    callback();
                    Ok::<(), ()>(())
                },
                worker_in_flight,
                move || {
                    if projection_is_current(&worker_generation, generation_a) {
                        *worker_label.lock().expect("label lock") =
                            "1 client connected".to_string();
                    }
                },
            )
            .expect("A callback is scheduled after its dependency returns");
        });

        worker_started
            .recv_timeout(Duration::from_millis(100))
            .expect("old optional projection is blocked");
        // A supervisor Listening kick produces primary context B while A is
        // still in flight. It advances the same generation source used by the
        // main-thread callback, so A must be discarded when it returns.
        let generation_b = advance_connected_clients_generation(&generation);
        assert_ne!(generation_a, generation_b);
        assert!(
            in_flight.load(Ordering::SeqCst),
            "the single-worker slot remains owned until A's main-thread callback discards"
        );
        release_worker.send(()).expect("finish old projection");
        worker.join().expect("old projection exits");

        assert_eq!(
            rendered_label.lock().expect("label lock").as_str(),
            "Connected clients: context B"
        );
        assert!(
            !in_flight.load(Ordering::SeqCst),
            "discarding A releases the single-worker slot for a later B projection"
        );
    }

    #[test]
    fn projection_scheduling_failure_releases_the_single_worker_slot() {
        let in_flight = Arc::new(AtomicBool::new(true));
        let callback_ran = Arc::new(AtomicBool::new(false));
        let callback_ran_from_callback = callback_ran.clone();
        let result: Result<(), &str> = schedule_projection_callback(
            |_callback| Err("main thread unavailable"),
            in_flight.clone(),
            move || callback_ran_from_callback.store(true, Ordering::SeqCst),
        );

        assert_eq!(result, Err("main thread unavailable"));
        assert!(!callback_ran.load(Ordering::SeqCst));
        assert!(
            !in_flight.load(Ordering::SeqCst),
            "a rejected callback cannot wedge future projections"
        );
        assert!(
            in_flight
                .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok(),
            "the next primary tray update can claim the slot"
        );
    }

    #[test]
    fn initialization_manages_the_poll_before_starting_its_worker() {
        let source = include_str!("tray.rs");
        let state = source
            .find("app.manage(TrayState {")
            .expect("tray menu state is managed");
        let poll = source
            .find("app.manage(TrayPoll {")
            .expect("tray poll lifetime is managed");
        let spawn = source
            .find("let worker = spawn_poll_thread(")
            .expect("managed tray poll worker is started");
        assert!(state < poll && poll < spawn);
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
