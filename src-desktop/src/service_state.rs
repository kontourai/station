//! Installed Station-service discovery and health checks used by the desktop tray.
//!
//! This module deliberately has no Tauri dependency so its manifest and state
//! machine behavior is unit-testable without launching a GUI process.

use crate::windows_path_trust::{self, TrustKind};
use serde::Deserialize;
use serde_json::Value;
use std::env;
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const INSTANCE_PROBE_TIMEOUT: Duration = Duration::from_millis(750);
const MAX_JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceManifest {
    pub host: String,
    pub instance_id: String,
    pub node_path: String,
    pub platform: String,
    pub repo_path: String,
    pub server_port: u16,
    pub ui_port: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResolvedLocalService {
    pub base_dir: PathBuf,
    pub manifest: ServiceManifest,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DefaultServiceResolution {
    Local(ResolvedLocalService),
    /// The selected Station still identifies a local service, but uninstall
    /// removed its bound manifest. This is ordinary setup-needed state, not a
    /// malformed profile and never a reason to guess another service.
    LocalManifestMissing(PathBuf),
    NoDefaultProfile,
    RemoteDefaultProfile,
    InvalidDefaultProfile(String),
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StationProfileStoreDocument {
    schema_version: u8,
    revision: u64,
    // `Option<Option<_>>` preserves the shared contract distinction: omitted
    // is invalid, while an explicit JSON null means no default is selected.
    default_profile: Option<Option<String>>,
    profiles: Vec<StationProfileDocument>,
    // Required even though service resolution does not select by project. Its
    // presence proves this is the current shared CLI/Desktop store contract.
    project_profiles: std::collections::HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StationProfileDocument {
    schema_version: u8,
    name: String,
    endpoint: String,
    credential_ref: Option<StationProfileCredentialRef>,
    environment_id: Option<String>,
    local_service: Option<StationProfileLocalService>,
    setup_source: String,
    configuration_state: String,
    created_at: f64,
    updated_at: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StationProfileCredentialRef {
    kind: String,
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StationProfileLocalService {
    instance_id: String,
    base_dir: String,
    server_port: u16,
    ui_port: u16,
}

fn valid_profile_store_document(store: &StationProfileStoreDocument) -> bool {
    let _ = store.revision;
    for profile in &store.profiles {
        let _ = &profile.environment_id;
    }
    if store.schema_version != 1
        || store.revision > MAX_JS_SAFE_INTEGER
        || store.default_profile.is_none()
        || store.profiles.iter().any(|profile| {
            profile.schema_version != 1
                || profile.name.is_empty()
                || profile.endpoint.is_empty()
                || !matches!(
                    profile.setup_source.as_str(),
                    "local" | "existing" | "hosted" | "paired" | "manual"
                )
                || !matches!(
                    profile.configuration_state.as_str(),
                    "configured" | "requires-auth" | "unconfigured"
                )
                || !profile.created_at.is_finite()
                || !profile.updated_at.is_finite()
                || profile.credential_ref.as_ref().is_some_and(|reference| {
                    reference.kind != "station-bearer" || reference.id.is_empty()
                })
                || profile.local_service.as_ref().is_some_and(|local| {
                    local.instance_id.is_empty()
                        || local.base_dir.is_empty()
                        || local.server_port == 0
                        || local.ui_port == 0
                })
        })
        || store
            .project_profiles
            .iter()
            .any(|(project, profile)| project.is_empty() || profile.is_empty())
    {
        return false;
    }
    let mut names = std::collections::HashSet::new();
    if store
        .profiles
        .iter()
        .any(|profile| !names.insert(profile.name.to_lowercase()))
    {
        return false;
    }
    let has_profile = |name: &str| names.contains(&name.to_lowercase());
    store
        .default_profile
        .as_ref()
        .is_some_and(|default| default.as_deref().is_none_or(has_profile))
        && store
            .project_profiles
            .values()
            .all(|profile| has_profile(profile))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdentityProbe {
    pub instance_id: Option<String>,
    pub outcome: ProbeOutcome,
    pub status: Option<u16>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProbeOutcome {
    Refused,
    Responded,
    Unknown,
}

impl IdentityProbe {
    pub fn refused() -> Self {
        Self {
            instance_id: None,
            outcome: ProbeOutcome::Refused,
            status: None,
        }
    }

    pub fn unknown() -> Self {
        Self {
            instance_id: None,
            outcome: ProbeOutcome::Unknown,
            status: None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServiceHealth {
    NotInstalled,
    Stopped,
    Running,
    Unhealthy,
}

impl ServiceHealth {
    pub fn label(self) -> &'static str {
        match self {
            Self::NotInstalled => "Not installed",
            Self::Stopped => "Stopped",
            Self::Running => "Running",
            Self::Unhealthy => "Unhealthy",
        }
    }

    pub fn poll_interval(self) -> Duration {
        match self {
            // The profile/default can be changed by the CLI while Desktop is
            // open, and the service can crash or recover outside this
            // process. Keep every state on the same short convergence loop.
            Self::NotInstalled | Self::Stopped | Self::Running | Self::Unhealthy => {
                Duration::from_secs(10)
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServiceAction {
    Start,
    Stop,
}

impl ServiceAction {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceCommand {
    pub args: Vec<String>,
    control_paths: Vec<(PathBuf, TrustKind)>,
    pub path: String,
    pub program: String,
}

pub fn resolve_station_home() -> PathBuf {
    resolve_station_home_for_channel(env::var_os("STATION_DESKTOP_CHANNEL").as_deref())
}

/// Shared client metadata is root-scoped. Runtime selection must never move
/// profiles, keyring references, or the selected default between channels.
pub fn resolve_station_root() -> PathBuf {
    station_root_from_env(
        env::var_os("STATION_ROOT"),
        env::var_os("STATION_HOME"),
        env::var_os("HOME"),
        env::var_os("USERPROFILE"),
        cfg!(windows),
    )
}

fn station_root_from_env(
    station_root: Option<std::ffi::OsString>,
    station_home: Option<std::ffi::OsString>,
    home: Option<std::ffi::OsString>,
    user_profile: Option<std::ffi::OsString>,
    is_windows: bool,
) -> PathBuf {
    let configured = station_root.filter(|path| !path.is_empty());
    let user_home = if is_windows {
        user_profile.or(home)
    } else {
        home
    };
    let root = configured
        .map(PathBuf::from)
        .or_else(|| {
            station_home
                .filter(|path| !path.is_empty())
                .map(PathBuf::from)
                .map(|home| {
                    let parent = home.parent();
                    if parent.and_then(Path::file_name) == Some(std::ffi::OsStr::new("instances")) {
                        return parent.and_then(Path::parent).unwrap_or(&home).to_path_buf();
                    }
                    if parent.and_then(Path::file_name) == Some(std::ffi::OsStr::new("dev"))
                        && parent.and_then(Path::parent).and_then(Path::file_name)
                            == Some(std::ffi::OsStr::new("instances"))
                    {
                        return parent
                            .and_then(Path::parent)
                            .and_then(Path::parent)
                            .unwrap_or(&home)
                            .to_path_buf();
                    }
                    home
                })
        })
        .unwrap_or_else(|| {
            user_home
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".station")
        });
    if root.is_absolute() {
        root
    } else {
        env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(root)
    }
}

/// The `STATION_ROOT` a spawned Station runtime must carry for `station_home`,
/// or `None` when it must be left UNSET.
///
/// Mirrors `spawnedStationRoot` in
/// `packages/shared/src/runtime-path-resolver.ts`, and exists for the same
/// reason: the runtime's admission guard allows `root == home` only when
/// `STATION_ROOT` is unset, because provenance is not observable from an
/// environment and absence is the only available proof that the root was
/// DERIVED from the home rather than being a foreign root the home would
/// swallow. A raw external `STATION_HOME` self-roots, so spelling the derived
/// value out makes the sidecar refuse to boot -- the crash this function
/// exists to prevent (#1108).
///
/// An operator-set `STATION_ROOT` is passed through unchanged, including when
/// it equals the home: that is the original escape, and it stays rejected.
pub fn spawned_station_root(
    station_root: &Path,
    station_home: &Path,
    explicit_station_root: Option<std::ffi::OsString>,
) -> Option<PathBuf> {
    if explicit_station_root
        .filter(|value| !value.is_empty())
        .is_some()
    {
        return Some(station_root.to_path_buf());
    }
    if station_root == station_home {
        return None;
    }
    Some(station_root.to_path_buf())
}

pub fn resolve_station_home_for_channel(channel: Option<&std::ffi::OsStr>) -> PathBuf {
    station_home_from_env(
        env::var_os("STATION_HOME"),
        env::var_os("STATION_ROOT"),
        env::var_os("HOME"),
        env::var_os("USERPROFILE"),
        cfg!(windows),
        channel,
    )
}

fn lexical_absolute(path: &Path) -> Result<PathBuf, String> {
    let source = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()
            .map_err(|error| format!("resolve current directory: {error}"))?
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for component in source.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(Path::new(std::path::MAIN_SEPARATOR_STR)),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(name) => normalized.push(name),
        }
    }
    Ok(normalized)
}

fn canonical_path_through_existing_ancestor(path: &Path) -> Result<PathBuf, String> {
    let requested = lexical_absolute(path)?;
    let mut cursor = requested.clone();
    let mut suffix = Vec::new();
    loop {
        match fs::symlink_metadata(&cursor) {
            Ok(_) => {
                let canonical = fs::canonicalize(&cursor).map_err(|error| {
                    format!(
                        "inspect runtime-home ancestor '{}': {error}",
                        cursor.display()
                    )
                })?;
                let metadata = fs::symlink_metadata(&canonical).map_err(|error| {
                    format!(
                        "inspect canonical runtime-home ancestor '{}': {error}",
                        canonical.display()
                    )
                })?;
                if !metadata.file_type().is_dir() {
                    return Err(format!(
                        "runtime-home ancestor '{}' is not a directory",
                        cursor.display()
                    ));
                }
                let mut resolved = canonical;
                for segment in suffix.iter().rev() {
                    resolved.push(segment);
                }
                return Ok(resolved);
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "inspect runtime-home ancestor '{}': {error}",
                    cursor.display()
                ));
            }
        }
        let name = cursor.file_name().ok_or_else(|| {
            format!(
                "no existing ancestor can establish runtime-home '{}',",
                requested.display()
            )
        })?;
        suffix.push(name.to_os_string());
        if !cursor.pop() {
            return Err(format!(
                "no existing ancestor can establish runtime-home '{}',",
                requested.display()
            ));
        }
    }
}

fn same_or_descendant(path: &Path, parent: &Path) -> bool {
    #[cfg(any(windows, target_os = "macos"))]
    {
        let path = path.to_string_lossy().to_lowercase();
        let parent = parent.to_string_lossy().to_lowercase();
        return Path::new(&path).strip_prefix(&parent).is_ok();
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    path.strip_prefix(parent).is_ok()
}

/// Admit only a concrete runtime leaf. Shared profiles/keyring/cache/install
/// containers are control-plane state, never a movable or deletable runtime.
/// Existing ancestors are canonicalized before comparison so symlink aliases
/// cannot bypass the same boundary.
pub fn admit_station_runtime_home_for_root(home: &Path, root: &Path) -> Result<PathBuf, String> {
    let lexical_home = lexical_absolute(home)?;
    let lexical_root = lexical_absolute(root)?;
    match fs::symlink_metadata(&lexical_home) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err("selected runtime home is a symlink".into());
            }
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "inspect selected runtime home '{}': {error}",
                lexical_home.display()
            ));
        }
    }
    let home = canonical_path_through_existing_ancestor(home)?;
    let root = canonical_path_through_existing_ancestor(root)?;
    for container in [
        Path::new("config"),
        Path::new("cache"),
        Path::new("installs"),
        Path::new("instances"),
        Path::new("instances/dev"),
    ] {
        let path = root.join(container);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() => {
            }
            Ok(_) => {
                return Err(format!(
                    "shared Station container is unsafe: {}",
                    container.display()
                ))
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "inspect shared Station container '{}': {error}",
                    container.display()
                ))
            }
        }
    }
    if same_or_descendant(&root, &home) {
        return Err("runtime home is the shared Station root or an ancestor of it".into());
    }
    for name in ["config", "cache", "installs"] {
        let canonical_protected =
            canonical_path_through_existing_ancestor(&lexical_root.join(name))?;
        if same_or_descendant(&home, &canonical_protected)
            || same_or_descendant(&lexical_home, &lexical_root.join(name))
        {
            return Err(format!(
                "runtime home is inside the shared Station {name} subtree"
            ));
        }
    }
    let instances = root.join("instances");
    if same_or_descendant(&home, &instances) && same_or_descendant(&instances, &home) {
        return Err("runtime home is the shared Station instances container".into());
    }
    let dev_instances = instances.join("dev");
    if same_or_descendant(&home, &dev_instances) && same_or_descendant(&dev_instances, &home) {
        return Err("runtime home is the shared Station development-instances container".into());
    }
    if same_or_descendant(&home, &instances) {
        // macOS/Windows comparisons above are deliberately case-folded to
        // reject reserved aliases. Do not reinterpret such an alias as a
        // valid instance leaf when recovering the exact relative segments.
        let exact_relative = home
            .strip_prefix(&instances)
            .map_err(|_| "runtime home uses a reserved instances alias".to_string())?;
        let parts = exact_relative
            .components()
            .filter_map(|component| match component {
                Component::Normal(part) => part.to_str(),
                _ => None,
            })
            .collect::<Vec<_>>();
        let safe_instance_leaf = parts.len() == 1
            && !parts[0].is_empty()
            && parts[0]
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
        let safe_dev_leaf = parts.len() == 2
            && parts[0] == "dev"
            && !parts[1].is_empty()
            && parts[1]
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
        if !safe_instance_leaf && !safe_dev_leaf {
            return Err("runtime home is not a concrete Station runtime instance leaf".into());
        }
    }
    Ok(home)
}

pub fn admit_station_runtime_home(home: &Path) -> Result<PathBuf, String> {
    admit_station_runtime_home_for_root(home, &resolve_station_root())
}

fn station_home_from_env(
    station_home: Option<std::ffi::OsString>,
    station_root: Option<std::ffi::OsString>,
    home: Option<std::ffi::OsString>,
    user_profile: Option<std::ffi::OsString>,
    is_windows: bool,
    channel: Option<&std::ffi::OsStr>,
) -> PathBuf {
    if let Some(path) = station_home.filter(|path| !path.is_empty()) {
        return PathBuf::from(path);
    }
    let directory = crate::channel_ports_generated::station_instance_directory(
        channel.and_then(|value| value.to_str()),
    );
    if let Some(root) = station_root.filter(|path| !path.is_empty()) {
        return PathBuf::from(root).join("instances").join(directory);
    }
    let user_home = if is_windows {
        user_profile.or(home)
    } else {
        home
    };
    user_home
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".station")
        .join("instances")
        .join(directory)
}

fn service_path_entries(
    node_dir: &Path,
    inherited_path: impl IntoIterator<Item = PathBuf>,
) -> Vec<PathBuf> {
    let mut entries = vec![node_dir.to_path_buf()];
    entries.extend(inherited_path);
    entries
}

fn service_path(node_dir: &Path) -> Result<String, String> {
    let inherited = env::var_os("PATH")
        .map(|path| env::split_paths(&path).collect::<Vec<_>>())
        .unwrap_or_default();
    env::join_paths(service_path_entries(node_dir, inherited))
        .map(|path| path.to_string_lossy().into_owned())
        .map_err(|_| "Station service PATH contains an unsupported path entry".to_string())
}

/// Resolve only the explicit shared CLI default. A Desktop shell never guesses
/// from `service/default.json` or filename order: a hosted default is valid as
/// a connection, but it is not a service the local shell may start.
pub fn resolve_default_service(home: &Path) -> DefaultServiceResolution {
    let store_path = home.join("config").join("profiles.json");
    let raw = match read_owner_only_file(&store_path, "saved Station store") {
        Ok(raw) => raw,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return DefaultServiceResolution::NoDefaultProfile
        }
        Err(error) => {
            return DefaultServiceResolution::InvalidDefaultProfile(format!(
                "read saved Station store: {error}"
            ))
        }
    };
    let store = match serde_json::from_str::<StationProfileStoreDocument>(&raw) {
        Ok(store) if valid_profile_store_document(&store) => store,
        Ok(_) => {
            return DefaultServiceResolution::InvalidDefaultProfile(
                "saved Station store schema is unsupported".into(),
            )
        }
        Err(error) => {
            return DefaultServiceResolution::InvalidDefaultProfile(format!(
                "parse saved Station store: {error}"
            ))
        }
    };
    let Some(default_profile) = store.default_profile else {
        return DefaultServiceResolution::InvalidDefaultProfile(
            "saved Station store has no defaultProfile field".into(),
        );
    };
    let Some(default_name) = default_profile else {
        return DefaultServiceResolution::NoDefaultProfile;
    };
    let Some(profile) = store
        .profiles
        .iter()
        .find(|profile| profile.name.to_lowercase() == default_name.to_lowercase())
    else {
        return DefaultServiceResolution::InvalidDefaultProfile(
            "shared default names no saved Station".into(),
        );
    };
    let Some(local) = &profile.local_service else {
        return DefaultServiceResolution::RemoteDefaultProfile;
    };
    if local.instance_id.trim().is_empty()
        || local.base_dir.trim().is_empty()
        || !Path::new(&local.base_dir).is_absolute()
        || local.server_port == 0
        || local.ui_port == 0
    {
        return DefaultServiceResolution::InvalidDefaultProfile(
            "shared default localService is incomplete or unsafe".into(),
        );
    }
    let manifest_path = Path::new(&local.base_dir)
        .join("service")
        .join(format!("{}.json", local.instance_id));
    let manifest = match read_owner_only_file(&manifest_path, "service manifest") {
        Ok(raw) => match serde_json::from_str::<ServiceManifest>(&raw) {
            Ok(manifest) => manifest,
            Err(error) => {
                return DefaultServiceResolution::InvalidDefaultProfile(format!(
                    "parse service manifest at {}: {error}",
                    manifest_path.display()
                ))
            }
        },
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return DefaultServiceResolution::LocalManifestMissing(PathBuf::from(&local.base_dir))
        }
        Err(error) => {
            return DefaultServiceResolution::InvalidDefaultProfile(format!(
                "read service manifest at {}: {error}",
                manifest_path.display()
            ))
        }
    };
    if !valid_manifest(&manifest)
        || manifest.instance_id != local.instance_id
        || manifest.server_port != local.server_port
        || manifest.ui_port != local.ui_port
    {
        return DefaultServiceResolution::InvalidDefaultProfile(
            "service manifest does not match the default localService identity".into(),
        );
    }
    DefaultServiceResolution::Local(ResolvedLocalService {
        base_dir: PathBuf::from(&local.base_dir),
        manifest,
    })
}

