use mdns_sd::{
    instance_name_unescaped, DaemonStatus, IfKind, IfPredicate, RecvTimeoutError, ResolvedService,
    ServiceDaemon, ServiceEvent,
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, VecDeque},
    net::Ipv4Addr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

const SERVICE_TYPE: &str = "_station._tcp.local.";
const SCAN_DURATION: Duration = Duration::from_secs(5);
const SHUTDOWN_DURATION: Duration = Duration::from_millis(1500);
const MAX_CANDIDATES: usize = 32;

#[derive(Default, Clone)]
pub struct DiscoveryState(Arc<Mutex<Scans>>);

#[derive(Clone)]
pub struct DiscoveryAdmission(pub Arc<dyn Fn() -> bool + Send + Sync>);

#[derive(Default)]
struct Scans {
    active: Option<(String, Arc<AtomicBool>)>,
    cancelled: VecDeque<String>,
}

impl DiscoveryState {
    fn start(&self, scan_id: &str) -> Result<Arc<AtomicBool>, &'static str> {
        if scan_id.is_empty()
            || scan_id.len() > 128
            || !scan_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
        {
            return Err("failed");
        }
        let mut scans = self.0.lock().map_err(|_| "failed")?;
        if let Some(index) = scans.cancelled.iter().position(|entry| entry == scan_id) {
            scans.cancelled.remove(index);
            return Err("cancelled");
        }
        if scans.active.is_some() {
            return Err("unavailable");
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        scans.active = Some((scan_id.to_owned(), cancelled.clone()));
        Ok(cancelled)
    }

    fn cancel(&self, scan_id: &str) {
        if let Ok(mut scans) = self.0.lock() {
            if let Some((active_id, cancelled)) = &scans.active {
                if active_id == scan_id {
                    cancelled.store(true, Ordering::Release);
                    return;
                }
            }
            if scan_id.len() <= 128 && !scans.cancelled.iter().any(|entry| entry == scan_id) {
                scans.cancelled.push_back(scan_id.to_owned());
                if scans.cancelled.len() > MAX_CANDIDATES {
                    scans.cancelled.pop_front();
                }
            }
        }
    }

    fn finish(&self, scan_id: &str) {
        if let Ok(mut scans) = self.0.lock() {
            if scans
                .active
                .as_ref()
                .is_some_and(|(active_id, _)| active_id == scan_id)
            {
                scans.active = None;
            }
        }
    }

    fn complete(&self, scan_id: &str, result: Result<DiscoveryResult, ()>) -> DiscoveryResult {
        match result {
            Ok(result) => {
                self.finish(scan_id);
                result
            }
            Err(()) => DiscoveryResult::empty("failed"),
        }
    }
}

