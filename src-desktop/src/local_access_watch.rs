//! Desktop-owned access review. It runs from the tray poll, not a WebView.
use serde::Deserialize;
use std::collections::HashSet;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogResult};

const ACCESS_PATH: &str = "/.well-known/station/v1/pairing/local-access";
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Target {
    pub origin: String,
    pub home: PathBuf,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    request_id: String,
    device_name: String,
    status: String,
    expires_at: u64,
}
#[derive(Default)]
struct State {
    target: Option<Target>,
    pending: Vec<Request>,
    seen: HashSet<String>,
}
#[derive(Default)]
pub(crate) struct LocalAccessWatch {
    state: Mutex<State>,
    in_flight: AtomicBool,
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn request(target: &Target, action: &str, id: Option<&str>) -> Result<serde_json::Value, String> {
    let mut body = serde_json::json!({"action": action});
    if let Some(id) = id { body["requestId"] = id.into(); }
    local_request(target, ACCESS_PATH, body)
}
fn local_request(target: &Target, path: &str, mut body: serde_json::Value) -> Result<serde_json::Value, String> {
    let url = url::Url::parse(&target.origin).map_err(|_| "Invalid local Station address")?;
    if !matches!(
        url.host_str(),
        Some("127.0.0.1") | Some("localhost") | Some("[::1]") | Some("::1")
    ) || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.scheme() != "http"
    {
        return Err("Access review requires the owned local Station".into());
    }
    let secret = crate::service_state::read_owner_only_file(
        &target.home.join("runtime/local-grant.secret"),
        "local grant secret",
    ).map_err(|_| "Could not read local Station authorization".to_string())?;
    body["secret"] = secret.trim().into();
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .max_redirects(0)
        .timeout_global(Some(Duration::from_secs(5)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut response = agent
        .post(&format!(
            "{}{path}",
            target.origin.trim_end_matches('/')
        ))
        .header("Content-Type", "application/json")
        .send(body.to_string())
        .map_err(|_| "Could not reach this Station")?;
    if response.status().as_u16() != 200 {
        return Err("The request expired, changed, or could not be authorized. Check pending requests again.".into());
    }
    let mut raw = String::new();
    response
        .body_mut()
        .as_reader()
        .take(65537)
        .read_to_string(&mut raw)
        .map_err(|_| "Could not read the Station response")?;
    if raw.len() > 65536 {
        return Err("Station response was too large".into());
    }
    serde_json::from_str(&raw).map_err(|_| "Could not read the Station response".into())
}
fn pending_requests(value: serde_json::Value) -> Result<Vec<Request>, String> {
    let items: Vec<Request> = serde_json::from_value(
        value
            .get("requests")
            .cloned()
            .ok_or("Missing request list")?,
    )
    .map_err(|_| "Invalid request list")?;
    if items.len() > 128 {
        return Err("Too many requests".into());
    }
    Ok(items
        .into_iter()
        .filter(|r| r.status == "pending" && r.expires_at > now_ms())
        .collect())
}
pub(crate) fn refresh(app: AppHandle, target: Option<Target>) {
    let watch = app.state::<LocalAccessWatch>();
    {
        let mut state = watch.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.target != target {
            state.target = target.clone();
            state.pending.clear();
            state.seen.clear();
        }
    }
    let Some(target) = target else {
        return;
    };
    if watch.in_flight.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let result = request(&target, "list", None).and_then(pending_requests);
        let watch = app.state::<LocalAccessWatch>();
        let mut fresh = Vec::new();
        {
            let mut state = watch.state.lock().unwrap_or_else(|e| e.into_inner());
            if state.target.as_ref() == Some(&target) {
                if let Ok(pending) = result {
                    state.seen.retain(|id| pending.iter().any(|request| &request.request_id == id));
                for r in &pending {
                        if state.seen.insert(r.request_id.clone()) {
                            fresh.push(r.request_id.clone());
                        }
                    }
                    state.pending = pending;
                }
            }
        }
        watch.in_flight.store(false, Ordering::SeqCst);
        for id in fresh {
            let handle = app.clone();
            let target = target.clone();
            std::thread::spawn(move || {
                let mut notification = notify_rust::Notification::new();
                notification.summary("A browser is requesting Station access").body("Click to review this request. You can also use Pending access requests in the Station tray.").action("default", "Review").timeout(300000);
                #[cfg(target_os = "macos")]
                let _ = notify_rust::set_application(&handle.config().identifier);
                #[cfg(target_os = "windows")]
                notification.app_id(&handle.config().identifier);
                if let Ok(shown) = notification.show() {
                    shown.wait_for_action(|action| {
                        // macOS reports the action label; other backends use its ID.
                        if action == "default" || action == "Review" {
                            review(handle, target, id);
                        }
                    });
                }
            });
        }
    });
}
pub(crate) fn pending_count(app: &AppHandle) -> usize {
    app.state::<LocalAccessWatch>()
        .state
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .pending
        .iter()
        .filter(|r| r.expires_at > now_ms())
        .count()
}
pub(crate) fn review_next(app: &AppHandle) {
    let state = app.state::<LocalAccessWatch>();
    let state = state.state.lock().unwrap_or_else(|e| e.into_inner());
    if let (Some(target), Some(request)) = (
        state.target.clone(),
        state.pending.iter().find(|r| r.expires_at > now_ms()),
    ) {
        review(app.clone(), target, request.request_id.clone());
    }
}
fn decision(result: MessageDialogResult) -> Option<&'static str> {
    match result {
        MessageDialogResult::Custom(label) if label == "Approve" => Some("approve"),
        MessageDialogResult::Custom(label) if label == "Deny" => Some("deny"),
        _ => None,
    }
}
fn review(app: AppHandle, target: Target, id: String) {
    std::thread::spawn(move || {
        if app
            .state::<LocalAccessWatch>()
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .target
            .as_ref()
            != Some(&target)
        {
            return;
        }
        let current = request(&target, "list", None)
            .and_then(pending_requests)
            .ok()
            .and_then(|items| items.into_iter().find(|r| r.request_id == id));
        let Some(current) = current else {
            app.dialog()
                .message("This access request has expired or was already handled.")
                .title("Station access")
                .blocking_show();
            return;
        };
        let result = app
            .dialog()
            .message(format!(
                "Allow “{}” to use this Station?\n\nStation: {}\nRequest: {}",
                current.device_name, target.origin, current.request_id
            ))
            .title("Review Station access")
            .buttons(MessageDialogButtons::YesNoCancelCustom(
                "Approve".into(),
                "Deny".into(),
                "Not now".into(),
            ))
            .blocking_show_with_result();
        if let Some(action) = decision(result) {
            if app
                .state::<LocalAccessWatch>()
                .state
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .target
                .as_ref()
                != Some(&target)
            {
                return;
            }
            if let Err(error) = request(&target, action, Some(&id)) {
                app.dialog()
                    .message(error)
                    .title("Could not update access")
                    .blocking_show();
            }
            refresh(app.clone(), Some(target));
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closing_or_cancelling_never_grants_or_denies() {
        assert_eq!(decision(MessageDialogResult::Cancel), None);
        assert_eq!(
            decision(MessageDialogResult::Custom("Not now".into())),
            None
        );
        assert_eq!(
            decision(MessageDialogResult::Custom("Approve".into())),
            Some("approve")
        );
        assert_eq!(
            decision(MessageDialogResult::Custom("Deny".into())),
            Some("deny")
        );
    }
}

pub(crate) fn browser_origin(raw: &str, scheme: &str, owned_origin: &str) -> Result<String, String> {
    let link = url::Url::parse(raw).map_err(|_| "Invalid Station link")?;
    let pairs: Vec<_> = link.query_pairs().collect();
    if link.scheme() != scheme || link.host_str() != Some("open-browser") || !link.path().is_empty() || link.fragment().is_some() || link.port().is_some() || !link.username().is_empty() || link.password().is_some() || pairs.len() != 1 || pairs[0].0 != "origin" { return Err("Invalid Station browser handoff".into()); }
    let origin = url::Url::parse(&pairs[0].1).map_err(|_| "Invalid browser address")?;
    let owned = url::Url::parse(owned_origin).map_err(|_| "Station browser address unavailable")?;
    if origin.scheme() != "http" || !matches!(origin.host_str(), Some("localhost") | Some("127.0.0.1") | Some("[::1]") | Some("::1")) || origin.port_or_known_default() != owned.port_or_known_default() || !origin.username().is_empty() || origin.password().is_some() || origin.path() != "/" || origin.query().is_some() || origin.fragment().is_some() { return Err("This browser is requesting a different Station. Open the app for that instance or use its launcher link.".into()); }
    Ok(origin.origin().ascii_serialization())
}
pub(crate) fn open_browser(app: &AppHandle, target: &Target, origin: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let response = local_request(target, "/.well-known/station/v1/pairing/mint-ui-bootstrap", serde_json::json!({"purpose":"launcher"}))?;
    let token = response.get("token").and_then(|v| v.as_str()).ok_or("No browser authorization returned")?;
    if token.len() != 43 || !token.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') { return Err("Invalid browser authorization".into()); }
    app.opener().open_url(format!("{origin}/#station-ui-bootstrap={token}"), None::<&str>).map_err(|_| "Could not open the browser".into())
}

#[cfg(test)] mod browser_tests {
 use super::*;
 #[test] fn handoff_is_bound_to_the_owned_local_browser_port_and_channel() {
   assert_eq!(browser_origin("station-nightly://open-browser?origin=http%3A%2F%2Flocalhost%3A5492", "station-nightly", "http://127.0.0.1:5492").unwrap(), "http://localhost:5492");
   for url in ["station-stable://open-browser?origin=http%3A%2F%2Flocalhost%3A5492", "station-nightly://open-browser?origin=http%3A%2F%2Flocalhost%3A9999", "station-nightly://open-browser?origin=https%3A%2F%2Fevil.example", "station-nightly://open-browser?origin=http%3A%2F%2Flocalhost%3A5492&extra=1", "station-nightly://open-browser?origin=http%3A%2F%2Flocalhost%3A5492%2Felsewhere"] {
     assert!(browser_origin(url, "station-nightly", "http://127.0.0.1:5492").is_err());
   }
 }
}