pub fn discover_manifest(home: &Path) -> Option<ResolvedLocalService> {
    match resolve_default_service(home) {
        DefaultServiceResolution::Local(service) => Some(service),
        DefaultServiceResolution::NoDefaultProfile
        | DefaultServiceResolution::RemoteDefaultProfile
        | DefaultServiceResolution::LocalManifestMissing(_)
        | DefaultServiceResolution::InvalidDefaultProfile(_) => None,
    }
}

/// Shared profiles select a connection, but a desktop runtime may only act on
/// the service bound to its own resolved runtime home. This prevents a global
/// default for another channel or worktree from retargeting an owned sidecar.
pub fn discover_manifest_for_runtime(
    station_root: &Path,
    runtime_home: &Path,
) -> Option<ResolvedLocalService> {
    resolve_runtime_owned_service(station_root, runtime_home)
        .ok()
        .flatten()
        .map(|(_, service)| service)
}

/// Resolve the one local profile that is structurally bound to this runtime
/// home. This intentionally does not consult `defaultProfile`: the shared
/// default is a user connection choice and may belong to another channel.
///
/// A duplicate or malformed claimed binding is an ownership ambiguity, never
/// permission to choose a filename/order fallback.
pub fn resolve_runtime_owned_service(
    station_root: &Path,
    runtime_home: &Path,
) -> Result<Option<(String, ResolvedLocalService)>, String> {
    let runtime_home = admit_station_runtime_home_for_root(runtime_home, station_root)?;
    let store_path = station_root.join("config").join("profiles.json");
    let raw = match read_owner_only_file(&store_path, "saved Station store") {
        Ok(raw) => raw,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("read saved Station store: {error}")),
    };
    let store = serde_json::from_str::<StationProfileStoreDocument>(&raw)
        .map_err(|error| format!("parse saved Station store: {error}"))?;
    if !valid_profile_store_document(&store) {
        return Err("saved Station store schema is unsupported".into());
    }
    let mut matches = Vec::new();
    for profile in &store.profiles {
        let Some(local) = &profile.local_service else {
            continue;
        };
        if profile.setup_source != "local" {
            continue;
        }
        if !Path::new(&local.base_dir).is_absolute() {
            return Err("local service binding baseDir is not absolute".into());
        }
        let base_dir =
            admit_station_runtime_home_for_root(Path::new(&local.base_dir), station_root)
                .map_err(|error| format!("local service binding is invalid: {error}"))?;
        if base_dir == runtime_home {
            matches.push((profile, local, base_dir));
        }
    }
    let Some((profile, local, base_dir)) = matches.pop() else {
        return Ok(None);
    };
    if !matches.is_empty() {
        return Err("multiple saved Stations claim this runtime home".into());
    }
    let manifest_path = base_dir
        .join("service")
        .join(format!("{}.json", local.instance_id));
    let raw = read_owner_only_file(&manifest_path, "service manifest").map_err(|error| {
        format!(
            "read service manifest at {}: {error}",
            manifest_path.display()
        )
    })?;
    let manifest = serde_json::from_str::<ServiceManifest>(&raw).map_err(|error| {
        format!(
            "parse service manifest at {}: {error}",
            manifest_path.display()
        )
    })?;
    if !valid_manifest(&manifest)
        || manifest.instance_id != local.instance_id
        || manifest.server_port != local.server_port
        || manifest.ui_port != local.ui_port
    {
        return Err("service manifest does not match the runtime localService identity".into());
    }
    Ok(Some((
        profile.name.clone(),
        ResolvedLocalService { base_dir, manifest },
    )))
}

