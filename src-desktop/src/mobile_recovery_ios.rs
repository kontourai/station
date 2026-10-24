//! WKWebView recovery stays on the main thread and never reloads in background.
use super::mobile_recovery::{RecoveryAction, RendererRecovery};
use objc2::msg_send;
use objc2::runtime::{AnyClass, AnyObject};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;
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
        .terminated(Instant::now(), !backgrounded());
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
        .map(|(label, state)| (label.clone(), state.foreground(Instant::now())))
        .collect();
    for (label, action) in actions {
        if let Some(webview) = app.get_webview_window(&label) {
            act(webview.as_ref(), action);
        }
    }
}

pub(crate) fn install(app: AppHandle) {
    super::ios_network_path::start(&app);
    use block2::RcBlock;
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSString};
    let callback = RcBlock::new(move |_: std::ptr::NonNull<NSNotification>| {
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
}
