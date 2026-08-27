//! Notification delivery that survives the app being backgrounded.
//!
//! The obvious place to raise an OS notification is the web layer: it already
//! receives every notification over SSE. That does not work. The stream lives
//! in the webview, Android suspends the webview when the app is backgrounded,
//! and SSE events are not replayed on reconnect — so a notification raised
//! while the user is elsewhere is lost rather than delivered late. Device
//! testing confirmed exactly that: notifications posted in the foreground and
//! were silent when backgrounded.
//!
//! This host-side poller keeps running while the webview is paused, which was
//! the whole point. The webview supplies the endpoint and credential once; the
//! poller owns delivery from then on.
//!
//! **DORMANT — nothing calls this. See #943 before switching it on.** Device
//! testing disproved the approach three ways on Android: the cached-app freezer
//! SIGSTOPs the entire process when backgrounded (so this thread stops too),
//! the foreground service that would prevent that is blocked by tauri#11609 and
//! tauri#15671 on the versions Station builds, and native Rust cannot resolve
//! DNS on Android at all — `example.com` fails the same way the real host does,
//! while the WebView in the same process fetches it fine.
//!
//! It is kept because the seam is right: a push relay (#917) slots in behind
//! `notification_watch_start` without the web layer changing. The full account
//! is in docs/design/notification-delivery.md.

use serde::Deserialize;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Long enough to be cheap on battery, short enough that a pairing request —
/// which expires in five minutes — is still actionable when it arrives.
const POLL_INTERVAL: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Deserialize)]
pub struct NotificationEnvelope {
    data: Vec<NotificationItem>,
}

#[derive(Debug, Deserialize)]
pub struct NotificationItem {
    id: String,
    title: String,
    #[serde(default)]
    body: Option<String>,
}

#[derive(Default)]
pub struct NotificationWatch {
    inner: Mutex<Option<Arc<AtomicBool>>>,
}

impl NotificationWatch {
    /// Replaces any watch already running. The active connection can change
    /// (a different Station, a re-pair), and two pollers would double-notify.
    pub fn restart(&self) -> Arc<AtomicBool> {
        let stop = Arc::new(AtomicBool::new(false));
        let mut guard = self.inner.lock().expect("notification watch poisoned");
        if let Some(previous) = guard.replace(Arc::clone(&stop)) {
            previous.store(true, Ordering::SeqCst);
        }
        stop
    }

    pub fn stop(&self) {
        let mut guard = self.inner.lock().expect("notification watch poisoned");
        if let Some(previous) = guard.take() {
            previous.store(true, Ordering::SeqCst);
        }
    }
}

/// What the poller decides to show, separated from the IO so it can be tested
/// without a server or a device.
///
/// Deliberately not filtering on status: which statuses are still live is
/// Station API vocabulary, and the web layer already owns that. It encodes the
/// filter into the URL it hands us, so the host has one fewer copy of a list
/// that would silently rot when the contract gains a status.
pub fn undelivered<'a>(
    items: &'a [NotificationItem],
    seen: &HashSet<String>,
) -> Vec<&'a NotificationItem> {
    items
        .iter()
        .filter(|item| !seen.contains(&item.id))
        .collect()
}

/// True on the first poll of a watch, where every notification is "new" only
/// because nothing has been seen yet. Showing them would mean a burst of
/// history every time the app reconnects.
pub fn is_priming(seen: &HashSet<String>) -> bool {
    seen.is_empty()
}

/// `url` is supplied whole by the web layer rather than assembled here — route
/// path and query filter are Station API knowledge, and this process should not
/// hold a second copy of them.
pub fn poll_once(
    url: &str,
    credential: &str,
    seen: &mut HashSet<String>,
) -> Result<Vec<(String, Option<String>)>, String> {
    // Matches how the tray probes the local server: ureq is built without
    // default features here, so there is no `json` helper — read the body and
    // hand it to serde_json.
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(REQUEST_TIMEOUT))
        .build()
        .into();
    let mut response = agent
        .get(url)
        .header("Authorization", &format!("Bearer {credential}"))
        .call()
        .map_err(|error| format!("notification poll failed: {error}"))?;

    let raw = response
        .body_mut()
        .read_to_string()
        .map_err(|error| format!("notification poll returned unreadable body: {error}"))?;
    let envelope: NotificationEnvelope = serde_json::from_str(&raw)
        .map_err(|error| format!("notification poll returned unusable body: {error}"))?;

    let priming = is_priming(seen);
    let fresh: Vec<(String, Option<String>)> = undelivered(&envelope.data, seen)
        .into_iter()
        .map(|item| (item.title.clone(), item.body.clone()))
        .collect();

    for item in &envelope.data {
        seen.insert(item.id.clone());
    }

    // Prime silently: the first poll establishes what already existed.
    Ok(if priming { Vec::new() } else { fresh })
}