#[derive(Serialize)]
pub struct Admission {
    status: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Candidate {
    name: String,
    host: String,
    port: u16,
    transport: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    app_origin: Option<String>,
}

#[derive(Serialize)]
pub struct DiscoveryResult {
    status: &'static str,
    candidates: Vec<Candidate>,
}

impl DiscoveryResult {
    fn empty(status: &'static str) -> Self {
        Self {
            status,
            candidates: Vec::new(),
        }
    }
}

#[tauri::command]
pub async fn prepare(admission: tauri::State<'_, DiscoveryAdmission>) -> Result<Admission, ()> {
    let check = admission.0.clone();
    let enabled = tauri::async_runtime::spawn_blocking(move || check())
        .await
        .unwrap_or(false);
    Ok(Admission {
        status: if enabled { "ready" } else { "unavailable" },
    })
}

#[tauri::command]
pub fn cancel(state: tauri::State<'_, DiscoveryState>, scan_id: String) -> Admission {
    state.cancel(&scan_id);
    Admission {
        status: "cancelled",
    }
}

#[tauri::command]
pub async fn discover(
    state: tauri::State<'_, DiscoveryState>,
    admission: tauri::State<'_, DiscoveryAdmission>,
    scan_id: String,
) -> Result<DiscoveryResult, ()> {
    let cancelled = match state.start(&scan_id) {
        Ok(cancelled) => cancelled,
        Err(status) => return Ok(DiscoveryResult::empty(status)),
    };
    let check = admission.0.clone();
    let worker = tauri::async_runtime::spawn_blocking(move || {
        if check() {
            browse(cancelled)
        } else {
            Ok(DiscoveryResult::empty("unavailable"))
        }
    })
    .await;
    Ok(state.complete(&scan_id, worker.unwrap_or(Err(()))))
}

fn private_ipv4(address: Ipv4Addr) -> bool {
    address.is_private() || address.is_link_local()
}

fn candidate(service: &ResolvedService) -> Option<Candidate> {
    let transport = service.get_property_val_str("transport")?;
    if service.get_property_val_str("v") != Some("1")
        || !matches!(transport, "http" | "https")
        || service.get_port() == 0
    {
        return None;
    }
    let address = service
        .get_addresses_v4()
        .into_iter()
        .filter(|address| private_ipv4(*address))
        .min()?;
    let name: String = instance_name_unescaped(service.get_fullname())
        .chars()
        .filter(|character| !character.is_control())
        .take(100)
        .collect();
    let app_origin = service
        .get_property_val_str("appOrigin")
        .filter(|value| !value.is_empty() && value.len() <= 245)
        .map(str::to_owned);
    Some(Candidate {
        name,
        host: address.to_string(),
        port: service.get_port(),
        transport: transport.to_owned(),
        app_origin,
    })
}

fn browse(cancelled: Arc<AtomicBool>) -> Result<DiscoveryResult, ()> {
    if cancelled.load(Ordering::Acquire) {
        return Ok(DiscoveryResult::empty("cancelled"));
    }
    let daemon = match ServiceDaemon::new() {
        Ok(daemon) => daemon,
        Err(_) => return Ok(DiscoveryResult::empty("unavailable")),
    };
    let result = browse_daemon(&daemon, &cancelled);
    let _ = daemon.stop_browse(SERVICE_TYPE);
    let shutdown = daemon
        .shutdown()
        .ok()
        .and_then(|receiver| receiver.recv_timeout(SHUTDOWN_DURATION).ok());
    if shutdown != Some(DaemonStatus::Shutdown) {
        return Err(());
    }
    if cancelled.load(Ordering::Acquire) {
        return Ok(DiscoveryResult::empty("cancelled"));
    }
    Ok(result)
}

fn browse_daemon(daemon: &ServiceDaemon, cancelled: &AtomicBool) -> DiscoveryResult {
    if daemon.disable_interface(IfKind::All).is_err()
        || daemon
            .enable_interface(IfKind::Predicate(IfPredicate::new(
                |interface| match interface.ip() {
                    std::net::IpAddr::V4(address) => private_ipv4(address),
                    std::net::IpAddr::V6(_) => false,
                },
            )))
            .is_err()
    {
        return DiscoveryResult::empty("unavailable");
    }
    let events = match daemon.browse(SERVICE_TYPE) {
        Ok(events) => events,
        Err(_) => return DiscoveryResult::empty("unavailable"),
    };
    let deadline = Instant::now() + SCAN_DURATION;
    let mut candidates = BTreeMap::new();
    while Instant::now() < deadline {
        if cancelled.load(Ordering::Acquire) {
            return DiscoveryResult::empty("cancelled");
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        match events.recv_timeout(remaining.min(Duration::from_millis(50))) {
            Ok(ServiceEvent::ServiceResolved(service)) => {
                let key = service.get_fullname().to_owned();
                if let Some(candidate) = candidate(&service) {
                    if candidates.len() < MAX_CANDIDATES || candidates.contains_key(&key) {
                        candidates.insert(key, candidate);
                    }
                } else {
                    candidates.remove(&key);
                }
            }
            Ok(ServiceEvent::ServiceRemoved(_, fullname)) => {
                candidates.remove(&fullname);
            }
            Err(RecvTimeoutError::Disconnected) => return DiscoveryResult::empty("failed"),
            Err(RecvTimeoutError::Timeout) | Ok(_) => {}
        }
    }
    DiscoveryResult {
        status: if candidates.is_empty() {
            "empty"
        } else {
            "available"
        },
        candidates: candidates.into_values().collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdns_sd::ServiceInfo;

    #[test]
    fn resolved_advertisements_are_only_bounded_private_endpoint_hints() {
        let properties = [
            ("v", "1"),
            ("transport", "http"),
            ("appOrigin", "https://station.example.com"),
        ];
        let service = ServiceInfo::new(
            SERVICE_TYPE,
            "Nearby",
            "station.local.",
            "192.168.1.5",
            43141,
            &properties[..],
        )
        .unwrap()
        .as_resolved_service();
        let hint = candidate(&service).unwrap();
        assert_eq!(hint.host, "192.168.1.5");
        assert_eq!(hint.port, 43141);
        assert_eq!(
            hint.app_origin.as_deref(),
            Some("https://station.example.com")
        );
        for address in ["127.0.0.1", "8.8.8.8", "100.64.0.1", "::1"] {
            let service = ServiceInfo::new(
                SERVICE_TYPE,
                "Nearby",
                "station.local.",
                address,
                43141,
                &properties[..],
            )
            .unwrap()
            .as_resolved_service();
            assert!(candidate(&service).is_none(), "accepted {address}");
        }
        for properties in [
            vec![("v", "2"), ("transport", "http")],
            vec![("v", "1"), ("transport", "ftp")],
            vec![("transport", "https")],
        ] {
            let service = ServiceInfo::new(
                SERVICE_TYPE,
                "Nearby",
                "station.local.",
                "192.168.1.5",
                43141,
                &properties[..],
            )
            .unwrap()
            .as_resolved_service();
            assert!(candidate(&service).is_none());
        }
    }

    #[test]
    fn cancellation_is_exact_and_keeps_the_worker_slot_until_cleanup() {
        let state = DiscoveryState::default();
        state.cancel("cancel-before-start");
        assert_eq!(state.start("cancel-before-start").unwrap_err(), "cancelled");
        let first = state.start("first").unwrap();
        state.cancel("unrelated");
        assert!(!first.load(Ordering::Acquire));
        state.cancel("first");
        assert!(first.load(Ordering::Acquire));
        assert_eq!(state.start("second").unwrap_err(), "unavailable");
        state.finish("unrelated");
        assert_eq!(state.start("second").unwrap_err(), "unavailable");
        assert_eq!(
            state
                .complete("first", Ok(DiscoveryResult::empty("cancelled")))
                .status,
            "cancelled"
        );
        assert!(state.start("second").is_ok());
        assert_eq!(state.complete("second", Err(())).status, "failed");
        assert_eq!(state.start("third").unwrap_err(), "unavailable");
    }
}
