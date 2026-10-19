//! Native-owned desktop self-update (station#3851 slice 1).
//!
//! The desktop shell owns its own update lifecycle: check, download (with
//! byte progress), then install and restart as a separate, explicit step.
//! The webview only reads the state this module computes and asks it to act;
//! it no longer holds updater or process plugin authority itself.
//!
//! Layers, so the transitions are testable without Tauri:
//!
//! - [`Controller`] is the pure state machine. Every phase it reports is one
//!   a transition here produces; there is no standalone "error" phase. A
//!   failure returns to the most useful prior phase and carries an
//!   [`UpdateError`] beside it (a failed download is still `available`, a
//!   failed install is still `ready`).
//! - [`DesktopUpdater`] serializes access to the controller, emits every
//!   observable change through one callback, and drives the asynchronous
//!   check/download and the blocking install through injected operations.
//! - The `tauri_glue` section binds those operations to
//!   `tauri-plugin-updater`'s separate `Update::download` and
//!   `Update::install`, registers the commands and starts the in-process
//!   periodic check. A slice-2 tray reads [`DesktopUpdater::snapshot`] and
//!   listens on [`STATE_EVENT`], the same state the window reads.
//!
//! Restart is never automatic: only `desktop_update_install` restarts, and
//! only after the install it was asked for succeeds.

