//! WKWebView recovery stays on the main thread and never reloads in background.
use super::mobile_recovery::{RecoveryAction, RendererRecovery};
use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Webview};

static RECOVERY: OnceLock<Mutex<HashMap<String, RendererRecovery>>> = OnceLock::new();
fn backgrounded() -> bool {
    assert!(objc2::MainThreadMarker::new().is_some());
    unsafe {
        let app: &AnyObject = msg_send![
            AnyClass::get(c"UIApplication").expect("UIKit UIApplication"),
            sharedApplication
        ];
        let state: isize = msg_send![app, applicationState];
        state == 2
    }
}
fn act(webview: &Webview, action: RecoveryAction) {
    match action {
        RecoveryAction::Deferred => {}
        RecoveryAction::Reload => {
            let _ = webview.reload();
        }
        RecoveryAction::ShowError => {
            // Native alert survives another renderer death. Reload requires a person.
            use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
            let view = webview.clone();
            webview
                .app_handle()
                .dialog()
                .message("Station could not restore this screen.")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Reload".into(),
                    "Close".into(),
                ))
                .show(move |reload| {
                    if reload {
                        if let Some(state) = RECOVERY.get() {
                            state
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .remove(view.label());
                        }
                        let app = view.app_handle().clone();
                        let _ = app.run_on_main_thread(move || {
                            // A dialog can complete after backgrounding; queue the request.
                            terminated(&view);
                        });
                    }
                });
        }
    }
}
pub(crate) fn terminated(webview: &Webview) {
    let action = RECOVERY
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(webview.label().to_owned())
        .or_default()
        .terminated(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default(),
            !backgrounded(),
        );
    act(webview, action);
}
pub(crate) fn foreground(app: &AppHandle) {
    let Some(states) = RECOVERY.get() else {
        return;
    };
    let actions: Vec<_> = states
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter_mut()
        .map(|(label, state)| {
            (
                label.clone(),
                state.foreground(
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default(),
                ),
            )
        })
        .collect();
    for (label, action) in actions {
        if let Some(webview) = app.get_webview(&label) {
            act(&webview, action);
        }
    }
}

pub(crate) fn install(app: AppHandle) {
    use block2::RcBlock;
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSString};
    let callback = RcBlock::new(move |_: std::ptr::NonNull<NSNotification>| {
        super::native_http_transport::network_changed();
        foreground(&app);
    });
    // NotificationCenter retains the process-lifetime observer and callback.
    let _observer = unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(&NSString::from_str(
                "UIApplicationDidBecomeActiveNotification",
            )),
            None,
            None,
            &callback,
        )
    };
    install_path_monitor();
}

fn install_path_monitor() {
    use block2::{Block, RcBlock};
    use dispatch2::DispatchQueue;
    use std::ffi::c_void;
    #[link(name = "Network", kind = "framework")]
    extern "C" {
        fn nw_path_monitor_create() -> *mut c_void;
        fn nw_path_monitor_set_update_handler(
            monitor: *mut c_void,
            handler: &Block<dyn Fn(*mut c_void)>,
        );
        fn nw_path_monitor_set_queue(monitor: *mut c_void, queue: &DispatchQueue);
        fn nw_path_monitor_start(monitor: *mut c_void);
    }
    // One retained monitor for the process. Its callback only advances an atomic.
    unsafe {
        let monitor = nw_path_monitor_create();
        if monitor.is_null() {
            return;
        }
        let changed =
            RcBlock::new(|_: *mut c_void| super::native_http_transport::network_changed());
        nw_path_monitor_set_update_handler(monitor, &changed);
        nw_path_monitor_set_queue(monitor, DispatchQueue::main());
        nw_path_monitor_start(monitor);
    }
}
