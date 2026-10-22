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
#[derive(Default)]
struct PathState(std::sync::Mutex<Option<NetworkPathSnapshot>>);

#[cfg(any(target_os = "ios", test))]
impl PathState {
    fn snapshot(&self) -> Option<NetworkPathSnapshot> {
        *self.0.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn update(&self, constrained: bool, expensive: bool, emit: impl FnOnce(NetworkPathSnapshot)) {
        let mut current = self.0.lock().unwrap_or_else(|error| error.into_inner());
        // Every path callback matters, including same-cost Wi-Fi/VPN transitions.
        crate::native_http_transport::network_changed();
        let snapshot = NetworkPathSnapshot {
            revision: current.map_or(1, |value| value.revision + 1),
            constrained,
            expensive,
        };
        *current = Some(snapshot);
        emit(snapshot);
    }
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
    use super::PathState;
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
            PATH.update(constrained, expensive, |snapshot| {
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
    fn path_callbacks_invalidate_transport_even_when_cost_is_unchanged_and_retain_latest_cost() {
        const WORKER: &str = "STATION_IOS_PATH_TEST_WORKER";
        if std::env::var_os(WORKER).is_none() {
            assert!(std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "ios_network_path::tests::path_callbacks_invalidate_transport_even_when_cost_is_unchanged_and_retain_latest_cost", "--nocapture"])
                .env(WORKER, "1")
                .status().unwrap().success());
            return;
        }
        let state = PathState::default();
        assert!(state.snapshot().is_none());
        let mut events = Vec::new();
        for (constrained, expensive) in
            [(true, false), (true, false), (false, true), (false, false)]
        {
            let before = crate::native_http_transport::network_epoch();
            state.update(constrained, expensive, |snapshot| {
                assert!(crate::native_http_transport::network_epoch() > before);
                events.push(serde_json::to_value(snapshot).unwrap());
            });
        }
        assert_eq!(
            events,
            [
                serde_json::json!({"revision": 1, "constrained": true, "expensive": false}),
                serde_json::json!({"revision": 2, "constrained": true, "expensive": false}),
                serde_json::json!({"revision": 3, "constrained": false, "expensive": true}),
                serde_json::json!({"revision": 4, "constrained": false, "expensive": false}),
            ]
        );
        assert_eq!(serde_json::to_value(state.snapshot()).unwrap(), events[3]);
    }
}