use serde::{Deserialize, Serialize};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The event every state change is emitted on. Mirrored by
/// `DESKTOP_UPDATE_STATE_EVENT` in `@kontourai/station-contracts/desktop-update`.
pub const STATE_EVENT: &str = "station://desktop-update-state";
/// First automatic check after startup: late enough not to compete with the
/// window's own boot, early enough that a short session still learns of an
/// update.
pub const FIRST_CHECK_DELAY: Duration = Duration::from_secs(20);
/// Re-check cadence while the app keeps running (including tray-only).
pub const CHECK_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// The `after-24h` policy's delay, measured from when this version was first
/// seen available on this machine.
pub const AUTO_DOWNLOAD_DELAY_MS: u64 = 24 * 60 * 60 * 1000;
/// Progress is emitted at most once per this interval (≤ 10/s), and with a
/// known total only when the whole percentage changes.
pub const PROGRESS_MIN_INTERVAL_MS: u64 = 100;
const STORE_FILE: &str = "desktop-update.json";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum DownloadPolicy {
    #[serde(rename = "never")]
    Never,
    #[default]
    #[serde(rename = "after-24h")]
    After24h,
    #[serde(rename = "immediately")]
    Immediately,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum UpdatePhase {
    /// This build carries no usable updater configuration (dev builds, and
    /// any channel before its endpoint ships). Nothing is checked.
    Disabled,
    /// Configured, and no check has finished yet in this run.
    Idle,
    Checking,
    UpToDate {
        checked_at: u64,
    },
    Available {
        version: String,
        notes: Option<String>,
        /// When this version was first seen available on this machine
        /// (persisted, so the `after-24h` delay survives restarts).
        available_since: u64,
    },
    Downloading {
        version: String,
        downloaded_bytes: u64,
        total_bytes: Option<u64>,
    },
    /// Downloaded and signature-verified; waiting for a confirmed restart.
    Ready {
        version: String,
    },
    Installing {
        version: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorContext {
    Check,
    Download,
    Install,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateError {
    pub context: ErrorContext,
    /// The updater's own message, unclassified: this layer cannot tell an
    /// offline host from a bad signature, so it does not label the text.
    pub message: String,
    pub version: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateState {
    pub phase: UpdatePhase,
    pub error: Option<UpdateError>,
    pub policy: DownloadPolicy,
    pub current_version: String,
    /// When the policy downloads the available update by itself; absent when
    /// it never will (policy `never`, or nothing available).
    pub auto_download_at: Option<u64>,
    /// Increases with every emitted change in this process, so a reader can
    /// drop an event or snapshot older than one it already applied.
    pub sequence: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedAvailable {
    version: String,
    since: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Persisted {
    policy: DownloadPolicy,
    /// A policy value this build does not know (written by a newer build).
    /// The default policy applies, and the value is written back unchanged
    /// until the user picks a policy here.
    unknown_policy: Option<serde_json::Value>,
    available: Option<PersistedAvailable>,
    /// The whole file as read, so fields this build does not own (written
    /// by a newer build) survive a write.
    document: serde_json::Map<String, serde_json::Value>,
}

impl Persisted {
    /// Fields are read independently: a corrupt or unknown field costs only
    /// that field (default policy, or a restarted 24h clock), never the
    /// other. A missing file is the ordinary first run; anything else that
    /// cannot be read is logged.
    fn load(dir: &Path) -> Self {
        let path = dir.join(STORE_FILE);
        let raw = match std::fs::read_to_string(&path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Self::default(),
            Err(error) => {
                log::warn!("could not read desktop update settings, using defaults: {error}");
                return Self::default();
            }
        };
        let value: serde_json::Value = match serde_json::from_str(&raw) {
            Ok(value) => value,
            Err(error) => {
                log::warn!("desktop update settings are corrupt, using defaults: {error}");
                return Self::default();
            }
        };
        let mut persisted = Self::default();
        let Some(document) = value.as_object() else {
            log::warn!("desktop update settings are not an object, using defaults");
            return persisted;
        };
        persisted.document = document.clone();
        if let Some(policy) = value.get("policy").filter(|value| !value.is_null()) {
            match serde_json::from_value::<DownloadPolicy>(policy.clone()) {
                Ok(policy) => persisted.policy = policy,
                Err(_) => {
                    log::warn!("unknown desktop update policy {policy}; using the default");
                    persisted.unknown_policy = Some(policy.clone());
                }
            }
        }
        if let Some(available) = value.get("available").filter(|value| !value.is_null()) {
            match serde_json::from_value::<PersistedAvailable>(available.clone()) {
                Ok(available) => persisted.available = Some(available),
                Err(error) => {
                    log::warn!("ignoring an unreadable desktop update clock: {error}")
                }
            }
        }
        persisted
    }

    fn save(&self, dir: &Path) -> Result<(), String> {
        let mut document = self.document.clone();
        document.insert(
            "policy".into(),
            self.unknown_policy
                .clone()
                .unwrap_or_else(|| serde_json::to_value(self.policy).unwrap_or_default()),
        );
        match &self.available {
            Some(available) => {
                document.insert(
                    "available".into(),
                    serde_json::to_value(available).unwrap_or_default(),
                );
            }
            None => {
                document.remove("available");
            }
        }
        let body = serde_json::to_vec_pretty(&document)
            .map_err(|error| format!("encode desktop update settings: {error}"))?;
        write_atomically(dir, STORE_FILE, &body, "desktop update settings")
    }
}

/// Write-then-rename so a crash never leaves a half-written file; a failed
/// rename removes its temporary file.
fn write_atomically(dir: &Path, name: &str, body: &[u8], what: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|error| format!("create {}: {error}", dir.display()))?;
    let temporary = dir.join(format!("{name}.{}.tmp", std::process::id()));
    std::fs::write(&temporary, body).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        format!("write {what}: {error}")
    })?;
    std::fs::rename(&temporary, dir.join(name)).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        format!("persist {what}: {error}")
    })
}

/// The downloaded package, kept on disk (in the app cache directory) rather
/// than in memory while it waits for a confirmed restart, so it survives a
/// quit. `package.json` is written last and names the version, the release
/// manifest the native handle is restored from, and the bytes' SHA-256.
#[derive(Clone, Debug)]
pub struct PackageStore {
    dir: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageRecord {
    pub version: String,
    pub manifest: serde_json::Value,
    pub sha256: String,
    pub length: u64,
}

const PACKAGE_FILE: &str = "package.bin";
/// Far above any Station desktop package (about 150–250 MB today).
pub const MAX_PACKAGE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const PACKAGE_RECORD: &str = "package.json";

fn sha256_hex(bytes: &[u8]) -> String {
    ring::digest::digest(&ring::digest::SHA256, bytes)
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

impl PackageStore {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn save(
        &self,
        version: &str,
        manifest: serde_json::Value,
        bytes: &[u8],
    ) -> Result<(), String> {
        // The record goes first out and last in: a crash between the two
        // writes leaves no record, which reads as no package.
        let _ = std::fs::remove_file(self.dir.join(PACKAGE_RECORD));
        write_atomically(&self.dir, PACKAGE_FILE, bytes, "the downloaded update")?;
        let record = PackageRecord {
            version: version.to_string(),
            manifest,
            sha256: sha256_hex(bytes),
            length: bytes.len() as u64,
        };
        let body = serde_json::to_vec_pretty(&record)
            .map_err(|error| format!("encode the update record: {error}"))?;
        write_atomically(&self.dir, PACKAGE_RECORD, &body, "the update record")
    }

    pub fn record(&self) -> Option<PackageRecord> {
        let raw = std::fs::read_to_string(self.dir.join(PACKAGE_RECORD)).ok()?;
        serde_json::from_str(&raw).ok()
    }

    /// The package bytes for `version`, only if the record names that
    /// version and the bytes still hash to what was written.
    pub fn load(&self, version: &str) -> Result<Vec<u8>, String> {
        let record = self
            .record()
            .ok_or_else(|| "the downloaded update is missing; download it again".to_string())?;
        if record.version != version {
            return Err(format!(
                "the downloaded update is version {}, not {version}; download it again",
                record.version
            ));
        }
        // Size first, so a damaged record or file cannot make this read an
        // unbounded amount into memory.
        let path = self.dir.join(PACKAGE_FILE);
        let size = std::fs::metadata(&path)
            .map_err(|error| format!("read the downloaded update: {error}"))?
            .len();
        if record.length > MAX_PACKAGE_BYTES || size != record.length {
            return Err("the downloaded update is damaged; download it again".to_string());
        }
        let bytes =
            std::fs::read(&path).map_err(|error| format!("read the downloaded update: {error}"))?;
        if bytes.len() as u64 != record.length || sha256_hex(&bytes) != record.sha256 {
            return Err("the downloaded update is damaged; download it again".to_string());
        }
        Ok(bytes)
    }

    /// Removes the package, its record and any temporary file a crash left
    /// mid-write.
    pub fn clear(&self) {
        let debris = std::fs::read_dir(&self.dir)
            .map(|entries| {
                entries
                    .flatten()
                    .map(|entry| entry.file_name().to_string_lossy().to_string())
                    .filter(|name| name.ends_with(".tmp"))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for name in [PACKAGE_RECORD, PACKAGE_FILE]
            .into_iter()
            .map(str::to_string)
            .chain(debris)
        {
            match std::fs::remove_file(self.dir.join(&name)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => log::warn!("could not remove a cached desktop update: {error}"),
            }
        }
    }
}

/// The native update handle's identity, as far as the cache needs it.
pub trait UpdateHandle: Clone + Send + 'static {
    fn version(&self) -> &str;
    /// The release manifest the handle can be restored from after a restart.
    fn manifest(&self) -> serde_json::Value;
}

/// What a successful check found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Offer {
    pub version: String,
    pub notes: Option<String>,
}

#[derive(Default)]
struct ProgressThrottle {
    last_emit_ms: Option<u64>,
    last_percent: Option<u64>,
}

impl ProgressThrottle {
    fn should_emit(&mut self, downloaded: u64, total: Option<u64>, now: u64) -> bool {
        if self
            .last_emit_ms
            .is_some_and(|last| now.saturating_sub(last) < PROGRESS_MIN_INTERVAL_MS)
        {
            return false;
        }
        let percent = total
            .filter(|total| *total > 0)
            .map(|total| downloaded.min(total) * 100 / total);
        if percent.is_some() && percent == self.last_percent {
            return false;
        }
        self.last_emit_ms = Some(now);
        self.last_percent = percent;
        true
    }
}

/// The pure state machine. `H` is the native update handle (the plugin's
/// `Update` in the app, a stand-in in tests).
pub struct Controller<H> {
    phase: UpdatePhase,
    error: Option<UpdateError>,
    persisted: Persisted,
    store_dir: Option<PathBuf>,
    current_version: String,
    handle: Option<H>,
    sequence: u64,
    /// The phase a running check or download returns to when it fails.
    resume_phase: Option<UpdatePhase>,
    throttle: ProgressThrottle,
}

impl<H: Clone> Controller<H> {
    pub fn new(enabled: bool, current_version: String, store_dir: Option<PathBuf>) -> Self {
        let persisted = store_dir
            .as_deref()
            .map(Persisted::load)
            .unwrap_or_default();
        Self {
            phase: if enabled {
                UpdatePhase::Idle
            } else {
                UpdatePhase::Disabled
            },
            error: None,
            persisted,
            store_dir,
            current_version,
            handle: None,
            sequence: 0,
            resume_phase: None,
            throttle: ProgressThrottle::default(),
        }
    }

    pub fn state(&self) -> DesktopUpdateState {
        DesktopUpdateState {
            phase: self.phase.clone(),
            error: self.error.clone(),
            policy: self.persisted.policy,
            current_version: self.current_version.clone(),
            auto_download_at: self.auto_download_at(),
            sequence: self.sequence,
        }
    }

    fn auto_download_at(&self) -> Option<u64> {
        let UpdatePhase::Available {
            available_since, ..
        } = &self.phase
        else {
            return None;
        };
        match self.persisted.policy {
            DownloadPolicy::Never => None,
            DownloadPolicy::Immediately => Some(*available_since),
            DownloadPolicy::After24h => {
                Some(available_since.saturating_add(AUTO_DOWNLOAD_DELAY_MS))
            }
        }
    }

    /// Whether the policy says the available update should download now.
    /// A failed automatic download is retried at the next periodic tick.
    pub fn auto_download_due(&self, now: u64) -> bool {
        self.auto_download_at().is_some_and(|at| now >= at)
    }

    fn persist(&self) -> Result<(), String> {
        match &self.store_dir {
            Some(dir) => self.persisted.save(dir),
            None => Ok(()),
        }
    }

    /// Persist first, then adopt: a policy that could not be saved would
    /// silently revert at the next launch, so it is refused instead.
    pub fn set_policy(&mut self, policy: DownloadPolicy) -> Result<(), String> {
        let previous = (self.persisted.policy, self.persisted.unknown_policy.take());
        self.persisted.policy = policy;
        if let Err(error) = self.persist() {
            (self.persisted.policy, self.persisted.unknown_policy) = previous;
            return Err(error);
        }
        Ok(())
    }

    /// Only an idle, up-to-date or available state may start a check. A
    /// downloaded or in-flight update is not replaced by a newer offer.
    pub fn begin_check(&mut self) -> bool {
        if !matches!(
            self.phase,
            UpdatePhase::Idle | UpdatePhase::UpToDate { .. } | UpdatePhase::Available { .. }
        ) {
            return false;
        }
        if self
            .error
            .as_ref()
            .is_some_and(|error| error.context == ErrorContext::Check)
        {
            self.error = None;
        }
        self.resume_phase = Some(std::mem::replace(&mut self.phase, UpdatePhase::Checking));
        true
    }

    pub fn finish_check(&mut self, result: Result<Option<(Offer, H)>, String>, now: u64) {
        if self.phase != UpdatePhase::Checking {
            return;
        }
        let resume = self.resume_phase.take().unwrap_or(UpdatePhase::Idle);
        match result {
            Ok(None) => {
                self.phase = UpdatePhase::UpToDate { checked_at: now };
                self.handle = None;
                self.error = None;
                if self.persisted.available.take().is_some() {
                    if let Err(error) = self.persist() {
                        log::warn!("could not clear the persisted desktop update: {error}");
                    }
                }
            }
            Ok(Some((offer, handle))) => {
                // The 24h clock belongs to a version: a newer offer gets its
                // own bake time, the same offer keeps its original start.
                // A start in the future (a clock that moved back, or a
                // tampered file) would postpone the download indefinitely.
                let since = match &self.persisted.available {
                    Some(previous)
                        if previous.version == offer.version && previous.since <= now =>
                    {
                        previous.since
                    }
                    _ => now,
                };
                let record = PersistedAvailable {
                    version: offer.version.clone(),
                    since,
                };
                if self.persisted.available.as_ref() != Some(&record) {
                    self.persisted.available = Some(record);
                    if let Err(error) = self.persist() {
                        log::warn!("could not persist the desktop update clock: {error}");
                    }
                }
                // A download failure for this same version stays visible.
                if !self
                    .error
                    .as_ref()
                    .is_some_and(|error| error.version.as_deref() == Some(offer.version.as_str()))
                {
                    self.error = None;
                }
                self.phase = UpdatePhase::Available {
                    version: offer.version,
                    notes: offer.notes,
                    available_since: since,
                };
                self.handle = Some(handle);
            }
            Err(message) => {
                self.phase = resume;
                self.error = Some(UpdateError {
                    context: ErrorContext::Check,
                    message,
                    version: None,
                });
            }
        }
    }

    /// Starts a download of the available update, returning the native
    /// handle to download with.
    pub fn begin_download(&mut self) -> Option<H> {
        let UpdatePhase::Available { version, .. } = &self.phase else {
            return None;
        };
        let handle = self.handle.clone()?;
        let version = version.clone();
        self.error = None;
        self.throttle = ProgressThrottle::default();
        self.resume_phase = Some(std::mem::replace(
            &mut self.phase,
            UpdatePhase::Downloading {
                version,
                downloaded_bytes: 0,
                total_bytes: None,
            },
        ));
        Some(handle)
    }

    /// Accumulates one chunk; returns whether this progress should be
    /// emitted (see [`PROGRESS_MIN_INTERVAL_MS`]).
    pub fn record_progress(&mut self, chunk: usize, total: Option<u64>, now: u64) -> bool {
        let UpdatePhase::Downloading {
            downloaded_bytes,
            total_bytes,
            ..
        } = &mut self.phase
        else {
            return false;
        };
        *downloaded_bytes = downloaded_bytes.saturating_add(chunk as u64);
        *total_bytes = total;
        let downloaded = *downloaded_bytes;
        self.throttle.should_emit(downloaded, total, now)
    }

    /// `result` is the outcome of downloading and caching the package.
    pub fn finish_download(&mut self, result: Result<(), String>) {
        let UpdatePhase::Downloading { version, .. } = &self.phase else {
            return;
        };
        let version = version.clone();
        let resume = self.resume_phase.take();
        match result {
            Ok(()) => {
                self.phase = UpdatePhase::Ready { version };
            }
            Err(message) => {
                self.phase = resume.unwrap_or(UpdatePhase::Idle);
                self.error = Some(UpdateError {
                    context: ErrorContext::Download,
                    message,
                    version: Some(version),
                });
            }
        }
    }

    /// Adopts a package cached by an earlier run as `ready`. Only from
    /// `idle`, i.e. at startup before any check.
    pub fn restore_ready(&mut self, handle: H, version: String) -> bool {
        if self.phase != UpdatePhase::Idle {
            return false;
        }
        self.handle = Some(handle);
        self.phase = UpdatePhase::Ready { version };
        true
    }

    /// A restored package the release feed no longer offers (withdrawn, or
    /// superseded): fold the feed's answer in as an ordinary check result.
    /// Only from `ready`; a request to install that raced ahead wins.
    pub fn withdraw_ready(&mut self, offer: Option<(Offer, H)>, now: u64) -> bool {
        if !matches!(self.phase, UpdatePhase::Ready { .. }) {
            return false;
        }
        self.handle = None;
        self.resume_phase = Some(UpdatePhase::Idle);
        self.phase = UpdatePhase::Checking;
        self.finish_check(Ok(offer), now);
        true
    }

    /// Starts installing the downloaded update; returns the handle and the
    /// version whose cached package must be installed.
    pub fn begin_install(&mut self) -> Option<(H, String)> {
        let UpdatePhase::Ready { version } = &self.phase else {
            return None;
        };
        let version = version.clone();
        let handle = self.handle.clone()?;
        self.error = None;
        self.phase = UpdatePhase::Installing {
            version: version.clone(),
        };
        Some((handle, version))
    }

    /// The cached package is missing or damaged: there is nothing to retry,
    /// so the update is dropped and the next check offers it again.
    pub fn discard_package(&mut self, message: String) {
        let UpdatePhase::Installing { version } = &self.phase else {
            return;
        };
        self.error = Some(UpdateError {
            context: ErrorContext::Install,
            message,
            version: Some(version.clone()),
        });
        self.handle = None;
        self.phase = UpdatePhase::Idle;
    }

    /// On success the phase stays `installing` until the process restarts.
    /// On failure the cached package stays for a retry.
    pub fn finish_install(&mut self, result: Result<(), String>) {
        let UpdatePhase::Installing { version } = &self.phase else {
            return;
        };
        if let Err(message) = result {
            let version = version.clone();
            self.error = Some(UpdateError {
                context: ErrorContext::Install,
                message,
                version: Some(version.clone()),
            });
            self.phase = UpdatePhase::Ready { version };
        }
    }
}

type Emit = dyn Fn(&DesktopUpdateState) + Send + Sync;
type Clock = dyn Fn() -> u64 + Send + Sync;
/// Per-chunk progress callback handed to the download operation.
pub type OnChunk = Box<dyn FnMut(usize, Option<u64>) + Send>;

/// Serialized access to the [`Controller`] plus the one emission path.
pub struct DesktopUpdater<H> {
    controller: Arc<Mutex<Controller<H>>>,
    emit: Arc<Emit>,
    clock: Arc<Clock>,
    packages: PackageStore,
}

impl<H> Clone for DesktopUpdater<H> {
    fn clone(&self) -> Self {
        Self {
            controller: Arc::clone(&self.controller),
            emit: Arc::clone(&self.emit),
            clock: Arc::clone(&self.clock),
            packages: self.packages.clone(),
        }
    }
}

impl<H: UpdateHandle> DesktopUpdater<H> {
    pub fn new(
        controller: Controller<H>,
        emit: Arc<Emit>,
        clock: Arc<Clock>,
        packages: PackageStore,
    ) -> Self {
        Self {
            controller: Arc::new(Mutex::new(controller)),
            emit,
            clock,
            packages,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Controller<H>> {
        self.controller
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn snapshot(&self) -> DesktopUpdateState {
        self.lock().state()
    }

    pub fn now(&self) -> u64 {
        (self.clock)()
    }

    /// Applies one transition and emits the resulting state when it changed.
    /// The lock is released before emitting.
    fn update<T>(&self, transition: impl FnOnce(&mut Controller<H>) -> T) -> T {
        let (value, emitted) = {
            let mut controller = self.lock();
            let before = controller.state();
            let value = transition(&mut controller);
            let emitted = (controller.state() != before).then(|| {
                controller.sequence += 1;
                controller.state()
            });
            (value, emitted)
        };
        if let Some(state) = emitted {
            (self.emit)(&state);
        }
        value
    }

    pub fn set_policy(&self, policy: DownloadPolicy) -> Result<DesktopUpdateState, String> {
        self.update(|controller| controller.set_policy(policy))?;
        Ok(self.snapshot())
    }

    pub fn auto_download_due(&self) -> bool {
        let now = self.now();
        self.lock().auto_download_due(now)
    }

    /// Runs one check through `check`. A refused start (already busy, or
    /// disabled) returns the current state without calling `check`.
    pub async fn check<F, Fut>(&self, check: F) -> DesktopUpdateState
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Option<(Offer, H)>, String>>,
    {
        if !self.update(Controller::begin_check) {
            return self.snapshot();
        }
        let result = check().await;
        let now = self.now();
        self.update(|controller| controller.finish_check(result, now));
        self.snapshot()
    }

    /// Downloads the available update through `download`, emitting
    /// throttled byte progress. Refused (no call) unless an update is
    /// available.
    pub async fn download<F, Fut>(&self, download: F) -> DesktopUpdateState
    where
        F: FnOnce(H, OnChunk) -> Fut,
        Fut: Future<Output = Result<Vec<u8>, String>>,
    {
        let Some(handle) = self.update(Controller::begin_download) else {
            return self.snapshot();
        };
        let progress = self.clone();
        let on_chunk: OnChunk = Box::new(move |chunk, total| {
            let now = progress.now();
            let emitted = {
                let mut controller = progress.lock();
                controller.record_progress(chunk, total, now).then(|| {
                    controller.sequence += 1;
                    controller.state()
                })
            };
            if let Some(state) = emitted {
                (progress.emit)(&state);
            }
        });
        let version = handle.version().to_string();
        let manifest = handle.manifest();
        // The bytes live on disk from here on; the in-memory copy is dropped
        // as soon as it is written.
        let result = download(handle, on_chunk)
            .await
            .and_then(|bytes| self.packages.save(&version, manifest, &bytes));
        if result.is_err() {
            self.packages.clear();
        }
        self.update(|controller| controller.finish_download(result));
        self.snapshot()
    }

    /// Installs the downloaded update through the blocking `install`.
    /// Returns `true` only when the install succeeded and the caller should
    /// now restart; the phase then stays `installing`.
    pub fn install<F>(&self, install: F) -> bool
    where
        F: FnOnce(&H, &[u8]) -> Result<(), String>,
    {
        let Some((handle, version)) = self.update(Controller::begin_install) else {
            return false;
        };
        let bytes = match self.packages.load(&version) {
            Ok(bytes) => bytes,
            Err(message) => {
                self.packages.clear();
                self.update(|controller| controller.discard_package(message));
                return false;
            }
        };
        let result = install(&handle, &bytes);
        let installed = result.is_ok();
        self.update(|controller| controller.finish_install(result));
        installed
    }

    /// After a restore: ask the feed whether the cached version is still the
    /// one it offers. Ready is otherwise never re-checked, so a withdrawn
    /// release would wait forever. Without an answer (offline, a failing
    /// feed) the package is kept. A different offer, newer or older,
    /// replaces it: the cached package is deleted and the offer becomes an
    /// ordinary `available` (or `up-to-date` when nothing is offered).
    pub async fn revalidate_restored<C, CF>(&self, check: C)
    where
        C: FnOnce() -> CF,
        CF: Future<Output = Result<Option<(Offer, H)>, String>>,
    {
        let UpdatePhase::Ready { version } = self.snapshot().phase else {
            return;
        };
        match check().await {
            Err(error) => {
                log::info!("kept cached desktop update {version}; the feed did not answer: {error}")
            }
            Ok(Some((offer, _))) if offer.version == version => {}
            Ok(offer) => {
                let now = self.now();
                let packages = self.packages.clone();
                self.update(|controller| {
                    let withdrawn = controller.withdraw_ready(offer, now);
                    if withdrawn {
                        packages.clear();
                    }
                    withdrawn
                });
                log::info!("dropped cached desktop update {version}: the feed no longer offers it");
            }
        }
    }

    /// At startup: adopt a package an earlier run downloaded, if `restore`
    /// rebuilds a handle for it (the release is still newer than this app)
    /// and the bytes pass verification. Anything else is deleted. Returns
    /// whether a package was restored.
    pub fn restore_cached<F>(&self, restore: F) -> bool
    where
        F: FnOnce(&serde_json::Value, &[u8]) -> Result<Option<H>, String>,
    {
        let Some(record) = self.packages.record() else {
            self.packages.clear();
            return false;
        };
        let restored = self
            .packages
            .load(&record.version)
            .and_then(|bytes| restore(&record.manifest, &bytes));
        match restored {
            Ok(Some(handle)) if handle.version() == record.version => {
                let version = record.version.clone();
                if self.update(|controller| controller.restore_ready(handle, version)) {
                    return true;
                }
            }
            Ok(_) => log::info!(
                "discarding cached desktop update {}: no longer an update",
                record.version
            ),
            Err(error) => log::warn!(
                "discarding cached desktop update {}: {error}",
                record.version
            ),
        }
        self.packages.clear();
        false
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// The longest single sleep of the periodic schedule. The schedule follows
/// wall-clock time: a machine that slept past the due time checks within one
/// step of waking instead of a whole interval later.
pub const SCHEDULE_STEP: Duration = Duration::from_secs(30);

/// How long to sleep next before wall-clock `due`; `None` once it is due.
pub fn schedule_step(now: u64, due: u64) -> Option<Duration> {
    (now < due).then(|| Duration::from_millis(due - now).min(SCHEDULE_STEP))
}

/// Sleeps in short steps until wall-clock `due`.
pub fn wait_until(due: u64, clock: &dyn Fn() -> u64, sleep: &dyn Fn(Duration)) {
    while let Some(step) = schedule_step(clock(), due) {
        sleep(step);
    }
}

/// One periodic tick: check, then download if the policy says so. It is
/// handed no install operation and no app handle, so a tick cannot install
/// or restart; restart stays behind the confirmed install command.
pub async fn periodic_tick<H, C, CF, D, DF>(
    updater: &DesktopUpdater<H>,
    check: C,
    download: D,
) -> DesktopUpdateState
where
    H: UpdateHandle,
    C: FnOnce() -> CF,
    CF: Future<Output = Result<Option<(Offer, H)>, String>>,
    D: FnOnce(H, OnChunk) -> DF,
    DF: Future<Output = Result<Vec<u8>, String>>,
{
    let state = updater.check(check).await;
    if let Some(error) = &state.error {
        log::info!("desktop update check did not complete: {}", error.message);
    }
    if updater.auto_download_due() {
        log::info!("downloading the available desktop update per the download policy");
        return updater.download(download).await;
    }
    updater.snapshot()
}

/// Startup for a managed updater: an unconfigured build starts no periodic
/// check (and so restores nothing).
pub fn start<H, P>(updater: &DesktopUpdater<H>, enabled: bool, start_periodic: P)
where
    H: UpdateHandle,
    P: FnOnce(DesktopUpdater<H>),
{
    if enabled {
        start_periodic(updater.clone());
    }
}

/// The first thing the periodic thread does, off the setup thread: restore
/// a cached package (reading and verifying it can take seconds for a large
/// package; the state reads `idle` meanwhile), then confirm the feed still
/// offers it.
pub async fn restore_on_startup<H, R, C, CF>(updater: &DesktopUpdater<H>, restore: R, check: C)
where
    H: UpdateHandle,
    R: FnOnce(&serde_json::Value, &[u8]) -> Result<Option<H>, String>,
    C: FnOnce() -> CF,
    CF: Future<Output = Result<Option<(Offer, H)>, String>>,
{
    if updater.restore_cached(restore) {
        updater.revalidate_restored(check).await;
    }
}

pub use tauri_glue::*;

mod tauri_glue {
    use super::*;
    use tauri::{AppHandle, Emitter, Manager, Runtime, State};
    use tauri_plugin_updater::{Update, UpdaterExt};

    pub type AppDesktopUpdater = DesktopUpdater<Update>;

    impl UpdateHandle for Update {
        fn version(&self) -> &str {
            &self.version
        }
        fn manifest(&self) -> serde_json::Value {
            self.raw_json.clone()
        }
    }

    /// The updater's HTTP bounds. A check is bounded in total; a download
    /// may legitimately take minutes, so it has no total bound, and a
    /// connection that stops delivering bytes for `stall` fails instead of
    /// hanging in `downloading` forever.
    #[derive(Clone, Copy, Debug)]
    pub struct Timeouts {
        pub check: Duration,
        pub stall: Duration,
    }

    pub const TIMEOUTS: Timeouts = Timeouts {
        check: Duration::from_secs(30),
        stall: Duration::from_secs(60),
    };

    fn build_updater<R: Runtime>(
        app: &AppHandle<R>,
        timeouts: Timeouts,
    ) -> Result<tauri_plugin_updater::Updater, String> {
        let stall = timeouts.stall;
        app.updater_builder()
            .timeout(timeouts.check)
            // Copied into every update handle's client, so it also bounds
            // downloads.
            .configure_client(move |client| client.read_timeout(stall))
            .build()
            .map_err(|error| error.to_string())
    }

    /// Manages the updater state for the app. `enabled` is the existing
    /// `desktop_updater_plugin_configured` decision: an unconfigured build
    /// reports `disabled`, restores nothing and never checks.
    pub fn manage<R: Runtime>(app: &AppHandle<R>, enabled: bool) {
        let emitter = app.clone();
        let packages = PackageStore::new(
            app.path()
                .app_cache_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join(&app.config().identifier))
                .join("desktop-update"),
        );
        let updater = AppDesktopUpdater::new(
            Controller::new(
                enabled,
                app.package_info().version.to_string(),
                app.path().app_config_dir().ok(),
            ),
            Arc::new(move |state: &DesktopUpdateState| {
                if let Err(error) = emitter.emit(STATE_EVENT, state) {
                    log::warn!("could not emit desktop update state: {error}");
                }
            }),
            Arc::new(now_ms),
            packages,
        );
        app.manage(updater.clone());
        let periodic_app = app.clone();
        start(&updater, enabled, move |updater| {
            start_periodic_check(periodic_app, updater)
        });
    }

    /// The in-process re-check (owner preference: no OS job, cron or
    /// launchd). One named thread waits on wall-clock time between ticks;
    /// it lives exactly as long as the app process.
    fn start_periodic_check<R: Runtime>(app: AppHandle<R>, updater: AppDesktopUpdater) {
        let spawned = std::thread::Builder::new()
            .name("station-desktop-update".into())
            .spawn(move || {
                let sleep = |step: Duration| std::thread::sleep(step);
                tauri::async_runtime::block_on(restore_on_startup(
                    &updater,
                    |manifest, bytes| native_restore(&app, manifest, bytes),
                    || native_check(&app, TIMEOUTS),
                ));
                let mut due = now_ms() + FIRST_CHECK_DELAY.as_millis() as u64;
                loop {
                    wait_until(due, &now_ms, &sleep);
                    tauri::async_runtime::block_on(periodic_tick(
                        &updater,
                        || native_check(&app, TIMEOUTS),
                        native_download,
                    ));
                    due = now_ms() + CHECK_INTERVAL.as_millis() as u64;
                }
            });
        if let Err(error) = spawned {
            log::error!("could not start the desktop update check thread: {error}");
        }
    }

    pub(super) async fn native_check<R: Runtime>(
        app: &AppHandle<R>,
        timeouts: Timeouts,
    ) -> Result<Option<(Offer, Update)>, String> {
        match build_updater(app, timeouts)?.check().await {
            Ok(Some(update)) => Ok(Some((
                Offer {
                    version: update.version.clone(),
                    notes: update.body.clone(),
                },
                update,
            ))),
            Ok(None) => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    /// Rebuilds the handle for a cached package and verifies its bytes with
    /// the plugin's own signature check. `restore_update` returns nothing
    /// when the release is no longer newer than this app.
    pub(super) fn native_restore<R: Runtime>(
        app: &AppHandle<R>,
        manifest: &serde_json::Value,
        bytes: &[u8],
    ) -> Result<Option<Update>, String> {
        let Some(update) = build_updater(app, TIMEOUTS)?
            .restore_update(manifest.clone())
            .map_err(|error| error.to_string())?
        else {
            return Ok(None);
        };
        update.verify(bytes).map_err(|error| error.to_string())?;
        Ok(Some(update))
    }

    /// The handle a download runs with: no total timeout, leaving the stall
    /// bound from [`build_updater`]. tauri-plugin-updater 2.14 already builds
    /// checked handles without the check's timeout (pinned by
    /// `a_download_is_not_cut_off_by_the_checks_total_timeout`); clearing it
    /// here keeps that true if a plugin upgrade starts copying it.
    pub(super) fn for_download(mut update: Update) -> Update {
        update.timeout = None;
        update
    }

    pub(super) async fn native_download(
        update: Update,
        mut on_chunk: OnChunk,
    ) -> Result<Vec<u8>, String> {
        for_download(update)
            .download(|chunk, total| on_chunk(chunk, total), || {})
            .await
            .map_err(|error| error.to_string())
    }

    #[tauri::command]
    pub fn desktop_update_state(updater: State<'_, AppDesktopUpdater>) -> DesktopUpdateState {
        updater.snapshot()
    }

    #[tauri::command]
    pub async fn desktop_update_check<R: Runtime>(
        app: AppHandle<R>,
        updater: State<'_, AppDesktopUpdater>,
    ) -> Result<DesktopUpdateState, String> {
        let updater = updater.inner().clone();
        updater.check(|| native_check(&app, TIMEOUTS)).await;
        spawn_download_if_due(&updater);
        Ok(updater.snapshot())
    }

    /// The command paths return immediately; the download reports itself on
    /// [`STATE_EVENT`].
    fn spawn_download_if_due(updater: &AppDesktopUpdater) {
        if updater.auto_download_due() {
            let background = updater.clone();
            tauri::async_runtime::spawn(async move {
                background.download(native_download).await;
            });
        }
    }

    /// Starts a download and returns at once; progress and the outcome
    /// arrive on [`STATE_EVENT`].
    #[tauri::command]
    pub fn desktop_update_download(updater: State<'_, AppDesktopUpdater>) -> DesktopUpdateState {
        let updater = updater.inner().clone();
        let background = updater.clone();
        tauri::async_runtime::spawn(async move {
            background.download(native_download).await;
        });
        updater.snapshot()
    }

    /// Installs the downloaded update and, only if that succeeded, restarts.
    /// The webview calls this after the user confirmed the restart. The
    /// returned state tells a caller whose request was refused (no `ready`
    /// update) that nothing is installing.
    #[tauri::command]
    pub async fn desktop_update_install<R: Runtime>(
        app: AppHandle<R>,
        updater: State<'_, AppDesktopUpdater>,
    ) -> Result<DesktopUpdateState, String> {
        let updater = updater.inner().clone();
        let installer = updater.clone();
        let installed = tauri::async_runtime::spawn_blocking(move || {
            // `Update::install` verifies the signature of the bytes first.
            installer
                .install(|update, bytes| update.install(bytes).map_err(|error| error.to_string()))
        })
        .await
        .map_err(|error| format!("desktop update install task failed: {error}"))?;
        if installed {
            log::info!("desktop update installed; restarting");
            app.request_restart();
        }
        Ok(updater.snapshot())
    }

    #[tauri::command]
    pub async fn desktop_update_set_policy(
        policy: DownloadPolicy,
        updater: State<'_, AppDesktopUpdater>,
    ) -> Result<DesktopUpdateState, String> {
        let updater = updater.inner().clone();
        let state = updater.set_policy(policy)?;
        // A policy that is already due (e.g. switching to `immediately`)
        // takes effect now rather than at the next hourly tick.
        spawn_download_if_due(&updater);
        Ok(state)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::io::{Read, Write};
        use std::net::{TcpListener, TcpStream};
        use std::sync::atomic::{AtomicU64, Ordering};
        use std::time::Instant;

        const BODY_LENGTH: usize = 10 * 1024;

        /// A loopback release feed: `/latest.json` announces 99.0.0, `/slow`
        /// streams the package in ten pieces 100 ms apart, `/stall` sends
        /// the headers and a few bytes, then nothing.
        fn serve(listener: TcpListener) {
            let port = listener.local_addr().unwrap().port();
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    std::thread::spawn(move || answer(stream, port));
                }
            });
        }

        fn answer(mut stream: TcpStream, port: u16) {
            let mut request = [0u8; 4096];
            let read = stream.read(&mut request).unwrap_or(0);
            let request = String::from_utf8_lossy(&request[..read]).to_string();
            let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
            let target = tauri_plugin_updater::target().unwrap();
            match path.as_str() {
                "/latest.json" | "/stall.json" => {
                    let package = if path == "/latest.json" {
                        "slow"
                    } else {
                        "stall"
                    };
                    let body = serde_json::json!({
                        "version": "99.0.0",
                        "platforms": { target: {
                            "url": format!("http://127.0.0.1:{port}/{package}"),
                            "signature": "not-a-signature",
                        }},
                    })
                    .to_string();
                    let _ = write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                }
                "/slow" | "/stall" => {
                    let _ = write!(
                        stream,
                        "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {BODY_LENGTH}\r\nConnection: close\r\n\r\n"
                    );
                    let piece = vec![7u8; BODY_LENGTH / 10];
                    if path == "/slow" {
                        for _ in 0..10 {
                            let _ = stream.write_all(&piece);
                            let _ = stream.flush();
                            std::thread::sleep(Duration::from_millis(100));
                        }
                    } else {
                        let _ = stream.write_all(&piece[..16]);
                        let _ = stream.flush();
                        std::thread::sleep(Duration::from_secs(8));
                    }
                }
                _ => {
                    let _ = write!(
                        stream,
                        "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"
                    );
                }
            }
        }

        fn app_for(feed: &str) -> tauri::App<tauri::test::MockRuntime> {
            app_with_key(feed, "not-a-real-key")
        }

        fn app_with_key(feed: &str, pubkey: &str) -> tauri::App<tauri::test::MockRuntime> {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            serve(listener);
            let mut context = tauri::test::mock_context(tauri::test::noop_assets());
            context.config_mut().plugins.0.insert(
                "updater".into(),
                serde_json::json!({
                    "pubkey": pubkey,
                    "endpoints": [format!("http://127.0.0.1:{port}/{feed}")],
                    "dangerousInsecureTransportProtocol": true,
                }),
            );
            tauri::test::mock_builder()
                .plugin(tauri_plugin_updater::Builder::new().build())
                .build(context)
                .unwrap()
        }

        /// Short bounds so the test is fast: the download outlasts the
        /// check's total bound, while no single gap reaches the stall bound.
        const SHORT: Timeouts = Timeouts {
            check: Duration::from_millis(300),
            stall: Duration::from_millis(600),
        };

        fn checked(app: &tauri::App<tauri::test::MockRuntime>) -> Update {
            let (offer, update) = tauri::async_runtime::block_on(native_check(app.handle(), SHORT))
                .unwrap()
                .expect("the feed announces an update");
            assert_eq!(offer.version, "99.0.0");
            update
        }

        #[test]
        fn a_download_is_not_cut_off_by_the_checks_total_timeout() {
            let app = app_for("latest.json");
            let update = checked(&app);
            // 2.14 does not copy the check's bound into the handle.
            assert!(update.timeout.is_none());
            let received = Arc::new(AtomicU64::new(0));
            let counter = Arc::clone(&received);
            let started = Instant::now();
            let result = tauri::async_runtime::block_on(native_download(
                update,
                Box::new(move |chunk, _| {
                    counter.fetch_add(chunk as u64, Ordering::SeqCst);
                }),
            ));
            // Every byte arrived although the transfer took longer than the
            // check's 300 ms bound; only the (fake) signature fails.
            assert!(started.elapsed() > SHORT.check);
            assert_eq!(received.load(Ordering::SeqCst), BODY_LENGTH as u64);
            let error = result.unwrap_err();
            assert!(!error.to_lowercase().contains("timed out"), "{error}");
        }

        #[test]
        fn a_stalled_download_fails_instead_of_hanging() {
            let app = app_for("stall.json");
            let update = checked(&app);
            let (done, finished) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let result =
                    tauri::async_runtime::block_on(native_download(update, Box::new(|_, _| {})));
                let _ = done.send(result);
            });
            let result = finished
                .recv_timeout(Duration::from_secs(4))
                .expect("a stalled download must fail within the stall bound");
            assert!(result.is_err());
        }

        // A throwaway minisign key made with `tauri signer generate`; its
        // private half was deleted. `versioned.sig` was signed with
        // `--app-version 99.0.0`, `unversioned.sig` without, as the macOS
        // release signed before #3851.
        const SIGNING_KEY: &str = include_str!("fixtures/desktop-update-signing/key.pub");
        const SIGNED_PACKAGE: &[u8] = include_bytes!("fixtures/desktop-update-signing/package.bin");
        const VERSIONED_SIGNATURE: &str =
            include_str!("fixtures/desktop-update-signing/versioned.sig");
        const UNVERSIONED_SIGNATURE: &str =
            include_str!("fixtures/desktop-update-signing/unversioned.sig");

        fn signed_manifest(signature: &str) -> serde_json::Value {
            serde_json::json!({
                "version": "99.0.0",
                "platforms": { tauri_plugin_updater::target().unwrap(): {
                    "url": "https://example.invalid/package.bin",
                    "signature": signature.trim(),
                }},
            })
        }

        /// The whole restart path with the real plugin: a package cached by
        /// one run, restored by the next through `native_restore`.
        fn restored_after_restart(
            signature: &str,
            bytes: &[u8],
        ) -> (bool, DesktopUpdateState, bool) {
            let app = app_with_key("latest.json", SIGNING_KEY.trim());
            let cache = tempfile::tempdir().unwrap();
            let packages = PackageStore::new(cache.path().to_path_buf());
            packages
                .save("99.0.0", signed_manifest(signature), bytes)
                .unwrap();
            let updater = AppDesktopUpdater::new(
                Controller::new(true, "0.1.11".into(), None),
                Arc::new(|_: &DesktopUpdateState| {}),
                Arc::new(now_ms),
                packages.clone(),
            );
            let handle = app.handle().clone();
            let restored =
                updater.restore_cached(|manifest, bytes| native_restore(&handle, manifest, bytes));
            (restored, updater.snapshot(), packages.record().is_some())
        }

        #[test]
        fn a_package_signed_for_its_version_is_restored_by_the_real_plugin() {
            let (restored, state, kept) =
                restored_after_restart(VERSIONED_SIGNATURE, SIGNED_PACKAGE);
            assert!(restored);
            assert_eq!(
                state.phase,
                UpdatePhase::Ready {
                    version: "99.0.0".into()
                }
            );
            assert!(kept);
        }

        #[test]
        fn a_package_signed_without_its_version_is_discarded_by_the_real_plugin() {
            let (restored, state, kept) =
                restored_after_restart(UNVERSIONED_SIGNATURE, SIGNED_PACKAGE);
            assert!(!restored);
            assert_eq!(state.phase, UpdatePhase::Idle);
            assert!(!kept);
            // Different bytes under a valid versioned signature fail too.
            let (restored, _, kept) =
                restored_after_restart(VERSIONED_SIGNATURE, b"tampered package");
            assert!(!restored);
            assert!(!kept);
        }

        #[test]
        fn a_cached_release_no_newer_than_this_app_is_not_restored() {
            let app = app_for("latest.json");
            let manifest = serde_json::json!({
                "version": "0.0.1",
                "platforms": { tauri_plugin_updater::target().unwrap(): {
                    "url": "https://example.invalid/pkg", "signature": "x" } },
            });
            assert!(native_restore(app.handle(), &manifest, b"bytes")
                .unwrap()
                .is_none());
            // A newer release whose bytes fail the signature check is refused.
            let mut newer = manifest.clone();
            newer["version"] = "99.0.0".into();
            assert!(native_restore(app.handle(), &newer, b"bytes").is_err());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

    const T0: u64 = 1_760_000_000_000;
    const VERSION: &str = "0.1.11";

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct FakeHandle(&'static str);

    impl UpdateHandle for FakeHandle {
        fn version(&self) -> &str {
            self.0
        }
        fn manifest(&self) -> serde_json::Value {
            serde_json::json!({ "version": self.0 })
        }
    }

    fn offer(version: &'static str) -> Option<(Offer, FakeHandle)> {
        Some((
            Offer {
                version: version.to_string(),
                notes: Some("Faster startup.".to_string()),
            },
            FakeHandle(version),
        ))
    }

    struct Harness {
        updater: DesktopUpdater<FakeHandle>,
        emitted: Arc<Mutex<Vec<DesktopUpdateState>>>,
        clock: Arc<AtomicU64>,
        cache: PathBuf,
        _cache_root: Option<tempfile::TempDir>,
    }

    impl Harness {
        fn new(enabled: bool, store_dir: Option<PathBuf>) -> Self {
            let root = tempfile::tempdir().unwrap();
            let cache = root.path().join("desktop-update");
            let mut harness = Self::with_cache(enabled, store_dir, cache);
            harness._cache_root = Some(root);
            harness
        }

        fn with_cache(enabled: bool, store_dir: Option<PathBuf>, cache: PathBuf) -> Self {
            let emitted = Arc::new(Mutex::new(Vec::new()));
            let clock = Arc::new(AtomicU64::new(T0));
            let sink = Arc::clone(&emitted);
            let time = Arc::clone(&clock);
            Self {
                updater: DesktopUpdater::new(
                    Controller::new(enabled, VERSION.to_string(), store_dir),
                    Arc::new(move |state: &DesktopUpdateState| {
                        sink.lock().unwrap().push(state.clone())
                    }),
                    Arc::new(move || time.load(Ordering::SeqCst)),
                    PackageStore::new(cache.clone()),
                ),
                emitted,
                clock,
                cache,
                _cache_root: None,
            }
        }

        fn at(&self, now: u64) {
            self.clock.store(now, Ordering::SeqCst);
        }

        fn emitted(&self) -> Vec<DesktopUpdateState> {
            self.emitted.lock().unwrap().clone()
        }

        fn check(&self, result: Result<Option<(Offer, FakeHandle)>, String>) -> DesktopUpdateState {
            tauri::async_runtime::block_on(self.updater.check(|| async move { result }))
        }

        fn download(&self, result: Result<Vec<u8>, String>) -> DesktopUpdateState {
            tauri::async_runtime::block_on(
                self.updater
                    .download(|_handle, _on_chunk| async move { result }),
            )
        }
    }

    fn fixture(name: &str) -> serde_json::Value {
        let all: serde_json::Value =
            serde_json::from_str(include_str!("fixtures/desktop-update-states.json")).unwrap();
        let mut value = all
            .get(name)
            .unwrap_or_else(|| panic!("fixture {name} is missing"))
            .clone();
        // The sequence depends on the path taken; it has its own test.
        assert!(value.as_object_mut().unwrap().remove("sequence").is_some());
        value
    }

    fn json(state: &DesktopUpdateState) -> serde_json::Value {
        let mut value = serde_json::to_value(state).unwrap();
        assert!(value.as_object_mut().unwrap().remove("sequence").is_some());
        value
    }

    #[test]
    fn an_unconfigured_build_is_disabled_and_never_checks() {
        let harness = Harness::new(false, None);
        assert_eq!(json(&harness.updater.snapshot()), fixture("disabled"));
        let called = AtomicUsize::new(0);
        tauri::async_runtime::block_on(harness.updater.check(|| async {
            called.fetch_add(1, Ordering::SeqCst);
            Ok(None)
        }));
        assert_eq!(called.load(Ordering::SeqCst), 0);
        assert!(harness.emitted().is_empty());
    }

    #[test]
    fn a_check_reports_checking_then_up_to_date() {
        let harness = Harness::new(true, None);
        assert_eq!(json(&harness.updater.snapshot()), fixture("idle"));
        let state = harness.check(Ok(None));
        assert_eq!(json(&state), fixture("upToDate"));
        let emitted = harness.emitted();
        assert_eq!(emitted.len(), 2);
        assert_eq!(json(&emitted[0]), fixture("checking"));
        assert_eq!(json(&emitted[1]), fixture("upToDate"));
    }

    #[test]
    fn a_check_failure_returns_to_the_prior_phase_with_the_error() {
        let harness = Harness::new(true, None);
        let state = harness.check(Err("error sending request for url".into()));
        assert_eq!(json(&state), fixture("checkFailed"));

        // From `available`, a failed re-check keeps the offer.
        let harness = Harness::new(true, None);
        harness.check(Ok(offer("0.1.12")));
        let state = harness.check(Err("offline".into()));
        assert!(matches!(state.phase, UpdatePhase::Available { .. }));
        assert_eq!(state.error.unwrap().context, ErrorContext::Check);
        // The next successful check clears it.
        let state = harness.check(Ok(offer("0.1.12")));
        assert_eq!(state.error, None);
    }

    #[test]
    fn an_offer_is_available_with_the_policy_download_time() {
        let harness = Harness::new(true, None);
        let state = harness.check(Ok(offer("0.1.12")));
        assert_eq!(json(&state), fixture("available"));
    }

    #[test]
    fn the_24h_clock_survives_a_restart_and_restarts_for_a_newer_version() {
        let dir = tempfile::tempdir().unwrap();
        let first = Harness::new(true, Some(dir.path().to_path_buf()));
        first.check(Ok(offer("0.1.12")));
        drop(first);

        // A new process, an hour later, sees the same version.
        let second = Harness::new(true, Some(dir.path().to_path_buf()));
        second.at(T0 + 60 * 60 * 1000);
        let state = second.check(Ok(offer("0.1.12")));
        assert_eq!(
            state.phase,
            UpdatePhase::Available {
                version: "0.1.12".into(),
                notes: Some("Faster startup.".into()),
                available_since: T0,
            }
        );
        assert!(!second.updater.auto_download_due());
        second.at(T0 + AUTO_DOWNLOAD_DELAY_MS - 1);
        assert!(!second.updater.auto_download_due());
        second.at(T0 + AUTO_DOWNLOAD_DELAY_MS);
        assert!(second.updater.auto_download_due());

        // A newer version gets its own bake time.
        let later = T0 + AUTO_DOWNLOAD_DELAY_MS + 5;
        second.at(later);
        let state = second.check(Ok(offer("0.1.13")));
        assert_eq!(state.auto_download_at, Some(later + AUTO_DOWNLOAD_DELAY_MS));
        assert!(!second.updater.auto_download_due());

        // Up to date clears the persisted clock.
        second.check(Ok(None));
        let third = Harness::new(true, Some(dir.path().to_path_buf()));
        third.at(T0 + 10 * AUTO_DOWNLOAD_DELAY_MS);
        let state = third.check(Ok(offer("0.1.13")));
        assert_eq!(
            state.auto_download_at,
            Some(T0 + 11 * AUTO_DOWNLOAD_DELAY_MS)
        );
    }

    #[test]
    fn the_policy_decides_when_an_available_update_downloads_by_itself() {
        let dir = tempfile::tempdir().unwrap();
        let harness = Harness::new(true, Some(dir.path().to_path_buf()));
        assert_eq!(harness.updater.snapshot().policy, DownloadPolicy::After24h);
        harness.check(Ok(offer("0.1.12")));

        harness
            .updater
            .set_policy(DownloadPolicy::Immediately)
            .unwrap();
        assert!(harness.updater.auto_download_due());
        assert_eq!(harness.updater.snapshot().auto_download_at, Some(T0));

        let state = harness.updater.set_policy(DownloadPolicy::Never).unwrap();
        assert_eq!(state.auto_download_at, None);
        harness.at(T0 + 100 * AUTO_DOWNLOAD_DELAY_MS);
        assert!(!harness.updater.auto_download_due());

        // Persisted across a restart.
        let restarted = Harness::new(true, Some(dir.path().to_path_buf()));
        assert_eq!(restarted.updater.snapshot().policy, DownloadPolicy::Never);
        let raw = std::fs::read_to_string(dir.path().join(STORE_FILE)).unwrap();
        assert!(raw.contains("\"never\""), "{raw}");
    }

    #[test]
    fn a_policy_that_cannot_be_saved_is_refused_not_silently_adopted() {
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("not-a-directory");
        std::fs::write(&blocker, "file").unwrap();
        let harness = Harness::new(true, Some(blocker));
        assert!(harness.updater.set_policy(DownloadPolicy::Never).is_err());
        assert_eq!(harness.updater.snapshot().policy, DownloadPolicy::After24h);
        assert!(harness.emitted().is_empty());
    }

    #[test]
    fn a_malformed_settings_file_falls_back_to_defaults() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(STORE_FILE), "{not json").unwrap();
        let harness = Harness::new(true, Some(dir.path().to_path_buf()));
        assert_eq!(harness.updater.snapshot().policy, DownloadPolicy::After24h);
    }

    #[test]
    fn a_download_emits_throttled_byte_progress_and_ends_ready() {
        let harness = Harness::new(true, None);
        harness.check(Ok(offer("0.1.12")));
        let before = harness.emitted().len();
        let clock = Arc::clone(&harness.clock);
        let total = 100_000_000u64;
        let state = tauri::async_runtime::block_on(harness.updater.download(
            move |handle, mut on_chunk| async move {
                assert_eq!(handle, FakeHandle("0.1.12"));
                // 420 chunks of 100 KB, 20 ms apart: one whole percent
                // every 200 ms over 8.4 s.
                for index in 0..420u64 {
                    clock.store(T0 + index * 20, Ordering::SeqCst);
                    on_chunk(100_000, Some(total));
                }
                Ok(vec![1, 2, 3])
            },
        ));
        assert_eq!(json(&state), fixture("ready"));

        let progress: Vec<_> = harness.emitted()[before..]
            .iter()
            .filter_map(|state| match &state.phase {
                UpdatePhase::Downloading {
                    downloaded_bytes,
                    total_bytes,
                    ..
                } => Some((*downloaded_bytes, *total_bytes)),
                _ => None,
            })
            .collect();
        // The start (0 bytes) plus one event per whole percent (0..=42):
        // 44 events for 420 chunks, not one per chunk.
        assert_eq!(progress.len(), 44, "{progress:?}");
        assert_eq!(progress[0], (0, None));
        assert!(progress[1..]
            .iter()
            .all(|(_, total_bytes)| *total_bytes == Some(total)));
        assert!(progress.windows(2).all(|pair| pair[0].0 < pair[1].0));
        assert_eq!(progress.last().unwrap().0, 42_000_000);
        let last_downloading = harness.emitted()[before..]
            .iter()
            .rev()
            .find(|state| matches!(state.phase, UpdatePhase::Downloading { .. }))
            .cloned()
            .unwrap();
        assert_eq!(json(&last_downloading), fixture("downloading"));
    }

    #[test]
    fn the_throttle_emits_on_whole_percent_changes_at_most_ten_times_a_second() {
        let mut throttle = ProgressThrottle::default();
        assert!(throttle.should_emit(0, Some(1000), 0));
        // Within 100 ms: suppressed even though the percentage moved.
        assert!(!throttle.should_emit(500, Some(1000), 99));
        assert!(throttle.should_emit(500, Some(1000), 100));
        // Same whole percent: suppressed even after the interval.
        assert!(!throttle.should_emit(509, Some(1000), 1000));
        assert!(throttle.should_emit(510, Some(1000), 1000));
        // Unknown total: time-throttled only.
        let mut unknown = ProgressThrottle::default();
        assert!(unknown.should_emit(1, None, 0));
        assert!(!unknown.should_emit(2, None, 50));
        assert!(unknown.should_emit(3, None, 150));
    }

    #[test]
    fn a_failed_download_returns_to_available_with_the_error() {
        let harness = Harness::new(true, None);
        harness.check(Ok(offer("0.1.12")));
        let state = harness.download(Err(
            "Download request failed with status: 503 Service Unavailable".into(),
        ));
        assert_eq!(json(&state), fixture("downloadFailed"));
        // A re-check of the same version keeps that download error visible.
        let state = harness.check(Ok(offer("0.1.12")));
        assert_eq!(state.error.unwrap().context, ErrorContext::Download);
        // Retrying the download clears it.
        let state = harness.download(Ok(vec![1]));
        assert_eq!(state.error, None);
        assert!(matches!(state.phase, UpdatePhase::Ready { .. }));
    }

    #[test]
    fn nothing_is_downloaded_or_installed_out_of_order() {
        let harness = Harness::new(true, None);
        let called = AtomicUsize::new(0);
        // No offer yet: download is refused without calling the operation.
        tauri::async_runtime::block_on(harness.updater.download(|_, _| async {
            called.fetch_add(1, Ordering::SeqCst);
            Ok(vec![])
        }));
        assert!(!harness.updater.install(|_, _| {
            called.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }));
        harness.check(Ok(offer("0.1.12")));
        // Available but not downloaded: install is refused.
        assert!(!harness.updater.install(|_, _| {
            called.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }));
        assert_eq!(called.load(Ordering::SeqCst), 0);
        // A downloaded update is not replaced by a check.
        harness.download(Ok(vec![9]));
        let state = harness.check(Ok(offer("0.1.13")));
        assert_eq!(
            state.phase,
            UpdatePhase::Ready {
                version: "0.1.12".into()
            }
        );
    }

    #[test]
    fn a_failed_install_returns_to_ready_with_the_package_kept_for_a_retry() {
        let harness = Harness::new(true, None);
        harness.check(Ok(offer("0.1.12")));
        harness.download(Ok(vec![7, 7, 7]));
        let before = harness.emitted().len();
        assert!(!harness
            .updater
            .install(|_, _| Err("failed to move the new app into place".into())));
        assert_eq!(json(&harness.updater.snapshot()), fixture("installFailed"));
        assert_eq!(json(&harness.emitted()[before]), fixture("installing"));
        // The package stays on disk for the retry.
        assert_eq!(
            PackageStore::new(harness.cache.clone())
                .load("0.1.12")
                .unwrap(),
            vec![7, 7, 7]
        );

        let mut installed = Vec::new();
        assert!(harness.updater.install(|handle, bytes| {
            assert_eq!(handle, &FakeHandle("0.1.12"));
            installed.extend_from_slice(bytes);
            Ok(())
        }));
        assert_eq!(installed, vec![7, 7, 7]);
        // A successful install stays `installing` until the restart.
        assert_eq!(json(&harness.updater.snapshot()), fixture("installing"));
    }

    #[test]
    fn checks_are_refused_while_one_is_running() {
        let harness = Harness::new(true, None);
        let nested = tauri::async_runtime::block_on(harness.updater.check(|| {
            let inner = harness.updater.clone();
            async move {
                let state = inner.check(|| async { Ok(None) }).await;
                assert_eq!(state.phase, UpdatePhase::Checking);
                Ok(None)
            }
        }));
        assert!(matches!(nested.phase, UpdatePhase::UpToDate { .. }));
    }

    // --- #3851 fix round ------------------------------------------------

    fn ready_with_package(harness: &Harness, bytes: Vec<u8>) {
        harness.check(Ok(offer("0.1.12")));
        harness.download(Ok(bytes));
        assert_eq!(
            harness.updater.snapshot().phase,
            UpdatePhase::Ready {
                version: "0.1.12".into()
            }
        );
    }

    #[test]
    fn a_downloaded_package_is_cached_on_disk_with_its_manifest_and_digest() {
        let harness = Harness::new(true, None);
        ready_with_package(&harness, vec![5; 4096]);
        let store = PackageStore::new(harness.cache.clone());
        let record = store.record().expect("record written");
        assert_eq!(record.version, "0.1.12");
        assert_eq!(record.manifest, serde_json::json!({ "version": "0.1.12" }));
        assert_eq!(record.length, 4096);
        assert_eq!(record.sha256, sha256_hex(&[5; 4096]));
        assert_eq!(
            std::fs::read(harness.cache.join(PACKAGE_FILE)).unwrap(),
            vec![5; 4096]
        );
    }

    #[test]
    fn a_failed_download_leaves_no_package() {
        let harness = Harness::new(true, None);
        ready_with_package(&harness, vec![1, 2, 3]);
        // A failed download in a later run leaves no record behind.
        let other = Harness::with_cache(true, None, harness.cache.clone());
        other.check(Ok(offer("0.1.13")));
        other.download(Err("network".into()));
        assert!(PackageStore::new(harness.cache.clone()).record().is_none());
    }

    #[test]
    fn a_package_cached_by_an_earlier_run_is_restored_as_ready() {
        let first = Harness::new(true, None);
        ready_with_package(&first, vec![9, 9, 9]);

        let second = Harness::with_cache(true, None, first.cache.clone());
        let mut seen = None;
        assert!(second.updater.restore_cached(|manifest, bytes| {
            seen = Some((manifest.clone(), bytes.to_vec()));
            Ok(Some(FakeHandle("0.1.12")))
        }));
        assert_eq!(
            seen,
            Some((serde_json::json!({ "version": "0.1.12" }), vec![9, 9, 9]))
        );
        assert_eq!(json(&second.updater.snapshot()), fixture("ready"));
        // And it installs from the cached bytes.
        let mut installed = Vec::new();
        assert!(second.updater.install(|_, bytes| {
            installed.extend_from_slice(bytes);
            Ok(())
        }));
        assert_eq!(installed, vec![9, 9, 9]);
    }

    #[test]
    fn stale_damaged_or_mismatched_packages_are_deleted_at_startup() {
        // No longer an update (the restore finds no newer release).
        let first = Harness::new(true, None);
        ready_with_package(&first, vec![1]);
        let next = Harness::with_cache(true, None, first.cache.clone());
        assert!(!next.updater.restore_cached(|_, _| Ok(None)));
        assert!(PackageStore::new(first.cache.clone()).record().is_none());
        assert!(!first.cache.join(PACKAGE_FILE).exists());
        assert_eq!(next.updater.snapshot().phase, UpdatePhase::Idle);

        // Damaged bytes never reach the restore (or its signature check).
        let first = Harness::new(true, None);
        ready_with_package(&first, vec![1, 2, 3]);
        std::fs::write(first.cache.join(PACKAGE_FILE), [1, 2, 4]).unwrap();
        let next = Harness::with_cache(true, None, first.cache.clone());
        let called = AtomicUsize::new(0);
        assert!(!next.updater.restore_cached(|_, _| {
            called.fetch_add(1, Ordering::SeqCst);
            Ok(Some(FakeHandle("0.1.12")))
        }));
        assert_eq!(called.load(Ordering::SeqCst), 0);
        assert!(PackageStore::new(first.cache.clone()).record().is_none());

        // A failed signature check, or a handle for another version.
        for restore in [
            Err("signature mismatch".to_string()),
            Ok(Some(FakeHandle("0.1.13"))),
        ] {
            let first = Harness::new(true, None);
            ready_with_package(&first, vec![7]);
            let next = Harness::with_cache(true, None, first.cache.clone());
            assert!(!next.updater.restore_cached(|_, _| restore));
            assert!(PackageStore::new(first.cache.clone()).record().is_none());
            assert_eq!(next.updater.snapshot().phase, UpdatePhase::Idle);
        }
    }

    #[test]
    fn a_damaged_package_is_not_installed() {
        let harness = Harness::new(true, None);
        ready_with_package(&harness, vec![4, 4]);
        std::fs::write(harness.cache.join(PACKAGE_FILE), [4, 5]).unwrap();
        let called = AtomicUsize::new(0);
        assert!(!harness.updater.install(|_, _| {
            called.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }));
        assert_eq!(called.load(Ordering::SeqCst), 0);
        // Nothing to retry: the update is dropped and offered again by the
        // next check, which a ready update would not run.
        let state = harness.updater.snapshot();
        assert_eq!(state.phase, UpdatePhase::Idle);
        assert!(state.error.unwrap().message.contains("damaged"));
        assert!(PackageStore::new(harness.cache.clone()).record().is_none());
        let state = harness.check(Ok(offer("0.1.12")));
        assert!(matches!(state.phase, UpdatePhase::Available { .. }));
    }

    #[test]
    fn a_periodic_tick_downloads_per_policy_but_never_installs() {
        let dir = tempfile::tempdir().unwrap();
        let harness = Harness::new(true, Some(dir.path().to_path_buf()));
        harness
            .updater
            .set_policy(DownloadPolicy::Immediately)
            .unwrap();
        let state = tauri::async_runtime::block_on(periodic_tick(
            &harness.updater,
            || async { Ok(offer("0.1.12")) },
            |_, _| async { Ok(vec![1, 2, 3]) },
        ));
        assert_eq!(
            state.phase,
            UpdatePhase::Ready {
                version: "0.1.12".into()
            }
        );
        // A second tick with the update ready does nothing at all.
        let state = tauri::async_runtime::block_on(periodic_tick(
            &harness.updater,
            || async { panic!("a ready update is not re-checked") },
            |_, _| async { panic!("a ready update is not re-downloaded") },
        ));
        assert_eq!(
            state.phase,
            UpdatePhase::Ready {
                version: "0.1.12".into()
            }
        );
        assert!(harness
            .emitted()
            .iter()
            .all(|state| !matches!(state.phase, UpdatePhase::Installing { .. })));
    }

    #[test]
    fn an_unconfigured_start_starts_no_periodic_check() {
        let harness = Harness::new(false, None);
        let calls = AtomicUsize::new(0);
        start(&harness.updater, false, |_| {
            calls.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(calls.load(Ordering::SeqCst), 0);

        // Configured: the periodic thread starts, and the cached package is
        // not touched on the caller's (setup) thread.
        let first = Harness::new(true, None);
        ready_with_package(&first, vec![3]);
        let configured = Harness::with_cache(true, None, first.cache.clone());
        start(&configured.updater, true, |updater| {
            assert_eq!(updater.snapshot().phase, UpdatePhase::Idle);
            calls.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(configured.updater.snapshot().phase, UpdatePhase::Idle);
    }

    fn restored(
        feed: Result<Option<(Offer, FakeHandle)>, String>,
    ) -> (Harness, DesktopUpdateState) {
        let first = Harness::new(true, None);
        ready_with_package(&first, vec![6, 6]);
        let next = Harness::with_cache(true, None, first.cache.clone());
        tauri::async_runtime::block_on(restore_on_startup(
            &next.updater,
            |_, _| Ok(Some(FakeHandle("0.1.12"))),
            || async move { feed },
        ));
        let state = next.updater.snapshot();
        // Keep the first harness's temp root alive with the second.
        let mut next = next;
        next._cache_root = first._cache_root;
        (next, state)
    }

    #[test]
    fn a_restored_package_the_feed_still_offers_stays_ready() {
        let (harness, state) = restored(Ok(offer("0.1.12")));
        assert_eq!(
            state.phase,
            UpdatePhase::Ready {
                version: "0.1.12".into()
            }
        );
        assert!(PackageStore::new(harness.cache.clone()).record().is_some());
    }

    #[test]
    fn a_restored_package_is_kept_when_the_feed_does_not_answer() {
        let (harness, state) = restored(Err("offline".into()));
        assert_eq!(
            state.phase,
            UpdatePhase::Ready {
                version: "0.1.12".into()
            }
        );
        assert!(PackageStore::new(harness.cache.clone()).record().is_some());
    }

    #[test]
    fn a_withdrawn_or_superseded_restored_package_is_dropped() {
        let (harness, state) = restored(Ok(None));
        assert!(matches!(state.phase, UpdatePhase::UpToDate { .. }));
        assert!(PackageStore::new(harness.cache.clone()).record().is_none());

        let (harness, state) = restored(Ok(offer("0.1.13")));
        assert!(matches!(
            state.phase,
            UpdatePhase::Available { ref version, .. } if version == "0.1.13"
        ));
        assert!(PackageStore::new(harness.cache.clone()).record().is_none());
    }

    #[test]
    fn an_install_that_started_first_is_not_withdrawn() {
        let mut controller: Controller<FakeHandle> = Controller::new(true, VERSION.into(), None);
        assert!(controller.restore_ready(FakeHandle("0.1.12"), "0.1.12".into()));
        assert!(controller.begin_install().is_some());
        assert!(!controller.withdraw_ready(None, T0));
        assert_eq!(
            controller.state().phase,
            UpdatePhase::Installing {
                version: "0.1.12".into()
            }
        );
    }

    #[test]
    fn clearing_the_cache_also_removes_interrupted_writes() {
        let harness = Harness::new(true, None);
        ready_with_package(&harness, vec![1]);
        std::fs::write(harness.cache.join("package.bin.4242.tmp"), [0; 64]).unwrap();
        PackageStore::new(harness.cache.clone()).clear();
        assert_eq!(std::fs::read_dir(&harness.cache).unwrap().count(), 0);
    }

    #[test]
    fn a_package_whose_size_disagrees_with_its_record_is_not_read() {
        let harness = Harness::new(true, None);
        ready_with_package(&harness, vec![1, 2, 3]);
        let store = PackageStore::new(harness.cache.clone());
        let mut record = store.record().unwrap();
        record.length = MAX_PACKAGE_BYTES + 1;
        std::fs::write(
            harness.cache.join(PACKAGE_RECORD),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
        assert!(store.load("0.1.12").unwrap_err().contains("damaged"));
        std::fs::write(harness.cache.join(PACKAGE_FILE), [1, 2, 3, 4]).unwrap();
        record.length = 3;
        std::fs::write(
            harness.cache.join(PACKAGE_RECORD),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
        assert!(store.load("0.1.12").unwrap_err().contains("damaged"));
    }

    #[test]
    fn the_schedule_follows_wall_clock_time_across_sleep() {
        assert_eq!(schedule_step(1_000, 1_000), None);
        assert_eq!(
            schedule_step(1_000, 1_500),
            Some(Duration::from_millis(500))
        );
        assert_eq!(schedule_step(0, 3_600_000), Some(SCHEDULE_STEP));
        // The machine sleeps for two hours during the first step: the wait
        // ends on waking, not a whole interval later.
        let now = AtomicU64::new(0);
        let sleeps = AtomicUsize::new(0);
        wait_until(
            CHECK_INTERVAL.as_millis() as u64,
            &|| now.load(Ordering::SeqCst),
            &|step| {
                assert!(step <= SCHEDULE_STEP);
                sleeps.fetch_add(1, Ordering::SeqCst);
                now.fetch_add(2 * 3_600_000, Ordering::SeqCst);
            },
        );
        assert_eq!(sleeps.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn every_emitted_state_has_a_greater_sequence() {
        let harness = Harness::new(true, None);
        harness.check(Ok(offer("0.1.12")));
        tauri::async_runtime::block_on(harness.updater.download(|_, mut on_chunk| async move {
            on_chunk(10, Some(100));
            on_chunk(10, Some(100));
            Ok(vec![0; 20])
        }));
        let sequences: Vec<u64> = harness
            .emitted()
            .iter()
            .map(|state| state.sequence)
            .collect();
        assert!(sequences.len() >= 4, "{sequences:?}");
        assert!(
            sequences.windows(2).all(|pair| pair[0] < pair[1]),
            "{sequences:?}"
        );
        assert_eq!(
            harness.updater.snapshot().sequence,
            *sequences.last().unwrap()
        );
    }

    #[test]
    fn a_stored_start_in_the_future_restarts_the_clock() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(STORE_FILE),
            serde_json::json!({
                "policy": "after-24h",
                "available": { "version": "0.1.12", "since": T0 + 1_000_000_000 }
            })
            .to_string(),
        )
        .unwrap();
        let harness = Harness::new(true, Some(dir.path().to_path_buf()));
        let state = harness.check(Ok(offer("0.1.12")));
        assert_eq!(state.auto_download_at, Some(T0 + AUTO_DOWNLOAD_DELAY_MS));
    }

    #[test]
    fn settings_fields_are_read_independently_and_an_unknown_policy_survives() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join(STORE_FILE),
            serde_json::json!({
                "policy": "when-idle",
                "available": { "version": "0.1.12", "since": T0 - 5 }
            })
            .to_string(),
        )
        .unwrap();
        let harness = Harness::new(true, Some(dir.path().to_path_buf()));
        // The default applies, and the timer record is kept.
        assert_eq!(harness.updater.snapshot().policy, DownloadPolicy::After24h);
        let state = harness.check(Ok(offer("0.1.12")));
        assert_eq!(
            state.auto_download_at,
            Some(T0 - 5 + AUTO_DOWNLOAD_DELAY_MS)
        );
        // Writing the clock back keeps the newer build's value.
        harness.check(Ok(offer("0.1.13")));
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join(STORE_FILE)).unwrap())
                .unwrap();
        assert_eq!(raw["policy"], "when-idle");
        // Choosing a policy here replaces it.
        harness.updater.set_policy(DownloadPolicy::Never).unwrap();
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join(STORE_FILE)).unwrap())
                .unwrap();
        assert_eq!(raw["policy"], "never");

        // Fields this build does not own survive a write, and a null policy
        // reads as absent.
        std::fs::write(
            dir.path().join(STORE_FILE),
            r#"{"policy":null,"skippedVersion":"0.1.12","available":null}"#,
        )
        .unwrap();
        let harness = Harness::new(true, Some(dir.path().to_path_buf()));
        assert_eq!(harness.updater.snapshot().policy, DownloadPolicy::After24h);
        harness.check(Ok(offer("0.1.13")));
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join(STORE_FILE)).unwrap())
                .unwrap();
        assert_eq!(raw["skippedVersion"], "0.1.12");
        assert_eq!(raw["policy"], "after-24h");
        assert_eq!(raw["available"]["version"], "0.1.13");

        // An unreadable clock keeps a known policy.
        std::fs::write(
            dir.path().join(STORE_FILE),
            r#"{"policy":"immediately","available":{"version":7}}"#,
        )
        .unwrap();
        let harness = Harness::new(true, Some(dir.path().to_path_buf()));
        assert_eq!(
            harness.updater.snapshot().policy,
            DownloadPolicy::Immediately
        );
    }
}
