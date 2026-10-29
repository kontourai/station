//! System DNS-SD browsing only. Results are untrusted address hints; Station's
//! existing handshake, encryption decision and access exchange own admission.
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_station_discovery);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("station-discovery")
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            _api.register_android_plugin(
                "io.kontourai.station.discovery",
                "StationDiscoveryPlugin",
            )?;
            #[cfg(target_os = "ios")]
            _api.register_ios_plugin(init_plugin_station_discovery)?;
            Ok(())
        })
        .build()
}
