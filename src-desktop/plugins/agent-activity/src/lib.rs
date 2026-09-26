//! Native agent-activity notifications: on Android an ongoing card, promoted
//! to an Android 16 Live Update chip while work is running, plus attention
//! alerts; on iOS 18+ a Live Activity (lock screen and Dynamic Island).
//!
//! Rendering and push receipt live entirely in native code. Android: the
//! Kotlin plugin (`android/`), woken by a `FirebaseMessagingService` that
//! must not depend on the WebView or on Rust — see
//! docs/design/notification-delivery.md for why every keep-the-process-alive
//! approach failed there. iOS: APNs starts and updates the Live Activity and
//! the widget extension (`src-desktop/ios/StationAgentActivity`) opens the
//! sealed card; the Swift plugin (`ios/`) only registers identity and hands
//! over push tokens (including the app's APNs device token for alerts). The iOS
//! half is compiled only when STATION_IOS_LIVE_ACTIVITY=1 (see build.rs).
//!
//! There are no Rust command handlers. On mobile, Tauri forwards an
//! unhandled `plugin:station-agent-activity|<command>` invoke to the native
//! plugin after the ACL check, so the permissions generated from `build.rs`
//! still gate every call. On desktop the plugin is not registered.

use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

/// Whether this build carries the iOS native half (STATION_IOS_LIVE_ACTIVITY=1).
/// The cfg is set by this crate's build script only, so the app reads it here
/// to report `remote-push` honestly.
pub const IOS_LIVE_ACTIVITY_BUILT: bool = cfg!(all(target_os = "ios", station_ios_live_activity));

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "io.kontourai.station.agentactivity";

#[cfg(all(target_os = "ios", station_ios_live_activity))]
tauri::ios_plugin_binding!(init_plugin_station_agent_activity);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("station-agent-activity")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin(PLUGIN_IDENTIFIER, "AgentActivityPlugin")?;
            #[cfg(all(target_os = "ios", station_ios_live_activity))]
            _api.register_ios_plugin(init_plugin_station_agent_activity)?;
            Ok(())
        })
        .build()
}
