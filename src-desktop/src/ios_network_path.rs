//! iOS path observation only: no endpoint, credentials, probes, or request replay.
use serde::Serialize;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NetworkPathSnapshot {
    revision: u64,
    constrained: bool,
    expensive: bool,
}

#[cfg(any(target_os = "ios", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PathIdentity {
    satisfied: bool,
    interfaces: u8,
}

#[cfg(any(target_os = "ios", test))]
struct ObservedPath {
    identity: PathIdentity,
    snapshot: NetworkPathSnapshot,
}

#[cfg(any(target_os = "ios", test))]
#[derive(Default)]
struct PathState(std::sync::Mutex<Option<ObservedPath>>);

#[cfg(any(target_os = "ios", test))]
impl PathState {
    fn snapshot(&self) -> Option<NetworkPathSnapshot> {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .map(|path| path.snapshot)
    }

    fn update(
        &self,
        identity: PathIdentity,
        constrained: bool,
        expensive: bool,
        emit: impl FnOnce(NetworkPathSnapshot),
    ) {
        let mut current = self.0.lock().unwrap_or_else(|error| error.into_inner());
        if current.is_none() {
            crate::native_http_transport::retire_idle_connections();
        }
        if current
            .as_ref()
            .is_some_and(|path| path.identity != identity)
        {
            crate::native_http_transport::network_changed();
        }
        if current.as_ref().is_some_and(|path| {
            path.identity == identity
                && path.snapshot.constrained == constrained
                && path.snapshot.expensive == expensive
        }) {
            return;
        }
        let snapshot = NetworkPathSnapshot {
            revision: current
                .as_ref()
                .map_or(1, |path| path.snapshot.revision + 1),
            constrained,
            expensive,
        };
        *current = Some(ObservedPath { identity, snapshot });
        emit(snapshot);
    }
}

#[cfg(any(target_os = "ios", test))]
pub(crate) fn resumed() {
    // tao 0.37.1 emits Resumed on willEnterForeground, not didBecomeActive.
    // Retire old pooled sockets without interrupting requests already in flight.
    crate::native_http_transport::retire_idle_connections();
}

#[cfg(any(target_os = "ios", test))]
fn interface_mask(mut uses: impl FnMut(u32) -> bool) -> u8 {
    // nw_interface_type_t: other=0, Wi-Fi=1, cellular=2, wired=3.
    // Loopback=4 cannot carry a remote Station route; its churn must not abort
    // response waits. Keep other because VPN/virtual interfaces can change routing.
    (0..=3).fold(
        0,
        |set, kind| {
            if uses(kind) {
                set | (1 << kind)
            } else {
                set
            }
        },
    )
}

#[tauri::command]
pub(crate) fn station_native_network_path() -> Option<NetworkPathSnapshot> {
    #[cfg(target_os = "ios")]
    return platform::PATH.snapshot();
    #[cfg(not(target_os = "ios"))]
    None
}

#[cfg(target_os = "ios")]
mod platform {
    use super::{PathIdentity, PathState};
    use block2::{Block, RcBlock};
    use dispatch2::DispatchQueue;
    use std::ffi::c_void;
    use std::ptr::NonNull;
    use std::sync::Mutex;
    use tauri::{AppHandle, Emitter, Manager};

    pub(super) static PATH: PathState = PathState(Mutex::new(None));

    #[link(name = "Network", kind = "framework")]
    extern "C" {
        fn nw_path_monitor_create() -> *mut c_void;
        fn nw_path_monitor_set_update_handler(
            monitor: *mut c_void,
            handler: &Block<dyn Fn(*mut c_void)>,
        );
        fn nw_path_monitor_set_queue(monitor: *mut c_void, queue: &DispatchQueue);
        fn nw_path_monitor_start(monitor: *mut c_void);
        fn nw_path_monitor_cancel(monitor: *mut c_void);
        fn nw_path_get_status(path: *mut c_void) -> u32;
        fn nw_path_uses_interface_type(path: *mut c_void, interface_type: u32) -> bool;
        fn nw_path_is_constrained(path: *mut c_void) -> bool;
        fn nw_path_is_expensive(path: *mut c_void) -> bool;
        fn nw_release(object: *mut c_void);
    }

    struct Monitor(NonNull<c_void>);
    // Network.framework monitor lifetime operations are thread safe. Updates
    // arrive on one serial dispatch queue; Rust never dereferences this pointer.
    unsafe impl Send for Monitor {}
    impl Drop for Monitor {
        fn drop(&mut self) {
            unsafe {
                nw_path_monitor_cancel(self.0.as_ptr());
                nw_release(self.0.as_ptr());
            }
        }
    }
    struct MonitorState(Mutex<Option<Monitor>>);

    pub(crate) fn start(app: &AppHandle) {
        let Some(pointer) = NonNull::new(unsafe { nw_path_monitor_create() }) else {
            log::warn!("iOS network path observation is unavailable");
            return;
        };
        let monitor = Monitor(pointer);
        let events = app.clone();
        let handler = RcBlock::new(move |path: *mut c_void| {
            let (constrained, expensive) =
                unsafe { (nw_path_is_constrained(path), nw_path_is_expensive(path)) };
            // Cost changes and duplicate callbacks must not retire connections.
            let identity = PathIdentity {
                satisfied: unsafe { nw_path_get_status(path) == 1 },
                interfaces: super::interface_mask(|kind| unsafe {
                    nw_path_uses_interface_type(path, kind)
                }),
            };
            PATH.update(identity, constrained, expensive, |snapshot| {
                let _ = events.emit("station://network-path", snapshot);
            });
        });
        let queue = DispatchQueue::new("io.kontourai.station.network-path", None);
        unsafe {
            // Network.framework retains the queue and copies the handler.
            nw_path_monitor_set_update_handler(pointer.as_ptr(), &handler);
            nw_path_monitor_set_queue(pointer.as_ptr(), &queue);
            nw_path_monitor_start(pointer.as_ptr());
        }
        app.manage(MonitorState(Mutex::new(Some(monitor))));
    }

