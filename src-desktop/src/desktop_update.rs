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
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedAvailable {
    version: String,
    since: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Persisted {
    #[serde(default)]
    policy: DownloadPolicy,
    #[serde(default)]
    available: Option<PersistedAvailable>,
}

impl Persisted {
    /// An unreadable or malformed file falls back to defaults: the only cost
    /// is the default policy and a restarted 24h clock.
    fn load(dir: &Path) -> Self {
        std::fs::read_to_string(dir.join(STORE_FILE))
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    fn save(&self, dir: &Path) -> Result<(), String> {
        std::fs::create_dir_all(dir)
            .map_err(|error| format!("create the desktop config directory: {error}"))?;
        let body = serde_json::to_vec_pretty(self)
            .map_err(|error| format!("encode desktop update settings: {error}"))?;
        // Write-then-rename so a crash never leaves a half-written file.
        let temporary = dir.join(format!("{STORE_FILE}.{}.tmp", std::process::id()));
        std::fs::write(&temporary, body)
            .map_err(|error| format!("write desktop update settings: {error}"))?;
        std::fs::rename(&temporary, dir.join(STORE_FILE))
            .map_err(|error| format!("persist desktop update settings: {error}"))
    }
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
    bytes: Option<Vec<u8>>,
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
            bytes: None,
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
        let previous = self.persisted.policy;
        self.persisted.policy = policy;
        if let Err(error) = self.persist() {
            self.persisted.policy = previous;
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
                let since = match &self.persisted.available {
                    Some(previous) if previous.version == offer.version => previous.since,
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

    pub fn finish_download(&mut self, result: Result<Vec<u8>, String>) {
        let UpdatePhase::Downloading { version, .. } = &self.phase else {
            return;
        };
        let version = version.clone();
        let resume = self.resume_phase.take();
        match result {
            Ok(bytes) => {
                self.bytes = Some(bytes);
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

    /// Takes the verified bytes for installation. They come back through
    /// [`Self::finish_install`] so a failed install can be retried.
    pub fn begin_install(&mut self) -> Option<(H, Vec<u8>)> {
        let UpdatePhase::Ready { version } = &self.phase else {
            return None;
        };
        let version = version.clone();
        let handle = self.handle.clone()?;
        let bytes = self.bytes.take()?;
        self.error = None;
        self.phase = UpdatePhase::Installing { version };
        Some((handle, bytes))
    }

    /// On success the phase stays `installing` until the process restarts.
    pub fn finish_install(&mut self, result: Result<(), String>, bytes: Vec<u8>) {
        let UpdatePhase::Installing { version } = &self.phase else {
            return;
        };
        if let Err(message) = result {
            let version = version.clone();
            self.bytes = Some(bytes);
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
}

impl<H> Clone for DesktopUpdater<H> {
    fn clone(&self) -> Self {
        Self {
            controller: Arc::clone(&self.controller),
            emit: Arc::clone(&self.emit),
            clock: Arc::clone(&self.clock),
        }
    }
}

impl<H: Clone + Send + 'static> DesktopUpdater<H> {
    pub fn new(controller: Controller<H>, emit: Arc<Emit>, clock: Arc<Clock>) -> Self {
        Self {
            controller: Arc::new(Mutex::new(controller)),
            emit,
            clock,
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
        let (value, before, after) = {
            let mut controller = self.lock();
            let before = controller.state();
            let value = transition(&mut controller);
            (value, before, controller.state())
        };
        if before != after {
            (self.emit)(&after);
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
                controller
                    .record_progress(chunk, total, now)
                    .then(|| controller.state())
            };
            if let Some(state) = emitted {
                (progress.emit)(&state);
            }
        });
        let result = download(handle, on_chunk).await;
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
        let Some((handle, bytes)) = self.update(Controller::begin_install) else {
            return false;
        };
        let result = install(&handle, &bytes);
        let installed = result.is_ok();
        self.update(|controller| controller.finish_install(result, bytes));
        installed
    }
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

pub use tauri_glue::*;

mod tauri_glue {
    use super::*;
    use tauri::{AppHandle, Emitter, Manager, Runtime, State};
    use tauri_plugin_updater::{Update, UpdaterExt};

    pub type AppDesktopUpdater = DesktopUpdater<Update>;

    const CHECK_TIMEOUT: Duration = Duration::from_secs(30);
    /// A download may legitimately take minutes, so it has no total timeout;
    /// a connection that stops delivering bytes for this long fails instead
    /// of hanging in `downloading` forever.
    const DOWNLOAD_READ_TIMEOUT: Duration = Duration::from_secs(60);

    /// Manages the updater state for the app. `enabled` is the existing
    /// `desktop_updater_plugin_configured` decision: an unconfigured build
    /// reports `disabled` and never checks.
    pub fn manage<R: Runtime>(app: &AppHandle<R>, enabled: bool) {
        let store_dir = app.path().app_config_dir().ok();
        let emitter = app.clone();
        let updater = AppDesktopUpdater::new(
            Controller::new(enabled, app.package_info().version.to_string(), store_dir),
            Arc::new(move |state: &DesktopUpdateState| {
                if let Err(error) = emitter.emit(STATE_EVENT, state) {
                    log::warn!("could not emit desktop update state: {error}");
                }
            }),
            Arc::new(now_ms),
        );
        app.manage(updater.clone());
        if enabled {
            start_periodic_check(app.clone(), updater);
        }
    }

    /// The in-process re-check (owner preference: no OS job, cron or
    /// launchd). One named thread sleeps between ticks; it lives exactly as
    /// long as the app process.
    fn start_periodic_check<R: Runtime>(app: AppHandle<R>, updater: AppDesktopUpdater) {
        let spawned = std::thread::Builder::new()
            .name("station-desktop-update".into())
            .spawn(move || {
                std::thread::sleep(FIRST_CHECK_DELAY);
                loop {
                    tauri::async_runtime::block_on(tick(&app, &updater));
                    std::thread::sleep(CHECK_INTERVAL);
                }
            });
        if let Err(error) = spawned {
            log::error!("could not start the desktop update check thread: {error}");
        }
    }

    async fn tick<R: Runtime>(app: &AppHandle<R>, updater: &AppDesktopUpdater) {
        let state = updater.check(|| native_check(app)).await;
        if let Some(error) = &state.error {
            log::info!("desktop update check did not complete: {}", error.message);
        }
        maybe_auto_download(updater).await;
    }

    async fn maybe_auto_download(updater: &AppDesktopUpdater) {
        if updater.auto_download_due() {
            log::info!("downloading the available desktop update per the download policy");
            updater.download(native_download).await;
        }
    }

    async fn native_check<R: Runtime>(
        app: &AppHandle<R>,
    ) -> Result<Option<(Offer, Update)>, String> {
        let updater = app
            .updater_builder()
            .timeout(CHECK_TIMEOUT)
            .configure_client(|client| client.read_timeout(DOWNLOAD_READ_TIMEOUT))
            .build()
            .map_err(|error| error.to_string())?;
        match updater.check().await {
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

    async fn native_download(update: Update, mut on_chunk: OnChunk) -> Result<Vec<u8>, String> {
        let mut update = update;
        // The handle inherits the check's total timeout; see
        // DOWNLOAD_READ_TIMEOUT for what bounds a stalled download instead.
        update.timeout = None;
        update
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
        updater.check(|| native_check(&app)).await;
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
    /// The webview calls this after the user confirmed the restart.
    #[tauri::command]
    pub async fn desktop_update_install<R: Runtime>(
        app: AppHandle<R>,
        updater: State<'_, AppDesktopUpdater>,
    ) -> Result<DesktopUpdateState, String> {
        let updater = updater.inner().clone();
        let installer = updater.clone();
        let installed = tauri::async_runtime::spawn_blocking(move || {
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

    const T0: u64 = 1_760_000_000_000;
    const VERSION: &str = "0.1.11";

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct FakeHandle(&'static str);

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
    }

    impl Harness {
        fn new(enabled: bool, store_dir: Option<PathBuf>) -> Self {
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
                ),
                emitted,
                clock,
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
        all.get(name)
            .unwrap_or_else(|| panic!("fixture {name} is missing"))
            .clone()
    }

    fn json(state: &DesktopUpdateState) -> serde_json::Value {
        serde_json::to_value(state).unwrap()
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
    fn a_failed_install_returns_to_ready_with_the_bytes_for_a_retry() {
        let harness = Harness::new(true, None);
        harness.check(Ok(offer("0.1.12")));
        harness.download(Ok(vec![7, 7, 7]));
        let before = harness.emitted().len();
        assert!(!harness
            .updater
            .install(|_, _| Err("failed to move the new app into place".into())));
        assert_eq!(json(&harness.updater.snapshot()), fixture("installFailed"));
        assert_eq!(json(&harness.emitted()[before]), fixture("installing"));

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
}
