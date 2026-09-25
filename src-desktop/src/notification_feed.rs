//! Native consumer of the notification delivery feed (#2608).
//!
//! The server's delivery router is the single policy engine for desktop OS
//! alerts: it queues DECIDED, already-redacted entries per surface and the
//! desktop app reads its own from `GET /api/notifications/deliveries`
//! (docs/design/notification-delivery.md, "Desktop OS alerts"). The webview
//! used to be that reader, and a webview hidden in the tray is suspended, so
//! nothing read and nothing alerted. This module is the reader now.
//!
//! **One consumer.** On a desktop host this thread is the ONLY consumer of the
//! feed. The webview asks `notification_feed_native_consumer` before its first
//! read; this host answers `true`, and the webview then never reads the feed
//! and never posts an alert from it (`src-ui/src/platform/native/deliveryFeed.ts`).
//! The answer is static for the process, so the role never changes hands at
//! runtime and the two can never both post. The one handoff is across an app
//! upgrade: an older build's webview kept its cursor in localStorage. The
//! webview offers that cursor once (`notification_feed_adopt_cursor`); this
//! consumer takes it only when it has no cursor of its own for that Station,
//! and the webview deletes its copy only when it was taken. Until either a
//! handed-over cursor or its own cursor exists, it reads without applying for
//! up to [`ADOPTION_GRACE_MS`], then starts from the cursor it saw on its
//! FIRST read — so nothing that arrives after the first read is lost, and a
//! backlog an earlier consumer already alerted is not replayed. An offer is
//! refused once this consumer has chosen its own start — it has a committed
//! cursor, or a read that chose one is still being committed. Entries queued
//! between the webview's cursor and this consumer's first read (while the
//! app was closed for the upgrade) are then not alerted.
//!
//! **Retry and at-least-once.** A read is decided under the consumer lock,
//! its OS calls are made with the lock released, in order, and the cursor is
//! then committed up to the entry BEFORE the first post the OS refused or the
//! first call that did not answer (timed out, or not made because earlier
//! calls are still stuck — [`OsCallGate`]). That entry and everything after it
//! are read and tried again next poll. The same alert refused on
//! [`MAX_REFUSALS`] polls in a row is skipped (logged once), so one entry
//! cannot hold the feed; a call that does not answer is never counted
//! towards that and never skipped. A crash between posting and the commit
//! posts those entries again on the next run (the in-memory dedupe does not
//! survive a restart), and a show that times out but appears later is shown
//! again by the retry.
//!
//! **Same surface, same credential.** The read goes to the host-authorized
//! active Station with that profile's bearer — the exact authority the
//! webview's own requests use through `station_native_http_request` — plus
//! this installation's id header, so the server derives the same surface
//! (`local:desktop-<id>` on this computer's Station, `device:<id>` on a
//! remote one). This module does no filtering: focus, quiet hours, mutes,
//! minimum urgency and `hideContent` were applied by the router. Its one
//! presentation guard matches the webview's: no OS alert while the main
//! window is focused (the in-app toast shows it); the entry is consumed.
//!
//! **Cursor and epoch** persist per Station origin in the app config
//! directory, tagged with the surface the server echoed. A cursor for a
//! different surface is not used. A different epoch is a restarted server
//! whose answer is all new.
//!
//! **Retract** closes the OS notification this process posted for that id
//! where the platform backend can: Linux (D-Bus `CloseNotification`). The
//! pinned notify-rust 4.18 backends on macOS (NSUserNotificationCenter) and
//! Windows return handles with no close, so there a retract only stops an
//! alert that has not been posted yet (a retract later in the same read).
//!
//! **Click** focuses the app and hands the entry's `link` to the main webview
//! (`station://notification-open`, then `take_notification_open_link`). The
//! link is accepted only as an in-app path; anything else opens the app
//! where it was. No URL is ever opened outside the app.
//!
//! The legacy `notification_watch.rs` is not revived: it posts raw titles and
//! ignores envelopes, `hideContent`, quiet hours and mutes.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Well inside the server's 90 s host lease (`DESKTOP_HOST_LEASE_MS`); the
/// same cadence the webview used.
pub(crate) const POLL_INTERVAL_MS: u64 = 20_000;
/// How long a consumer without a cursor waits for the webview to hand one
/// over before it starts from its first read's cursor.
pub(crate) const ADOPTION_GRACE_MS: u64 = 30_000;
const POSTED_MAX: usize = 200;
const MAX_ENTRIES: usize = 500;
const MAX_STORED_ORIGINS: usize = 16;
/// Polls in a row the OS may refuse the same alert before it is skipped.
pub(crate) const MAX_REFUSALS: u32 = 3;
const MAX_LINK_LEN: usize = 2048;
pub(crate) const OPEN_EVENT: &str = "station://notification-open";
const CURSOR_FILE: &str = "notification-delivery-cursors.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StoredCursor {
    pub surface: String,
    pub cursor: u64,
    pub epoch: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum FeedEntry {
    #[serde(rename_all = "camelCase")]
    Alert {
        seq: u64,
        notification_id: String,
        title: String,
        #[serde(default)]
        body: Option<String>,
        urgency: String,
        #[serde(default)]
        link: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Retract { seq: u64, notification_id: String },
}

impl FeedEntry {
    fn seq(&self) -> u64 {
        match self {
            FeedEntry::Alert { seq, .. } | FeedEntry::Retract { seq, .. } => *seq,
        }
    }
    fn notification_id(&self) -> &str {
        match self {
            FeedEntry::Alert {
                notification_id, ..
            }
            | FeedEntry::Retract {
                notification_id, ..
            } => notification_id,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Feed {
    pub surface: String,
    pub entries: Vec<FeedEntry>,
    pub cursor: u64,
    pub epoch: String,
}

/// One alert to show. `link` is already validated as an in-app path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Alert {
    pub notification_id: String,
    pub title: String,
    pub body: Option<String>,
    pub link: Option<String>,
}

/// What one OS call did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OsOutcome {
    /// Shown, or closed.
    Done,
    /// The OS refused the post, or there was nothing held to close.
    NotDone,
    /// Not known to have happened: the call timed out, or it was not made
    /// because earlier calls are still stuck (see [`OsCallGate`]).
    Deferred,
}

pub(crate) trait AlertSink {
    /// Show one alert.
    fn post(&mut self, alert: &Alert) -> OsOutcome;
    /// Take down the alert this process posted for `notification_id`.
    fn close(&mut self, notification_id: &str) -> OsOutcome;
}

/// Runs OS notification calls on helper threads, each bounded by a timeout,
/// with a breaker: while `cap` earlier calls are still running (parked on a
/// notification service that does not answer — zbus has no default method
/// timeout), no new call is made at all. A stuck service therefore costs at
/// most `cap` parked threads, never one per alert.
pub(crate) struct OsCallGate {
    in_flight: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    cap: usize,
    timeout: std::time::Duration,
}

impl OsCallGate {
    pub(crate) fn new(cap: usize, timeout: std::time::Duration) -> Self {
        Self {
            in_flight: Default::default(),
            cap,
            timeout,
        }
    }

    /// `None` when the call timed out or was not made (breaker open).
    pub(crate) fn run<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> T + Send + 'static,
    ) -> Option<T> {
        use std::sync::atomic::Ordering;
        if self
            .in_flight
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| {
                (count < self.cap).then_some(count + 1)
            })
            .is_err()
        {
            return None;
        }
        let (sender, receiver) = std::sync::mpsc::channel();
        let in_flight = std::sync::Arc::clone(&self.in_flight);
        let spawned = std::thread::Builder::new()
            .name("station-notification-os-call".into())
            .spawn(move || {
                let answer = work();
                in_flight.fetch_sub(1, Ordering::SeqCst);
                let _ = sender.send(answer);
            });
        if spawned.is_err() {
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        receiver.recv_timeout(self.timeout).ok()
    }
}

pub(crate) trait CursorStore {
    fn save(&mut self, cursors: &HashMap<String, StoredCursor>);
}

/// Parse the route's `{ success, data }` answer. Anything malformed is `None`:
/// nothing is applied and the cursor does not move.
pub(crate) fn parse_feed_response(body: &str) -> Option<Feed> {
    #[derive(Deserialize)]
    struct Envelope {
        success: bool,
        data: Option<Feed>,
    }
    let envelope: Envelope = serde_json::from_str(body).ok()?;
    let feed = envelope.data.filter(|_| envelope.success)?;
    (feed.entries.len() <= MAX_ENTRIES && !feed.surface.is_empty() && !feed.epoch.is_empty())
        .then_some(feed)
}

/// An entry's `link` as an in-app path, or `None`. Accepts only a
/// same-origin absolute path (`/…`, optionally with a query); refuses
/// schemes, protocol-relative `//host`, backslashes, fragments, control
/// characters and oversize values, so a click can navigate the app but never
/// open anything outside it. The NORMALIZED path is checked and returned:
/// dot segments (`/..//host`, `/%2e%2e//host`) can collapse to `//host`.
pub(crate) fn in_app_link(link: Option<&str>) -> Option<String> {
    let link = link?;
    if link.is_empty()
        || link.len() > MAX_LINK_LEN
        || !link.starts_with('/')
        || link.starts_with("//")
        || link.contains('\\')
        || link.contains('#')
        || link.chars().any(|c| c.is_control() || c.is_whitespace())
    {
        return None;
    }
    let base = url::Url::parse("https://station.invalid/").ok()?;
    let joined = base.join(link).ok()?;
    if joined.origin() != base.origin() || joined.path().starts_with("//") {
        return None;
    }
    Some(match joined.query() {
        Some(query) => format!("{}?{query}", joined.path()),
        None => joined.path().to_string(),
    })
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct Applied {
    pub posted: usize,
    pub closed: usize,
    /// Read without applying: no cursor yet, still inside the adoption grace.
    pub waiting: bool,
}

/// What one read decided, made under the consumer lock and carried out
/// (OS calls) after it is released. Each carries its entry's `seq`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Action {
    Post { seq: u64, alert: Alert, key: String },
    Close { seq: u64, notification_id: String },
}

#[derive(Debug, Default)]
pub(crate) struct Plan {
    pub actions: Vec<Action>,
    /// The position to commit once the actions ran; `None` while waiting.
    commit: Option<StoredCursor>,
}

impl Plan {
    pub(crate) fn waiting(&self) -> bool {
        self.commit.is_none()
    }
}

/// What carrying out a plan did.
#[derive(Debug, Default)]
pub(crate) struct Executed {
    /// Dedupe keys of alerts the OS accepted.
    accepted: Vec<String>,
    /// The entry the run stopped at (not handled); nothing after it ran.
    stopped_at: Option<u64>,
    /// The key of a post the OS refused, when that is why it stopped.
    refused: Option<String>,
    pub applied: Applied,
}

/// Carry out a plan's OS calls, in order, stopping at the first post the OS
/// refuses and at the first call that is deferred (timed out, or breaker
/// open). The stopping entry and everything after it stay uncommitted, so a
/// later poll retries them.
pub(crate) fn execute(actions: Vec<Action>, sink: &mut dyn AlertSink) -> Executed {
    let mut executed = Executed::default();
    for action in actions {
        match action {
            Action::Post { seq, alert, key } => match sink.post(&alert) {
                OsOutcome::Done => {
                    executed.accepted.push(key);
                    executed.applied.posted += 1;
                }
                OsOutcome::NotDone => {
                    executed.stopped_at = Some(seq);
                    executed.refused = Some(key);
                    break;
                }
                OsOutcome::Deferred => {
                    executed.stopped_at = Some(seq);
                    break;
                }
            },
            Action::Close {
                seq,
                notification_id,
            } => match sink.close(&notification_id) {
                OsOutcome::Done => executed.applied.closed += 1,
                OsOutcome::NotDone => {}
                OsOutcome::Deferred => {
                    executed.stopped_at = Some(seq);
                    break;
                }
            },
        }
    }
    executed
}

/// The consumer's decisions, free of HTTP and OS calls so they can be tested.
#[derive(Default)]
pub(crate) struct FeedConsumer {
    /// Per Station origin: where this consumer has read to.
    cursors: HashMap<String, StoredCursor>,
    /// Origins by last commit, least recent first (bounds `cursors`).
    recent: VecDeque<String>,
    /// Cursors handed over by the webview, per origin, not yet adopted.
    handed_over: HashMap<String, StoredCursor>,
    /// Per origin without a cursor: the first read's position and when, on
    /// the caller's MONOTONIC millisecond clock.
    first_read: HashMap<String, (StoredCursor, u64)>,
    posted: VecDeque<String>,
    posted_set: HashSet<String>,
    /// The post the OS last refused, and how many polls in a row it did.
    refused: Option<(String, u32)>,
    /// Origins with a planned read whose outcome is not committed yet.
    pending: HashSet<String>,
}

impl FeedConsumer {
    pub(crate) fn with_cursors(cursors: HashMap<String, StoredCursor>) -> Self {
        Self {
            recent: cursors.keys().cloned().collect(),
            cursors,
            ..Self::default()
        }
    }

    #[cfg(test)]
    pub(crate) fn cursor(&self, origin: &str) -> Option<&StoredCursor> {
        self.cursors.get(origin)
    }

    /// `after` and `epoch` for the next read. Without a cursor the whole
    /// retained feed is read, so a cursor handed over later can still be
    /// applied from wherever it points.
    pub(crate) fn request(&self, origin: &str) -> (u64, Option<String>) {
        match self.cursors.get(origin) {
            Some(stored) => (stored.cursor, Some(stored.epoch.clone())),
            None => (0, None),
        }
    }

    /// The webview's cursor from an older build (see the module comment).
    /// Returns whether it was taken: only when this consumer has no cursor of
    /// its own for that origin and no read of that origin is being committed
    /// (that read already chose where to start). A `false` leaves the
    /// webview's copy in place.
    pub(crate) fn hand_over(&mut self, origin: &str, cursor: StoredCursor) -> bool {
        if cursor.surface.is_empty()
            || cursor.epoch.is_empty()
            || self.cursors.contains_key(origin)
            || self.pending.contains(origin)
            || (self.handed_over.len() >= MAX_STORED_ORIGINS
                && !self.handed_over.contains_key(origin))
        {
            return false;
        }
        self.handed_over.insert(origin.to_string(), cursor);
        true
    }

    /// Decide one read. No OS call happens here; see [`execute`] and
    /// [`FeedConsumer::finish`].
    pub(crate) fn plan(
        &mut self,
        origin: &str,
        feed: &Feed,
        focused: bool,
        now_ms: u64,
        store: &mut dyn CursorStore,
    ) -> Plan {
        // A cursor stored for another surface (another installation, or the
        // credential now reads as a different caller) says nothing here.
        if self
            .cursors
            .get(origin)
            .is_some_and(|stored| stored.surface != feed.surface)
        {
            self.cursors.remove(origin);
            self.recent.retain(|key| key != origin);
            store.save(&self.cursors);
        }
        let start = match self.cursors.get(origin) {
            Some(stored) => stored.clone(),
            None => match self.start_without_cursor(origin, feed, now_ms) {
                Some(start) => start,
                None => return Plan::default(),
            },
        };
        let from = if start.epoch == feed.epoch {
            start.cursor
        } else {
            0
        };
        let mut entries: Vec<&FeedEntry> = feed
            .entries
            .iter()
            .filter(|entry| entry.seq() > from)
            .collect();
        entries.sort_by_key(|entry| entry.seq());
        let mut retracted_at: HashMap<&str, u64> = HashMap::new();
        for entry in &entries {
            if let FeedEntry::Retract { .. } = entry {
                retracted_at.insert(entry.notification_id(), entry.seq());
            }
        }
        let mut planned_keys = HashSet::new();
        let mut actions = Vec::new();
        for entry in entries {
            match entry {
                FeedEntry::Retract {
                    seq,
                    notification_id,
                } => actions.push(Action::Close {
                    seq: *seq,
                    notification_id: notification_id.clone(),
                }),
                FeedEntry::Alert {
                    seq,
                    notification_id,
                    title,
                    body,
                    urgency,
                    link,
                } => {
                    let retracted_later = retracted_at
                        .get(notification_id.as_str())
                        .is_some_and(|at| at > seq);
                    // JSON of the fields keeps the key unambiguous; an update
                    // under the same id with new content alerts again.
                    let key = serde_json::to_string(&(notification_id, title, body, urgency))
                        .unwrap_or_default();
                    if self
                        .refused
                        .as_ref()
                        .is_some_and(|(refused, count)| *refused == key && *count >= MAX_REFUSALS)
                    {
                        // Refused on every one of the last MAX_REFUSALS polls:
                        // skipped, so one entry cannot hold the feed forever.
                        log::warn!(
                            "skipping notification {notification_id}: the OS refused it {MAX_REFUSALS} times"
                        );
                        self.refused = None;
                        continue;
                    }
                    if !retracted_later
                        && !focused
                        && !self.posted_set.contains(&key)
                        && planned_keys.insert(key.clone())
                    {
                        actions.push(Action::Post {
                            seq: *seq,
                            alert: Alert {
                                notification_id: notification_id.clone(),
                                title: title.clone(),
                                body: body.clone(),
                                link: in_app_link(link.as_deref()),
                            },
                            key,
                        });
                    }
                }
            }
        }
        self.pending.insert(origin.to_string());
        Plan {
            actions,
            commit: Some(StoredCursor {
                surface: feed.surface.clone(),
                cursor: feed.cursor,
                epoch: feed.epoch.clone(),
            }),
        }
    }

    /// Record a plan's outcome: remember the accepted alerts and commit the
    /// cursor — up to the entry BEFORE the one the run stopped at, so a
    /// refused or deferred post and everything after it are read again next
    /// poll. Committing after the OS calls also means a crash between
    /// posting and this save posts those entries again.
    pub(crate) fn finish(
        &mut self,
        origin: &str,
        plan_commit: Option<StoredCursor>,
        executed: Executed,
        store: &mut dyn CursorStore,
    ) {
        self.pending.remove(origin);
        for key in executed.accepted {
            if self
                .refused
                .as_ref()
                .is_some_and(|(refused, _)| *refused == key)
            {
                self.refused = None;
            }
            self.remember_posted(key);
        }
        if let Some(key) = executed.refused {
            let count = match &self.refused {
                Some((refused, count)) if *refused == key => count + 1,
                _ => 1,
            };
            self.refused = Some((key, count));
        }
        if let Some(mut next) = plan_commit {
            if let Some(stopped) = executed.stopped_at {
                next.cursor = next.cursor.min(stopped.saturating_sub(1));
            }
            self.commit(origin, next, store);
        }
    }

    /// Plan, execute and finish in one call, for callers without a lock to
    /// release in between (tests).
    #[cfg(test)]
    pub(crate) fn apply(
        &mut self,
        origin: &str,
        feed: &Feed,
        focused: bool,
        now_ms: u64,
        sink: &mut dyn AlertSink,
        store: &mut dyn CursorStore,
    ) -> Applied {
        let plan = self.plan(origin, feed, focused, now_ms, store);
        let waiting = plan.waiting();
        let mut executed = execute(plan.actions, sink);
        let mut applied = std::mem::take(&mut executed.applied);
        self.finish(origin, plan.commit, executed, store);
        applied.waiting = waiting;
        applied
    }

    fn start_without_cursor(
        &mut self,
        origin: &str,
        feed: &Feed,
        now_ms: u64,
    ) -> Option<StoredCursor> {
        if let Some(handed) = self
            .handed_over
            .remove(origin)
            .filter(|handed| handed.surface == feed.surface)
        {
            self.first_read.remove(origin);
            return Some(handed);
        }
        match self.first_read.get(origin) {
            Some((first, at)) if first.surface == feed.surface => {
                if now_ms.saturating_sub(*at) < ADOPTION_GRACE_MS {
                    return None;
                }
                let first = first.clone();
                self.first_read.remove(origin);
                Some(first)
            }
            _ => {
                self.first_read.insert(
                    origin.to_string(),
                    (
                        StoredCursor {
                            surface: feed.surface.clone(),
                            cursor: feed.cursor,
                            epoch: feed.epoch.clone(),
                        },
                        now_ms,
                    ),
                );
                None
            }
        }
    }

    fn commit(&mut self, origin: &str, next: StoredCursor, store: &mut dyn CursorStore) {
        self.handed_over.remove(origin);
        self.recent.retain(|key| key != origin);
        self.recent.push_back(origin.to_string());
        if self.cursors.get(origin) == Some(&next) {
            return;
        }
        self.cursors.insert(origin.to_string(), next);
        // Bounded: drop the least recently committed other origin.
        while self.cursors.len() > MAX_STORED_ORIGINS {
            let Some(oldest) = self.recent.pop_front() else {
                break;
            };
            self.cursors.remove(&oldest);
        }
        store.save(&self.cursors);
    }

    fn remember_posted(&mut self, key: String) {
        if self.posted_set.insert(key.clone()) {
            self.posted.push_back(key);
            if self.posted.len() > POSTED_MAX {
                if let Some(oldest) = self.posted.pop_front() {
                    self.posted_set.remove(&oldest);
                }
            }
        }
    }
}

/// The consumer behind one lock that is never held across an OS call: a
/// read is planned under it, the alerts are posted or closed after it is
/// released, and the outcome is committed under it again. A notification
/// backend that stalls therefore never blocks a cursor handover.
pub(crate) struct SharedConsumer<C> {
    inner: Mutex<Option<(FeedConsumer, C)>>,
}

impl<C: CursorStore> SharedConsumer<C> {
    pub(crate) const fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    fn with<T>(
        &self,
        init: impl FnOnce() -> Option<(FeedConsumer, C)>,
        run: impl FnOnce(&mut FeedConsumer, &mut C) -> T,
    ) -> Option<T> {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if guard.is_none() {
            *guard = init();
        }
        let (consumer, store) = guard.as_mut()?;
        Some(run(consumer, store))
    }

    pub(crate) fn request(
        &self,
        init: impl FnOnce() -> Option<(FeedConsumer, C)>,
        origin: &str,
    ) -> Option<(u64, Option<String>)> {
        self.with(init, |consumer, _| consumer.request(origin))
    }

    pub(crate) fn hand_over(
        &self,
        init: impl FnOnce() -> Option<(FeedConsumer, C)>,
        origin: &str,
        cursor: StoredCursor,
    ) -> bool {
        self.with(init, |consumer, _| consumer.hand_over(origin, cursor))
            .unwrap_or(false)
    }

    pub(crate) fn apply(
        &self,
        init: impl FnOnce() -> Option<(FeedConsumer, C)>,
        origin: &str,
        feed: &Feed,
        focused: bool,
        now_ms: u64,
        sink: &mut dyn AlertSink,
    ) -> Option<Applied> {
        let plan = self.with(init, |consumer, store| {
            consumer.plan(origin, feed, focused, now_ms, store)
        })?;
        let waiting = plan.waiting();
        // No consumer lock from here until the outcome is committed.
        let mut executed = execute(plan.actions, sink);
        let mut applied = std::mem::take(&mut executed.applied);
        self.with(
            || None,
            |consumer, store| consumer.finish(origin, plan.commit, executed, store),
        );
        applied.waiting = waiting;
        Some(applied)
    }
}

/// The cursor file in the app config directory: `{ "<origin>": StoredCursor }`.
pub(crate) struct CursorFile {
    path: PathBuf,
    warned: bool,
}

impl CursorFile {
    pub(crate) fn in_dir(dir: &Path) -> Self {
        Self {
            path: dir.join(CURSOR_FILE),
            warned: false,
        }
    }

    /// Unreadable or malformed reads as empty: the consumer then waits for a
    /// handed-over cursor or starts from its first read, never replays.
    pub(crate) fn load(&self) -> HashMap<String, StoredCursor> {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default()
    }

    fn write(&self, raw: &str) -> std::io::Result<()> {
        use std::io::Write;
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        // Write-then-rename so a crash never leaves a half-written file;
        // owner-only where the platform has modes.
        let temporary = self
            .path
            .with_extension(format!("{}.tmp", std::process::id()));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let written = options
            .open(&temporary)
            .and_then(|mut file| file.write_all(raw.as_bytes()))
            .and_then(|()| std::fs::rename(&temporary, &self.path));
        if written.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        written
    }
}

impl CursorStore for CursorFile {
    fn save(&mut self, cursors: &HashMap<String, StoredCursor>) {
        let Ok(raw) = serde_json::to_string(cursors) else {
            return;
        };
        match self.write(&raw) {
            Ok(()) => self.warned = false,
            Err(error) if !self.warned => {
                // Once per failure streak: the poll repeats every 20 s.
                self.warned = true;
                log::warn!("could not persist the notification delivery cursor: {error}");
            }
            Err(_) => {}
        }
    }
}

#[cfg(not(mobile))]
pub(crate) use host::*;

#[cfg(not(mobile))]
mod host {
    use super::*;
    use std::io::Read;
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use tauri::{AppHandle, Emitter, Manager, Runtime};

    const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
    const BODY_LIMIT: u64 = 1024 * 1024;
    const OPEN_LINK_TTL: Duration = Duration::from_secs(60);
    /// Threads waiting on a click, at most. Past this an alert still shows;
    /// only its click is not observed.
    const MAX_CLICK_WAITERS: usize = 32;
    /// The longest one OS notification call (show, close) may take. A show
    /// that times out may still appear later: that notification is orphaned
    /// (no handle kept, so no retract; no click waiter; not remembered as
    /// posted), and because a timed-out post leaves its entry uncommitted the
    /// next poll posts it again — it can then show twice.
    const OS_CALL_TIMEOUT: Duration = Duration::from_secs(5);
    /// OS calls still running (parked past their timeout) before the breaker
    /// stops making new ones.
    const MAX_PARKED_OS_CALLS: usize = 4;
    /// Posted alerts whose handle is kept for a retract (Linux), at most;
    /// the oldest is dropped first.
    #[cfg(all(unix, not(target_os = "macos")))]
    const MAX_HELD_HANDLES: usize = 64;

    /// Managed state. Its presence is what `notification_feed_native_consumer`
    /// reports: a host that manages it runs the consumer thread.
    pub(crate) struct NotificationFeed {
        consumer: SharedConsumer<CursorFile>,
        open_link: Mutex<Option<(String, Instant)>>,
        sink: Mutex<Option<OsAlertSink>>,
    }

    impl Default for NotificationFeed {
        fn default() -> Self {
            Self {
                consumer: SharedConsumer::new(),
                open_link: Mutex::new(None),
                sink: Mutex::new(None),
            }
        }
    }

    /// Milliseconds on a monotonic clock: the adoption grace must not jump
    /// with a wall-clock change.
    fn monotonic_ms() -> u64 {
        static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
        START.get_or_init(Instant::now).elapsed().as_millis() as u64
    }

    fn config_dir(app: &AppHandle) -> Option<PathBuf> {
        app.path().app_config_dir().ok()
    }

    fn init_consumer(app: &AppHandle) -> impl FnOnce() -> Option<(FeedConsumer, CursorFile)> + '_ {
        move || {
            let file = CursorFile::in_dir(&config_dir(app)?);
            Some((FeedConsumer::with_cursors(file.load()), file))
        }
    }

    /// Start the consumer thread. Called once from setup, after the tray.
    pub(crate) fn start(app: &AppHandle) -> std::io::Result<()> {
        let app = app.clone();
        std::thread::Builder::new()
            .name("station-notification-feed".into())
            .spawn(move || loop {
                std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
                poll_once(&app);
            })
            .map(|_| ())
    }

    fn main_window_focused(app: &AppHandle) -> bool {
        app.get_webview_window("main").is_some_and(|window| {
            window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false)
        })
    }

    fn poll_once(app: &AppHandle) {
        // No host-authorized Station yet (the webview authorizes it at boot):
        // nothing to read, and no invented credential.
        let Some(origin) = crate::native_active_station_origin(app) else {
            return;
        };
        let Ok(credential) = crate::native_credential_for_origin(app, &origin) else {
            return;
        };
        let Some(installation) =
            config_dir(app).and_then(|dir| crate::desktop_installation::read_or_create(&dir).ok())
        else {
            return;
        };
        let state = app.state::<NotificationFeed>();
        let Some((after, epoch)) = state.consumer.request(init_consumer(app), &origin) else {
            return;
        };
        let Some(feed) = read_feed(&origin, &credential, &installation, after, epoch.as_deref())
        else {
            return;
        };
        let focused = main_window_focused(app);
        // Only the sink lock is held across the OS calls; the consumer lock
        // is taken to plan and to commit (see `SharedConsumer::apply`).
        let mut sink_guard = state
            .sink
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let sink = sink_guard.get_or_insert_with(|| OsAlertSink::new(app.clone()));
        let _ = state.consumer.apply(
            init_consumer(app),
            &origin,
            &feed,
            focused,
            monotonic_ms(),
            sink,
        );
    }

    fn read_feed(
        origin: &str,
        credential: &str,
        installation: &str,
        after: u64,
        epoch: Option<&str>,
    ) -> Option<Feed> {
        let mut url = url::Url::parse(origin)
            .ok()?
            .join("/api/notifications/deliveries")
            .ok()?;
        url.query_pairs_mut()
            .append_pair("after", &after.to_string());
        if let Some(epoch) = epoch {
            url.query_pairs_mut().append_pair("epoch", epoch);
        }
        let request = ureq::http::Request::builder()
            .method("GET")
            .uri(url.as_str())
            .header("Authorization", format!("Bearer {credential}"))
            .header("Accept", "application/json")
            // `DESKTOP_INSTALLATION_HEADER` in packages/contracts/src/notification-preferences.ts.
            .header("X-Station-Desktop-Installation", installation)
            .body(Vec::new())
            .ok()?;
        let agent = crate::native_http_agent();
        let request = agent
            .configure_request(request)
            .timeout_global(Some(REQUEST_TIMEOUT))
            .build();
        let mut response = agent.run(request).ok()?;
        if response.status().as_u16() != 200 {
            return None;
        }
        let mut body = String::new();
        response
            .body_mut()
            .as_reader()
            .take(BODY_LIMIT + 1)
            .read_to_string(&mut body)
            .ok()?;
        if body.len() as u64 > BODY_LIMIT {
            return None;
        }
        parse_feed_response(&body)
    }

    /// Record the link a click asked for and bring the app forward. The
    /// webview takes the link once; a stale one expires.
    fn open_from_click(app: &AppHandle, link: Option<String>) {
        if let Some(link) = link {
            if let Some(state) = app.try_state::<NotificationFeed>() {
                *state
                    .open_link
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                    Some((link, Instant::now()));
            }
        }
        crate::request_main_window_activation(app);
        if let Err(error) = app.emit_to("main", OPEN_EVENT, ()) {
            log::warn!("could not hand a notification click to the app: {error}");
        }
    }

    /// Linux: handles kept for a retract, oldest first.
    #[cfg(all(unix, not(target_os = "macos")))]
    #[derive(Default)]
    struct HeldHandles {
        map: HashMap<String, Arc<notify_rust::NotificationHandle>>,
        order: VecDeque<String>,
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    impl HeldHandles {
        fn insert(&mut self, id: String, handle: Arc<notify_rust::NotificationHandle>) {
            self.order.retain(|held| *held != id);
            self.order.push_back(id.clone());
            self.map.insert(id, handle);
            while self.map.len() > MAX_HELD_HANDLES {
                let Some(oldest) = self.order.pop_front() else {
                    break;
                };
                self.map.remove(&oldest);
            }
        }

        fn remove(&mut self, id: &str) -> Option<Arc<notify_rust::NotificationHandle>> {
            self.order.retain(|held| held != id);
            self.map.remove(id)
        }
    }

    /// Closes what the platform backend can close; see the module comment.
    ///
    /// Clicks are observed by one waiting thread per alert, at most
    /// [`MAX_CLICK_WAITERS`]. On macOS (NSUserNotificationCenter) a waiter
    /// returns only when its notification is clicked, dismissed, or leaves
    /// Notification Center, so a person who never clears Notification Center
    /// keeps its slots taken: past the cap, alerts still show but their
    /// clicks open nothing.
    pub(crate) struct OsAlertSink {
        app: AppHandle,
        waiters: Arc<std::sync::atomic::AtomicUsize>,
        gate: OsCallGate,
        #[cfg(all(unix, not(target_os = "macos")))]
        handles: Arc<Mutex<HeldHandles>>,
    }

    impl OsAlertSink {
        fn new(app: AppHandle) -> Self {
            Self {
                app,
                waiters: Arc::default(),
                gate: OsCallGate::new(MAX_PARKED_OS_CALLS, OS_CALL_TIMEOUT),
                #[cfg(all(unix, not(target_os = "macos")))]
                handles: Arc::default(),
            }
        }

        fn claim_waiter(&self) -> bool {
            use std::sync::atomic::Ordering;
            self.waiters
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| {
                    (count < MAX_CLICK_WAITERS).then_some(count + 1)
                })
                .is_ok()
        }
    }

    fn is_open_action(action: &str) -> bool {
        // macOS reports the action label; other backends use its id.
        action == "default" || action == "Open"
    }

    impl AlertSink for OsAlertSink {
        fn post(&mut self, alert: &Alert) -> OsOutcome {
            let mut notification = notify_rust::Notification::new();
            notification
                .summary(&alert.title)
                .body(alert.body.as_deref().unwrap_or(""))
                .action("default", "Open");
            #[cfg(target_os = "macos")]
            let _ = notify_rust::set_application(&self.app.config().identifier);
            #[cfg(target_os = "windows")]
            notification.app_id(&self.app.config().identifier);
            // Gated: on Linux `show` is a D-Bus round trip with no timeout.
            let shown = match self.gate.run(move || notification.show()) {
                None => {
                    log::warn!("a notification did not show within {OS_CALL_TIMEOUT:?}, or the notification service is stuck; retrying next poll");
                    return OsOutcome::Deferred;
                }
                Some(Err(_)) => return OsOutcome::NotDone,
                Some(Ok(shown)) => shown,
            };
            let app = self.app.clone();
            let link = alert.link.clone();
            #[cfg(all(unix, not(target_os = "macos")))]
            {
                let shown = Arc::new(shown);
                self.handles
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .insert(alert.notification_id.clone(), Arc::clone(&shown));
                if self.claim_waiter() {
                    let waiters = Arc::clone(&self.waiters);
                    let handles = Arc::clone(&self.handles);
                    let id = alert.notification_id.clone();
                    std::thread::spawn(move || {
                        tauri::async_runtime::block_on(shown.wait_for_action_async(
                            |response| {
                                if matches!(response, notify_rust::NotificationResponse::Default)
                                    || matches!(response, notify_rust::NotificationResponse::Action(action) if is_open_action(action))
                                {
                                    open_from_click(&app, link);
                                }
                            },
                        ));
                        // Answered or closed: nothing left to take down.
                        let mut handles = handles
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        if handles
                            .map
                            .get(&id)
                            .is_some_and(|held| Arc::ptr_eq(held, &shown))
                        {
                            handles.remove(&id);
                        }
                        waiters.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                    });
                }
            }
            #[cfg(not(all(unix, not(target_os = "macos"))))]
            {
                if self.claim_waiter() {
                    let waiters = Arc::clone(&self.waiters);
                    std::thread::spawn(move || {
                        shown.wait_for_action(|action| {
                            if is_open_action(action) {
                                open_from_click(&app, link);
                            }
                        });
                        waiters.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                    });
                } else {
                    // Shown without observing its click (macOS sends on drop).
                    drop(shown);
                }
            }
            OsOutcome::Done
        }

        fn close(&mut self, notification_id: &str) -> OsOutcome {
            #[cfg(all(unix, not(target_os = "macos")))]
            {
                let held = self
                    .handles
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(notification_id);
                let Some(handle) = held else {
                    return OsOutcome::NotDone;
                };
                let closing = Arc::clone(&handle);
                // Gated D-Bus `CloseNotification`.
                if self
                    .gate
                    .run(move || tauri::async_runtime::block_on(closing.close_async()))
                    .is_some()
                {
                    return OsOutcome::Done;
                }
                // Kept, so the retried retract can close it.
                self.handles
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .insert(notification_id.to_string(), handle);
                OsOutcome::Deferred
            }
            #[cfg(not(all(unix, not(target_os = "macos"))))]
            {
                // notify-rust 4.18's NSUserNotificationCenter and Windows
                // handles expose no close.
                let _ = notification_id;
                OsOutcome::NotDone
            }
        }
    }

    /// Whether this host consumes the delivery feed itself. The webview posts
    /// nothing from the feed when it does.
    #[tauri::command]
    pub(crate) fn notification_feed_native_consumer(app: AppHandle) -> bool {
        app.try_state::<NotificationFeed>().is_some()
    }

    /// The webview hands over the cursor an older build kept in
    /// localStorage. `origin` is the Station origin the cursor belongs to.
    /// Main window only, and off the main thread: it takes the consumer lock.
    #[tauri::command(async)]
    pub(crate) fn notification_feed_adopt_cursor<R: Runtime>(
        window: tauri::WebviewWindow<R>,
        app: AppHandle,
        origin: String,
        cursor: StoredCursor,
    ) -> bool {
        if window.label() != "main" {
            return false;
        }
        let Ok(parsed) = url::Url::parse(&origin) else {
            return false;
        };
        let origin = parsed.origin().ascii_serialization();
        let Some(state) = app.try_state::<NotificationFeed>() else {
            return false;
        };
        state
            .consumer
            .hand_over(init_consumer(&app), &origin, cursor)
    }

    /// The link the last notification click asked for, once. Main window only.
    #[tauri::command]
    pub(crate) fn take_notification_open_link<R: Runtime>(
        window: tauri::WebviewWindow<R>,
        app: AppHandle<R>,
    ) -> Option<String> {
        if window.label() != "main" {
            return None;
        }
        let state = app.try_state::<NotificationFeed>()?;
        let taken = state
            .open_link
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take()?;
        (taken.1.elapsed() < OPEN_LINK_TTL).then_some(taken.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORIGIN: &str = "http://127.0.0.1:4100";
    const SURFACE: &str = "local:desktop-6f1c2d3e-aaaa-4bbb-8ccc-111122223333";

    #[derive(Default)]
    struct FakeSink {
        posted: Vec<Alert>,
        open: HashSet<String>,
        closed: Vec<String>,
    }
    impl AlertSink for FakeSink {
        fn post(&mut self, alert: &Alert) -> OsOutcome {
            self.open.insert(alert.notification_id.clone());
            self.posted.push(alert.clone());
            OsOutcome::Done
        }
        fn close(&mut self, notification_id: &str) -> OsOutcome {
            if self.open.remove(notification_id) {
                self.closed.push(notification_id.to_string());
                OsOutcome::Done
            } else {
                OsOutcome::NotDone
            }
        }
    }

    #[derive(Default)]
    struct MemoryStore {
        saved: Option<HashMap<String, StoredCursor>>,
    }
    impl CursorStore for MemoryStore {
        fn save(&mut self, cursors: &HashMap<String, StoredCursor>) {
            self.saved = Some(cursors.clone());
        }
    }

    fn alert(seq: u64, id: &str) -> FeedEntry {
        FeedEntry::Alert {
            seq,
            notification_id: id.into(),
            title: format!("Alert {id}"),
            body: Some(format!("Body {id}")),
            urgency: "done".into(),
            link: Some("/?surface=activity".into()),
        }
    }
    fn retract(seq: u64, id: &str) -> FeedEntry {
        FeedEntry::Retract {
            seq,
            notification_id: id.into(),
        }
    }
    fn feed(cursor: u64, entries: Vec<FeedEntry>, epoch: &str) -> Feed {
        Feed {
            surface: SURFACE.into(),
            entries,
            cursor,
            epoch: epoch.into(),
        }
    }
    fn stored(cursor: u64, epoch: &str) -> StoredCursor {
        StoredCursor {
            surface: SURFACE.into(),
            cursor,
            epoch: epoch.into(),
        }
    }
    fn started(cursor: u64, epoch: &str) -> FeedConsumer {
        FeedConsumer::with_cursors(HashMap::from([(ORIGIN.to_string(), stored(cursor, epoch))]))
    }
    fn ids(sink: &FakeSink) -> Vec<&str> {
        sink.posted
            .iter()
            .map(|alert| alert.notification_id.as_str())
            .collect()
    }

    #[test]
    fn posts_new_entries_and_persists_the_cursor_and_epoch() {
        let mut consumer = started(4, "run-1");
        let (mut sink, mut store) = (FakeSink::default(), MemoryStore::default());
        assert_eq!(consumer.request(ORIGIN), (4, Some("run-1".into())));
        let applied = consumer.apply(
            ORIGIN,
            &feed(
                6,
                vec![alert(4, "old"), alert(5, "n-1"), alert(6, "n-2")],
                "run-1",
            ),
            false,
            0,
            &mut sink,
            &mut store,
        );
        assert_eq!(applied.posted, 2);
        assert_eq!(ids(&sink), ["n-1", "n-2"]);
        assert_eq!(store.saved.unwrap()[ORIGIN], stored(6, "run-1"));
        assert_eq!(consumer.request(ORIGIN), (6, Some("run-1".into())));
    }

    #[test]
    fn a_persisted_cursor_survives_a_restart_through_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let mut file = CursorFile::in_dir(dir.path());
        let mut consumer = started(1, "run-1");
        let mut sink = FakeSink::default();
        consumer.apply(
            ORIGIN,
            &feed(3, vec![alert(2, "a"), alert(3, "b")], "run-1"),
            false,
            0,
            &mut sink,
            &mut file,
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.path().join(CURSOR_FILE))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "the cursor file is owner-only");
        }
        let restarted = FeedConsumer::with_cursors(CursorFile::in_dir(dir.path()).load());
        assert_eq!(restarted.cursor(ORIGIN), Some(&stored(3, "run-1")));
        assert_eq!(restarted.request(ORIGIN), (3, Some("run-1".into())));
    }

    #[test]
    fn a_new_epoch_is_a_restarted_server_whose_entries_are_all_new() {
        let mut consumer = started(40, "run-1");
        let (mut sink, mut store) = (FakeSink::default(), MemoryStore::default());
        consumer.apply(
            ORIGIN,
            &feed(2, vec![alert(1, "a"), alert(2, "b")], "run-2"),
            false,
            0,
            &mut sink,
            &mut store,
        );
        assert_eq!(ids(&sink), ["a", "b"]);
        assert_eq!(consumer.cursor(ORIGIN), Some(&stored(2, "run-2")));
    }

    #[test]
    fn a_cursor_for_another_surface_is_not_used() {
        let mut consumer = FeedConsumer::with_cursors(HashMap::from([(
            ORIGIN.to_string(),
            StoredCursor {
                surface: "device:other".into(),
                cursor: 1,
                epoch: "run-1".into(),
            },
        )]));
        let (mut sink, mut store) = (FakeSink::default(), MemoryStore::default());
        let applied = consumer.apply(
            ORIGIN,
            &feed(5, vec![alert(5, "a")], "run-1"),
            false,
            0,
            &mut sink,
            &mut store,
        );
        assert!(applied.waiting);
        assert!(sink.posted.is_empty());
        assert_eq!(consumer.request(ORIGIN), (0, None));
    }

    #[test]
    fn without_a_cursor_it_starts_from_its_first_read_after_the_grace() {
        let mut consumer = FeedConsumer::default();
        let (mut sink, mut store) = (FakeSink::default(), MemoryStore::default());
        // The backlog an earlier consumer already alerted is not replayed.
        let first = consumer.apply(
            ORIGIN,
            &feed(3, vec![alert(3, "backlog")], "run-1"),
            false,
            1_000,
            &mut sink,
            &mut store,
        );
        assert!(first.waiting);
        // Arrived inside the grace: held, not lost.
        let inside = feed(4, vec![alert(3, "backlog"), alert(4, "during")], "run-1");
        assert!(
            consumer
                .apply(
                    ORIGIN,
                    &inside,
                    false,
                    1_000 + ADOPTION_GRACE_MS - 1,
                    &mut sink,
                    &mut store
                )
                .waiting
        );
        assert!(sink.posted.is_empty());
        let after = consumer.apply(
            ORIGIN,
            &inside,
            false,
            1_000 + ADOPTION_GRACE_MS,
            &mut sink,
            &mut store,
        );
        assert_eq!(after.posted, 1);
        assert_eq!(ids(&sink), ["during"]);
    }

    #[test]
    fn a_handed_over_cursor_is_adopted_so_the_handoff_neither_loses_nor_repeats() {
        let mut consumer = FeedConsumer::default();
        let (mut sink, mut store) = (FakeSink::default(), MemoryStore::default());
        // The webview posted through seq 2 before the upgrade; 3 and 4 queued
        // while the app was closed.
        let backlog = feed(
            4,
            vec![alert(1, "a"), alert(2, "b"), alert(3, "c"), alert(4, "d")],
            "run-1",
        );
        assert!(
            consumer
                .apply(ORIGIN, &backlog, false, 0, &mut sink, &mut store)
                .waiting
        );
        assert!(consumer.hand_over(ORIGIN, stored(2, "run-1")));
        consumer.apply(ORIGIN, &backlog, false, 1, &mut sink, &mut store);
        assert_eq!(ids(&sink), ["c", "d"]);
        assert_eq!(consumer.cursor(ORIGIN), Some(&stored(4, "run-1")));
    }

    #[test]
    fn a_handed_over_cursor_never_rewinds_one_the_consumer_already_has() {
        let mut consumer = started(4, "run-1");
        let (mut sink, mut store) = (FakeSink::default(), MemoryStore::default());
        assert!(
            !consumer.hand_over(ORIGIN, stored(1, "run-1")),
            "a cursor that is not adopted must not be reported as taken"
        );
        consumer.apply(
            ORIGIN,
            &feed(
                4,
                vec![alert(2, "a"), alert(3, "b"), alert(4, "c")],
                "run-1",
            ),
            false,
            0,
            &mut sink,
            &mut store,
        );
        assert!(
            sink.posted.is_empty(),
            "entries the consumer already handled must not post twice"
        );
    }

    #[test]
    fn a_retract_closes_the_alert_this_consumer_posted() {
        let mut consumer = started(0, "run-1");
        let (mut sink, mut store) = (FakeSink::default(), MemoryStore::default());
        consumer.apply(
            ORIGIN,
            &feed(1, vec![alert(1, "n-1")], "run-1"),
            false,
            0,
            &mut sink,
            &mut store,
        );
        let applied = consumer.apply(
            ORIGIN,
            &feed(2, vec![retract(2, "n-1")], "run-1"),
            false,
            0,
            &mut sink,
            &mut store,
        );
        assert_eq!(applied.closed, 1);
        assert_eq!(sink.closed, ["n-1"]);
    }

    #[test]
    fn a_retract_in_the_same_read_drops_the_alert_before_it_posts() {
        let mut consumer = started(0, "run-1");
        let (mut sink, mut store) = (FakeSink::default(), MemoryStore::default());
        consumer.apply(
            ORIGIN,
            &feed(2, vec![alert(1, "n-1"), retract(2, "n-1")], "run-1"),
            false,
            0,
            &mut sink,
            &mut store,
        );
        assert!(sink.posted.is_empty());
    }

    #[test]
    fn a_focused_window_consumes_without_posting() {
        let mut consumer = started(0, "run-1");
        let (mut sink, mut store) = (FakeSink::default(), MemoryStore::default());
        consumer.apply(
            ORIGIN,
            &feed(1, vec![alert(1, "n-1")], "run-1"),
            true,
            0,
            &mut sink,
            &mut store,
        );
        assert!(sink.posted.is_empty());
        assert_eq!(consumer.cursor(ORIGIN), Some(&stored(1, "run-1")));
    }

    #[test]
    fn the_same_alert_is_not_posted_twice_but_changed_content_is() {
        let mut consumer = started(0, "run-1");
        let (mut sink, mut store) = (FakeSink::default(), MemoryStore::default());
        consumer.apply(
            ORIGIN,
            &feed(1, vec![alert(1, "n-1")], "run-1"),
            false,
            0,
            &mut sink,
            &mut store,
        );
        // A restarted server re-delivers the same content under a new epoch.
        consumer.apply(
            ORIGIN,
            &feed(1, vec![alert(1, "n-1")], "run-2"),
            false,
            0,
            &mut sink,
            &mut store,
        );
        assert_eq!(sink.posted.len(), 1);
        let mut changed = alert(2, "n-1");
        if let FeedEntry::Alert { title, .. } = &mut changed {
            *title = "Needs input".into();
        }
        consumer.apply(
            ORIGIN,
            &feed(2, vec![changed], "run-2"),
            false,
            0,
            &mut sink,
            &mut store,
        );
        assert_eq!(sink.posted.len(), 2);
    }

    #[test]
    fn only_in_app_paths_are_handed_to_a_click() {
        for good in [
            "/",
            "/?surface=activity&session=s-1",
            "/projects/demo?chat=c&dock=open",
            "/notifications",
        ] {
            assert_eq!(in_app_link(Some(good)).as_deref(), Some(good), "{good}");
        }
        for bad in [
            "https://evil.example/",
            "//evil.example/x",
            "/\\evil.example",
            "javascript:alert(1)",
            "relative/path",
            "/a#frag",
            "/a b",
            "/a\nb",
            "/a\u{85}b",
            "",
            // Dot segments that normalize to a protocol-relative `//host`.
            "/..//evil.example",
            "/.//evil.example",
            "/%2e%2e//evil.example",
            "/%2E%2E//evil.example/x?y=1",
        ] {
            assert_eq!(in_app_link(Some(bad)), None, "{bad:?}");
        }
        // The normalized path is what a click navigates to.
        assert_eq!(in_app_link(Some("/a/../b?x=1")).as_deref(), Some("/b?x=1"));
        assert_eq!(
            in_app_link(Some(&format!("/{}", "a".repeat(MAX_LINK_LEN)))),
            None
        );
        assert_eq!(in_app_link(None), None);
    }

    #[test]
    fn a_click_carries_only_a_validated_link() {
        let mut consumer = started(0, "run-1");
        let (mut sink, mut store) = (FakeSink::default(), MemoryStore::default());
        let mut hostile = alert(1, "n-1");
        if let FeedEntry::Alert { link, .. } = &mut hostile {
            *link = Some("https://evil.example/".into());
        }
        consumer.apply(
            ORIGIN,
            &feed(2, vec![hostile, alert(2, "n-2")], "run-1"),
            false,
            0,
            &mut sink,
            &mut store,
        );
        assert_eq!(sink.posted[0].link, None);
        assert_eq!(sink.posted[1].link.as_deref(), Some("/?surface=activity"));
    }

    #[test]
    fn the_route_answer_is_parsed_and_malformed_answers_apply_nothing() {
        let body = format!(
            r#"{{"success":true,"data":{{"surface":"{SURFACE}","cursor":2,"epoch":"run-1","leaseMs":90000,"entries":[
                {{"seq":1,"kind":"alert","notificationId":"n-1","title":"Station","urgency":"done","link":"/","at":"x"}},
                {{"seq":2,"kind":"retract","notificationId":"n-1","at":"x"}}]}}}}"#
        );
        let parsed = parse_feed_response(&body).unwrap();
        assert_eq!(parsed.entries.len(), 2);
        assert_eq!(parsed.entries[1], retract(2, "n-1"));
        assert!(
            parse_feed_response(r#"{"success":false,"error":"installation_required"}"#).is_none()
        );
        assert!(
            parse_feed_response(r#"{"success":true,"data":{"surface":"s","cursor":1}}"#).is_none()
        );
        assert!(parse_feed_response("not json").is_none());
    }

    /// Answers each post from a script per notification id (default Done),
    /// and records every attempt.
    #[derive(Default)]
    struct Scripted {
        answers: HashMap<String, VecDeque<OsOutcome>>,
        attempts: Vec<String>,
    }
    impl AlertSink for Scripted {
        fn post(&mut self, alert: &Alert) -> OsOutcome {
            self.attempts.push(alert.notification_id.clone());
            self.answers
                .get_mut(&alert.notification_id)
                .and_then(VecDeque::pop_front)
                .unwrap_or(OsOutcome::Done)
        }
        fn close(&mut self, _notification_id: &str) -> OsOutcome {
            OsOutcome::NotDone
        }
    }
    fn scripted(id: &str, answers: &[OsOutcome]) -> Scripted {
        Scripted {
            answers: HashMap::from([(id.to_string(), answers.iter().copied().collect())]),
            attempts: Vec::new(),
        }
    }

    #[test]
    fn a_refused_post_is_retried_from_there_next_poll() {
        let mut consumer = started(0, "run-1");
        let mut store = MemoryStore::default();
        let mut sink = scripted("b", &[OsOutcome::NotDone]);
        let batch = feed(
            3,
            vec![alert(1, "a"), alert(2, "b"), alert(3, "c")],
            "run-1",
        );
        let applied = consumer.apply(ORIGIN, &batch, false, 0, &mut sink, &mut store);
        assert_eq!(applied.posted, 1, "a refused post is not counted");
        // Nothing after the refusal ran, and the cursor stops before it.
        assert_eq!(sink.attempts, ["a", "b"]);
        assert_eq!(consumer.request(ORIGIN), (1, Some("run-1".into())));
        consumer.apply(
            ORIGIN,
            &feed(3, vec![alert(2, "b"), alert(3, "c")], "run-1"),
            false,
            0,
            &mut sink,
            &mut store,
        );
        assert_eq!(sink.attempts, ["a", "b", "b", "c"]);
        assert_eq!(consumer.request(ORIGIN), (3, Some("run-1".into())));
    }

    #[test]
    fn an_entry_the_os_keeps_refusing_is_skipped_after_the_limit() {
        let mut consumer = started(0, "run-1");
        let mut store = MemoryStore::default();
        let mut sink = scripted("b", &[OsOutcome::NotDone; 10]);
        let batch = feed(2, vec![alert(1, "b"), alert(2, "c")], "run-1");
        for _ in 0..MAX_REFUSALS {
            consumer.apply(ORIGIN, &batch, false, 0, &mut sink, &mut store);
        }
        assert_eq!(sink.attempts, vec!["b"; MAX_REFUSALS as usize]);
        assert_eq!(consumer.request(ORIGIN), (0, Some("run-1".into())));
        // The next poll skips it instead of holding the feed forever.
        consumer.apply(ORIGIN, &batch, false, 0, &mut sink, &mut store);
        assert_eq!(sink.attempts.last().map(String::as_str), Some("c"));
        assert_eq!(
            sink.attempts.iter().filter(|id| *id == "b").count(),
            MAX_REFUSALS as usize
        );
        assert_eq!(consumer.request(ORIGIN), (2, Some("run-1".into())));
    }

    #[test]
    fn a_deferred_post_stops_the_poll_and_is_never_skipped() {
        let mut consumer = started(0, "run-1");
        let mut store = MemoryStore::default();
        let mut sink = scripted("b", &[OsOutcome::Deferred; 5]);
        let batch = feed(2, vec![alert(1, "b"), alert(2, "c")], "run-1");
        for _ in 0..5 {
            consumer.apply(ORIGIN, &batch, false, 0, &mut sink, &mut store);
        }
        // A stuck service: one attempt per poll, nothing after it, nothing committed.
        assert_eq!(sink.attempts, vec!["b"; 5]);
        assert_eq!(consumer.request(ORIGIN), (0, Some("run-1".into())));
        consumer.apply(ORIGIN, &batch, false, 0, &mut sink, &mut store);
        assert_eq!(&sink.attempts[5..], ["b", "c"]);
    }

    #[test]
    fn the_gate_stops_calling_while_earlier_calls_are_stuck() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::mpsc::channel;
        use std::sync::Arc;
        use std::time::Duration;

        let gate = OsCallGate::new(2, Duration::from_millis(50));
        let started_calls = Arc::new(AtomicUsize::new(0));
        let (release, released) = channel::<()>();
        let released = Arc::new(Mutex::new(released));
        let stuck = || {
            let started_calls = Arc::clone(&started_calls);
            let released = Arc::clone(&released);
            move || {
                started_calls.fetch_add(1, Ordering::SeqCst);
                let _ = released.lock().unwrap().recv();
            }
        };
        assert_eq!(gate.run(stuck()), None, "a stuck call times out");
        assert_eq!(gate.run(stuck()), None);
        // Two calls are parked: the breaker makes no third call at all.
        assert_eq!(gate.run(stuck()), None);
        assert_eq!(started_calls.load(Ordering::SeqCst), 2);
        release.send(()).unwrap();
        release.send(()).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while gate.run(|| 7) != Some(7) {
            assert!(
                std::time::Instant::now() < deadline,
                "the gate never reopened"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn a_handover_during_an_uncommitted_read_is_refused_not_lost() {
        use std::sync::mpsc::{channel, Receiver, Sender};
        use std::sync::Arc;
        use std::time::Duration;

        struct Blocking {
            entered: Sender<()>,
            release: Receiver<()>,
        }
        impl AlertSink for Blocking {
            fn post(&mut self, _alert: &Alert) -> OsOutcome {
                let _ = self.entered.send(());
                let _ = self.release.recv();
                OsOutcome::Done
            }
            fn close(&mut self, _notification_id: &str) -> OsOutcome {
                OsOutcome::NotDone
            }
        }
        let shared: Arc<SharedConsumer<MemoryStore>> = Arc::new(SharedConsumer::new());
        let init = || Some((FeedConsumer::default(), MemoryStore::default()));
        let batch = feed(2, vec![alert(2, "n-1")], "run-1");
        let mut idle = FakeSink::default();
        // First read: no cursor, inside the grace.
        let first = shared.apply(init, ORIGIN, &feed(1, vec![], "run-1"), false, 0, &mut idle);
        assert!(first.unwrap().waiting);
        let (entered_tx, entered_rx) = channel();
        let (release_tx, release_rx) = channel();
        let applying = {
            let shared = Arc::clone(&shared);
            std::thread::spawn(move || {
                let mut sink = Blocking {
                    entered: entered_tx,
                    release: release_rx,
                };
                // Past the grace: this read starts from its first read and posts.
                shared.apply(|| None, ORIGIN, &batch, false, ADOPTION_GRACE_MS, &mut sink)
            })
        };
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        // The webview's offer lands while that read is posting.
        let taken = shared.hand_over(|| None, ORIGIN, stored(0, "run-1"));
        release_tx.send(()).unwrap();
        applying.join().unwrap();
        assert!(
            !taken,
            "an offer the pending commit will discard must not be reported as taken"
        );
        assert_eq!(
            shared.request(|| None, ORIGIN),
            Some((2, Some("run-1".into())))
        );
    }

    #[test]
    fn the_least_recently_used_origin_is_evicted() {
        let mut consumer = FeedConsumer::default();
        let (mut sink, mut store) = (FakeSink::default(), MemoryStore::default());
        let origin = |index: usize| format!("http://127.0.0.1:{}", 5000 + index);
        for index in 0..MAX_STORED_ORIGINS {
            assert!(consumer.hand_over(&origin(index), stored(0, "run-1")));
            consumer.apply(
                &origin(index),
                &feed(1, vec![], "run-1"),
                false,
                0,
                &mut sink,
                &mut store,
            );
        }
        // Origin 0 is used again, so origin 1 is now the least recent.
        consumer.apply(
            &origin(0),
            &feed(2, vec![], "run-1"),
            false,
            0,
            &mut sink,
            &mut store,
        );
        assert!(consumer.hand_over(&origin(99), stored(0, "run-1")));
        consumer.apply(
            &origin(99),
            &feed(1, vec![], "run-1"),
            false,
            0,
            &mut sink,
            &mut store,
        );
        assert!(consumer.cursor(&origin(0)).is_some());
        assert!(consumer.cursor(&origin(1)).is_none());
        assert!(consumer.cursor(&origin(99)).is_some());
    }

    #[test]
    fn a_blocked_sink_does_not_block_a_handover_or_hold_the_consumer_lock() {
        use std::sync::mpsc::{channel, Receiver, Sender};
        use std::sync::Arc;
        use std::time::Duration;

        struct Blocking {
            entered: Sender<()>,
            release: Receiver<()>,
        }
        impl AlertSink for Blocking {
            fn post(&mut self, _alert: &Alert) -> OsOutcome {
                let _ = self.entered.send(());
                let _ = self.release.recv();
                OsOutcome::Done
            }
            fn close(&mut self, _notification_id: &str) -> OsOutcome {
                OsOutcome::NotDone
            }
        }
        let shared: Arc<SharedConsumer<MemoryStore>> = Arc::new(SharedConsumer::new());
        let init = || Some((started(0, "run-1"), MemoryStore::default()));
        assert!(shared.request(init, ORIGIN).is_some());
        let (entered_tx, entered_rx) = channel();
        let (release_tx, release_rx) = channel();
        let applying = {
            let shared = Arc::clone(&shared);
            std::thread::spawn(move || {
                let mut sink = Blocking {
                    entered: entered_tx,
                    release: release_rx,
                };
                shared.apply(
                    || None,
                    ORIGIN,
                    &feed(1, vec![alert(1, "n-1")], "run-1"),
                    false,
                    0,
                    &mut sink,
                )
            })
        };
        entered_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("the sink was reached");
        // The sink is stalled inside an OS call. A handover must still run.
        let (done_tx, done_rx) = channel();
        {
            let shared = Arc::clone(&shared);
            std::thread::spawn(move || {
                let _ = done_tx.send(shared.hand_over(
                    || None,
                    "http://127.0.0.1:4200",
                    stored(3, "run-1"),
                ));
            });
        }
        let handed = done_rx.recv_timeout(Duration::from_secs(2));
        release_tx.send(()).unwrap();
        let applied = applying.join().unwrap().unwrap();
        assert_eq!(handed, Ok(true), "a handover waited on a stalled OS call");
        assert_eq!(applied.posted, 1);
        assert_eq!(
            shared.request(|| None, ORIGIN),
            Some((1, Some("run-1".into())))
        );
    }
}