/// Read saved Station metadata and service manifests without following symlinks.
/// On Unix, these secret-free control files still need the same current-user,
/// owner-only boundary as the CLI store. Windows rejects reparse-point links;
/// its user-profile ACL is the platform's equivalent ownership boundary.
///
/// `pub(crate)` (station#1715): also used by `lib.rs`'s
/// `station_local_grant_secret` to read `<base_dir>/runtime/local-grant.secret`
/// under the exact same owner-only boundary as the service manifest it sits
/// beside — that secret is not itself a bearer, but reading it under a weaker
/// boundary would hand a same-host, different-user process the means to mint
/// one for itself.
pub(crate) fn read_owner_only_file(path: &Path, label: &str) -> Result<String, std::io::Error> {
    let parent = path.parent().ok_or_else(|| {
        std::io::Error::new(
            ErrorKind::PermissionDenied,
            format!("{label} has no parent directory"),
        )
    })?;
    let parent_metadata = fs::symlink_metadata(parent)?;
    if !parent_metadata.file_type().is_dir() {
        return Err(std::io::Error::new(
            ErrorKind::PermissionDenied,
            format!("{label} parent must be a directory, not a symlink"),
        ));
    }
    windows_path_trust::verify(&[(TrustKind::Directory, parent), (TrustKind::File, path)])
        .map_err(|error| std::io::Error::new(ErrorKind::PermissionDenied, error))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if parent_metadata.mode() & 0o077 != 0 || !owned_by_current_user(parent_metadata.uid()) {
            return Err(std::io::Error::new(
                ErrorKind::PermissionDenied,
                format!("{label} parent must be current-user owned and owner-only"),
            ));
        }
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.file_type().is_file() {
        return Err(std::io::Error::new(
            ErrorKind::PermissionDenied,
            format!("{label} must be a regular file, not a symlink"),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
        if metadata.mode() & 0o077 != 0 || !owned_by_current_user(metadata.uid()) {
            return Err(std::io::Error::new(
                ErrorKind::PermissionDenied,
                format!("{label} must be current-user owned and owner-only"),
            ));
        }
        // O_NOFOLLOW closes the final-component race between metadata and the
        // read. Parent-directory replacement remains outside std's portable
        // descriptor APIs, so paths are revalidated before every action.
        let mut options = fs::OpenOptions::new();
        options.read(true).custom_flags(libc::O_NOFOLLOW);
        let mut file = options.open(path)?;
        let opened = file.metadata()?;
        if opened.dev() != metadata.dev() || opened.ino() != metadata.ino() {
            return Err(std::io::Error::new(
                ErrorKind::PermissionDenied,
                format!("{label} changed while it was being opened"),
            ));
        }
        let mut contents = String::new();
        use std::io::Read;
        file.read_to_string(&mut contents)?;
        return Ok(contents);
    }
    #[cfg(not(unix))]
    fs::read_to_string(path)
}

#[cfg(unix)]
fn owned_by_current_user(owner_uid: u32) -> bool {
    // libc exposes the effective uid directly, avoiding a PATH-dependent
    // subprocess in the file-trust boundary.
    unsafe { libc::geteuid() == owner_uid }
}

fn valid_manifest(manifest: &ServiceManifest) -> bool {
    matches!(manifest.platform.as_str(), "darwin" | "linux" | "win32")
        && !manifest.host.is_empty()
        && !manifest.instance_id.is_empty()
        && Path::new(&manifest.node_path).is_absolute()
        && Path::new(&manifest.repo_path).is_absolute()
        && manifest.server_port != 0
        && manifest.ui_port != 0
}

fn command_paths(manifest: &ServiceManifest) -> (PathBuf, PathBuf, PathBuf) {
    let node_path = PathBuf::from(&manifest.node_path);
    let repo_path = PathBuf::from(&manifest.repo_path);
    let tsx_cli = repo_path.join("node_modules/tsx/dist/cli.mjs");
    let station_cli = repo_path.join("scripts/station-cli.ts");
    (node_path, tsx_cli, station_cli)
}

fn command_paths_exist(manifest: &ServiceManifest) -> bool {
    let (node_path, tsx_cli, station_cli) = command_paths(manifest);
    trusted_manifest_path(&node_path, true)
        && trusted_manifest_path(&tsx_cli, false)
        && trusted_manifest_path(&station_cli, false)
}

fn trusted_manifest_path(path: &Path, executable: bool) -> bool {
    let Some(parent) = path.parent() else {
        return false;
    };
    let Ok(parent_metadata) = fs::symlink_metadata(parent) else {
        return false;
    };
    if !parent_metadata.file_type().is_dir() {
        return false;
    }
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.file_type().is_file() {
        return false;
    }
    if windows_path_trust::verify_execution_paths(&[
        (TrustKind::Directory, parent),
        (TrustKind::File, path),
    ])
    .is_err()
    {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if !owned_by_current_user(parent_metadata.uid())
            || parent_metadata.mode() & 0o022 != 0
            || !owned_by_current_user(metadata.uid())
            || metadata.mode() & 0o022 != 0
        {
            return false;
        }
        if executable && metadata.mode() & 0o111 == 0 {
            return false;
        }
    }
    true
}

pub fn derive_health(
    manifest: Option<&ServiceManifest>,
    server: &IdentityProbe,
    ui: &IdentityProbe,
) -> ServiceHealth {
    let Some(manifest) = manifest else {
        return ServiceHealth::NotInstalled;
    };
    if server.outcome == ProbeOutcome::Refused && ui.outcome == ProbeOutcome::Refused {
        return ServiceHealth::Stopped;
    }
    if server.status == Some(200)
        && ui.status == Some(200)
        && server.instance_id.as_deref() == Some(&manifest.instance_id)
        && ui.instance_id.as_deref() == Some(&manifest.instance_id)
    {
        ServiceHealth::Running
    } else {
        ServiceHealth::Unhealthy
    }
}

pub fn probe_identity(host: &str, port: u16, path: &str) -> IdentityProbe {
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    let url = format!("http://{host}:{port}{path}");
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(PROBE_TIMEOUT))
        .http_status_as_error(false)
        .build()
        .into();
    let mut response = match agent.get(&url).call() {
        Ok(response) => response,
        Err(ureq::Error::Io(error)) if error.kind() == ErrorKind::ConnectionRefused => {
            return IdentityProbe::refused();
        }
        Err(_) => return IdentityProbe::unknown(),
    };
    let status = response.status().as_u16();
    let instance_id = response
        .body_mut()
        .read_to_string()
        .ok()
        .and_then(|body| serde_json::from_str::<Value>(&body).ok())
        .and_then(|body| body.get("instanceId")?.as_str().map(str::to_owned));
    IdentityProbe {
        instance_id,
        outcome: ProbeOutcome::Responded,
        status: Some(status),
    }
}

pub fn probe_service(manifest: Option<&ServiceManifest>) -> ServiceHealth {
    let Some(manifest) = manifest else {
        return ServiceHealth::NotInstalled;
    };
    if !command_paths_exist(manifest) {
        log::debug!(
            "Station service probe for instance {}: command paths missing, reporting unhealthy",
            manifest.instance_id
        );
        return ServiceHealth::Unhealthy;
    }
    let server = probe_identity(&manifest.host, manifest.server_port, "/api/system/identity");
    let ui = probe_identity(&manifest.host, manifest.ui_port, "/__station/identity");
    let health = derive_health(Some(manifest), &server, &ui);
    // Debug, not info: the tray poll thread calls this on every tick (as
    // often as ~every second while `Running`), so logging every probe at a
    // level enabled by default would flood the file the moment the app is
    // idle rather than crashing.
    log::debug!(
        "Station service probe for instance {}: {health:?}",
        manifest.instance_id
    );
    health
}

/// Builds the CLI process invocation from manifest-owned absolute locations.
/// The desktop process never depends on the GUI launcher's PATH or cwd.
pub fn service_action(
    base_dir: &Path,
    manifest: &ServiceManifest,
    action: ServiceAction,
) -> Result<ServiceCommand, String> {
    if !valid_manifest(manifest) {
        return Err("Station service manifest is incomplete or unsafe".into());
    }
    if !base_dir.is_absolute() {
        return Err("Station service base directory must be absolute".into());
    }
    let (node_path, tsx_cli, station_cli) = command_paths(manifest);
    if !node_path.is_file() || !tsx_cli.is_file() || !station_cli.is_file() {
        return Err("Station service manifest references missing CLI paths".into());
    }
    let node_dir = node_path
        .parent()
        .ok_or("Station manifest nodePath has no parent directory")?;
    Ok(ServiceCommand {
        program: node_path.display().to_string(),
        args: vec![
            tsx_cli.display().to_string(),
            station_cli.display().to_string(),
            "service".into(),
            action.as_str().into(),
            format!("--instance={}", manifest.instance_id),
            format!("--base={}", base_dir.display()),
            format!("--port={}", manifest.server_port),
            format!("--ui-port={}", manifest.ui_port),
            format!("--host={}", manifest.host),
            "--json".into(),
        ],
        control_paths: vec![
            (base_dir.to_path_buf(), TrustKind::Directory),
            (base_dir.join("service"), TrustKind::Directory),
            (
                base_dir
                    .join("service")
                    .join(format!("{}.json", manifest.instance_id)),
                TrustKind::File,
            ),
        ],
        path: service_path(node_dir)?,
    })
}

/// Recheck every manifest-derived executable/script path immediately before
/// spawning it. This narrows the remaining filesystem race after resolution:
/// callers never execute a path that became a symlink, changed owner, or was
/// made writable by another account while a service action was being prepared.
pub fn service_command_is_trusted(command: &ServiceCommand) -> bool {
    command.args.len() >= 2
        && command
            .control_paths
            .iter()
            .all(|(path, kind)| trusted_station_control_path(path, *kind))
        && trusted_manifest_path(Path::new(&command.program), true)
        && trusted_manifest_path(Path::new(&command.args[0]), false)
        && trusted_manifest_path(Path::new(&command.args[1]), false)
}

fn trusted_station_control_path(path: &Path, kind: TrustKind) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    let valid_kind = match kind {
        TrustKind::Directory => metadata.file_type().is_dir(),
        TrustKind::File => metadata.file_type().is_file(),
    };
    if !valid_kind || windows_path_trust::verify(&[(kind, path)]).is_err() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.mode() & 0o077 != 0 || !owned_by_current_user(metadata.uid()) {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::fs;
    use std::ops::Deref;

    fn manifest() -> ServiceManifest {
        ServiceManifest {
            host: "127.0.0.1".into(),
            instance_id: "default".into(),
            node_path: "/opt/node/bin/node".into(),
            platform: "darwin".into(),
            repo_path: "/opt/station".into(),
            server_port: 3141,
            ui_port: 3000,
        }
    }

    fn probe(status: Option<u16>, instance_id: Option<&str>) -> IdentityProbe {
        IdentityProbe {
            status,
            instance_id: instance_id.map(str::to_owned),
            outcome: if status.is_some() {
                ProbeOutcome::Responded
            } else {
                ProbeOutcome::Unknown
            },
        }
    }

    struct TempHome(tempfile::TempDir);

    impl Deref for TempHome {
        type Target = Path;

        fn deref(&self) -> &Self::Target {
            self.0.path()
        }
    }

    fn temp_home() -> TempHome {
        TempHome(
            tempfile::Builder::new()
                .prefix("station-tray-state-")
                .tempdir()
                .expect("create isolated service-state fixture home"),
        )
    }

    #[test]
    fn temp_homes_are_isolated_under_parallel_creation() {
        let homes = (0..64)
            .map(|index| {
                std::thread::spawn(move || {
                    let home = temp_home();
                    fs::write(home.join("owner"), index.to_string()).unwrap();
                    (home, index)
                })
            })
            .map(|worker| worker.join().expect("fixture worker completes"))
            .collect::<Vec<_>>();

        let paths = homes
            .iter()
            .map(|(home, _)| home.to_path_buf())
            .collect::<HashSet<_>>();
        assert_eq!(paths.len(), homes.len());
        for (home, index) in &homes {
            assert_eq!(
                fs::read_to_string(home.join("owner")).unwrap(),
                index.to_string()
            );
        }
    }

    #[test]
    fn admits_only_concrete_runtime_leaves_without_creating_rejected_paths() {
        let parent = temp_home();
        let root = parent.join("shared-root");
        fs::create_dir(&root).unwrap();
        let rejected = [
            root.clone(),
            parent.to_path_buf(),
            root.join("config"),
            root.join("cache"),
            root.join("installs"),
            root.join("instances"),
            root.join("instances/dev"),
            root.join("instances/stable/nested"),
        ];
        for home in rejected {
            assert!(admit_station_runtime_home_for_root(&home, &root).is_err());
            assert!(!home.starts_with(&root) || home == root || !home.exists());
        }
        assert_eq!(
            admit_station_runtime_home_for_root(&root.join("instances/stable"), &root).unwrap(),
            fs::canonicalize(&root).unwrap().join("instances/stable")
        );
        assert_eq!(
            admit_station_runtime_home_for_root(&root.join("instances/dev/dev-proof"), &root)
                .unwrap(),
            fs::canonicalize(&root)
                .unwrap()
                .join("instances/dev/dev-proof")
        );
        let custom = parent.join("custom-runtime");
        assert_eq!(
            admit_station_runtime_home_for_root(&custom, &root).unwrap(),
            fs::canonicalize(&*parent).unwrap().join("custom-runtime")
        );
        assert!(!custom.exists());
    }

    #[cfg(unix)]
    #[test]
    fn canonical_aliases_cannot_bypass_runtime_home_admission() {
        use std::os::unix::fs::symlink;

        let parent = temp_home();
        let root = parent.join("shared-root");
        fs::create_dir(&root).unwrap();
        let alias = parent.join("shared-root-alias");
        symlink(&root, &alias).unwrap();
        assert!(admit_station_runtime_home_for_root(&alias.join("config"), &root).is_err());
        assert_eq!(
            admit_station_runtime_home_for_root(&alias.join("instances/stable"), &root).unwrap(),
            fs::canonicalize(&root).unwrap().join("instances/stable")
        );
    }

    #[cfg(unix)]
    #[test]
    fn redirected_protected_subtrees_and_dangling_links_fail_closed() {
        use std::os::unix::fs::symlink;

        let parent = temp_home();
        let root = parent.join("root");
        let outside = parent.join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        for name in ["config", "cache", "installs"] {
            let target = outside.join(name);
            fs::create_dir(&target).unwrap();
            symlink(&target, root.join(name)).unwrap();
            for candidate in [root.join(name).join("runtime"), target.join("runtime")] {
                assert!(admit_station_runtime_home_for_root(&candidate, &root).is_err());
                assert!(!candidate.exists());
            }
        }
        let dangling = root.join("config-dangling");
        symlink(outside.join("missing"), &dangling).unwrap();
        assert!(admit_station_runtime_home_for_root(&dangling.join("runtime"), &root).is_err());
        assert!(!dangling.join("runtime").exists());
    }

    #[cfg(unix)]
    #[test]
    fn unsafe_shared_containers_block_unrelated_runtime_homes() {
        use std::os::unix::fs::symlink;
        for container in ["config", "cache", "installs", "instances", "instances/dev"] {
            let parent = temp_home();
            let root = parent.join("root");
            let outside = parent.join("outside");
            fs::create_dir(&root).unwrap();
            fs::create_dir(&outside).unwrap();
            if container.contains('/') {
                fs::create_dir(root.join("instances")).unwrap();
            }
            symlink(&outside, root.join(container)).unwrap();
            assert!(
                admit_station_runtime_home_for_root(&parent.join("external-runtime"), &root)
                    .is_err()
            );
        }
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn rejects_differently_cased_shared_containers_before_creation() {
        let parent = temp_home();
        let root = parent.join("shared-root");
        fs::create_dir(&root).unwrap();
        for candidate in [
            root.join("CONFIG"),
            root.join("CACHE"),
            root.join("INSTALLS"),
            root.join("INSTANCES"),
            root.join("instances/DEV"),
        ] {
            assert!(admit_station_runtime_home_for_root(&candidate, &root).is_err());
            assert!(!candidate.exists());
        }
    }

    fn write_owner_only(path: &Path, contents: impl AsRef<[u8]>) {
        fs::create_dir_all(path.parent().expect("test fixture path has parent")).unwrap();
        fs::write(path, contents).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        }
    }

    fn create_owner_only_dir(path: &Path) {
        fs::create_dir_all(path).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
    }

    #[test]
    fn resolves_the_shared_default_local_service_from_its_exact_custom_base() {
        let home = temp_home();
        let base = home.join("custom-local-base");
        create_owner_only_dir(&base.join("service"));
        let mut selected = manifest();
        selected.instance_id = "custom".into();
        selected.server_port = 4011;
        selected.ui_port = 4012;
        write_owner_only(
            &base.join("service/custom.json"),
            serde_json::to_string(&selected).unwrap(),
        );
        create_owner_only_dir(&home.join("config"));
        write_owner_only(
            &home.join("config/profiles.json"),
            serde_json::json!({
                "schemaVersion": 1,
                "revision": 0,
                "defaultProfile": "local",
                "projectProfiles": {},
                "profiles": [{
                    "schemaVersion": 1,
                    "name": "local",
                    "endpoint": "http://127.0.0.1:4011",
                    "setupSource": "local",
                    "configurationState": "configured",
                    "createdAt": 1,
                    "updatedAt": 1,
                    "localService": {
                        "instanceId": "custom",
                        "baseDir": base,
                        "serverPort": 4011,
                        "uiPort": 4012
                    }
                }, {
                    "schemaVersion": 1,
                    "name": "other-local-service",
                    "endpoint": "http://127.0.0.1:5011",
                    "setupSource": "local",
                    "configurationState": "configured",
                    "createdAt": 1,
                    "updatedAt": 1,
                    "localService": {
                        "instanceId": "other",
                        "baseDir": home.join("other-local-base"),
                        "serverPort": 5011,
                        "uiPort": 5012
                    }
                }]
            })
            .to_string(),
        );
        assert_eq!(
            resolve_default_service(&home),
            DefaultServiceResolution::Local(ResolvedLocalService {
                base_dir: base.clone(),
                manifest: selected,
            })
        );
    }

    #[test]
    fn resolves_the_runtime_owner_independently_of_the_shared_default() {
        let root = temp_home();
        let runtime = root.join("instances/beta");
        create_owner_only_dir(&runtime.join("service"));
        let mut beta = manifest();
        beta.instance_id = "desktop-sidecar-beta".into();
        beta.server_port = 28141;
        beta.ui_port = 28000;
        write_owner_only(
            &runtime.join("service/desktop-sidecar-beta.json"),
            serde_json::to_string(&beta).unwrap(),
        );
        create_owner_only_dir(&root.join("config"));
        let store = |duplicate: bool| {
            let mut profiles = vec![
                serde_json::json!({
                    "schemaVersion": 1,
                    "name": "remote-default",
                    "endpoint": "https://remote.example.test",
                    "setupSource": "paired",
                    "configurationState": "configured",
                    "createdAt": 1,
                    "updatedAt": 1
                }),
                serde_json::json!({
                    "schemaVersion": 1,
                    "name": "beta-local",
                    "endpoint": "http://127.0.0.1:28141",
                    "setupSource": "local",
                    "configurationState": "configured",
                    "createdAt": 1,
                    "updatedAt": 1,
                    "localService": {
                        "instanceId": "desktop-sidecar-beta",
                        "baseDir": runtime,
                        "serverPort": 28141,
                        "uiPort": 28000
                    }
                }),
            ];
            if duplicate {
                let mut copy = profiles[1].clone();
                copy["name"] = serde_json::json!("beta-local-copy");
                profiles.push(copy);
            }
            serde_json::json!({
                "schemaVersion": 1,
                "revision": 0,
                "defaultProfile": "remote-default",
                "projectProfiles": {},
                "profiles": profiles
            })
        };
        write_owner_only(&root.join("config/profiles.json"), store(false).to_string());

        assert_eq!(
            resolve_default_service(&root),
            DefaultServiceResolution::RemoteDefaultProfile
        );
        let (name, service) = resolve_runtime_owned_service(&root, &runtime)
            .unwrap()
            .expect("beta runtime owner");
        assert_eq!(name, "beta-local");
        assert_eq!(service.base_dir, fs::canonicalize(&runtime).unwrap());

        write_owner_only(&root.join("config/profiles.json"), store(true).to_string());
        assert!(resolve_runtime_owned_service(&root, &runtime)
            .unwrap_err()
            .contains("multiple saved Stations"));
    }

    #[test]
    fn stale_stable_default_record_cannot_retarget_the_prepared_stable_runtime() {
        let parent = temp_home();
        let root = parent.join("shared-root");
        let runtime = root.join("instances/stable");
        create_owner_only_dir(&runtime);
        create_owner_only_dir(&root.join("config"));

        // This is the exact pre-one-root Stable shape: a shared-root service
        // identity at 3141/3000. After runtime preparation quarantines its
        // legacy manifest, it must not be re-adopted for the Stable runtime.
        write_owner_only(
            &root.join("config/profiles.json"),
            serde_json::json!({
                "schemaVersion": 1,
                "revision": 0,
                "defaultProfile": "stable",
                "projectProfiles": {},
                "profiles": [{
                    "schemaVersion": 1,
                    "name": "stable",
                    "endpoint": "http://127.0.0.1:3141",
                    "setupSource": "local",
                    "configurationState": "configured",
                    "createdAt": 1,
                    "updatedAt": 1,
                    "localService": {
                        "instanceId": "default",
                        "baseDir": root,
                        "serverPort": 3141,
                        "uiPort": 3000
                    }
                }]
            })
            .to_string(),
        );

        assert!(
            resolve_runtime_owned_service(&root, &runtime).is_err(),
            "the shared-root binding is ambiguous/invalid, never a runtime owner"
        );
        assert_eq!(discover_manifest_for_runtime(&root, &runtime), None);
    }

    #[test]
    fn remote_or_hosted_default_is_not_a_startable_local_service() {
        let home = temp_home();
        create_owner_only_dir(&home.join("config"));
        write_owner_only(
            &home.join("config/profiles.json"),
            serde_json::json!({
                "schemaVersion": 1,
                "revision": 0,
                "defaultProfile": "hosted",
                "projectProfiles": {},
                "profiles": [{
                    "schemaVersion": 1,
                    "name": "hosted",
                    "endpoint": "https://station.kontourai.io",
                    "setupSource": "hosted",
                    "configurationState": "configured",
                    "createdAt": 1,
                    "updatedAt": 1
                }]
            })
            .to_string(),
        );
        assert_eq!(
            resolve_default_service(&home),
            DefaultServiceResolution::RemoteDefaultProfile
        );
        assert!(discover_manifest(&home).is_none());
    }

    #[test]
    fn rejects_reduced_or_malformed_shared_profile_documents() {
        let home = temp_home();
        fs::create_dir_all(home.join("config")).unwrap();
        fs::write(
            home.join("config/profiles.json"),
            serde_json::json!({
                "schemaVersion": 1,
                "defaultProfile": "local",
                "projectProfiles": {},
                "profiles": [{ "name": "local" }]
            })
            .to_string(),
        )
        .unwrap();
        assert!(matches!(
            resolve_default_service(&home),
            DefaultServiceResolution::InvalidDefaultProfile(_)
        ));

        fs::write(
            home.join("config/profiles.json"),
            serde_json::json!({
                "schemaVersion": 1,
                "revision": 0,
                "defaultProfile": "missing",
                "projectProfiles": { "project": "missing" },
                "profiles": [{
                    "schemaVersion": 1,
                    "name": "local",
                    "endpoint": "https://local.example",
                    "setupSource": "manual",
                    "configurationState": "configured",
                    "createdAt": 1,
                    "updatedAt": 1
                }]
            })
            .to_string(),
        )
        .unwrap();
        assert!(matches!(
            resolve_default_service(&home),
            DefaultServiceResolution::InvalidDefaultProfile(_)
        ));

        // The rest of this fixture is valid; omission is distinct from an
        // explicit `defaultProfile: null` and must fail like the TS contract.
        fs::write(
            home.join("config/profiles.json"),
            serde_json::json!({
                "schemaVersion": 1,
                "revision": 0,
                "projectProfiles": {},
                "profiles": [{
                    "schemaVersion": 1,
                    "name": "local",
                    "endpoint": "https://local.example",
                    "setupSource": "manual",
                    "configurationState": "configured",
                    "createdAt": 1,
                    "updatedAt": 1
                }]
            })
            .to_string(),
        )
        .unwrap();
        assert!(matches!(
            resolve_default_service(&home),
            DefaultServiceResolution::InvalidDefaultProfile(_)
        ));

        fs::write(
            home.join("config/profiles.json"),
            serde_json::json!({
                "schemaVersion": 1,
                "revision": 9_007_199_254_740_992u64,
                "defaultProfile": null,
                "projectProfiles": {},
                "profiles": []
            })
            .to_string(),
        )
        .unwrap();
        assert!(matches!(
            resolve_default_service(&home),
            DefaultServiceResolution::InvalidDefaultProfile(_)
        ));

        // JavaScript's String#toLowerCase is Unicode-aware. Native service
        // selection must reject the same non-ASCII case collision rather than
        // accepting a store the shared TypeScript contract rejects.
        fs::write(
            home.join("config/profiles.json"),
            serde_json::json!({
                "schemaVersion": 1,
                "revision": 0,
                "defaultProfile": null,
                "projectProfiles": {},
                "profiles": [{
                    "schemaVersion": 1,
                    "name": "Ä",
                    "endpoint": "https://upper.example",
                    "setupSource": "manual",
                    "configurationState": "configured",
                    "createdAt": 1,
                    "updatedAt": 1
                }, {
                    "schemaVersion": 1,
                    "name": "ä",
                    "endpoint": "https://lower.example",
                    "setupSource": "manual",
                    "configurationState": "configured",
                    "createdAt": 1,
                    "updatedAt": 1
                }]
            })
            .to_string(),
        )
        .unwrap();
        assert!(matches!(
            resolve_default_service(&home),
            DefaultServiceResolution::InvalidDefaultProfile(_)
        ));
    }

    #[test]
    fn absent_bound_manifest_is_setup_needed_not_an_invalid_profile() {
        let home = temp_home();
        let base = home.join("uninstalled-local-base");
        create_owner_only_dir(&home.join("config"));
        write_owner_only(
            &home.join("config/profiles.json"),
            serde_json::json!({
                "schemaVersion": 1,
                "revision": 0,
                "defaultProfile": "local",
                "projectProfiles": {},
                "profiles": [{
                    "schemaVersion": 1,
                    "name": "local",
                    "endpoint": "http://127.0.0.1:4011",
                    "setupSource": "local",
                    "configurationState": "configured",
                    "createdAt": 1,
                    "updatedAt": 1,
                    "localService": {
                        "instanceId": "missing",
                        "baseDir": base,
                        "serverPort": 4011,
                        "uiPort": 4012
                    }
                }]
            })
            .to_string(),
        );

        assert_eq!(
            resolve_default_service(&home),
            DefaultServiceResolution::LocalManifestMissing(base.clone())
        );
        assert!(discover_manifest(&home).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_shared_profile_store() {
        use std::os::unix::fs::symlink;

        let home = temp_home();
        let target = home.join("profiles-target.json");
        create_owner_only_dir(&home.join("config"));
        write_owner_only(&target, "{}");
        symlink(&target, home.join("config/profiles.json")).unwrap();

        assert!(matches!(
            resolve_default_service(&home),
            DefaultServiceResolution::InvalidDefaultProfile(reason)
                if reason.contains("saved Station store")
        ));
    }

    #[test]
    fn accepts_the_cli_win32_manifest_platform_shape() {
        let mut windows = manifest();
        windows.platform = "win32".into();
        assert!(valid_manifest(&windows));
        windows.platform = "windows".into();
        assert!(!valid_manifest(&windows));
    }

    #[test]
    fn resolves_station_home_from_environment_or_home_directory() {
        assert_eq!(
            station_home_from_env(
                Some("/tmp/station-tray-home".into()),
                None,
                Some("/Users/tester".into()),
                Some("C:\\Users\\tester".into()),
                false,
                None,
            ),
            PathBuf::from("/tmp/station-tray-home")
        );
        assert_eq!(
            station_home_from_env(
                None,
                Some("C:\\Users\\tester\\.station".into()),
                None,
                Some("C:\\Users\\tester".into()),
                true,
                Some(std::ffi::OsStr::new("beta"))
            ),
            PathBuf::from("C:\\Users\\tester\\.station")
                .join("instances")
                .join("beta")
        );
    }

    #[test]
    fn derives_station_root_from_a_lone_explicit_home() {
        assert_eq!(
            station_root_from_env(
                None,
                Some("/tmp/isolated-home".into()),
                Some("/Users/tester".into()),
                Some("C:\\Users\\tester".into()),
                false,
            ),
            PathBuf::from("/tmp/isolated-home")
        );
        assert_eq!(
            station_root_from_env(
                None,
                Some("/tmp/isolated-root/instances/e2e".into()),
                Some("/Users/tester".into()),
                None,
                false,
            ),
            PathBuf::from("/tmp/isolated-root")
        );
        assert_eq!(
            station_root_from_env(
                None,
                Some("/tmp/isolated-root/instances/dev/e2e".into()),
                Some("/Users/tester".into()),
                None,
                false,
            ),
            PathBuf::from("/tmp/isolated-root")
        );
        assert_eq!(
            station_root_from_env(
                Some("/tmp/operator-root".into()),
                Some("/tmp/isolated-home".into()),
                Some("/Users/tester".into()),
                None,
                false,
            ),
            PathBuf::from("/tmp/operator-root")
        );
    }

    #[test]
    fn derives_every_health_state_fail_closed() {
        let expected = manifest();
        assert_eq!(
            derive_health(None, &IdentityProbe::refused(), &IdentityProbe::refused()),
            ServiceHealth::NotInstalled
        );
        assert_eq!(
            derive_health(
                Some(&expected),
                &IdentityProbe::refused(),
                &IdentityProbe::refused(),
            ),
            ServiceHealth::Stopped
        );
        assert_eq!(
            derive_health(
                Some(&expected),
                &IdentityProbe::unknown(),
                &IdentityProbe::unknown(),
            ),
            ServiceHealth::Unhealthy
        );
        assert_eq!(
            derive_health(
                Some(&expected),
                &IdentityProbe::refused(),
                &IdentityProbe::unknown(),
            ),
            ServiceHealth::Unhealthy
        );
        assert_eq!(
            derive_health(
                Some(&expected),
                &probe(Some(200), Some("default")),
                &probe(Some(200), Some("default")),
            ),
            ServiceHealth::Running
        );
        assert_eq!(
            derive_health(
                Some(&expected),
                &probe(Some(200), Some("wrong")),
                &probe(Some(200), Some("default")),
            ),
            ServiceHealth::Unhealthy
        );
        assert_eq!(
            derive_health(
                Some(&expected),
                &probe(Some(503), None),
                &IdentityProbe::refused(),
            ),
            ServiceHealth::Unhealthy
        );
    }

    #[test]
    fn builds_manifest_absolute_cli_argv_and_explicit_path() {
        let home = temp_home();
        let repo = home.join("station checkout");
        let node = home.join("node bin/node");
        let tsx = repo.join("node_modules/tsx/dist/cli.mjs");
        let cli = repo.join("scripts/station-cli.ts");
        create_owner_only_dir(node.parent().unwrap());
        create_owner_only_dir(tsx.parent().unwrap());
        create_owner_only_dir(cli.parent().unwrap());
        write_owner_only(&node, "");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&node, fs::Permissions::from_mode(0o700)).unwrap();
        }
        write_owner_only(&tsx, "");
        write_owner_only(&cli, "");
        let mut installed = manifest();
        installed.node_path = node.display().to_string();
        installed.repo_path = repo.display().to_string();
        let selected_base = home.join("selected Station base");
        let command = service_action(&selected_base, &installed, ServiceAction::Start).unwrap();
        assert_eq!(command.program, node.display().to_string());
        assert_eq!(
            command.args,
            vec![
                tsx.display().to_string(),
                cli.display().to_string(),
                "service".into(),
                "start".into(),
                "--instance=default".into(),
                format!("--base={}", selected_base.display()),
                "--port=3141".into(),
                "--ui-port=3000".into(),
                "--host=127.0.0.1".into(),
                "--json".into(),
            ]
        );
        let command_paths = env::split_paths(&command.path).collect::<Vec<_>>();
        assert_eq!(
            command_paths.first(),
            Some(&node.parent().unwrap().to_path_buf())
        );
    }

    #[test]
    fn stale_manifest_paths_are_unhealthy_and_actions_fail_closed() {
        let stale = manifest();
        assert_eq!(probe_service(Some(&stale)), ServiceHealth::Unhealthy);
        assert_eq!(
            service_action(Path::new("/tmp/.station"), &stale, ServiceAction::Stop),
            Err("Station service manifest references missing CLI paths".into())
        );
    }

    #[test]
    fn prepared_command_revalidates_manifest_derived_paths_before_execution() {
        let home = temp_home();
        create_owner_only_dir(&home);
        let repo = home.join("station");
        let node = home.join("node/node");
        let tsx = repo.join("node_modules/tsx/dist/cli.mjs");
        let cli = repo.join("scripts/station-cli.ts");
        create_owner_only_dir(node.parent().unwrap());
        create_owner_only_dir(tsx.parent().unwrap());
        create_owner_only_dir(cli.parent().unwrap());
        write_owner_only(&node, "");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&node, fs::Permissions::from_mode(0o700)).unwrap();
        }
        write_owner_only(&tsx, "");
        write_owner_only(&cli, "");
        let mut installed = manifest();
        installed.node_path = node.display().to_string();
        installed.repo_path = repo.display().to_string();
        let service_dir = home.join("service");
        create_owner_only_dir(&service_dir);
        write_owner_only(
            &service_dir.join(format!("{}.json", installed.instance_id)),
            "{}",
        );
        let command = service_action(&home, &installed, ServiceAction::Start).unwrap();
        assert!(service_command_is_trusted(&command));
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            fs::remove_file(&cli).unwrap();
            symlink("/tmp/untrusted-station-cli", &cli).unwrap();
            assert!(!service_command_is_trusted(&command));
        }
    }

    #[test]
    fn service_path_does_not_inject_system_utility_directories() {
        let node_dir = PathBuf::from("C:\\Station\\node");
        let entries = service_path_entries(&node_dir, vec![PathBuf::from("C:\\Tools")]);
        assert_eq!(entries[0], node_dir);
        assert!(entries.contains(&PathBuf::from("C:\\Tools")));
        assert!(!entries.contains(&PathBuf::from("C:\\Windows\\System32")));
    }
}
