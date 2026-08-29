use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use tauri::Manager;

#[cfg(not(mobile))]
mod bundled_server_state;
mod channel_ports_generated;
mod notification_watch;
mod pairing_deep_link_channels_generated;
mod service_state;
#[cfg(not(mobile))]
mod ssh_launcher;
mod startup_readiness;
#[cfg(not(mobile))]
mod tray;
mod windows_path_trust;

#[cfg(not(mobile))]
use bundled_server_state::{
    parse_generation_tagged_listening, transition, BundledServerStatus, ServerOwnership,
    SupervisorEffect, SupervisorInput,
};
#[cfg(not(mobile))]
use ssh_launcher::{
    ssh_env_probe, ssh_launch_cancel, ssh_launch_mark_identity_verified, ssh_launch_start,
    ssh_launch_status,
};
#[cfg(not(mobile))]
use std::io::{BufRead, BufReader};
#[cfg(not(mobile))]
use std::path::{Path, PathBuf};
#[cfg(not(mobile))]
use std::process::{Child, ChildStdout, Command, ExitStatus, Stdio};
#[cfg(not(mobile))]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(not(mobile))]
use std::sync::{
    mpsc::{channel, sync_channel, Receiver, RecvTimeoutError, Sender, SyncSender, TrySendError},
    Arc, Mutex,
};
#[cfg(not(mobile))]
use std::thread;
use std::{
    net::{SocketAddr, TcpStream},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Emitter;
use tauri::{ipc::Channel, AppHandle, State};
#[cfg(not(mobile))]
use tauri::{
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent},
    WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
#[cfg(not(mobile))]
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeCapabilityStatus {
    id: &'static str,
    state: &'static str,
    reason: &'static str,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeCapabilityReport {
    platform: &'static str,
    channel: &'static str,
    pairing_deep_link_scheme: String,
    capabilities: Vec<NativeCapabilityStatus>,
    /// True for a development build. On Android this is the `.debug`
    /// application id installed alongside a release build, so the UI can look
    /// visibly different and leave no doubt which one is on screen.
    dev_build: bool,
    /// Optional trusted build-time bootstrap for a native-mobile shell. It is
    /// secret-free and never replaces a saved/default profile in the UI.
    #[serde(skip_serializing_if = "Option::is_none")]
    mobile_default_endpoint: Option<String>,
}

fn trusted_mobile_default_endpoint(raw: Option<&str>) -> Option<String> {
    let raw = raw?.trim();
    let parsed = url::Url::parse(raw).ok()?;
    if parsed.scheme() != "https"
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return None;
    }
    Some(parsed.origin().ascii_serialization())
}

fn compile_target_platform() -> &'static str {
    #[cfg(target_os = "android")]
    return "android";
    #[cfg(target_os = "ios")]
    return "ios";
    #[cfg(target_os = "linux")]
    return "linux";
    #[cfg(target_os = "macos")]
    return "macos";
    #[cfg(target_os = "windows")]
    return "windows";
    #[allow(unreachable_code)]
    "unknown"
}

fn native_app_channel(identifier: &str, dev_build: bool) -> &'static str {
    if dev_build {
        "dev"
    } else {
        channel_ports_generated::desktop_channel_from_identifier(identifier).unwrap_or("stable")
    }
}

fn compile_target_capability_report(identifier: &str) -> NativeCapabilityReport {
    let mut capabilities = vec![
        NativeCapabilityStatus {
            id: "capability-report",
            state: "enabled",
            reason: "Station exposes this compile-target report through a typed command.",
        },
        NativeCapabilityStatus {
            id: "host-event-bridge",
            state: "enabled",
            reason: "Tauri core can deliver typed host events to the platform adapter.",
        },
        NativeCapabilityStatus {
            id: "share-intake",
            state: "disabled",
            reason:
                "Station has not selected and reviewed a native share-target or deep-link receiver.",
        },
    ];

    #[cfg(mobile)]
    capabilities.push(NativeCapabilityStatus {
        id: "local-browser-preview",
        state: "unsupported",
        reason: "Local browser previews require a supported desktop native host.",
    });
    #[cfg(not(mobile))]
    capabilities.push(NativeCapabilityStatus {
        id: "local-browser-preview",
        state: "enabled",
        reason: "The desktop native host can open a bounded local preview in the system browser.",
    });

    #[cfg(mobile)]
    capabilities.push(NativeCapabilityStatus {
        id: "workspace-pane-pop-out",
        state: "unsupported",
        reason: "Pane pop-out requires a supported desktop native host.",
    });
    #[cfg(not(mobile))]
    capabilities.push(NativeCapabilityStatus {
        id: "workspace-pane-pop-out",
        state: "enabled",
        reason: "The desktop native host can open a Station-routed pane window.",
    });

    #[cfg(mobile)]
    capabilities.push(NativeCapabilityStatus {
        id: "desktop-tray",
        state: "unsupported",
        reason: "The Station service tray is a desktop-only host capability.",
    });
    #[cfg(not(mobile))]
    capabilities.push(NativeCapabilityStatus {
        id: "desktop-tray",
        state: "enabled",
        reason: "The native desktop host owns the Station service tray.",
    });

    // Official Tauri haptics plugin (same class as notification). Enabled only
    // on mobile compile targets; desktop/web stay silent (station#1954).
    #[cfg(mobile)]
    capabilities.push(NativeCapabilityStatus {
        id: "haptics",
        state: "enabled",
        reason: "The mobile native host exposes selection/impact/notification haptics.",
    });

    capabilities.push(NativeCapabilityStatus {
        id: "pairing-deep-link",
        state: "enabled",
        reason: "The native host registers this channel's reviewed pairing association.",
    });
    capabilities.push(NativeCapabilityStatus {
        id: "host-credential-broker",
        state: "enabled",
        reason: "The native host owns Station bearer persistence, pairing commit, and bounded authenticated requests; bearer values never cross into the WebView.",
    });
    // station#3677 PR 3: every Tauri target can show the native consent
    // dialog (tauri-plugin-dialog is desktop + mobile); the server still
    // refuses unless this app's credential carries the local-grant mint.
    capabilities.push(NativeCapabilityStatus {
        id: "native-consent-broker",
        state: "enabled",
        reason: "The native host can review and decide consent approvals in OS chrome the webview cannot script.",
    });
    #[cfg(not(mobile))]
    capabilities.push(NativeCapabilityStatus {
        id: "haptics",
        state: "unsupported",
        reason: "Haptic feedback is a mobile-only host capability.",
    });

    capabilities.push(NativeCapabilityStatus {
        id: "remote-push",
        state: "unsupported",
        reason: "Station has no provisioned FCM/APNs application or server delivery credentials; the local notification watch cannot wake a backgrounded or closed mobile app (station#917/#1225).",
    });

    NativeCapabilityReport {
        platform: compile_target_platform(),
        channel: native_app_channel(identifier, cfg!(debug_assertions)),
        pairing_deep_link_scheme:
            pairing_deep_link_channels_generated::native_pairing_deep_link_scheme(
                identifier,
                cfg!(debug_assertions),
                native_app_channel(identifier, cfg!(debug_assertions)),
            ),
        dev_build: cfg!(debug_assertions),
        mobile_default_endpoint: if cfg!(mobile) {
            trusted_mobile_default_endpoint(option_env!("STATION_MOBILE_DEFAULT_ENDPOINT"))
        } else {
            None
        },
        capabilities,
    }
}

const STATION_CREDENTIAL_SERVICE: &str = "io.kontourai.station";
const EMPTY_STATION_PROFILE_STORE: &str =
    r#"{"schemaVersion":1,"revision":0,"defaultProfile":null,"profiles":[],"projectProfiles":{}}"#;
const JAVASCRIPT_MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const NATIVE_HTTP_BODY_LIMIT: usize = 24 * 1024 * 1024;
const NATIVE_HTTP_GLOBAL_REQUEST_LIMIT: usize = 32;
const NATIVE_HTTP_PENDING_READ_LIMIT: usize = 64;
/// Ordinary (non-stream) authenticated requests per origin.
///
/// station#2282: this used to bound *every* native request, and Station's own
/// long-lived SSE consumers — server, scheduler, monitoring, orchestration,
/// session — filled it on their own. Ordinary startup reads then lost the race
/// and failed with `native Station request capacity reached`, which surfaced
/// as a healthy, authorized Station appearing intermittently unreachable and
/// as a non-dismissible `Extensions unavailable` banner when `/api/plugins`
/// was the loser. Event streams are long-lived by design; ordinary reads are
/// not, and the two must not draw on the same allowance.
const NATIVE_HTTP_PER_ORIGIN_REQUEST_LIMIT: usize = 8;
/// Long-lived event streams per origin, budgeted separately from the above.
const NATIVE_HTTP_PER_ORIGIN_STREAM_LIMIT: usize = 12;
const NATIVE_PAIRING_EXCHANGE_GLOBAL_REQUEST_LIMIT: usize = 8;
const NATIVE_PAIRING_EXCHANGE_PER_ORIGIN_REQUEST_LIMIT: usize = 2;
const NATIVE_PAIRING_EXCHANGE_BODY_LIMIT: usize = 1024 * 1024;

/// The versioned, secret-free reference held by a saved Station.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
struct NativeCredentialReference {
    kind: String,
    id: String,
}

/// A structured refusal from the native Station authority, credential
/// store, or native pairing bridge, serialized across the Tauri invoke
/// boundary so TypeScript can switch on a stable `code` instead of matching
/// English prose (station#1818 R2). The classifier this replaced
/// (`packages/connect/src/core/connectionFailureClassification.ts`'s
/// `classifyNativeTransportRefusal`) matched literal substrings of the
/// `message` field below across the FFI boundary and needed a test that
/// read this very file to detect wording drift — a reworded `Err(...)`
/// silently degraded every case to `unreachable`. `code` is now the
/// contract; `message` is prose for logs and UI fallback text and carries
/// none — reword it freely.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeCommandError {
    code: &'static str,
    message: String,
}

impl NativeCommandError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for NativeCommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

/// Every helper on this file's error paths still returns the file's ambient
/// `Result<_, String>` convention (out of scope to convert wholesale here —
/// station#1818 R2 scopes this to the native HTTP bridge, the profile
/// authority, and the native pairing bridge only). An untyped internal
/// error reaching one of the newly-structured commands (a lock poison, a
/// malformed profile document, an I/O fault) has no meaningful refusal
/// code, so it degrades to a fixed `"internal"` code rather than pretending
/// to classify it — `classifyNativeTransportRefusal`'s fallback for an
/// unrecognized code already treats this conservatively (defers to the
/// caller's own transport-failure default instead of asserting a specific
/// reason it cannot support).
impl From<String> for NativeCommandError {
    fn from(message: String) -> Self {
        Self::new("internal", message)
    }
}

/// The reverse direction: a handful of callers on these same paths
/// (`credential_vault_delete`) are not part of this fix's scope and keep
/// the ambient `Result<_, String>` signature — this lets `?` still compose
/// through a structured-error helper without forcing every caller to
/// convert. The code is dropped deliberately; those callers were never
/// wired to a code-aware classifier and gain nothing from carrying one.
impl From<NativeCommandError> for String {
    fn from(error: NativeCommandError) -> Self {
        error.message
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
struct CredentialProfileStore {
    schema_version: u8,
    revision: u64,
    default_profile: Option<String>,
    profiles: Vec<CredentialProfile>,
    project_profiles: std::collections::HashMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
struct CredentialProfile {
    schema_version: u8,
    name: String,
    endpoint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    credential_ref: Option<NativeCredentialReference>,
    #[serde(rename = "environmentId", skip_serializing_if = "Option::is_none")]
    _environment_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    local_service: Option<NativeLocalService>,
    setup_source: String,
    configuration_state: String,
    created_at: f64,
    updated_at: f64,
    /// station#1818 R3 review round 1 (MEDIUM): persisted, not derived. See
    /// `resolve_local_self_provision_client_instance_id`'s doc comment for
    /// why a computed value (this file previously hashed one from
    /// `local_service.instance_id`) is the wrong shape for something the
    /// server's supersession must match byte-for-byte forever. Optional so
    /// every profile written before this field existed (or by the CLI,
    /// which never sets it) still parses under `deny_unknown_fields`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_instance_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
struct NativeLocalService {
    instance_id: String,
    base_dir: String,
    server_port: u16,
    ui_port: u16,
}

#[derive(Clone)]
struct AuthorizedProfile {
    name: String,
    reference: NativeCredentialReference,
    /// Renewed by every explicit authorization, even when the selected profile
    /// returns to the same credential. This is a capability epoch, not a
    /// profile identifier: the renderer never learns the credential reference
    /// or environment that it binds.
    binding_id: String,
}

/// The only receipt that crosses the IPC boundary after an explicit profile
/// authorization. Keep this deliberately small: a profile name, credential
/// reference, environment, and keyring account are native-only authority.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeProfileAuthorizationReceipt {
    binding_id: String,
    exact_origin: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct NativeCredentialBinding {
    exact_origin: String,
    environment_id: String,
}

#[derive(Clone, Default)]
struct NativeProfileAuthority(std::sync::Arc<std::sync::Mutex<NativeProfileAuthorityState>>);

#[derive(Default)]
struct NativeProfileAuthorityState {
    active: Option<AuthorizedProfile>,
    /// Credential references are the native authority identity. Profile names
    /// are renderer metadata and are never an authority key.
    bindings: std::collections::HashMap<String, NativeCredentialBinding>,
    transitioning: std::collections::HashSet<String>,
}

/// A bearer returned by the public pairing exchange is never returned across
/// IPC.  It exists only long enough for the profile-commit command to bind it
/// to the profile which the host has just revalidated.
#[derive(Clone, Default)]
struct NativePendingPairingCredentials(
    std::sync::Arc<std::sync::Mutex<std::collections::HashMap<String, PendingPairingCredential>>>,
);

struct PendingPairingCredential {
    credential: String,
    reference: NativeCredentialReference,
    exact_origin: String,
    environment_id: String,
    client_instance_id: String,
    expires_at: SystemTime,
    phase: NativePairingPhase,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum NativePairingPhase {
    AwaitingRequiresAuth,
    RequiresAuthPersisted { profile_name: String },
    CredentialRemoved { profile_name: String },
    KeyringWritten { profile_name: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativePairingPublicDevice {
    id: String,
    name: String,
    scope: String,
    kind: String,
    created_at: f64,
    last_used_at: Option<f64>,
    revoked_at: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativePairingExchangeResponse {
    environment_id: String,
    device: NativePairingPublicDevice,
    credential: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NativePairingExchangeError {
    error: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativePairingExchangeSuccess {
    ok: bool,
    environment_id: String,
    device: NativePairingPublicDeviceResponse,
    credential_handle: String,
    credential_ref: NativeCredentialReference,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativePairingPublicDeviceResponse {
    id: String,
    name: String,
    scope: String,
    kind: String,
    created_at: f64,
    last_used_at: Option<f64>,
    revoked_at: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativePairingExchangeFailure {
    ok: bool,
    status: u16,
    error: String,
}

#[derive(Serialize)]
#[serde(untagged)]
enum NativePairingExchangeResult {
    Success(NativePairingExchangeSuccess),
    Failure(NativePairingExchangeFailure),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeHttpRequest {
    request_id: String,
    url: String,
    method: String,
    #[serde(default)]
    headers: std::collections::HashMap<String, String>,
    #[serde(default)]
    body: Option<Vec<u8>>,
    /// Basis captures this opaque receipt when its exact connection becomes
    /// authorized. Ordinary native transport consumers remain deliberately
    /// unscoped for compatibility; they omit this field.
    #[serde(default)]
    expected_binding_id: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum NativeHttpMessage {
    Response {
        status: u16,
        headers: std::collections::HashMap<String, String>,
        #[serde(rename = "bodyLength")]
        body_length: Option<u64>,
    },
    Chunk {
        bytes: Vec<u8>,
    },
    End,
    Error {
        code: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
}

struct NativeHttpBrokerFailure {
    code: &'static str,
    detail: Option<String>,
}

struct NativeHttpTransportDetail {
    code: &'static str,
    detail: String,
}

impl NativeHttpBrokerFailure {
    fn coded(code: &'static str) -> Self {
        Self { code, detail: None }
    }

    fn transport(transport: NativeHttpTransportDetail) -> Self {
        Self {
            code: transport.code,
            detail: Some(transport.detail),
        }
    }
}

#[derive(Clone, Default)]
struct NativeHttpCancellation(
    std::sync::Arc<(
        std::sync::Mutex<NativeHttpAdmissionState>,
        std::sync::Condvar,
    )>,
);

#[derive(Default)]
struct NativeHttpAdmissionState {
    active: std::collections::HashMap<String, NativeActiveHttpRequest>,
    pending_reads: std::collections::VecDeque<NativePendingHttpRequest>,
}

struct NativePendingHttpRequest {
    request_id: String,
    origin: String,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

struct NativeActiveHttpRequest {
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    origin: String,
    /// Whether this reservation draws on the stream allowance rather than the
    /// ordinary-request one (station#2282).
    stream: bool,
}

/// Native pairing exchange has an independent, deliberately small admission
/// registry. Pairing responses briefly contain a bearer before it is captured
/// into a one-use host handle, so this registry is kept separate from the
/// generic authenticated request broker and is acquired before network I/O.
#[derive(Clone, Default)]
struct NativePairingExchangeCancellation(
    std::sync::Arc<
        std::sync::Mutex<std::collections::HashMap<String, NativeActivePairingExchange>>,
    >,
);

struct NativeActivePairingExchange {
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    origin: String,
}

fn credential_reference_key(reference: &NativeCredentialReference) -> Result<String, String> {
    if reference.kind != "station-bearer" {
        return Err("unsupported Station credential reference".to_string());
    }
    if reference.id.trim().is_empty() || reference.id.len() > 512 {
        return Err("invalid Station credential reference".to_string());
    }
    Ok(format!("{}:{}", reference.kind, reference.id))
}

/// Shared with the CLI credential adapter: service is fixed and an account is
/// derived solely from a secret-free saved Station reference.
fn credential_account(reference: &NativeCredentialReference) -> Result<String, String> {
    Ok(format!("profile:{}", credential_reference_key(reference)?))
}

fn credential_endpoint_uses_secure_transport(endpoint: &str) -> bool {
    let Some((scheme, authority)) = endpoint.split_once("://") else {
        return false;
    };
    if authority.is_empty()
        || authority.contains(['/', '?', '#', '@'])
        || authority.chars().any(char::is_whitespace)
    {
        return false;
    }
    let (host, port) = if let Some(bracketed) = authority.strip_prefix('[') {
        let Some((host, suffix)) = bracketed.split_once(']') else {
            return false;
        };
        let port = if suffix.is_empty() {
            None
        } else if let Some(port) = suffix.strip_prefix(':') {
            Some(port)
        } else {
            return false;
        };
        (host, port)
    } else if let Some((host, port)) = authority.rsplit_once(':') {
        if host.contains(':') {
            return false;
        }
        (host, Some(port))
    } else {
        (authority, None)
    };
    if host.is_empty() || port.is_some_and(|value| value.parse::<u16>().is_err()) {
        return false;
    }
    match scheme {
        "https" => true,
        "http" => host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback()),
        _ => false,
    }
}

fn parse_station_profile_store(contents: &str) -> Result<CredentialProfileStore, String> {
    let raw: serde_json::Value = serde_json::from_str(contents)
        .map_err(|error| format!("parse saved Station metadata: {error}"))?;
    if raw
        .as_object()
        .is_none_or(|object| !object.contains_key("defaultProfile"))
    {
        return Err("saved Station metadata is missing defaultProfile".to_string());
    }
    let store: CredentialProfileStore = serde_json::from_str(contents)
        .map_err(|error| format!("parse saved Station metadata: {error}"))?;
    if store.schema_version != 1 {
        return Err("unsupported saved Station schema version".to_string());
    }
    if store.revision > JAVASCRIPT_MAX_SAFE_INTEGER {
        return Err("saved Station revision exceeds the shared safe-integer range".to_string());
    }
    let mut names = std::collections::HashSet::new();
    let mut references = std::collections::HashSet::new();
    for profile in &store.profiles {
        if profile.schema_version != 1
            || profile.name.is_empty()
            || profile.endpoint.is_empty()
            || !profile.created_at.is_finite()
            || !profile.updated_at.is_finite()
            || !matches!(
                profile.setup_source.as_str(),
                "local" | "existing" | "hosted" | "paired" | "manual"
            )
            || !matches!(
                profile.configuration_state.as_str(),
                "configured" | "requires-auth" | "unconfigured"
            )
        {
            return Err("invalid saved Station metadata".to_string());
        }
        if !names.insert(profile.name.to_lowercase()) {
            return Err("Station names must be unique".to_string());
        }
        if let Some(service) = &profile.local_service {
            if service.instance_id.is_empty()
                || service.base_dir.is_empty()
                || service.server_port == 0
                || service.ui_port == 0
            {
                return Err("invalid Station local service metadata".to_string());
            }
        }
        if let Some(reference) = &profile.credential_ref {
            let key = credential_reference_key(reference)?;
            if !references.insert(key) {
                return Err("Station credential references must be unique".to_string());
            }
            if !credential_endpoint_uses_secure_transport(&profile.endpoint) {
                return Err(
                    "Station refuses credentials for a non-HTTPS, non-loopback endpoint"
                        .to_string(),
                );
            }
        }
    }
    if store
        .default_profile
        .as_ref()
        .is_some_and(|name| !names.contains(&name.to_lowercase()))
    {
        return Err("the default Station is missing from saved Station metadata".to_string());
    }
    if store.project_profiles.iter().any(|(project, profile)| {
        project.is_empty() || profile.is_empty() || !names.contains(&profile.to_lowercase())
    }) {
        return Err("the project Station selection is invalid".to_string());
    }
    Ok(store)
}

fn selected_profile_from_store<'a>(
    store: &'a CredentialProfileStore,
    profile_name: &str,
) -> Result<&'a CredentialProfile, String> {
    let profile = store
        .profiles
        .iter()
        .find(|profile| profile.name.eq_ignore_ascii_case(profile_name))
        .ok_or_else(|| "the selected Station is missing from saved Station metadata".to_string())?;
    Ok(profile)
}

#[cfg(test)]
fn selected_credential_reference_from_contents(
    contents: &str,
    profile_name: &str,
) -> Result<NativeCredentialReference, String> {
    let store = parse_station_profile_store(contents)?;
    let profile = selected_profile_from_store(&store, profile_name)?;
    let reference = profile
        .credential_ref
        .clone()
        .ok_or_else(|| "the selected Station has no credential reference".to_string())?;
    Ok(reference)
}

fn profile_credential_binding(
    profile: &CredentialProfile,
) -> Result<NativeCredentialBinding, String> {
    Ok(NativeCredentialBinding {
        exact_origin: exact_origin(&profile.endpoint)?,
        environment_id: profile
            ._environment_id
            .clone()
            .filter(|value| !value.is_empty() && value.len() <= 512)
            .ok_or_else(|| {
                "credential-bearing saved Stations require an environmentId".to_string()
            })?,
    })
}

fn observe_configured_profile_bindings(
    authority: &mut NativeProfileAuthorityState,
    store: &CredentialProfileStore,
) -> Result<(), String> {
    for profile in &store.profiles {
        if profile.configuration_state == "configured" {
            if let Some(reference) = &profile.credential_ref {
                let key = credential_reference_key(reference)?;
                let binding = profile_credential_binding(profile)?;
                authority.bindings.entry(key).or_insert(binding);
            }
        }
    }
    Ok(())
}

fn profile_bindings_are_authorized(
    authority: &NativeProfileAuthorityState,
    store: &CredentialProfileStore,
) -> Result<(), String> {
    for profile in &store.profiles {
        if let Some(reference) = &profile.credential_ref {
            let key = credential_reference_key(reference)?;
            if let Some(expected) = authority.bindings.get(&key) {
                let actual = profile_credential_binding(profile)?;
                if actual != *expected {
                    return Err(
                        "Station credential origin and environment bindings are host-authorized and cannot be changed through webview metadata"
                            .to_string(),
                    );
                }
            }
            if authority.transitioning.contains(&key) && profile.configuration_state == "configured"
            {
                return Err(
                    "Station credential is still transitioning and cannot be configured"
                        .to_string(),
                );
            }
        }
    }
    Ok(())
}

fn renderer_store_references_are_authorized(
    authority: &NativeProfileAuthorityState,
    store: &CredentialProfileStore,
) -> Result<(), String> {
    profile_bindings_are_authorized(authority, store)?;
    for profile in &store.profiles {
        if let Some(reference) = &profile.credential_ref {
            let key = credential_reference_key(reference)?;
            if !authority.bindings.contains_key(&key) {
                return Err(
                    "Station renderer writes cannot add an unobserved credential reference"
                        .to_string(),
                );
            }
            if authority.transitioning.contains(&key) {
                return Err(
                    "Station credential is transitioning; complete pairing first".to_string(),
                );
            }
        }
    }
    Ok(())
}

/// A successful owner-document write may leave unrelated display metadata
/// alone, but it must retire the active epoch if it changes the exact profile
/// authority. A later explicit authorize mints a fresh epoch even when the
/// user switches A -> B -> A.
fn invalidate_active_profile_receipt_after_store_write(
    authority: &mut NativeProfileAuthorityState,
    next_store: &CredentialProfileStore,
) {
    let Some(active) = authority.active.as_ref() else {
        return;
    };
    let remains_exactly_authorized = selected_profile_from_store(next_store, &active.name)
        .ok()
        .filter(|profile| profile.credential_ref.as_ref() == Some(&active.reference))
        .filter(|profile| profile.configuration_state == "configured")
        .and_then(|profile| {
            let key = credential_reference_key(&active.reference).ok()?;
            let expected = authority.bindings.get(&key)?;
            (profile_credential_binding(profile).ok()? == *expected).then_some(())
        })
        .is_some();
    if !remains_exactly_authorized {
        authority.active = None;
    }
}

fn invalidate_active_profile_receipt_after_credential_delete(
    authority: &mut NativeProfileAuthorityState,
    reference: &NativeCredentialReference,
) {
    if authority
        .active
        .as_ref()
        .is_some_and(|active| active.reference == *reference)
    {
        authority.active = None;
    }
}

#[cfg(all(not(mobile), target_os = "macos"))]
fn initialize_credential_store() -> Result<(), String> {
    use std::sync::OnceLock;

    static INITIALIZED: OnceLock<Result<(), String>> = OnceLock::new();
    INITIALIZED
        .get_or_init(|| {
            apple_native_keyring_store::keychain::Store::new()
                .map(|store| keyring_core::set_default_store(store))
                .map_err(|error| format!("macOS Keychain is unavailable: {error}"))
        })
        .clone()
}

#[cfg(all(not(mobile), target_os = "windows"))]
fn initialize_credential_store() -> Result<(), String> {
    use std::sync::OnceLock;

    static INITIALIZED: OnceLock<Result<(), String>> = OnceLock::new();
    INITIALIZED
        .get_or_init(|| {
            windows_native_keyring_store::Store::new()
                .map(|store| keyring_core::set_default_store(store))
                .map_err(|error| format!("Windows Credential Manager is unavailable: {error}"))
        })
        .clone()
}

// Secret Service is the maintained Linux keyring boundary. A missing D-Bus
// service or locked collection stays actionable and fail-closed; this never
// substitutes a file-backed or unattended credential store.
#[cfg(all(not(mobile), target_os = "linux"))]
fn initialize_credential_store() -> Result<(), String> {
    use std::sync::OnceLock;

    static INITIALIZED: OnceLock<Result<(), String>> = OnceLock::new();
    INITIALIZED
        .get_or_init(|| {
            zbus_secret_service_keyring_store::Store::new()
                .map(|store| keyring_core::set_default_store(store))
                .map_err(|error| {
                    format!(
                        "Linux Secret Service is unavailable or locked: {error}. Unlock your desktop keyring and retry; Station will not fall back to plaintext storage."
                    )
                })
        })
        .clone()
}

#[cfg(mobile)]
fn initialize_credential_store() -> Result<(), String> {
    mobile_credential_store()
        .get_password("__station_backend_probe__")
        .map(|_| ())
        .map_err(|error| format!("mobile OS credential store unavailable: {error}"))
}

#[cfg(mobile)]
fn mobile_credential_store() -> &'static tauri_plugin_keyring_store::KeyringStore {
    use std::sync::OnceLock;
    static STORE: OnceLock<tauri_plugin_keyring_store::KeyringStore> = OnceLock::new();
    STORE.get_or_init(|| {
        let store = tauri_plugin_keyring_store::KeyringStore::new(STATION_CREDENTIAL_SERVICE);
        #[cfg(target_os = "ios")]
        let store = store.with_write_accessibility(
            tauri_plugin_keyring_store::WriteAccessibility::AfterFirstUnlockThisDeviceOnly,
        );
        store
    })
}

fn write_credential_password(
    reference: &NativeCredentialReference,
    password: &str,
) -> Result<(), String> {
    #[cfg(mobile)]
    {
        let account = credential_account(reference)?;
        return mobile_credential_store()
            .set_password(&account, password)
            .map_err(|error| format!("write OS credential store: {error}"));
    }
    #[cfg(not(mobile))]
    credential_entry(reference)?
        .set_password(password)
        .map_err(|error| format!("write OS credential store: {error}"))
}

#[cfg(all(
    not(mobile),
    not(any(target_os = "macos", target_os = "windows", target_os = "linux"))
))]
fn initialize_credential_store() -> Result<(), String> {
    Err("This desktop platform has no supported OS credential store; Station will not fall back to plaintext storage.".to_string())
}

fn credential_entry(reference: &NativeCredentialReference) -> Result<keyring_core::Entry, String> {
    initialize_credential_store()?;
    let account = credential_account(reference)?;
    keyring_core::Entry::new(STATION_CREDENTIAL_SERVICE, &account)
        .map_err(|error| format!("create OS credential entry: {error}"))
}

fn is_missing_credential(error: &keyring_core::Error) -> bool {
    matches!(error, keyring_core::Error::NoEntry)
}

#[tauri::command]
fn credential_vault_delete(
    app: AppHandle,
    authority: State<'_, NativeProfileAuthority>,
) -> Result<(), String> {
    let reference = authorized_credential_reference(&app, &authority)?;
    match credential_entry(&reference)?.delete_credential() {
        Ok(()) => {
            let mut state = authority
                .0
                .lock()
                .map_err(|_| "Station native authority is unavailable".to_string())?;
            invalidate_active_profile_receipt_after_credential_delete(&mut state, &reference);
            Ok(())
        }
        Err(error) if is_missing_credential(&error) => {
            let mut state = authority
                .0
                .lock()
                .map_err(|_| "Station native authority is unavailable".to_string())?;
            invalidate_active_profile_receipt_after_credential_delete(&mut state, &reference);
            Ok(())
        }
        Err(error) => Err(format!("delete OS credential: {error}")),
    }
}

/// A retired reference may be supplied only after the host proves no profile
/// still owns it. This supports key rotation without reopening arbitrary
/// read/write/delete access to every keyring account.
#[tauri::command]
fn credential_vault_delete_unreferenced(
    app: AppHandle,
    reference: NativeCredentialReference,
) -> Result<(), String> {
    credential_reference_key(&reference)?;
    let contents = read_station_profile_contents(&app)?;
    let store = parse_station_profile_store(&contents)?;
    if store.profiles.iter().any(|profile| {
        profile
            .credential_ref
            .as_ref()
            .is_some_and(|owned| owned.kind == reference.kind && owned.id == reference.id)
    }) {
        return Err("refusing to delete a credential still owned by a saved Station".to_string());
    }
    match credential_entry(&reference)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(error) if is_missing_credential(&error) => Ok(()),
        Err(error) => Err(format!("delete OS credential: {error}")),
    }
}

/// The native host records the selected Station/reference after validating the full
/// owner-only document. Later keyring operations revalidate this exact binding,
/// so rewriting saved Station JSON cannot alias another credential into the selection.
///
/// Extracted from the `#[tauri::command]` wrapper (station#1715) so
/// `station_local_self_provision` can call it in-process, without an IPC
/// round-trip, immediately after its own CAS write records the binding this
/// function requires.
fn station_profile_authorize_active_internal(
    app: &AppHandle,
    authority: &NativeProfileAuthority,
    profile_name: &str,
) -> Result<NativeProfileAuthorizationReceipt, String> {
    let store = parse_station_profile_store(&read_station_profile_contents(app)?)?;
    let mut state = authority
        .0
        .lock()
        .map_err(|_| "Station native authority is unavailable".to_string())?;
    let receipt = authorize_active_profile_in_state(&mut state, &store, profile_name)?;
    drop(state);
    // The renderer may have attempted its bounded readiness proof before the
    // active credential was available. Reuse its mounted retry subscription
    // once the host has committed the selected profile.
    #[cfg(not(mobile))]
    notify_startup_readiness_if_waiting(app);
    #[cfg(mobile)]
    let _ = app.emit("station://startup-readiness-retry", ());
    Ok(receipt)
}

fn authorize_active_profile_in_state(
    state: &mut NativeProfileAuthorityState,
    store: &CredentialProfileStore,
    profile_name: &str,
) -> Result<NativeProfileAuthorizationReceipt, String> {
    let profile = selected_profile_from_store(store, profile_name)?;
    let reference = profile
        .credential_ref
        .clone()
        .ok_or_else(|| "the selected Station has no credential reference".to_string())?;
    profile_bindings_are_authorized(&state, &store)?;
    let key = credential_reference_key(&reference)?;
    if state.transitioning.contains(&key)
        || profile.configuration_state != "configured"
        || !state.bindings.contains_key(&key)
    {
        return Err(
            "the selected Station is not a configured host-observed credential; reload saved Station metadata before using its credential"
                .to_string(),
        );
    }
    let receipt = NativeProfileAuthorizationReceipt {
        binding_id: uuid::Uuid::new_v4().to_string(),
        exact_origin: profile_credential_binding(profile)?.exact_origin,
    };
    state.active = Some(AuthorizedProfile {
        name: profile.name.clone(),
        reference,
        binding_id: receipt.binding_id.clone(),
    });
    Ok(receipt)
}

#[tauri::command]
fn station_profile_authorize_active(
    app: AppHandle,
    authority: State<'_, NativeProfileAuthority>,
    profile_name: String,
) -> Result<NativeProfileAuthorizationReceipt, String> {
    station_profile_authorize_active_internal(&app, &authority, &profile_name)
}

/// Same-user local self-authorization (station#1715): reads the per-boot
/// grant secret the local Station service wrote to
/// `<base_dir>/runtime/local-grant.secret` alongside its service manifest,
/// under the identical owner-only boundary as the manifest
/// (`service_state::read_owner_only_file` — reject a symlink, a foreign
/// owner, or loose permissions on the file or its parent), so only the same
/// OS user that runs the service — never a different local account — can
/// retrieve it.
///
/// This never crosses IPC to the webview: `station_local_self_provision`
/// (the sole command in this family, see below) reads it, POSTs it to the
/// local-grant route, and stores the resulting credential entirely on the
/// Rust side. The route on the other end refuses anything but a direct
/// loopback caller, so filesystem possession plus loopback reachability is
/// the entire proof of authority; see the route's own threat-model comment
/// in `runtime-routes.ts`.
fn read_local_grant_secret(local: &NativeLocalService) -> Result<String, String> {
    if local.base_dir.trim().is_empty() || !std::path::Path::new(&local.base_dir).is_absolute() {
        return Err("the selected Station has an invalid local service base directory".to_string());
    }
    let secret_path = std::path::Path::new(&local.base_dir)
        .join("runtime")
        .join("local-grant.secret");
    let raw = service_state::read_owner_only_file(&secret_path, "local grant secret")
        .map_err(|error| format!("read Station local grant secret: {error}"))?;
    let secret = raw.trim().to_string();
    if secret.len() < 20 || secret.len() > 100 {
        return Err("Station local grant secret has an unexpected length".to_string());
    }
    Ok(secret)
}

/// A label for the paired-device entry this profile's credential becomes.
/// There is no webview to ask (`deriveDefaultDeviceName` is a browser-only
/// helper the connect layer's join panel uses), so this derives a
/// best-effort platform label without adding a new dependency:
/// `libc::gethostname` is already a `cfg(unix)` dependency of this crate
/// (used elsewhere here for `libc::geteuid`), and Windows sets
/// `COMPUTERNAME` in every normal session. Cosmetic only — it never
/// participates in an authorization decision.
fn local_device_name() -> String {
    #[cfg(unix)]
    {
        let mut buffer = [0_u8; 256];
        let result =
            unsafe { libc::gethostname(buffer.as_mut_ptr() as *mut libc::c_char, buffer.len()) };
        if result == 0 {
            if let Some(end) = buffer.iter().position(|&byte| byte == 0) {
                if let Ok(name) = std::str::from_utf8(&buffer[..end]) {
                    let trimmed = name.trim();
                    if !trimmed.is_empty() {
                        return format!("{trimmed} \u{b7} Station");
                    }
                }
            }
        }
    }
    #[cfg(windows)]
    {
        if let Ok(name) = std::env::var("COMPUTERNAME") {
            let trimmed = name.trim();
            if !trimmed.is_empty() {
                return format!("{trimmed} \u{b7} Station");
            }
        }
    }
    "This device \u{b7} Station".to_string()
}

#[cfg(not(mobile))]
fn station_profiles_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let _ = app;
    Ok(service_state::resolve_station_root()
        .join("config")
        .join("profiles.json"))
}

#[cfg(any(mobile, test))]
fn secure_mobile_station_profiles_path(
    app_config_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    match std::fs::symlink_metadata(app_config_dir) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => {
            return Err(
                "Station mobile config path must not be a symlink or non-directory".to_string(),
            )
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(app_config_dir)
                .map_err(|error| format!("create Station mobile config directory: {error}"))?;
        }
        Err(error) => {
            return Err(format!("inspect Station mobile config directory: {error}"));
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(app_config_dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("secure Station mobile config directory: {error}"))?;
    }
    Ok(app_config_dir.join("profiles.json"))
}

#[cfg(mobile)]
fn station_profiles_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    // Android's `home_dir()` resolves through external/scoped storage and is
    // not a reliable writable application home; iOS likewise does not expose
    // a Unix-style home contract to embedded code. Tauri's app-config path is
    // private to this application on both targets and is the correct durable
    // home for secret-free saved Station metadata. STATION_HOME remains a desktop/
    // CLI ownership override only and is deliberately ignored on mobile.
    let app_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("resolve Station mobile config directory: {error}"))?;
    secure_mobile_station_profiles_path(&app_config_dir)
}

/// Profile metadata controls which native credentials and local service are
/// selected. Treat it as a local control-plane file: never follow a final
/// symlink and, on Unix, require the current user's owner-only file mode.
fn validate_station_profile_store(path: &std::path::Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "saved Station metadata has no parent directory".to_string())?;
    match std::fs::symlink_metadata(parent) {
        Ok(metadata) if metadata.file_type().is_dir() => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if metadata.mode() & 0o077 != 0
                    || !profile_lock_owned_by_current_user(metadata.uid())
                {
                    return Err(
                        "saved Station directory must be current-user owned and owner-only"
                            .to_string(),
                    );
                }
            }
        }
        Ok(_) => {
            return Err(
                "saved Station directory must not be a symlink or non-directory".to_string(),
            )
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("inspect saved Station directory: {error}")),
    }
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if metadata.mode() & 0o077 != 0
                    || !profile_lock_owned_by_current_user(metadata.uid())
                {
                    return Err(
                        "saved Station metadata must be current-user owned and owner-only"
                            .to_string(),
                    );
                }
            }
            crate::windows_path_trust::verify(&[
                (crate::windows_path_trust::TrustKind::Directory, parent),
                (crate::windows_path_trust::TrustKind::File, path),
            ])
        }
        Ok(_) => Err("saved Station metadata must not be a symlink or non-file".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("inspect saved Station metadata: {error}")),
    }
}

fn read_station_profile_store(path: &std::path::Path) -> Result<String, std::io::Error> {
    validate_station_profile_store(path)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::PermissionDenied, error))?;
    #[cfg(unix)]
    {
        use std::io::Read;
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

        let mut options = std::fs::OpenOptions::new();
        options.read(true).custom_flags(libc::O_NOFOLLOW);
        let mut file = options.open(path)?;
        let metadata = file.metadata()?;
        if metadata.mode() & 0o077 != 0 || !profile_lock_owned_by_current_user(metadata.uid()) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "saved Station metadata must be current-user owned and owner-only",
            ));
        }
        let mut contents = String::new();
        file.read_to_string(&mut contents)?;
        return Ok(contents);
    }
    #[cfg(not(unix))]
    std::fs::read_to_string(path)
}

fn read_station_profile_contents(app: &AppHandle) -> Result<String, String> {
    let path = station_profiles_path(app)?;
    read_station_profile_store(&path)
        .map_err(|error| format!("read saved Station metadata for credential access: {error}"))
}

fn authorized_credential_reference(
    app: &AppHandle,
    authority: &NativeProfileAuthority,
) -> Result<NativeCredentialReference, NativeCommandError> {
    let state = authority
        .0
        .lock()
        .map_err(|_| "Station native authority is unavailable".to_string())?;
    let selected = state.active.clone().ok_or_else(|| {
        NativeCommandError::new(
            "no_active_profile",
            "Station has no host-authorized active Station",
        )
    })?;
    let store = parse_station_profile_store(&read_station_profile_contents(app)?)?;
    profile_bindings_are_authorized(&state, &store)?;
    let profile = selected_profile_from_store(&store, &selected.name)?;
    if profile.credential_ref.as_ref() != Some(&selected.reference) {
        return Err(NativeCommandError::new(
            "credential_binding_changed",
            "the active Station credential binding changed; reselect the Station before using its credential",
        ));
    }
    let key = credential_reference_key(&selected.reference)?;
    // These are genuinely different states, not one "not authorized" bucket:
    // `transitioning` means an authorization (pairing/rebind) is actively in
    // flight and will resolve on its own, while `configuration_state !=
    // "configured"` means nothing is pending at all — no approval was ever
    // requested. Station's native-transport error classifier
    // (`packages/connect/src/core/connectionFailureClassification.ts`)
    // switches on the `code` below to tell "wait, this is healthy" apart from
    // "this device is not authenticated here"; unlike the prose this
    // replaced, both call sites below may now share ONE code per state
    // (`mid_authorization` / `not_configured`) instead of a
    // context-specific wording, because the code itself — not a guess from
    // matching a sentence — is what the classifier reads.
    if state.transitioning.contains(&key) {
        return Err(NativeCommandError::new(
            "mid_authorization",
            "the active Station is mid-authorization for credential use",
        ));
    }
    if profile.configuration_state != "configured" {
        return Err(NativeCommandError::new(
            "not_configured",
            "the active Station is not configured for credential use",
        ));
    }
    let binding = state.bindings.get(&key).ok_or_else(|| {
        NativeCommandError::new(
            "credential_not_observed",
            "Station active credential was not observed by the native host",
        )
    })?;
    if profile_credential_binding(profile)? != *binding {
        return Err(NativeCommandError::new(
            "binding_changed",
            "the active Station origin or Environment binding changed",
        ));
    }
    Ok(selected.reference)
}

/// Native-only credential read for one already-validated origin. It reuses the
/// same profile binding authority as authenticated requests; no caller can
/// select a credential or return it through the WebView boundary.
pub(crate) fn native_credential_for_origin(
    app: &AppHandle,
    origin: &str,
) -> Result<String, String> {
    let authority = app
        .try_state::<NativeProfileAuthority>()
        .ok_or_else(|| "Station native authority is unavailable".to_string())?;
    let reference = authorized_profile_for_origin(app, &authority, origin)
        .map_err(|error| error.to_string())?;
    credential_entry(&reference)?
        .get_password()
        .map_err(|error| format!("read OS credential store: {error}"))
}

/// Decodes `%XX` escapes in one pass so the refusal below sees what the
/// server's router will match on. This is deliberately a CONSERVATIVE
/// SUPERSET of the router's `decodeURI`, not an equivalent of it: this
/// helper also decodes reserved escapes the router preserves (`%2F`, `%3F`,
/// `%23`) and replaces invalid UTF-8 rather than keeping it. The difference
/// can only over-block — a spelling the router would NOT route into the
/// consent family may still be refused here (`/api/consent%2Ffoo` routes to
/// the fallback today) — which is the safe direction for a refusal, and a
/// live probe of this repo's router version found no input it routes into
/// the family that this helper misses. Dot segments need no handling:
/// `url::Url::parse` already normalized them, as the server sees them.
fn percent_decode_path_lossy(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = (bytes[index + 1] as char).to_digit(16);
            let low = (bytes[index + 2] as char).to_digit(16);
            if let (Some(high), Some(low)) = (high, low) {
                out.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The webview relay must never ferry the native consent broker's family
/// (station#3677 PR 3). The relay attaches THIS APP'S keyring credential —
/// the local-grant mint the broker's server routes require — to whatever
/// path the webview asks for, so without this refusal any JS in the webview
/// (including plugin-contributed UI) could review and approve consent
/// transactions by riding the app's own authority, with no dialog shown at
/// all. Belt to the server's mint-kind gate, not the sole defense.
///
/// Both the raw and the decoded path are checked, because the server's
/// router decodes percent escapes BEFORE matching: `/api/%63onsent/...`
/// reaches the `/api/consent/...` route (probed live against this repo's
/// router version). A raw-only comparison — the first version of this
/// refusal, caught in review round 1 — let exactly that through and was a
/// silent-approval hole.
///
/// The family is denied by DEFAULT, with exactly one read allowed through:
/// `native-eligibility`, which has no server-side effect and answers only
/// "may the credential you already hold decide?" — a fact the caller could
/// learn by attempting a review. It has to pass, because on Tauri the app's
/// own UI reaches the server through THIS relay; blocking it made the
/// broker unreachable on the only hosts it serves (review round 2), a fix
/// that defeated itself. A new leaf under this family is refused until
/// someone deliberately adds it here.
const CONSENT_ELIGIBILITY_PATH: &str = "/api/consent/native-eligibility";

fn is_webview_forbidden_native_path(url: &url::Url) -> bool {
    let raw = url.path();
    let decoded = percent_decode_path_lossy(raw);
    [raw, decoded.as_str()].iter().any(|path| {
        (*path == "/api/consent" || path.starts_with("/api/consent/"))
            && *path != CONSENT_ELIGIBILITY_PATH
    })
}

fn exact_origin(value: &str) -> Result<String, String> {
    let url = url::Url::parse(value).map_err(|_| "invalid Station request URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.username() != "" || url.password().is_some()
    {
        return Err("invalid Station request URL".to_string());
    }
    Ok(url.origin().ascii_serialization())
}

fn authorized_profile_for_origin(
    app: &AppHandle,
    authority: &NativeProfileAuthority,
    origin: &str,
) -> Result<NativeCredentialReference, NativeCommandError> {
    let state = authority
        .0
        .lock()
        .map_err(|_| "Station native authority is unavailable".to_string())?;
    let selected = state.active.clone().ok_or_else(|| {
        NativeCommandError::new(
            "no_active_profile",
            "Station has no host-authorized active Station",
        )
    })?;
    let store = parse_station_profile_store(&read_station_profile_contents(app)?)?;
    profile_bindings_are_authorized(&state, &store)?;
    let profile = selected_profile_from_store(&store, &selected.name)?;
    if profile.credential_ref.as_ref() != Some(&selected.reference) {
        return Err(NativeCommandError::new(
            "credential_binding_changed",
            "the active Station credential binding changed; reselect the Station before using its credential",
        ));
    }
    let key = credential_reference_key(&selected.reference)?;
    // Same split as `authorized_credential_reference` above, and for the same
    // reason: `transitioning` (an authorization actively in flight) and "not
    // configured at all" are different states that Station's native-transport
    // error classifier must be able to tell apart — now by `code`, shared
    // with `authorized_credential_reference` since the code itself carries
    // the meaning.
    if state.transitioning.contains(&key) {
        return Err(NativeCommandError::new(
            "mid_authorization",
            "the active Station is mid-authorization for native requests",
        ));
    }
    if profile.configuration_state != "configured" {
        return Err(NativeCommandError::new(
            "not_configured",
            "the active Station is not configured for native requests",
        ));
    }
    let binding = state.bindings.get(&key).ok_or_else(|| {
        NativeCommandError::new(
            "credential_not_observed",
            "Station active credential was not observed by the native host",
        )
    })?;
    if binding.exact_origin != origin {
        return Err(NativeCommandError::new(
            "origin_changed",
            "the active Station origin changed; reselect the Station before using its credential",
        ));
    }
    if profile_credential_binding(profile)? != *binding {
        return Err(NativeCommandError::new(
            "binding_changed",
            "the active Station origin or Environment binding changed",
        ));
    }
    Ok(selected.reference)
}

/// A scoped request is bound to one explicit authorization epoch. Deliberately
/// collapse every invalid/missing/stale owner-document condition to the same
/// public refusal: the receipt is an opaque capability, and this boundary must
/// not reveal which profile, credential, environment, or keyring state changed.
fn native_request_binding_stale() -> NativeCommandError {
    NativeCommandError::new(
        "request_binding_stale",
        "the native request authorization is no longer active",
    )
}

fn scoped_profile_for_origin(
    app: &AppHandle,
    authority: &NativeProfileAuthority,
    expected_binding_id: &str,
    origin: &str,
) -> Result<NativeCredentialReference, NativeCommandError> {
    if uuid::Uuid::parse_str(expected_binding_id).is_err() {
        return Err(native_request_binding_stale());
    }
    let state = authority
        .0
        .lock()
        .map_err(|_| native_request_binding_stale())?;
    let store = read_station_profile_contents(app)
        .and_then(|contents| parse_station_profile_store(&contents))
        .map_err(|_| native_request_binding_stale())?;
    scoped_profile_for_origin_in_store(&state, &store, expected_binding_id, origin)
}

fn scoped_profile_for_origin_in_store(
    state: &NativeProfileAuthorityState,
    store: &CredentialProfileStore,
    expected_binding_id: &str,
    origin: &str,
) -> Result<NativeCredentialReference, NativeCommandError> {
    if uuid::Uuid::parse_str(expected_binding_id).is_err() {
        return Err(native_request_binding_stale());
    }
    let selected = state
        .active
        .clone()
        .filter(|selected| selected.binding_id == expected_binding_id)
        .ok_or_else(native_request_binding_stale)?;
    profile_bindings_are_authorized(state, store).map_err(|_| native_request_binding_stale())?;
    let profile = selected_profile_from_store(store, &selected.name)
        .map_err(|_| native_request_binding_stale())?;
    if profile.credential_ref.as_ref() != Some(&selected.reference) {
        return Err(native_request_binding_stale());
    }
    let key = credential_reference_key(&selected.reference)
        .map_err(|_| native_request_binding_stale())?;
    let binding = state
        .bindings
        .get(&key)
        .ok_or_else(native_request_binding_stale)?;
    if state.transitioning.contains(&key)
        || profile.configuration_state != "configured"
        || binding.exact_origin != origin
        || profile_credential_binding(profile).map_err(|_| native_request_binding_stale())?
            != *binding
    {
        return Err(native_request_binding_stale());
    }
    Ok(selected.reference)
}

fn native_http_profile_for_origin(
    app: &AppHandle,
    authority: &NativeProfileAuthority,
    expected_binding_id: Option<&str>,
    origin: &str,
) -> Result<NativeCredentialReference, NativeCommandError> {
    match expected_binding_id {
        Some(binding_id) => scoped_profile_for_origin(app, authority, binding_id, origin),
        None => authorized_profile_for_origin(app, authority, origin),
    }
}

fn revalidate_native_http_profile(
    app: &AppHandle,
    authority: &NativeProfileAuthority,
    expected_binding_id: Option<&str>,
    origin: &str,
    captured_reference: &NativeCredentialReference,
) -> Result<(), NativeCommandError> {
    if expected_binding_id.is_none() {
        return Ok(());
    }
    let current = native_http_profile_for_origin(app, authority, expected_binding_id, origin)?;
    if current != *captured_reference {
        return Err(native_request_binding_stale());
    }
    Ok(())
}

fn native_header_allowlisted(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "accept"
            | "content-type"
            | "last-event-id"
            | "x-request-id"
            // `CLIENT_ORIGIN_HEADER` in `packages/contracts/src/client-origin.ts`.
            // This client-reported provenance is display-only on the server;
            // native still owns the bearer and refuses every authority-bearing
            // renderer header below.
            | "x-station-client-origin"
            | "x-station-client-session"
            | "x-station-plugin"
            | "x-abort-reason"
    )
}

fn native_response_headers(
    headers: &ureq::http::HeaderMap,
) -> std::collections::HashMap<String, String> {
    headers
        .iter()
        .filter_map(|(name, value)| {
            let name = name.as_str().to_ascii_lowercase();
            matches!(
                name.as_str(),
                "content-type"
                    | "cache-control"
                    | "etag"
                    | "last-modified"
                    | "retry-after"
                    | "x-request-id"
            )
            .then(|| value.to_str().ok().map(|value| (name, value.to_string())))
            .flatten()
        })
        .collect()
}

fn native_response_is_open_stream(headers: &ureq::http::HeaderMap) -> bool {
    headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            value.split(';').next().is_some_and(|media_type| {
                media_type.trim().eq_ignore_ascii_case("text/event-stream")
            })
        })
}

/// Admission for a native authenticated request.
///
/// station#2282: the per-origin allowance is split by class. Station's own
/// long-lived event streams — server, scheduler, monitoring, orchestration,
/// session — used to draw on the same budget as ordinary reads and could fill
/// it by themselves, after which a healthy authorized Station looked
/// intermittently unreachable and `/api/plugins` could lose the startup race
/// and leave a non-dismissible `Extensions unavailable` banner.
///
/// station#2795: an ordinary cold-start burst can also fill its own allowance.
/// Ordinary reads therefore wait in one bounded FIFO instead of surfacing a
/// scheduling decision as a transport failure. Streams retain immediate
/// refusal because they are long-lived; active global and per-class limits
/// remain unchanged.
fn admit_native_http_request(
    active: &mut std::collections::HashMap<String, NativeActiveHttpRequest>,
    request_id: &str,
    origin: &str,
    is_stream: bool,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), String> {
    let per_origin_limit = if is_stream {
        NATIVE_HTTP_PER_ORIGIN_STREAM_LIMIT
    } else {
        NATIVE_HTTP_PER_ORIGIN_REQUEST_LIMIT
    };
    let same_class_for_origin = active
        .values()
        .filter(|active_request| {
            active_request.origin == origin && active_request.stream == is_stream
        })
        .count();
    if active.contains_key(request_id)
        || active.len() >= NATIVE_HTTP_GLOBAL_REQUEST_LIMIT
        || same_class_for_origin >= per_origin_limit
    {
        return Err("native Station request capacity reached".to_string());
    }
    active.insert(
        request_id.to_string(),
        NativeActiveHttpRequest {
            cancel,
            origin: origin.to_string(),
            stream: is_stream,
        },
    );
    Ok(())
}

fn native_http_request_has_capacity(
    active: &std::collections::HashMap<String, NativeActiveHttpRequest>,
    origin: &str,
) -> bool {
    active.len() < NATIVE_HTTP_GLOBAL_REQUEST_LIMIT
        && active
            .values()
            .filter(|request| request.origin == origin && !request.stream)
            .count()
            < NATIVE_HTTP_PER_ORIGIN_REQUEST_LIMIT
}

/// Admission happens before a response channel exists, so capacity refusals
/// cross the invoke boundary as a `NativeCommandError`, not a bare string.
fn native_http_capacity_refusal(message: String) -> NativeCommandError {
    NativeCommandError::new("transport_capacity", message)
}

/// Reserve a request slot before opening the response channel. This small seam
/// keeps the invoke-boundary error coding testable without needing a Tauri app
/// handle or OS credential setup.
fn reserve_native_http_request(
    cancellations: &NativeHttpCancellation,
    request_id: &str,
    origin: &str,
    is_stream_request: bool,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<(), NativeCommandError> {
    use std::sync::atomic::Ordering;

    let (state_lock, changed) = &*cancellations.0;
    let mut state = state_lock
        .lock()
        .map_err(|_| "native request cancellation state unavailable".to_string())?;
    if state.active.contains_key(request_id)
        || state
            .pending_reads
            .iter()
            .any(|pending| pending.request_id == request_id)
    {
        return Err(native_http_capacity_refusal(
            "native Station request capacity reached".to_string(),
        ));
    }
    if is_stream_request {
        return admit_native_http_request(&mut state.active, request_id, origin, true, cancel)
            .map_err(native_http_capacity_refusal);
    }

    if state.pending_reads.len() >= NATIVE_HTTP_PENDING_READ_LIMIT {
        return Err(native_http_capacity_refusal(
            "native Station request queue capacity reached".to_string(),
        ));
    }

    state.pending_reads.push_back(NativePendingHttpRequest {
        request_id: request_id.to_string(),
        origin: origin.to_string(),
        cancel: std::sync::Arc::clone(&cancel),
    });
    loop {
        if cancel.load(Ordering::SeqCst) {
            state
                .pending_reads
                .retain(|pending| pending.request_id != request_id);
            changed.notify_all();
            return Err(NativeCommandError::new(
                "cancelled",
                "native Station request was cancelled while waiting for capacity",
            ));
        }
        let is_front = state
            .pending_reads
            .front()
            .is_some_and(|pending| pending.request_id == request_id);
        if is_front && native_http_request_has_capacity(&state.active, origin) {
            let pending = state
                .pending_reads
                .pop_front()
                .expect("front request remains queued until admission");
            state.active.insert(
                request_id.to_string(),
                NativeActiveHttpRequest {
                    cancel: pending.cancel,
                    origin: pending.origin,
                    stream: false,
                },
            );
            changed.notify_all();
            return Ok(());
        }
        state = changed
            .wait(state)
            .map_err(|_| "native request cancellation state unavailable".to_string())?;
    }
}

fn release_native_http_request(
    cancellations: &NativeHttpCancellation,
    request_id: &str,
) -> Result<(), String> {
    let (state_lock, changed) = &*cancellations.0;
    state_lock
        .lock()
        .map_err(|_| "native request cancellation state unavailable".to_string())?
        .active
        .remove(request_id);
    changed.notify_all();
    Ok(())
}

fn cancel_native_http_request(
    cancellations: &NativeHttpCancellation,
    request_id: &str,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    let (state_lock, changed) = &*cancellations.0;
    let state = state_lock
        .lock()
        .map_err(|_| "native request cancellation state unavailable".to_string())?;
    if let Some(active) = state.active.get(request_id) {
        active.cancel.store(true, Ordering::SeqCst);
    } else if let Some(pending) = state
        .pending_reads
        .iter()
        .find(|pending| pending.request_id == request_id)
    {
        pending.cancel.store(true, Ordering::SeqCst);
    }
    changed.notify_all();
    Ok(())
}

pub(crate) fn native_http_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .max_redirects(0)
        // SSE bodies are intentionally open-ended. Bound connection and
        // response-header phases only; cancellation is checked between
        // bounded body receives below.
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_recv_response(Some(Duration::from_secs(20)))
        .timeout_recv_body(Some(Duration::from_secs(1)))
        .http_status_as_error(false)
        .build()
        .into()
}

fn native_request_transport_detail(error: &ureq::Error) -> NativeHttpTransportDetail {
    use std::io::ErrorKind;
    match error {
        ureq::Error::HostNotFound => NativeHttpTransportDetail {
            code: "transport_dns",
            detail: "Station host could not be resolved.".to_string(),
        },
        ureq::Error::Timeout(_) => NativeHttpTransportDetail {
            code: "transport_timeout",
            detail: "Station request timed out before response headers arrived.".to_string(),
        },
        ureq::Error::Tls(_) => NativeHttpTransportDetail {
            code: "transport_tls",
            detail: format!("TLS connection to Station failed: {error}"),
        },
        ureq::Error::Io(error) => match error.kind() {
            ErrorKind::ConnectionRefused => NativeHttpTransportDetail {
                code: "transport_refused",
                detail: "Station refused the connection.".to_string(),
            },
            ErrorKind::ConnectionReset => NativeHttpTransportDetail {
                code: "transport_reset",
                detail: "Connection to Station was reset before a response arrived.".to_string(),
            },
            ErrorKind::HostUnreachable
            | ErrorKind::NetworkUnreachable
            | ErrorKind::NotConnected => NativeHttpTransportDetail {
                code: "transport_unreachable",
                detail: "Station is unreachable on the current network.".to_string(),
            },
            ErrorKind::TimedOut => NativeHttpTransportDetail {
                code: "transport_timeout",
                detail: "Connection to Station timed out.".to_string(),
            },
            _ => NativeHttpTransportDetail {
                code: "transport",
                detail: format!("Station request failed: {error}"),
            },
        },
        _ => NativeHttpTransportDetail {
            code: "transport",
            detail: format!("Station request failed: {error}"),
        },
    }
}

fn native_response_transport_detail(error: &std::io::Error) -> NativeHttpTransportDetail {
    use std::io::ErrorKind;
    match error.kind() {
        ErrorKind::ConnectionReset => NativeHttpTransportDetail {
            code: "transport_reset",
            detail: "Connection to Station was reset while receiving the response.".to_string(),
        },
        ErrorKind::UnexpectedEof | ErrorKind::BrokenPipe => NativeHttpTransportDetail {
            code: "transport_reset",
            detail: "Connection to Station ended before the response finished.".to_string(),
        },
        ErrorKind::HostUnreachable | ErrorKind::NetworkUnreachable | ErrorKind::NotConnected => {
            NativeHttpTransportDetail {
                code: "transport_unreachable",
                detail: "Station became unreachable while receiving the response.".to_string(),
            }
        }
        _ => NativeHttpTransportDetail {
            code: "transport",
            detail: format!("Station response stream failed: {error}"),
        },
    }
}

/// The authenticated request path is intentionally narrow: no caller selected
/// keyring account, no ambient cookie jar, no renderer Authorization header,
/// no redirect following, and no cross-origin retry.
fn station_native_http_request_blocking(
    app: AppHandle,
    authority: NativeProfileAuthority,
    cancellations: NativeHttpCancellation,
    request: NativeHttpRequest,
    channel: Channel<NativeHttpMessage>,
) -> Result<(), NativeCommandError> {
    use std::io::Read;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    if request.request_id.is_empty()
        || request.request_id.len() > 128
        || request.url.len() > 8192
        || request.headers.len() > 32
        || request
            .body
            .as_ref()
            .is_some_and(|body| body.len() > NATIVE_HTTP_BODY_LIMIT)
    {
        return Err("invalid native Station request".to_string().into());
    }
    let method = request.method.to_ascii_uppercase();
    if !matches!(
        method.as_str(),
        "GET" | "HEAD" | "OPTIONS" | "POST" | "PUT" | "PATCH" | "DELETE"
    ) {
        return Err("native Station method is not allowed".to_string().into());
    }
    let origin = exact_origin(&request.url).map_err(NativeCommandError::from)?;
    // `exact_origin` proved the URL parses; re-parse for the path refusal.
    let parsed_url =
        url::Url::parse(&request.url).map_err(|_| "invalid Station request URL".to_string())?;
    if is_webview_forbidden_native_path(&parsed_url) {
        return Err(NativeCommandError::new(
            "webview_forbidden_path",
            "the consent broker cannot be driven from the webview",
        ));
    }
    let parsed_method = method
        .parse::<ureq::http::Method>()
        .map_err(|_| "native Station method is not allowed".to_string())?;
    let request_id = request.request_id.clone();
    let expected_binding_id = request.expected_binding_id.clone();
    let expected_binding_id = expected_binding_id.as_deref();
    // The response does not exist yet, so the class comes from what the caller
    // asked for. An SSE consumer sends `Accept: text/event-stream`.
    let is_stream_request = request.headers.iter().any(|(name, value)| {
        name.eq_ignore_ascii_case("accept")
            && value.split(',').any(|media| {
                media.split(';').next().is_some_and(|media_type| {
                    media_type.trim().eq_ignore_ascii_case("text/event-stream")
                })
            })
    });
    for (name, value) in &request.headers {
        if name.len() > 128
            || value.len() > 8192
            || name.eq_ignore_ascii_case("authorization")
            || name.eq_ignore_ascii_case("cookie")
        {
            return Err("native Station request contains a forbidden header"
                .to_string()
                .into());
        }
        if !native_header_allowlisted(name) {
            return Err("native Station request header is not allowed"
                .to_string()
                .into());
        }
    }
    // Preserve the ordinary relay's ambient active-profile behavior. Basis is
    // the only scoped caller: it supplies a receipt and is resolved only after
    // admission below.
    let unscoped_authorization = if expected_binding_id.is_none() {
        let reference = authorized_profile_for_origin(&app, &authority, &origin)?;
        let credential = credential_entry(&reference)
            .map_err(NativeCommandError::from)?
            .get_password()
            .map_err(|error| {
                if is_missing_credential(&error) {
                    NativeCommandError::new("credential_missing", "credential_missing")
                } else {
                    NativeCommandError::new(
                        "credential_store_unreadable",
                        format!("read OS credential store: {error}"),
                    )
                }
            })?;
        Some((reference, credential))
    } else {
        None
    };
    let cancel = Arc::new(AtomicBool::new(false));
    reserve_native_http_request(
        &cancellations,
        &request_id,
        &origin,
        is_stream_request,
        Arc::clone(&cancel),
    )?;
    let result = (|| -> Result<(), NativeHttpBrokerFailure> {
        // Scoped callers enter the capacity queue before we resolve their
        // receipt. That makes an A -> B switch while queued fail closed rather
        // than reading B's active credential after the wait.
        let (reference, credential) = match unscoped_authorization {
            Some(authorization) => authorization,
            None => {
                let reference =
                    native_http_profile_for_origin(&app, &authority, expected_binding_id, &origin)
                        .map_err(|error| NativeHttpBrokerFailure::coded(error.code))?;
                let credential = credential_entry(&reference)
                    .map_err(|_| NativeHttpBrokerFailure::coded("request_binding_stale"))?
                    .get_password()
                    // Do not disclose whether a stale receipt's old keyring
                    // account still exists or is readable.
                    .map_err(|_| NativeHttpBrokerFailure::coded("request_binding_stale"))?;
                (reference, credential)
            }
        };
        let mut builder = ureq::http::Request::builder()
            .method(parsed_method)
            .uri(&request.url)
            .header("Authorization", format!("Bearer {credential}"));
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        let request = builder
            .body(request.body.unwrap_or_default())
            .map_err(|_| NativeHttpBrokerFailure::coded("request_binding_stale"))?;
        // The keyring read is deliberately outside the authority lock. Check
        // the same captured receipt immediately before issuing bytes; this
        // must never select a replacement active profile.
        revalidate_native_http_profile(&app, &authority, expected_binding_id, &origin, &reference)
            .map_err(|error| NativeHttpBrokerFailure::coded(error.code))?;
        let agent = native_http_agent();
        let mut response = agent.run(request).map_err(|error| {
            NativeHttpBrokerFailure::transport(native_request_transport_detail(&error))
        })?;
        revalidate_native_http_profile(&app, &authority, expected_binding_id, &origin, &reference)
            .map_err(|error| NativeHttpBrokerFailure::coded(error.code))?;
        let open_stream = native_response_is_open_stream(response.headers());
        let status = response.status().as_u16();
        channel
            .send(NativeHttpMessage::Response {
                status,
                headers: native_response_headers(response.headers()),
                // Chunked, close-delimited, and transparently decompressed
                // responses do not have an exact wire length. Preserve a
                // declared ordinary body length so the WebView can reject a
                // clean-looking EOF that actually truncated JSON (#2265).
                body_length: response.body().content_length(),
            })
            .map_err(|_| NativeHttpBrokerFailure::coded("cancelled"))?;
        let mut reader = response.body_mut().as_reader();
        let mut buffer = [0_u8; 16 * 1024];
        let mut total = 0_usize;
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(NativeHttpBrokerFailure::coded("cancelled"));
            }
            let read = match reader.read(&mut buffer) {
                Ok(read) => read,
                // A short body receive timeout gives cancellation a bounded
                // rendezvous without imposing a lifetime on an SSE stream.
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                    ) =>
                {
                    continue
                }
                Err(error) => {
                    return Err(NativeHttpBrokerFailure::transport(
                        native_response_transport_detail(&error),
                    ))
                }
            };
            if read == 0 {
                break;
            }
            total += read;
            if !open_stream && total > 64 * 1024 * 1024 {
                return Err(NativeHttpBrokerFailure::coded("response_too_large"));
            }
            revalidate_native_http_profile(
                &app,
                &authority,
                expected_binding_id,
                &origin,
                &reference,
            )
            .map_err(|error| NativeHttpBrokerFailure::coded(error.code))?;
            channel
                .send(NativeHttpMessage::Chunk {
                    bytes: buffer[..read].to_vec(),
                })
                .map_err(|_| NativeHttpBrokerFailure::coded("cancelled"))?;
        }
        revalidate_native_http_profile(&app, &authority, expected_binding_id, &origin, &reference)
            .map_err(|error| NativeHttpBrokerFailure::coded(error.code))?;
        channel
            .send(NativeHttpMessage::End)
            .map_err(|_| NativeHttpBrokerFailure::coded("cancelled"))?;
        Ok(())
    })();
    release_native_http_request(&cancellations, &request_id)?;
    if let Err(failure) = result {
        let _ = channel.send(NativeHttpMessage::Error {
            code: failure.code,
            detail: failure.detail,
        });
    }
    Ok(())
}

#[tauri::command]
async fn station_native_http_request(
    app: AppHandle,
    authority: State<'_, NativeProfileAuthority>,
    cancellations: State<'_, NativeHttpCancellation>,
    request: NativeHttpRequest,
    channel: Channel<NativeHttpMessage>,
) -> Result<(), NativeCommandError> {
    let authority = authority.inner().clone();
    let cancellations = cancellations.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        station_native_http_request_blocking(app, authority, cancellations, request, channel)
    })
    .await
    .map_err(|error| {
        NativeCommandError::from(format!("native Station request task failed: {error}"))
    })?
}

// ── Native consent broker (station#3677 PR 3) ──────────────────────────────
//
// The one place a consent transaction can be decided from the desktop/mobile
// app. The server half (`/api/consent/requests/:id/native-review|decide`)
// admits only a LOCAL-GRANT-minted credential — the per-boot owner-secret
// mint that lives in this process's OS keyring and never crosses into the
// webview — and the webview relay refuses to ferry this path family at all
// (`is_webview_forbidden_native_path`). So webview JS (plugin code included)
// can neither call the server routes with the app's authority nor script the
// approval surface: the dialog below is native OS chrome. The decision is
// committed SERVER-SIDE; this command returns only the settled status.

/// One native consent dialog at a time, per app process (station#3677 PR 3,
/// review round 1). The command is registered on the main window's invoke
/// handler, so any JavaScript running in THAT frame can call it — today
/// that is Station's own bundle: plugin UI loads cross-origin in a sandboxed
/// iframe (`PluginFrameHost` points it at the Station server origin while
/// the shell is served from the Tauri custom protocol), and no remote-domain
/// IPC access is configured, so plugin code has no invoke bridge. What this
/// guard buys is that even a caller that CAN invoke cannot stack dialogs,
/// churn the render nonce, or drain the transaction's render budget: a
/// second concurrent review is refused before it touches the server.
///
/// It does not — and cannot — make the dialog unreachable from main-frame
/// script. The honest claim is narrower than "the webview cannot drive the
/// broker": approval always requires the user to click Approve in OS chrome
/// that no page can draw over or script, and the server commits the
/// decision itself.
/// The lease is held ACROSS the dialog's blocking show, which has no
/// timeout of its own, so RAII alone cannot recover from a dialog backend
/// that never returns and never unwinds (review round 2). It therefore also
/// expires: a lease older than this is taken over, bounding a wedged dialog
/// to an inconvenience rather than consent being denied until the app is
/// restarted. Long enough that a person reading a real approval is never
/// interrupted.
const NATIVE_CONSENT_DIALOG_MAX_AGE: Duration = Duration::from_secs(600);

static NATIVE_CONSENT_DIALOG_LEASE: std::sync::Mutex<Option<(u64, std::time::Instant)>> =
    std::sync::Mutex::new(None);
static NATIVE_CONSENT_DIALOG_GENERATION: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

struct NativeConsentDialogLease {
    generation: u64,
}

impl NativeConsentDialogLease {
    /// `None` while another review is genuinely in flight. A lease older
    /// than `max_age` is treated as abandoned and taken over.
    fn acquire(max_age: Duration) -> Option<Self> {
        let mut held = NATIVE_CONSENT_DIALOG_LEASE.lock().ok()?;
        if let Some((_, taken_at)) = *held {
            if taken_at.elapsed() < max_age {
                return None;
            }
        }
        let generation =
            NATIVE_CONSENT_DIALOG_GENERATION.fetch_add(1, std::sync::atomic::Ordering::AcqRel) + 1;
        *held = Some((generation, std::time::Instant::now()));
        Some(Self { generation })
    }
}

impl Drop for NativeConsentDialogLease {
    fn drop(&mut self) {
        // Released on every exit path — refusal, transport error, panic.
        // The generation check matters after a takeover: a late-returning
        // abandoned review must not clear the lease its successor now holds.
        if let Ok(mut held) = NATIVE_CONSENT_DIALOG_LEASE.lock() {
            if held.is_some_and(|(generation, _)| generation == self.generation) {
                *held = None;
            }
        }
    }
}

/// A consent transaction id is a server-minted UUID; refuse anything that
/// could not be one before it is embedded in a URL path.
fn is_valid_consent_request_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConsentDescriptionItemWire {
    label: String,
    detail: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConsentDescriptionWire {
    title: String,
    summary: String,
    #[serde(default)]
    items: Vec<ConsentDescriptionItemWire>,
    #[serde(default)]
    warning: Option<String>,
    approve_label: String,
    deny_label: String,
}

#[derive(Deserialize)]
struct ConsentNativeReviewWire {
    description: ConsentDescriptionWire,
    nonce: String,
}

#[derive(Deserialize)]
struct ConsentNativeReviewEnvelope {
    review: ConsentNativeReviewWire,
}

#[derive(Deserialize)]
struct ConsentNativeDecideWire {
    status: String,
}

#[derive(Deserialize)]
struct ConsentNativeDecideEnvelope {
    request: ConsentNativeDecideWire,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeConsentOutcome {
    status: String,
}

/// The dialog body is assembled from the SAME server-authored
/// `ConsentDescription` the browser review page renders — one description,
/// two presentation surfaces. Nothing caller-supplied reaches this text.
fn consent_dialog_body(description: &ConsentDescriptionWire) -> String {
    let mut body = description.summary.clone();
    for item in &description.items {
        body.push_str("\n\n");
        body.push_str(&item.label);
        body.push_str(": ");
        body.push_str(&item.detail);
    }
    if let Some(warning) = &description.warning {
        body.push_str("\n\n");
        body.push_str(warning);
    }
    body
}

fn consent_broker_error(body: &str, fallback: &str) -> NativeCommandError {
    let detail = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| error.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| fallback.to_string());
    NativeCommandError::new("consent_broker_refused", detail)
}

fn consent_broker_post(
    agent: &ureq::Agent,
    url: &str,
    credential: &str,
    body: Option<String>,
) -> Result<(u16, String), NativeCommandError> {
    let request = agent
        .post(url)
        .header("Authorization", format!("Bearer {credential}"))
        .header("Content-Type", "application/json");
    let mut response = request.send(body.unwrap_or_default()).map_err(|error| {
        NativeCommandError::from(native_request_transport_detail(&error).detail)
    })?;
    let status = response.status().as_u16();
    let text = response.body_mut().read_to_string().map_err(|_| {
        NativeCommandError::from("consent broker response was unreadable".to_string())
    })?;
    Ok((status, text))
}

fn station_native_consent_review_blocking(
    app: AppHandle,
    authority: NativeProfileAuthority,
    request_id: String,
) -> Result<NativeConsentOutcome, NativeCommandError> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
    if !is_valid_consent_request_id(&request_id) {
        return Err("invalid consent request id".to_string().into());
    }
    let _lease =
        NativeConsentDialogLease::acquire(NATIVE_CONSENT_DIALOG_MAX_AGE).ok_or_else(|| {
            NativeCommandError::new(
                "consent_review_in_progress",
                "another approval is already open; finish it first",
            )
        })?;
    // The app's OWN authorized origin — never a caller-supplied URL. The same
    // authorization chain as the relay resolves the credential for it.
    let origin = {
        let state = authority
            .0
            .lock()
            .map_err(|_| "Station native authority is unavailable".to_string())?;
        let selected = state.active.clone().ok_or_else(|| {
            NativeCommandError::new(
                "no_active_profile",
                "Station has no host-authorized active Station",
            )
        })?;
        let key = credential_reference_key(&selected.reference)?;
        state
            .bindings
            .get(&key)
            .ok_or_else(|| {
                NativeCommandError::new(
                    "credential_not_observed",
                    "Station active credential was not observed by the native host",
                )
            })?
            .exact_origin
            .clone()
    };
    let credential = credential_entry(&authorized_profile_for_origin(&app, &authority, &origin)?)
        .map_err(NativeCommandError::from)?
        .get_password()
        .map_err(|error| {
            if is_missing_credential(&error) {
                NativeCommandError::new("credential_missing", "credential_missing")
            } else {
                NativeCommandError::new(
                    "credential_store_unreadable",
                    format!("read OS credential store: {error}"),
                )
            }
        })?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .max_redirects(0)
        .timeout_global(Some(std::time::Duration::from_secs(20)))
        .http_status_as_error(false)
        .build()
        .into();
    let review_url = format!("{origin}/api/consent/requests/{request_id}/native-review");
    let (status, body) = consent_broker_post(&agent, &review_url, &credential, None)?;
    if status != 200 {
        return Err(consent_broker_error(
            &body,
            "the approval could not be reviewed",
        ));
    }
    let review = serde_json::from_str::<ConsentNativeReviewEnvelope>(&body)
        .map_err(|_| "unexpected consent review response".to_string())?
        .review;

    // Native OS dialog — chrome the webview cannot draw over or script. A
    // dismissal (Esc / close) maps to the deny button, which commits nothing
    // and settles the transaction denied: any non-approval is a refusal.
    let approved = app
        .dialog()
        .message(consent_dialog_body(&review.description))
        .title(&review.description.title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            review.description.approve_label.clone(),
            review.description.deny_label.clone(),
        ))
        .blocking_show();

    let decide_url = format!("{origin}/api/consent/requests/{request_id}/native-decide");
    let decide_body = serde_json::json!({
        "decision": if approved { "approve" } else { "deny" },
        "nonce": review.nonce,
    });
    let (status, body) = consent_broker_post(
        &agent,
        &decide_url,
        &credential,
        Some(
            serde_json::to_string(&decide_body)
                .map_err(|_| "invalid consent decision".to_string())?,
        ),
    )?;
    if status != 200 {
        return Err(consent_broker_error(
            &body,
            "the approval could not be decided",
        ));
    }
    let decided = serde_json::from_str::<ConsentNativeDecideEnvelope>(&body)
        .map_err(|_| "unexpected consent decision response".to_string())?
        .request;
    Ok(NativeConsentOutcome {
        status: decided.status,
    })
}

#[tauri::command]
async fn station_native_consent_review(
    app: AppHandle,
    authority: State<'_, NativeProfileAuthority>,
    request_id: String,
) -> Result<NativeConsentOutcome, NativeCommandError> {
    let authority = authority.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        station_native_consent_review_blocking(app, authority, request_id)
    })
    .await
    .map_err(|error| {
        NativeCommandError::from(format!("native consent review task failed: {error}"))
    })?
}

#[tauri::command]
fn station_native_http_cancel(
    cancellations: State<'_, NativeHttpCancellation>,
    request_id: String,
) -> Result<(), String> {
    cancel_native_http_request(cancellations.inner(), &request_id)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativePairingExchangeRequest {
    endpoint: String,
    offer_id: String,
    proof: String,
    request_id: String,
    client_instance_id: String,
    operation_id: String,
    #[serde(default)]
    browser_session: bool,
}

/// station#1818 R3 (owner scope-growth): every code minted below is chosen
/// to REUSE the vocabulary the public HTTP pairing path already establishes
/// in `src-server/services/ssh/device-pairing-service.ts` /
/// `packages/connect/src/core/devicePairing.ts` (`network_unreachable`,
/// `invalid_request`, `cancelled`) wherever the native failure is the same
/// logical event, so `JoinDevicePairingPanel` can branch on `.code` the same
/// way regardless of which transport delivered it. Where the native bridge
/// has a failure the HTTP path has no equivalent for at all — a locally
/// malformed request/endpoint before any network call, a malformed or
/// oversized response body, a rejected scheme, or a local resource limit —
/// it gets a distinct code (`invalid_endpoint`, `insecure_endpoint`,
/// `invalid_response`, `operation_in_progress`, `capacity_reached`) rather
/// than being forced into a misleading reuse. (station#1818 review round 1,
/// LOW: `insecure_endpoint` was minted below but missing from this list —
/// corrected.)
fn validate_native_pairing_exchange_request(
    request: &NativePairingExchangeRequest,
) -> Result<String, NativeCommandError> {
    if request.browser_session
        || request.offer_id.len() > 512
        || request.proof.len() > 4096
        || request.request_id.len() > 512
        || request.client_instance_id.len() > 128
        || request.operation_id.is_empty()
        || request.operation_id.len() > 128
    {
        return Err(NativeCommandError::new(
            "invalid_request",
            "invalid native pairing exchange",
        ));
    }
    let origin = exact_origin(&request.endpoint).map_err(NativeCommandError::from)?;
    if !credential_endpoint_uses_secure_transport(&origin) {
        return Err(NativeCommandError::new(
            "insecure_endpoint",
            "Station pairing endpoints must use HTTPS or strict loopback HTTP",
        ));
    }
    Ok(origin)
}

fn reserve_native_pairing_exchange(
    cancellations: &NativePairingExchangeCancellation,
    operation_id: &str,
    origin: &str,
) -> Result<std::sync::Arc<std::sync::atomic::AtomicBool>, NativeCommandError> {
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    let mut active = cancellations
        .0
        .lock()
        .map_err(|_| "native pairing exchange cancellation state unavailable".to_string())?;
    if active.contains_key(operation_id) {
        return Err(NativeCommandError::new(
            "operation_in_progress",
            "native pairing exchange operation is already in flight",
        ));
    }
    if active.len() >= NATIVE_PAIRING_EXCHANGE_GLOBAL_REQUEST_LIMIT
        || active
            .values()
            .filter(|active_exchange| active_exchange.origin == origin)
            .count()
            >= NATIVE_PAIRING_EXCHANGE_PER_ORIGIN_REQUEST_LIMIT
    {
        return Err(NativeCommandError::new(
            "capacity_reached",
            "native pairing exchange capacity reached",
        ));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    active.insert(
        operation_id.to_string(),
        NativeActivePairingExchange {
            cancel: Arc::clone(&cancel),
            origin: origin.to_string(),
        },
    );
    Ok(cancel)
}

fn release_native_pairing_exchange(
    cancellations: &NativePairingExchangeCancellation,
    operation_id: &str,
) {
    if let Ok(mut active) = cancellations.0.lock() {
        active.remove(operation_id);
    }
}

fn native_pairing_device_response(
    device: NativePairingPublicDevice,
) -> Result<NativePairingPublicDeviceResponse, String> {
    if device.id.is_empty()
        || device.id.len() > 512
        || device.name.is_empty()
        || device.name.len() > 512
        || device.scope.is_empty()
        || device.scope.len() > 1024
        || !matches!(device.kind.as_str(), "device" | "delegation")
        || !device.created_at.is_finite()
        || device.last_used_at.is_some_and(|value| !value.is_finite())
        || device.revoked_at.is_some_and(|value| !value.is_finite())
    {
        return Err("invalid native pairing response".to_string());
    }
    Ok(NativePairingPublicDeviceResponse {
        id: device.id,
        name: device.name,
        scope: device.scope,
        kind: device.kind,
        created_at: device.created_at,
        last_used_at: device.last_used_at,
        revoked_at: device.revoked_at,
    })
}

/// The `{"error": "<code>"}` body every pairing route (public exchange,
/// local-grant) answers with on a non-2xx. Shared so a Rust-originated
/// failure and a proxied server failure read identically to callers.
fn pairing_error_code(raw: &str) -> String {
    serde_json::from_str::<NativePairingExchangeError>(raw)
        .ok()
        .map(|body| body.error)
        .filter(|code| {
            !code.is_empty()
                && code.len() <= 128
                && code.chars().all(|character| {
                    character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
                })
        })
        .unwrap_or_else(|| "pairing_exchange_failed".to_string())
}

fn sanitized_pairing_error(status: u16, raw: &str) -> NativePairingExchangeResult {
    let error = pairing_error_code(raw);
    NativePairingExchangeResult::Failure(NativePairingExchangeFailure {
        ok: false,
        status,
        error,
    })
}

/// Captures the only bearer-bearing public pairing response before it crosses
/// IPC. The returned handle is opaque, one-use, and is bound to a fresh
/// host-allocated credential reference, exact origin, and environment.
fn station_native_pairing_exchange_blocking(
    pending: NativePendingPairingCredentials,
    request: NativePairingExchangeRequest,
    origin: String,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<NativePairingExchangeResult, NativeCommandError> {
    let client_instance_id = request.client_instance_id.clone();
    let endpoint = url::Url::parse(&origin)
        .map_err(|_| {
            NativeCommandError::new("invalid_endpoint", "invalid native pairing endpoint")
        })?
        .join("/.well-known/station/v1/pairing/exchange")
        .map_err(|_| {
            NativeCommandError::new("invalid_endpoint", "invalid native pairing endpoint")
        })?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .max_redirects(0)
        .timeout_global(Some(Duration::from_secs(20)))
        // A short receive timeout provides cancellation rendezvous while the
        // overall 20-second pairing timeout remains unchanged.
        .timeout_recv_body(Some(Duration::from_secs(1)))
        .http_status_as_error(false)
        .build()
        .into();
    let request_body = serde_json::json!({
        "offerId": request.offer_id,
        "proof": request.proof,
        "requestId": request.request_id,
        "clientInstanceId": request.client_instance_id,
    });
    if cancel.load(std::sync::atomic::Ordering::SeqCst) {
        return Err(NativeCommandError::new("cancelled", "cancelled"));
    }
    let mut response = agent
        .post(endpoint.as_str())
        .header("Content-Type", "application/json")
        .send(
            serde_json::to_string(&request_body)
                .map_err(|_| "invalid native pairing exchange".to_string())?,
        )
        // Reuses the HTTP pairing path's own code for "the request never
        // reached the Station" (`pairingFetch`'s `network_unreachable` in
        // `packages/connect/src/core/devicePairing.ts`) — the same logical
        // failure, so callers branch on one code regardless of transport.
        .map_err(|_| NativeCommandError::new("network_unreachable", "transport"))?;
    let status = response.status().as_u16();
    let mut reader = response.body_mut().as_reader();
    let mut raw_bytes = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        if cancel.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(NativeCommandError::new("cancelled", "cancelled"));
        }
        let read = match reader.read(&mut buffer) {
            Ok(read) => read,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                continue
            }
            Err(_) => return Err(NativeCommandError::new("network_unreachable", "transport")),
        };
        if read == 0 {
            break;
        }
        if raw_bytes.len() + read > NATIVE_PAIRING_EXCHANGE_BODY_LIMIT {
            return Err(NativeCommandError::new(
                "invalid_response",
                "invalid native pairing response",
            ));
        }
        raw_bytes.extend_from_slice(&buffer[..read]);
    }
    let raw = String::from_utf8(raw_bytes).map_err(|_| {
        NativeCommandError::new("invalid_response", "invalid native pairing response")
    })?;
    if !(200..300).contains(&status) {
        return Ok(sanitized_pairing_error(status, &raw));
    }
    let response: NativePairingExchangeResponse = serde_json::from_str(&raw).map_err(|_| {
        NativeCommandError::new("invalid_response", "invalid native pairing response")
    })?;
    if response.environment_id.is_empty()
        || response.environment_id.len() > 512
        || response.credential.is_empty()
        || response.credential.len() > 16 * 1024
    {
        return Err(NativeCommandError::new(
            "invalid_response",
            "invalid native pairing response",
        ));
    }
    let device =
        native_pairing_device_response(response.device).map_err(NativeCommandError::from)?;
    let handle = uuid::Uuid::new_v4().to_string();
    let reference = NativeCredentialReference {
        kind: "station-bearer".to_string(),
        id: format!("pairing:{}", uuid::Uuid::new_v4()),
    };
    let mut pending = pending
        .0
        .lock()
        .map_err(|_| "native pairing credential state unavailable".to_string())?;
    let now = SystemTime::now();
    pending.retain(|_, entry| entry.expires_at > now);
    if pending.len() >= 128 {
        return Err(NativeCommandError::new(
            "capacity_reached",
            "native pairing credential capacity reached",
        ));
    }
    pending.insert(
        handle.clone(),
        PendingPairingCredential {
            credential: response.credential,
            reference: reference.clone(),
            exact_origin: origin,
            environment_id: response.environment_id.clone(),
            client_instance_id,
            expires_at: now + Duration::from_secs(120),
            phase: NativePairingPhase::AwaitingRequiresAuth,
        },
    );
    Ok(NativePairingExchangeResult::Success(
        NativePairingExchangeSuccess {
            ok: true,
            environment_id: response.environment_id,
            device,
            credential_handle: handle,
            credential_ref: reference,
        },
    ))
}

#[tauri::command]
async fn station_native_pairing_exchange(
    pending: State<'_, NativePendingPairingCredentials>,
    cancellations: State<'_, NativePairingExchangeCancellation>,
    request: NativePairingExchangeRequest,
) -> Result<NativePairingExchangeResult, NativeCommandError> {
    let pending = pending.inner().clone();
    let cancellations = cancellations.inner().clone();
    let origin = validate_native_pairing_exchange_request(&request)?;
    let operation_id = request.operation_id.clone();
    let cancel = reserve_native_pairing_exchange(&cancellations, &operation_id, &origin)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        station_native_pairing_exchange_blocking(pending, request, origin, cancel)
    })
    .await
    .map_err(|error| {
        NativeCommandError::from(format!("native pairing exchange task failed: {error}"))
    });
    release_native_pairing_exchange(&cancellations, &operation_id);
    result?
}

#[tauri::command]
fn station_native_pairing_exchange_cancel(
    cancellations: State<'_, NativePairingExchangeCancellation>,
    operation_id: String,
) -> Result<(), NativeCommandError> {
    if operation_id.is_empty() || operation_id.len() > 128 {
        return Err(NativeCommandError::new(
            "invalid_request",
            "invalid native pairing exchange operation",
        ));
    }
    if let Some(active) = cancellations
        .0
        .lock()
        .map_err(|_| "native pairing exchange cancellation state unavailable".to_string())?
        .get(&operation_id)
    {
        use std::sync::atomic::Ordering;
        active.cancel.store(true, Ordering::SeqCst);
    }
    Ok(())
}

fn pairing_profile_matches(
    store: &CredentialProfileStore,
    profile_name: &str,
    entry: &PendingPairingCredential,
    configuration_state: &str,
) -> Result<(), String> {
    let profile = selected_profile_from_store(store, profile_name)?;
    if profile.configuration_state != configuration_state
        || profile.credential_ref.as_ref() != Some(&entry.reference)
        || exact_origin(&profile.endpoint)? != entry.exact_origin
        || profile._environment_id.as_deref() != Some(&entry.environment_id)
        || profile.client_instance_id.as_deref() != Some(&entry.client_instance_id)
    {
        return Err("the pairing Station does not match its native authority handle".to_string());
    }
    Ok(())
}

fn pairing_requires_auth_profile_name(
    store: &CredentialProfileStore,
    entry: &PendingPairingCredential,
) -> Result<String, String> {
    let matches = store
        .profiles
        .iter()
        .filter(|profile| {
            profile.configuration_state == "requires-auth"
                && profile.credential_ref.as_ref() == Some(&entry.reference)
                && exact_origin(&profile.endpoint).ok().as_deref() == Some(&entry.exact_origin)
                && profile._environment_id.as_deref() == Some(&entry.environment_id)
                && profile.client_instance_id.as_deref() == Some(&entry.client_instance_id)
        })
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err(
            "Station pairing requires exactly one matching requires-auth Station".to_string(),
        );
    }
    Ok(matches[0].name.clone())
}

fn validate_pairing_default_transition(
    current: &CredentialProfileStore,
    next: &CredentialProfileStore,
    newly_configured_profile: Option<&str>,
) -> Result<(), String> {
    if current.default_profile == next.default_profile {
        return Ok(());
    }
    if current.default_profile.is_none()
        && newly_configured_profile.is_some_and(|profile| {
            next.default_profile
                .as_deref()
                .is_some_and(|default| default.eq_ignore_ascii_case(profile))
        })
    {
        return Ok(());
    }
    Err("Station pairing cannot replace an explicit active Station".to_string())
}

fn pairing_store_references_are_authorized(
    authority: &NativeProfileAuthorityState,
    store: &CredentialProfileStore,
    entry: &PendingPairingCredential,
) -> Result<(), String> {
    let target_key = credential_reference_key(&entry.reference)?;
    for profile in &store.profiles {
        if let Some(reference) = &profile.credential_ref {
            let key = credential_reference_key(reference)?;
            if key == target_key {
                continue;
            }
            let binding = authority.bindings.get(&key).ok_or_else(|| {
                "Station renderer writes cannot add an unobserved credential reference".to_string()
            })?;
            if profile_credential_binding(profile)? != *binding {
                return Err(
                    "Station credential origin and environment bindings are host-authorized and cannot be changed through webview metadata"
                        .to_string(),
                );
            }
            if authority.transitioning.contains(&key) {
                return Err(
                    "Station credential is transitioning; complete pairing first".to_string(),
                );
            }
        }
    }
    Ok(())
}

/// Extracted from the `#[tauri::command]` wrapper (station#1715) so
/// `station_local_self_provision` can drive the SAME `RequiresAuthPersisted
/// -> KeyringWritten` transition in-process, with no IPC round-trip and no
/// separately-exposed handle for a renderer to guess at.
fn credential_vault_commit_pairing_internal(
    app: &AppHandle,
    authority: &NativeProfileAuthority,
    pending: &NativePendingPairingCredentials,
    handle: &str,
) -> Result<(), String> {
    let mut pending = pending
        .0
        .lock()
        .map_err(|_| "native pairing credential state unavailable".to_string())?;
    let entry = pending
        .get_mut(handle)
        .filter(|entry| entry.expires_at > SystemTime::now())
        .ok_or_else(|| "native pairing credential handle is missing or expired".to_string())?;
    let profile_name = match &entry.phase {
        NativePairingPhase::RequiresAuthPersisted { profile_name } => profile_name.clone(),
        _ => return Err("Station pairing handle is not awaiting keyring commitment".to_string()),
    };
    let store = parse_station_profile_store(&read_station_profile_contents(app)?)?;
    pairing_profile_matches(&store, &profile_name, entry, "requires-auth")?;
    let reference_key = credential_reference_key(&entry.reference)?;
    let state = authority
        .0
        .lock()
        .map_err(|_| "Station native authority is unavailable".to_string())?;
    if !state.transitioning.contains(&reference_key) || state.bindings.contains_key(&reference_key)
    {
        return Err("Station pairing authority is not transitioning".to_string());
    }
    drop(state);
    entry.phase = NativePairingPhase::CredentialRemoved {
        profile_name: profile_name.clone(),
    };
    if let Err(error) = write_credential_password(&entry.reference, &entry.credential) {
        if entry.expires_at > SystemTime::now() {
            entry.phase = NativePairingPhase::RequiresAuthPersisted { profile_name };
        }
        return Err(error);
    }
    entry.phase = NativePairingPhase::KeyringWritten { profile_name };
    Ok(())
}

#[tauri::command]
fn credential_vault_commit_pairing(
    app: AppHandle,
    authority: State<'_, NativeProfileAuthority>,
    pending: State<'_, NativePendingPairingCredentials>,
    handle: String,
) -> Result<(), String> {
    credential_vault_commit_pairing_internal(&app, &authority, &pending, &handle)
}

/// A short owner-only lock shared with the CLI's `profiles.json.lock` protocol.
/// The revision check is still authoritative; the lock only makes the
/// read-compare-replace window interprocess-safe rather than best-effort.
struct StationProfileLock {
    path: std::path::PathBuf,
}

/// An exclusive sibling guard held only while removing a stale `.lock` file.
/// It prevents two reclaimers from racing such that one unlinks the live lock
/// the other acquired after reclaiming the stale predecessor.
struct StationProfileReclaimGuard {
    path: std::path::PathBuf,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyStationProfileLockRecord {
    schema_version: u8,
    pid: u32,
    created_at: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StationProfileLockRecord {
    schema_version: u8,
    pid: u32,
    birth: String,
    created_at: u64,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ParsedStationProfileLockRecord {
    V2(StationProfileLockRecord),
    V1(LegacyStationProfileLockRecord),
}

const PROFILE_LOCK_STALE_AFTER: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProfileLockOwnerLiveness {
    Alive,
    Dead,
    Ambiguous,
}

#[cfg(not(mobile))]
fn native_profile_lock_birth(app: &AppHandle, pid: u32) -> Result<Option<String>, String> {
    let resource_dir = simplified_sidecar_resource_dir(
        &app.path()
            .resource_dir()
            .map_err(|error| format!("locate packaged process identity authority: {error}"))?,
    );
    match profile_lock_birth_bridge(&resource_dir, pid) {
        Ok(birth) => Ok(Some(birth)),
        // An unavailable identity remains a fence during reclamation, but a
        // fresh writer must not publish a v2 record without one.
        Err(RegistryBridgeFailure::Invocation | RegistryBridgeFailure::Protocol) => Ok(None),
        Err(RegistryBridgeFailure::Untrusted) => Ok(None),
    }
}

impl Drop for StationProfileLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

impl Drop for StationProfileReclaimGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn profile_reclaim_guard_path(lock_path: &std::path::Path) -> Result<std::path::PathBuf, String> {
    use std::ffi::OsString;

    let file_name = lock_path
        .file_name()
        .ok_or_else(|| "saved Station lock has no filename".to_string())?;
    let mut guard_name = OsString::from(file_name);
    guard_name.push(".reclaim");
    Ok(lock_path.with_file_name(guard_name))
}

fn acquire_profile_reclaim_guard(
    lock_path: &std::path::Path,
    record_bytes: &dyn Fn() -> Result<Vec<u8>, String>,
    birth_for_pid: &dyn Fn(u32) -> Result<Option<String>, String>,
) -> Result<Option<StationProfileReclaimGuard>, String> {
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;

    let path = profile_reclaim_guard_path(lock_path)?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    for attempt in 0..2 {
        match options.open(&path) {
            Ok(mut file) => {
                let guard = StationProfileReclaimGuard { path };
                crate::windows_path_trust::ensure(&[(
                    crate::windows_path_trust::TrustKind::File,
                    &guard.path,
                )])?;
                let contents = record_bytes()?;
                file.write_all(&contents)
                    .map_err(|error| format!("write saved Station reclaim guard: {error}"))?;
                file.sync_all()
                    .map_err(|error| format!("sync saved Station reclaim guard: {error}"))?;
                return Ok(Some(guard));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && attempt == 0 => {
                // A process can crash after acquiring `.reclaim`, before it
                // gets a chance to release it. Recover only a proven old,
                // dead owner; a live or ambiguous guard stays fail-closed.
                if reclaim_stale_profile_reclaim_guard(&path, birth_for_pid)? {
                    continue;
                }
                return Ok(None);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(None),
            Err(error) => return Err(format!("acquire saved Station reclaim guard: {error}")),
        }
    }
    Ok(None)
}

fn reclaim_stale_profile_reclaim_guard(
    path: &std::path::Path,
    birth_for_pid: &dyn Fn(u32) -> Result<Option<String>, String>,
) -> Result<bool, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("inspect saved Station reclaim guard: {error}"))?;
    if !metadata.file_type().is_file() {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o777 != 0o600 || !profile_lock_owned_by_current_user(metadata.uid()) {
            return Ok(false);
        }
    }
    let contents = std::fs::read_to_string(path)
        .map_err(|error| format!("read saved Station reclaim guard: {error}"))?;
    let reclaimable = match serde_json::from_str::<ParsedStationProfileLockRecord>(&contents) {
        Ok(record) => {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|error| format!("clock for saved Station reclaim guard: {error}"))?
                .as_millis();
            let stale_by_time = now
                .saturating_sub(u128::from(profile_lock_record_created_at(&record)))
                >= PROFILE_LOCK_STALE_AFTER.as_millis();
            profile_lock_record_reclaimable(
                record,
                stale_by_time,
                &profile_lock_owner_liveness,
                birth_for_pid,
            )?
        }
        Err(_) => {
            // Only a torn record receives the historical mtime recovery
            // path. A complete JSON record that violates the closed schema is
            // an untrusted fence, not a stale owner identity.
            if serde_json::from_str::<serde_json::Value>(&contents).is_ok() {
                false
            } else {
                profile_lock_mtime_is_stale(&metadata)
            }
        }
    };
    if !reclaimable {
        return Ok(false);
    }
    // Recheck just before unlinking so a competing recovery that already
    // replaced this pathname with a live guard is never removed by us.
    let current = std::fs::symlink_metadata(path)
        .map_err(|error| format!("reinspect saved Station reclaim guard: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if current.dev() != metadata.dev() || current.ino() != metadata.ino() {
            return Ok(false);
        }
    }
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!(
            "reclaim stale saved Station reclaim guard: {error}"
        )),
    }
}

fn profile_lock_record_bytes(birth: &str) -> Result<Vec<u8>, String> {
    if birth.is_empty() || birth.len() > 512 {
        return Err("saved Station lock process identity is unavailable".to_string());
    }
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("clock for saved Station lock: {error}"))?
        .as_millis()
        .try_into()
        .map_err(|_| "saved Station lock timestamp is out of range".to_string())?;
    let mut contents = serde_json::to_vec(&StationProfileLockRecord {
        schema_version: 2,
        pid: std::process::id(),
        birth: birth.to_string(),
        created_at,
    })
    .map_err(|error| format!("encode saved Station lock: {error}"))?;
    contents.push(b'\n');
    Ok(contents)
}

#[cfg(mobile)]
fn legacy_profile_lock_record_bytes() -> Result<Vec<u8>, String> {
    let created_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("clock for saved Station lock: {error}"))?
        .as_millis()
        .try_into()
        .map_err(|_| "saved Station lock timestamp is out of range".to_string())?;
    let mut contents = serde_json::to_vec(&LegacyStationProfileLockRecord {
        schema_version: 1,
        pid: std::process::id(),
        created_at,
    })
    .map_err(|error| format!("encode saved Station lock: {error}"))?;
    contents.push(b'\n');
    Ok(contents)
}

fn lock_station_profiles_with_identity(
    path: &std::path::Path,
    birth: &str,
    birth_for_pid: &dyn Fn(u32) -> Result<Option<String>, String>,
) -> Result<StationProfileLock, String> {
    lock_station_profiles_with_record(path, &|| profile_lock_record_bytes(birth), birth_for_pid)
}

#[cfg(mobile)]
fn lock_station_profiles_legacy(path: &std::path::Path) -> Result<StationProfileLock, String> {
    lock_station_profiles_with_record(path, &legacy_profile_lock_record_bytes, &|_| Ok(None))
}

fn lock_station_profiles_with_record(
    path: &std::path::Path,
    record_bytes: &dyn Fn() -> Result<Vec<u8>, String>,
    birth_for_pid: &dyn Fn(u32) -> Result<Option<String>, String>,
) -> Result<StationProfileLock, String> {
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;

    let lock_path = path.with_extension("json.lock");
    let mut reclaimed_stale_lock = false;
    for _ in 0..100 {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        match options.open(&lock_path) {
            Ok(mut file) => {
                let lock = StationProfileLock { path: lock_path };
                crate::windows_path_trust::ensure(&[(
                    crate::windows_path_trust::TrustKind::File,
                    &lock.path,
                )])?;
                let contents = record_bytes()?;
                file.write_all(&contents)
                    .map_err(|error| format!("write saved Station lock: {error}"))?;
                file.sync_all()
                    .map_err(|error| format!("sync saved Station lock: {error}"))?;
                return Ok(lock);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                if !reclaimed_stale_lock
                    && reclaim_stale_profile_lock(&lock_path, record_bytes, birth_for_pid)?
                {
                    reclaimed_stale_lock = true;
                    continue;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(format!("lock saved Station metadata: {error}")),
        }
    }
    Err("saved Station metadata is busy in another CLI or Desktop process; retry the explicit change.".to_string())
}

fn reclaim_stale_profile_lock(
    path: &std::path::Path,
    record_bytes: &dyn Fn() -> Result<Vec<u8>, String>,
    birth_for_pid: &dyn Fn(u32) -> Result<Option<String>, String>,
) -> Result<bool, String> {
    // The guard is deliberately acquired before the stale check. A concurrent
    // reclaimer fails closed instead of inspecting and later unlinking a lock
    // another guarded reclaimer has already replaced with a live owner record.
    let Some(_guard) = acquire_profile_reclaim_guard(path, record_bytes, birth_for_pid)? else {
        return Ok(false);
    };
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("inspect saved Station lock: {error}"))?;
    if !metadata.file_type().is_file() {
        return Ok(false);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o777 != 0o600 || !profile_lock_owned_by_current_user(metadata.uid()) {
            return Ok(false);
        }
    }
    let contents = std::fs::read_to_string(path)
        .map_err(|error| format!("read saved Station lock: {error}"))?;
    let record: Option<ParsedStationProfileLockRecord> = match serde_json::from_str(&contents) {
        Ok(record) => Some(record),
        // A process can crash after exclusive creation but before its JSON
        // record is durable. Under the exclusive reclaim guard, only a
        // safe owner-only zero/partial file old enough by mtime is recoverable.
        Err(_) if serde_json::from_str::<serde_json::Value>(&contents).is_err() => {
            if !profile_lock_mtime_is_stale(&metadata) {
                return Ok(false);
            }
            None
        }
        Err(_) => return Ok(false),
    };
    if let Some(record) = record {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("clock for saved Station lock: {error}"))?
            .as_millis();
        let stale_by_time = now.saturating_sub(u128::from(profile_lock_record_created_at(&record)))
            >= PROFILE_LOCK_STALE_AFTER.as_millis();
        if !profile_lock_record_reclaimable(
            record,
            stale_by_time,
            &profile_lock_owner_liveness,
            birth_for_pid,
        )? {
            return Ok(false);
        }
    }
    // Bind deletion to the exact inode inspected under the exclusive guard;
    // a pathname replacement is never reclaim authority.
    let current = std::fs::symlink_metadata(path)
        .map_err(|error| format!("reinspect saved Station lock: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if current.dev() != metadata.dev() || current.ino() != metadata.ino() {
            return Ok(false);
        }
    }
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("reclaim stale saved Station lock: {error}")),
    }
}

fn profile_lock_mtime_is_stale(metadata: &std::fs::Metadata) -> bool {
    metadata
        .modified()
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age >= PROFILE_LOCK_STALE_AFTER)
}

#[cfg(unix)]
fn profile_lock_owned_by_current_user(owner_uid: u32) -> bool {
    unsafe { libc::geteuid() == owner_uid }
}

fn profile_lock_record_reclaimable(
    record: ParsedStationProfileLockRecord,
    stale_by_time: bool,
    owner_liveness: &dyn Fn(u32) -> ProfileLockOwnerLiveness,
    birth_for_pid: &dyn Fn(u32) -> Result<Option<String>, String>,
) -> Result<bool, String> {
    match record {
        // The on-disk v1 protocol did not bind PID reuse. Keep its original
        // five-minute rule exactly; upgrading must not reinterpret old locks.
        ParsedStationProfileLockRecord::V1(record) => Ok(record.schema_version == 1
            && record.pid != 0
            && stale_by_time
            && owner_liveness(record.pid) == ProfileLockOwnerLiveness::Dead),
        // A valid v2 record can be reclaimed as soon as the exact owner dies
        // or the shared process-identity authority proves PID reuse. A live
        // owner with an unavailable birth probe stays fenced.
        ParsedStationProfileLockRecord::V2(record) => {
            if record.schema_version != 2
                || record.pid == 0
                || record.birth.is_empty()
                || record.birth.len() > 512
            {
                return Ok(false);
            }
            match owner_liveness(record.pid) {
                ProfileLockOwnerLiveness::Dead => Ok(true),
                // The birth comparison is meaningful only after a successful
                // liveness probe. An EPERM/unknown probe failure cannot
                // authorize lock reclamation even if a later lookup differs.
                ProfileLockOwnerLiveness::Ambiguous => Ok(false),
                ProfileLockOwnerLiveness::Alive => {
                    Ok(birth_for_pid(record.pid)?.is_some_and(|observed| observed != record.birth))
                }
            }
        }
    }
}

fn profile_lock_record_created_at(record: &ParsedStationProfileLockRecord) -> u64 {
    match record {
        ParsedStationProfileLockRecord::V1(record) => record.created_at,
        ParsedStationProfileLockRecord::V2(record) => record.created_at,
    }
}

#[cfg(not(mobile))]
fn lock_station_profiles_for_app(
    app: &AppHandle,
    path: &std::path::Path,
) -> Result<StationProfileLock, String> {
    let own_pid = std::process::id();
    let birth = native_profile_lock_birth(app, own_pid)?
        .ok_or_else(|| "saved Station lock process identity is unavailable".to_string())?;
    lock_station_profiles_with_identity(path, &birth, &|pid| native_profile_lock_birth(app, pid))
}

#[cfg(mobile)]
fn lock_station_profiles_for_app(
    _app: &AppHandle,
    path: &std::path::Path,
) -> Result<StationProfileLock, String> {
    // Mobile does not share profiles.json with the desktop CLI and has no
    // packaged birth-fingerprint authority. Keep the established v1 protocol:
    // pid liveness plus the five-minute stale window, with no invented birth.
    lock_station_profiles_legacy(path)
}

#[cfg(test)]
fn lock_station_profiles(path: &std::path::Path) -> Result<StationProfileLock, String> {
    let self_pid = std::process::id();
    lock_station_profiles_with_identity(path, "test-process-birth", &|pid| {
        Ok((pid == self_pid).then(|| "test-process-birth".to_string()))
    })
}

#[cfg(unix)]
fn profile_lock_owner_liveness_from_probe(
    pid: u32,
    probe: &dyn Fn(libc::pid_t) -> Result<(), i32>,
) -> ProfileLockOwnerLiveness {
    // `pid_t` is i32, so a recorded pid at or above 2^31 wraps NEGATIVE when
    // cast — and a negative argument to kill(2) does not mean "this process".
    // -1 broadcasts to every process the caller may signal and therefore
    // succeeds, so such a record read as permanently alive and its lock could
    // never be reclaimed: saved Station metadata stayed "busy in another CLI or
    // Desktop process" forever. Other negatives address process GROUPS, which
    // is a different question than the one being asked (station#2293).
    //
    // A pid that cannot be a positive pid_t cannot identify a live process, so
    // it is reported dead. That only makes the lock a candidate — the caller
    // still requires schema v1, a non-zero pid, and a record older than
    // PROFILE_LOCK_STALE_AFTER before anything is removed.
    let Ok(native) = libc::pid_t::try_from(pid) else {
        return ProfileLockOwnerLiveness::Dead;
    };
    if native <= 0 {
        return ProfileLockOwnerLiveness::Dead;
    }
    match probe(native) {
        Ok(()) => ProfileLockOwnerLiveness::Alive,
        // ESRCH is the sole signal-0 result that proves no process owns this
        // PID. EPERM and all other failures remain an ownership fence.
        Err(libc::ESRCH) => ProfileLockOwnerLiveness::Dead,
        Err(_) => ProfileLockOwnerLiveness::Ambiguous,
    }
}

#[cfg(unix)]
fn profile_lock_owner_liveness(pid: u32) -> ProfileLockOwnerLiveness {
    // A direct signal-0 probe works in sandboxed mobile processes and avoids
    // requiring a shell utility that Android/iOS do not expose to apps.
    profile_lock_owner_liveness_from_probe(pid, &|native| {
        if unsafe { libc::kill(native, 0) } == 0 {
            Ok(())
        } else {
            Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(-1))
        }
    })
}

#[cfg(unix)]
fn profile_lock_owner_alive(pid: u32) -> bool {
    profile_lock_owner_liveness(pid) != ProfileLockOwnerLiveness::Dead
}

#[cfg(any(all(not(mobile), windows), test))]
fn windows_process_liveness_from_output(
    status_success: bool,
    stdout: &[u8],
) -> ProfileLockOwnerLiveness {
    // A PowerShell success status alone does not establish what it observed.
    // Only the exact, locale-independent sentinel can classify a PID. Empty,
    // malformed, or contradictory stdout remains a reclamation fence.
    if !status_success {
        return ProfileLockOwnerLiveness::Ambiguous;
    }
    match String::from_utf8_lossy(stdout).trim() {
        "0" => ProfileLockOwnerLiveness::Dead,
        "1" => ProfileLockOwnerLiveness::Alive,
        _ => ProfileLockOwnerLiveness::Ambiguous,
    }
}

#[cfg(any(all(not(mobile), windows), test))]
fn windows_process_probe_arguments(pid: u32) -> Vec<String> {
    // `tasklist` reports localized prose. The PowerShell object API and this
    // numeric sentinel are locale-independent. The PID is Base64 JSON inside
    // an encoded program: PowerShell does not reliably preserve argv after
    // the command program as positional values.
    let payload = crate::windows_path_trust::base64_utf8(&format!(r#"{{"pid":{pid}}}"#));
    let program = format!(
        "$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{payload}')) | ConvertFrom-Json; if (Get-Process -Id $request.pid -ErrorAction SilentlyContinue) {{ [Console]::Out.Write('1') }} else {{ [Console]::Out.Write('0') }}"
    );
    crate::windows_path_trust::encoded_powershell_command(&program)
}

#[cfg(windows)]
fn profile_lock_owner_liveness(pid: u32) -> ProfileLockOwnerLiveness {
    let Ok(powershell) = crate::windows_path_trust::powershell_path() else {
        // Fail closed: an untrusted utility path must never make a live lock
        // look reclaimable.
        return ProfileLockOwnerLiveness::Ambiguous;
    };
    Command::new(powershell)
        .args(windows_process_probe_arguments(pid))
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
        .map(|output| windows_process_liveness_from_output(output.status.success(), &output.stdout))
        .unwrap_or(ProfileLockOwnerLiveness::Ambiguous)
}

#[cfg(windows)]
fn profile_lock_owner_alive(pid: u32) -> bool {
    profile_lock_owner_liveness(pid) != ProfileLockOwnerLiveness::Dead
}

#[cfg(not(any(unix, windows)))]
fn profile_lock_owner_liveness(_pid: u32) -> ProfileLockOwnerLiveness {
    ProfileLockOwnerLiveness::Ambiguous
}

#[cfg(not(any(unix, windows)))]
fn profile_lock_owner_alive(pid: u32) -> bool {
    profile_lock_owner_liveness(pid) != ProfileLockOwnerLiveness::Dead
}

/// Read the same secret-free profile file as the CLI. Missing metadata is an
/// ordinary first-run state; malformed content is returned to the TypeScript
/// contract validator so the UI can fail closed with its diagnostic.
#[tauri::command]
fn station_profile_store_read(
    app: AppHandle,
    authority: State<'_, NativeProfileAuthority>,
) -> Result<String, String> {
    let path = station_profiles_path(&app)?;
    validate_station_profile_store(&path)?;
    match read_station_profile_store(&path) {
        Ok(contents) => {
            let store = parse_station_profile_store(&contents)?;
            let mut state = authority
                .0
                .lock()
                .map_err(|_| "Station native authority is unavailable".to_string())?;
            profile_bindings_are_authorized(&state, &store)?;
            // A read is the only trust-on-first-observation path. It accepts
            // externally configured CLI profiles, but never promotes a
            // crash-left `requires-auth` record into native authority.
            observe_configured_profile_bindings(&mut state, &store)?;
            Ok(contents)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(EMPTY_STATION_PROFILE_STORE.to_string())
        }
        Err(error) => Err(format!("read saved Station metadata: {error}")),
    }
}

/// Write only the secret-free profile document. The TypeScript caller validates
/// the versioned contract before this command; the native side supplies the
/// same owner-only, temp-and-rename durability boundary as the CLI store.
///
/// Extracted from the `#[tauri::command]` wrapper (station#1715) so
/// `station_local_self_provision` can drive the SAME CAS/rollback state
/// machine in-process, twice (once per pairing phase), with no IPC
/// round-trip and no renderer-authored `contents` string in between.
fn station_profile_store_write_internal(
    app: &AppHandle,
    authority: &NativeProfileAuthority,
    pending: &NativePendingPairingCredentials,
    contents: String,
    expected_revision: u64,
    pairing_handle: Option<String>,
) -> Result<(), String> {
    if contents.len() > 1024 * 1024 {
        return Err("saved Station metadata is too large".to_string());
    }
    let next_store = parse_station_profile_store(&contents)?;
    let path = station_profiles_path(app)?;
    let parent = path
        .parent()
        .ok_or_else(|| "saved Station metadata has no parent directory".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("create saved Station directory: {error}"))?;
    crate::windows_path_trust::ensure(&[(
        crate::windows_path_trust::TrustKind::Directory,
        parent,
    )])?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("secure saved Station directory: {error}"))?;
    }
    validate_station_profile_store(&path)?;
    let _lock = lock_station_profiles_for_app(app, &path)?;
    // Serialize all pairing-handle phases across the durable CAS. This keeps a
    // handle one-use without ever consuming it before the write it authorizes.
    let mut pending_entries = if pairing_handle.is_some() {
        Some(
            pending
                .0
                .lock()
                .map_err(|_| "native pairing credential state unavailable".to_string())?,
        )
    } else {
        None
    };
    let current_store = match read_station_profile_store(&path) {
        Ok(current) => parse_station_profile_store(&current)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            parse_station_profile_store(EMPTY_STATION_PROFILE_STORE)?
        }
        Err(error) => return Err(format!("read saved Station metadata for revision: {error}")),
    };
    if current_store.revision != expected_revision {
        return Err(format!(
            "saved Station revision conflict: expected {expected_revision}, found {}. Reload and retry the explicit change.",
            current_store.revision,
        ));
    }
    let next_revision = next_store.revision;
    if next_revision != expected_revision.saturating_add(1) {
        return Err(format!(
            "saved Station revision is invalid: expected next revision {}, found {next_revision}.",
            expected_revision.saturating_add(1)
        ));
    }
    let mut transition_rollback: Option<(String, String)> = None;
    {
        let mut state = authority
            .0
            .lock()
            .map_err(|_| "Station native authority is unavailable".to_string())?;
        profile_bindings_are_authorized(&state, &current_store)?;
        if let Some(handle) = pairing_handle.as_ref() {
            let entries = pending_entries
                .as_deref_mut()
                .ok_or_else(|| "native pairing credential state unavailable".to_string())?;
            let entry = entries
                .get_mut(handle)
                .filter(|entry| entry.expires_at > SystemTime::now())
                .ok_or_else(|| {
                    "native pairing credential handle is missing or expired".to_string()
                })?;
            let reference_key = credential_reference_key(&entry.reference)?;
            pairing_store_references_are_authorized(&state, &next_store, entry)?;
            match &entry.phase {
                NativePairingPhase::AwaitingRequiresAuth => {
                    validate_pairing_default_transition(&current_store, &next_store, None)?;
                    if current_store
                        .profiles
                        .iter()
                        .any(|profile| profile.credential_ref.as_ref() == Some(&entry.reference))
                    {
                        return Err("Station pairing target credential reference already exists"
                            .to_string());
                    }
                    let profile_name = pairing_requires_auth_profile_name(&next_store, entry)?;
                    if state.bindings.contains_key(&reference_key)
                        || state.transitioning.contains(&reference_key)
                    {
                        return Err("Station pairing target credential reference is unavailable"
                            .to_string());
                    }
                    // This is deliberately before the durable CAS. If it
                    // crashes after the write, the next host instance will not
                    // observe a requires-auth Station; if the CAS fails we
                    // restore both in-memory phases below.
                    state.transitioning.insert(reference_key.clone());
                    entry.phase = NativePairingPhase::RequiresAuthPersisted {
                        profile_name: profile_name.clone(),
                    };
                    transition_rollback = Some((reference_key, handle.clone()));
                }
                NativePairingPhase::KeyringWritten { profile_name } => {
                    validate_pairing_default_transition(
                        &current_store,
                        &next_store,
                        Some(profile_name),
                    )?;
                    pairing_profile_matches(&next_store, profile_name, entry, "configured")?;
                    if !state.transitioning.contains(&reference_key) {
                        return Err(
                            "Station pairing authority is no longer transitioning".to_string()
                        );
                    }
                }
                _ => {
                    return Err(
                        "Station pairing handle is not ready for this saved Station write"
                            .to_string(),
                    )
                }
            }
        } else {
            renderer_store_references_are_authorized(&state, &next_store)?;
        }
    }
    let temporary = path.with_extension(format!(
        "{}.{}.tmp",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| format!("clock for profile write: {error}"))?
            .as_nanos()
    ));
    let write_result = (|| -> Result<(), String> {
        #[cfg(unix)]
        use std::os::unix::fs::OpenOptionsExt;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options
            .open(&temporary)
            .map_err(|error| format!("create saved Station temp file: {error}"))?;
        crate::windows_path_trust::ensure(&[(
            crate::windows_path_trust::TrustKind::File,
            &temporary,
        )])?;
        file.write_all(contents.as_bytes())
            .map_err(|error| format!("write saved Station temp file: {error}"))?;
        file.sync_all()
            .map_err(|error| format!("sync saved Station temp file: {error}"))?;
        std::fs::rename(&temporary, &path)
            .map_err(|error| format!("replace saved Station metadata: {error}"))?;
        crate::windows_path_trust::ensure(&[(crate::windows_path_trust::TrustKind::File, &path)])?;
        Ok(())
    })();
    if temporary.exists() {
        let _ = std::fs::remove_file(&temporary);
    }
    if write_result.is_ok() {
        let mut state = authority
            .0
            .lock()
            .map_err(|_| "Station native authority is unavailable".to_string())?;
        invalidate_active_profile_receipt_after_store_write(&mut state, &next_store);
        if let Some(handle) = pairing_handle.as_ref() {
            let entries = pending_entries
                .as_deref_mut()
                .ok_or_else(|| "native pairing credential state unavailable".to_string())?;
            let entry = entries
                .get(handle)
                .ok_or_else(|| "native pairing credential handle is missing".to_string())?;
            if let NativePairingPhase::KeyringWritten { .. } = entry.phase {
                let key = credential_reference_key(&entry.reference)?;
                state.bindings.insert(
                    key.clone(),
                    NativeCredentialBinding {
                        exact_origin: entry.exact_origin.clone(),
                        environment_id: entry.environment_id.clone(),
                    },
                );
                state.transitioning.remove(&key);
                entries.remove(handle);
            }
        }
    } else if let Some((reference_key, handle)) = transition_rollback {
        let mut state = authority
            .0
            .lock()
            .map_err(|_| "Station native authority is unavailable".to_string())?;
        state.transitioning.remove(&reference_key);
        if let Some(entry) = pending_entries
            .as_deref_mut()
            .and_then(|entries| entries.get_mut(&handle))
        {
            entry.phase = NativePairingPhase::AwaitingRequiresAuth;
        }
    }
    #[cfg(not(mobile))]
    if write_result.is_ok() {
        // A cold first run may create or repair this channel's bundled
        // credential after the first readiness attempt. Wake the existing
        // bounded proof without coupling it to renderer hydration order.
        notify_startup_readiness_if_waiting(app);
    }
    write_result
}

#[tauri::command]
fn station_profile_store_write(
    app: AppHandle,
    authority: State<'_, NativeProfileAuthority>,
    pending: State<'_, NativePendingPairingCredentials>,
    contents: String,
    expected_revision: u64,
    pairing_handle: Option<String>,
) -> Result<(), String> {
    station_profile_store_write_internal(
        &app,
        &authority,
        &pending,
        contents,
        expected_revision,
        pairing_handle,
    )
}

#[cfg(not(mobile))]
fn now_millis_f64() -> Result<f64, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("clock for local self-provision: {error}"))?
        .as_millis() as f64)
}

#[cfg(not(mobile))]
fn same_runtime_home_identity(left: &str, right: &str, station_root: &std::path::Path) -> bool {
    matches!(
        (
            service_state::admit_station_runtime_home_for_root(
                std::path::Path::new(left),
                station_root,
            ),
            service_state::admit_station_runtime_home_for_root(
                std::path::Path::new(right),
                station_root,
            ),
        ),
        (Ok(left), Ok(right)) if left == right
    )
}

#[cfg(not(mobile))]
fn bundled_local_profile_owner_name(
    current: &CredentialProfileStore,
    base_dir: &str,
    station_root: &std::path::Path,
) -> Option<String> {
    // A bundled local Station is identified by the native-owned service base,
    // not its display name or endpoint. Names and endpoints are user data and
    // can legitimately collide with a saved remote Station; the service base
    // is the channel-private ownership boundary supplied by the host.
    current
        .profiles
        .iter()
        .find(|profile| {
            profile.setup_source == "local"
                && profile.local_service.as_ref().is_some_and(|service| {
                    same_runtime_home_identity(&service.base_dir, base_dir, station_root)
                })
        })
        .map(|profile| profile.name.clone())
}

#[cfg(not(mobile))]
fn bundled_local_profile_name(current: &CredentialProfileStore) -> String {
    if !current
        .profiles
        .iter()
        .any(|profile| profile.name.eq_ignore_ascii_case("local"))
    {
        return "local".to_string();
    }
    for suffix in 2..=u16::MAX {
        let candidate = format!("local-{suffix}");
        if !current
            .profiles
            .iter()
            .any(|profile| profile.name.eq_ignore_ascii_case(&candidate))
        {
            return candidate;
        }
    }
    // This is unreachable under the bounded profile-count limit, but
    // retain a deterministic fallback rather than ever aliasing a user name.
    "local-bundled".to_string()
}

/// Reconcile the channel-owned bundled local Station with a saved profile
/// store. The native service base is the ownership key: a same-origin profile
/// with a different credential or service identity remains intact, while the
/// bundled owner is returned to the desktop shell without changing the shared
/// global default, which may name another channel or be explicitly null.
#[cfg(not(mobile))]
fn reconciled_bundled_local_profile_store(
    current: &CredentialProfileStore,
    station_root: &std::path::Path,
    endpoint: String,
    instance_id: String,
    base_dir: String,
    server_port: u16,
    ui_port: u16,
    now_ms: f64,
) -> (CredentialProfileStore, String) {
    let owner_name = bundled_local_profile_owner_name(current, &base_dir, station_root)
        .unwrap_or_else(|| bundled_local_profile_name(current));
    let mut next = current.clone();
    let owner_index = next.profiles.iter().position(|profile| {
        profile.name.eq_ignore_ascii_case(&owner_name)
            && profile.setup_source == "local"
            && profile.local_service.as_ref().is_some_and(|service| {
                same_runtime_home_identity(&service.base_dir, &base_dir, station_root)
            })
    });

    if let Some(index) = owner_index {
        let profile = &mut next.profiles[index];
        let service = profile
            .local_service
            .as_mut()
            .expect("bundled local owner has local service");
        // This is the profile owned by THIS desktop sidecar (matched above by
        // its channel-private base directory), so its lifecycle identity is a
        // host-observed fact too. Keeping an old sidecar id here split the
        // native profile from the injected owner after an app replacement:
        // both rows named the same loopback server, but only the injected row
        // carried the current host authority. Attached durable services never
        // enter this sidecar-only reconciliation path, so their service ids
        // remain untouched.
        let changed = profile.endpoint != endpoint
            || service.instance_id != instance_id
            || service.server_port != server_port
            || service.ui_port != ui_port;
        profile.endpoint = endpoint;
        service.instance_id = instance_id;
        service.server_port = server_port;
        service.ui_port = ui_port;
        if changed {
            profile.updated_at = now_ms;
        }
    } else {
        next.profiles.push(CredentialProfile {
            schema_version: 1,
            name: owner_name.clone(),
            endpoint,
            credential_ref: None,
            _environment_id: None,
            local_service: Some(NativeLocalService {
                instance_id,
                base_dir,
                server_port,
                ui_port,
            }),
            setup_source: "local".to_string(),
            configuration_state: "configured".to_string(),
            created_at: now_ms,
            updated_at: now_ms,
            client_instance_id: None,
        });
    }
    next.default_profile = current.default_profile.clone();
    if serde_json::to_value(&next).ok() != serde_json::to_value(current).ok() {
        next.revision = current.revision + 1;
    }
    (next, owner_name)
}

#[cfg(not(mobile))]
fn resolve_bundled_profile_ui_port(
    explicit_ui_port: Option<&str>,
    channel: Option<&str>,
) -> Option<u16> {
    explicit_ui_port
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port > 0)
        .or_else(|| channel_ports_generated::default_desktop_ui_port(channel))
}

/// Bootstrap only the desktop-owned sidecar in a truly empty channel home.
/// The renderer supplies no endpoint, path, port, or profile contents: every
/// field is derived from the native ownership/status contract. This makes the
/// existing local self-provision path reachable on first install without
/// granting a compromised webview authority to invent a local service.
#[cfg(not(mobile))]
#[tauri::command]
fn station_ensure_bundled_local_profile(
    app: AppHandle,
    authority: State<'_, NativeProfileAuthority>,
    pending: State<'_, NativePendingPairingCredentials>,
) -> Result<Option<String>, String> {
    let state = app
        .try_state::<DesktopServerState>()
        .ok_or_else(|| "Desktop startup readiness is not initialized.".to_string())?;
    let station_root = state.supervisor.context.launch.station_root.clone();
    let station_home = state.supervisor.context.launch.station_home.clone();
    let status = unified_server_status(&app);
    if status.fail_closed {
        return Err(status
            .detail
            .unwrap_or_else(|| "Desktop local ownership is unavailable.".to_string()));
    }
    if status.ownership != bundled_server_state::ServerOwnership::Sidecar {
        return service_state::resolve_runtime_owned_service(&station_root, &station_home)
            .map(|owned| owned.map(|(name, _)| name));
    }
    if status.phase != bundled_server_state::ServerPhase::Running {
        return Ok(None);
    }
    let server_port = status
        .port
        .ok_or_else(|| "running Station sidecar has no server port".to_string())?;
    let endpoint = status
        .api_base
        .ok_or_else(|| "running Station sidecar has no API base".to_string())?;
    let instance_id = status
        .instance_id
        .ok_or_else(|| "running Station sidecar has no instance identity".to_string())?;
    if exact_origin(&endpoint)? != endpoint {
        return Err("running Station sidecar API base is not an exact origin".to_string());
    }
    let channel = if cfg!(debug_assertions) {
        None
    } else {
        channel_ports_generated::desktop_channel_from_identifier(&app.config().identifier)
    };
    let path = station_root.join("config").join("profiles.json");
    validate_station_profile_store(&path)?;
    let current = match read_station_profile_store(&path) {
        Ok(contents) => parse_station_profile_store(&contents)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            parse_station_profile_store(EMPTY_STATION_PROFILE_STORE)?
        }
        Err(error) => return Err(format!("read saved Station metadata: {error}")),
    };
    let explicit_ui_port = std::env::var("STATION_UI_PORT").ok();
    let ui_port = resolve_bundled_profile_ui_port(explicit_ui_port.as_deref(), channel)
        .ok_or_else(|| "running Station sidecar has no UI port contract".to_string())?;
    let (next, profile_name) = reconciled_bundled_local_profile_store(
        &current,
        &station_root,
        endpoint,
        instance_id,
        station_home.to_string_lossy().to_string(),
        server_port,
        ui_port,
        now_millis_f64()?,
    );
    if next.revision != current.revision {
        station_profile_store_write_internal(
            &app,
            &authority,
            &pending,
            serde_json::to_string(&next)
                .map_err(|_| "invalid bundled Station metadata".to_string())?,
            current.revision,
            None,
        )?;
    }
    Ok(Some(profile_name))
}

/// Three outcomes of asking whether a stored credential can actually be
/// read back, distinguished because they demand different responses from
/// `profile_already_locally_provisioned` below.
#[cfg(not(mobile))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CredentialReadOutcome {
    /// The keychain entry exists and was read successfully. This proves only
    /// that the bytes are retrievable from the OS store — NOT that the
    /// Station server will accept them (station#1866: a server restart
    /// invalidates the local grant while the bearer stays perfectly
    /// readable). Named `Readable` rather than `Usable` so the next reader
    /// does not collapse "I could read it" with "the server honours it" —
    /// the eligibility check below pairs this with a separate server-side
    /// rejection signal before concluding a saved Station is provisioned.
    Readable,
    /// Nothing is stored under this reference, OR the platform answered
    /// with an error this crate does not distinguish from "nothing usable
    /// is here" (see the taxonomy note below). Provisioning may proceed and
    /// replace it.
    Absent,
    /// The platform specifically refused this credential item's access
    /// control. On macOS this is the keychain status family emitted after an
    /// ad-hoc bundle replacement invalidates the prior item's ACL. The
    /// channel-owned local profile may replace this one credential.
    StaleItemAccess,
    /// The credential STORE itself refused the read for a reason that is
    /// about the store, not this item: locked, unavailable, a permissions
    /// fault on the store file. This is not evidence the credential is
    /// gone — minting a fresh one here would create a second live grant
    /// next to one that still works once the transient condition clears.
    /// Provisioning must refuse and let the already-classified
    /// `credential_store_unreadable` error (`station_native_http_request`)
    /// tell the user what is actually wrong instead.
    StoreUnavailable,
}

/// Reads `reference` from the OS credential store purely to classify
/// whether it is usable, absent, or the store itself is unavailable — never
/// to obtain the secret (callers must not log or forward the `Ok` value).
///
/// station#1818 error-taxonomy note, stated plainly rather than guessed at:
/// `keyring-core` 1.0's `Error` enum has no variant for "this exact item's
/// access-control entry refused this process" as distinct from other
/// platform failures — reading `apple-native-keyring-store` 1.0.1's own
/// OSStatus mapping (`keychain.rs`), only `errSecItemNotFound` (-25300)
/// maps to `NoEntry`; a handful of explicit codes for a locked/unavailable
/// *store* (`errSecNotAvailable`, `errSecReadOnly`, `errSecNoSuchKeychain`,
/// `errSecInvalidKeychain`, a write-permission fault) map to
/// `NoStorageAccess`; and EVERY OTHER OSStatus — including the
/// `errSecAuthFailed`/`errSecInteractionNotAllowed` family an ACL bound to a
/// since-replaced code signature would plausibly produce — falls into the
/// catch-all `PlatformFailure`. That catch-all is also where a genuinely
/// unrelated platform fault would land. The crate does not hand this
/// function a way to tell those apart, and I could not determine one from
/// its public surface; I am not guessing at a finer rule than the type
/// system can support.
///
/// `PlatformFailure` is not itself sufficient evidence to replace a grant:
/// it can also mean corrupt keychain data or a transient platform fault. We
/// recover only from the specific macOS status names/codes that Security
/// returns for an item's ACL/entitlement refusal. Every other platform error,
/// including malformed/corrupt credential data, remains `StoreUnavailable`.
/// This is intentionally fail-closed: a locked or damaged store must never
/// create another live server grant merely because it cannot be read today.
/// The taxonomy decision itself, isolated from any real keychain I/O so it
/// has an explicit, directly testable seam (station#1818: "make the seam
/// explicit rather than pretending the untestable part is covered" — this
/// crate's real store requires a live, unlocked OS keychain that a CI
/// sandbox cannot be assumed to have, and writing a probe secret into a
/// developer's REAL login keychain as a side effect of `cargo test` would
/// be its own bug). Every `keyring_core::Error` variant this function's
/// callers can produce is constructible directly in a unit test.
#[cfg(not(mobile))]
fn platform_error_indicates_stale_item_access(
    error: &(dyn std::error::Error + Send + Sync + 'static),
) -> bool {
    // Security-framework's Display text is localized and may omit its numeric
    // status, so recovery must inspect the typed error rather than prose.
    // errSecAuthFailed is the one established stale per-item ACL signal after
    // an ad-hoc signature swap. KeychainLocked (-25308) and missing
    // entitlement (-34018) are deliberately NOT admitted: both are expected
    // to make the replacement write fail after server-side supersession.
    #[cfg(target_os = "macos")]
    {
        error
            .downcast_ref::<security_framework::base::Error>()
            .is_some_and(|status| status.code() == -25293)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = error;
        false
    }
}

#[cfg(not(mobile))]
fn classify_credential_read_result(
    result: Result<String, keyring_core::Error>,
) -> CredentialReadOutcome {
    match result {
        Ok(_) => CredentialReadOutcome::Readable,
        Err(error) if is_missing_credential(&error) => CredentialReadOutcome::Absent,
        Err(keyring_core::Error::NoStorageAccess(_)) => CredentialReadOutcome::StoreUnavailable,
        Err(keyring_core::Error::PlatformFailure(error))
            if platform_error_indicates_stale_item_access(error.as_ref()) =>
        {
            CredentialReadOutcome::StaleItemAccess
        }
        // A bad encoding/data format and every unrecognised platform failure
        // are not proof that this precise item was invalidated by a bundle
        // swap. Do not mint a replacement against a locked/corrupt store.
        Err(_) => CredentialReadOutcome::StoreUnavailable,
    }
}

#[cfg(not(mobile))]
fn read_credential_for_eligibility(reference: &NativeCredentialReference) -> CredentialReadOutcome {
    let entry = match credential_entry(reference) {
        Ok(entry) => entry,
        // A failure here is about creating the *handle* — the platform
        // store failing to initialize, or the reference itself being
        // malformed — never a statement about whether this credential is
        // present. Treat it exactly like `StoreUnavailable`: refuse to
        // guess, and let the caller's existing refusal stand.
        Err(_) => return CredentialReadOutcome::StoreUnavailable,
    };
    classify_credential_read_result(entry.get_password())
}

/// Whether `profile` already has a durable, WORKING native credential and so
/// must never be touched by `station_local_self_provision` again.
///
/// station#1818 live-boot fix: the previous version of this check asked
/// only whether `credential_ref` was RECORDED and `configuration_state ==
/// "configured"` — two fields written once at authorization time and never
/// revisited. That is exactly what stranded the owner after a nightly
/// bundle swap: the nightly is ad-hoc signed on the machine that builds it,
/// so a replacement bundle carries a different signature, the macOS
/// keychain ACL bound to the PREVIOUS signature no longer trusts this
/// process, and the OS refuses every read of the item that build stored —
/// permanently, with these two fields still reading exactly like a healthy
/// profile. `configured`/`credentialRef` is a RECORD that provisioning
/// happened once; it is not an observation that the credential still
/// works. Eligibility now performs that observation: it actually reads the
/// credential back (see `read_credential_for_eligibility` for the read's
/// own error taxonomy) rather than recalling that a write once succeeded.
///
/// station#1715's original fix stands: `configuration_state` alone is
/// still not sufficient — `station setup local`
/// (packages/cli/src/commands/setup-command.ts) writes a fresh local
/// profile as `configured` with no `credentialRef` at all (the CLI itself
/// never needed one), so a profile with no `credential_ref` recorded yet is
/// `false` (eligible) here without ever touching the keychain.
///
/// A readable credential is only locally available, not authority-adequate.
/// `station_local_self_provision` therefore always follows this local check
/// with the server-owned local-grant eligibility probe. A raw 401/403 never
/// bypasses the probe: it may mean a restart or a transient server policy,
/// neither of which proves that revoking and replacing the grant is safe.
#[cfg(not(mobile))]
/// Applies the profile-state and credential-read halves of local provisioning
/// eligibility. Keeping the read as an explicit one-shot operation gives the
/// profile-level decision a deterministic test seam without changing the
/// production credential-store behavior.
fn profile_already_locally_provisioned(
    profile: &CredentialProfile,
    read_credential: impl FnOnce(&NativeCredentialReference) -> CredentialReadOutcome,
) -> bool {
    let Some(reference) = profile.credential_ref.as_ref() else {
        return false;
    };
    if profile.configuration_state != "configured" {
        return false;
    }
    credential_provisioned_from_read_outcome(read_credential(reference))
}

/// The local half of the eligibility decision. A readable keychain item must
/// subsequently receive the server-owned authority probe; no remembered
/// transport status is allowed to skip that probe and mint a replacement.
#[cfg(not(mobile))]
fn credential_provisioned_from_read_outcome(read_outcome: CredentialReadOutcome) -> bool {
    matches!(
        read_outcome,
        CredentialReadOutcome::Readable | CredentialReadOutcome::StoreUnavailable
    )
}

/// The only server-side facts that may turn a readable local credential into
/// an eligible replacement. The desktop presents the bearer directly from
/// Rust, and the server answers whether its *already-bound* principal carries
/// the owner-secret local-grant mint. This is intentionally not `/api/auth/
/// status`: an old paired bearer can be accepted there while lacking the
/// home-possession and mint-kind facts personal-mode identity requires.
///
/// Only the bounded `{ "eligible": false }` server response replaces. An
/// authentication rejection, outage,
/// malformed response, or a future route drift cannot supersede a working
/// grant. The exchange that follows remains desktop-only and must still read
/// the owner-only local-grant secret itself.
#[cfg(not(mobile))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LocalCredentialProbeOutcome {
    Eligible,
    Ineligible,
    Inconclusive,
}

#[cfg(not(mobile))]
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeLocalGrantEligibilityResponse {
    eligible: bool,
}

#[cfg(not(mobile))]
fn classify_local_credential_probe(
    response: Result<(u16, &str), ()>,
) -> LocalCredentialProbeOutcome {
    match response {
        Ok((200..=299, body)) => {
            match serde_json::from_str::<NativeLocalGrantEligibilityResponse>(body) {
                Ok(NativeLocalGrantEligibilityResponse { eligible: true }) => {
                    LocalCredentialProbeOutcome::Eligible
                }
                Ok(NativeLocalGrantEligibilityResponse { eligible: false }) => {
                    LocalCredentialProbeOutcome::Ineligible
                }
                Err(_) => LocalCredentialProbeOutcome::Inconclusive,
            }
        }
        Ok((401 | 403, _)) => LocalCredentialProbeOutcome::Inconclusive,
        Ok(_) | Err(()) => LocalCredentialProbeOutcome::Inconclusive,
    }
}

#[cfg(not(mobile))]
fn readable_local_credential_needs_reprovision(outcome: LocalCredentialProbeOutcome) -> bool {
    matches!(outcome, LocalCredentialProbeOutcome::Ineligible)
}

/// Injectable control seam for the readable-credential branch. The caller
/// supplies the local-grant exchange only after this returns `Reprovision`,
/// making the no-supersession contract testable without a Keychain or server.
#[cfg(not(mobile))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReadableCredentialRecoveryDecision {
    Retain,
    Reprovision,
    Refuse,
}

#[cfg(not(mobile))]
fn decide_readable_credential_recovery(
    outcome: LocalCredentialProbeOutcome,
) -> ReadableCredentialRecoveryDecision {
    if readable_local_credential_needs_reprovision(outcome) {
        ReadableCredentialRecoveryDecision::Reprovision
    } else if outcome == LocalCredentialProbeOutcome::Eligible {
        ReadableCredentialRecoveryDecision::Retain
    } else {
        ReadableCredentialRecoveryDecision::Refuse
    }
}

/// Executes a local-grant exchange only after a server-confirmed authority
/// gap. Tests inject the exchange closure to prove a healthy, unknown, or
/// failed probe cannot supersede a grant by accident.
#[cfg(not(mobile))]
fn exchange_after_readable_credential_probe<T>(
    outcome: LocalCredentialProbeOutcome,
    client_instance_id: &str,
    exchange: impl FnOnce(&str) -> T,
) -> Result<T, ReadableCredentialRecoveryDecision> {
    match decide_readable_credential_recovery(outcome) {
        ReadableCredentialRecoveryDecision::Reprovision => Ok(exchange(client_instance_id)),
        decision => Err(decision),
    }
}

#[cfg(not(mobile))]
fn probe_local_credential(origin: &str, credential: &str) -> LocalCredentialProbeOutcome {
    let endpoint = match url::Url::parse(origin)
        .and_then(|url| url.join("/api/auth/local-grant-eligibility"))
    {
        Ok(endpoint) => endpoint,
        Err(_) => return LocalCredentialProbeOutcome::Inconclusive,
    };
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .max_redirects(0)
        .timeout_global(Some(Duration::from_secs(5)))
        .http_status_as_error(false)
        .build()
        .into();
    let response = agent
        .get(endpoint.as_str())
        .header("Authorization", format!("Bearer {credential}"))
        .call()
        .map_err(|_| ());
    let parsed = response.and_then(|mut response| {
        let status = response.status().as_u16();
        let body = response.body_mut().read_to_string().map_err(|_| ())?;
        Ok((status, body))
    });
    match parsed {
        Ok((status, body)) => classify_local_credential_probe(Ok((status, &body))),
        Err(()) => classify_local_credential_probe(Err(())),
    }
}

/// Clones `current`, sets `next_revision`, and upserts exactly the named
/// profile's `credentialRef`/`environmentId`/`configurationState`/`updatedAt`
/// — never anything else (`defaultProfile`, other profiles, `setupSource`,
/// are all carried through verbatim). Serialized back to the wire JSON string
/// `station_profile_store_write_internal` expects, so this function is the
/// one place `station_local_self_provision` authors profile-store content —
/// there is no renderer-authored `contents` string on this path at all.
#[cfg(not(mobile))]
fn local_self_provision_next_store(
    current: &CredentialProfileStore,
    next_revision: u64,
    profile_name: &str,
    reference: &NativeCredentialReference,
    environment_id: &str,
    configuration_state: &str,
    updated_at: f64,
    client_instance_id: &str,
) -> Result<String, String> {
    let mut next = current.clone();
    next.revision = next_revision;
    let mut found = false;
    for profile in &mut next.profiles {
        if profile.name.eq_ignore_ascii_case(profile_name) {
            profile.credential_ref = Some(reference.clone());
            profile._environment_id = Some(environment_id.to_string());
            profile.configuration_state = configuration_state.to_string();
            profile.updated_at = updated_at;
            // station#1818 R3 review round 1 (MEDIUM): persisted verbatim,
            // never recomputed — see
            // `resolve_local_self_provision_client_instance_id`'s doc
            // comment for why this must be the same value across every
            // write, once assigned.
            profile.client_instance_id = Some(client_instance_id.to_string());
            found = true;
        }
    }
    if !found {
        return Err("the selected Station is missing from saved Station metadata".to_string());
    }
    serde_json::to_string(&next)
        .map_err(|_| "invalid local self-provision profile update".to_string())
}

/// Same-user local self-authorization (station#1715). The sole command in
/// this family: reads the per-boot local-grant secret and exchanges it for a
/// paired-device credential by POSTing to the Station's own local-grant
/// route FROM RUST, mirroring `station_native_pairing_exchange_blocking` —
/// the bearer never crosses IPC to the webview, which is exactly why
/// `NativeStationProfileStorage.commitVerifiedPairing` (the TypeScript
/// completion every other pairing surface uses) refuses a renderer-visible
/// `credential` field on desktop. It then drives the SAME pending-handle /
/// CAS / rollback state machine `station_native_pairing_exchange` +
/// `credential_vault_commit_pairing` use for every other pairing flow — the
/// three helpers extracted above — in-process, with no intermediate IPC
/// round-trip, before authorizing the Station active exactly as
/// `station_profile_authorize_active` does.
///
/// Scoped to first-time provisioning only: refuses a saved Station that is
/// already durably authorized (`credentialRef` present AND `configured`),
/// so a caller may retry freely from an interrupted attempt (no
/// `credentialRef` yet, or one stranded at `requires-auth`/`unconfigured`
/// from a previous failed attempt — never trusted on its own per
/// `observe_configured_profile_bindings`) without ever clobbering a
/// credential already in use.
///
/// station#1715 live-boot fix: this was originally gated on
/// `configuration_state == "configured"` alone. `station setup local`
/// (packages/cli/src/commands/setup-command.ts) writes a fresh local
/// profile as `configured` with NO `credentialRef` — the CLI never needed
/// one — so that check refused every real local install unconditionally.
/// Live verification against an actual `~/.station/config/profiles.json`
/// confirmed the command never even attempted the exchange. `credentialRef`
/// presence is the only signal that means "already durably provisioned";
/// `configuration_state` alone does not.
///
/// A failure partway through this command leaves the SAME bounded,
/// in-memory-only residue (a stale `transitioning` entry, an unbound
/// pending handle) that an interrupted `commitVerifiedPairing` already
/// leaves today; nothing here is persisted beyond the saved-Station-store CAS
/// writes themselves, and every such residue clears on the next app
/// restart.
/// station#1818 R3 (owner follow-up, from the issue's own comment): every
/// call used to send `uuid::Uuid::new_v4()` — a FRESH random id each time —
/// as `clientInstanceId`. The server's pairing exchange already supersedes
/// (revokes) any prior non-revoked device sharing the SAME `clientInstanceId`
/// (`DevicePairingService.exchange`, `src-server/services/ssh/device-pairing-service.ts`),
/// exactly the mechanism `clientInstanceId`'s own doc comment
/// (`packages/connect/src/core/devicePairing.ts`) describes: "an approved
/// re-pair [replaces] this app instance's prior grant." A fresh random id
/// every call can never match a prior grant, so that supersession never
/// fired — this is the actual mechanism behind the issue's reported
/// accumulation (two live, full-scope, unrevoked devices after one manual
/// recovery). The fix is entirely client-side: send the SAME id every time
/// for the same local Station, and the ALREADY-EXISTING server logic does
/// the rest. Nothing server-side needed to change; this only reaches what
/// the local-grant route already accepts and already acts on.
///
/// station#1818 R3 review round 1 (MEDIUM): this used to DERIVE a
/// deterministic id from `local_service.instance_id` via two `DefaultHasher`
/// passes rather than persist one, on the theory that a drift would cost
/// only "one extra device entry". Traced further: the server's
/// supersession matches ONLY on an exactly-equal `clientInstanceId`, so a
/// drifted id supersedes NOTHING — the prior grant stays `revokedAt: null`
/// forever, a live, full-scope credential accepted by `verifyCredential`
/// (including over the tailnet) with no future supersession path. A
/// computed value that could ever drift is the wrong shape here regardless
/// of how unlikely the drift is.
///
/// The fix is to persist instead of derive:
/// `CredentialProfile.client_instance_id` now lives in `profiles.json` —
/// a plain, unsigned JSON document that already survives exactly the event
/// this issue is about (a nightly bundle swap re-signs the binary; the
/// document is untouched) — and is reused verbatim on every subsequent
/// self-provision for the same saved Station. A fresh id is minted only the
/// FIRST time a saved Station has none (a brand-new local install, or a
/// profiles.json written before this field existed), via
/// `resolve_local_self_provision_client_instance_id` below. Once written,
/// nothing needs to reproduce it again by computation — only read it back —
/// so the toolchain-stability caveat the derived version carried no longer
/// applies at all.
///
/// **What this mechanism does and does not reach (accepted gap, review
/// round 2)**: it makes every FUTURE self-provision for a given local
/// Station supersede the one before it, closing unbounded accumulation
/// going forward. It cannot reach a grant minted BEFORE this field
/// existed. The original station#1715 code sent a fresh random
/// `uuid::Uuid::new_v4()` on every call and persisted nothing, so the id
/// that created any already-live grant was never recorded anywhere — there
/// is no value this function, or anything else, can read to reconstruct
/// it. The very first self-provision on this binary therefore takes the
/// `None` branch below, mints a NEW id unrelated to any pre-existing
/// grant's id, and — correctly, per the server's exact-match supersession —
/// does not revoke a device it cannot identify. A saved Station with N prior
/// grants from the pre-persistence code (e.g. the two live, full-scope,
/// unrevoked devices station#1818's own comment reports:
/// `local-grant:36471b8f-…` and `local-grant:532d5bc8-…`) reaches this
/// commit's first self-provision with all N still live, and gains one
/// more; only that Nth+1 grant and every one after it participate in
/// supersession from here on. This is a deliberate, disclosed boundary,
/// not an oversight: the only way to reach further back would be to guess
/// which OTHER non-revoked device for the same Station the new grant
/// replaces — by name, scope, or kind, since no field links a device to
/// the saved Station that created it — and that heuristic could just as easily
/// revoke the owner's legitimate, unrelated paired phone. Destroying a
/// real device credential to clean up this bookkeeping gap is a worse
/// defect than leaving it, so no such auto-revoke is implemented. The
/// existing REMEDY for the pre-existing devices is manual: the Connections
/// UI's "Paired devices" panel (`PairedDevicesPanel`,
/// `packages/connect/src/react/connection-manager-modal/PairedDevicesPanel.tsx`,
/// reachable via "Manage Connections" → devices) lists every device on the
/// environment and lets an operator revoke one by hand — the same path
/// already used to clean up the owner's two live orphans. There is
/// currently no CLI equivalent.
///
/// One more disclosed, PRE-EXISTING pattern this field now exercises for
/// the first time: `CredentialProfile` derives `#[serde(deny_unknown_fields)]`
/// and `packages/contracts/src/station-profile.ts`'s `isStationProfile` is a
/// matching strict allow-list, so an OLDER build (a stale CLI, or a
/// downgraded desktop app) reading a `profiles.json` this build has written
/// `clientInstanceId` into rejects the WHOLE Station entry, not just the unknown
/// field — this is how every field in this document has always behaved,
/// not something this change introduces, but a downgrade or a stale CLI
/// reading fresh saved Station metadata is a real scenario and was previously
/// undisclosed.
#[cfg(not(mobile))]
fn resolve_local_self_provision_client_instance_id(profile: &CredentialProfile) -> String {
    profile
        .client_instance_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
}

#[cfg(not(mobile))]
#[tauri::command]
fn station_local_self_provision(
    app: AppHandle,
    authority: State<'_, NativeProfileAuthority>,
    pending: State<'_, NativePendingPairingCredentials>,
    profile_name: String,
) -> Result<(), NativeCommandError> {
    let store = parse_station_profile_store(&read_station_profile_contents(&app)?)?;
    let profile = selected_profile_from_store(&store, &profile_name)?;
    // A local-service-shaped profile is not necessarily owned by this desktop
    // channel. Do not replace a paired/remote identity just because it shares
    // an endpoint or attachment shape with the bundled sidecar.
    if profile.setup_source != "local" {
        return Err(NativeCommandError::new(
            "local_profile_not_owned",
            "only this desktop channel's local Station may self-provision",
        ));
    }
    let state = app.try_state::<DesktopServerState>().ok_or_else(|| {
        NativeCommandError::new(
            "local_profile_not_owned",
            "Desktop local ownership is not initialized.",
        )
    })?;
    let station_root = &state.supervisor.context.launch.station_root;
    let station_home = &state.supervisor.context.launch.station_home;
    let (owned_name, owned_service) =
        service_state::resolve_runtime_owned_service(station_root, station_home)
            .map_err(|error| NativeCommandError::new("local_profile_not_owned", error))?
            .ok_or_else(|| {
                NativeCommandError::new(
                    "local_profile_not_owned",
                    "no saved Station is owned by this desktop runtime",
                )
            })?;
    if !owned_name.eq_ignore_ascii_case(&profile_name) {
        return Err(NativeCommandError::new(
            "local_profile_not_owned",
            "the selected Station belongs to another desktop runtime",
        ));
    }
    let origin = exact_origin(&profile.endpoint)?;
    if !credential_endpoint_uses_secure_transport(&origin) {
        return Err(NativeCommandError::new(
            "local_profile_not_owned",
            "Station local service endpoint must use HTTPS or strict loopback HTTP",
        ));
    }
    let status = unified_server_status(&app);
    let local = profile.local_service.as_ref().ok_or_else(|| {
        NativeCommandError::new(
            "local_profile_not_owned",
            "the selected Station has no local service",
        )
    })?;
    if status.phase != bundled_server_state::ServerPhase::Running
        || !matches!(
            status.ownership,
            bundled_server_state::ServerOwnership::Sidecar
                | bundled_server_state::ServerOwnership::Service
        )
        || status.api_base.as_deref() != Some(origin.as_str())
        || status.port != Some(local.server_port)
        || status.instance_id.as_deref() != Some(local.instance_id.as_str())
        || owned_service.base_dir != *station_home
        || owned_service.manifest.instance_id != local.instance_id
    {
        return Err(NativeCommandError::new(
            "local_profile_not_owned",
            "the selected Station does not match the running desktop runtime",
        ));
    }
    // The full consequential tail lives behind one FnOnce. The readable
    // credential gate below invokes this exact closure only after a server
    // confirms `{ "eligible": false }`, or returns without making the local-grant request,
    // allocating pending state, or touching the Keychain.
    let client_instance_id = resolve_local_self_provision_client_instance_id(profile);
    let reprovision = || -> Result<(), NativeCommandError> {
        let secret = read_local_grant_secret(local)?;

        // Exchange the secret for a credential, entirely in Rust.
        let endpoint = url::Url::parse(&origin)
            .map_err(|_| "invalid Station local service endpoint".to_string())?
            .join("/.well-known/station/v1/pairing/local-grant")
            .map_err(|_| "invalid Station local service endpoint".to_string())?;
        let agent: ureq::Agent = ureq::Agent::config_builder()
            .max_redirects(0)
            .timeout_global(Some(Duration::from_secs(20)))
            .http_status_as_error(false)
            .build()
            .into();
        let request_body = serde_json::json!({
            "secret": secret,
            "deviceName": local_device_name(),
            "clientInstanceId": client_instance_id,
        });
        let mut response = agent
            .post(endpoint.as_str())
            .header("Content-Type", "application/json")
            .send(
                serde_json::to_string(&request_body)
                    .map_err(|_| "invalid local self-provision request".to_string())?,
            )
            .map_err(|_| "transport".to_string())?;
        let status = response.status().as_u16();
        let raw = response
            .body_mut()
            .read_to_string()
            .map_err(|_| "invalid local self-provision response".to_string())?;
        if !(200..300).contains(&status) {
            return Err(format!(
                "local self-provision exchange failed: {} (HTTP {status})",
                pairing_error_code(&raw)
            )
            .into());
        }
        let exchange: NativePairingExchangeResponse = serde_json::from_str(&raw)
            .map_err(|_| "invalid local self-provision response".to_string())?;
        if exchange.environment_id.is_empty()
            || exchange.environment_id.len() > 512
            || exchange.credential.is_empty()
            || exchange.credential.len() > 16 * 1024
        {
            return Err("invalid local self-provision response".to_string().into());
        }
        native_pairing_device_response(exchange.device)?;

        let reference = NativeCredentialReference {
            kind: "station-bearer".to_string(),
            id: format!("local-grant:{}", uuid::Uuid::new_v4()),
        };
        let handle = uuid::Uuid::new_v4().to_string();
        {
            let mut pending_map = pending
                .0
                .lock()
                .map_err(|_| "native pairing credential state unavailable".to_string())?;
            let now = SystemTime::now();
            pending_map.retain(|_, entry| entry.expires_at > now);
            if pending_map.len() >= 128 {
                return Err("native pairing credential capacity reached"
                    .to_string()
                    .into());
            }
            pending_map.insert(
                handle.clone(),
                PendingPairingCredential {
                    credential: exchange.credential,
                    reference: reference.clone(),
                    exact_origin: origin.clone(),
                    environment_id: exchange.environment_id.clone(),
                    client_instance_id: client_instance_id.clone(),
                    expires_at: now + Duration::from_secs(120),
                    phase: NativePairingPhase::AwaitingRequiresAuth,
                },
            );
        }

        let now_ms = now_millis_f64()?;
        let requires_auth_contents = local_self_provision_next_store(
            &store,
            store.revision + 1,
            &profile_name,
            &reference,
            &exchange.environment_id,
            "requires-auth",
            now_ms,
            &client_instance_id,
        )?;
        station_profile_store_write_internal(
            &app,
            &authority,
            &pending,
            requires_auth_contents,
            store.revision,
            Some(handle.clone()),
        )?;

        credential_vault_commit_pairing_internal(&app, &authority, &pending, &handle).map_err(|_| {
        NativeCommandError::new(
            "credential_replacement_write_failed",
            "Station could not save its replacement credential. Unlock your keychain or credential store, then relaunch Station.",
        )
    })?;

        let configured_contents = local_self_provision_next_store(
            &store,
            store.revision + 2,
            &profile_name,
            &reference,
            &exchange.environment_id,
            "configured",
            now_ms,
            &client_instance_id,
        )?;
        station_profile_store_write_internal(
            &app,
            &authority,
            &pending,
            configured_contents,
            store.revision + 1,
            Some(handle),
        )?;
        station_profile_authorize_active_internal(&app, &authority, &profile_name)?;
        Ok(())
    };
    if profile_already_locally_provisioned(profile, read_credential_for_eligibility) {
        // A readable keychain item is only locally healthy. Before retaining
        // it, ask one bounded protected same-origin endpoint from Rust. This
        // reaches neither the WebView nor the generic connection scheduler,
        // so a disconnected UI cannot suppress the evidence we need here.
        let readable = profile
            .credential_ref
            .as_ref()
            .and_then(|reference| credential_entry(reference).ok())
            .and_then(|entry| entry.get_password().ok());
        if let Some(credential) = readable {
            let probe = probe_local_credential(&origin, &credential);
            return match exchange_after_readable_credential_probe(
                probe,
                &client_instance_id,
                |validated_client_instance_id| {
                    debug_assert_eq!(validated_client_instance_id, client_instance_id);
                    reprovision()
                },
            ) {
                Ok(result) => result,
                Err(ReadableCredentialRecoveryDecision::Retain) => Err(NativeCommandError::new(
                    "local_profile_already_provisioned",
                    "the selected Station credential is still accepted",
                )),
                Err(ReadableCredentialRecoveryDecision::Refuse) => Err(NativeCommandError::new(
                    "local_credential_probe_inconclusive",
                    "Station could not validate its saved credential; it was left unchanged",
                )),
                Err(ReadableCredentialRecoveryDecision::Reprovision) => unreachable!(),
            };
        } else {
            return Err(NativeCommandError::new(
                "local_profile_already_provisioned",
                "the selected Station is already configured, or its credential store is temporarily unavailable",
            ));
        }
    }
    reprovision()
}

/// Start delivering notifications from the host rather than the webview.
///
/// The web layer already sees every notification over SSE, but that stream is
/// suspended with the webview when the app is backgrounded, and SSE events are
/// not replayed — so notifications raised while the user was elsewhere were
/// lost, not delayed. Device testing showed exactly that. This poller runs in
/// the host process, which keeps going while the webview is paused.
///
/// **Dormant: nothing calls this — see #943.** Android freezes the whole cached
/// process when the app is backgrounded, so this thread stops there too; the
/// foreground service that would prevent that is blocked by tauri#11609; and
/// native Rust cannot resolve DNS on Android at all. Registered so the seam
/// exists for push (#917) — see docs/design/notification-delivery.md.
///
/// `async` deliberately: a plain `fn` command is `ExecutionContext::Blocking`,
/// which Tauri runs on the **main thread**. The first poll below can take up to
/// the request timeout, and blocking the main thread that long on Android is an
/// ANR, not a pause.
#[tauri::command]
async fn notification_watch_start(
    app: AppHandle,
    url: String,
    credential: String,
) -> Result<(), String> {
    if url.trim().is_empty() || credential.trim().is_empty() {
        return Err("url and credential are required".to_string());
    }
    let watch = app.state::<notification_watch::NotificationWatch>();
    let stop = watch.restart();
    let handle = app.clone();

    // Poll once before returning, and hand any failure back to the caller.
    //
    // The loop below has to swallow errors — offline, asleep, a rotated
    // credential all recover on the next tick — but swallowing *every* error
    // meant a watch that failed 100% of its polls looked exactly like a
    // working one. That is how a build with no TLS backend compiled in, unable
    // to reach any HTTPS Station, reported success and stayed silent. A watch
    // that cannot do its first poll is a configuration problem, not a blip, so
    // it is reported rather than retried into the void.
    //
    // On the blocking pool: `poll_once` is synchronous IO, so awaiting it
    // directly would tie up an async worker for the whole request timeout.
    let probe_url = url.clone();
    let probe_credential = credential.clone();
    let seen = tauri::async_runtime::spawn_blocking(move || {
        let mut seen = std::collections::HashSet::new();
        notification_watch::poll_once(&probe_url, &probe_credential, &mut seen).map(|_| seen)
    })
    .await
    .map_err(|error| format!("notification watch probe did not run: {error}"))?
    .map_err(|error| format!("notification watch could not reach the Station: {error}"))?;

    std::thread::spawn(move || {
        use tauri_plugin_notification::NotificationExt;
        // Carries the primed set from the synchronous poll above, so history
        // is not dumped into the tray on the first tick.
        let mut seen = seen;
        while !stop.load(std::sync::atomic::Ordering::SeqCst) {
            std::thread::sleep(notification_watch::poll_interval());
            match notification_watch::poll_once(&url, &credential, &mut seen) {
                Ok(fresh) => {
                    for (title, body) in fresh {
                        let mut builder = handle.notification().builder().title(title);
                        if let Some(body) = body {
                            builder = builder.body(body);
                        }
                        // A failed post must not end the watch.
                        let _ = builder.show();
                    }
                }
                Err(error) => {
                    // Transient by assumption — the first poll already proved
                    // the endpoint and credential work. The next tick
                    // recovers, so this stays at debug rather than warn.
                    log::debug!("Station notification watch poll failed (will retry): {error}");
                }
            }
        }
    });

    log::info!("Station notification watch started");
    Ok(())
}

#[tauri::command]
fn notification_watch_stop(app: AppHandle) {
    app.state::<notification_watch::NotificationWatch>().stop();
    log::info!("Station notification watch stopped");
}

#[tauri::command]
fn native_capability_report(app: AppHandle) -> NativeCapabilityReport {
    compile_target_capability_report(&app.config().identifier)
}

#[cfg(not(mobile))]
const LOCAL_BROWSER_PREVIEW_URL_MAX_BYTES: usize = 2048;
#[cfg(not(mobile))]
const LOCAL_BROWSER_PREVIEW_GRANT_TTL: Duration = Duration::from_secs(60);
#[cfg(not(mobile))]
const LOCAL_BROWSER_PREVIEW_PROBE_DEADLINE: Duration = Duration::from_secs(1);

#[cfg(not(mobile))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct NativeBrowserPreviewWindowRequest {
    grant_id: String,
}

/// The React host supplies only catalog-issued workspace identity. This native
/// boundary builds the Station route; it does not retain a native handle or
/// any window presentation state.

#[cfg(not(mobile))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct NativeWorkspacePanePopOutRequest {
    project_id: String,
    project_slug: String,
    layout_id: String,
    descriptor_id: String,
    instance_id: String,
}

#[cfg(not(mobile))]
const WORKSPACE_PANE_POPOUT_SEGMENT_MAX_BYTES: usize = 512;

#[cfg(not(mobile))]
fn workspace_pane_pop_out_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= WORKSPACE_PANE_POPOUT_SEGMENT_MAX_BYTES
        && value == value.trim()
        && !value.chars().any(char::is_control)
}

#[cfg(not(mobile))]
fn workspace_pane_pop_out_route(
    request: &NativeWorkspacePanePopOutRequest,
) -> Result<String, String> {
    if ![
        &request.project_id,
        &request.project_slug,
        &request.layout_id,
        &request.descriptor_id,
        &request.instance_id,
    ]
    .iter()
    .all(|value| workspace_pane_pop_out_segment(value))
    {
        return Err("Station refused the malformed workspace pane identity.".to_string());
    }
    let encode = |value: &str| {
        url::form_urlencoded::byte_serialize(value.as_bytes())
            .collect::<String>()
            .replace('+', "%20")
    };
    Ok(format!(
        "/projects/{}/layouts/{}/panes/{}/{}?projectId={}",
        encode(&request.project_slug),
        encode(&request.layout_id),
        encode(&request.descriptor_id),
        encode(&request.instance_id),
        encode(&request.project_id),
    ))
}

/// A renderer may nominate a loopback address, but only the native host can
/// resolve and probe it. This is deliberately not a general network probe:
/// `browser_preview_origin` and `browser_preview_target_socket_addrs` both
/// reject anything that is not the exact local target shape.
#[cfg(not(mobile))]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct NativeBrowserPreviewDiscoveryRequest {
    url: String,
}

#[cfg(not(mobile))]
#[derive(Clone, Debug, PartialEq, Eq)]
struct BrowserPreviewOrigin {
    scheme: String,
    host: String,
    port: u16,
}

/// An observation is scoped to one ephemeral native target selection. It is
/// not durable Pane state and is intentionally precise about what a separate
/// WebviewWindow cannot inspect: it cannot read a page title/history or
/// observe an in-page frame's outcome.
#[cfg(not(mobile))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeBrowserPreviewObservation {
    reachability: &'static str,
    tls: &'static str,
    navigation: &'static str,
    frame: &'static str,
    renderer: &'static str,
    title: &'static str,
    history: &'static str,
}

#[cfg(not(mobile))]
impl NativeBrowserPreviewObservation {
    fn pending(target: &url::Url) -> Self {
        Self {
            reachability: "not-observed",
            // A TCP connection does not prove a TLS handshake, certificate,
            // or HTTP response. HTTP has no TLS layer to inspect.
            tls: if target.scheme() == "https" {
                "not-observed"
            } else {
                "not-applicable"
            },
            navigation: "not-observed",
            frame: "not-applicable",
            renderer: "not-created",
            title: "not-observable",
            history: "not-observable",
        }
    }

    fn with_reachability(target: &url::Url, reachability: &'static str) -> Self {
        Self {
            reachability,
            ..Self::pending(target)
        }
    }

    fn renderer_created(&self) -> Self {
        Self {
            // This reports only that Tauri created the separate renderer and
            // installed the native navigation policy. It says nothing about a
            // response, final page, title, history, or renderer health.
            navigation: "policy-installed",
            renderer: "created-unverified",
            ..self.clone()
        }
    }
}

#[cfg(not(mobile))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
enum NativeBrowserPreviewWindowResponse {
    Opened {
        session_id: String,
        observation: NativeBrowserPreviewObservation,
    },
    Rejected {
        code: &'static str,
        message: String,
    },
}

#[cfg(not(mobile))]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
enum NativeBrowserPreviewGrantResponse {
    Issued {
        grant_id: String,
        expires_at_ms: u64,
        observation: NativeBrowserPreviewObservation,
    },
    Rejected {
        code: &'static str,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        observation: Option<NativeBrowserPreviewObservation>,
    },
}

#[cfg(not(mobile))]
#[derive(Clone, Debug)]
struct NativeBrowserPreviewGrantRecord {
    target: url::Url,
    target_origin: BrowserPreviewOrigin,
    service_endpoint: String,
    expires_at: SystemTime,
    observation: NativeBrowserPreviewObservation,
}

/// Native-only lifecycle state. Pending grants expire rapidly; consumed ids
/// keep replay fail-closed through that expiry, while an active target+endpoint
/// binding remains until its native window is destroyed. Nothing here is
/// serialized or restored after a shell restart.
#[cfg(not(mobile))]
#[derive(Clone, Default)]
struct NativeBrowserPreviewGrants(std::sync::Arc<std::sync::Mutex<NativeBrowserPreviewGrantState>>);

#[cfg(not(mobile))]
#[derive(Default)]
struct NativeBrowserPreviewGrantState {
    pending: std::collections::HashMap<String, NativeBrowserPreviewGrantRecord>,
    consumed: std::collections::HashMap<String, SystemTime>,
    active: std::collections::HashMap<String, NativeBrowserPreviewGrantRecord>,
}

#[cfg(not(mobile))]
fn browser_preview_rejected(
    code: &'static str,
    message: impl Into<String>,
) -> NativeBrowserPreviewWindowResponse {
    NativeBrowserPreviewWindowResponse::Rejected {
        code,
        message: message.into(),
    }
}

#[cfg(not(mobile))]
fn browser_preview_grant_rejected(
    code: &'static str,
    message: impl Into<String>,
) -> NativeBrowserPreviewGrantResponse {
    NativeBrowserPreviewGrantResponse::Rejected {
        code,
        message: message.into(),
        observation: None,
    }
}

#[cfg(not(mobile))]
fn browser_preview_grant_observation_rejected(
    code: &'static str,
    message: impl Into<String>,
    observation: NativeBrowserPreviewObservation,
) -> NativeBrowserPreviewGrantResponse {
    NativeBrowserPreviewGrantResponse::Rejected {
        code,
        message: message.into(),
        observation: Some(observation),
    }
}

/// Canonicalize the only URL shape the desktop browser-preview action may
/// leave Station with. This validation is intentionally repeated at the Rust
/// authority boundary rather than trusting webview-side parsing.
#[cfg(not(mobile))]
fn normalize_local_browser_preview_url(requested: &str) -> Result<String, String> {
    if requested.is_empty() || requested.len() > LOCAL_BROWSER_PREVIEW_URL_MAX_BYTES {
        return Err("The local preview URL is missing or exceeds the allowed size.".to_owned());
    }
    let url = url::Url::parse(requested)
        .map_err(|_| "The local preview URL must be an absolute HTTP(S) URL.".to_owned())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Only HTTP(S) local preview URLs are allowed.".to_owned());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Local preview URLs cannot include credentials.".to_owned());
    }
    if url.fragment().is_some() {
        return Err("Local preview URLs cannot include fragments.".to_owned());
    }
    if !browser_preview_external_target_allowed(&url) {
        return Err("Local preview URLs must use an exact loopback host.".to_owned());
    }
    Ok(url.to_string())
}

/// The system-browser action never probes or embeds this destination, so it
/// can retain the user-facing `localhost` spelling. Native discovery and the
/// isolated preview window use the stricter numeric-only origin below.
#[cfg(not(mobile))]
fn browser_preview_external_target_allowed(url: &url::Url) -> bool {
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    match url.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(host)) => host.is_loopback(),
        Some(url::Host::Ipv6(host)) => host.is_loopback(),
        None => false,
    }
}

#[cfg(not(mobile))]
fn normalize_numeric_local_browser_preview_url(requested: &str) -> Result<String, String> {
    let normalized = normalize_local_browser_preview_url(requested)?;
    let url = url::Url::parse(&normalized).map_err(|_| {
        "Station could not parse the approved local Browser Preview target.".to_owned()
    })?;
    if browser_preview_origin(&url).is_none() {
        return Err(
            "Desktop Browser Preview requires a numeric loopback host (127.0.0.0/8 or ::1). Use the system-browser action for localhost."
                .to_owned(),
        );
    }
    Ok(normalized)
}

/// Returns the only origin a Browser Preview renderer may navigate within.
/// The initial URL additionally rejects fragments, but a same-origin fragment
/// navigation is harmless and may be required by a client-side development
/// app, so the navigation policy evaluates origin rather than full path.
#[cfg(not(mobile))]
fn browser_preview_origin(url: &url::Url) -> Option<BrowserPreviewOrigin> {
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return None;
    }
    let loopback = match url.host() {
        Some(url::Host::Ipv4(host)) => host.is_loopback(),
        Some(url::Host::Ipv6(host)) => host.is_loopback(),
        None => false,
        _ => false,
    };
    if !loopback {
        return None;
    }
    Some(BrowserPreviewOrigin {
        scheme: url.scheme().to_owned(),
        host: url.host_str()?.to_ascii_lowercase(),
        port: url.port_or_known_default()?,
    })
}

#[cfg(not(mobile))]
fn browser_preview_navigation_allowed(
    approved_origin: &BrowserPreviewOrigin,
    navigation: &url::Url,
) -> bool {
    browser_preview_origin(navigation).is_some_and(|candidate| candidate == *approved_origin)
}

#[cfg(not(mobile))]
/// Browser Preview accepts one literal loopback address. Domain names never
/// enter native discovery, so neither DNS state nor a resolver race can alter
/// the target after URL admission.
#[cfg(not(mobile))]
fn browser_preview_target_socket_addr(target: &url::Url) -> Option<SocketAddr> {
    let port = target.port_or_known_default()?;
    match target.host() {
        Some(url::Host::Ipv4(host)) if host.is_loopback() => {
            Some(SocketAddr::new(host.into(), port))
        }
        Some(url::Host::Ipv6(host)) if host.is_loopback() => {
            Some(SocketAddr::new(host.into(), port))
        }
        _ => None,
    }
}

/// A bounded native probe observes TCP reachability only. It does not make an
/// HTTP request, follow a redirect, offer headers/cookies, or establish TLS;
/// the result therefore remains deliberately narrower than browser health.
#[cfg(not(mobile))]
fn discover_browser_preview_target(target: &url::Url) -> NativeBrowserPreviewObservation {
    let Some(address) = browser_preview_target_socket_addr(target) else {
        return NativeBrowserPreviewObservation::with_reachability(target, "unreachable");
    };
    match TcpStream::connect_timeout(&address, LOCAL_BROWSER_PREVIEW_PROBE_DEADLINE) {
        Ok(_) => NativeBrowserPreviewObservation::with_reachability(target, "reachable"),
        Err(error) if error.kind() == std::io::ErrorKind::ConnectionRefused => {
            NativeBrowserPreviewObservation::with_reachability(target, "refused")
        }
        Err(_) => NativeBrowserPreviewObservation::with_reachability(target, "unreachable"),
    }
}

#[cfg(not(mobile))]
fn expires_at_ms(value: SystemTime) -> u64 {
    value
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

#[cfg(not(mobile))]
fn issue_browser_preview_grant(
    requested_url: &str,
    service_endpoint: &str,
    now: SystemTime,
    grants: &NativeBrowserPreviewGrants,
    observation: NativeBrowserPreviewObservation,
) -> NativeBrowserPreviewGrantResponse {
    if observation.reachability != "reachable" {
        return browser_preview_grant_observation_rejected(
            "target-unreachable",
            "Station refused to authorize a Browser Preview target that was not reached by native discovery.",
            observation,
        );
    }
    let approved_target = match normalize_numeric_local_browser_preview_url(requested_url) {
        Ok(target) => target,
        Err(message) => return browser_preview_grant_rejected("invalid-target", message),
    };
    let target = match url::Url::parse(&approved_target) {
        Ok(target) => target,
        Err(_) => {
            return browser_preview_grant_rejected(
                "invalid-target",
                "Station could not parse the approved local Browser Preview target.",
            )
        }
    };
    let target_origin = match browser_preview_origin(&target) {
        Some(origin) => origin,
        None => {
            return browser_preview_grant_rejected(
                "invalid-target",
                "Station refused the non-loopback Browser Preview target.",
            )
        }
    };
    if normalize_local_browser_preview_url(service_endpoint).is_err() {
        return browser_preview_grant_rejected(
            "authority-unavailable",
            "Station's configured local service is not an approved loopback endpoint.",
        );
    }
    let expires_at = now + LOCAL_BROWSER_PREVIEW_GRANT_TTL;
    let grant_id = uuid::Uuid::new_v4().to_string();
    let record = NativeBrowserPreviewGrantRecord {
        target,
        target_origin,
        service_endpoint: service_endpoint.to_owned(),
        expires_at,
        observation: observation.clone(),
    };
    let Ok(mut state) = grants.0.lock() else {
        return browser_preview_grant_rejected(
            "renderer-unavailable",
            "Station could not retain the Browser Preview grant.",
        );
    };
    state.pending.retain(|_, entry| entry.expires_at > now);
    state.consumed.retain(|_, expires_at| *expires_at > now);
    state.pending.insert(grant_id.clone(), record);
    NativeBrowserPreviewGrantResponse::Issued {
        grant_id,
        expires_at_ms: expires_at_ms(expires_at),
        observation,
    }
}

#[cfg(not(mobile))]
fn consume_browser_preview_grant(
    grant_id: &str,
    now: SystemTime,
    grants: &NativeBrowserPreviewGrants,
) -> Result<NativeBrowserPreviewGrantRecord, NativeBrowserPreviewWindowResponse> {
    let Ok(mut state) = grants.0.lock() else {
        return Err(browser_preview_rejected(
            "renderer-unavailable",
            "Station could not read the Browser Preview grant.",
        ));
    };
    if let Some(expires_at) = state.consumed.get(grant_id) {
        return Err(browser_preview_rejected(
            if *expires_at > now {
                "grant-consumed"
            } else {
                "grant-expired"
            },
            "Station refused the previously consumed or expired Browser Preview grant.",
        ));
    }
    let Some(grant) = state.pending.remove(grant_id) else {
        return Err(browser_preview_rejected(
            "invalid-grant",
            "Station refused the unknown Browser Preview grant.",
        ));
    };
    state.consumed.insert(grant_id.to_owned(), grant.expires_at);
    if grant.expires_at <= now {
        return Err(browser_preview_rejected(
            "grant-expired",
            "Station refused the expired Browser Preview grant.",
        ));
    }
    // Revalidate the retained native authority when consuming. This keeps a
    // corrupted or future-mutated record fail-closed instead of turning a
    // previously issued grant into a generic renderer capability.
    if normalize_local_browser_preview_url(&grant.service_endpoint).is_err() {
        return Err(browser_preview_rejected(
            "authority-unavailable",
            "Station refused a Browser Preview grant without a bounded local service authority.",
        ));
    }
    Ok(grant)
}

#[cfg(not(mobile))]
fn bind_active_browser_preview_grant(
    label: &str,
    grant: NativeBrowserPreviewGrantRecord,
    grants: &NativeBrowserPreviewGrants,
) {
    if let Ok(mut state) = grants.0.lock() {
        state.active.insert(label.to_owned(), grant);
    }
}

#[cfg(not(mobile))]
fn close_active_browser_preview_grant(label: &str, grants: &NativeBrowserPreviewGrants) {
    if let Ok(mut state) = grants.0.lock() {
        state.active.remove(label);
    }
}

#[cfg(not(mobile))]
fn open_local_browser_preview_with(
    requested: &str,
    opener: impl FnOnce(&str) -> Result<(), String>,
) -> Result<(), String> {
    let approved = normalize_local_browser_preview_url(requested)?;
    opener(&approved).map_err(|error| format!("Station could not open the local preview: {error}"))
}

/// Opens a revalidated loopback target in the operating system's browser.
///
/// This command is intentionally not a renderer: Station cannot inspect or
/// constrain redirects after the operating system browser receives the URL.
#[cfg(not(mobile))]
#[tauri::command]
fn open_local_browser_preview(app: AppHandle, url: String) -> Result<(), String> {
    open_local_browser_preview_with(&url, |approved| {
        app.opener()
            .open_url(approved, None::<&str>)
            .map_err(|error| error.to_string())
    })
}

/// Opens only the closed GitHub work-item locator admitted by the MCP host.
/// The WebView never receives generic opener authority.
#[tauri::command]
fn open_external_link(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| "invalid external URL".to_string())?;
    let segments: Vec<_> = parsed
        .path_segments()
        .map(|segments| segments.collect())
        .unwrap_or_default();
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || parsed.port().is_some()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || segments.len() != 4
        || segments[0].is_empty()
        || segments[1].is_empty()
        || segments[2] != "issues"
        || segments[3]
            .parse::<u64>()
            .ok()
            .filter(|number| *number > 0)
            .is_none()
    {
        return Err("Station refused an unrecognized external work-item URL".to_string());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}

/// Discover and select exactly one reachable local preview target. The native
/// service authority must be running first; the UI cannot nominate a remote
/// connection, a session endpoint, or a pre-existing renderer as authority.
/// A reachable result is immediately represented by the one-time grant that
/// the separate-window command consumes, so a later caller cannot retarget it.
#[cfg(not(mobile))]
#[tauri::command]
fn discover_local_browser_preview_target(
    app: AppHandle,
    request: NativeBrowserPreviewDiscoveryRequest,
    grants: State<'_, NativeBrowserPreviewGrants>,
) -> NativeBrowserPreviewGrantResponse {
    let service = unified_server_status(&app);
    let Some(service_endpoint) = service
        .api_base
        .filter(|_| matches!(service.phase, bundled_server_state::ServerPhase::Running))
    else {
        return browser_preview_grant_rejected(
            "authority-unavailable",
            "Station's local service is not running at a bounded loopback endpoint.",
        );
    };
    let approved_target = match normalize_numeric_local_browser_preview_url(&request.url) {
        Ok(value) => value,
        Err(message) => return browser_preview_grant_rejected("invalid-target", message),
    };
    let target = match url::Url::parse(&approved_target) {
        Ok(target) => target,
        Err(_) => {
            return browser_preview_grant_rejected(
                "invalid-target",
                "Station could not parse the approved local Browser Preview target.",
            )
        }
    };
    let observation = discover_browser_preview_target(&target);
    match observation.reachability {
        "reachable" => issue_browser_preview_grant(
            &approved_target,
            &service_endpoint,
            SystemTime::now(),
            grants.inner(),
            observation,
        ),
        "refused" => browser_preview_grant_observation_rejected(
            "target-refused",
            "Station reached the selected loopback address, but the local server refused the connection.",
            observation,
        ),
        "dns-failed" => browser_preview_grant_observation_rejected(
            "target-dns-failed",
            "Station could not resolve the selected loopback address to a local target.",
            observation,
        ),
        _ => browser_preview_grant_observation_rejected(
            "target-unreachable",
            "Station could not reach the selected local server within the bounded probe.",
            observation,
        ),
    }
}

/// Opens one isolated desktop renderer for a freshly-authorized local target.
/// The dynamic window receives no Station command capability: its label is not
/// in `capabilities/default.json`. Navigation is constrained at the native
/// edge to the exact approved loopback origin; popups and downloads are denied
/// rather than handed to an external opener. No URL, session, native window
/// handle, geometry, cookie store, or renderer-health fact is persisted.
#[cfg(not(mobile))]
#[tauri::command]
fn open_local_browser_preview_window(
    app: AppHandle,
    request: NativeBrowserPreviewWindowRequest,
    grants: State<'_, NativeBrowserPreviewGrants>,
) -> NativeBrowserPreviewWindowResponse {
    let grant_store = grants.inner().clone();
    let grant =
        match consume_browser_preview_grant(&request.grant_id, SystemTime::now(), &grant_store) {
            Ok(grant) => grant,
            Err(response) => return response,
        };
    let session_id = request.grant_id;
    let label = format!("browser-preview-{session_id}");
    let origin = grant.target_origin.clone();
    let response =
        WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(grant.target.clone()))
            .title("Station Browser Preview")
            // This renderer never reuses Station's persistent browser store.
            .incognito(true)
            .on_navigation(move |navigation| {
                browser_preview_navigation_allowed(&origin, navigation)
            })
            .on_new_window(|_, _| NewWindowResponse::Deny)
            // A preview has no file-export contract. Deny every request at the
            // native edge instead of leaking it to a system browser.
            .on_download(|_, _event: DownloadEvent<'_>| false)
            .build();
    match response {
        Ok(window) => {
            let observation = grant.observation.renderer_created();
            bind_active_browser_preview_grant(&label, grant, &grant_store);
            let active_label = label.clone();
            let active_grants = grant_store.clone();
            window.on_window_event(move |event| {
                if matches!(event, WindowEvent::Destroyed) {
                    close_active_browser_preview_grant(&active_label, &active_grants);
                }
            });
            NativeBrowserPreviewWindowResponse::Opened {
                session_id,
                observation,
            }
        }
        Err(error) => browser_preview_rejected(
            "renderer-unavailable",
            format!("Station could not create the desktop Browser Preview: {error}"),
        ),
    }
}

/// Opens a Station-routed desktop window for one exact catalog pane. The app
/// document remains the packaged index while the initialization script sets
/// its route before React reads it. The request, route, and native window are
/// all transient; this command deliberately writes no native state.
#[cfg(not(mobile))]
#[tauri::command]
fn open_workspace_pane_pop_out(
    app: AppHandle,
    request: NativeWorkspacePanePopOutRequest,
) -> Result<(), String> {
    let route = workspace_pane_pop_out_route(&request)?;
    let route_json = serde_json::to_string(&route)
        .map_err(|_| "Station could not encode the workspace pane route.".to_string())?;
    let label = format!("workspace-pane-pop-out-{}", uuid::Uuid::new_v4());
    WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("Station workspace pane")
        .initialization_script(format!(
            "window.history.replaceState(null, '', {route_json});"
        ))
        .build()
        .map(|_| ())
        .map_err(|error| format!("Station could not create the workspace pane window: {error}"))
}

// Phase 2: this is deliberately an attach-before-spawn seam only. It does not
// start a process or alter desktop status; later phases own that wiring.
#[cfg(not(mobile))]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct RegistryInstanceEntry {
    id: String,
    #[serde(rename = "type")]
    instance_type: String,
    port: Option<u16>,
    pid: Option<u32>,
    pid_alive: Option<bool>,
}

#[cfg(not(mobile))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryBridgeReadResponse {
    ok: bool,
    instances: Option<Vec<RegistryInstanceEntry>>,
    error: Option<RegistryBridgeErrorPayload>,
}

#[cfg(not(mobile))]
#[derive(Clone, Debug, Deserialize)]
struct RegistryBridgeErrorPayload {
    code: String,
}

/// The only successful result the desktop accepts from the legacy-home
/// preparation bridge.  This stays deliberately path-free: the native shell
/// needs the outcome, not a filesystem narration it could accidentally log.
#[cfg(not(mobile))]
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum PrepareRuntimeKind {
    Absent,
    New,
    Already,
    Recovered,
}

#[cfg(not(mobile))]
impl PrepareRuntimeKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Absent => "absent",
            Self::New => "new",
            Self::Already => "already",
            Self::Recovered => "recovered",
        }
    }
}

#[cfg(not(mobile))]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct PrepareRuntimeBridgeResponse {
    ok: bool,
    kind: PrepareRuntimeKind,
}

#[cfg(not(mobile))]
#[derive(Clone, Debug, PartialEq, Eq)]
enum RegistryBridgeFailure {
    Untrusted,
    Protocol,
    Invocation,
}

#[cfg(not(mobile))]
#[cfg(not(mobile))]
#[derive(Clone, Debug, PartialEq, Eq)]
enum HomeOwnershipDecision {
    ServiceOwnsHome { id: String, port: u16 },
    SpawnSidecar,
    AmbiguousOwnership,
    FailClosedRegistry,
}

/// Desktop never programmatically trusts an unverified loopback listener as
/// its backend. A live durable-service registry entry owns the home; opening
/// that service is a user decision, not an automatic attachment.
#[cfg(not(mobile))]
fn decide_home_ownership(
    registry: Result<&[RegistryInstanceEntry], RegistryBridgeFailure>,
) -> HomeOwnershipDecision {
    let entries = match registry {
        Ok(entries) => entries,
        Err(RegistryBridgeFailure::Untrusted) => return HomeOwnershipDecision::FailClosedRegistry,
        Err(_) => return HomeOwnershipDecision::FailClosedRegistry,
    };
    let live_services = entries
        .iter()
        .filter(|entry| {
            entry.instance_type == "service"
                && entry.port.is_some()
                && entry.pid.is_some()
                && entry.pid_alive == Some(true)
        })
        .collect::<Vec<_>>();
    match live_services.as_slice() {
        [] => HomeOwnershipDecision::SpawnSidecar,
        [entry] => HomeOwnershipDecision::ServiceOwnsHome {
            id: entry.id.clone(),
            port: entry.port.expect("live service requires port"),
        },
        _ => HomeOwnershipDecision::AmbiguousOwnership,
    }
}

#[cfg(not(mobile))]
fn registry_bridge_script_path(resource_dir: &Path) -> PathBuf {
    resource_dir
        .join("dist-server")
        .join("instance-registry-bridge.js")
}

/// Calls the packaged bridge, never the registry file. The returned failure is
/// deliberately typed and path-free because the child protocol is redacted.
#[cfg(not(mobile))]
fn read_registry_bridge(
    resource_dir: &Path,
    station_home: &Path,
) -> Result<Vec<RegistryInstanceEntry>, RegistryBridgeFailure> {
    let output = invoke_registry_bridge(
        resource_dir,
        "read",
        serde_json::json!({ "home": station_home }),
    )?;
    let response: RegistryBridgeReadResponse =
        serde_json::from_slice(&output).map_err(|_| RegistryBridgeFailure::Protocol)?;
    if response.ok {
        return response.instances.ok_or(RegistryBridgeFailure::Protocol);
    }
    Err(registry_bridge_error(&response))
}

#[cfg(not(mobile))]
fn registry_bridge_error(response: &RegistryBridgeReadResponse) -> RegistryBridgeFailure {
    match response.error.as_ref().map(|error| error.code.as_str()) {
        Some("REGISTRY_UNTRUSTED") => RegistryBridgeFailure::Untrusted,
        _ => RegistryBridgeFailure::Protocol,
    }
}

#[cfg(not(mobile))]
const MAX_REGISTRY_BRIDGE_OUTPUT_BYTES: usize = 4 * 1024;

/// Parse one success-only, bounded preparation result.  A refusal is emitted
/// with a nonzero child exit and therefore never reaches this parser.
#[cfg(not(mobile))]
fn parse_prepare_runtime_bridge_output(
    output: &[u8],
) -> Result<PrepareRuntimeKind, RegistryBridgeFailure> {
    if output.len() > MAX_REGISTRY_BRIDGE_OUTPUT_BYTES {
        return Err(RegistryBridgeFailure::Protocol);
    }
    let response: PrepareRuntimeBridgeResponse =
        serde_json::from_slice(output).map_err(|_| RegistryBridgeFailure::Protocol)?;
    if response.ok {
        Ok(response.kind)
    } else {
        Err(RegistryBridgeFailure::Protocol)
    }
}

/// Prepare an already native-derived runtime home before the desktop reads
/// ownership or claims a sidecar slot.  The bridge receives both exact native
/// paths; it never derives either from its own process environment.
#[cfg(not(mobile))]
fn prepare_runtime_registry_bridge(
    resource_dir: &Path,
    station_root: &Path,
    station_home: &Path,
) -> Result<PrepareRuntimeKind, RegistryBridgeFailure> {
    let output = invoke_registry_bridge(
        resource_dir,
        "prepareRuntime",
        serde_json::json!({ "home": station_home, "root": station_root }),
    )?;
    parse_prepare_runtime_bridge_output(&output)
}

/// Capture bridge stdout without allowing a hostile or malformed child to grow
/// native memory.  Continue draining after the cap so a completed child cannot
/// be left blocked on its pipe; callers reject the retained cap-plus-one value.
#[cfg(not(mobile))]
fn capture_bounded_registry_bridge_stdout(mut stdout: ChildStdout) -> std::io::Result<Vec<u8>> {
    let mut retained = Vec::with_capacity(MAX_REGISTRY_BRIDGE_OUTPUT_BYTES + 1);
    let mut chunk = [0_u8; 1024];
    loop {
        let read = stdout.read(&mut chunk)?;
        if read == 0 {
            return Ok(retained);
        }
        let remaining = (MAX_REGISTRY_BRIDGE_OUTPUT_BYTES + 1).saturating_sub(retained.len());
        retained.extend_from_slice(&chunk[..read.min(remaining)]);
    }
}

/// Reap the bridge child before a caller joins its stdout reader. This is
/// deliberately best-effort cleanup: the original operation still reports its
/// own typed failure, but no failure path leaves a pipe-draining thread joined
/// against a live child.
#[cfg(not(mobile))]
fn terminate_registry_bridge_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(mobile))]
fn registry_bridge_poll_result(
    child: &mut Child,
    poll: std::io::Result<Option<ExitStatus>>,
) -> Result<Option<ExitStatus>, RegistryBridgeFailure> {
    match poll {
        Ok(status) => Ok(status),
        Err(_) => {
            terminate_registry_bridge_child(child);
            Err(RegistryBridgeFailure::Invocation)
        }
    }
}

#[cfg(not(mobile))]
fn write_registry_bridge_input(
    writer: &mut dyn Write,
    input: &[u8],
) -> Result<(), RegistryBridgeFailure> {
    writer
        .write_all(input)
        .map_err(|_| RegistryBridgeFailure::Invocation)
}

/// Every registry bridge operation is bounded. `prepareRuntime` uses the same
/// watchdog now that the shared v2 profile lock can immediately reclaim an
/// owner proven dead or PID-reused after a parent kill.
#[cfg(not(mobile))]
fn wait_for_registry_bridge_child(
    child: &mut Child,
    _operation: &str,
    timeout: Duration,
) -> Result<ExitStatus, RegistryBridgeFailure> {
    let started = std::time::Instant::now();
    loop {
        let poll = child.try_wait();
        if let Some(status) = registry_bridge_poll_result(child, poll)? {
            return Ok(status);
        }
        if started.elapsed() >= timeout {
            terminate_registry_bridge_child(child);
            return Err(RegistryBridgeFailure::Invocation);
        }
        thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(not(mobile))]
fn invoke_registry_bridge(
    resource_dir: &Path,
    operation: &str,
    input: serde_json::Value,
) -> Result<Vec<u8>, RegistryBridgeFailure> {
    let shell_path = resolve_login_shell_path();
    let mut command = build_registry_bridge_command(resource_dir, operation, &shell_path);
    let mut child = command
        .spawn()
        .map_err(|_| RegistryBridgeFailure::Invocation)?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            terminate_registry_bridge_child(&mut child);
            return Err(RegistryBridgeFailure::Invocation);
        }
    };
    let stdout_reader = thread::spawn(move || capture_bounded_registry_bridge_stdout(stdout));
    let write_result = match child.stdin.take() {
        Some(mut stdin) => write_registry_bridge_input(&mut stdin, input.to_string().as_bytes()),
        None => Err(RegistryBridgeFailure::Invocation),
    };
    if let Err(error) = write_result {
        terminate_registry_bridge_child(&mut child);
        let _ = stdout_reader.join();
        return Err(error);
    }
    // All bridge operations use the same bounded parent watchdog. A killed
    // preparation child leaves a v2 birth-aware profile lock that its next
    // acquisition can safely reclaim immediately.
    const BRIDGE_TIMEOUT: Duration = Duration::from_secs(10);
    let status = match wait_for_registry_bridge_child(&mut child, operation, BRIDGE_TIMEOUT) {
        Ok(status) => status,
        Err(error) => {
            // The waiter reaps on every error path. Keep this explicit before
            // joining so future waiter changes cannot reintroduce a live-child
            // join deadlock.
            terminate_registry_bridge_child(&mut child);
            let _ = stdout_reader.join();
            return Err(error);
        }
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| RegistryBridgeFailure::Invocation)?
        .map_err(|_| RegistryBridgeFailure::Invocation)?;
    if stdout.len() > MAX_REGISTRY_BRIDGE_OUTPUT_BYTES {
        return Err(RegistryBridgeFailure::Protocol);
    }
    if status.success() {
        Ok(stdout)
    } else {
        let response: RegistryBridgeReadResponse =
            serde_json::from_slice(&stdout).map_err(|_| RegistryBridgeFailure::Protocol)?;
        Err(registry_bridge_error(&response))
    }
}

#[cfg(not(mobile))]
#[cfg(not(mobile))]
fn supervisor_birth_bridge(
    resource_dir: &Path,
    station_home: &Path,
) -> Result<String, RegistryBridgeFailure> {
    let output = invoke_registry_bridge(
        resource_dir,
        "supervisorIdentity",
        serde_json::json!({ "home": station_home }),
    )?;
    let value: serde_json::Value =
        serde_json::from_slice(&output).map_err(|_| RegistryBridgeFailure::Protocol)?;
    value
        .get("birth")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or(RegistryBridgeFailure::Protocol)
}

/// The packaged Node bridge owns the cross-platform process-birth authority.
/// Native lock code deliberately asks that same authority rather than adding a
/// second Rust-specific liveness probe with different PID-reuse semantics.
#[cfg(not(mobile))]
fn profile_lock_birth_bridge(
    resource_dir: &Path,
    pid: u32,
) -> Result<String, RegistryBridgeFailure> {
    let output = invoke_registry_bridge(
        resource_dir,
        "profileLockIdentity",
        serde_json::json!({ "pid": pid }),
    )?;
    let value: serde_json::Value =
        serde_json::from_slice(&output).map_err(|_| RegistryBridgeFailure::Protocol)?;
    value
        .get("birth")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 512)
        .map(str::to_owned)
        .ok_or(RegistryBridgeFailure::Protocol)
}

#[cfg(not(mobile))]
fn claim_sidecar_registry_bridge(
    resource_dir: &Path,
    home: &Path,
    id: &str,
    instance: serde_json::Value,
) -> Result<bool, RegistryBridgeFailure> {
    let output = invoke_registry_bridge(
        resource_dir,
        "claimSidecar",
        serde_json::json!({"home":home,"id":id,"instance":instance}),
    )?;
    let value: serde_json::Value =
        serde_json::from_slice(&output).map_err(|_| RegistryBridgeFailure::Protocol)?;
    value
        .get("claimed")
        .and_then(serde_json::Value::as_bool)
        .ok_or(RegistryBridgeFailure::Protocol)
}

// Write counterparts are kept at the same narrow bridge seam for Phase 3's
// handshake/restart/teardown lifecycle wiring. They intentionally have no
// startup caller in Phase 2.
#[cfg(not(mobile))]
fn upsert_registry_bridge(
    resource_dir: &Path,
    home: &Path,
    id: &str,
    instance: serde_json::Value,
) -> Result<(), RegistryBridgeFailure> {
    invoke_registry_bridge(
        resource_dir,
        "upsert",
        serde_json::json!({ "home": home, "id": id, "instance": instance }),
    )
    .map(|_| ())
}

#[cfg(not(mobile))]
fn update_registry_status_bridge(
    resource_dir: &Path,
    home: &Path,
    id: &str,
    status: &str,
    pid: Option<u32>,
) -> Result<(), RegistryBridgeFailure> {
    invoke_registry_bridge(
        resource_dir,
        "updateStatus",
        serde_json::json!({ "home": home, "id": id, "status": status, "pid": pid }),
    )
    .map(|_| ())
}

#[cfg(not(mobile))]
fn remove_registry_bridge(
    resource_dir: &Path,
    home: &Path,
    id: &str,
) -> Result<(), RegistryBridgeFailure> {
    invoke_registry_bridge(
        resource_dir,
        "remove",
        serde_json::json!({ "home": home, "id": id }),
    )
    .map(|_| ())
}

#[cfg(not(mobile))]
#[cfg(not(mobile))]
fn decide_home_ownership_from_runtime(resource_dir: &Path, home: &Path) -> HomeOwnershipDecision {
    let entries = match read_registry_bridge(resource_dir, &home) {
        Ok(entries) => entries,
        Err(error) => return decide_home_ownership(Err(error)),
    };
    decide_home_ownership(Ok(&entries))
}

// Phase 1 launch context only. These helpers deliberately construct nothing
// that runs: later slices will connect them to the desktop-owned sidecar
// supervisor after the registry attach-before-spawn decision exists.
#[cfg(not(mobile))]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// The packaged resource directory must be normalized before Node sees it:
/// Windows verbatim paths (`\\?\`) are not accepted by Node's module resolver.
#[cfg(not(mobile))]
fn simplified_sidecar_resource_dir(resource_dir: &Path) -> PathBuf {
    dunce::simplified(resource_dir).to_path_buf()
}

/// Present packaged entrypoint for the desktop-owned Command Station sidecar.
#[cfg(not(mobile))]
fn command_station_script_path(resource_dir: &Path) -> PathBuf {
    resource_dir.join("dist-server").join("command-station.js")
}

/// PATH is the user's executable policy. Unix callers recover a login-shell
/// PATH before constructing the child command; this stays literal so we do
/// not guess between mise, nvm, Volta, system, or vendor Node installs.
#[cfg(not(mobile))]
fn find_node() -> String {
    "node".into()
}

/// Builds the registry bridge command with the same login-shell executable
/// policy as the sidecar. Packaged desktop launches do not inherit an
/// interactive terminal PATH, so invoking `node` before recovering it breaks
/// nvm/mise/Volta installations even though the sidecar itself can start.
#[cfg(not(mobile))]
fn build_registry_bridge_command(
    resource_dir: &Path,
    operation: &str,
    shell_path: &str,
) -> Command {
    let mut command = Command::new(find_node());
    command
        .arg(registry_bridge_script_path(resource_dir))
        .arg(operation)
        .env("PATH", shell_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    apply_no_window(&mut command);
    command
}

#[cfg(all(not(mobile), windows))]
fn resolve_login_shell_path() -> String {
    std::env::var("PATH").unwrap_or_default()
}

#[cfg(all(not(mobile), unix))]
fn resolve_login_shell_path() -> String {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    if let Ok(output) = Command::new(&shell)
        .args(["-ilc", "echo $PATH"])
        .stderr(Stdio::null())
        .output()
    {
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !path.is_empty() {
            return path;
        }
    }
    std::env::var("PATH").unwrap_or_default()
}

/// A base port reserves the server, terminal, voice, and consent four-port
/// block (station#3677). Invalid explicit configuration is an error: it must
/// never silently select a different pinned port.
#[cfg(not(mobile))]
fn parse_pinned_desktop_port(raw: Option<&str>) -> Result<Option<u16>, String> {
    let Some(raw) = raw else {
        return Ok(None);
    };
    let trimmed = raw.trim();
    let port = trimmed.parse::<u16>().map_err(|_| {
        format!("STATION_DESKTOP_PORT={trimmed:?} must be an integer between 1 and 65532")
    })?;
    if !(1..=65_532).contains(&port) {
        return Err(format!(
            "STATION_DESKTOP_PORT={trimmed:?} must be an integer between 1 and 65532"
        ));
    }
    Ok(Some(port))
}

/// Explicit desktop configuration wins over a packaged channel default. A
/// debug build has no packaged channel, so it remains in automatic mode unless
/// the developer explicitly supplied a port.
#[cfg(not(mobile))]
fn resolve_pinned_desktop_port(
    explicit_port: Option<&str>,
    packaged_channel: Option<&str>,
) -> Result<Option<u16>, String> {
    Ok(parse_pinned_desktop_port(explicit_port)?
        .or_else(|| channel_ports_generated::default_desktop_port(packaged_channel)))
}

#[cfg(not(mobile))]
#[derive(Clone, Debug, PartialEq, Eq)]
struct SidecarLaunchContext {
    resource_dir: PathBuf,
    station_root: PathBuf,
    station_home: PathBuf,
    home: String,
    shell_path: String,
    channel: Option<String>,
    pinned_port: Option<u16>,
    supervisor_birth: String,
    /// Stable across child restarts so `/api/system/identity` describes the
    /// channel installation, not an individual Node process.
    instance_id: String,
}

/// Builds, but does not spawn, a sidecar child command. Keeping this separate
/// makes the inherited-environment removals and loopback contract testable.
#[cfg(not(mobile))]
fn build_sidecar_command(context: &SidecarLaunchContext, boot_id: &str) -> Command {
    let mut command = Command::new(find_node());
    command
        .arg(command_station_script_path(&context.resource_dir))
        .current_dir(&context.resource_dir)
        .env("STATION_ROOT", &context.station_root)
        .env("STATION_HOME", &context.station_home)
        .env("STATION_HOST", "127.0.0.1")
        .env("STATION_STDOUT_HANDSHAKE", "1")
        .env("STATION_INSTANCE_ID", &context.instance_id)
        // A boot identifies one concrete Node process. Generate it at the
        // spawn boundary so every supervised restart rotates the value while
        // retaining the channel-scoped instance identity above.
        .env("STATION_BOOT_ID", boot_id)
        // Arm the server's existing parent watchdog.  The desktop process is
        // the supervisor; if it is force-killed, the sidecar exits on the
        // watchdog's bounded next poll rather than surviving as an orphan.
        .env("STATION_SUPERVISOR_PID", std::process::id().to_string())
        .env("STATION_SUPERVISOR_BIRTH", &context.supervisor_birth)
        .env("PATH", &context.shell_path)
        .env("HOME", &context.home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    match &context.channel {
        Some(channel) => {
            command.env("STATION_DESKTOP_CHANNEL", channel);
        }
        None => {
            command.env_remove("STATION_DESKTOP_CHANNEL");
        }
    }
    match context.pinned_port {
        Some(port) => {
            command
                .env("PORT", port.to_string())
                .env_remove("STATION_PORT_MODE");
        }
        None => {
            command.env("PORT", "0").env("STATION_PORT_MODE", "auto");
        }
    }
    apply_no_window(&mut command);
    command
}

#[cfg(not(mobile))]
fn fresh_sidecar_boot_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[cfg(not(mobile))]
fn stable_dev_identifier_hash(value: &str) -> u64 {
    // FNV-1a is specified inline rather than using `DefaultHasher`, whose
    // algorithm is not a stability contract. The identifier is trusted,
    // public configuration and its full byte sequence scopes the worktree.
    value
        .as_bytes()
        .iter()
        .fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
            (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3)
        })
}

#[cfg(not(mobile))]
fn desktop_sidecar_instance_id(packaged_channel: Option<&str>, app_identifier: &str) -> String {
    if let Some(channel) = packaged_channel {
        return format!("desktop-sidecar-{channel}");
    }
    format!(
        "desktop-sidecar-dev-{:016x}",
        stable_dev_identifier_hash(app_identifier)
    )
}

#[cfg(all(not(mobile), windows))]
fn apply_no_window(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(all(not(mobile), not(windows)))]
fn apply_no_window(_command: &mut Command) {}

/// Runtime ownership selected by the registry decision. The durable service
/// is attached-only; `ServerSupervisor` is the only owner allowed to spawn or
/// signal a child.
#[cfg(not(mobile))]
#[derive(Clone, Debug, PartialEq, Eq)]
enum DesktopOwner {
    Sidecar,
    Service {
        id: String,
        port: u16,
    },
    /// The home is free — no live service owns it and this desktop holds no
    /// sidecar claim. Distinct from `None`, which means the registry could not
    /// be read (ambiguous or fail-closed). Conflating them was station#3116's
    /// second lie: a stopped service must not report "could not select a safe
    /// local owner" as if the registry were broken.
    Unowned,
    None,
}

/// Structured desktop ownership for local-only consumers such as the tray.
/// This deliberately carries the registry identity rather than asking callers
/// to infer it from a human-facing status message or detail string.
#[cfg(not(mobile))]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum DesktopOwnerSnapshot {
    Sidecar,
    Service { instance_id: String, api_port: u16 },
    Unowned,
    Unavailable,
}

#[cfg(not(mobile))]
fn owner_snapshot(owner: DesktopOwner) -> DesktopOwnerSnapshot {
    match owner {
        DesktopOwner::Sidecar => DesktopOwnerSnapshot::Sidecar,
        DesktopOwner::Service { id, port } => DesktopOwnerSnapshot::Service {
            instance_id: id,
            api_port: port,
        },
        DesktopOwner::Unowned => DesktopOwnerSnapshot::Unowned,
        DesktopOwner::None => DesktopOwnerSnapshot::Unavailable,
    }
}

#[cfg(not(mobile))]
fn owner_for_decision(decision: HomeOwnershipDecision) -> DesktopOwner {
    match decision {
        HomeOwnershipDecision::ServiceOwnsHome { id, port } => DesktopOwner::Service { id, port },
        HomeOwnershipDecision::SpawnSidecar => DesktopOwner::Sidecar,
        HomeOwnershipDecision::AmbiguousOwnership | HomeOwnershipDecision::FailClosedRegistry => {
            DesktopOwner::None
        }
    }
}

#[cfg(not(mobile))]
fn owner_owns_reapable_child(owner: DesktopOwner) -> bool {
    owner == DesktopOwner::Sidecar
}

/// Window destruction is not application exit: preview and workspace pop-out
/// windows are ordinary Station windows. Sidecar teardown is intentionally
/// wired only from `RunEvent::Exit` below.
#[cfg(not(mobile))]
fn window_destruction_requests_sidecar_teardown() -> bool {
    false
}

#[cfg(not(mobile))]
fn registry_claim_allows_running(result: Result<(), RegistryBridgeFailure>) -> bool {
    result.is_ok()
}

#[cfg(not(mobile))]
struct DesktopServerState {
    owner: Mutex<DesktopOwner>,
    supervisor: Arc<ServerSupervisor>,
    readiness: Mutex<startup_readiness::StartupReadiness>,
    startup_commit_in_flight: AtomicBool,
    startup_commit_pending: AtomicBool,
    /// When the owner was last re-derived. App setup seeds this with the
    /// instant of its own derivation, so in production it is always `Some` —
    /// the boot decision starts the interval rather than making the first
    /// status read pay for a registry-bridge child. station#3116 recorded what
    /// happened without this field: a real observation (pid probe + birth
    /// fingerprint) taken at one instant and then asserted forever.
    ownership_checked_at: Mutex<Option<Instant>>,
}

#[cfg(not(mobile))]
#[derive(Default)]
struct NativeStartupBootstrap {
    renderer_observed: AtomicBool,
    renderer_mounted: AtomicBool,
}

#[cfg(not(mobile))]
fn startup_readiness_accepts_retry(phase: startup_readiness::ReadinessPhase) -> bool {
    phase == startup_readiness::ReadinessPhase::Waiting
}

#[cfg(not(mobile))]
fn claim_startup_commit(
    renderer_observed: bool,
    phase: startup_readiness::ReadinessPhase,
    in_flight: &AtomicBool,
    pending: &AtomicBool,
) -> bool {
    if !renderer_observed || !startup_readiness_accepts_retry(phase) {
        return false;
    }
    loop {
        if in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            pending.store(false, Ordering::Release);
            return true;
        }
        pending.store(true, Ordering::Release);
        if in_flight.load(Ordering::Acquire) {
            return false;
        }
    }
}

#[cfg(not(mobile))]
fn release_failed_startup_commit_claim(in_flight: &AtomicBool, pending: &AtomicBool) -> bool {
    in_flight.store(false, Ordering::Release);
    pending.swap(false, Ordering::AcqRel)
}

#[cfg(not(mobile))]
fn release_failed_startup_commit(app: &AppHandle) {
    if let Some(state) = app.try_state::<DesktopServerState>() {
        if release_failed_startup_commit_claim(
            &state.startup_commit_in_flight,
            &state.startup_commit_pending,
        ) {
            request_native_startup_commit(app);
        }
    }
}

#[cfg(not(mobile))]
fn complete_startup_commit(app: &AppHandle) {
    if let Some(state) = app.try_state::<DesktopServerState>() {
        state
            .startup_commit_pending
            .store(false, Ordering::Release);
    }
}

#[cfg(not(mobile))]
fn request_native_startup_commit(app: &AppHandle) {
    let Some(bootstrap) = app.try_state::<NativeStartupBootstrap>() else {
        log::warn!("native startup bootstrap state is unavailable");
        return;
    };
    if !bootstrap.renderer_observed.load(Ordering::Acquire) {
        log::debug!("native startup bootstrap is waiting for the main renderer page start");
        return;
    }
    let Some(state) = app.try_state::<DesktopServerState>() else {
        log::debug!("native startup bootstrap is waiting for desktop state");
        return;
    };
    let ticket = {
        let status = state
            .supervisor
            .status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match current_startup_ticket(&status) {
            Ok(ticket) => ticket,
            Err(error) => {
                log::info!("native startup bootstrap is waiting for a sidecar ticket: {error}");
                return;
            }
        }
    };
    request_native_startup_commit_for_ticket(app, ticket);
}

#[cfg(not(mobile))]
fn request_native_startup_commit_for_ticket(
    app: &AppHandle,
    ticket: startup_readiness::StartupTicket,
) {
    let Some(bootstrap) = app.try_state::<NativeStartupBootstrap>() else {
        log::warn!("native startup bootstrap state is unavailable");
        return;
    };
    let Some(state) = app.try_state::<DesktopServerState>() else {
        log::debug!("native startup bootstrap is waiting for desktop state");
        return;
    };
    let phase = state
        .readiness
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .phase;
    if !claim_startup_commit(
        bootstrap.renderer_observed.load(Ordering::Acquire),
        phase,
        &state.startup_commit_in_flight,
        &state.startup_commit_pending,
    ) {
        log::info!(
            "native startup bootstrap did not claim: phase={phase:?} inFlight={} pending={} rendererObserved={}",
            state.startup_commit_in_flight.load(Ordering::Acquire),
            state.startup_commit_pending.load(Ordering::Acquire),
            bootstrap.renderer_observed.load(Ordering::Acquire),
        );
        return;
    }
    log::info!(
        "native startup bootstrap claimed identity proof generation {}",
        ticket.generation
    );
    let app_for_commit = app.clone();
    tauri::async_runtime::spawn(async move {
        match tauri::async_runtime::spawn_blocking({
            let app_for_task = app_for_commit.clone();
            move || commit_startup_readiness_blocking(app_for_task, ticket)
        })
        .await
        {
            Ok(Ok(())) => complete_startup_commit(&app_for_commit),
            Ok(Err(error)) => {
                log::warn!("native startup bootstrap proof refused: {error}");
                release_failed_startup_commit(&app_for_commit);
            }
            Err(error) => {
                log::warn!("native startup bootstrap task failed: {error}");
                release_failed_startup_commit(&app_for_commit);
            }
        }
    });
}

#[cfg(not(mobile))]
fn advance_native_startup_after_page(app: &AppHandle) {
    let Some(bootstrap) = app.try_state::<NativeStartupBootstrap>() else {
        return;
    };
    if !bootstrap.renderer_observed.load(Ordering::Acquire) {
        return;
    }
    let Some(state) = app.try_state::<DesktopServerState>() else {
        return;
    };
    let owner = state
        .owner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    if native_startup_uses_sidecar_proof(&owner) {
        request_native_startup_commit(app);
    } else if let Err(error) = commit_native_startup_recovery_for_app(app) {
        log::warn!("native startup recovery reveal refused: {error}");
    }
}

#[cfg(not(mobile))]
fn replay_native_startup_renderer_observations(app: &AppHandle) {
    let Some(bootstrap) = app.try_state::<NativeStartupBootstrap>() else {
        return;
    };
    if !bootstrap.renderer_observed.load(Ordering::Acquire) {
        return;
    }
    let Some(state) = app.try_state::<DesktopServerState>() else {
        return;
    };
    let _ = transition_startup_readiness(
        state.inner(),
        startup_readiness::ReadinessInput::RendererPageStarted,
    );
    if bootstrap.renderer_mounted.load(Ordering::Acquire) {
        let _ = transition_startup_readiness(
            state.inner(),
            startup_readiness::ReadinessInput::RendererMounted,
        );
    }
    advance_native_startup_after_page(app);
}

#[cfg(not(mobile))]
fn native_startup_uses_sidecar_proof(owner: &DesktopOwner) -> bool {
    owner == &DesktopOwner::Sidecar
}

#[cfg(not(mobile))]
fn notify_startup_readiness_if_waiting(app: &AppHandle) {
    let Some(state) = app.try_state::<DesktopServerState>() else {
        return;
    };
    let phase = state
        .readiness
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .phase;
    if startup_readiness_accepts_retry(phase) {
        // Native owns the credential and identity proof. Claim it before the
        // compatibility renderer wake so an already-mounted WebView cannot
        // win the single-flight slot and recreate the bootstrap dependency.
        request_native_startup_commit(app);
        let _ = app.emit("station://startup-readiness-retry", ());
    }
}

/// Hands a user-initiated main-window activation across setup's readiness
/// boundary. Every release channel starts with its main window hidden, so a
/// cold macOS Apple Event can arrive before `DesktopServerState` exists.
///
/// Both sides hold the same mutex while inspecting and changing the handoff
/// state. A separate `try_state` check plus an atomic pending flag has a
/// lost-wakeup gap: setup can observe no pending activation before the event
/// records one. The replay still goes through `request_main_window_activation`,
/// which keeps startup readiness as the sole reveal authority.
#[cfg(not(mobile))]
#[derive(Default)]
struct PendingMainWindowActivation(Mutex<PendingMainWindowActivationState>);

#[cfg(not(mobile))]
#[derive(Default)]
struct PendingMainWindowActivationState {
    readiness_installed: bool,
    activation_pending: bool,
}

#[cfg(not(mobile))]
impl PendingMainWindowActivation {
    /// Returns whether a managed readiness authority is already available and
    /// this event should be delivered immediately.
    fn request(&self) -> bool {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.readiness_installed {
            true
        } else {
            state.activation_pending = true;
            false
        }
    }

    /// Publishes readiness and returns the one coalesced cold activation that
    /// arrived before it. `DesktopServerState` must be managed first.
    fn install_readiness(&self) -> bool {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state.readiness_installed = true;
        std::mem::take(&mut state.activation_pending)
    }
}

#[cfg(target_os = "macos")]
const NATIVE_STARTUP_COVER_IDENTIFIER: &str = "io.kontourai.station.startup-cover";

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct NativeCoverDesired {
    generation: u64,
    covered: bool,
}

#[cfg(target_os = "macos")]
struct NativeCoverDispatcher {
    desired: Arc<Mutex<NativeCoverDesired>>,
    wake: SyncSender<()>,
}

#[cfg(target_os = "macos")]
fn update_native_cover_desired(
    desired: &Mutex<NativeCoverDesired>,
    wake: &SyncSender<()>,
    covered: bool,
) {
    let mut target = desired
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    target.generation = target.generation.wrapping_add(1);
    target.covered = covered;
    drop(target);

    match wake.try_send(()) {
        Ok(()) | Err(TrySendError::Full(())) => {}
        Err(TrySendError::Disconnected(())) => {
            log::error!("native cover dispatcher is unavailable");
        }
    }
}

#[cfg(target_os = "macos")]
fn apply_native_cover_until_current(
    desired: &Mutex<NativeCoverDesired>,
    mut apply: impl FnMut(NativeCoverDesired) -> bool,
) -> bool {
    loop {
        let target = *desired
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !apply(target) {
            return false;
        }
        if desired
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .generation
            == target.generation
        {
            return true;
        }
    }
}

#[cfg(target_os = "macos")]
fn native_cover_dispatcher(app: AppHandle) -> Option<NativeCoverDispatcher> {
    let desired = Arc::new(Mutex::new(NativeCoverDesired {
        generation: 0,
        covered: false,
    }));
    let (wake, receiver) = sync_channel(1);
    let worker_desired = Arc::clone(&desired);
    let worker = thread::Builder::new()
        .name("station-native-cover-dispatcher".into())
        .spawn(move || {
            while receiver.recv().is_ok() {
                let completed = apply_native_cover_until_current(&worker_desired, |target| {
                    let (ack_tx, ack_rx) = sync_channel(0);
                    let main_app = app.clone();
                    let scheduled = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        app.run_on_main_thread(move || {
                            let task_succeeded =
                                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                    let Some(window) = main_app.get_webview_window("main") else {
                                        log::error!(
                                            "native cover task could not find the main window"
                                        );
                                        return false;
                                    };
                                    match with_native_startup_cover(&window, target.covered) {
                                        Ok(()) => true,
                                        Err(error) => {
                                            log::error!("native cover task failed: {error}");
                                            false
                                        }
                                    }
                                }))
                                .unwrap_or_else(|_| {
                                    log::error!("native cover main-thread task panicked");
                                    false
                                });
                            if ack_tx.send(task_succeeded).is_err() {
                                log::error!("native cover task acknowledgement was abandoned");
                            }
                        })
                    }));
                    match scheduled {
                        Ok(Ok(())) => {}
                        Ok(Err(error)) => {
                            log::error!("could not schedule native cover task: {error}");
                            return false;
                        }
                        Err(_) => {
                            log::error!("native cover main-thread dispatch panicked");
                            return false;
                        }
                    }
                    match ack_rx.recv() {
                        Ok(true) => true,
                        Ok(false) => false,
                        Err(_) => {
                            log::error!("native cover main-thread task did not acknowledge");
                            false
                        }
                    }
                });
                if !completed {
                    // A later activation may retry a fail-closed task. The
                    // worker itself remains bounded and available.
                    continue;
                }
            }
        });
    if let Err(error) = worker {
        log::error!("could not spawn native cover dispatcher: {error}");
        return None;
    }
    Some(NativeCoverDispatcher { desired, wake })
}

#[cfg(target_os = "macos")]
fn request_native_cover(app: &AppHandle, covered: bool) {
    let Some(dispatcher) = app.try_state::<NativeCoverDispatcher>() else {
        log::error!("native cover dispatcher state is unavailable");
        return;
    };
    update_native_cover_desired(&dispatcher.desired, &dispatcher.wake, covered);
}

#[cfg(target_os = "macos")]
fn with_native_startup_cover(
    window: &tauri::WebviewWindow,
    covered: bool,
) -> Result<(), tauri::Error> {
    use objc2::{ClassType, MainThreadMarker};
    use objc2_app_kit::{
        NSAutoresizingMaskOptions, NSBox, NSBoxType, NSColor, NSFont, NSTextAlignment,
        NSTextField, NSUserInterfaceItemIdentification, NSView,
    };
    use objc2_foundation::{ns_string, NSArray, NSObjectProtocol, NSPoint, NSRect, NSSize};

    window.with_webview(move |webview| {
        let marker = MainThreadMarker::new()
            .expect("Tauri executes native webview access on the macOS main thread");
        // Tauri's documented PlatformWebview macOS handles are valid only in
        // this callback; nothing escapes or is retained across a window close.
        let webview_view = unsafe { &*webview.inner().cast::<NSView>() };
        let ns_window = unsafe { &*webview.ns_window().cast::<objc2_app_kit::NSWindow>() };
        let Some(content) = ns_window.contentView() else {
            return;
        };
        let cover_identifier = ns_string!("io.kontourai.station.startup-cover");
        debug_assert_eq!(
            cover_identifier.to_string(),
            NATIVE_STARTUP_COVER_IDENTIFIER
        );
        let subviews = content.subviews();
        let existing = subviews.iter().find(|view| {
            view.identifier()
                .as_deref()
                .is_some_and(|identifier| identifier.isEqualToString(cover_identifier))
        });

        if covered {
            if let Some(existing) = existing {
                if !existing.isKindOfClass(NSBox::class()) {
                    log::error!("refusing to replace an unexpected native startup cover view");
                    return;
                }
            } else {
                let cover = NSBox::new(marker);
                cover.setFrame(content.bounds());
                cover.setAutoresizingMask(
                    NSAutoresizingMaskOptions::ViewWidthSizable
                        | NSAutoresizingMaskOptions::ViewHeightSizable,
                );
                cover.setBoxType(NSBoxType::Custom);
                cover.setFillColor(&NSColor::windowBackgroundColor());
                cover.setTitle(ns_string!(""));
                cover.setIdentifier(Some(cover_identifier));
                if let Some(cover_content) = cover.contentView() {
                    let label_text = ns_string!("Station is preparing its protected workspace…");
                    let label = NSTextField::labelWithString(label_text, marker);
                    let bounds = cover_content.bounds();
                    label.setFrame(NSRect::new(
                        NSPoint::new(24.0, ((bounds.size.height - 30.0) / 2.0).max(0.0)),
                        NSSize::new((bounds.size.width - 48.0).max(0.0), 30.0),
                    ));
                    label.setAutoresizingMask(
                        NSAutoresizingMaskOptions::ViewWidthSizable
                            | NSAutoresizingMaskOptions::ViewMinYMargin
                            | NSAutoresizingMaskOptions::ViewMaxYMargin,
                    );
                    label.setAlignment(NSTextAlignment(2));
                    label.setFont(Some(&NSFont::boldSystemFontOfSize(17.0)));
                    label.setTextColor(Some(&NSColor::labelColor()));
                    unsafe {
                        let _: () = objc2::msg_send![&*label, setAccessibilityElement: true];
                        let _: () = objc2::msg_send![&*label, setAccessibilityLabel: label_text];
                    }
                    cover_content.addSubview(&label);
                }
                content.addSubview(&cover);
            }
            let protected_subviews = content.subviews();
            if let Some(protected_cover) = protected_subviews.iter().find(|view| {
                view.identifier()
                    .as_deref()
                    .is_some_and(|identifier| identifier.isEqualToString(cover_identifier))
            }) {
                let protected_children = NSArray::arrayWithObject(&*protected_cover);
                unsafe {
                    let _: () = objc2::msg_send![&*content, setAccessibilityChildren: &*protected_children];
                }
            }
            unsafe {
                let _: () = objc2::msg_send![webview_view, setAccessibilityHidden: true];
                // Keep WebKit executing the readiness proof. Accessibility is
                // isolated by the content-view child list above; alpha is now
                // only the visual half of the protected surface.
                let _: () = objc2::msg_send![webview_view, setAlphaValue: 0.0f64];
            }
            ns_window.makeFirstResponder(None);
            ns_window.deminiaturize(None);
            ns_window.makeKeyAndOrderFront(None);
        } else {
            if let Some(cover) = existing {
                if !cover.isKindOfClass(NSBox::class()) {
                    log::error!("refusing to remove an unexpected startup cover view");
                    return;
                }
                cover.removeFromSuperview();
            }
            unsafe {
                let _: () = objc2::msg_send![webview_view, setAccessibilityHidden: false];
            }
            unsafe {
                // Clear our temporary override. AppKit must resume deriving
                // the live accessibility hierarchy; a copied subview snapshot
                // would retain stale children and omit later replacements.
                let _: () = objc2::msg_send![&*content, setAccessibilityChildren: None::<&NSArray<NSView>>];
                let _: () = objc2::msg_send![webview_view, setAlphaValue: 1.0f64];
            }
            ns_window.deminiaturize(None);
            ns_window.makeFirstResponder(Some(webview_view));
            ns_window.makeKeyAndOrderFront(None);
        }
    })
}

#[cfg(target_os = "macos")]
fn present_startup_recovery_surface(app: &AppHandle) {
    request_native_cover(app, true);
}

#[cfg(all(not(mobile), not(target_os = "macos")))]
fn present_startup_recovery_surface(_app: &AppHandle) {
    // Other desktop hosts retain the established hidden-until-ticket behavior.
}

#[cfg(not(mobile))]
fn reveal_main_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        request_native_cover(app, false);
        return;
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(not(mobile))]
fn transition_startup_readiness(
    state: &DesktopServerState,
    input: startup_readiness::ReadinessInput,
) -> Vec<startup_readiness::ReadinessEffect> {
    let mut readiness = state
        .readiness
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (next, effects) = startup_readiness::transition(&readiness, input);
    *readiness = next;
    effects
}

#[cfg(not(mobile))]
fn commit_current_startup_ticket(
    status: &BundledServerStatus,
    readiness: &mut startup_readiness::StartupReadiness,
    ticket: startup_readiness::StartupTicket,
) -> Result<Vec<startup_readiness::ReadinessEffect>, &'static str> {
    let current = current_startup_ticket(status)?;
    if ticket != current {
        return Err("Desktop startup readiness ticket is stale.");
    }
    let (next, effects) = startup_readiness::transition(
        readiness,
        startup_readiness::ReadinessInput::NativeIdentityCommitted(ticket),
    );
    if !next.identity_committed {
        return Err("Desktop startup readiness commit is no longer current.");
    }
    *readiness = next;
    Ok(effects)
}

#[cfg(not(mobile))]
fn current_startup_ticket(
    status: &BundledServerStatus,
) -> Result<startup_readiness::StartupTicket, &'static str> {
    Ok(startup_readiness::StartupTicket {
        generation: status
            .generation
            .ok_or("Desktop sidecar has no active generation.")?,
        instance_id: status
            .instance_id
            .clone()
            .ok_or("Desktop sidecar has no active instance identity.")?,
        boot_id: status
            .boot_id
            .clone()
            .ok_or("Desktop sidecar has no active boot identity.")?,
        api_base: status
            .api_base
            .clone()
            .ok_or("Desktop sidecar has no active API base.")?,
    })
}

#[cfg(not(mobile))]
pub(crate) fn request_main_window_activation(app: &AppHandle) {
    let Some(state) = app.try_state::<DesktopServerState>() else {
        return;
    };
    let effects = transition_startup_readiness(
        state.inner(),
        startup_readiness::ReadinessInput::ActivationRequested,
    );
    if effects.contains(&startup_readiness::ReadinessEffect::PresentStartupRecoverySurface) {
        present_startup_recovery_surface(app);
    }
    if effects.contains(&startup_readiness::ReadinessEffect::RevealMainWindow) {
        reveal_main_window(app);
    }
    continue_startup_readiness(app, state.inner(), &effects);
}

#[cfg(not(mobile))]
fn continue_startup_readiness(
    app: &AppHandle,
    state: &DesktopServerState,
    effects: &[startup_readiness::ReadinessEffect],
) {
    let resumed = effects.iter().any(|effect| {
        matches!(
            effect,
            startup_readiness::ReadinessEffect::ReprobeCurrentTicket
                | startup_readiness::ReadinessEffect::RestartOwnedSidecar
                | startup_readiness::ReadinessEffect::RecommitRecoverySurface
        )
    });
    if !resumed {
        return;
    }
    if effects.contains(&startup_readiness::ReadinessEffect::RestartOwnedSidecar) {
        let _ = state.supervisor.tx.send(SupervisorMessage::Restart);
    } else {
        notify_startup_readiness_if_waiting(app);
    }
    let epoch = state
        .readiness
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .epoch;
    arm_startup_deadline(app.clone(), epoch);
}

#[cfg(not(mobile))]
fn request_or_defer_main_window_activation(
    app: &AppHandle,
    pending_activation: &PendingMainWindowActivation,
) {
    if pending_activation.request() {
        request_main_window_activation(app);
    }
}

#[cfg(not(mobile))]
fn replay_pending_main_window_activation(
    app: &AppHandle,
    pending_activation: &PendingMainWindowActivation,
) {
    if pending_activation.install_readiness() {
        request_main_window_activation(app);
    }
}

#[cfg(not(mobile))]
fn observe_startup_ticket(app: &AppHandle, ticket: startup_readiness::StartupTicket) {
    let Some(state) = app.try_state::<DesktopServerState>() else {
        return;
    };
    let generation = ticket.generation;
    let published_ticket = ticket.clone();
    let _ = transition_startup_readiness(
        state.inner(),
        startup_readiness::ReadinessInput::ServerTicket(ticket),
    );
    log::info!(
        "native startup bootstrap observed sidecar ticket generation {}",
        generation
    );
    request_native_startup_commit_for_ticket(app, published_ticket);
    // A sidecar retry becomes reprobeable only after this exact new generation
    // is running and has published its ticket; never wake the renderer against
    // the old child during Restart.
    let _ = app.emit("station://startup-readiness-retry", ());
}

#[cfg(not(mobile))]
fn observe_startup_loss(app: &AppHandle, generation: u64) {
    let Some(state) = app.try_state::<DesktopServerState>() else {
        return;
    };
    let _ = transition_startup_readiness(
        state.inner(),
        startup_readiness::ReadinessInput::ServerLost { generation },
    );
}

#[cfg(not(mobile))]
fn arm_startup_deadline(app: AppHandle, epoch: u64) {
    let _ = thread::Builder::new()
        .name(format!("station-startup-readiness-{epoch}"))
        .spawn(move || {
            thread::sleep(Duration::from_secs(30));
            let Some(state) = app.try_state::<DesktopServerState>() else { return };
            let effects = transition_startup_readiness(state.inner(), startup_readiness::ReadinessInput::DeadlineElapsed { epoch, now_ms: 30_000 });
            if effects.iter().any(|effect| matches!(effect,
                startup_readiness::ReadinessEffect::ReprobeCurrentTicket
                    | startup_readiness::ReadinessEffect::RestartOwnedSidecar
                    | startup_readiness::ReadinessEffect::RecommitRecoverySurface
            )) {
                continue_startup_readiness(&app, state.inner(), &effects);
                return;
            }
            if !effects.contains(&startup_readiness::ReadinessEffect::ShowDiagnostic { epoch }) { return; }
            use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
            log::warn!("desktop startup readiness timed out for epoch {epoch}");
            let retry = app.dialog().message("Station is still preparing its protected workspace. Retry safely resumes the selected local recovery surface.").title("Station is not ready").kind(MessageDialogKind::Warning).buttons(MessageDialogButtons::OkCancelCustom("Retry".into(), "Exit".into())).blocking_show();
            if !retry {
                let still_failed_for_dialog_epoch = {
                    let readiness = state
                    .readiness
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                    readiness.phase == startup_readiness::ReadinessPhase::Failed
                        && readiness.epoch == epoch
                };
                if still_failed_for_dialog_epoch { let _ = app.exit(1); }
                return;
            }
            let retry_effects = transition_startup_readiness(state.inner(), startup_readiness::ReadinessInput::Retry { now_ms: 0, timeout_ms: 30_000 });
            continue_startup_readiness(&app, state.inner(), &retry_effects);
        });
}

#[cfg(not(mobile))]
fn prepare_desktop_station_home<F>(
    station_home: PathBuf,
    ensure_schema: F,
) -> Result<PathBuf, String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    let station_home = service_state::admit_station_runtime_home(&station_home)
        .map_err(|error| format!("Desktop rejected its Station runtime home: {error}"))?;
    ensure_schema(&station_home)
        .map_err(|error| format!("Desktop could not establish its Station home schema: {error}"))?;
    Ok(station_home)
}

#[cfg(not(mobile))]
fn exit_after_dialog_dismissal<F>(exit: F) -> impl FnOnce(bool)
where
    F: FnOnce(),
{
    move |_| exit()
}

/// Home preparation happens before the desktop has an ownership state, tray,
/// or sidecar supervisor. Returning an error from `Builder::setup` at that
/// point crosses Tauri's platform callback and aborts the process, which
/// hides a deterministic, user-actionable problem behind a native crash.
///
/// This deliberately offers no retry: choosing between two Station homes or
/// repairing a rejected schema needs an explicit operator decision. No
/// supervisor exists when this is called, so acknowledging the dialog exits
/// without starting a backend or changing either home.
#[cfg(not(mobile))]
fn exit_desktop_home_preparation_failure(
    app: &tauri::App,
    title: &str,
    message: &str,
    detail: &str,
) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    log::error!("desktop home preparation failed: {detail}");
    let app_handle = app.handle().clone();
    app.handle()
        .dialog()
        .message(format!(
            "{message}\n\nNo local backend was started.\n\nDetails: {detail}"
        ))
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCustom("Exit".into()))
        .show(exit_after_dialog_dismissal(move || app_handle.exit(1)));
}

#[cfg(not(mobile))]
#[derive(Clone, Debug, PartialEq, Eq)]
struct BundledStartupCredentialReceipt {
    profile_name: String,
    reference: NativeCredentialReference,
    exact_origin: String,
    instance_id: String,
    station_home: PathBuf,
}

#[cfg(not(mobile))]
fn bundled_startup_credential_receipt(
    store: &CredentialProfileStore,
    launch: &SidecarLaunchContext,
    ticket: &startup_readiness::StartupTicket,
) -> Result<BundledStartupCredentialReceipt, String> {
    let ticket_url = url::Url::parse(&ticket.api_base)
        .map_err(|_| "Desktop startup readiness API base is invalid.".to_string())?;
    if ticket_url.path() != "/" || ticket_url.query().is_some() || ticket_url.fragment().is_some() {
        return Err("Desktop startup readiness API base is not an origin.".to_string());
    }
    let ticket_origin = exact_origin(&ticket.api_base)?;
    let home = launch
        .station_home
        .to_str()
        .ok_or_else(|| "Desktop startup channel home is not valid UTF-8.".to_string())?;
    let matches = store
        .profiles
        .iter()
        .filter(|profile| {
            // `localService.baseDir` is the native-owned channel boundary.
            // `setupSource` records how the credential arrived and may be
            // `paired` after a reviewed home/profile cutover; it is not
            // authority for this startup proof.
            profile.configuration_state == "configured"
                && profile.credential_ref.is_some()
                && profile.local_service.as_ref().is_some_and(|service| {
                    service.instance_id == ticket.instance_id
                        && same_runtime_home_identity(
                            &service.base_dir,
                            home,
                            &launch.station_root,
                        )
                })
                && exact_origin(&profile.endpoint).as_deref() == Ok(ticket_origin.as_str())
        })
        .collect::<Vec<_>>();
    let [profile] = matches.as_slice() else {
        return Err(
            "Desktop startup readiness requires exactly one configured profile owned by this channel home."
                .to_string(),
        );
    };
    let reference = profile.credential_ref.clone().ok_or_else(|| {
        "Desktop startup readiness profile has no native credential reference.".to_string()
    })?;
    credential_reference_key(&reference)?;
    Ok(BundledStartupCredentialReceipt {
        profile_name: profile.name.clone(),
        reference,
        exact_origin: ticket_origin,
        instance_id: ticket.instance_id.clone(),
        station_home: launch.station_home.clone(),
    })
}

#[cfg(not(mobile))]
fn read_bundled_startup_credential_receipt(
    launch: &SidecarLaunchContext,
    ticket: &startup_readiness::StartupTicket,
) -> Result<BundledStartupCredentialReceipt, String> {
    let path = launch.station_root.join("config").join("profiles.json");
    let contents = read_station_profile_store(&path)
        .map_err(|error| format!("read bundled startup profile metadata: {error}"))?;
    let store = parse_station_profile_store(&contents)?;
    bundled_startup_credential_receipt(&store, launch, ticket)
}

#[cfg(not(mobile))]
fn startup_identity_matches_ticket(body: &str, ticket: &startup_readiness::StartupTicket) -> bool {
    let Ok(identity) = serde_json::from_str::<serde_json::Value>(body) else {
        return false;
    };
    identity
        .get("instanceId")
        .and_then(serde_json::Value::as_str)
        == Some(ticket.instance_id.as_str())
        && identity.get("bootId").and_then(serde_json::Value::as_str)
            == Some(ticket.boot_id.as_str())
}

#[cfg(not(mobile))]
fn prove_bundled_startup_identity(
    launch: &SidecarLaunchContext,
    ticket: &startup_readiness::StartupTicket,
) -> Result<(), String> {
    let receipt = read_bundled_startup_credential_receipt(launch, ticket)?;
    let credential = credential_entry(&receipt.reference)?
        .get_password()
        .map_err(|error| format!("read bundled startup credential: {error}"))?;
    let identity_url = url::Url::parse(&receipt.exact_origin)
        .and_then(|origin| origin.join("/api/system/identity"))
        .map_err(|_| "Desktop startup identity URL is invalid.".to_string())?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .max_redirects(0)
        .timeout_global(Some(Duration::from_secs(5)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut response = agent
        .get(identity_url.as_str())
        .header("Authorization", format!("Bearer {credential}"))
        .call()
        .map_err(|error| {
            format!(
                "Desktop startup identity request failed: {}",
                native_request_transport_detail(&error).detail
            )
        })?;
    if response.status().as_u16() != 200 {
        return Err(format!(
            "Desktop startup identity request returned HTTP {}.",
            response.status().as_u16()
        ));
    }
    let body = response
        .body_mut()
        .with_config()
        .limit(16 * 1024)
        .read_to_string()
        .map_err(|error| format!("Desktop startup identity response was unreadable: {error}"))?;
    if !startup_identity_matches_ticket(&body, ticket) {
        return Err(
            "Desktop startup identity did not match the current sidecar ticket.".to_string(),
        );
    }
    // The profile is mutable shared metadata. Re-read the host-owned binding
    // after network I/O so a concurrent profile replacement cannot authorize
    // the reveal with a stale credential receipt.
    if read_bundled_startup_credential_receipt(launch, ticket)? != receipt {
        return Err(
            "Desktop startup credential binding changed during identity proof.".to_string(),
        );
    }
    Ok(())
}

#[cfg(not(mobile))]
fn commit_startup_readiness_blocking(
    app: AppHandle,
    ticket: startup_readiness::StartupTicket,
) -> Result<(), String> {
    let generation = ticket.generation;
    let state = app
        .try_state::<DesktopServerState>()
        .ok_or("Desktop startup readiness is not initialized.")?;
    let launch = state.supervisor.context.launch.clone();
    {
        let status = state
            .supervisor
            .status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let current = current_startup_ticket(&status).map_err(|error| {
            log::warn!(
                "desktop startup identity proof refused generation {generation}: {error}"
            );
            error.to_string()
        })?;
        if ticket != current {
            log::warn!(
                "desktop startup identity proof refused generation {generation}: ticket is stale"
            );
            return Err("Desktop startup readiness ticket is stale.".to_string());
        }
    }
    // Native owns the exact bundled profile and Keychain reference. Prove the
    // current sidecar directly so reveal never depends on the WebView's active
    // profile, which may still name another channel during cold bootstrap.
    if let Err(error) = prove_bundled_startup_identity(&launch, &ticket) {
        // The renderer receives this refusal but cannot safely inspect or log
        // native credential details. Keep one secret-free host diagnostic so
        // a protected-window timeout identifies profile, Keychain, transport,
        // identity, or race refusal instead of collapsing to a blank deadline.
        log::warn!("desktop startup identity proof refused generation {generation}: {error}");
        return Err(error);
    }
    // Supervisor status precedes readiness everywhere this pair is acquired.
    // Revalidate and transition after the bounded request, then release before UI.
    let status = state
        .supervisor
        .status
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut readiness = state
        .readiness
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let effects =
        commit_current_startup_ticket(&status, &mut readiness, ticket).map_err(|error| {
            log::warn!("desktop startup identity proof refused generation {generation}: {error}");
            error.to_string()
        })?;
    drop(readiness);
    drop(status);
    log::info!(
        "desktop startup identity proof committed generation {}",
        generation
    );
    if effects.contains(&startup_readiness::ReadinessEffect::RevealMainWindow) {
        log::info!("desktop startup readiness revealed after identity and renderer mount");
        reveal_main_window(&app);
    }
    Ok(())
}

#[cfg(not(mobile))]
fn observe_native_startup_page(app: &AppHandle, label: &str, event: PageLoadEvent) {
    if !native_startup_page_admitted(label, event) {
        return;
    }
    let Some(bootstrap) = app.try_state::<NativeStartupBootstrap>() else {
        return;
    };
    bootstrap.renderer_mounted.store(false, Ordering::Release);
    if !bootstrap.renderer_observed.swap(true, Ordering::AcqRel) {
        log::info!("native startup bootstrap observed the main renderer page start");
    }
    if let Some(state) = app.try_state::<DesktopServerState>() {
        let _ = transition_startup_readiness(
            state.inner(),
            startup_readiness::ReadinessInput::RendererPageStarted,
        );
    }
    advance_native_startup_after_page(app);
}

#[cfg(not(mobile))]
fn native_startup_page_admitted(label: &str, event: PageLoadEvent) -> bool {
    label == "main" && event == PageLoadEvent::Started
}

#[cfg(not(mobile))]
#[tauri::command]
async fn commit_startup_readiness(
    app: AppHandle,
    ticket: startup_readiness::StartupTicket,
) -> Result<(), String> {
    let state = app
        .try_state::<DesktopServerState>()
        .ok_or("Desktop startup readiness is not initialized.")?;
    let phase = state
        .readiness
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .phase;
    if !claim_startup_commit(
        true,
        phase,
        &state.startup_commit_in_flight,
        &state.startup_commit_pending,
    ) {
        return Err("Desktop startup identity proof is already in flight.".to_string());
    }
    let app_for_commit = app.clone();
    let result = match tauri::async_runtime::spawn_blocking(move || {
        commit_startup_readiness_blocking(app_for_commit, ticket)
    })
    .await
    {
        Ok(result) => result,
        Err(error) => {
            release_failed_startup_commit(&app);
            return Err(format!("Desktop startup identity task failed: {error}"));
        }
    };
    if result.is_err() {
        release_failed_startup_commit(&app);
    } else {
        complete_startup_commit(&app);
    }
    result
}

#[cfg(not(mobile))]
fn renderer_mount_label_admitted(label: &str) -> bool {
    label == "main"
}

#[cfg(not(mobile))]
#[tauri::command]
fn commit_renderer_mount(window: tauri::WebviewWindow, app: AppHandle) -> Result<(), String> {
    if !renderer_mount_label_admitted(window.label()) {
        return Err("Renderer mount commits are accepted only from the main WebView.".into());
    }
    let bootstrap = app
        .try_state::<NativeStartupBootstrap>()
        .ok_or("Desktop startup bootstrap is not initialized.")?;
    bootstrap.renderer_mounted.store(true, Ordering::Release);
    let Some(state) = app.try_state::<DesktopServerState>() else {
        log::info!("native startup bootstrap retained the main React mount before desktop state");
        return Ok(());
    };
    let effects = transition_startup_readiness(
        state.inner(),
        startup_readiness::ReadinessInput::RendererMounted,
    );
    log::info!("native startup bootstrap observed the main React mount");
    if effects.contains(&startup_readiness::ReadinessEffect::RevealMainWindow) {
        log::info!("desktop startup readiness revealed after identity and renderer mount");
        reveal_main_window(&app);
    }
    Ok(())
}

#[cfg(not(mobile))]
#[tauri::command]
fn commit_startup_recovery_ui(window: tauri::WebviewWindow, app: AppHandle) -> Result<(), String> {
    if !renderer_mount_label_admitted(window.label()) {
        return Err("Startup recovery commits are accepted only from the main WebView.".into());
    }
    commit_startup_recovery_ui_for_app(&app)
}

#[cfg(not(mobile))]
fn commit_startup_recovery_ui_for_app(app: &AppHandle) -> Result<(), String> {
    commit_startup_recovery_for_app(app, startup_readiness::ReadinessInput::RecoveryUiCommitted)
}

#[cfg(not(mobile))]
fn commit_native_startup_recovery_for_app(app: &AppHandle) -> Result<(), String> {
    commit_startup_recovery_for_app(
        app,
        startup_readiness::ReadinessInput::NativeRecoveryCommitted,
    )
}

#[cfg(not(mobile))]
fn commit_startup_recovery_for_app(
    app: &AppHandle,
    input: startup_readiness::ReadinessInput,
) -> Result<(), String> {
    let state = app
        .try_state::<DesktopServerState>()
        .ok_or("Desktop startup readiness is not initialized.")?;
    if state
        .owner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
        == DesktopOwner::Sidecar
    {
        return Err("Desktop sidecar recovery requires an exact authenticated ticket.".into());
    }
    let effects = transition_startup_readiness(state.inner(), input);
    if effects.contains(&startup_readiness::ReadinessEffect::RevealMainWindow) {
        reveal_main_window(app);
    }
    Ok(())
}

#[cfg(not(mobile))]
struct ServerSupervisor {
    child: Mutex<Option<Child>>,
    status: Arc<Mutex<BundledServerStatus>>,
    stderr_reader: Mutex<Option<(thread::JoinHandle<()>, Receiver<()>)>>,
    shutting_down: AtomicBool,
    tx: Sender<SupervisorMessage>,
    thread: Mutex<Option<thread::JoinHandle<()>>>,
    context: SidecarRuntimeContext,
}

#[cfg(not(mobile))]
#[derive(Clone)]
struct SidecarRuntimeContext {
    launch: SidecarLaunchContext,
    registry_id: String,
}

#[cfg(not(mobile))]
enum SupervisorMessage {
    Listening { generation: u64, port: u16 },
    Restart,
    Shutdown,
}

/// Where the resolved local service's own log files live, derived from its
/// base directory, instance id, and platform — never guessed, never a
/// directory standing in for a file. Mirrors the paths the CLI's own service
/// installers write: `packages/cli/src/commands/service-launchd.ts` (darwin,
/// separate out/err files), `service-windows.ts` (win32, one combined file),
/// and `service-systemd.ts` (linux, no `StandardOutput`/`StandardError` file
/// is configured — journald is the only destination, so there is no path).
#[cfg(not(mobile))]
fn service_log_file_paths(
    service: Option<&service_state::ResolvedLocalService>,
) -> (Option<String>, Option<String>) {
    let Some(service) = service else {
        return (None, None);
    };
    let logs_dir = service.base_dir.join("logs");
    let instance = &service.manifest.instance_id;
    match service.manifest.platform.as_str() {
        "darwin" => (
            Some(
                logs_dir
                    .join(format!("{instance}-service.out.log"))
                    .to_string_lossy()
                    .to_string(),
            ),
            Some(
                logs_dir
                    .join(format!("{instance}-service.err.log"))
                    .to_string_lossy()
                    .to_string(),
            ),
        ),
        "win32" => (
            Some(
                logs_dir
                    .join(format!("{instance}-service.log"))
                    .to_string_lossy()
                    .to_string(),
            ),
            None,
        ),
        _ => (None, None),
    }
}

/// Coarse signature of the service branch's observable health problems.
/// The attached-service resolver runs on essentially every tray poll tick
/// (as often as every ~10s while `Running`, more often while resolving a
/// problem) — mirrors service_state.rs's `probe_service` debug-not-info
/// rationale: an unbounded run of identical warn lines would evict rarer
/// errors from the 25MB rotation window. `log_service_status_problem` warns
/// once when this signature CHANGES (a fresh problem, or a genuinely
/// different one) and logs every repeat at debug instead.
#[cfg(not(mobile))]
#[derive(Clone, PartialEq, Eq)]
enum ServiceStatusProblem {
    InvalidDefaultProfile(String),
    Unhealthy(String),
}

#[cfg(not(mobile))]
static LAST_SERVICE_STATUS_PROBLEM: std::sync::Mutex<Option<ServiceStatusProblem>> =
    std::sync::Mutex::new(None);

#[cfg(not(mobile))]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ProblemLogLevel {
    Warn,
    Debug,
    Silent,
}

/// Pure decision, factored out of `log_service_status_problem` so the
/// transition logic is unit-testable without a global static: no problem is
/// always silent; the same problem as last time is a repeat (debug); a
/// different (or newly appearing) problem is a transition (warn).
#[cfg(not(mobile))]
fn service_status_problem_log_level(
    previous: &Option<ServiceStatusProblem>,
    current: &Option<ServiceStatusProblem>,
) -> ProblemLogLevel {
    match current {
        None => ProblemLogLevel::Silent,
        Some(_) if previous == current => ProblemLogLevel::Debug,
        Some(_) => ProblemLogLevel::Warn,
    }
}

#[cfg(not(mobile))]
fn log_service_status_problem(current: Option<ServiceStatusProblem>, message: &str) {
    let mut guard = LAST_SERVICE_STATUS_PROBLEM
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match service_status_problem_log_level(&guard, &current) {
        ProblemLogLevel::Warn => log::warn!("{message}"),
        ProblemLogLevel::Debug => log::debug!("{message}"),
        ProblemLogLevel::Silent => {}
    }
    *guard = current;
}

#[cfg(not(mobile))]
fn attached_service_status(app: &AppHandle, id: &str, port: u16) -> BundledServerStatus {
    let (phase, api_base, message, detail) = (
        "stopped",
        None,
        "A durable Station service owns this home.".to_string(),
        Some(format!(
            "Service {id} is registered on port {port}. Desktop does not attach to it automatically; open it only by user choice."
        )),
    );
    let desktop_log_path = app
        .path()
        .app_log_dir()
        .ok()
        .map(|dir| desktop_log_file_path_within(&dir));
    BundledServerStatus {
        phase: match phase {
            "running" => bundled_server_state::ServerPhase::Running,
            "failed" => bundled_server_state::ServerPhase::Failed,
            _ => bundled_server_state::ServerPhase::Stopped,
        },
        attempt: 0,
        max_attempts: 0,
        api_base,
        port: Some(port),
        generation: None,
        instance_id: Some(id.to_string()),
        boot_id: None,
        last_exit_code: None,
        next_retry_in_ms: None,
        log_path: None,
        error_log_path: None,
        desktop_log_path,
        fail_closed: false,
        ownership: ServerOwnership::Service,
        can_run_in_background: false,
        message,
        detail,
    }
}

#[cfg(not(mobile))]
/// A home nobody owns: the registry was read, no live service owns it, and this
/// desktop holds no sidecar claim.
///
/// Deliberately NOT `unavailable_status`, which is a fail-closed *error* shape
/// (`phase: Failed`, `fail_closed: true`). Routing a free home through it made
/// the connection row render "Failed to start" with a red error dot
/// (`connection-manager-modal-utils.ts` maps `failed` → error) when nothing had
/// failed — station#3118's defect, arriving through the `Unowned` variant
/// station#3116 introduced. Nothing failed here; there is simply no Station
/// running, which is `Stopped` → "Not running" with an idle dot.
#[cfg(not(mobile))]
fn unowned_home_status(app: &AppHandle, message: String, detail: String) -> BundledServerStatus {
    let desktop_log_path = app
        .path()
        .app_log_dir()
        .ok()
        .map(|dir| desktop_log_file_path_within(&dir));
    unowned_home_status_fields(desktop_log_path, message, detail)
}

/// The shape itself, free of `AppHandle` so the Stopped-not-Failed decision is
/// provable. `unified_server_status` and its arms otherwise need a live Tauri
/// app, which is why station#3129 records them as uncovered.
#[cfg(not(mobile))]
fn unowned_home_status_fields(
    desktop_log_path: Option<String>,
    message: String,
    detail: String,
) -> BundledServerStatus {
    BundledServerStatus {
        phase: bundled_server_state::ServerPhase::Stopped,
        attempt: 0,
        max_attempts: 0,
        api_base: None,
        port: None,
        generation: None,
        instance_id: None,
        boot_id: None,
        last_exit_code: None,
        next_retry_in_ms: None,
        log_path: None,
        error_log_path: None,
        desktop_log_path,
        // Determinate, not fail-closed: we read the registry and it answered.
        fail_closed: false,
        ownership: ServerOwnership::None,
        can_run_in_background: false,
        message,
        detail: Some(detail),
    }
}

#[cfg(not(mobile))]
fn unavailable_status(app: &AppHandle, message: String, detail: String) -> BundledServerStatus {
    let desktop_log_path = app
        .path()
        .app_log_dir()
        .ok()
        .map(|dir| desktop_log_file_path_within(&dir));
    BundledServerStatus {
        phase: bundled_server_state::ServerPhase::Failed,
        attempt: 0,
        max_attempts: 0,
        api_base: None,
        port: None,
        generation: None,
        instance_id: None,
        boot_id: None,
        last_exit_code: None,
        next_retry_in_ms: None,
        log_path: None,
        error_log_path: None,
        desktop_log_path,
        fail_closed: true,
        ownership: ServerOwnership::None,
        can_run_in_background: false,
        message,
        detail: Some(detail),
    }
}

/// How long a re-derived ownership decision is treated as current.
///
/// `decide_home_ownership_from_runtime` reads the home-scoped registry through
/// `invoke_registry_bridge`, which spawns a Node child process with a 3s
/// timeout. `unified_server_status` runs on every status request and on the
/// tray's poll cadence, so re-deriving unconditionally would spawn a process
/// per emit. This bounds it to one bridge invocation per interval.
#[cfg(not(mobile))]
const OWNERSHIP_REFRESH_INTERVAL: Duration = Duration::from_secs(5);

/// May this owner be re-derived at all, and has its interval elapsed?
///
/// Never re-derives while this desktop owns the sidecar: holding the registry
/// claim makes our ownership authoritative — nothing can take the home from
/// under us — and reporting `Service` while our own supervisor is live would be
/// incoherent. `Unowned` deliberately IS re-derived, so a service that comes
/// back is noticed.
///
/// Pure so the rule is provable without a supervisor or a Node child,
/// mirroring how `decide_home_ownership` is tested apart from
/// `decide_home_ownership_from_runtime`.
#[cfg(not(mobile))]
fn should_rederive_home_ownership(
    current: &DesktopOwner,
    checked_at: Option<Instant>,
    now: Instant,
) -> bool {
    if *current == DesktopOwner::Sidecar {
        return false;
    }
    match checked_at {
        Some(previous) => now.saturating_duration_since(previous) >= OWNERSHIP_REFRESH_INTERVAL,
        None => true,
    }
}

/// Translate a freshly derived owner into what a *status read* may adopt.
///
/// `HomeOwnershipDecision::SpawnSidecar` is the only decision that maps to
/// `DesktopOwner::Sidecar`, and it does not mean "this desktop owns a sidecar"
/// — it means **the home is free and a sidecar could be spawned**. Only app
/// setup may act on that, because becoming the sidecar owner requires claiming
/// a registry slot and spawning a supervisor. A read path that adopted
/// `Sidecar` would return `BundledServerStatus::initial` from a supervisor that
/// was never launched: `phase: Starting` forever, with no process behind it,
/// and `restart_bundled_server` enabled against a dropped channel.
///
/// So a read path records the *fact* — the home is unowned — without taking
/// ownership. Refusing outright was station#3116's own blocker: a stopped
/// service derives `SpawnSidecar`, so refusing it left the previous
/// `Service { id, port }` cached and the banner naming a service and port that
/// no longer exist. That is the exact lie the issue was filed about, and the
/// most common case of it.
#[cfg(not(mobile))]
fn adoptable_refreshed_owner(derived: DesktopOwner) -> DesktopOwner {
    match derived {
        DesktopOwner::Sidecar => DesktopOwner::Unowned,
        owner => owner,
    }
}

/// Re-derive the home owner when the cached decision may have gone stale, so
/// the UI can learn that a durable service appeared, was replaced, or went
/// away — without touching the launch path.
#[cfg(not(mobile))]
fn refresh_home_ownership_if_stale(state: &DesktopServerState) {
    let now = Instant::now();
    // Check-and-stamp under ONE guard. Releasing between them let two callers
    // (the tray poll thread and the main/IPC thread) both pass the interval
    // check, both spawn a registry-bridge child, and a slower stale derivation
    // overwrite a faster fresh one.
    {
        let mut checked_at = state
            .ownership_checked_at
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let current = state
            .owner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        if !should_rederive_home_ownership(&current, *checked_at, now) {
            return;
        }
        *checked_at = Some(now);
    }

    let resource_dir = state.supervisor.context.launch.resource_dir.clone();
    let station_home = state.supervisor.context.launch.station_home.clone();
    let next = adoptable_refreshed_owner(owner_for_decision(decide_home_ownership_from_runtime(
        &resource_dir,
        &station_home,
    )));
    *state
        .owner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = next;
}

/// Which status producer a given owner routes to.
///
/// Pure so the routing is provable without a live Tauri app. station#3129
/// recorded that `unified_server_status` and its arms had no coverage at all:
/// swapping the `Unowned` arm for `None`'s message passed every test.
#[cfg(not(mobile))]
#[derive(Clone, Debug, PartialEq, Eq)]
enum HomeStatusRoute {
    SidecarSupervisor,
    AttachedService { id: String, port: u16 },
    UnownedHome,
    RegistryUnavailable,
}

#[cfg(not(mobile))]
fn home_status_route(owner: DesktopOwner) -> HomeStatusRoute {
    match owner {
        DesktopOwner::Sidecar => HomeStatusRoute::SidecarSupervisor,
        DesktopOwner::Service { id, port } => HomeStatusRoute::AttachedService { id, port },
        DesktopOwner::Unowned => HomeStatusRoute::UnownedHome,
        DesktopOwner::None => HomeStatusRoute::RegistryUnavailable,
    }
}

/// Read the owner. Refreshing is folded in deliberately: station#3116's whole
/// defect was a boot-time decision asserted forever, and a bare
/// `state.owner.lock()` elsewhere would reintroduce it silently. There is one
/// way to learn the owner, and it cannot skip the refresh.
#[cfg(not(mobile))]
fn current_home_owner(state: &DesktopServerState) -> DesktopOwner {
    refresh_home_ownership_if_stale(state);
    state
        .owner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

#[cfg(not(mobile))]
pub(crate) fn desktop_owner_snapshot(app: &AppHandle) -> DesktopOwnerSnapshot {
    let Some(state) = app.try_state::<DesktopServerState>() else {
        return DesktopOwnerSnapshot::Unavailable;
    };
    owner_snapshot(current_home_owner(&state))
}

#[cfg(not(mobile))]
fn unified_server_status(app: &AppHandle) -> BundledServerStatus {
    let Some(state) = app.try_state::<DesktopServerState>() else {
        return unavailable_status(
            app,
            "Station could not select a safe local owner.".into(),
            "Desktop local ownership is not initialized.".into(),
        );
    };
    match home_status_route(current_home_owner(&state)) {
        HomeStatusRoute::SidecarSupervisor => state
            .supervisor
            .status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone(),
        HomeStatusRoute::AttachedService { id, port } => attached_service_status(app, &id, port),
        // Only what the derivation establishes: the registry was read, no live
        // service owns this home, and this desktop holds no sidecar claim. It
        // deliberately does NOT say the service was "unregistered" -- a stopped
        // service is usually still registered, just not alive, and an empty
        // registry never had one.
        HomeStatusRoute::UnownedHome => unowned_home_status(
            app,
            "No Station is running for this home.".into(),
            "No live service owns this home and this desktop holds no sidecar claim.".into(),
        ),
        HomeStatusRoute::RegistryUnavailable => unavailable_status(
            app,
            "Station could not select a safe local owner.".into(),
            "The home-scoped registry is unavailable or ambiguous.".into(),
        ),
    }
}

#[cfg(not(mobile))]
#[tauri::command]
async fn bundled_server_status(app: AppHandle) -> BundledServerStatus {
    unified_server_status(&app)
}

#[cfg(not(mobile))]
#[tauri::command]
fn open_desktop_tray_menu(app: AppHandle) -> Result<bool, String> {
    crate::tray::open_menu(&app)
}

#[cfg(not(mobile))]
pub(crate) fn emit_service_status(app: &AppHandle) {
    let _ = app.emit(
        "station://bundled-server-status",
        unified_server_status(app),
    );
}

#[cfg(not(mobile))]
#[tauri::command]
fn restart_bundled_server(app: AppHandle) -> Result<(), String> {
    let state = app
        .try_state::<DesktopServerState>()
        .ok_or("Desktop local ownership is not initialized.")?;
    if state
        .owner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
        != DesktopOwner::Sidecar
    {
        return Err(
            "Station is attached to a durable service; restart controls never signal that service."
                .into(),
        );
    }
    state
        .supervisor
        .tx
        .send(SupervisorMessage::Restart)
        .map_err(|_| "Station sidecar supervisor is unavailable.")?;
    crate::tray::kick(&app);
    Ok(())
}

#[cfg(not(mobile))]
fn apply_supervisor_input(
    supervisor: &Arc<ServerSupervisor>,
    input: SupervisorInput,
) -> Vec<SupervisorEffect> {
    let (next, effects) = {
        let current = supervisor
            .status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        transition(&current, &input)
    };
    *supervisor
        .status
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = next;
    effects
}

#[cfg(not(mobile))]
fn spawn_sidecar_child(context: &SidecarRuntimeContext) -> Result<(Child, String), String> {
    let boot_id = fresh_sidecar_boot_id();
    build_sidecar_command(&context.launch, &boot_id)
        .spawn()
        .map(|child| (child, boot_id))
        .map_err(|error| format!("launch Station sidecar: {error}"))
}

#[cfg(not(mobile))]
fn spawn_sidecar_stdout_reader(
    stdout: std::process::ChildStdout,
    generation: u64,
    tx: Sender<SupervisorMessage>,
) {
    let _ = thread::Builder::new()
        .name("station-sidecar-stdout".into())
        .spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Some(listening) = parse_generation_tagged_listening(generation, &line) {
                    let _ = tx.send(SupervisorMessage::Listening {
                        generation: listening.generation,
                        port: listening.port,
                    });
                }
            }
        });
}

#[cfg(not(mobile))]
fn spawn_sidecar_stderr_reader(
    stderr: std::process::ChildStderr,
    status: Arc<Mutex<BundledServerStatus>>,
) -> Option<(thread::JoinHandle<()>, Receiver<()>)> {
    let (complete_tx, complete_rx) = channel();
    thread::Builder::new()
        .name("station-sidecar-stderr".into())
        .spawn(move || {
            let detail = capture_sidecar_stderr(stderr);
            if let Some(detail) = detail {
                let mut status = status
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                status.detail = Some(detail);
            }
            let _ = complete_tx.send(());
        })
        .ok()
        .map(|reader| (reader, complete_rx))
}

#[cfg(not(mobile))]
fn capture_sidecar_stderr(stderr: std::process::ChildStderr) -> Option<String> {
    let mut lines = Vec::new();
    for line in BufReader::new(stderr).lines().flatten() {
        lines.push(line);
        if lines.len() > 16 {
            lines.remove(0);
        }
    }
    (!lines.is_empty()).then(|| lines.join("\n"))
}

/// The direct child can exit while a descendant retains its stderr pipe. Keep
/// the deterministic tail when it arrives promptly, but never let that
/// descendant block claim cleanup.
#[cfg(not(mobile))]
fn drain_sidecar_stderr(supervisor: &Arc<ServerSupervisor>) {
    if let Some((reader, complete)) = supervisor
        .stderr_reader
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
    {
        drain_sidecar_stderr_reader(reader, complete);
    }
}

/// Returns whether the reader completed in the bounded grace period. Keeping
/// this seam separate lets the inherited-stderr regression prove that cleanup
/// proceeds even after the direct child exits but a descendant keeps the pipe.
#[cfg(not(mobile))]
fn drain_sidecar_stderr_reader(reader: thread::JoinHandle<()>, complete: Receiver<()>) -> bool {
    if complete.recv_timeout(Duration::from_millis(200)).is_ok() {
        let _ = reader.join();
        true
    } else {
        false
    }
}

#[cfg(not(mobile))]
fn terminate_desktop_child(child: &mut Child) {
    #[cfg(unix)]
    {
        let _ = Command::new("/bin/kill")
            .args(["-TERM", &child.id().to_string()])
            .status();
    }
    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        command.args(["/T", "/PID", &child.id().to_string()]);
        apply_no_window(&mut command);
        let _ = command.status();
    }
    for _ in 0..20 {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(mobile))]
fn reap_sidecar(supervisor: &Arc<ServerSupervisor>) {
    if let Some(mut child) = supervisor
        .child
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
    {
        terminate_desktop_child(&mut child);
    }
    drain_sidecar_stderr(supervisor);
}

#[cfg(not(mobile))]
fn run_sidecar_supervisor(
    supervisor: Arc<ServerSupervisor>,
    app: AppHandle,
    rx: Receiver<SupervisorMessage>,
) {
    let mut generation = 0_u64;
    loop {
        if supervisor.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        generation += 1;
        let child = match spawn_sidecar_child(&supervisor.context) {
            Ok((mut child, boot_id)) => {
                if let Some(stdout) = child.stdout.take() {
                    spawn_sidecar_stdout_reader(stdout, generation, supervisor.tx.clone());
                }
                if let Some(stderr) = child.stderr.take() {
                    *supervisor
                        .stderr_reader
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                        spawn_sidecar_stderr_reader(stderr, supervisor.status.clone());
                }
                *supervisor
                    .child
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(child);
                apply_supervisor_input(&supervisor, SupervisorInput::Spawned);
                {
                    let mut status = supervisor
                        .status
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                    status.generation = Some(generation);
                    status.instance_id = Some(supervisor.context.launch.instance_id.clone());
                    status.boot_id = Some(boot_id);
                }
                crate::tray::kick(&app);
                true
            }
            Err(error) => {
                let mut status = supervisor
                    .status
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                status.detail = Some(error);
                drop(status);
                false
            }
        };
        if !child {
            let _ = remove_registry_bridge(
                &supervisor.context.launch.resource_dir,
                &supervisor.context.launch.station_home,
                &supervisor.context.registry_id,
            );
            let effects = apply_supervisor_input(
                &supervisor,
                SupervisorInput::Exited {
                    code: None,
                    detail: supervisor
                        .status
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .detail
                        .clone(),
                },
            );
            crate::tray::kick(&app);
            if !drive_supervisor_effects(&supervisor, &app, &rx, effects) {
                return;
            }
            continue;
        }
        loop {
            match rx.recv_timeout(Duration::from_millis(150)) {
                Ok(SupervisorMessage::Shutdown) => {
                    reap_sidecar(&supervisor);
                    let _ = remove_registry_bridge(
                        &supervisor.context.launch.resource_dir,
                        &supervisor.context.launch.station_home,
                        &supervisor.context.registry_id,
                    );
                    return;
                }
                Ok(SupervisorMessage::Restart) => {
                    let effects =
                        apply_supervisor_input(&supervisor, SupervisorInput::ManualRestart);
                    crate::tray::kick(&app);
                    reap_sidecar(&supervisor);
                    // Retain this supervisor's atomic claim across generations.
                    // Releasing it here creates a race in which another desktop
                    // can claim the home before this restart respawns.
                    if !drive_supervisor_effects(&supervisor, &app, &rx, effects) {
                        return;
                    }
                    break;
                }
                Ok(SupervisorMessage::Listening {
                    generation: seen,
                    port,
                }) if seen == generation => {
                    let pid = supervisor
                        .child
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .as_ref()
                        .map(Child::id);
                    if !registry_claim_allows_running(upsert_registry_bridge(
                        &supervisor.context.launch.resource_dir,
                        &supervisor.context.launch.station_home,
                        &supervisor.context.registry_id,
                        serde_json::json!({"type":"sidecar","status":"running","port":port,"pid":pid,"startedAt":format!("{}", SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs())}),
                    )) {
                        reap_sidecar(&supervisor);
                        let _ = remove_registry_bridge(
                            &supervisor.context.launch.resource_dir,
                            &supervisor.context.launch.station_home,
                            &supervisor.context.registry_id,
                        );
                        let mut status = supervisor
                            .status
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        status.phase = bundled_server_state::ServerPhase::Failed;
                        status.fail_closed = true;
                        status.api_base = None;
                        status.port = None;
                        status.message =
                            "Station could not publish its sidecar ownership claim.".into();
                        status.detail = Some("The home-scoped registry refused the sidecar claim; Station stopped it to prevent duplicate ownership.".into());
                        drop(status);
                        crate::tray::kick(&app);
                        return;
                    }
                    // Running is published only after its registry claim is
                    // durable; otherwise the UI would assert ownership that
                    // no other process can observe.
                    apply_supervisor_input(&supervisor, SupervisorInput::Listening { port });
                    if let Some(boot_id) = supervisor
                        .status
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .boot_id
                        .clone()
                    {
                        observe_startup_ticket(
                            &app,
                            startup_readiness::StartupTicket {
                                generation,
                                instance_id: supervisor.context.launch.instance_id.clone(),
                                boot_id,
                                api_base: format!("http://127.0.0.1:{port}"),
                            },
                        );
                    }
                    crate::tray::kick(&app);
                }
                Ok(SupervisorMessage::Listening { .. }) => {}
                Err(RecvTimeoutError::Timeout) => {
                    let exit = supervisor
                        .child
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .as_mut()
                        .and_then(|child| {
                            child.try_wait().ok().flatten().map(|status| status.code())
                        });
                    if let Some(code) = exit {
                        supervisor
                            .child
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .take();
                        // The child has exited, so its stderr pipe is closed.
                        // Drain the reader before classifying this exit: a
                        // fail-closed marker written immediately before exit
                        // must win over retry classification.
                        drain_sidecar_stderr(&supervisor);
                        let _ = remove_registry_bridge(
                            &supervisor.context.launch.resource_dir,
                            &supervisor.context.launch.station_home,
                            &supervisor.context.registry_id,
                        );
                        let detail = supervisor
                            .status
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .detail
                            .clone();
                        let effects = apply_supervisor_input(
                            &supervisor,
                            SupervisorInput::Exited { code, detail },
                        );
                        observe_startup_loss(&app, generation);
                        crate::tray::kick(&app);
                        if !drive_supervisor_effects(&supervisor, &app, &rx, effects) {
                            return;
                        }
                        break;
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    reap_sidecar(&supervisor);
                    let _ = remove_registry_bridge(
                        &supervisor.context.launch.resource_dir,
                        &supervisor.context.launch.station_home,
                        &supervisor.context.registry_id,
                    );
                    return;
                }
            }
        }
    }
}

#[cfg(not(mobile))]
fn drive_supervisor_effects(
    supervisor: &Arc<ServerSupervisor>,
    app: &AppHandle,
    rx: &Receiver<SupervisorMessage>,
    effects: Vec<SupervisorEffect>,
) -> bool {
    for effect in effects {
        match effect {
            SupervisorEffect::Respawn { delay_ms } => {
                match rx.recv_timeout(Duration::from_millis(delay_ms)) {
                    Ok(SupervisorMessage::Shutdown) | Err(RecvTimeoutError::Disconnected) => {
                        return false
                    }
                    Ok(SupervisorMessage::Restart) | Err(RecvTimeoutError::Timeout) => return true,
                    Ok(SupervisorMessage::Listening { .. }) => return true,
                }
            }
            SupervisorEffect::GracefulStopThenRespawn => return true,
            SupervisorEffect::Kill => return false,
            SupervisorEffect::None => {
                let phase = supervisor
                    .status
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .phase;
                if matches!(
                    phase,
                    bundled_server_state::ServerPhase::Failed
                        | bundled_server_state::ServerPhase::Stopped
                ) {
                    loop {
                        match rx.recv() {
                            Ok(SupervisorMessage::Restart) => return true,
                            Ok(SupervisorMessage::Shutdown) | Err(_) => return false,
                            Ok(SupervisorMessage::Listening { .. }) => crate::tray::kick(app),
                        }
                    }
                }
            }
        }
    }
    true
}

/// Idempotently tear down only the child tracked by this desktop process. An
/// attached durable service has no child in this state and is never signalled.
#[cfg(not(mobile))]
pub(crate) fn teardown_sidecar(app: &AppHandle) {
    // The tray poll is app-owned, not sidecar-owned. Stop it explicitly on
    // every native exit so its managed wake sender cannot be mistaken for a
    // detached worker's lifetime.
    crate::tray::shutdown(app);
    let Some(state) = app.try_state::<DesktopServerState>() else {
        return;
    };
    if !owner_owns_reapable_child(
        state
            .owner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone(),
    ) {
        return;
    }
    if state.supervisor.shutting_down.swap(true, Ordering::SeqCst) {
        return;
    }
    apply_supervisor_input(&state.supervisor, SupervisorInput::ShutdownRequested);
    let _ = state.supervisor.tx.send(SupervisorMessage::Shutdown);
    // The supervisor is the sole registry writer/remover.  Wait for it to
    // reap the child and remove its claim before process exit can release the
    // desktop host's ownership boundary.
    if let Some(handle) = state
        .supervisor
        .thread
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take()
    {
        let _ = handle.join();
    }
    crate::tray::kick(app);
}

/// `STATION_DESKTOP_LOG_LEVEL` selects the desktop shell's log verbosity
/// (`trace`/`debug`/`info`/`warn`/`error`/`off`, case-insensitive — the `log`
/// crate's own `LevelFilter` grammar). Unset or empty keeps the default,
/// `info`; an unparseable value also falls back to `info`, and the returned
/// raw value is logged once at `warn` after the logger attaches so the
/// misconfiguration is visible instead of silently ignored.
fn resolve_desktop_log_level(raw: Option<String>) -> (log::LevelFilter, Option<String>) {
    match raw {
        None => (log::LevelFilter::Info, None),
        Some(raw) if raw.trim().is_empty() => (log::LevelFilter::Info, None),
        Some(raw) => match raw.trim().parse::<log::LevelFilter>() {
            Ok(level) => (level, None),
            Err(_) => (log::LevelFilter::Info, Some(raw)),
        },
    }
}

/// Whether the build-time Tauri config carries a usable `plugins.updater`
/// entry (#575): a non-empty `pubkey` and at least one non-empty `endpoints`
/// URL. `scripts/lib/native-release-config.mjs`'s `createNativeReleaseConfig`
/// writes the pubkey at this exact `plugins.updater.pubkey` path — a renamed
/// key on either side must fail
/// `desktop_updater_config_key_path_matches_the_release_config_emitter`
/// below (Rust) and its JS-side counterpart pinning the same path.
///
/// The two halves of this check exist for different reasons:
///
/// - The `pubkey` half is crash-avoidance. `tauri_plugin_updater::Config`'s
///   own deserializer requires `pubkey` with no default, so registering the
///   plugin against a config with no `plugins.updater` key at all (every dev
///   build) — or one whose `endpoints` entries are not valid URLs (a blank
///   or malformed string) — fails `Builder::build()` and aborts the whole
///   application, not just self-update. This check must run BEFORE the
///   plugin is registered, not inside its setup, so that config skips
///   registration entirely instead of crashing startup.
/// - The `endpoints`-non-empty half is NOT crash-avoidance: a pubkey with
///   `endpoints` absent or `[]` deserializes fine — `Config.endpoints`
///   defaults to an empty `Vec`. Requiring it non-empty here is deliberate
///   inertness policy: a registered plugin with zero endpoints would boot
///   without crashing but could never find an update, which is a worse,
///   quieter failure than not registering at all. This is the shape
///   `native-release-config.mjs`'s pubkey-only overlay produces today for
///   every channel before its endpoint ships.
#[cfg(not(mobile))]
fn desktop_updater_plugin_configured(
    plugins: &std::collections::HashMap<String, serde_json::Value>,
) -> bool {
    plugins
        .get("updater")
        .and_then(serde_json::Value::as_object)
        .is_some_and(|config| {
            config
                .get("pubkey")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|value| !value.trim().is_empty())
                && config
                    .get("endpoints")
                    .and_then(serde_json::Value::as_array)
                    .is_some_and(|endpoints| {
                        !endpoints.is_empty()
                            && endpoints.iter().all(|endpoint| {
                                endpoint
                                    .as_str()
                                    .is_some_and(|value| !value.trim().is_empty())
                            })
                    })
        })
}

/// The desktop shell's own log file's name (no extension — matches
/// `tauri_plugin_log::TargetKind::LogDir { file_name }`'s own vocabulary),
/// within `app_log_dir()`. `run()`'s `LogDir` target registration (every
/// target, mobile included — hence no `cfg(not(mobile))` here) and
/// `desktop_log_file_path_within` below both read this ONE constant so the
/// file the plugin actually writes and the path Desktop reports to the UI
/// cannot drift apart (#1899 review). Bound by
/// `desktop_log_file_path_matches_the_file_name_registered_with_the_log_plugin`.
const DESKTOP_LOG_FILE_NAME: &str = "station";

/// Mirrors exactly what `tauri-plugin-log`'s `LogDir` target writes for
/// `file_name: Some(DESKTOP_LOG_FILE_NAME.into())`: the vendored crate's
/// `RotatingFile::new` resolves the file at
/// `dir.join(&file_name).with_extension("log")` (tauri-plugin-log
/// src/lib.rs:184, `acquire_logger`'s `LogDir` arm). `app_log_dir()` alone —
/// the previous bug — is the *directory*; this is the *file*.
#[cfg(not(mobile))]
fn desktop_log_file_path_within(app_log_dir: &std::path::Path) -> String {
    app_log_dir
        .join(DESKTOP_LOG_FILE_NAME)
        .with_extension("log")
        .to_string_lossy()
        .to_string()
}

/// Mirrors tauri's OWN (desktop-target) `app_log_dir()` resolution —
/// `path/desktop.rs` in tauri-2.11.5, which macOS/Windows/Linux/iOS all share
/// (only Android goes through a different, JNI-backed path — see
/// `path/mod.rs`'s `#[cfg(not(target_os = "android"))] mod desktop`). Used
/// so the writability pre-check below (#1899 review) can run before an
/// `AppHandle` exists — the log plugin registers before one does.
#[cfg(not(mobile))]
fn app_log_dir_for(identifier: &str) -> Option<std::path::PathBuf> {
    #[cfg(target_os = "macos")]
    {
        dirs::home_dir().map(|dir| dir.join("Library/Logs").join(identifier))
    }
    #[cfg(not(target_os = "macos"))]
    {
        dirs::data_local_dir().map(|dir| dir.join(identifier).join("logs"))
    }
}

/// A real write probe, not just directory creation: some mounts allow
/// `mkdir` while denying file writes, and `create_dir_all` alone would pass
/// exactly the case this guards against.
#[cfg(not(mobile))]
fn log_dir_is_writable(dir: &std::path::Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".station-desktop-log-write-probe");
    match std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&probe)
    {
        Ok(_) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let (log_level, invalid_log_level) =
        resolve_desktop_log_level(std::env::var("STATION_DESKTOP_LOG_LEVEL").ok());
    let context = tauri::generate_context!();

    // Dev-build narration, BEFORE any plugin exists. A `tauri dev` build
    // shares its single-instance scope with the installed stable app (both
    // use the base `tauri.conf.json` identifier; only nightly's differs), so
    // launching dev while the stable app runs makes THIS process the doomed
    // secondary: the single-instance plugin focuses the stable window and
    // exits us during registration — before the log plugin exists, so the
    // exit is otherwise silent. `eprintln!` because there is no logger yet
    // and dev launches always have a terminal; `debug_assertions` because a
    // released binary must not narrate (and a release secondary's stderr
    // goes nowhere anyway).
    #[cfg(all(not(mobile), debug_assertions))]
    eprintln!(
        "station-desktop dev: single-instance scope is '{}' — shared with the installed stable app. \
If a stable instance is running, this launch will focus its window and exit.",
        context.config().identifier
    );

    // The log plugin's own `setup` does `create_dir_all` + opens the file,
    // and an `Err` there used to propagate all the way to `Builder::build()`
    // — so a double-clicked .app with an unwritable log dir never showed a
    // window (#1899 review). Pre-check and degrade to Stdout-only instead;
    // logging must never be why the app fails to boot. Mobile is not
    // pre-checked: Android's log dir does not resolve through this
    // (desktop-only) path logic at all, and always registers the LogDir
    // target as before.
    #[cfg(not(mobile))]
    let log_dir_writable = app_log_dir_for(&context.config().identifier)
        .map(|dir| log_dir_is_writable(&dir))
        .unwrap_or(false);
    // Read once, before any plugin is registered: whether this build carries
    // a usable updater configuration decides whether the plugin is
    // registered at all, not merely how it behaves once running.
    #[cfg(not(mobile))]
    let updater_configured = desktop_updater_plugin_configured(&context.config().plugins.0);
    #[cfg(mobile)]
    let log_dir_writable = true;

    // Every target, mobile included: `tauri-plugin-log` lists android/ios as
    // "full" support in its own platform metadata, and a double-clicked .app
    // (no terminal attached to inherit stderr) is exactly the case a bare
    // `eprintln!` never reached (#1899). Stdout is kept for terminal/dev
    // launches; `LogDir` writes under Tauri's platform `app_log_dir()`
    // convention so the file survives across runs. Bounded to 5 files of 5MB
    // each (25MB ceiling) — `KeepSome` renames the previous file with a date
    // suffix on rotation rather than deleting silently.
    let mut log_targets = vec![tauri_plugin_log::Target::new(
        tauri_plugin_log::TargetKind::Stdout,
    )];
    if log_dir_writable {
        log_targets.push(tauri_plugin_log::Target::new(
            tauri_plugin_log::TargetKind::LogDir {
                file_name: Some(DESKTOP_LOG_FILE_NAME.to_string()),
            },
        ));
    }
    let builder = tauri::Builder::default();

    // FIRST plugin, deliberately. In a secondary instance this plugin exits
    // the process during registration, so no OTHER plugin or setup side effect
    // runs there — no log rotation, no deep-link registration, no sidecar
    // claim, no registry write. (Not literally "nothing": run() performs a
    // log-dir writability probe before the builder exists, so a secondary
    // does one benign create/delete of a probe file first.) Register this
    // later and the doomed secondary performs real side effects instead.
    //
    // The primary's callback receives the secondary's argv. The `deep-link`
    // feature routes any URL in it to tauri-plugin-deep-link's handlers —
    // which is how a pairing link opened on Windows/Linux reaches the RUNNING
    // app instead of a new process (on macOS deep links arrive via Apple
    // Events, never argv, so the feature is inert there by design). The
    // callback itself only brings the existing window to the user.
    #[cfg(not(mobile))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(
        |app, _argv, _cwd| match app.get_webview_window("main") {
            Some(window) => {
                log::info!(
                    "second launch detected; requesting main window activation '{}'",
                    window.label()
                );
                request_main_window_activation(app);
            }
            None => {
                log::warn!("second launch detected but no window exists to focus");
            }
        },
    ));

    let mut builder = builder.plugin(
        tauri_plugin_log::Builder::new()
            .level(log_level)
            .max_file_size(5 * 1024 * 1024)
            .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(5))
            .targets(log_targets)
            .build(),
    );

    // The MCP host owns a narrow external-link command; register the opener on
    // mobile too so that command has the same OS-owned boundary everywhere.
    builder = builder.plugin(
        tauri_plugin_opener::Builder::new()
            .open_js_links_on_click(false)
            .build(),
    );

    #[cfg(not(mobile))]
    {
        // The Rust-owned tray opens one validated local Station URL. Disable
        // the opener plugin's default JavaScript link interception so the
        // webview receives no generic opener authority.
        // Registered only when the build carries a usable updater config —
        // see `desktop_updater_plugin_configured`'s doc comment for why an
        // unconditional registration is unsafe here.
        if updater_configured {
            builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
        }
        // Config-free, so this is always registered: it is the only way the
        // webview can relaunch the process, which the update-install flow
        // needs after `updater_configured` is true, but restart is also
        // reasonable chrome to offer regardless of that.
        builder = builder.plugin(tauri_plugin_process::init());
    }

    // Every target, mobile included: this is the only way a notification
    // reaches the native shell at all. Web push needs PushManager, which
    // Android WebView does not implement, so the app silently never subscribes.
    let builder = builder
        .plugin(tauri_plugin_notification::init())
        // Native OS dialogs for the consent broker (station#3677 PR 3): the
        // approval surface must be chrome webview JS cannot script.
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(notification_watch::NotificationWatch::default());
    // Mobile-only haptic feedback (station#1954). Capability report marks
    // haptics unsupported off-mobile so the webview never calls it there.
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_haptics::init());
    let builder = builder
        .manage(NativeProfileAuthority::default())
        .manage(NativePendingPairingCredentials::default())
        .manage(NativeHttpCancellation::default())
        .manage(NativePairingExchangeCancellation::default());
    #[cfg(not(mobile))]
    let builder = builder
        .manage(NativeStartupBootstrap::default())
        .on_page_load(|webview, payload| {
            observe_native_startup_page(webview.app_handle(), webview.label(), payload.event());
        })
        .manage(NativeBrowserPreviewGrants::default())
        .manage(ssh_launcher::SshLaunches::default());

    #[cfg(not(mobile))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        native_capability_report,
        credential_vault_delete,
        credential_vault_delete_unreferenced,
        credential_vault_commit_pairing,
        station_profile_authorize_active,
        station_ensure_bundled_local_profile,
        station_local_self_provision,
        station_native_http_request,
        station_native_http_cancel,
        station_native_consent_review,
        station_native_pairing_exchange,
        station_native_pairing_exchange_cancel,
        station_profile_store_read,
        station_profile_store_write,
        notification_watch_start,
        notification_watch_stop,
        open_local_browser_preview,
        open_external_link,
        discover_local_browser_preview_target,
        open_local_browser_preview_window,
        open_workspace_pane_pop_out,
        bundled_server_status,
        open_desktop_tray_menu,
        restart_bundled_server,
        commit_renderer_mount,
        commit_startup_readiness,
        commit_startup_recovery_ui,
        ssh_env_probe,
        ssh_launch_start,
        ssh_launch_status,
        ssh_launch_cancel,
        ssh_launch_mark_identity_verified
    ]);
    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        native_capability_report,
        open_external_link,
        credential_vault_delete,
        credential_vault_delete_unreferenced,
        credential_vault_commit_pairing,
        station_profile_authorize_active,
        station_native_http_request,
        station_native_http_cancel,
        station_native_consent_review,
        station_native_pairing_exchange,
        station_native_pairing_exchange_cancel,
        station_profile_store_read,
        station_profile_store_write,
        notification_watch_start,
        notification_watch_stop
    ]);

    builder
        .setup(move |app| {
            if let Some(raw) = &invalid_log_level {
                log::warn!(
                    "invalid STATION_DESKTOP_LOG_LEVEL={raw:?}; using the default (info). Expected one of trace, debug, info, warn, error, off."
                );
            }
            if !log_dir_writable {
                log::warn!(
                    "the desktop log directory is not writable; logging is degraded to stdout only for this run"
                );
            }
            log::info!(
                "Station desktop starting (version {})",
                app.package_info().version
            );
            #[cfg(not(mobile))]
            if updater_configured {
                log::info!("desktop updater plugin registered");
            } else {
                log::debug!(
                    "desktop updater plugin not registered; this build has no updater plugin configuration"
                );
            }

            #[cfg(not(mobile))]
            {
                let activation_app = app.handle().clone();
                let pending_activation = Arc::new(PendingMainWindowActivation::default());
                let pending_activation_for_deep_link = Arc::clone(&pending_activation);
                app.handle().deep_link().on_open_url(move |event| {
                    // macOS delivers open-document Apple Events here. Retain
                    // the plugin's URL event for the renderer and never let
                    // this activation bypass the main-window authority. The
                    // handler may run before setup manages readiness, so
                    // retain its activation until that authority exists.
                    let urls = event.urls().into_iter().map(|url| url.to_string()).collect::<Vec<_>>();
                    let _ = activation_app.emit("station://pairing-deep-link", urls);
                    request_or_defer_main_window_activation(
                        &activation_app,
                        &pending_activation_for_deep_link,
                    );
                });
                let resource_dir = simplified_sidecar_resource_dir(&app.path().resource_dir()?);
                let packaged_channel = if cfg!(debug_assertions) {
                    None
                } else {
                    channel_ports_generated::desktop_channel_from_identifier(&app.config().identifier)
                };
                let station_home = service_state::resolve_station_home_for_channel(
                    packaged_channel.map(std::ffi::OsStr::new),
                );
                // The desktop owns both path derivations.  Pass these exact
                // values to the bridge rather than letting its Node process
                // select a root/home from inherited environment or cwd.
                let station_root = service_state::resolve_station_root();
                let prepared_home = prepare_desktop_station_home(
                    station_home.clone(),
                    |home| {
                        invoke_registry_bridge(
                            &resource_dir,
                            "ensureHomeSchema",
                            serde_json::json!({ "home": home }),
                        )
                        .map(|_| ())
                        .map_err(|error| format!("{error:?}"))
                    },
                );
                let station_home = match prepared_home {
                    Ok(home) => home,
                    Err(error) => {
                        exit_desktop_home_preparation_failure(
                            app,
                            "Station could not validate its home folder",
                            "Station could not validate its data folder. Review the detail below, correct the folder problem without deleting data, then launch Station again.",
                            &error,
                        );
                        return Ok(());
                    }
                };
                let preparation_kind = match prepare_runtime_registry_bridge(
                    &resource_dir,
                    &station_root,
                    &station_home,
                ) {
                    Ok(kind) => kind,
                    Err(_) => {
                        exit_desktop_home_preparation_failure(
                            app,
                            "Station could not prepare its runtime state",
                            "Station refused an unsafe legacy service record before starting a backend.",
                            "runtime preparation bridge refused the selected home",
                        );
                        return Ok(());
                    }
                };
                log::info!(
                    "desktop runtime preparation completed: kind={}",
                    preparation_kind.as_str()
                );
                let home = std::env::var("HOME").unwrap_or_default();
                let log_dir = app.path().app_log_dir().unwrap_or_else(|_| std::env::temp_dir());
                let stdout_log = log_dir.join("station-sidecar.log").to_string_lossy().to_string();
                let stderr_log = log_dir.join("station-sidecar-err.log").to_string_lossy().to_string();
                let (tx, rx) = channel();
                let mut status = BundledServerStatus::initial(stdout_log, stderr_log);
                status.desktop_log_path = app.path().app_log_dir().ok().map(|dir| desktop_log_file_path_within(&dir));
                let pinned_port = resolve_pinned_desktop_port(
                    std::env::var("STATION_DESKTOP_PORT").ok().as_deref(),
                    packaged_channel,
                )
                .map_err(|error| format!("invalid desktop sidecar port: {error}"))?;
                let supervisor_birth = supervisor_birth_bridge(&resource_dir, &station_home)
                    .map_err(|error| {
                        log::error!("desktop registry bridge could not establish supervisor identity: {error:?}");
                        "Desktop could not establish supervisor identity."
                    })?;
                let supervisor = Arc::new(ServerSupervisor {
                    child: Mutex::new(None), status: Arc::new(Mutex::new(status)), stderr_reader: Mutex::new(None), shutting_down: AtomicBool::new(false), tx, thread: Mutex::new(None),
                    context: SidecarRuntimeContext {
                        // `registry_id` below is deliberately process-scoped:
                        // it owns one live child claim. `instance_id` is the
                        // server's public identity and therefore remains stable
                        // across that child's supervised boot rotations.
                        launch: SidecarLaunchContext { resource_dir: resource_dir.clone(), station_root: station_root.clone(), station_home: station_home.clone(), home, shell_path: resolve_login_shell_path(), channel: packaged_channel.map(str::to_owned), pinned_port, supervisor_birth, instance_id: desktop_sidecar_instance_id(packaged_channel, &app.config().identifier) },
                        registry_id: format!("desktop-sidecar-{}", std::process::id()),
                    },
                });
                let ownership = decide_home_ownership_from_runtime(&resource_dir, &station_home);
                let mut owner = owner_for_decision(ownership);
                // Reserve before the child is launched.  The shared module
                // performs this compare-and-set under its mutation lock, so
                // two desktops cannot both win a home-scoped sidecar slot.
                if owner == DesktopOwner::Sidecar {
                    let context = &supervisor.context;
                    let claimed = claim_sidecar_registry_bridge(
                        &resource_dir,
                        &station_home,
                        &context.registry_id,
                        serde_json::json!({"type":"sidecar","status":"starting","port":0}),
                    )
                    .map_err(|error| {
                        log::error!("desktop registry bridge could not claim the sidecar slot: {error:?}");
                        error
                    })
                    .unwrap_or(false);
                    log::info!("desktop sidecar registry claim: claimed={claimed}");
                    if !claimed { owner = DesktopOwner::None; }
                }
                let (readiness, effects) = startup_readiness::transition(
                    &startup_readiness::StartupReadiness::default(),
                    startup_readiness::ReadinessInput::Begin {
                        now_ms: 0,
                        timeout_ms: 30_000,
                        dev_bypass: cfg!(debug_assertions),
                        owned_sidecar: owner == DesktopOwner::Sidecar,
                    },
                );
                #[cfg(target_os = "macos")]
                if let Some(dispatcher) = native_cover_dispatcher(app.handle().clone()) {
                    app.manage(dispatcher);
                }
                app.manage(DesktopServerState { owner: Mutex::new(owner.clone()), supervisor: supervisor.clone(), readiness: Mutex::new(readiness), startup_commit_in_flight: AtomicBool::new(false), startup_commit_pending: AtomicBool::new(false), ownership_checked_at: Mutex::new(Some(Instant::now())) });
                replay_native_startup_renderer_observations(app.handle());
                replay_pending_main_window_activation(app.handle(), &pending_activation);
                // The tray poll reads this managed ownership state. Starting
                // it earlier allowed its first poll to see only the
                // fail-closed initialization placeholder and then stop before
                // the sidecar could publish its healthy state.
                tray::init(app.handle())?;
                if effects.contains(&startup_readiness::ReadinessEffect::RevealMainWindow) { reveal_main_window(app.handle()); }
                if !cfg!(debug_assertions) { arm_startup_deadline(app.handle().clone(), 1); }
                if owner == DesktopOwner::Sidecar {
                    let app_handle = app.handle().clone();
                    let handle = thread::Builder::new().name("station-sidecar-supervisor".into()).spawn(move || run_sidecar_supervisor(supervisor, app_handle, rx))
                        .expect("failed to start Station sidecar supervisor thread");
                    *app.state::<DesktopServerState>().supervisor.thread.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(handle);
                }
            }

            let _ = app;
            Ok(())
        })
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(all(not(mobile), target_os = "macos"))]
            if let tauri::RunEvent::Reopen { .. } = event {
                request_main_window_activation(app);
            }
            #[cfg(not(mobile))]
            if let tauri::RunEvent::Exit = event { teardown_sidecar(app); }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(not(mobile))]
    fn tray_initialization_follows_desktop_ownership_management() {
        let source = include_str!("lib.rs");
        let ownership_management = source
            .find("app.manage(DesktopServerState {")
            .expect("desktop ownership management exists");
        let tray_initialization = source
            .find("tray::init(app.handle())?;")
            .expect("tray initialization exists");

        assert!(
            ownership_management < tray_initialization,
            "tray polling must start only after DesktopServerState exists"
        );
    }

    #[test]
    #[cfg(not(mobile))]
    fn cold_link_activation_is_retained_until_hidden_window_readiness_exists() {
        let pending = PendingMainWindowActivation::default();
        assert!(
            !pending.request(),
            "an Apple Event received before DesktopServerState must replay once readiness exists"
        );
        assert!(
            pending.install_readiness(),
            "replaying the same cold activation twice could incorrectly focus a later window"
        );
        assert!(
            !pending.install_readiness(),
            "setup must not replay the same cold activation twice"
        );

        let (waiting, _) = startup_readiness::transition(
            &startup_readiness::StartupReadiness::default(),
            startup_readiness::ReadinessInput::Begin {
                now_ms: 1,
                timeout_ms: 10,
                dev_bypass: false,
                owned_sidecar: true,
            },
        );
        let (waiting, effects) = startup_readiness::transition(
            &waiting,
            startup_readiness::ReadinessInput::ActivationRequested,
        );
        assert_eq!(
            effects,
            vec![
                startup_readiness::ReadinessEffect::PresentStartupRecoverySurface,
                startup_readiness::ReadinessEffect::DeferActivation,
            ]
        );
        let ticket = startup_readiness::StartupTicket {
            generation: 1,
            instance_id: "desktop-sidecar-beta".into(),
            boot_id: "boot-beta".into(),
            api_base: "http://127.0.0.1:4141".into(),
        };
        let (waiting, _) = startup_readiness::transition(
            &waiting,
            startup_readiness::ReadinessInput::ServerTicket(ticket.clone()),
        );
        let (waiting, identity_effects) = startup_readiness::transition(
            &waiting,
            startup_readiness::ReadinessInput::NativeIdentityCommitted(ticket),
        );
        assert!(identity_effects.is_empty());
        let (_, effects) = startup_readiness::transition(
            &waiting,
            startup_readiness::ReadinessInput::RendererMounted,
        );
        assert_eq!(
            effects,
            vec![startup_readiness::ReadinessEffect::RevealMainWindow]
        );
    }

    #[test]
    #[cfg(not(mobile))]
    fn cold_activation_handoff_has_no_lost_wakeup_under_setup_interleavings() {
        use std::sync::Barrier;

        let setup_before_event = PendingMainWindowActivation::default();
        assert!(!setup_before_event.install_readiness());
        assert!(
            setup_before_event.request(),
            "an event arriving after setup must activate directly"
        );

        let event_before_setup = PendingMainWindowActivation::default();
        assert!(!event_before_setup.request());
        assert!(
            event_before_setup.install_readiness(),
            "an event arriving before setup must be replayed by setup"
        );

        let concurrent = Arc::new(PendingMainWindowActivation::default());
        let barrier = Arc::new(Barrier::new(3));
        let event_handoff = Arc::clone(&concurrent);
        let event_barrier = Arc::clone(&barrier);
        let event = thread::spawn(move || {
            event_barrier.wait();
            event_handoff.request()
        });
        let setup_handoff = Arc::clone(&concurrent);
        let setup_barrier = Arc::clone(&barrier);
        let setup = thread::spawn(move || {
            setup_barrier.wait();
            setup_handoff.install_readiness()
        });
        barrier.wait();
        assert_eq!(
            usize::from(event.join().unwrap()) + usize::from(setup.join().unwrap()),
            1,
            "exactly one side must own the cold activation under a simultaneous handoff"
        );

        let repeated = PendingMainWindowActivation::default();
        assert!(!repeated.request());
        assert!(!repeated.request());
        assert!(
            repeated.install_readiness(),
            "repeated pre-ready URLs coalesce to one window activation while their URL events remain distinct"
        );
        assert!(repeated.request());
        assert!(
            repeated.request(),
            "each repeated URL after setup activates through the managed authority"
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn native_cover_requests_are_bounded_and_latest_state_wins_before_dispatch() {
        let desired = Mutex::new(NativeCoverDesired {
            generation: 0,
            covered: false,
        });
        let (wake, receiver) = sync_channel(1);

        update_native_cover_desired(&desired, &wake, true);
        update_native_cover_desired(&desired, &wake, true);
        update_native_cover_desired(&desired, &wake, false);

        assert_eq!(receiver.try_iter().count(), 1, "repeated requests coalesce");
        let mut applied = Vec::new();
        assert!(apply_native_cover_until_current(&desired, |target| {
            applied.push(target);
            true
        }));
        assert_eq!(
            applied,
            vec![NativeCoverDesired {
                generation: 3,
                covered: false,
            }],
            "an unread cover must be superseded by the newer exact reveal"
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn native_cover_labels_and_isolates_ax_without_pausing_webkit() {
        let source = include_str!("lib.rs");
        let start = source
            .find("fn with_native_startup_cover")
            .expect("native startup cover exists");
        let end = source[start..]
            .find("fn present_startup_recovery_surface")
            .map(|offset| start + offset)
            .expect("native startup cover ends before recovery composition");
        let cover = &source[start..end];

        assert!(cover.contains("NSTextField::labelWithString(label_text, marker)"));
        assert!(cover.contains("setAccessibilityLabel: label_text"));
        assert!(cover.contains("NSArray::arrayWithObject(&*protected_cover)"));
        assert!(cover.contains("setAccessibilityChildren: &*protected_children"));
        assert!(cover.contains("setAccessibilityChildren: None::<&NSArray<NSView>>"));
        assert!(!cover.contains("let revealed_children = content.subviews()"));
        assert!(cover.contains("setAlphaValue: 0.0f64"));
        assert!(cover.contains("setAlphaValue: 1.0f64"));
        assert!(!cover.contains("webview_view.setHidden("));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn native_cover_dispatch_serializes_cover_before_a_fast_reveal() {
        let desired = Mutex::new(NativeCoverDesired {
            generation: 1,
            covered: true,
        });
        let (wake, _receiver) = sync_channel(1);
        let mut applied = Vec::new();

        assert!(apply_native_cover_until_current(&desired, |target| {
            applied.push(target.covered);
            if target.covered {
                update_native_cover_desired(&desired, &wake, false);
            }
            true
        }));
        assert_eq!(
            applied,
            vec![true, false],
            "the dispatcher must acknowledge the cover before applying reveal"
        );
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn native_cover_dispatch_stops_on_a_failed_main_thread_task() {
        let desired = Mutex::new(NativeCoverDesired {
            generation: 1,
            covered: true,
        });
        let mut attempts = 0;
        assert!(!apply_native_cover_until_current(&desired, |_| {
            attempts += 1;
            false
        }));
        assert_eq!(attempts, 1, "a failed task must not spin or reveal content");
    }

    #[test]
    #[cfg(not(mobile))]
    fn listening_transition_kicks_the_managed_tray_after_publishing_running_state() {
        let source = include_str!("lib.rs");
        let listening = source
            .find("Ok(SupervisorMessage::Listening {")
            .expect("supervisor receives a listening transition");
        let published = source[listening..]
            .find("apply_supervisor_input(&supervisor, SupervisorInput::Listening { port });")
            .map(|offset| listening + offset)
            .expect("listening state is published before tray convergence");
        let kick = source[published..]
            .find("crate::tray::kick(&app);")
            .map(|offset| published + offset)
            .expect("listening state wakes the managed tray poll");
        assert!(published < kick);
    }

    #[test]
    #[cfg(not(mobile))]
    fn native_teardown_stops_the_managed_tray_before_sidecar_teardown() {
        let source = include_str!("lib.rs");
        let teardown = source
            .find("pub(crate) fn teardown_sidecar(app: &AppHandle) {")
            .expect("desktop teardown exists");
        let tray_shutdown = source[teardown..]
            .find("crate::tray::shutdown(app);")
            .map(|offset| teardown + offset)
            .expect("desktop teardown stops the app-owned tray poll");
        let server_state = source[teardown..]
            .find("app.try_state::<DesktopServerState>()")
            .map(|offset| teardown + offset)
            .expect("sidecar teardown remains guarded by managed desktop state");
        assert!(tray_shutdown < server_state);
    }

    #[test]
    #[cfg(not(mobile))]
    fn runtime_preparation_refusal_exits_before_ownership_claim_supervisor_or_tray_start() {
        let source = include_str!("lib.rs");
        let preparation = source
            .find("let preparation_kind = match prepare_runtime_registry_bridge(")
            .expect("setup invokes runtime preparation through the typed bridge");
        let recovery = source[preparation..]
            .find("exit_desktop_home_preparation_failure(")
            .map(|offset| preparation + offset)
            .expect("setup routes bridge refusal to native recovery");
        let recovery_return = source[recovery..]
            .find("return Ok(());")
            .map(|offset| recovery + offset)
            .expect("recovery exits setup successfully instead of returning a Tauri setup error");
        let ownership = source[preparation..]
            .find("let ownership = decide_home_ownership_from_runtime")
            .map(|offset| preparation + offset)
            .expect("setup selects ownership only on the prepared path");
        let claim = source[preparation..]
            .find("let claimed = claim_sidecar_registry_bridge")
            .map(|offset| preparation + offset)
            .expect("setup claims a sidecar only after ownership selection");
        let supervisor = source[preparation..]
            .find("let supervisor = Arc::new(ServerSupervisor")
            .map(|offset| preparation + offset)
            .expect("setup creates the supervisor on its normal path");
        let tray = source[preparation..]
            .find("tray::init(app.handle())?;")
            .map(|offset| preparation + offset)
            .expect("setup initializes the tray on its normal path");

        assert!(
            preparation < recovery
                && recovery < recovery_return
                && recovery_return < supervisor
                && supervisor < ownership
                && ownership < claim
                && supervisor < tray,
            "a runtime refusal must exit through native recovery before ownership, claim, supervisor, or tray start"
        );
    }

    #[test]
    #[cfg(not(mobile))]
    fn runtime_preparation_protocol_accepts_only_the_bounded_success_vocabulary() {
        for kind in ["absent", "new", "already", "recovered"] {
            let output = format!(r#"{{"ok":true,"kind":"{kind}"}}"#);
            assert_eq!(
                parse_prepare_runtime_bridge_output(output.as_bytes()),
                Ok(match kind {
                    "absent" => PrepareRuntimeKind::Absent,
                    "new" => PrepareRuntimeKind::New,
                    "already" => PrepareRuntimeKind::Already,
                    "recovered" => PrepareRuntimeKind::Recovered,
                    _ => unreachable!(),
                })
            );
        }
    }

    #[test]
    #[cfg(not(mobile))]
    fn runtime_preparation_protocol_refuses_non_success_malformed_unknown_and_oversized_output() {
        for output in [
            br#"{"ok":false,"kind":"new"}"#.as_slice(),
            br#"{"ok":true,"kind":"refused"}"#.as_slice(),
            br#"{"ok":true,"kind":"new","path":"/private/station"}"#.as_slice(),
            br#"not-json"#.as_slice(),
        ] {
            assert_eq!(
                parse_prepare_runtime_bridge_output(output),
                Err(RegistryBridgeFailure::Protocol)
            );
        }
        let oversized = vec![b'x'; MAX_REGISTRY_BRIDGE_OUTPUT_BYTES + 1];
        assert_eq!(
            parse_prepare_runtime_bridge_output(&oversized),
            Err(RegistryBridgeFailure::Protocol)
        );
    }

    #[cfg(all(not(mobile), unix))]
    #[test]
    fn prepare_runtime_and_other_bridge_operations_are_killed_at_the_watchdog_bound() {
        let mut preparation = Command::new("/bin/sh")
            .args(["-c", "sleep 1; exit 0"])
            .spawn()
            .expect("preparation child starts");
        assert!(matches!(
            wait_for_registry_bridge_child(
                &mut preparation,
                "prepareRuntime",
                Duration::from_millis(1),
            ),
            Err(RegistryBridgeFailure::Invocation)
        ));

        let mut ordinary = Command::new("/bin/sh")
            .args(["-c", "sleep 1; exit 0"])
            .spawn()
            .expect("ordinary bridge child starts");
        assert!(
            matches!(
                wait_for_registry_bridge_child(&mut ordinary, "read", Duration::from_millis(1)),
                Err(RegistryBridgeFailure::Invocation)
            ),
            "ordinary bridge operations retain their bounded kill watchdog"
        );
    }

    #[cfg(not(mobile))]
    #[test]
    fn preparation_watchdog_is_unconditional_and_output_stays_bounded() {
        let source = include_str!("lib.rs");
        let waiter_start = source
            .find("fn wait_for_registry_bridge_child(")
            .expect("operation-aware bridge waiter exists");
        let waiter_end = source[waiter_start..]
            .find("#[cfg(not(mobile))]\nfn invoke_registry_bridge")
            .map(|offset| waiter_start + offset)
            .expect("waiter ends before bridge invocation");
        let waiter = &source[waiter_start..waiter_end];
        assert!(!waiter.contains("operation == \"prepareRuntime\""));
        assert!(waiter.contains("terminate_registry_bridge_child(child)"));
        let termination = &source[source
            .find("fn terminate_registry_bridge_child(")
            .expect("bridge termination helper exists")
            ..waiter_start];
        assert!(termination.contains("child.kill()"));
        assert!(termination.contains("child.wait()"));
        assert!(source.contains("MAX_REGISTRY_BRIDGE_OUTPUT_BYTES + 1"));
    }

    #[test]
    fn windows_profile_lock_probe_accepts_only_exact_success_sentinels() {
        assert_eq!(
            windows_process_liveness_from_output(true, b" \r\n1\t"),
            ProfileLockOwnerLiveness::Alive
        );
        assert_eq!(
            windows_process_liveness_from_output(true, b"\n0\r\n"),
            ProfileLockOwnerLiveness::Dead
        );
        for (success, stdout) in [
            (false, b"0".as_slice()),
            (false, b"1".as_slice()),
            (true, b"".as_slice()),
            (true, b"2".as_slice()),
            (true, b"true".as_slice()),
            (true, b"1 0".as_slice()),
        ] {
            assert_eq!(
                windows_process_liveness_from_output(success, stdout),
                ProfileLockOwnerLiveness::Ambiguous,
                "success={success}, stdout={stdout:?} must remain a reclamation fence"
            );
        }
    }

    #[cfg(all(not(mobile), unix))]
    #[test]
    fn bridge_stdin_write_failure_reaps_the_child_before_its_reader_is_joined() {
        use std::io::{Error as IoError, ErrorKind};

        struct FailingWriter;
        impl Write for FailingWriter {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(IoError::new(
                    ErrorKind::BrokenPipe,
                    "injected stdin failure",
                ))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let mut child = Command::new("/bin/sh")
            .args(["-c", "printf reader-started; sleep 30"])
            .stdout(Stdio::piped())
            .spawn()
            .expect("bridge fixture starts");
        let stdout = child.stdout.take().expect("fixture stdout is piped");
        let reader = thread::spawn(move || capture_bounded_registry_bridge_stdout(stdout));
        assert!(matches!(
            write_registry_bridge_input(&mut FailingWriter, b"{}"),
            Err(RegistryBridgeFailure::Invocation)
        ));
        // This is the identical cleanup branch used after a native stdin
        // write failure: kill/wait happens before joining the pipe reader.
        terminate_registry_bridge_child(&mut child);
        assert!(reader.join().expect("reader joins").is_ok());
        assert!(child.try_wait().expect("child is reapable").is_some());

        let source = include_str!("lib.rs");
        let write_failure = source
            .find("if let Err(error) = write_result {")
            .expect("bridge handles stdin write failure");
        let failure_branch = &source[write_failure
            ..source[write_failure..]
                .find("    // All bridge operations")
                .map(|offset| write_failure + offset)
                .expect("stdin failure branch ends before watchdog")];
        assert!(failure_branch.contains("terminate_registry_bridge_child(&mut child)"));
        assert!(failure_branch.contains("stdout_reader.join()"));
    }

    #[cfg(all(not(mobile), unix))]
    #[test]
    fn bridge_try_wait_failure_reaps_the_child_before_its_reader_returns() {
        use std::io::{Error as IoError, ErrorKind};

        let mut child = Command::new("/bin/sh")
            .args(["-c", "printf reader-started; sleep 30"])
            .stdout(Stdio::piped())
            .spawn()
            .expect("bridge fixture starts");
        let stdout = child.stdout.take().expect("fixture stdout is piped");
        let reader = thread::spawn(move || capture_bounded_registry_bridge_stdout(stdout));
        assert!(matches!(
            registry_bridge_poll_result(
                &mut child,
                Err(IoError::new(ErrorKind::Other, "injected try_wait failure")),
            ),
            Err(RegistryBridgeFailure::Invocation)
        ));
        assert!(reader.join().expect("reader joins").is_ok());
        assert!(child.try_wait().expect("child is reapable").is_some());
    }

    #[test]
    #[cfg(not(mobile))]
    fn runtime_preparation_receives_the_native_derived_root_and_admitted_home() {
        let source = include_str!("lib.rs");
        let root = source
            .find("let station_root = service_state::resolve_station_root();")
            .expect("setup derives the shared root natively");
        let preparation = source
            .find("let preparation_kind = match prepare_runtime_registry_bridge(")
            .expect("setup prepares the admitted runtime home");
        let call = &source[preparation
            ..source[preparation..]
                .find("};\n                log::info!(")
                .map(|offset| preparation + offset)
                .expect("runtime preparation match ends before setup continues")];
        assert!(root < preparation);
        assert!(call.contains("&station_root,"));
        assert!(call.contains("&station_home,"));
    }

    #[test]
    #[cfg(not(mobile))]
    fn home_preparation_exit_waits_for_the_async_dialog_dismissal() {
        let exited = std::cell::Cell::new(false);
        let dismissed = exit_after_dialog_dismissal(|| exited.set(true));

        assert!(
            !exited.get(),
            "scheduling the native dialog must not exit before it is visible"
        );
        dismissed(true);
        assert!(
            exited.get(),
            "the native dialog callback exits only after dismissal"
        );

        let source = include_str!("lib.rs");
        let recovery = &source[source
            .find("fn exit_desktop_home_preparation_failure")
            .expect("home-preparation recovery exists")
            ..source
                .find("fn commit_startup_readiness_blocking")
                .expect("next desktop lifecycle boundary exists")];
        assert!(recovery.contains(".show(exit_after_dialog_dismissal"));
        assert!(
            !recovery.contains(".blocking_show()"),
            "setup recovery must not block Tauri's main thread; worker readiness diagnostics may"
        );
    }

    #[test]
    fn atomic_ticket_commit_refuses_rotated_supervisor_and_waits_for_renderer_mount() {
        let mut status = BundledServerStatus::initial("out".into(), "err".into());
        status.phase = bundled_server_state::ServerPhase::Running;
        status.generation = Some(2);
        status.instance_id = Some("desktop-sidecar-stable".into());
        status.boot_id = Some("boot-2".into());
        status.api_base = Some("http://127.0.0.1:4123".into());
        let mut readiness = startup_readiness::transition(
            &startup_readiness::StartupReadiness::default(),
            startup_readiness::ReadinessInput::Begin {
                now_ms: 0,
                timeout_ms: 10,
                dev_bypass: false,
                owned_sidecar: true,
            },
        )
        .0;
        let stale = startup_readiness::StartupTicket {
            generation: 1,
            instance_id: "desktop-sidecar-stable".into(),
            boot_id: "boot-1".into(),
            api_base: "http://127.0.0.1:4123".into(),
        };
        let current = startup_readiness::StartupTicket {
            generation: 2,
            instance_id: "desktop-sidecar-stable".into(),
            boot_id: "boot-2".into(),
            api_base: "http://127.0.0.1:4123".into(),
        };
        let (next, _) = startup_readiness::transition(
            &readiness,
            startup_readiness::ReadinessInput::ServerTicket(current.clone()),
        );
        readiness = next;
        assert_eq!(
            commit_current_startup_ticket(&status, &mut readiness, stale),
            Err("Desktop startup readiness ticket is stale.")
        );
        assert_eq!(readiness.phase, startup_readiness::ReadinessPhase::Waiting);
        let effects = commit_current_startup_ticket(&status, &mut readiness, current).unwrap();
        assert!(effects.is_empty());
        assert!(readiness.identity_committed);
        assert_eq!(readiness.phase, startup_readiness::ReadinessPhase::Waiting);
        let (readiness, effects) = startup_readiness::transition(
            &readiness,
            startup_readiness::ReadinessInput::RendererMounted,
        );
        assert_eq!(
            effects,
            vec![startup_readiness::ReadinessEffect::RevealMainWindow]
        );
        assert_eq!(readiness.phase, startup_readiness::ReadinessPhase::Ready);
    }

    #[test]
    #[cfg(not(mobile))]
    fn profile_changes_wake_only_a_waiting_startup_proof() {
        assert!(startup_readiness_accepts_retry(
            startup_readiness::ReadinessPhase::Waiting
        ));
        for terminal in [
            startup_readiness::ReadinessPhase::Ready,
            startup_readiness::ReadinessPhase::Failed,
            startup_readiness::ReadinessPhase::Bypassed,
        ] {
            assert!(!startup_readiness_accepts_retry(terminal));
        }
    }

    #[test]
    #[cfg(not(mobile))]
    fn native_bootstrap_claim_requires_renderer_waiting_and_single_flight() {
        let in_flight = AtomicBool::new(false);
        let pending = AtomicBool::new(false);
        assert!(!claim_startup_commit(
            false,
            startup_readiness::ReadinessPhase::Waiting,
            &in_flight,
            &pending,
        ));
        assert!(!claim_startup_commit(
            true,
            startup_readiness::ReadinessPhase::Ready,
            &in_flight,
            &pending,
        ));
        assert!(claim_startup_commit(
            true,
            startup_readiness::ReadinessPhase::Waiting,
            &in_flight,
            &pending,
        ));
        assert!(!claim_startup_commit(
            true,
            startup_readiness::ReadinessPhase::Waiting,
            &in_flight,
            &pending,
        ));
        assert!(pending.load(Ordering::Acquire));
        assert!(release_failed_startup_commit_claim(
            &in_flight,
            &pending,
        ));
        assert!(!pending.load(Ordering::Acquire));
        assert!(claim_startup_commit(
            true,
            startup_readiness::ReadinessPhase::Waiting,
            &in_flight,
            &pending,
        ));
        assert!(!release_failed_startup_commit_claim(
            &in_flight,
            &pending,
        ));
        assert!(native_startup_page_admitted(
            "main",
            PageLoadEvent::Started,
        ));
        assert!(renderer_mount_label_admitted("main"));
        assert!(!renderer_mount_label_admitted("browser-preview-proof"));
        assert!(!native_startup_page_admitted(
            "main",
            PageLoadEvent::Finished,
        ));
        for foreign in ["preview", "workspace-popout", "main-copy", ""] {
            assert!(!native_startup_page_admitted(
                foreign,
                PageLoadEvent::Started,
            ));
        }
        assert!(native_startup_uses_sidecar_proof(&DesktopOwner::Sidecar));
        for owner in [
            DesktopOwner::Service {
                id: "service".into(),
                port: 18141,
            },
            DesktopOwner::Unowned,
            DesktopOwner::None,
        ] {
            assert!(!native_startup_uses_sidecar_proof(&owner));
        }
    }

    #[test]
    #[cfg(not(mobile))]
    fn startup_credential_admits_a_migrated_paired_owner_by_exact_channel_home() {
        let temp = tempfile::tempdir().unwrap();
        let station_root = temp.path().join(".station");
        let beta_home = station_root.join("instances").join("beta");
        let stable_home = station_root.join("instances").join("stable");
        std::fs::create_dir_all(&beta_home).unwrap();
        std::fs::create_dir_all(&stable_home).unwrap();
        let store = parse_station_profile_store(
            &serde_json::json!({
                "schemaVersion": 1,
                "revision": 2,
                "defaultProfile": "stable-local",
                "projectProfiles": {},
                "profiles": [
                    {
                        "schemaVersion": 1,
                        "name": "stable-local",
                        "endpoint": "http://127.0.0.1:18141",
                        "credentialRef": { "kind": "station-bearer", "id": "stable-token" },
                        "environmentId": "stable-environment",
                        "localService": {
                            "instanceId": "desktop-sidecar-stable",
                            "baseDir": stable_home,
                            "serverPort": 18141,
                            "uiPort": 18000
                        },
                        "setupSource": "local",
                        "configurationState": "configured",
                        "createdAt": 1,
                        "updatedAt": 1
                    },
                    {
                        "schemaVersion": 1,
                        "name": "beta-local",
                        "endpoint": "http://127.0.0.1:28141",
                        "credentialRef": { "kind": "station-bearer", "id": "beta-token" },
                        "environmentId": "beta-environment",
                        "localService": {
                            "instanceId": "desktop-sidecar-beta",
                            "baseDir": beta_home,
                            "serverPort": 28141,
                            "uiPort": 28000
                        },
                        "setupSource": "paired",
                        "configurationState": "configured",
                        "createdAt": 2,
                        "updatedAt": 2
                    },
                    {
                        "schemaVersion": 1,
                        "name": "beta-placeholder",
                        "endpoint": "http://127.0.0.1:28141",
                        "environmentId": null,
                        "localService": {
                            "instanceId": "desktop-sidecar-beta",
                            "baseDir": beta_home,
                            "serverPort": 28141,
                            "uiPort": 28000
                        },
                        "setupSource": "local",
                        "configurationState": "configured",
                        "createdAt": 3,
                        "updatedAt": 3
                    }
                ]
            })
            .to_string(),
        )
        .unwrap();
        let launch = SidecarLaunchContext {
            resource_dir: temp.path().join("resources"),
            station_root: station_root.clone(),
            station_home: beta_home.clone(),
            home: temp.path().to_string_lossy().into_owned(),
            shell_path: "/usr/bin:/bin".into(),
            channel: Some("beta".into()),
            pinned_port: Some(28141),
            supervisor_birth: "birth".into(),
            instance_id: "desktop-sidecar-beta".into(),
        };
        let ticket = startup_readiness::StartupTicket {
            generation: 3,
            instance_id: "desktop-sidecar-beta".into(),
            boot_id: "boot-beta".into(),
            api_base: "http://127.0.0.1:28141".into(),
        };

        let receipt = bundled_startup_credential_receipt(&store, &launch, &ticket).unwrap();
        assert_eq!(receipt.profile_name, "beta-local");
        assert_eq!(receipt.reference.id, "beta-token");
        assert_eq!(receipt.station_home, beta_home);
        assert_eq!(receipt.exact_origin, "http://127.0.0.1:28141");
    }

    #[test]
    #[cfg(not(mobile))]
    fn startup_credential_refuses_foreign_home_and_non_origin_ticket() {
        let temp = tempfile::tempdir().unwrap();
        let station_root = temp.path().join(".station");
        let beta_home = station_root.join("instances").join("beta");
        let foreign_home = station_root.join("instances").join("stable");
        std::fs::create_dir_all(&beta_home).unwrap();
        std::fs::create_dir_all(&foreign_home).unwrap();
        let store = parse_station_profile_store(
            &serde_json::json!({
                "schemaVersion": 1,
                "revision": 1,
                "defaultProfile": "foreign",
                "projectProfiles": {},
                "profiles": [{
                    "schemaVersion": 1,
                    "name": "foreign",
                    "endpoint": "http://127.0.0.1:28141",
                    "credentialRef": { "kind": "station-bearer", "id": "foreign-token" },
                    "environmentId": "foreign-environment",
                    "localService": {
                        "instanceId": "desktop-sidecar-beta",
                        "baseDir": foreign_home,
                        "serverPort": 28141,
                        "uiPort": 28000
                    },
                    "setupSource": "local",
                    "configurationState": "configured",
                    "createdAt": 1,
                    "updatedAt": 1
                }]
            })
            .to_string(),
        )
        .unwrap();
        let launch = SidecarLaunchContext {
            resource_dir: temp.path().join("resources"),
            station_root,
            station_home: beta_home,
            home: temp.path().to_string_lossy().into_owned(),
            shell_path: "/usr/bin:/bin".into(),
            channel: Some("beta".into()),
            pinned_port: Some(28141),
            supervisor_birth: "birth".into(),
            instance_id: "desktop-sidecar-beta".into(),
        };
        let mut ticket = startup_readiness::StartupTicket {
            generation: 1,
            instance_id: "desktop-sidecar-beta".into(),
            boot_id: "boot-beta".into(),
            api_base: "http://127.0.0.1:28141".into(),
        };
        assert!(bundled_startup_credential_receipt(&store, &launch, &ticket).is_err());
        ticket.api_base = "http://127.0.0.1:28141/foreign".into();
        assert!(bundled_startup_credential_receipt(&store, &launch, &ticket).is_err());
    }

    #[test]
    #[cfg(not(mobile))]
    fn startup_identity_requires_exact_instance_and_boot_ticket() {
        let ticket = startup_readiness::StartupTicket {
            generation: 7,
            instance_id: "desktop-sidecar-beta".into(),
            boot_id: "boot-beta".into(),
            api_base: "http://127.0.0.1:28141".into(),
        };
        assert!(startup_identity_matches_ticket(
            r#"{"instanceId":"desktop-sidecar-beta","bootId":"boot-beta","sha":"abc"}"#,
            &ticket,
        ));
        assert!(!startup_identity_matches_ticket(
            r#"{"instanceId":"desktop-sidecar-beta","bootId":"old"}"#,
            &ticket,
        ));
        assert!(!startup_identity_matches_ticket("not-json", &ticket));
    }

    #[test]
    fn webview_relay_refuses_the_consent_broker_family() {
        let forbidden = [
            "http://127.0.0.1:3141/api/consent",
            "http://127.0.0.1:3141/api/consent/",
            "http://127.0.0.1:3141/api/consent/requests/abc/native-review",
            "http://127.0.0.1:3141/api/consent/requests/abc/native-decide",
            // Query strings and fragments do not change the path refusal.
            "http://127.0.0.1:3141/api/consent/requests/abc/native-decide?x=1",
            // Percent-encoded segments: the server's router decodes before it
            // matches, so these REACH the consent routes and must be refused
            // here too (review round 1 BLOCKING — the raw-only comparison let
            // webview JS approve silently with the app's own bearer).
            "http://127.0.0.1:3141/api/%63onsent/requests/abc/native-review",
            "http://127.0.0.1:3141/api/con%73ent/requests/abc/native-decide",
            "http://127.0.0.1:3141/api/%63%6Fnsent/requests/abc/native-decide",
            // Dot segments are normalized by URL parsing on both sides —
            // including an attempt to walk out of the allowed read.
            "http://127.0.0.1:3141/api/x/../consent/requests/abc/native-decide",
            "http://127.0.0.1:3141/api/consent/native-eligibility/../requests/a/native-decide",
            // Deny-by-default: a leaf nobody allowed stays refused.
            "http://127.0.0.1:3141/api/consent/some-future-leaf",
        ];
        for url in forbidden {
            assert!(
                is_webview_forbidden_native_path(&url::Url::parse(url).unwrap()),
                "must refuse {url}"
            );
        }
        let allowed = [
            // The one deliberate allowance: the app's own UI reads its
            // eligibility through this relay, and a refusal here made the
            // whole broker unreachable (review round 2). Encoded spellings
            // of it are allowed too — they decode to the same read.
            "http://127.0.0.1:3141/api/consent/native-eligibility",
            "http://127.0.0.1:3141/api/%63onsent/native-eligibility",
            "http://127.0.0.1:3141/api/consent/native-eligibility?x=1",
            "http://127.0.0.1:3141/api/agents",
            "http://127.0.0.1:3141/api/consenting", // prefix must not over-match
            "http://127.0.0.1:3141/api/plugins/home-role/requests",
            // A malformed escape must not decode into a false positive, and
            // must not panic the decoder.
            "http://127.0.0.1:3141/api/%zzonsent",
            "http://127.0.0.1:3141/api/%6",
        ];
        for url in allowed {
            assert!(
                !is_webview_forbidden_native_path(&url::Url::parse(url).unwrap()),
                "must allow {url}"
            );
        }
    }

    /// The lease is process-global by design, so these two tests cannot run
    /// concurrently against it — the harness runs tests on threads, and the
    /// first version of this pair raced itself into a false red.
    static CONSENT_LEASE_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn one_native_consent_dialog_at_a_time() {
        let _serialized = CONSENT_LEASE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let first = NativeConsentDialogLease::acquire(NATIVE_CONSENT_DIALOG_MAX_AGE);
        assert!(first.is_some(), "the first review takes the lease");
        assert!(
            NativeConsentDialogLease::acquire(NATIVE_CONSENT_DIALOG_MAX_AGE).is_none(),
            "a concurrent review must be refused before it reaches the server"
        );
        drop(first);
        let after = NativeConsentDialogLease::acquire(NATIVE_CONSENT_DIALOG_MAX_AGE);
        assert!(
            after.is_some(),
            "the lease is released on every exit path, so one review cannot wedge the broker"
        );
    }

    #[test]
    fn an_abandoned_consent_dialog_lease_is_taken_over_not_held_forever() {
        let _serialized = CONSENT_LEASE_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // A dialog backend that never returns and never unwinds holds the
        // lease across its blocking show, where RAII cannot help (review
        // round 2). Age zero stands in for "older than the limit".
        let wedged = NativeConsentDialogLease::acquire(NATIVE_CONSENT_DIALOG_MAX_AGE)
            .expect("first review takes the lease");
        let successor = NativeConsentDialogLease::acquire(Duration::ZERO)
            .expect("an expired lease is taken over rather than denying consent forever");

        // The abandoned review returning late must not clear its
        // successor's lease.
        drop(wedged);
        assert!(
            NativeConsentDialogLease::acquire(NATIVE_CONSENT_DIALOG_MAX_AGE).is_none(),
            "the successor still holds the lease after the abandoned review drops"
        );
        drop(successor);
        assert!(
            NativeConsentDialogLease::acquire(NATIVE_CONSENT_DIALOG_MAX_AGE).is_some(),
            "the successor's own release frees the broker"
        );
    }

    #[cfg(not(mobile))]
    fn registry_entry(
        id: &str,
        instance_type: &str,
        port: Option<u16>,
        pid: Option<u32>,
        pid_alive: Option<bool>,
    ) -> RegistryInstanceEntry {
        RegistryInstanceEntry {
            id: id.into(),
            instance_type: instance_type.into(),
            port,
            pid,
            pid_alive,
        }
    }

    #[cfg(not(mobile))]
    #[test]
    fn sidecar_claim_admits_only_one_launcher() {
        assert!(
            registry_claim_allows_running(Ok(())),
            "first launcher owns the sidecar slot"
        );
        assert!(
            !registry_claim_allows_running(Err(RegistryBridgeFailure::Invocation)),
            "second launcher must not launch after a rejected atomic claim"
        );
    }

    #[cfg(not(mobile))]
    #[test]
    fn live_service_owns_home_without_spawning_or_setting_an_api_base() {
        let owner = owner_for_decision(HomeOwnershipDecision::ServiceOwnsHome {
            id: "service-a".into(),
            port: 38141,
        });
        assert_eq!(
            owner,
            DesktopOwner::Service {
                id: "service-a".into(),
                port: 38141
            }
        );
        assert_ne!(
            owner,
            DesktopOwner::Sidecar,
            "a durable service owner must not spawn a desktop child"
        );
    }

    #[cfg(not(mobile))]
    #[test]
    fn non_primary_window_destruction_never_tears_down_the_sidecar() {
        assert!(
            !window_destruction_requests_sidecar_teardown(),
            "destroying a Browser Preview or workspace pop-out must not tear down the sidecar"
        );
    }

    #[cfg(not(mobile))]
    #[test]
    fn registry_publication_failure_prevents_running_sidecar_status() {
        assert!(registry_claim_allows_running(Ok(())));
        assert!(
            !registry_claim_allows_running(Err(RegistryBridgeFailure::Invocation)),
            "a rejected registry claim must prevent the sidecar from becoming Running"
        );
    }

    #[cfg(all(not(mobile), unix))]
    #[test]
    fn immediate_home_reset_stderr_is_drained_before_exit_is_classified() {
        let mut child = Command::new("/bin/sh")
            .args([
                "-c",
                "printf 'STATION_HOME_RESET_REQUIRED: incompatible schema\\n' >&2; exit 1",
            ])
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let status = BundledServerStatus::initial("/tmp/out.log".into(), "/tmp/err.log".into());
        let stderr = child.stderr.take().unwrap();
        let code = child.wait().unwrap().code();
        let detail = capture_sidecar_stderr(stderr);
        let (next, effects) = transition(&status, &SupervisorInput::Exited { code, detail });
        assert_eq!(
            next.phase,
            bundled_server_state::ServerPhase::Failed,
            "the immediately-written fail-closed marker must not be misclassified as retryable"
        );
        assert!(next.fail_closed);
        assert_eq!(effects, vec![SupervisorEffect::None]);
    }

    #[cfg(all(not(mobile), unix))]
    #[test]
    fn inherited_stderr_descendant_cannot_block_claim_cleanup() {
        let mut child = Command::new("/bin/sh")
            .args([
                "-c",
                "printf 'sidecar exited\\n' >&2; (sleep 1) >&2 & exit 1",
            ])
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let status = Arc::new(Mutex::new(BundledServerStatus::initial(
            "/tmp/out.log".into(),
            "/tmp/err.log".into(),
        )));
        let reader = spawn_sidecar_stderr_reader(child.stderr.take().unwrap(), status)
            .expect("stderr reader starts");
        let _ = child.wait().unwrap();
        let started = std::time::Instant::now();
        assert!(
            !drain_sidecar_stderr_reader(reader.0, reader.1),
            "an inherited stderr descendant must outlive the direct child"
        );
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "bounded stderr drain must release claim cleanup before descendant stderr closes"
        );
    }

    #[cfg(all(not(mobile), unix))]
    #[test]
    fn teardown_reaps_the_owned_sidecar_without_signalling_an_attached_service() {
        let mut sidecar = Command::new("/bin/sh")
            .args(["-c", "sleep 30"])
            .spawn()
            .unwrap();
        let mut attached_service = Command::new("/bin/sh")
            .args(["-c", "sleep 30"])
            .spawn()
            .unwrap();
        assert!(owner_owns_reapable_child(DesktopOwner::Sidecar));
        terminate_desktop_child(&mut sidecar);
        assert!(
            sidecar.try_wait().unwrap().is_some(),
            "desktop-owned sidecar must be reaped"
        );
        assert!(!owner_owns_reapable_child(DesktopOwner::Service {
            id: "service-a".into(),
            port: 38141
        }));
        assert!(
            attached_service.try_wait().unwrap().is_none(),
            "attached service must not be signalled"
        );
        let _ = attached_service.kill();
        let _ = attached_service.wait();
    }

    #[cfg(not(mobile))]
    #[test]
    fn ownership_decision_fails_closed_for_untrusted_registry() {
        assert_eq!(
            decide_home_ownership(Err(RegistryBridgeFailure::Untrusted)),
            HomeOwnershipDecision::FailClosedRegistry
        );
    }

    #[cfg(not(mobile))]
    #[test]
    fn registry_bridge_untrusted_error_is_typed_and_cannot_select_spawn() {
        let response: RegistryBridgeReadResponse =
            serde_json::from_str(r#"{"ok":false,"error":{"code":"REGISTRY_UNTRUSTED"}}"#)
                .expect("redacted bridge failure must be parseable");
        let failure = registry_bridge_error(&response);
        assert_eq!(failure, RegistryBridgeFailure::Untrusted);
        assert_eq!(
            decide_home_ownership(Err(failure)),
            HomeOwnershipDecision::FailClosedRegistry
        );
    }

    #[cfg(not(mobile))]
    #[test]
    fn ownership_refresh_never_rederives_while_this_desktop_owns_the_sidecar() {
        // Holding the registry claim makes our ownership authoritative: nothing
        // can take the home from under us, and reporting Service while our own
        // supervisor is live would be incoherent. Elapsed time must not change
        // that, so this asserts with an interval far past the threshold.
        let now = Instant::now();
        let Some(long_ago) = now.checked_sub(OWNERSHIP_REFRESH_INTERVAL * 100) else {
            return; // Instant is boot-relative; skip on a just-booted machine.
        };
        assert!(!should_rederive_home_ownership(
            &DesktopOwner::Sidecar,
            Some(long_ago),
            now
        ));
    }

    #[test]
    #[cfg(not(mobile))]
    fn ownership_refresh_rederives_a_service_owner_once_the_interval_elapses() {
        // station#3116: the boot-time decision is a real observation taken at one
        // instant. A durable service can be stopped or replaced afterwards, so a
        // non-sidecar owner must be re-derived rather than asserted forever.
        let now = Instant::now();
        assert!(should_rederive_home_ownership(
            &DesktopOwner::Service {
                id: "service-a".into(),
                port: 38141,
            },
            now.checked_sub(OWNERSHIP_REFRESH_INTERVAL),
            now,
        ));
        assert!(!should_rederive_home_ownership(
            &DesktopOwner::Service {
                id: "service-a".into(),
                port: 38141,
            },
            now.checked_sub(OWNERSHIP_REFRESH_INTERVAL / 2),
            now,
        ));
        // Never re-derived before: the bridge spawns a Node child, so the very
        // first read is allowed to pay for it rather than reporting boot state.
        assert!(should_rederive_home_ownership(
            &DesktopOwner::None,
            None,
            now
        ));
    }

    #[test]
    #[cfg(not(mobile))]
    fn every_owner_routes_to_its_own_status_producer() {
        // station#3129: the arms had NO coverage — swapping the Unowned arm for
        // the registry-unavailable one passed all 134 tests, which is how a
        // "no Station is running" home could go back to claiming the registry
        // was broken.
        assert_eq!(
            home_status_route(DesktopOwner::Sidecar),
            HomeStatusRoute::SidecarSupervisor
        );
        assert_eq!(
            home_status_route(DesktopOwner::Service {
                id: "service-a".into(),
                port: 38141,
            }),
            HomeStatusRoute::AttachedService {
                id: "service-a".into(),
                port: 38141,
            }
        );
        // The two that must never collapse into each other: a free home is not
        // an unreadable registry.
        assert_eq!(
            home_status_route(DesktopOwner::Unowned),
            HomeStatusRoute::UnownedHome
        );
        assert_eq!(
            home_status_route(DesktopOwner::None),
            HomeStatusRoute::RegistryUnavailable
        );
        assert_ne!(
            home_status_route(DesktopOwner::Unowned),
            home_status_route(DesktopOwner::None)
        );
    }

    #[test]
    #[cfg(not(mobile))]
    fn a_free_home_reports_stopped_not_failed() {
        // station#3118: routing a free home through the fail-closed shape made
        // the connection row read "Failed to start" with a red error dot
        // (`connection-manager-modal-utils.ts` maps failed -> error) when nothing
        // had failed. A home nobody owns is Stopped -> "Not running", idle.
        let status = unowned_home_status_fields(
            None,
            "No Station is running for this home.".into(),
            "No live service owns this home and this desktop holds no sidecar claim.".into(),
        );
        assert_eq!(status.phase, bundled_server_state::ServerPhase::Stopped);
        // Determinate, not fail-closed: the registry was read and it answered.
        assert!(!status.fail_closed);
        assert_eq!(status.api_base, None);
    }

    #[test]
    #[cfg(not(mobile))]
    fn ownership_refresh_keeps_rechecking_a_free_home_so_a_returning_service_is_noticed() {
        // `Unowned` must NOT join the sidecar early-return. Treating "the home is
        // free" as settled would freeze the banner for the process lifetime and
        // silently reintroduce station#3116 for the install-a-service case.
        let now = Instant::now();
        let Some(elapsed) = now.checked_sub(OWNERSHIP_REFRESH_INTERVAL) else {
            return; // Instant is boot-relative; skip on a just-booted machine.
        };
        assert!(should_rederive_home_ownership(
            &DesktopOwner::Unowned,
            Some(elapsed),
            now
        ));
    }

    #[test]
    #[cfg(not(mobile))]
    fn ownership_refresh_records_a_free_home_without_acquiring_sidecar_ownership() {
        // `SpawnSidecar` is the ONLY decision that maps to `DesktopOwner::Sidecar`,
        // and it means "the home is free", not "this desktop owns a sidecar".
        // A read path must record that fact without taking ownership: refusing it
        // outright left a stopped service's `Service { id, port }` cached, so the
        // banner kept naming a service and port that no longer exist.
        assert_eq!(
            adoptable_refreshed_owner(DesktopOwner::Sidecar),
            DesktopOwner::Unowned
        );
        assert_eq!(
            adoptable_refreshed_owner(DesktopOwner::Service {
                id: "service-a".into(),
                port: 38141,
            }),
            DesktopOwner::Service {
                id: "service-a".into(),
                port: 38141,
            }
        );
        // An unreadable registry stays distinct from a free home: one means
        // "we could not look", the other "we looked and nobody owns it".
        assert_eq!(
            adoptable_refreshed_owner(DesktopOwner::None),
            DesktopOwner::None
        );
    }

    #[test]
    #[cfg(not(mobile))]
    fn ownership_refresh_releases_a_service_owner_once_its_service_stops() {
        // The end-to-end shape of the blocker, through the real derivation: a
        // registry with no live service derives SpawnSidecar, and a status read
        // must translate that to Unowned rather than retaining the dead service.
        let stopped = [registry_entry(
            "service-a",
            "service",
            Some(38141),
            Some(7),
            Some(false),
        )];
        assert_eq!(
            decide_home_ownership(Ok(&stopped)),
            HomeOwnershipDecision::SpawnSidecar
        );
        assert_eq!(
            adoptable_refreshed_owner(owner_for_decision(decide_home_ownership(Ok(&stopped)))),
            DesktopOwner::Unowned
        );
    }

    #[test]
    #[cfg(not(mobile))]
    fn ownership_decision_reports_ambiguous_live_services() {
        let entries = [
            registry_entry("service-a", "service", Some(38141), Some(7), Some(true)),
            registry_entry("service-b", "service", Some(38142), Some(8), Some(true)),
        ];
        assert_eq!(
            decide_home_ownership(Ok(&entries)),
            HomeOwnershipDecision::AmbiguousOwnership
        );
    }

    #[cfg(not(mobile))]
    #[test]
    fn ownership_decision_spawns_when_no_live_service_exists() {
        assert_eq!(
            decide_home_ownership(Ok(&[registry_entry(
                "service-a",
                "service",
                Some(38141),
                None,
                None,
            )])),
            HomeOwnershipDecision::SpawnSidecar
        );
    }

    #[cfg(not(mobile))]
    #[test]
    fn ownership_decision_reports_the_one_live_service() {
        assert_eq!(
            decide_home_ownership(Ok(&[registry_entry(
                "service-a",
                "service",
                Some(38141),
                Some(7),
                Some(true),
            )])),
            HomeOwnershipDecision::ServiceOwnsHome {
                id: "service-a".into(),
                port: 38141
            }
        );
    }

    #[cfg(not(mobile))]
    fn sample_sidecar_context(pinned_port: Option<u16>) -> SidecarLaunchContext {
        SidecarLaunchContext {
            resource_dir: PathBuf::from("/bundle/resources"),
            station_root: PathBuf::from("/home/example/.station"),
            station_home: PathBuf::from("/home/example/.station-nightly"),
            home: "/home/example".to_string(),
            shell_path: "/usr/local/bin:/usr/bin".to_string(),
            channel: Some("nightly".to_string()),
            pinned_port,
            supervisor_birth: "birth-a".to_string(),
            instance_id: "desktop-sidecar-nightly".to_string(),
        }
    }

    #[cfg(not(mobile))]
    fn command_env(command: &Command) -> Vec<(String, Option<String>)> {
        command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().to_string(),
                    value.map(|value| value.to_string_lossy().to_string()),
                )
            })
            .collect()
    }

    #[cfg(not(mobile))]
    #[test]
    fn sidecar_launch_targets_command_station_with_loopback_handshake() {
        let context = sample_sidecar_context(None);
        let command = build_sidecar_command(&context, "018f8f10-1df4-7d5b-b1f1-3a5c5dc7a111");
        assert_eq!(command.get_program(), "node");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![command_station_script_path(&context.resource_dir).as_os_str()]
        );
        let env = command_env(&command);
        for (name, value) in [
            ("STATION_ROOT", "/home/example/.station"),
            ("STATION_HOME", "/home/example/.station-nightly"),
            ("STATION_HOST", "127.0.0.1"),
            ("STATION_STDOUT_HANDSHAKE", "1"),
            ("STATION_INSTANCE_ID", "desktop-sidecar-nightly"),
            ("STATION_BOOT_ID", "018f8f10-1df4-7d5b-b1f1-3a5c5dc7a111"),
            ("STATION_DESKTOP_CHANNEL", "nightly"),
            ("PORT", "0"),
            ("STATION_PORT_MODE", "auto"),
        ] {
            assert!(
                env.contains(&(name.to_string(), Some(value.to_string()))),
                "{name} must be passed to the sidecar"
            );
        }
        assert!(
            !env.iter()
                .any(|(name, value)| { name == "STATION_HOME_CAPABILITY" && value.is_some() }),
            "the sidecar spawn environment must never receive STATION_HOME_CAPABILITY"
        );
        assert!(command_station_script_path(&context.resource_dir)
            .ends_with("dist-server/command-station.js"));
    }

    #[cfg(not(mobile))]
    #[test]
    fn sidecar_boot_identity_is_a_fresh_uuid_for_every_spawn() {
        let first = fresh_sidecar_boot_id();
        let second = fresh_sidecar_boot_id();
        assert_ne!(first, second, "a supervised restart must rotate bootId");
        assert!(uuid::Uuid::parse_str(&first).is_ok());
        assert!(uuid::Uuid::parse_str(&second).is_ok());

        let context = sample_sidecar_context(None);
        let first_env = command_env(&build_sidecar_command(&context, &first));
        let second_env = command_env(&build_sidecar_command(&context, &second));
        assert!(first_env.contains(&(
            "STATION_INSTANCE_ID".to_string(),
            Some(context.instance_id.clone())
        )));
        assert!(second_env.contains(&(
            "STATION_INSTANCE_ID".to_string(),
            Some(context.instance_id.clone())
        )));
        assert!(first_env.contains(&("STATION_BOOT_ID".to_string(), Some(first))));
        assert!(second_env.contains(&("STATION_BOOT_ID".to_string(), Some(second))));
    }

    #[cfg(not(mobile))]
    #[test]
    fn sidecar_instance_identity_is_stable_and_channel_scoped() {
        assert_eq!(
            desktop_sidecar_instance_id(Some("stable"), "ignored"),
            "desktop-sidecar-stable"
        );
        assert_eq!(
            desktop_sidecar_instance_id(Some("beta"), "ignored"),
            "desktop-sidecar-beta"
        );
        assert_eq!(
            desktop_sidecar_instance_id(Some("nightly"), "ignored"),
            "desktop-sidecar-nightly"
        );
        let first = desktop_sidecar_instance_id(None, "io.kontourai.station.dev.abc123");
        let second = desktop_sidecar_instance_id(None, "io.kontourai.station.dev.def456");
        assert_ne!(
            first, second,
            "development worktrees need distinct identities"
        );
        assert_eq!(first.len(), "desktop-sidecar-dev-".len() + 16);

        let shared_prefix = "a".repeat(128);
        let long_first = desktop_sidecar_instance_id(None, &format!("{shared_prefix}-one"));
        let long_second = desktop_sidecar_instance_id(None, &format!("{shared_prefix}-two"));
        assert_ne!(
            long_first, long_second,
            "the full trusted identifier, not a truncated prefix, must scope Dev"
        );
    }

    #[cfg(not(mobile))]
    #[test]
    fn pinned_nightly_port_removes_auto_mode_from_child_environment() {
        let command = build_sidecar_command(
            &sample_sidecar_context(Some(38141)),
            "018f8f10-1df4-7d5b-b1f1-3a5c5dc7a222",
        );
        let env = command_env(&command);
        assert!(env.contains(&("PORT".to_string(), Some("38141".to_string()))));
        assert!(env.contains(&("STATION_PORT_MODE".to_string(), None)));
        assert!(!env.contains(&("STATION_PORT_MODE".to_string(), Some("auto".to_string()))));
    }

    #[cfg(not(mobile))]
    #[test]
    fn registry_bridge_uses_the_recovered_login_shell_path() {
        let command = build_registry_bridge_command(
            Path::new("/bundle/resources"),
            "read",
            "/custom/node/bin:/usr/bin",
        );
        assert_eq!(command.get_program(), "node");
        assert_eq!(
            command.get_args().collect::<Vec<_>>(),
            vec![
                registry_bridge_script_path(Path::new("/bundle/resources")).as_os_str(),
                std::ffi::OsStr::new("read"),
            ]
        );
        assert!(command_env(&command).contains(&(
            "PATH".to_string(),
            Some("/custom/node/bin:/usr/bin".to_string())
        )));
    }

    #[cfg(not(mobile))]
    #[test]
    fn desktop_port_precedence_is_explicit_then_channel_then_auto() {
        assert_eq!(
            resolve_pinned_desktop_port(Some("49141"), Some("nightly")),
            Ok(Some(49141))
        );
        assert_eq!(
            resolve_pinned_desktop_port(Some("39141"), None),
            Ok(Some(39141)),
            "dev-desktop's exported port must stay pinned in a debug build"
        );
        assert_eq!(
            resolve_pinned_desktop_port(None, Some("stable")),
            Ok(Some(18141))
        );
        assert_eq!(
            resolve_pinned_desktop_port(None, Some("beta")),
            Ok(Some(28141))
        );
        assert_eq!(resolve_pinned_desktop_port(None, None), Ok(None));
        assert!(resolve_pinned_desktop_port(Some("65534"), Some("stable")).is_err());
    }

    #[cfg(not(mobile))]
    #[test]
    fn packaged_channels_select_fixed_ports_and_homes_while_debug_stays_unpinned() {
        assert_eq!(
            channel_ports_generated::default_desktop_port(Some("stable")),
            Some(18141)
        );
        assert_eq!(
            channel_ports_generated::default_desktop_port(Some("beta")),
            Some(28141)
        );
        assert_eq!(
            channel_ports_generated::default_desktop_port(Some("nightly")),
            Some(38141)
        );
        assert_eq!(channel_ports_generated::default_desktop_port(None), None);
        assert_eq!(
            channel_ports_generated::station_instance_directory(Some("stable")),
            "stable"
        );
        assert_eq!(
            channel_ports_generated::station_instance_directory(Some("beta")),
            "beta"
        );
        assert_eq!(
            channel_ports_generated::station_instance_directory(Some("nightly")),
            "nightly"
        );
    }

    #[cfg(not(mobile))]
    #[test]
    fn pinned_port_parser_accepts_nightly_value_and_rejects_invalid_values() {
        assert_eq!(parse_pinned_desktop_port(Some("38141")), Ok(Some(38141)));
        assert_eq!(parse_pinned_desktop_port(None), Ok(None));
        assert!(parse_pinned_desktop_port(Some("65533")).is_err());
        assert!(parse_pinned_desktop_port(Some("65534")).is_err());
        assert_eq!(parse_pinned_desktop_port(Some("65532")), Ok(Some(65532)));
        assert!(parse_pinned_desktop_port(Some("not-a-port")).is_err());
    }

    #[cfg(not(mobile))]
    #[test]
    fn node_resolution_stays_path_based_and_resource_simplification_is_stable() {
        assert_eq!(find_node(), "node");
        let resource_dir = Path::new("/bundle/resources");
        assert_eq!(simplified_sidecar_resource_dir(resource_dir), resource_dir);
    }

    #[test]
    fn mobile_profiles_stay_inside_the_app_private_config_directory() {
        let temp = tempfile::tempdir().expect("tempdir");
        let private_config = temp.path().join("app-private-config");
        std::fs::create_dir(&private_config).expect("create config dir");
        assert_eq!(
            secure_mobile_station_profiles_path(&private_config).expect("secure mobile path"),
            private_config.join("profiles.json")
        );
    }

    #[cfg(unix)]
    #[test]
    fn mobile_profiles_secure_the_platform_created_config_directory() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().expect("tempdir");
        let private_config = temp.path().join("app-private-config");
        std::fs::create_dir(&private_config).expect("create config dir");
        std::fs::set_permissions(&private_config, std::fs::Permissions::from_mode(0o755))
            .expect("set permissive fixture mode");
        secure_mobile_station_profiles_path(&private_config).expect("secure mobile path");
        let mode = std::fs::symlink_metadata(&private_config)
            .expect("config metadata")
            .permissions()
            .mode();
        assert_eq!(mode & 0o077, 0);
    }

    #[cfg(unix)]
    #[test]
    fn mobile_profiles_refuse_a_symlinked_config_directory() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("tempdir");
        let target = temp.path().join("target");
        let link = temp.path().join("app-private-config");
        std::fs::create_dir(&target).expect("create target");
        symlink(&target, &link).expect("create config symlink");
        assert!(secure_mobile_station_profiles_path(&link)
            .unwrap_err()
            .contains("must not be a symlink"));
    }

    #[test]
    fn service_log_file_paths_derives_the_real_per_platform_shape() {
        use crate::service_state::{ResolvedLocalService, ServiceManifest};
        use std::path::PathBuf;

        fn service(platform: &str, instance_id: &str, base_dir: PathBuf) -> ResolvedLocalService {
            ResolvedLocalService {
                base_dir,
                manifest: ServiceManifest {
                    host: "127.0.0.1".into(),
                    instance_id: instance_id.into(),
                    node_path: "node".into(),
                    platform: platform.into(),
                    repo_path: "repo".into(),
                    server_port: 3141,
                    ui_port: 3000,
                },
            }
        }

        // A relative base dir, joined with the platform's own path separator
        // at assertion time too, so this test is not tied to a Unix-shaped
        // absolute path on a Windows host. Two distinct instance ids — a
        // hardcoded "default" in the implementation would still pass a
        // single-instance test.
        let base_dir = PathBuf::from("station-home");
        let logs_dir = base_dir.join("logs");

        for instance_id in ["default", "work"] {
            // launchd (macOS): separate stdout/stderr files, matching
            // service-launchd.ts's StandardOutPath/StandardErrorPath.
            let darwin = service("darwin", instance_id, base_dir.clone());
            let (log_path, error_log_path) = service_log_file_paths(Some(&darwin));
            assert_eq!(
                log_path,
                Some(
                    logs_dir
                        .join(format!("{instance_id}-service.out.log"))
                        .to_string_lossy()
                        .to_string()
                )
            );
            assert_eq!(
                error_log_path,
                Some(
                    logs_dir
                        .join(format!("{instance_id}-service.err.log"))
                        .to_string_lossy()
                        .to_string()
                )
            );

            // Windows service wrapper: one combined log file, matching
            // service-windows.ts's logPath() — no separate error file exists.
            let win32 = service("win32", instance_id, base_dir.clone());
            let (log_path, error_log_path) = service_log_file_paths(Some(&win32));
            assert_eq!(
                log_path,
                Some(
                    logs_dir
                        .join(format!("{instance_id}-service.log"))
                        .to_string_lossy()
                        .to_string()
                )
            );
            assert_eq!(error_log_path, None);

            // systemd (Linux): service-systemd.ts sets no
            // StandardOutput/StandardError file — journald is the only
            // destination, so there is truthfully no file path to report.
            let linux = service("linux", instance_id, base_dir.clone());
            assert_eq!(service_log_file_paths(Some(&linux)), (None, None));
        }

        // No resolved local service at all: still never a fabricated path.
        assert_eq!(service_log_file_paths(None), (None, None));
    }

    #[test]
    fn service_status_problem_log_level_warns_once_then_debugs_on_repeat() {
        let unhealthy_a = Some(ServiceStatusProblem::Unhealthy("default".into()));
        let unhealthy_b = Some(ServiceStatusProblem::Unhealthy("work".into()));
        let invalid = Some(ServiceStatusProblem::InvalidDefaultProfile("bad".into()));

        // No problem: always silent, whatever came before.
        assert_eq!(
            service_status_problem_log_level(&None, &None),
            ProblemLogLevel::Silent
        );
        assert_eq!(
            service_status_problem_log_level(&unhealthy_a, &None),
            ProblemLogLevel::Silent
        );

        // A fresh problem — including from "no problem" — is a transition.
        assert_eq!(
            service_status_problem_log_level(&None, &unhealthy_a),
            ProblemLogLevel::Warn
        );

        // The identical problem again (the persistently-unhealthy case this
        // fix targets) is a repeat, not a transition.
        assert_eq!(
            service_status_problem_log_level(&unhealthy_a, &unhealthy_a),
            ProblemLogLevel::Debug
        );

        // A different instance, or a different problem KIND entirely, is a
        // fresh transition even though "previous" was also `Some`.
        assert_eq!(
            service_status_problem_log_level(&unhealthy_a, &unhealthy_b),
            ProblemLogLevel::Warn
        );
        assert_eq!(
            service_status_problem_log_level(&unhealthy_a, &invalid),
            ProblemLogLevel::Warn
        );
    }

    #[test]
    fn app_log_dir_for_resolves_under_the_given_identifier() {
        let Some(dir) = app_log_dir_for("io.kontourai.station.test-probe") else {
            // No home/data-local dir resolvable in this environment — nothing
            // to assert (rare CI sandboxing), but not a defect in the
            // function itself.
            return;
        };
        assert!(
            dir.components()
                .any(|component| component.as_os_str() == "io.kontourai.station.test-probe"),
            "expected the identifier as a path component of {dir:?}"
        );
    }

    #[test]
    fn log_dir_is_writable_probes_actual_write_capability_not_just_mkdir() {
        let temp = tempfile::tempdir().expect("tempdir");

        let writable_dir = temp.path().join("logs");
        assert!(log_dir_is_writable(&writable_dir));
        // The probe file must not be left behind.
        assert!(std::fs::read_dir(&writable_dir)
            .expect("read created dir")
            .next()
            .is_none());

        // A path that collides with an existing FILE can never become a
        // directory: create_dir_all must fail, and the pre-check must report
        // that honestly rather than assuming create_dir_all's early success
        // on the parent means the leaf is writable.
        let blocked_by_a_file = temp.path().join("not-a-directory");
        std::fs::write(&blocked_by_a_file, b"x").expect("write blocking file");
        let unwritable = blocked_by_a_file.join("logs");
        assert!(!log_dir_is_writable(&unwritable));
    }

    #[test]
    fn desktop_log_file_path_matches_the_file_name_registered_with_the_log_plugin() {
        // Independently reconstructs what tauri-plugin-log's `LogDir` target
        // writes for `file_name: Some(DESKTOP_LOG_FILE_NAME.into())` (the
        // exact value `run()` registers) via a *different* code path than
        // `desktop_log_file_path_within` — `format!` + `join` on an
        // explicitly-suffixed name, instead of `join` + `with_extension`. If
        // either side stops reading `DESKTOP_LOG_FILE_NAME` — the constant
        // shared with the plugin registration in `run()` — the two
        // constructions diverge and this reds (#1899 review: `logPath` was a
        // directory, not the file the plugin actually writes).
        let dir = std::path::PathBuf::from("app-log-dir");
        let expected = dir
            .join(format!("{DESKTOP_LOG_FILE_NAME}.log"))
            .to_string_lossy()
            .to_string();
        assert_eq!(desktop_log_file_path_within(&dir), expected);
        // And it must actually be the file, not the directory alone.
        assert_ne!(
            desktop_log_file_path_within(&dir),
            dir.to_string_lossy().to_string()
        );
    }

    #[test]
    fn desktop_log_level_defaults_to_info_when_unset_or_blank() {
        assert_eq!(
            resolve_desktop_log_level(None),
            (log::LevelFilter::Info, None)
        );
        assert_eq!(
            resolve_desktop_log_level(Some(String::new())),
            (log::LevelFilter::Info, None)
        );
        assert_eq!(
            resolve_desktop_log_level(Some("   ".into())),
            (log::LevelFilter::Info, None)
        );
    }

    #[test]
    fn desktop_log_level_parses_every_documented_level_case_insensitively() {
        assert_eq!(
            resolve_desktop_log_level(Some("trace".into())).0,
            log::LevelFilter::Trace
        );
        assert_eq!(
            resolve_desktop_log_level(Some("DEBUG".into())).0,
            log::LevelFilter::Debug
        );
        assert_eq!(
            resolve_desktop_log_level(Some("Info".into())).0,
            log::LevelFilter::Info
        );
        assert_eq!(
            resolve_desktop_log_level(Some("warn".into())).0,
            log::LevelFilter::Warn
        );
        assert_eq!(
            resolve_desktop_log_level(Some("ERROR".into())).0,
            log::LevelFilter::Error
        );
        assert_eq!(
            resolve_desktop_log_level(Some("off".into())).0,
            log::LevelFilter::Off
        );
    }

    #[test]
    fn desktop_log_level_falls_back_to_info_and_reports_the_invalid_raw_value() {
        let (level, invalid) = resolve_desktop_log_level(Some("verbose".into()));
        assert_eq!(level, log::LevelFilter::Info);
        assert_eq!(invalid.as_deref(), Some("verbose"));
    }

    fn plugins_map(value: serde_json::Value) -> std::collections::HashMap<String, serde_json::Value> {
        match value {
            serde_json::Value::Object(map) => map.into_iter().collect(),
            _ => panic!("test fixture must be a JSON object"),
        }
    }

    #[test]
    fn desktop_updater_plugin_is_inert_with_no_updater_key_at_all() {
        // Every dev build and every repo-committed tauri.*.conf.json: no
        // `plugins.updater` key exists until a release build's config
        // overlay injects one.
        assert!(!desktop_updater_plugin_configured(&plugins_map(
            serde_json::json!({})
        )));
    }

    #[test]
    fn desktop_updater_plugin_is_inert_with_pubkey_but_no_endpoints() {
        // Today's `native-release-config.mjs` overlay by itself: a signing
        // pubkey with no endpoints. The plugin must stay unregistered until
        // an endpoints overlay is also present, not merely degrade.
        assert!(!desktop_updater_plugin_configured(&plugins_map(
            serde_json::json!({ "updater": { "pubkey": "abc" } })
        )));
    }

    #[test]
    fn desktop_updater_plugin_is_inert_with_empty_pubkey_or_empty_endpoints() {
        assert!(!desktop_updater_plugin_configured(&plugins_map(
            serde_json::json!({ "updater": { "pubkey": "  ", "endpoints": ["https://example.test/latest.json"] } })
        )));
        assert!(!desktop_updater_plugin_configured(&plugins_map(
            serde_json::json!({ "updater": { "pubkey": "abc", "endpoints": [] } })
        )));
        assert!(!desktop_updater_plugin_configured(&plugins_map(
            serde_json::json!({ "updater": { "pubkey": "abc", "endpoints": [""] } })
        )));
    }

    #[test]
    fn desktop_updater_plugin_is_active_with_pubkey_and_endpoints() {
        assert!(desktop_updater_plugin_configured(&plugins_map(
            serde_json::json!({
                "updater": {
                    "pubkey": "abc",
                    "endpoints": ["https://example.test/latest.json"],
                }
            })
        )));
    }

    #[test]
    fn desktop_updater_config_key_path_matches_the_release_config_emitter() {
        // Cross-file pin against `scripts/lib/native-release-config.mjs`'s
        // `createNativeReleaseConfig`, which writes the signing key at
        // `plugins.updater.pubkey` (its own JS-side test pins the same
        // string against this file). Renaming either side's key without the
        // other breaks self-update silently rather than loudly, so both
        // sides assert the literal path.
        let source = include_str!("lib.rs");
        assert!(source.contains(".get(\"updater\")"));
        assert!(source.contains(".get(\"pubkey\")"));
        assert!(source.contains(".get(\"endpoints\")"));
    }

    #[test]
    fn windows_process_probe_uses_only_exact_success_numeric_output() {
        assert_eq!(
            windows_process_liveness_from_output(true, b"1\r\n"),
            ProfileLockOwnerLiveness::Alive
        );
        assert_eq!(
            windows_process_liveness_from_output(true, b"0"),
            ProfileLockOwnerLiveness::Dead
        );
        assert_eq!(
            windows_process_liveness_from_output(true, b"No tasks are running"),
            ProfileLockOwnerLiveness::Ambiguous
        );
        assert_eq!(
            windows_process_liveness_from_output(false, b"0"),
            ProfileLockOwnerLiveness::Ambiguous
        );
    }

    #[test]
    fn windows_process_probe_has_no_post_command_arguments() {
        let args = windows_process_probe_arguments(4242);
        assert_eq!(args.len(), 4);
        assert_eq!(args[2], "-EncodedCommand");
        assert!(!args.iter().any(|argument| argument.contains("4242")));
    }

    #[test]
    fn station_profile_credentials_use_the_shared_keyring_account_convention() {
        let reference = NativeCredentialReference {
            kind: "station-bearer".to_string(),
            id: "kontour-token".to_string(),
        };

        assert_eq!(STATION_CREDENTIAL_SERVICE, "io.kontourai.station");
        assert_eq!(
            credential_account(&reference).unwrap(),
            "profile:station-bearer:kontour-token"
        );
    }

    #[test]
    fn station_profile_credentials_reject_unknown_or_empty_references() {
        assert!(credential_account(&NativeCredentialReference {
            kind: "connection".to_string(),
            id: "credential".to_string(),
        })
        .is_err());
        assert!(credential_account(&NativeCredentialReference {
            kind: "station-bearer".to_string(),
            id: " ".to_string(),
        })
        .is_err());
    }

    #[test]
    fn native_http_streams_cannot_starve_ordinary_reads() {
        // The defect this pins (station#2282): Station's own long-lived event
        // streams filled the single per-origin allowance, and an ordinary
        // authenticated read then failed with `capacity reached` against a
        // healthy, authorized Station.
        use std::collections::HashMap;
        let mut active: HashMap<String, NativeActiveHttpRequest> = HashMap::new();
        let origin = "https://station.example.test";
        let cancel = || std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

        // Saturate the stream allowance for this origin.
        for index in 0..NATIVE_HTTP_PER_ORIGIN_STREAM_LIMIT {
            admit_native_http_request(
                &mut active,
                &format!("stream-{index}"),
                origin,
                true,
                cancel(),
            )
            .expect("stream within its own allowance is admitted");
        }
        assert_eq!(
            admit_native_http_request(&mut active, "stream-overflow", origin, true, cancel()),
            Err("native Station request capacity reached".to_string()),
            "the stream allowance is still bounded"
        );

        // THE point: ordinary reads still have their full allowance.
        for index in 0..NATIVE_HTTP_PER_ORIGIN_REQUEST_LIMIT {
            admit_native_http_request(
                &mut active,
                &format!("read-{index}"),
                origin,
                false,
                cancel(),
            )
            .expect("an ordinary read is not starved by saturated streams");
        }
        assert_eq!(
            admit_native_http_request(&mut active, "read-overflow", origin, false, cancel()),
            Err("native Station request capacity reached".to_string()),
            "the ordinary allowance is still bounded"
        );

        // A different origin is unaffected by either.
        admit_native_http_request(
            &mut active,
            "other-origin-read",
            "https://other.example.test",
            false,
            cancel(),
        )
        .expect("per-origin accounting stays per-origin");

        // Duplicate ids are still refused regardless of class.
        assert_eq!(
            admit_native_http_request(&mut active, "read-0", origin, false, cancel()),
            Err("native Station request capacity reached".to_string()),
        );
    }

    #[test]
    fn native_http_capacity_refusal_carries_a_structured_transport_code() {
        let cancellations = NativeHttpCancellation::default();
        let cancel = || std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

        reserve_native_http_request(
            &cancellations,
            "request-1",
            "https://station.example.test",
            false,
            cancel(),
        )
        .expect("the first request is admitted");

        let refusal = reserve_native_http_request(
            &cancellations,
            "request-1",
            "https://station.example.test",
            false,
            cancel(),
        )
        .expect_err("a duplicate request id is refused");

        assert_eq!(refusal.code, "transport_capacity");
        assert_eq!(refusal.message, "native Station request capacity reached");
    }

    fn wait_for_pending_native_reads(cancellations: &NativeHttpCancellation, expected: usize) {
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let (state_lock, _) = &*cancellations.0;
            let pending = state_lock.lock().unwrap().pending_reads.len();
            if pending == expected {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "expected {expected} pending native reads, observed {pending}"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn fill_native_read_allowance(cancellations: &NativeHttpCancellation, origin: &str) {
        let (state_lock, _) = &*cancellations.0;
        let mut state = state_lock.lock().unwrap();
        for index in 0..NATIVE_HTTP_PER_ORIGIN_REQUEST_LIMIT {
            state.active.insert(
                format!("seed-{index}"),
                NativeActiveHttpRequest {
                    cancel: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                    origin: origin.to_string(),
                    stream: false,
                },
            );
        }
    }

    #[test]
    fn native_http_ordinary_reads_wait_for_capacity_in_fifo_order() {
        let cancellations = NativeHttpCancellation::default();
        let origin = "https://station.example.test";
        fill_native_read_allowance(&cancellations, origin);
        let (admitted_tx, admitted_rx) = std::sync::mpsc::channel();

        let first_cancellations = cancellations.clone();
        let first_tx = admitted_tx.clone();
        let first = std::thread::spawn(move || {
            reserve_native_http_request(
                &first_cancellations,
                "queued-first",
                origin,
                false,
                std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            )
            .unwrap();
            first_tx.send("queued-first").unwrap();
        });
        wait_for_pending_native_reads(&cancellations, 1);

        let second_cancellations = cancellations.clone();
        let second = std::thread::spawn(move || {
            reserve_native_http_request(
                &second_cancellations,
                "queued-second",
                origin,
                false,
                std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            )
            .unwrap();
            admitted_tx.send("queued-second").unwrap();
        });
        wait_for_pending_native_reads(&cancellations, 2);

        release_native_http_request(&cancellations, "seed-0").unwrap();
        assert_eq!(
            admitted_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            "queued-first"
        );
        assert!(
            admitted_rx.try_recv().is_err(),
            "the second read must not barge"
        );
        release_native_http_request(&cancellations, "queued-first").unwrap();
        assert_eq!(
            admitted_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
            "queued-second"
        );
        release_native_http_request(&cancellations, "queued-second").unwrap();
        first.join().unwrap();
        second.join().unwrap();
    }

    #[test]
    fn native_http_pending_read_cancellation_wakes_and_removes_the_waiter() {
        let cancellations = NativeHttpCancellation::default();
        let origin = "https://station.example.test";
        fill_native_read_allowance(&cancellations, origin);
        let queued_cancellations = cancellations.clone();
        let waiter = std::thread::spawn(move || {
            reserve_native_http_request(
                &queued_cancellations,
                "queued-cancelled",
                origin,
                false,
                std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            )
            .unwrap_err()
        });
        wait_for_pending_native_reads(&cancellations, 1);

        cancel_native_http_request(&cancellations, "queued-cancelled").unwrap();
        let refusal = waiter.join().unwrap();
        assert_eq!(refusal.code, "cancelled");
        let (state_lock, _) = &*cancellations.0;
        let state = state_lock.lock().unwrap();
        assert!(state.pending_reads.is_empty());
        assert!(!state.active.contains_key("queued-cancelled"));
    }

    #[test]
    fn native_http_global_cap_queues_reads_but_still_rejects_streams() {
        let cancellations = NativeHttpCancellation::default();
        {
            let (state_lock, _) = &*cancellations.0;
            let mut state = state_lock.lock().unwrap();
            for index in 0..NATIVE_HTTP_GLOBAL_REQUEST_LIMIT {
                state.active.insert(
                    format!("global-{index}"),
                    NativeActiveHttpRequest {
                        cancel: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                        origin: format!("https://station-{index}.example.test"),
                        stream: true,
                    },
                );
            }
        }
        let stream_refusal = reserve_native_http_request(
            &cancellations,
            "stream-overflow",
            "https://stream.example.test",
            true,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
        .unwrap_err();
        assert_eq!(stream_refusal.code, "transport_capacity");

        let queued_cancellations = cancellations.clone();
        let waiter = std::thread::spawn(move || {
            reserve_native_http_request(
                &queued_cancellations,
                "queued-global",
                "https://read.example.test",
                false,
                std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            )
        });
        wait_for_pending_native_reads(&cancellations, 1);
        release_native_http_request(&cancellations, "global-0").unwrap();
        waiter.join().unwrap().unwrap();
        release_native_http_request(&cancellations, "queued-global").unwrap();
    }

    #[test]
    fn native_http_pending_read_queue_is_bounded() {
        let cancellations = NativeHttpCancellation::default();
        {
            let (state_lock, _) = &*cancellations.0;
            let mut state = state_lock.lock().unwrap();
            for index in 0..NATIVE_HTTP_PENDING_READ_LIMIT {
                state.pending_reads.push_back(NativePendingHttpRequest {
                    request_id: format!("pending-{index}"),
                    origin: "https://station.example.test".to_string(),
                    cancel: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
                });
            }
        }

        let refusal = reserve_native_http_request(
            &cancellations,
            "pending-overflow",
            "https://station.example.test",
            false,
            std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        )
        .unwrap_err();
        assert_eq!(refusal.code, "transport_capacity");
        assert_eq!(
            refusal.message,
            "native Station request queue capacity reached"
        );
    }

    #[test]
    fn native_pairing_exchange_reservation_rejects_duplicate_and_per_origin_overflow() {
        let cancellations = NativePairingExchangeCancellation::default();
        let origin = "https://station.example.test";

        let first = reserve_native_pairing_exchange(&cancellations, "operation-1", origin)
            .expect("first exchange is admitted");
        assert!(!first.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(
            reserve_native_pairing_exchange(&cancellations, "operation-1", origin)
                .unwrap_err()
                .code,
            "operation_in_progress"
        );
        reserve_native_pairing_exchange(&cancellations, "operation-2", origin)
            .expect("second exchange for an origin is admitted");
        assert_eq!(
            reserve_native_pairing_exchange(&cancellations, "operation-3", origin)
                .unwrap_err()
                .code,
            "capacity_reached"
        );

        release_native_pairing_exchange(&cancellations, "operation-1");
        reserve_native_pairing_exchange(&cancellations, "operation-1", origin)
            .expect("released operation ids are reusable");
    }

    #[test]
    fn native_pairing_exchange_reservation_enforces_global_cap_and_releases() {
        let cancellations = NativePairingExchangeCancellation::default();
        for index in 0..NATIVE_PAIRING_EXCHANGE_GLOBAL_REQUEST_LIMIT {
            reserve_native_pairing_exchange(
                &cancellations,
                &format!("operation-{index}"),
                &format!("https://station-{index}.example.test"),
            )
            .expect("distinct origins are admitted up to the global limit");
        }
        assert_eq!(
            reserve_native_pairing_exchange(
                &cancellations,
                "operation-overflow",
                "https://another.example.test",
            )
            .unwrap_err()
            .code,
            "capacity_reached"
        );

        release_native_pairing_exchange(&cancellations, "operation-0");
        reserve_native_pairing_exchange(
            &cancellations,
            "operation-overflow",
            "https://another.example.test",
        )
        .expect("capacity is returned after every completed exchange");
    }

    #[test]
    fn credential_access_is_bound_to_the_selected_profile_reference() {
        let reference = selected_credential_reference_from_contents(
            r#"{
              "schemaVersion":1,
              "revision":0,
              "defaultProfile":"remote",
              "profiles":[
                {"schemaVersion":1,"name":"local","endpoint":"http://127.0.0.1:3141","credentialRef":{"kind":"station-bearer","id":"local-token"},"setupSource":"local","configurationState":"configured","createdAt":1,"updatedAt":1},
                {"schemaVersion":1,"name":"remote","endpoint":"https://station.example","credentialRef":{"kind":"station-bearer","id":"remote-token"},"setupSource":"hosted","configurationState":"configured","createdAt":1,"updatedAt":1}
              ],
              "projectProfiles":{}
            }"#,
            "local",
        )
        .expect("selected Station is credential-safe");

        assert_eq!(reference.id, "local-token");
    }

    #[test]
    fn credential_access_rejects_nonloopback_http_profiles() {
        let contents = r#"{
          "schemaVersion":1,
          "revision":0,
          "defaultProfile":"remote",
          "profiles":[
            {"schemaVersion":1,"name":"remote","endpoint":"http://station.example","credentialRef":{"kind":"station-bearer","id":"remote-token"},"setupSource":"hosted","configurationState":"configured","createdAt":1,"updatedAt":1}
          ],
          "projectProfiles":{}
        }"#;

        assert!(
            selected_credential_reference_from_contents(contents, "remote")
                .unwrap_err()
                .contains("non-HTTPS, non-loopback")
        );
        assert!(credential_endpoint_uses_secure_transport(
            "https://station.example"
        ));
        assert!(credential_endpoint_uses_secure_transport(
            "http://127.0.0.1:3141"
        ));
        assert!(credential_endpoint_uses_secure_transport(
            "http://[::1]:3141"
        ));
        assert!(!credential_endpoint_uses_secure_transport(
            "http://station.example"
        ));
    }

    #[test]
    fn profile_store_rejects_aliases_unknown_fields_and_missing_required_fields() {
        let alias = r#"{
          "schemaVersion":1,"revision":0,"defaultProfile":"one","projectProfiles":{},
          "profiles":[
            {"schemaVersion":1,"name":"one","endpoint":"https://one.example","credentialRef":{"kind":"station-bearer","id":"shared"},"setupSource":"hosted","configurationState":"configured","createdAt":1,"updatedAt":1},
            {"schemaVersion":1,"name":"two","endpoint":"https://two.example","credentialRef":{"kind":"station-bearer","id":"shared"},"setupSource":"hosted","configurationState":"configured","createdAt":1,"updatedAt":1}
          ]
        }"#;
        assert!(parse_station_profile_store(alias)
            .unwrap_err()
            .contains("references must be unique"));

        let unknown = r#"{
          "schemaVersion":1,"revision":0,"defaultProfile":null,"projectProfiles":{},"unexpected":true,"profiles":[]
        }"#;
        assert!(parse_station_profile_store(unknown).is_err());

        let missing_default = r#"{
          "schemaVersion":1,"revision":0,"projectProfiles":{},"profiles":[]
        }"#;
        assert!(parse_station_profile_store(missing_default).is_err());

        let empty_endpoint = r#"{
          "schemaVersion":1,"revision":0,"defaultProfile":"one","projectProfiles":{},
          "profiles":[{"schemaVersion":1,"name":"one","endpoint":"","setupSource":"manual","configurationState":"unconfigured","createdAt":1,"updatedAt":1}]
        }"#;
        assert!(parse_station_profile_store(empty_endpoint).is_err());

        let unsafe_revision = r#"{
          "schemaVersion":1,"revision":9007199254740992,"defaultProfile":null,"projectProfiles":{},"profiles":[]
        }"#;
        assert!(parse_station_profile_store(unsafe_revision).is_err());
    }

    #[test]
    fn host_observed_credential_binding_rejects_metadata_reassignment() {
        let trusted = parse_station_profile_store(
            r#"{
              "schemaVersion":1,"revision":0,"defaultProfile":"one","projectProfiles":{},
              "profiles":[{"schemaVersion":1,"name":"one","endpoint":"https://one.example","credentialRef":{"kind":"station-bearer","id":"token-one"},"environmentId":"environment-one","setupSource":"hosted","configurationState":"configured","createdAt":1,"updatedAt":1}]
            }"#,
        )
        .unwrap();
        let reassigned = parse_station_profile_store(
            r#"{
              "schemaVersion":1,"revision":1,"defaultProfile":"two","projectProfiles":{},
              "profiles":[{"schemaVersion":1,"name":"two","endpoint":"https://two.example","credentialRef":{"kind":"station-bearer","id":"token-one"},"environmentId":"environment-one","setupSource":"hosted","configurationState":"configured","createdAt":1,"updatedAt":1}]
            }"#,
        )
        .unwrap();
        let mut authority = NativeProfileAuthorityState::default();
        observe_configured_profile_bindings(&mut authority, &trusted).unwrap();

        assert!(profile_bindings_are_authorized(&authority, &reassigned)
            .unwrap_err()
            .contains("origin and environment"));
    }

    #[test]
    fn renderer_cannot_add_unknown_credential_or_mutate_bound_endpoint_or_environment() {
        let trusted = parse_station_profile_store(
            r#"{
              "schemaVersion":1,"revision":0,"defaultProfile":"one","projectProfiles":{},
              "profiles":[{"schemaVersion":1,"name":"one","endpoint":"https://one.example","credentialRef":{"kind":"station-bearer","id":"token-one"},"environmentId":"environment-one","setupSource":"hosted","configurationState":"configured","createdAt":1,"updatedAt":1}]
            }"#,
        )
        .unwrap();
        let mut authority = NativeProfileAuthorityState::default();
        observe_configured_profile_bindings(&mut authority, &trusted).unwrap();

        let endpoint_mutation = parse_station_profile_store(
            r#"{
              "schemaVersion":1,"revision":1,"defaultProfile":"one","projectProfiles":{},
              "profiles":[{"schemaVersion":1,"name":"one","endpoint":"https://other.example","credentialRef":{"kind":"station-bearer","id":"token-one"},"environmentId":"environment-one","setupSource":"hosted","configurationState":"configured","createdAt":1,"updatedAt":1}]
            }"#,
        )
        .unwrap();
        assert!(
            renderer_store_references_are_authorized(&authority, &endpoint_mutation)
                .unwrap_err()
                .contains("origin and environment")
        );

        let environment_mutation = parse_station_profile_store(
            r#"{
              "schemaVersion":1,"revision":1,"defaultProfile":"one","projectProfiles":{},
              "profiles":[{"schemaVersion":1,"name":"one","endpoint":"https://one.example","credentialRef":{"kind":"station-bearer","id":"token-one"},"environmentId":"environment-two","setupSource":"hosted","configurationState":"configured","createdAt":1,"updatedAt":1}]
            }"#,
        )
        .unwrap();
        assert!(
            renderer_store_references_are_authorized(&authority, &environment_mutation).is_err()
        );

        let unknown_reference = parse_station_profile_store(
            r#"{
              "schemaVersion":1,"revision":1,"defaultProfile":"one","projectProfiles":{},
              "profiles":[{"schemaVersion":1,"name":"one","endpoint":"https://one.example","credentialRef":{"kind":"station-bearer","id":"token-one"},"environmentId":"environment-one","setupSource":"hosted","configurationState":"configured","createdAt":1,"updatedAt":1},{"schemaVersion":1,"name":"two","endpoint":"https://two.example","credentialRef":{"kind":"station-bearer","id":"token-two"},"environmentId":"environment-two","setupSource":"hosted","configurationState":"configured","createdAt":1,"updatedAt":1}]
            }"#,
        )
        .unwrap();
        assert!(
            renderer_store_references_are_authorized(&authority, &unknown_reference)
                .unwrap_err()
                .contains("cannot add")
        );
    }

    fn basis_authority_store(first_id: &str, second_id: &str) -> CredentialProfileStore {
        parse_station_profile_store(&format!(
            r#"{{
              "schemaVersion":1,"revision":0,"defaultProfile":"A","projectProfiles":{{}},
              "profiles":[
                {{"schemaVersion":1,"name":"A","endpoint":"https://basis.example","credentialRef":{{"kind":"station-bearer","id":"{first_id}"}},"environmentId":"environment-a","setupSource":"hosted","configurationState":"configured","createdAt":1,"updatedAt":1}},
                {{"schemaVersion":1,"name":"B","endpoint":"https://basis.example","credentialRef":{{"kind":"station-bearer","id":"{second_id}"}},"environmentId":"environment-b","setupSource":"hosted","configurationState":"configured","createdAt":1,"updatedAt":1}}
              ]
            }}"#
        ))
        .unwrap()
    }

    #[test]
    fn basis_receipt_is_opaque_and_contains_only_uuid_and_exact_origin() {
        let store = basis_authority_store("token-a", "token-b");
        let mut authority = NativeProfileAuthorityState::default();
        observe_configured_profile_bindings(&mut authority, &store).unwrap();
        let receipt = authorize_active_profile_in_state(&mut authority, &store, "A").unwrap();

        assert!(uuid::Uuid::parse_str(&receipt.binding_id).is_ok());
        assert_eq!(receipt.exact_origin, "https://basis.example");
        assert_eq!(
            serde_json::to_value(&receipt).unwrap(),
            serde_json::json!({
                "bindingId": receipt.binding_id,
                "exactOrigin": "https://basis.example"
            })
        );
    }

    #[test]
    fn basis_scoped_receipt_never_switches_to_same_origin_active_profile() {
        let store = basis_authority_store("token-a", "token-b");
        let mut authority = NativeProfileAuthorityState::default();
        observe_configured_profile_bindings(&mut authority, &store).unwrap();
        let receipt_a = authorize_active_profile_in_state(&mut authority, &store, "A").unwrap();
        let reference_a = scoped_profile_for_origin_in_store(
            &authority,
            &store,
            &receipt_a.binding_id,
            "https://basis.example",
        )
        .unwrap();
        assert_eq!(reference_a.id, "token-a");

        // Models a worker delayed after receipt capture: B becomes active on
        // the same origin, but the old worker cannot read or send with B.
        let receipt_b = authorize_active_profile_in_state(&mut authority, &store, "B").unwrap();
        let stale = scoped_profile_for_origin_in_store(
            &authority,
            &store,
            &receipt_a.binding_id,
            "https://basis.example",
        )
        .unwrap_err();
        assert_eq!(stale.code, "request_binding_stale");
        assert_eq!(
            scoped_profile_for_origin_in_store(
                &authority,
                &store,
                &receipt_b.binding_id,
                "https://basis.example",
            )
            .unwrap()
            .id,
            "token-b"
        );
    }

    #[test]
    fn basis_queued_scoped_request_rejects_after_switch_and_returns_admission() {
        let store = basis_authority_store("token-a", "token-b");
        let mut authority = NativeProfileAuthorityState::default();
        observe_configured_profile_bindings(&mut authority, &store).unwrap();
        let receipt_a = authorize_active_profile_in_state(&mut authority, &store, "A").unwrap();
        let cancellations = NativeHttpCancellation::default();
        fill_native_read_allowance(&cancellations, "https://basis.example");
        let queued_cancellations = cancellations.clone();
        let queued = std::thread::spawn(move || {
            reserve_native_http_request(
                &queued_cancellations,
                "basis-queued",
                "https://basis.example",
                false,
                std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            )
        });
        wait_for_pending_native_reads(&cancellations, 1);

        authorize_active_profile_in_state(&mut authority, &store, "B").unwrap();
        release_native_http_request(&cancellations, "seed-0").unwrap();
        queued.join().unwrap().unwrap();
        let stale = scoped_profile_for_origin_in_store(
            &authority,
            &store,
            &receipt_a.binding_id,
            "https://basis.example",
        )
        .unwrap_err();
        assert_eq!(stale.code, "request_binding_stale");
        release_native_http_request(&cancellations, "basis-queued").unwrap();
        let (state_lock, _) = &*cancellations.0;
        assert!(!state_lock
            .lock()
            .unwrap()
            .active
            .contains_key("basis-queued"));
    }

    #[test]
    fn basis_old_a_receipt_is_invalid_after_a_b_a_and_active_rotation_or_delete() {
        let store = basis_authority_store("token-a", "token-b");
        let mut authority = NativeProfileAuthorityState::default();
        observe_configured_profile_bindings(&mut authority, &store).unwrap();
        let first_a = authorize_active_profile_in_state(&mut authority, &store, "A").unwrap();
        authorize_active_profile_in_state(&mut authority, &store, "B").unwrap();
        let second_a = authorize_active_profile_in_state(&mut authority, &store, "A").unwrap();
        assert_ne!(first_a.binding_id, second_a.binding_id);
        assert_eq!(
            scoped_profile_for_origin_in_store(
                &authority,
                &store,
                &first_a.binding_id,
                "https://basis.example",
            )
            .unwrap_err()
            .code,
            "request_binding_stale"
        );

        let rotated = basis_authority_store("token-a-fresh", "token-b");
        observe_configured_profile_bindings(&mut authority, &rotated).unwrap();
        invalidate_active_profile_receipt_after_store_write(&mut authority, &rotated);
        assert!(
            authority.active.is_none(),
            "same-name fresh reference retires receipt"
        );

        let renewed = authorize_active_profile_in_state(&mut authority, &rotated, "A").unwrap();
        let active_reference = authority.active.as_ref().unwrap().reference.clone();
        invalidate_active_profile_receipt_after_credential_delete(
            &mut authority,
            &active_reference,
        );
        assert_eq!(
            scoped_profile_for_origin_in_store(
                &authority,
                &rotated,
                &renewed.binding_id,
                "https://basis.example",
            )
            .unwrap_err()
            .code,
            "request_binding_stale"
        );
    }

    #[test]
    fn basis_scope_revalidation_rejects_invalid_receipts_and_late_owner_document_change() {
        let store = basis_authority_store("token-a", "token-b");
        let mut authority = NativeProfileAuthorityState::default();
        observe_configured_profile_bindings(&mut authority, &store).unwrap();
        let receipt = authorize_active_profile_in_state(&mut authority, &store, "A").unwrap();
        assert_eq!(
            scoped_profile_for_origin_in_store(
                &authority,
                &store,
                "not-a-receipt",
                "https://basis.example"
            )
            .unwrap_err()
            .code,
            "request_binding_stale"
        );
        let changed = basis_authority_store("token-a", "token-b");
        let mut changed = changed;
        changed.profiles[0].configuration_state = "requires-auth".to_string();
        assert_eq!(
            scoped_profile_for_origin_in_store(
                &authority,
                &changed,
                &receipt.binding_id,
                "https://basis.example",
            )
            .unwrap_err()
            .code,
            "request_binding_stale",
            "the response/header/chunk/end revalidation uses this same real helper"
        );

        let unscoped: NativeHttpRequest = serde_json::from_str(
            r#"{"requestId":"ordinary","url":"https://basis.example/api","method":"GET"}"#,
        )
        .unwrap();
        assert!(unscoped.expected_binding_id.is_none());
    }

    #[test]
    fn requires_auth_profiles_are_not_observed_or_trusted_after_restart() {
        let requires_auth = parse_station_profile_store(
            r#"{
              "schemaVersion":1,"revision":1,"defaultProfile":null,"projectProfiles":{},
              "profiles":[{"schemaVersion":1,"name":"pending","endpoint":"https://one.example","credentialRef":{"kind":"station-bearer","id":"pending-token"},"environmentId":"environment-one","setupSource":"paired","configurationState":"requires-auth","createdAt":1,"updatedAt":1}]
            }"#,
        )
        .unwrap();
        let mut restarted_authority = NativeProfileAuthorityState::default();
        observe_configured_profile_bindings(&mut restarted_authority, &requires_auth).unwrap();
        assert!(restarted_authority.bindings.is_empty());
        assert!(
            renderer_store_references_are_authorized(&restarted_authority, &requires_auth)
                .unwrap_err()
                .contains("cannot add")
        );
    }

    #[test]
    fn pairing_handle_must_match_its_reference_profile_and_phase() {
        let reference = NativeCredentialReference {
            kind: "station-bearer".to_string(),
            id: "host-allocated".to_string(),
        };
        let entry = PendingPairingCredential {
            credential: "secret".to_string(),
            reference: reference.clone(),
            exact_origin: "https://one.example".to_string(),
            environment_id: "environment-one".to_string(),
            client_instance_id: "11111111-1111-4111-8111-111111111111".to_string(),
            expires_at: SystemTime::now() + Duration::from_secs(60),
            phase: NativePairingPhase::RequiresAuthPersisted {
                profile_name: "pending".to_string(),
            },
        };
        let requires_auth = parse_station_profile_store(
            r#"{
              "schemaVersion":1,"revision":1,"defaultProfile":null,"projectProfiles":{},
              "profiles":[{"schemaVersion":1,"name":"pending","endpoint":"https://one.example","credentialRef":{"kind":"station-bearer","id":"host-allocated"},"environmentId":"environment-one","clientInstanceId":"11111111-1111-4111-8111-111111111111","setupSource":"paired","configurationState":"requires-auth","createdAt":1,"updatedAt":1}]
            }"#,
        )
        .unwrap();
        assert_eq!(
            pairing_requires_auth_profile_name(&requires_auth, &entry).unwrap(),
            "pending"
        );
        pairing_profile_matches(&requires_auth, "pending", &entry, "requires-auth").unwrap();
        assert!(pairing_profile_matches(&requires_auth, "pending", &entry, "configured").is_err());
        let mut wrong_client = requires_auth.clone();
        wrong_client.profiles[0].client_instance_id =
            Some("22222222-2222-4222-8222-222222222222".to_string());
        assert!(
            pairing_profile_matches(&wrong_client, "pending", &entry, "requires-auth").is_err()
        );
        assert!(matches!(
            entry.phase,
            NativePairingPhase::RequiresAuthPersisted { .. }
        ));
        assert_eq!(entry.reference, reference);
    }

    #[test]
    fn pairing_selects_only_the_first_profile_at_the_configured_commit() {
        let empty = parse_station_profile_store(EMPTY_STATION_PROFILE_STORE).unwrap();
        let pending_with_default = parse_station_profile_store(
            r#"{
              "schemaVersion":1,"revision":1,"defaultProfile":"mobile","projectProfiles":{},
              "profiles":[{"schemaVersion":1,"name":"mobile","endpoint":"https://one.example","credentialRef":{"kind":"station-bearer","id":"host-allocated"},"environmentId":"environment-one","clientInstanceId":"11111111-1111-4111-8111-111111111111","setupSource":"paired","configurationState":"requires-auth","createdAt":1,"updatedAt":1}]
            }"#,
        )
        .unwrap();
        assert!(
            validate_pairing_default_transition(&empty, &pending_with_default, None).is_err(),
            "the requires-auth write cannot select a profile before the credential is durable"
        );

        let configured_with_default = parse_station_profile_store(
            r#"{
              "schemaVersion":1,"revision":2,"defaultProfile":"mobile","projectProfiles":{},
              "profiles":[{"schemaVersion":1,"name":"mobile","endpoint":"https://one.example","credentialRef":{"kind":"station-bearer","id":"host-allocated"},"environmentId":"environment-one","clientInstanceId":"11111111-1111-4111-8111-111111111111","setupSource":"paired","configurationState":"configured","createdAt":1,"updatedAt":1}]
            }"#,
        )
        .unwrap();
        assert!(validate_pairing_default_transition(
            &empty,
            &configured_with_default,
            Some("mobile")
        )
        .is_ok());
        assert!(validate_pairing_default_transition(
            &empty,
            &configured_with_default,
            Some("other")
        )
        .is_err());

        let mut removal = configured_with_default.clone();
        removal.revision += 1;
        removal.default_profile = None;
        assert!(
            validate_pairing_default_transition(&configured_with_default, &removal, Some("mobile"))
                .is_err(),
            "pairing cannot replace or clear an explicit default"
        );
        assert!(validate_pairing_default_transition(
            &configured_with_default,
            &configured_with_default,
            None
        )
        .is_ok());
    }

    #[test]
    fn pairing_exchange_response_accepts_additive_metadata_but_keeps_ipc_secret_free() {
        let raw = r#"{"environmentId":"environment-one","device":{"id":"device","name":"Pixel","scope":"device.read","kind":"device","createdAt":1,"lastUsedAt":null,"activityTracking":"tracked-since-issued","lastSeenFrom":null,"usageCount":0,"lastActiveDay":null,"revokedAt":null,"revocation":{"state":"not-revoked"},"source":"pairing-code"},"credential":"secret","replacement":"none"}"#;
        let response = serde_json::from_str::<NativePairingExchangeResponse>(raw).unwrap();
        let device = native_pairing_device_response(response.device).unwrap();
        let encoded = serde_json::to_string(&NativePairingExchangeSuccess {
            ok: true,
            environment_id: response.environment_id,
            device,
            credential_handle: "opaque-handle".to_string(),
            credential_ref: NativeCredentialReference {
                kind: "station-bearer".to_string(),
                id: "host-reference".to_string(),
            },
        })
        .unwrap();
        assert!(!encoded.contains("secret"));
        assert!(!encoded.contains("replacement"));
        assert!(!encoded.contains("activityTracking"));
        assert!(encoded.contains("opaque-handle"));
        let error = sanitized_pairing_error(409, r#"{"error":"request_not_confirmed"}"#);
        let encoded_error = serde_json::to_string(&error).unwrap();
        assert!(encoded_error.contains("request_not_confirmed"));
        assert!(!encoded_error.contains("credential"));
        assert!(encoded_error.contains("\"status\":409"));
    }

    #[test]
    fn pairing_error_code_extracts_only_a_well_formed_snake_case_code() {
        assert_eq!(
            pairing_error_code(r#"{"error":"local_grant_forbidden"}"#),
            "local_grant_forbidden"
        );
        // Malformed body, empty code, and an out-of-alphabet code all fall
        // back to the same generic code rather than leaking arbitrary text.
        assert_eq!(pairing_error_code("not json"), "pairing_exchange_failed");
        assert_eq!(
            pairing_error_code(r#"{"error":""}"#),
            "pairing_exchange_failed"
        );
        assert_eq!(
            pairing_error_code(r#"{"error":"Has Spaces"}"#),
            "pairing_exchange_failed"
        );
    }

    #[test]
    fn local_device_name_is_never_empty_and_names_the_app() {
        let name = local_device_name();
        assert!(!name.trim().is_empty());
        assert!(name.ends_with("Station"));
    }

    /// The EXACT shape `station setup local`
    /// (packages/cli/src/commands/setup-command.ts) writes for a fresh local
    /// install: `configurationState: "configured"`, no `credentialRef` at
    /// all. station#1715 live-boot fix: the previous fixture used
    /// `"unconfigured"` here, which this command never actually sees in
    /// production — that mismatch is exactly why 69 green OnboardingGate
    /// tests (and this file's own tests) missed a real-machine no-op.
    fn local_self_provision_fixture_store() -> CredentialProfileStore {
        parse_station_profile_store(
            r#"{
              "schemaVersion":1,"revision":3,"defaultProfile":"local","projectProfiles":{},
              "profiles":[
                {"schemaVersion":1,"name":"local","endpoint":"http://127.0.0.1:3141","setupSource":"local","configurationState":"configured","localService":{"instanceId":"inst","baseDir":"/home/station","serverPort":3141,"uiPort":3000},"createdAt":1,"updatedAt":1},
                {"schemaVersion":1,"name":"remote","endpoint":"https://station.example","credentialRef":{"kind":"station-bearer","id":"remote-token"},"environmentId":"environment-remote","setupSource":"hosted","configurationState":"configured","createdAt":1,"updatedAt":1}
              ]
            }"#,
        )
        .unwrap()
    }

    #[test]
    fn bundled_sidecar_bootstrap_authors_and_selects_a_channel_owned_profile() {
        let empty = parse_station_profile_store(EMPTY_STATION_PROFILE_STORE).unwrap();
        let (next, profile_name) = reconciled_bundled_local_profile_store(
            &empty,
            std::path::Path::new("/home/test/.station-root"),
            "http://127.0.0.1:28141".to_string(),
            "desktop-sidecar-42".to_string(),
            "/home/test/.station-beta".to_string(),
            28141,
            28000,
            123.0,
        );
        assert_eq!(profile_name, "local");
        assert_eq!(next.revision, 1);
        assert_eq!(next.default_profile, None);
        assert_eq!(next.profiles[0].endpoint, "http://127.0.0.1:28141");
        let service = next.profiles[0]
            .local_service
            .as_ref()
            .expect("local binding");
        assert_eq!(service.instance_id, "desktop-sidecar-42");
        assert_eq!(service.server_port, 28141);
        assert_eq!(service.ui_port, 28000);
        let wire = serde_json::to_string(&next).unwrap();
        assert!(!wire.contains("credentialRef"));
        assert!(!wire.contains("environmentId"));
        assert!(!wire.contains("clientInstanceId"));

        let existing = local_self_provision_fixture_store();
        let (reconciled, owner_name) = reconciled_bundled_local_profile_store(
            &existing,
            std::path::Path::new("/home/test/.station-root"),
            "http://127.0.0.1:28141".to_string(),
            "desktop-sidecar-42".to_string(),
            "/home/test/.station-beta".to_string(),
            28141,
            28000,
            123.0,
        );
        assert_eq!(owner_name, "local-2");
        assert_eq!(reconciled.default_profile.as_deref(), Some("local"));
        assert_eq!(reconciled.profiles.len(), 3);
        assert_eq!(reconciled.profiles[0].name, "local");
        assert_eq!(
            reconciled.profiles[1].credential_ref.as_ref().unwrap().id,
            "remote-token"
        );
        let bundled = reconciled
            .profiles
            .iter()
            .find(|profile| profile.name == "local-2")
            .expect("new bundled profile");
        assert_eq!(bundled.endpoint, "http://127.0.0.1:28141");
        assert!(bundled.credential_ref.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn bundled_sidecar_reuses_an_owner_reached_through_an_ancestor_alias() {
        use std::os::unix::fs::symlink;

        let parent = tempfile::tempdir().unwrap();
        let station_root = parent.path().join("root");
        let real_parent = parent.path().join("real");
        let runtime = real_parent.join("instances/beta");
        std::fs::create_dir(&station_root).unwrap();
        std::fs::create_dir(&real_parent).unwrap();
        std::fs::create_dir_all(&runtime).unwrap();
        let alias = parent.path().join("alias");
        symlink(&real_parent, &alias).unwrap();
        let aliased_runtime = alias.join("instances/beta");
        let current = parse_station_profile_store(
            &serde_json::json!({
                "schemaVersion": 1,
                "revision": 4,
                "defaultProfile": "remote",
                "projectProfiles": {},
                "profiles": [{
                    "schemaVersion": 1,
                    "name": "beta-owner",
                    "endpoint": "http://127.0.0.1:28141",
                    "setupSource": "local",
                    "configurationState": "configured",
                    "localService": {
                        "instanceId": "old-beta",
                        "baseDir": aliased_runtime,
                        "serverPort": 28141,
                        "uiPort": 28000
                    },
                    "createdAt": 1,
                    "updatedAt": 1
                }, {
                    "schemaVersion": 1,
                    "name": "remote",
                    "endpoint": "https://remote.example.test",
                    "setupSource": "paired",
                    "configurationState": "configured",
                    "createdAt": 1,
                    "updatedAt": 1
                }]
            })
            .to_string(),
        )
        .unwrap();

        let (next, owner_name) = reconciled_bundled_local_profile_store(
            &current,
            &station_root,
            "http://127.0.0.1:28141".into(),
            "current-beta".into(),
            runtime.to_string_lossy().into_owned(),
            28141,
            28000,
            2.0,
        );

        assert_eq!(owner_name, "beta-owner");
        assert_eq!(next.default_profile.as_deref(), Some("remote"));
        assert_eq!(next.profiles.len(), 2);
    }

    #[test]
    fn bundled_sidecar_reconciles_a_stale_same_origin_default_without_merging_credentials() {
        let current = parse_station_profile_store(
            r#"{
              "schemaVersion":1,"revision":7,"defaultProfile":"local","projectProfiles":{},
              "profiles":[
                {"schemaVersion":1,"name":"local","endpoint":"http://127.0.0.1:28141","credentialRef":{"kind":"station-bearer","id":"shared-local-token"},"environmentId":"shared-local-environment","setupSource":"paired","configurationState":"configured","createdAt":1,"updatedAt":1},
                {"schemaVersion":1,"name":"old-bundled","endpoint":"http://127.0.0.1:28141","credentialRef":{"kind":"station-bearer","id":"local-grant:existing"},"environmentId":"bundled-local-environment","clientInstanceId":"00000000-0000-4000-8000-000000000000","setupSource":"local","configurationState":"configured","localService":{"instanceId":"old","baseDir":"/home/test/.station-nightly","serverPort":28141,"uiPort":28000},"createdAt":2,"updatedAt":2}
              ]
            }"#,
        )
        .unwrap();

        let (next, owner_name) = reconciled_bundled_local_profile_store(
            &current,
            std::path::Path::new("/home/test/.station-root"),
            "http://127.0.0.1:28141".to_string(),
            "desktop-sidecar-42".to_string(),
            "/home/test/.station-nightly".to_string(),
            28141,
            28000,
            123.0,
        );

        assert_eq!(owner_name, "old-bundled");
        assert_eq!(next.default_profile.as_deref(), Some("local"));
        assert_eq!(next.revision, 8);
        let bundled = next
            .profiles
            .iter()
            .find(|profile| profile.name == "old-bundled")
            .expect("locally provisioned bundled profile survives");
        assert_eq!(
            bundled.credential_ref.as_ref().unwrap().id,
            "local-grant:existing"
        );
        assert_eq!(
            bundled._environment_id.as_deref(),
            Some("bundled-local-environment")
        );
        assert_eq!(
            bundled.local_service.as_ref().unwrap().instance_id,
            "desktop-sidecar-42"
        );
        let remote = next
            .profiles
            .iter()
            .find(|profile| profile.name == "local")
            .expect("credential-bearing same-origin profile survives");
        assert_eq!(
            remote.credential_ref.as_ref().unwrap().id,
            "shared-local-token"
        );
        assert_eq!(
            remote._environment_id.as_deref(),
            Some("shared-local-environment")
        );

        // A later sidecar generation retains the explicit bundled owner and
        // advances only its host-owned lifecycle identity. It never returns
        // to the same-origin paired default or changes the local credential.
        let (relaunch, relaunch_owner) = reconciled_bundled_local_profile_store(
            &next,
            std::path::Path::new("/home/test/.station-root"),
            "http://127.0.0.1:28141".to_string(),
            "desktop-sidecar-99".to_string(),
            "/home/test/.station-nightly".to_string(),
            28141,
            28000,
            456.0,
        );
        assert_eq!(relaunch_owner, "old-bundled");
        assert_eq!(relaunch.revision, next.revision + 1);
        assert_eq!(
            relaunch
                .profiles
                .iter()
                .find(|profile| profile.name == "old-bundled")
                .and_then(|profile| profile.local_service.as_ref())
                .map(|service| service.instance_id.as_str()),
            Some("desktop-sidecar-99")
        );
    }

    #[test]
    fn bundled_profile_ui_port_preserves_explicit_runtime_precedence() {
        assert_eq!(
            resolve_bundled_profile_ui_port(Some("5274"), Some("stable")),
            Some(5274)
        );
        assert_eq!(
            resolve_bundled_profile_ui_port(None, Some("stable")),
            Some(18000)
        );
        assert_eq!(
            resolve_bundled_profile_ui_port(Some("invalid"), Some("beta")),
            Some(28000)
        );
    }

    #[test]
    fn profile_already_locally_provisioned_requires_a_credential_ref_and_configured() {
        let store = local_self_provision_fixture_store();
        let local = store
            .profiles
            .iter()
            .find(|profile| profile.name == "local")
            .unwrap();
        // THE regression case: the real `station setup local` output — no
        // credentialRef, already "configured" — must read as NOT yet
        // provisioned, or the boot-time effect never fires (station#1715
        // live-boot bug: it originally read this as "done, skip it"). This
        // short-circuits before any keychain read (no `credential_ref` to
        // even look up), so it stays a pure, deterministic test.
        assert!(!profile_already_locally_provisioned(local, |_| {
            CredentialReadOutcome::Readable
        }));

        // A credential_ref stranded at requires-auth (an interrupted
        // attempt) is never trusted as "done" either — must stay eligible
        // for a retry. This ALSO short-circuits before any keychain read
        // (the configuration_state gate runs first).
        let mut stranded = local.clone();
        stranded.credential_ref = Some(NativeCredentialReference {
            kind: "station-bearer".to_string(),
            id: "local-grant:stranded".to_string(),
        });
        stranded.configuration_state = "requires-auth".to_string();
        assert!(!profile_already_locally_provisioned(&stranded, |_| {
            CredentialReadOutcome::Readable
        }));
    }

    /// station#1818 — THE regression this whole fix exists to prove: a
    /// profile whose `credentialRef` is recorded and `configurationState`
    /// is `"configured"` (exactly what a stranded profile looks like after
    /// a nightly bundle swap invalidates its keychain ACL) must now read as
    /// NOT provisioned when the credential cannot actually be read back —
    /// the opposite of what this file asserted before this fix. The profile
    /// seam injects `Absent` so the test never depends on a developer or CI
    /// keychain, while still proving that the exact recorded reference is
    /// consulted once.
    #[test]
    fn profile_already_locally_provisioned_observes_an_absent_credential_as_not_provisioned() {
        let store = local_self_provision_fixture_store();
        let local = store
            .profiles
            .iter()
            .find(|profile| profile.name == "local")
            .unwrap();
        let mut with_unwritten_credential = local.clone();
        with_unwritten_credential.credential_ref = Some(NativeCredentialReference {
            kind: "station-bearer".to_string(),
            id: "local-grant:station-1818-eligibility-probe".to_string(),
        });
        let expected_reference = with_unwritten_credential.credential_ref.clone().unwrap();
        let mut consulted_references = Vec::new();

        assert!(!profile_already_locally_provisioned(
            &with_unwritten_credential,
            |reference| {
                consulted_references.push(reference.clone());
                CredentialReadOutcome::Absent
            },
        ));
        assert_eq!(consulted_references, vec![expected_reference]);
    }

    #[test]
    fn profile_already_locally_provisioned_applies_store_and_stale_item_outcomes() {
        let store = local_self_provision_fixture_store();
        let local = store
            .profiles
            .iter()
            .find(|profile| profile.name == "local")
            .unwrap();
        let mut configured_with_credential = local.clone();
        configured_with_credential.credential_ref = Some(NativeCredentialReference {
            kind: "station-bearer".to_string(),
            id: "local-grant:outcome-reducer".to_string(),
        });

        assert!(profile_already_locally_provisioned(
            &configured_with_credential,
            |_| CredentialReadOutcome::StoreUnavailable,
        ));
        assert!(!profile_already_locally_provisioned(
            &configured_with_credential,
            |_| CredentialReadOutcome::StaleItemAccess,
        ));
    }

    /// Local keychain readability is only the first gate. A readable item
    /// always proceeds to the server-owned authority probe; no remembered
    /// 401/403 can send it directly to the replacement exchange.
    #[test]
    fn readable_credential_reaches_authority_probe_without_auth_rejection_bypass() {
        assert!(credential_provisioned_from_read_outcome(
            CredentialReadOutcome::Readable,
        ));
        // A transiently unavailable store remains fail-closed: do not mint
        // another grant beside an item we cannot inspect.
        assert!(credential_provisioned_from_read_outcome(
            CredentialReadOutcome::StoreUnavailable,
        ));
        // An absent credential has no bearer to probe and may use the first
        // provisioning path instead.
        assert!(!credential_provisioned_from_read_outcome(
            CredentialReadOutcome::Absent,
        ));
        // A signature/ACL-invalidated item is the one platform refusal that
        // is eligible for one local replacement; it is not a store outage.
        assert!(!credential_provisioned_from_read_outcome(
            CredentialReadOutcome::StaleItemAccess,
        ));
    }

    #[test]
    fn local_credential_probe_requires_server_bound_local_grant_eligibility() {
        assert_eq!(
            classify_local_credential_probe(Ok((200, r#"{"eligible":true}"#))),
            LocalCredentialProbeOutcome::Eligible
        );
        // The pre-#3677 desktop bearer is still accepted by the ordinary auth
        // boundary, but its registry record lacks both mint-time facts. Only
        // this explicit server answer may trigger the owner-secret exchange.
        assert_eq!(
            classify_local_credential_probe(Ok((200, r#"{"eligible":false}"#))),
            LocalCredentialProbeOutcome::Ineligible
        );
        // A stale 401/403 observation is deliberately NOT authority evidence
        // and therefore cannot bypass the strict `{eligible:false}` result.
        assert_eq!(
            classify_local_credential_probe(Ok((401, ""))),
            LocalCredentialProbeOutcome::Inconclusive
        );
        assert_eq!(
            classify_local_credential_probe(Ok((403, ""))),
            LocalCredentialProbeOutcome::Inconclusive
        );
        // A server fault, unknown route, malformed response, or transport
        // timeout must never replace a readable credential or supersede its
        // server grant.
        assert_eq!(
            classify_local_credential_probe(Ok((200, r#"{"authenticated":true}"#))),
            LocalCredentialProbeOutcome::Inconclusive
        );
        assert_eq!(
            classify_local_credential_probe(Ok((500, ""))),
            LocalCredentialProbeOutcome::Inconclusive
        );
        assert_eq!(
            classify_local_credential_probe(Ok((404, ""))),
            LocalCredentialProbeOutcome::Inconclusive
        );
        assert_eq!(
            classify_local_credential_probe(Err(())),
            LocalCredentialProbeOutcome::Inconclusive
        );
        assert!(!readable_local_credential_needs_reprovision(
            LocalCredentialProbeOutcome::Eligible
        ));
        assert!(readable_local_credential_needs_reprovision(
            LocalCredentialProbeOutcome::Ineligible
        ));
        assert!(!readable_local_credential_needs_reprovision(
            LocalCredentialProbeOutcome::Inconclusive
        ));
        let exchange_count = |outcome| {
            let mut exchanges = 0;
            let mut observed_client_instance_id = None;
            let result = exchange_after_readable_credential_probe(
                outcome,
                "11111111-1111-4111-8111-111111111111",
                |client_instance_id| {
                    // This represents the sole local-grant exchange/supersession
                    // call; retain/refuse must never enter it.
                    exchanges += 1;
                    observed_client_instance_id = Some(client_instance_id.to_string());
                },
            );
            assert_eq!(
                result.is_ok(),
                outcome == LocalCredentialProbeOutcome::Ineligible
            );
            assert_eq!(
                observed_client_instance_id.as_deref(),
                (outcome == LocalCredentialProbeOutcome::Ineligible)
                    .then_some("11111111-1111-4111-8111-111111111111")
            );
            exchanges
        };
        assert_eq!(exchange_count(LocalCredentialProbeOutcome::Eligible), 0);
        assert_eq!(exchange_count(LocalCredentialProbeOutcome::Ineligible), 1);
        assert_eq!(exchange_count(LocalCredentialProbeOutcome::Inconclusive), 0);
        // First repair mints exactly one current grant; the immediate retry
        // sees the new eligible credential and must not rotate it again.
        let mut exchanges = 0;
        for outcome in [
            LocalCredentialProbeOutcome::Ineligible,
            LocalCredentialProbeOutcome::Eligible,
        ] {
            let _ = exchange_after_readable_credential_probe(
                outcome,
                "11111111-1111-4111-8111-111111111111",
                |_| exchanges += 1,
            );
        }
        assert_eq!(exchanges, 1);
    }

    /// The taxonomy decision (station#1818's hardest part), tested through
    /// the explicit injected-outcome seam described on
    /// `classify_credential_read_result` — every `keyring_core::Error`
    /// variant this function's real callers can produce, without touching a
    /// real keychain.
    #[test]
    fn classify_credential_read_result_recovers_only_item_acl_refusals() {
        assert_eq!(
            classify_credential_read_result(Ok("secret".to_string())),
            CredentialReadOutcome::Readable
        );
        assert_eq!(
            classify_credential_read_result(Err(keyring_core::Error::NoEntry)),
            CredentialReadOutcome::Absent
        );
        // The explicit "store is locked/unavailable" family — must NOT read
        // as absent, or a merely-locked keychain would mint a redundant
        // credential instead of waiting for the transient condition to
        // clear.
        assert_eq!(
            classify_credential_read_result(Err(keyring_core::Error::NoStorageAccess(Box::new(
                std::io::Error::other("keychain is locked")
            )))),
            CredentialReadOutcome::StoreUnavailable
        );
        // Non-macOS / unknown boxed PlatformFailure values fail closed even
        // when their display text happens to look like an OSStatus. The
        // production macOS branch downcasts a concrete Security error below.
        assert_eq!(
            classify_credential_read_result(Err(keyring_core::Error::PlatformFailure(Box::new(
                std::io::Error::other("errSecAuthFailed (-25293)")
            )))),
            CredentialReadOutcome::StoreUnavailable
        );
        // A platform failure without that closed access-control signal can be
        // a corrupt keychain or a transient OS failure. It must fail closed,
        // never mint another full-scope server grant.
        assert_eq!(
            classify_credential_read_result(Err(keyring_core::Error::PlatformFailure(Box::new(
                std::io::Error::other("keychain database corrupt")
            )))),
            CredentialReadOutcome::StoreUnavailable
        );
        // `errSecInteractionNotAllowed` is a locked Keychain, and a missing
        // entitlement is process-wide. Neither is evidence of a stale item
        // ACL, so both must fail closed rather than revoke/supersede a grant.
        for detail in [
            "errSecInteractionNotAllowed (-25308)",
            "errSecMissingEntitlement (-34018)",
        ] {
            assert_eq!(
                classify_credential_read_result(Err(keyring_core::Error::PlatformFailure(
                    Box::new(std::io::Error::other(detail))
                ))),
                CredentialReadOutcome::StoreUnavailable
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn classify_credential_read_result_reads_concrete_macos_status_codes() {
        let outcome_for = |code| {
            classify_credential_read_result(Err(keyring_core::Error::PlatformFailure(Box::new(
                security_framework::base::Error::from_code(code),
            ))))
        };
        // The exact per-item ACL refusal caused by an ad-hoc signature swap.
        assert_eq!(outcome_for(-25293), CredentialReadOutcome::StaleItemAccess);
        // Locked Keychain and missing entitlement are process/store failures,
        // never reasons to supersede a credential before attempting a write.
        assert_eq!(outcome_for(-25308), CredentialReadOutcome::StoreUnavailable);
        assert_eq!(outcome_for(-34018), CredentialReadOutcome::StoreUnavailable);
    }

    /// station#1818 R3 review round 1 (MEDIUM) — the persisted replacement
    /// for the derived id: reuses an EXISTING `client_instance_id` verbatim,
    /// mints a fresh one only when the profile has none yet. This is the
    /// fault-injection proof for the reuse half: reverting the production
    /// change back to always minting `uuid::Uuid::new_v4()` makes two calls
    /// against the SAME already-provisioned profile disagree with
    /// overwhelming probability (a random UUID v4 colliding with another is
    /// a 2^-122 event), which is exactly what this test asserts does NOT
    /// happen once a profile already carries one.
    #[test]
    fn resolve_local_self_provision_client_instance_id_reuses_or_mints() {
        let mut store = local_self_provision_fixture_store();
        let local_profile = store
            .profiles
            .iter_mut()
            .find(|profile| profile.name == "local")
            .unwrap();

        // No persisted id yet (a brand-new local install, or a profiles.json
        // written before this field existed): a fresh id is minted.
        assert!(local_profile.client_instance_id.is_none());
        let minted = resolve_local_self_provision_client_instance_id(local_profile);
        assert!(!minted.is_empty());

        // Once persisted, it is reused byte-for-byte on every subsequent
        // call — this is what lets the server's `clientInstanceId`-keyed
        // supersession actually match a PRIOR grant instead of drifting.
        local_profile.client_instance_id = Some(minted.clone());
        let reused = resolve_local_self_provision_client_instance_id(local_profile);
        assert_eq!(reused, minted);
        let reused_again = resolve_local_self_provision_client_instance_id(local_profile);
        assert_eq!(reused_again, minted);
    }

    #[test]
    fn local_self_provision_next_store_upserts_only_the_named_profile() {
        let current = local_self_provision_fixture_store();
        let reference = NativeCredentialReference {
            kind: "station-bearer".to_string(),
            id: "local-grant:test".to_string(),
        };
        let contents = local_self_provision_next_store(
            &current,
            current.revision + 1,
            "local",
            &reference,
            "environment-local",
            "requires-auth",
            12_345.0,
            "11111111-1111-4111-8111-111111111111",
        )
        .unwrap();
        let next = parse_station_profile_store(&contents).unwrap();

        assert_eq!(next.revision, current.revision + 1);
        // Untouched profile, byte-for-byte on every field this function could
        // have (but must not) touched.
        let remote = next.profiles.iter().find(|p| p.name == "remote").unwrap();
        assert_eq!(remote.configuration_state, "configured");
        assert_eq!(remote.credential_ref.as_ref().unwrap().id, "remote-token");
        assert_eq!(
            remote._environment_id.as_deref(),
            Some("environment-remote")
        );
        assert!(remote.client_instance_id.is_none());
        // default_profile carried through verbatim.
        assert_eq!(next.default_profile.as_deref(), Some("local"));

        let local = next.profiles.iter().find(|p| p.name == "local").unwrap();
        assert_eq!(local.configuration_state, "requires-auth");
        assert_eq!(local.credential_ref.as_ref().unwrap(), &reference);
        assert_eq!(local._environment_id.as_deref(), Some("environment-local"));
        assert_eq!(local.updated_at, 12_345.0);
        // station#1818 R3 review round 1 (MEDIUM) — THE persistence proof:
        // the id this call was given is what actually lands in the
        // serialized document, round-trip through JSON.
        assert_eq!(
            local.client_instance_id.as_deref(),
            Some("11111111-1111-4111-8111-111111111111")
        );
        // setupSource and localService both carried through verbatim — this
        // function must never turn a local install into something else.
        assert_eq!(local.setup_source, "local");
        assert!(local.local_service.is_some());
    }

    #[test]
    fn local_self_provision_next_store_errors_on_an_unknown_profile_name() {
        let current = local_self_provision_fixture_store();
        let reference = NativeCredentialReference {
            kind: "station-bearer".to_string(),
            id: "local-grant:test".to_string(),
        };
        assert!(local_self_provision_next_store(
            &current,
            current.revision + 1,
            "does-not-exist",
            &reference,
            "environment-local",
            "requires-auth",
            1.0,
            "11111111-1111-4111-8111-111111111111",
        )
        .is_err());
    }

    #[test]
    fn native_broker_limits_and_semantic_headers_match_the_desktop_contract() {
        assert_eq!(NATIVE_HTTP_BODY_LIMIT, 24 * 1024 * 1024);
        assert!(native_header_allowlisted("x-station-plugin"));
        assert!(native_header_allowlisted("x-abort-reason"));
        assert!(native_header_allowlisted("X-Station-Client-Origin"));
        assert!(!native_header_allowlisted("authorization"));
        assert!(!native_header_allowlisted("cookie"));
        assert!(!native_header_allowlisted("x-station-device-id"));
        assert!(NATIVE_HTTP_PER_ORIGIN_REQUEST_LIMIT < NATIVE_HTTP_GLOBAL_REQUEST_LIMIT);
    }

    #[test]
    fn native_broker_preserves_http_error_statuses() {
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0_u8; 1024];
            let _ = socket.read(&mut request).unwrap();
            socket
                .write_all(
                    b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                )
                .unwrap();
        });
        let request = ureq::http::Request::builder()
            .method("GET")
            .uri(format!("http://{address}/protected"))
            .body(Vec::<u8>::new())
            .unwrap();

        let response = native_http_agent().run(request).unwrap();

        assert_eq!(response.status().as_u16(), 401);
        server.join().unwrap();
    }

    #[test]
    fn native_broker_keeps_actionable_request_transport_detail() {
        let refused = ureq::Error::Io(std::io::Error::from(std::io::ErrorKind::ConnectionRefused));

        assert_eq!(
            native_request_transport_detail(&ureq::Error::HostNotFound).code,
            "transport_dns"
        );
        assert_eq!(
            native_request_transport_detail(&refused).code,
            "transport_refused"
        );
        assert_eq!(
            native_request_transport_detail(&refused).detail,
            "Station refused the connection."
        );
    }

    #[test]
    fn native_broker_identifies_midstream_termination() {
        assert_eq!(
            native_response_transport_detail(&std::io::Error::from(
                std::io::ErrorKind::ConnectionReset,
            ))
            .code,
            "transport_reset"
        );
        assert_eq!(
            native_response_transport_detail(&std::io::Error::from(
                std::io::ErrorKind::UnexpectedEof,
            ))
            .code,
            "transport_reset"
        );
    }

    #[test]
    fn native_http_response_serializes_the_webview_bridge_contract() {
        let message = NativeHttpMessage::Response {
            status: 200,
            headers: std::collections::HashMap::new(),
            body_length: Some(17),
        };

        assert_eq!(
            serde_json::to_value(message).expect("native HTTP response serializes"),
            serde_json::json!({
                "type": "response",
                "status": 200,
                "headers": {},
                "bodyLength": 17,
            })
        );
    }

    #[test]
    fn native_broker_keeps_sse_open_ended_but_bounds_ordinary_responses() {
        let mut sse = ureq::http::HeaderMap::new();
        sse.insert(
            "content-type",
            "text/event-stream; charset=utf-8".parse().unwrap(),
        );
        let mut json = ureq::http::HeaderMap::new();
        json.insert("content-type", "application/json".parse().unwrap());

        assert!(native_response_is_open_stream(&sse));
        assert!(!native_response_is_open_stream(&json));
    }

    #[test]
    fn capability_report_identifies_the_compile_target() {
        let report = compile_target_capability_report("io.kontourai.station");

        assert_eq!(report.platform, compile_target_platform());
        assert_ne!(report.platform, "unknown");
    }

    #[test]
    fn capability_report_channel_comes_from_trusted_native_identity() {
        assert_eq!(native_app_channel("io.kontourai.station", false), "stable");
        assert_eq!(
            native_app_channel("io.kontourai.station.beta", false),
            "beta"
        );
        assert_eq!(
            native_app_channel("io.kontourai.station.nightly", false),
            "nightly"
        );
        assert_eq!(native_app_channel("io.kontourai.station.beta", true), "dev");
        assert_eq!(
            pairing_deep_link_channels_generated::native_pairing_deep_link_scheme(
                "io.kontourai.station.dev.dev.release.7",
                true,
                "dev",
            ),
            "station-dev-dev-release-7",
        );
    }

    #[test]
    fn mobile_build_default_accepts_only_a_secret_free_https_origin() {
        assert_eq!(
            trusted_mobile_default_endpoint(Some(" https://station.example.test:8442/ ")),
            Some("https://station.example.test:8442".to_string())
        );
        for rejected in [
            "tauri://localhost",
            "http://100.64.0.1:28141",
            "https://user:secret@station.example.test",
            "https://station.example.test/path",
            "https://station.example.test/?channel=beta",
            "https://station.example.test/#beta",
        ] {
            assert_eq!(trusted_mobile_default_endpoint(Some(rejected)), None);
        }
        assert_eq!(trusted_mobile_default_endpoint(None), None);
    }

    #[test]
    fn capability_report_makes_station_enablement_explicit() {
        let report = compile_target_capability_report("io.kontourai.station");
        let states = report
            .capabilities
            .iter()
            .map(|capability| (capability.id, capability.state))
            .collect::<Vec<_>>();

        assert!(states.contains(&("capability-report", "enabled")));
        assert!(states.contains(&("host-event-bridge", "enabled")));
        assert!(states.contains(&("share-intake", "disabled")));
        assert!(states.contains(&("pairing-deep-link", "enabled")));
        #[cfg(mobile)]
        assert!(states.contains(&("local-browser-preview", "unsupported")));
        #[cfg(not(mobile))]
        assert!(states.contains(&("local-browser-preview", "enabled")));
        #[cfg(mobile)]
        assert!(states.contains(&("workspace-pane-pop-out", "unsupported")));
        #[cfg(not(mobile))]
        assert!(states.contains(&("workspace-pane-pop-out", "enabled")));
        #[cfg(mobile)]
        assert!(states.contains(&("desktop-tray", "unsupported")));
        #[cfg(not(mobile))]
        assert!(states.contains(&("desktop-tray", "enabled")));
        #[cfg(mobile)]
        assert!(states.contains(&("haptics", "enabled")));
        #[cfg(not(mobile))]
        assert!(states.contains(&("haptics", "unsupported")));
        assert!(states.contains(&("remote-push", "unsupported")));
    }

    #[cfg(not(mobile))]
    #[test]
    fn local_browser_preview_authority_revalidates_loopback_urls_before_opening() {
        let mut opened = None;
        open_local_browser_preview_with("http://127.0.0.1:5173", |url| {
            opened = Some(url.to_owned());
            Ok(())
        })
        .unwrap();
        assert_eq!(opened.as_deref(), Some("http://127.0.0.1:5173/"));

        for rejected in [
            "http://user:secret@127.0.0.1:5173/",
            "https://example.com/",
            "http://127.0.0.1:5173/#fragment",
        ] {
            assert!(normalize_local_browser_preview_url(rejected).is_err());
        }
    }

    #[cfg(not(mobile))]
    #[test]
    fn workspace_pane_pop_out_route_preserves_exact_identity_without_window_state() {
        let route = workspace_pane_pop_out_route(&NativeWorkspacePanePopOutRequest {
            project_id: "project uuid".to_string(),
            project_slug: "project/route".to_string(),
            layout_id: "coding layout".to_string(),
            descriptor_id: "pane:code/editor".to_string(),
            instance_id: "instance?one".to_string(),
        })
        .unwrap();

        assert_eq!(
            route,
            "/projects/project%2Froute/layouts/coding%20layout/panes/pane%3Acode%2Feditor/instance%3Fone?projectId=project%20uuid"
        );
        assert!(
            workspace_pane_pop_out_route(&NativeWorkspacePanePopOutRequest {
                project_id: " ".to_string(),
                project_slug: "project".to_string(),
                layout_id: "coding".to_string(),
                descriptor_id: "pane:coding".to_string(),
                instance_id: "instance".to_string(),
            })
            .is_err()
        );
    }

    #[cfg(not(mobile))]
    #[test]
    fn local_browser_preview_authority_returns_opener_failure() {
        let error = open_local_browser_preview_with("http://localhost:5173/", |_| {
            Err("no system browser is available".to_owned())
        })
        .unwrap_err();
        assert!(error.contains("could not open the local preview"));
        assert!(error.contains("no system browser is available"));
    }

    #[cfg(not(mobile))]
    #[test]
    fn native_browser_preview_discovery_observes_only_bounded_loopback_tcp() {
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let reachable =
            url::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let observation = discover_browser_preview_target(&reachable);
        assert_eq!(observation.reachability, "reachable");
        assert_eq!(observation.tls, "not-applicable");
        assert_eq!(observation.navigation, "not-observed");
        assert_eq!(observation.frame, "not-applicable");
        assert_eq!(observation.renderer, "not-created");
        assert_eq!(observation.title, "not-observable");
        assert_eq!(observation.history, "not-observable");

        // A freed ephemeral port is only refused while nothing rebinds it, and
        // under a concurrent suite run a sibling test's `bind("127.0.0.1:0")`
        // can land on the just-freed port before the probe connects (observed
        // live: station#3043). Retry with a fresh port on that collision; a
        // broken discovery that reports every closed port as reachable still
        // exhausts every attempt and fails.
        let mut last_reachability = "";
        let refused_observed = (0..5).any(|_| {
            let refused_address = {
                let listener = TcpListener::bind("127.0.0.1:0").unwrap();
                listener.local_addr().unwrap()
            };
            let refused = url::Url::parse(&format!("http://{refused_address}/")).unwrap();
            last_reachability = discover_browser_preview_target(&refused).reachability;
            last_reachability == "refused"
        });
        assert!(
            refused_observed,
            "no freed loopback port observed as refused in 5 attempts; last reachability: {last_reachability}"
        );
    }

    #[cfg(not(mobile))]
    #[test]
    fn native_browser_preview_admission_requires_a_reachable_discovery_observation() {
        let grants = NativeBrowserPreviewGrants::default();
        let target = url::Url::parse("http://127.0.0.1:5173/").unwrap();
        assert!(matches!(
            issue_browser_preview_grant(
                target.as_str(),
                "http://127.0.0.1:3241/",
                UNIX_EPOCH,
                &grants,
                NativeBrowserPreviewObservation::pending(&target),
            ),
            NativeBrowserPreviewGrantResponse::Rejected {
                code: "target-unreachable",
                observation: Some(NativeBrowserPreviewObservation {
                    reachability: "not-observed",
                    ..
                }),
                ..
            }
        ));
    }

    #[cfg(not(mobile))]
    #[test]
    fn native_browser_preview_requires_literal_numeric_loopback_targets() {
        for accepted in [
            "http://127.0.0.1:5173/",
            "http://127.42.0.1:5173/",
            "http://[::1]:5173/",
        ] {
            let normalized = normalize_numeric_local_browser_preview_url(accepted).unwrap();
            let target = url::Url::parse(&normalized).unwrap();
            assert!(browser_preview_origin(&target).is_some());
            assert!(browser_preview_target_socket_addr(&target).is_some());
        }
        assert!(normalize_local_browser_preview_url("http://localhost:5173/").is_ok());
        let rejected =
            normalize_numeric_local_browser_preview_url("http://localhost:5173/").unwrap_err();
        assert!(rejected.contains("numeric loopback host"));
        assert!(rejected.contains("system-browser action"));
    }

    #[cfg(not(mobile))]
    #[test]
    fn native_browser_preview_grants_are_bound_one_time_and_expire() {
        let grants = NativeBrowserPreviewGrants::default();
        let now = UNIX_EPOCH + Duration::from_secs(1_000);
        let issued = issue_browser_preview_grant(
            "http://127.0.0.1:5173/app",
            "http://127.0.0.1:3241/",
            now,
            &grants,
            NativeBrowserPreviewObservation::with_reachability(
                &url::Url::parse("http://127.0.0.1:5173/app").unwrap(),
                "reachable",
            ),
        );
        let NativeBrowserPreviewGrantResponse::Issued { grant_id, .. } = issued else {
            panic!("expected an issued native grant");
        };

        let consumed = consume_browser_preview_grant(&grant_id, now, &grants).unwrap();
        assert_eq!(consumed.target.as_str(), "http://127.0.0.1:5173/app");
        assert_eq!(consumed.service_endpoint, "http://127.0.0.1:3241/");
        assert!(matches!(
            consume_browser_preview_grant(&grant_id, now, &grants),
            Err(NativeBrowserPreviewWindowResponse::Rejected {
                code: "grant-consumed",
                ..
            })
        ));

        let NativeBrowserPreviewGrantResponse::Issued {
            grant_id: expired_grant,
            ..
        } = issue_browser_preview_grant(
            "http://127.0.0.1:5173/app",
            "http://127.0.0.1:3241/",
            now,
            &grants,
            NativeBrowserPreviewObservation::with_reachability(
                &url::Url::parse("http://127.0.0.1:5173/app").unwrap(),
                "reachable",
            ),
        )
        else {
            panic!("expected an issued native grant");
        };
        assert!(matches!(
            consume_browser_preview_grant(
                &expired_grant,
                now + LOCAL_BROWSER_PREVIEW_GRANT_TTL,
                &grants,
            ),
            Err(NativeBrowserPreviewWindowResponse::Rejected {
                code: "grant-expired",
                ..
            })
        ));
    }

    #[cfg(not(mobile))]
    #[test]
    fn native_browser_preview_grant_cannot_be_retargeted_or_kept_after_close() {
        let grants = NativeBrowserPreviewGrants::default();
        let now = UNIX_EPOCH + Duration::from_secs(1_000);
        let NativeBrowserPreviewGrantResponse::Issued { grant_id, .. } =
            issue_browser_preview_grant(
                "http://127.0.0.1:5173/app",
                "http://127.0.0.1:3241/",
                now,
                &grants,
                NativeBrowserPreviewObservation::with_reachability(
                    &url::Url::parse("http://127.0.0.1:5173/app").unwrap(),
                    "reachable",
                ),
            )
        else {
            panic!("expected an issued native grant");
        };

        // The renderer command schema accepts only the opaque grant id; a
        // caller cannot append a replacement URL to re-target a grant.
        assert!(
            serde_json::from_value::<NativeBrowserPreviewWindowRequest>(serde_json::json!({
                "grantId": grant_id,
                "url": "http://127.0.0.1:4173/attacker"
            }))
            .is_err()
        );

        let grant = consume_browser_preview_grant(&grant_id, now, &grants).unwrap();
        let label = "browser-preview-test";
        bind_active_browser_preview_grant(label, grant, &grants);
        {
            let state = grants.0.lock().unwrap();
            let active = state.active.get(label).unwrap();
            assert_eq!(active.target.as_str(), "http://127.0.0.1:5173/app");
            assert_eq!(active.service_endpoint, "http://127.0.0.1:3241/");
        }
        // Issuing a later grant prunes only pending/consumed records. The
        // open preview keeps its native target+endpoint binding until close.
        let _ = issue_browser_preview_grant(
            "http://127.0.0.1:5173/next",
            "http://127.0.0.1:3241/",
            now + LOCAL_BROWSER_PREVIEW_GRANT_TTL,
            &grants,
            NativeBrowserPreviewObservation::with_reachability(
                &url::Url::parse("http://127.0.0.1:5173/next").unwrap(),
                "reachable",
            ),
        );
        assert!(grants.0.lock().unwrap().active.contains_key(label));
        close_active_browser_preview_grant(label, &grants);
        assert!(grants.0.lock().unwrap().active.get(label).is_none());

        assert!(matches!(
            issue_browser_preview_grant(
                "http://127.0.0.1:5173/",
                "https://station.example/",
                now,
                &grants,
                NativeBrowserPreviewObservation::with_reachability(
                    &url::Url::parse("http://127.0.0.1:5173/").unwrap(),
                    "reachable",
                ),
            ),
            NativeBrowserPreviewGrantResponse::Rejected {
                code: "authority-unavailable",
                ..
            }
        ));
    }

    #[cfg(not(mobile))]
    #[test]
    fn native_browser_preview_navigation_stays_on_the_exact_approved_loopback_origin() {
        let approved = url::Url::parse("http://127.0.0.1:5173/entry").unwrap();
        let origin = browser_preview_origin(&approved).unwrap();

        for allowed in [
            "http://127.0.0.1:5173/next",
            "http://127.0.0.1:5173/next#client-route",
        ] {
            assert!(browser_preview_navigation_allowed(
                &origin,
                &url::Url::parse(allowed).unwrap(),
            ));
        }
        for rejected in [
            "https://127.0.0.1:5173/next",
            "http://127.0.0.1:4173/next",
            "http://localhost:5173/next",
            "https://example.test/redirected",
            "http://user:secret@localhost:5173/next",
        ] {
            assert!(!browser_preview_navigation_allowed(
                &origin,
                &url::Url::parse(rejected).unwrap(),
            ));
        }
    }

    #[test]
    fn stale_profile_lock_reclamation_requires_a_valid_old_dead_owner_record() {
        let dead = |_| ProfileLockOwnerLiveness::Dead;
        let unavailable = |_| Ok(None);
        assert!(!profile_lock_record_reclaimable(
            ParsedStationProfileLockRecord::V1(LegacyStationProfileLockRecord {
                schema_version: 0,
                pid: 42,
                created_at: 0,
            }),
            true,
            &dead,
            &unavailable,
        )
        .unwrap());
        assert!(!profile_lock_record_reclaimable(
            ParsedStationProfileLockRecord::V1(LegacyStationProfileLockRecord {
                schema_version: 1,
                pid: 0,
                created_at: 0,
            }),
            true,
            &dead,
            &unavailable,
        )
        .unwrap());
        assert!(!profile_lock_record_reclaimable(
            ParsedStationProfileLockRecord::V1(LegacyStationProfileLockRecord {
                schema_version: 1,
                pid: 42,
                created_at: 0,
            }),
            false,
            &dead,
            &unavailable,
        )
        .unwrap());
        assert!(profile_lock_record_reclaimable(
            ParsedStationProfileLockRecord::V1(LegacyStationProfileLockRecord {
                schema_version: 1,
                pid: u32::MAX,
                created_at: 0,
            }),
            true,
            &dead,
            &unavailable,
        )
        .unwrap());
    }

    #[test]
    fn v2_profile_lock_reclamation_requires_death_or_proven_pid_reuse() {
        let alive = |_| ProfileLockOwnerLiveness::Alive;
        let dead = |_| ProfileLockOwnerLiveness::Dead;
        let ambiguous = |_| ProfileLockOwnerLiveness::Ambiguous;
        let exact = |_| Ok(Some("exact-birth".to_string()));
        let reused = |_| Ok(Some("new-birth".to_string()));
        let record = || {
            ParsedStationProfileLockRecord::V2(StationProfileLockRecord {
                schema_version: 2,
                pid: std::process::id(),
                birth: "exact-birth".to_string(),
                created_at: 0,
            })
        };
        assert!(!profile_lock_record_reclaimable(record(), false, &alive, &exact).unwrap());
        assert!(profile_lock_record_reclaimable(record(), false, &alive, &reused).unwrap());
        assert!(profile_lock_record_reclaimable(record(), false, &dead, &exact).unwrap());
        assert!(!profile_lock_record_reclaimable(record(), false, &ambiguous, &reused).unwrap());
    }

    #[test]
    fn mobile_profile_lock_protocol_stays_v1_and_birth_free() {
        let source = include_str!("lib.rs");
        let mobile_start = source
            .find("#[cfg(mobile)]\nfn lock_station_profiles_for_app(")
            .expect("mobile lock entry point is explicitly cfg-gated");
        let mobile_end = source[mobile_start..]
            .find("#[cfg(test)]\nfn lock_station_profiles(")
            .map(|offset| mobile_start + offset)
            .expect("mobile lock entry point ends before the test helper");
        let mobile_entry = &source[mobile_start..mobile_end];
        assert!(mobile_entry.contains("lock_station_profiles_legacy(path)"));
        assert!(!mobile_entry.contains("native_profile_lock_birth"));

        let legacy_start = source
            .find("fn legacy_profile_lock_record_bytes()")
            .expect("mobile v1 record writer exists");
        let legacy_end = source[legacy_start..]
            .find("fn lock_station_profiles_with_identity(")
            .map(|offset| legacy_start + offset)
            .expect("legacy record writer is bounded by the v2 writer");
        let legacy_writer = &source[legacy_start..legacy_end];
        assert!(legacy_writer.contains("schema_version: 1"));
        assert!(!legacy_writer.contains("birth"));
    }

    #[cfg(unix)]
    #[test]
    fn out_of_range_lock_owner_pids_are_not_reported_alive() {
        // pid_t is i32. Casting a recorded pid at or above 2^31 wraps
        // negative, and kill(-1, 0) is a BROADCAST that succeeds — which made
        // such a record read as permanently alive and wedged the lock
        // (station#2293). Anything that cannot be a positive pid_t is dead.
        assert!(!profile_lock_owner_alive(u32::MAX));
        // Not just -1: a value wrapping to another negative addresses a process
        // GROUP, which is a different question than "is this process alive".
        assert!(!profile_lock_owner_alive(u32::MAX - 5));
        assert!(!profile_lock_owner_alive(1 << 31));
        assert!(!profile_lock_owner_alive(0));

        // The probe still answers honestly for a pid that can identify a
        // process: this one is alive by construction.
        let self_pid = u32::try_from(std::process::id()).expect("own pid fits");
        assert!(profile_lock_owner_alive(self_pid));
    }

    #[cfg(unix)]
    #[test]
    fn unix_profile_lock_liveness_only_treats_esrch_as_dead() {
        let calls = std::cell::Cell::new(0);
        let probe = |_: libc::pid_t| {
            calls.set(calls.get() + 1);
            Err(libc::EPERM)
        };
        assert_eq!(
            profile_lock_owner_liveness_from_probe(42, &probe),
            ProfileLockOwnerLiveness::Ambiguous
        );
        assert_eq!(calls.get(), 1);
        assert_eq!(
            profile_lock_owner_liveness_from_probe(42, &|_| Err(libc::ESRCH)),
            ProfileLockOwnerLiveness::Dead
        );
        assert_eq!(
            profile_lock_owner_liveness_from_probe(42, &|_| Ok(())),
            ProfileLockOwnerLiveness::Alive
        );
        // Invalid values are rejected before the probe can run.
        assert_eq!(
            profile_lock_owner_liveness_from_probe(0, &|_| panic!("must not probe")),
            ProfileLockOwnerLiveness::Dead
        );
    }

    #[cfg(unix)]
    #[test]
    fn stale_dead_profile_lock_is_reclaimed_once_before_acquisition_retries() {
        use std::os::unix::fs::PermissionsExt;

        let directory = std::env::temp_dir().join(format!(
            "station-profile-lock-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let profile_path = directory.join("profiles.json");
        let lock_path = profile_path.with_extension("json.lock");
        std::fs::write(
            &lock_path,
            "{\"schemaVersion\":1,\"pid\":4294967295,\"createdAt\":0}\n",
        )
        .unwrap();
        std::fs::set_permissions(&lock_path, std::fs::Permissions::from_mode(0o600)).unwrap();

        let lock = lock_station_profiles(&profile_path).expect("reclaims stale lock");
        drop(lock);
        assert!(!lock_path.exists());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn stale_reclaim_guard_is_recovered_after_a_crash() {
        use std::os::unix::fs::PermissionsExt;

        let directory = std::env::temp_dir().join(format!(
            "station-profile-stale-reclaim-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let lock_path = directory.join("profiles.json.lock");
        let guard_path = profile_reclaim_guard_path(&lock_path).unwrap();
        std::fs::write(
            &guard_path,
            "{\"schemaVersion\":1,\"pid\":4294967295,\"createdAt\":0}\n",
        )
        .unwrap();
        std::fs::set_permissions(&guard_path, std::fs::Permissions::from_mode(0o600)).unwrap();

        let guard = acquire_profile_reclaim_guard(
            &lock_path,
            &|| profile_lock_record_bytes("test-process-birth"),
            &|_| Ok(None),
        )
        .unwrap()
        .expect("recovers the abandoned reclaim guard");
        drop(guard);
        assert!(!guard_path.exists());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn old_owner_only_partial_lock_records_are_reclaimed_under_the_guard() {
        use std::os::unix::fs::PermissionsExt;

        let directory = std::env::temp_dir().join(format!(
            "station-profile-partial-lock-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let profile_path = directory.join("profiles.json");
        let lock_path = profile_path.with_extension("json.lock");
        for contents in ["", "{\"schemaVersion\":1"] {
            std::fs::write(&lock_path, contents).unwrap();
            std::fs::set_permissions(&lock_path, std::fs::Permissions::from_mode(0o600)).unwrap();
            let file = std::fs::OpenOptions::new()
                .write(true)
                .open(&lock_path)
                .unwrap();
            file.set_times(std::fs::FileTimes::new().set_modified(
                SystemTime::now() - PROFILE_LOCK_STALE_AFTER - Duration::from_secs(1),
            ))
            .unwrap();
            drop(file);
            assert!(reclaim_stale_profile_lock(
                &lock_path,
                &|| profile_lock_record_bytes("test-process-birth"),
                &|_| Ok(None),
            )
            .unwrap());
            assert!(!lock_path.exists());
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn guarded_reclaimer_cannot_unlink_a_new_live_lock() {
        use std::os::unix::fs::PermissionsExt;

        let directory = std::env::temp_dir().join(format!(
            "station-profile-reclaim-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let profile_path = directory.join("profiles.json");
        let lock_path = profile_path.with_extension("json.lock");
        std::fs::write(
            &lock_path,
            "{\"schemaVersion\":1,\"pid\":4294967295,\"createdAt\":0}\n",
        )
        .unwrap();
        std::fs::set_permissions(&lock_path, std::fs::Permissions::from_mode(0o600)).unwrap();

        // This represents the first reclaimer after it won the exclusive guard
        // but before it releases it. A normal writer is still allowed to claim
        // the main lock after the stale predecessor has gone.
        let reclaim_guard = acquire_profile_reclaim_guard(
            &lock_path,
            &|| profile_lock_record_bytes("test-process-birth"),
            &|_| Ok(None),
        )
        .unwrap()
        .expect("first reclaimer owns the guard");
        let guard_path = profile_reclaim_guard_path(&lock_path).unwrap();
        let record: StationProfileLockRecord =
            serde_json::from_str(&std::fs::read_to_string(&guard_path).unwrap()).unwrap();
        assert_eq!(record.schema_version, 2);
        assert_eq!(record.pid, std::process::id());
        assert_eq!(record.birth, "test-process-birth");
        std::fs::remove_file(&lock_path).unwrap();
        let live_lock =
            lock_station_profiles(&profile_path).expect("normal writer acquires live lock");

        // A second reclaimer loses the guard before it can inspect or unlink
        // the current lock, so it cannot delete the new owner's lock record.
        assert!(!reclaim_stale_profile_lock(
            &lock_path,
            &|| profile_lock_record_bytes("test-process-birth"),
            &|_| Ok(None),
        )
        .unwrap());
        assert!(lock_path.exists());

        drop(live_lock);
        drop(reclaim_guard);
        assert!(!guard_path.exists());
        std::fs::remove_dir_all(directory).unwrap();
    }

    /// station#2502, cases the existing broker tests do not reach.
    ///
    /// `native_broker_keeps_actionable_request_transport_detail` already pins
    /// HostNotFound and ConnectionRefused, and
    /// `native_broker_identifies_midstream_termination` pins the stream path.
    /// These add the classes they do not cover, plus two invariants that are
    /// easy to lose silently.
    #[test]
    fn native_request_transport_detail_classifies_the_remaining_failure_classes() {
        use std::io::{Error as IoError, ErrorKind};

        let unreachable = native_request_transport_detail(&ureq::Error::Io(IoError::from(
            ErrorKind::NetworkUnreachable,
        )));
        assert_eq!(
            unreachable.code, "transport_unreachable",
            "an unreachable network must be emitted as transport_unreachable, not collapsed to the generic code"
        );

        let timed_out =
            native_request_transport_detail(&ureq::Error::Io(IoError::from(ErrorKind::TimedOut)));
        assert_eq!(
            timed_out.code, "transport_timeout",
            "a timed-out connection must be emitted as transport_timeout, not collapsed to the generic code"
        );
    }

    /// An unclassified error must still fall back to the generic code rather
    /// than inventing one — the fallback is what keeps the vocabulary honest.
    #[test]
    fn native_request_transport_detail_falls_back_for_unclassified_errors() {
        use std::io::{Error as IoError, ErrorKind};

        let other =
            native_request_transport_detail(&ureq::Error::Io(IoError::from(ErrorKind::Other)));
        assert_eq!(
            other.code, "transport",
            "an unclassified io error must fall back to the generic transport code"
        );
        assert!(
            !other.detail.is_empty(),
            "the generic fallback must still carry a human detail; a bare code is what this issue was about"
        );
    }

    /// The mid-stream path is a separate function and was separately capable of
    /// discarding the classification.
    #[test]
    fn native_response_transport_detail_classifies_stream_failures() {
        use std::io::{Error as IoError, ErrorKind};

        for kind in [ErrorKind::UnexpectedEof, ErrorKind::BrokenPipe] {
            let ended = native_response_transport_detail(&IoError::from(kind));
            assert_eq!(
                ended.code, "transport_reset",
                "a stream that ended early must be emitted as transport_reset, not collapsed to the generic code"
            );
        }

        let reset = native_response_transport_detail(&IoError::from(ErrorKind::ConnectionReset));
        assert_eq!(
            reset.code, "transport_reset",
            "a reset mid-stream must be emitted as transport_reset, not collapsed to the generic code"
        );
    }

    /// The detail is display text, and the CODE is the contract. This pins that
    /// they are distinct: no classified code may be inferable only from prose,
    /// which is the failure mode the TypeScript side used to have.
    #[test]
    fn every_classified_code_is_distinct_from_its_detail() {
        use std::io::{Error as IoError, ErrorKind};

        for (error, expected) in [
            (ErrorKind::ConnectionRefused, "transport_refused"),
            (ErrorKind::ConnectionReset, "transport_reset"),
            (ErrorKind::NetworkUnreachable, "transport_unreachable"),
            (ErrorKind::TimedOut, "transport_timeout"),
        ] {
            let classified =
                native_request_transport_detail(&ureq::Error::Io(IoError::from(error)));
            assert_eq!(classified.code, expected);
            assert!(
                !classified.detail.contains(classified.code),
                "the detail must not merely restate the code — they are different contracts, one for machines and one for people"
            );
        }
    }
}