    pub(crate) fn stop(app: &AppHandle) {
        if let Some(state) = app.try_state::<MonitorState>() {
            // Cancel explicitly at Exit to break the handler's AppHandle cycle.
            state
                .0
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take();
        }
    }
}

#[cfg(target_os = "ios")]
pub(crate) use platform::{start, stop};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_connectivity_or_interface_changes_invalidate_transport_and_cost_is_retained() {
        const WORKER: &str = "STATION_IOS_PATH_TEST_WORKER";
        if std::env::var_os(WORKER).is_none() {
            assert!(std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "ios_network_path::tests::only_connectivity_or_interface_changes_invalidate_transport_and_cost_is_retained", "--nocapture"])
                .env(WORKER, "1")
                .status().unwrap().success());
            return;
        }
        let state = PathState::default();
        assert!(state.snapshot().is_none());
        let mut events = Vec::new();
        let wifi = PathIdentity {
            satisfied: true,
            interfaces: 2,
        };
        let offline = PathIdentity {
            satisfied: false,
            interfaces: 0,
        };
        let cellular = PathIdentity {
            satisfied: true,
            interfaces: 4,
        };
        let wired = PathIdentity {
            satisfied: true,
            interfaces: 8,
        };
        for (identity, constrained, expensive, epoch_changes) in [
            (wifi, false, false, false), // First callback retires idle connections, without changing epoch.
            (wifi, false, false, false), // Duplicate, including app activation.
            (wifi, true, false, false),  // Low Data Mode only.
            (wifi, false, true, false),  // Cost only.
            (offline, false, true, true),
            (wifi, false, true, true),
            (cellular, false, true, true), // Same cost, different interface.
            (wired, false, false, true),
        ] {
            let before = crate::native_http_transport::network_epoch();
            state.update(identity, constrained, expensive, |snapshot| {
                events.push(serde_json::to_value(snapshot).unwrap());
            });
            assert_eq!(
                crate::native_http_transport::network_epoch() != before,
                epoch_changes
            );
        }
        assert_eq!(events.len(), 7, "duplicate callbacks do not emit");
        assert_eq!(
            events[1],
            serde_json::json!({"revision": 2, "constrained": true, "expensive": false})
        );
        assert_eq!(
            events[2],
            serde_json::json!({"revision": 3, "constrained": false, "expensive": true})
        );
        assert_eq!(
            serde_json::to_value(state.snapshot()).unwrap(),
            serde_json::json!({"revision": 7, "constrained": false, "expensive": false})
        );
    }

    #[test]
    fn loopback_only_changes_preserve_epoch_but_other_changes_advance_it() {
        const WORKER: &str = "STATION_IOS_INTERFACE_TEST_WORKER";
        if std::env::var_os(WORKER).is_none() {
            assert!(std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "ios_network_path::tests::loopback_only_changes_preserve_epoch_but_other_changes_advance_it", "--nocapture"])
                .env(WORKER, "1").status().unwrap().success());
            return;
        }
        let state = PathState::default();
        for (loopback, other, epoch_changes) in [
            (false, false, false),
            (true, false, false),
            (false, false, false),
            (false, true, true),
            (true, true, false),
            (false, true, false),
            (false, false, true),
        ] {
            let identity = PathIdentity {
                satisfied: true,
                interfaces: interface_mask(|kind| {
                    kind == 1 || (kind == 4 && loopback) || (kind == 0 && other)
                }),
            };
            let before = crate::native_http_transport::network_epoch();
            state.update(identity, false, false, |_| {});
            let reason = if epoch_changes {
                "other changes must advance the network epoch"
            } else {
                "loopback-only changes must not advance the network epoch"
            };
            assert_eq!(
                crate::native_http_transport::network_epoch() != before,
                epoch_changes,
                "{reason}"
            );
        }
    }

    #[test]
    fn resume_and_first_observation_retire_preexisting_connections_without_epoch_change() {
        const WORKER: &str = "STATION_IOS_IDLE_TEST_WORKER";
        if std::env::var_os(WORKER).is_none() {
            assert!(std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "ios_network_path::tests::resume_and_first_observation_retire_preexisting_connections_without_epoch_change", "--nocapture"])
                .env(WORKER, "1").status().unwrap().success());
            return;
        }
        let station = crate::native_http_performance_tests::KeepAliveStation::start();
        let agent = crate::native_http_agent();
        let saved = agent.clone();
        assert!(station.get(&agent, "fixture").starts_with("1:"));
        let epoch = crate::native_http_transport::network_epoch();
        let state = PathState::default();
        let wifi = PathIdentity {
            satisfied: true,
            interfaces: 2,
        };
        state.update(wifi, false, false, |_| {});
        assert_eq!(crate::native_http_transport::network_epoch(), epoch);
        assert!(
            station.get(&saved, "fixture").starts_with("2:"),
            "first observation must retire startup connections"
        );
        state.update(wifi, false, false, |_| panic!("duplicate must not emit"));
        assert!(station.get(&agent, "fixture").starts_with("2:"));
        resumed();
        assert_eq!(
            crate::native_http_transport::network_epoch(),
            epoch,
            "activation must not wake response waits"
        );
        assert!(
            station.get(&saved, "fixture").starts_with("3:"),
            "resume must retire connections even without a path callback"
        );
        assert!(station.get(&agent, "fixture").starts_with("3:"));
    }
}