pub fn poll_interval() -> Duration {
    POLL_INTERVAL
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str) -> NotificationItem {
        NotificationItem {
            id: id.to_string(),
            title: format!("title {id}"),
            body: None,
        }
    }

    #[test]
    fn shows_only_what_has_not_been_seen() {
        let items = vec![item("a"), item("b")];
        let mut seen = HashSet::new();
        seen.insert("a".to_string());
        let fresh = undelivered(&items, &seen);
        assert_eq!(fresh.len(), 1);
        assert_eq!(fresh[0].id, "b");
    }

    #[test]
    fn reads_the_shape_the_server_actually_returns() {
        // The envelope carries `success` alongside `data`; parsing must not
        // depend on the host knowing about the extra field.
        let envelope: NotificationEnvelope =
            serde_json::from_str(r#"{"success":true,"data":[{"id":"a","title":"t","body":"b"}]}"#)
                .expect("envelope parses");
        assert_eq!(envelope.data.len(), 1);
        assert_eq!(envelope.data[0].body.as_deref(), Some("b"));
    }

    #[test]
    fn tolerates_a_notification_with_no_body() {
        // `body` is optional on the contract.
        let envelope: NotificationEnvelope =
            serde_json::from_str(r#"{"data":[{"id":"a","title":"t"}]}"#).expect("envelope parses");
        assert!(envelope.data[0].body.is_none());
    }

    #[test]
    fn the_http_client_can_actually_speak_tls() {
        // The Station a phone pairs with is normally reached over HTTPS (a
        // Tailscale-served host). ureq is declared with default-features off,
        // and without a TLS backend every such poll fails with "TLS required,
        // but transport is unsecured" — silently, since the watch swallows
        // errors to keep polling. That shipped once and only turned up on a
        // device, so pin it here.
        //
        // A real listener is needed: ureq connects before it negotiates, so a
        // closed port fails with connection-refused and never reaches the TLS
        // layer at all. (The first version of this test did exactly that and
        // passed with no TLS backend compiled in.) Nothing is served — the
        // handshake is expected to fail; what matters is *how*.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind a local listener");
        let port = listener.local_addr().expect("listener address").port();
        std::thread::spawn(move || {
            // Accept and drop, so the client gets a connection to negotiate on.
            let _ = listener.accept();
        });

        let agent: ureq::Agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(5)))
            .build()
            .into();
        let error = match agent
            .get(&format!("https://127.0.0.1:{port}/notifications"))
            .call()
        {
            Err(error) => error.to_string(),
            Ok(_) => panic!("nothing is served here, so this cannot succeed"),
        };
        assert!(
            !error.contains("TLS required"),
            "ureq has no TLS backend compiled in: {error}"
        );
    }

    #[test]
    fn the_first_poll_is_priming() {
        assert!(is_priming(&HashSet::new()));
        let mut seen = HashSet::new();
        seen.insert("a".to_string());
        assert!(!is_priming(&seen));
    }

    #[test]
    fn restarting_stops_the_previous_watch() {
        // Two pollers against the same Station would notify twice.
        let watch = NotificationWatch::default();
        let first = watch.restart();
        assert!(!first.load(Ordering::SeqCst));
        let _second = watch.restart();
        assert!(first.load(Ordering::SeqCst), "previous watch kept running");
    }

    #[test]
    fn stopping_ends_the_watch() {
        let watch = NotificationWatch::default();
        let stop = watch.restart();
        watch.stop();
        assert!(stop.load(Ordering::SeqCst));
    }
}
