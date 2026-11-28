//! System DNS-SD browsing only. Results are untrusted address hints; Station's
//! existing handshake, encryption decision and access exchange own admission.
use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_station_discovery);

pub fn init<R: Runtime>(
    #[cfg(target_os = "windows")] admission: fn(&tauri::AppHandle<R>) -> bool,
) -> TauriPlugin<R> {
    let builder = Builder::new("station-discovery");
    #[cfg(target_os = "windows")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        windows::prepare,
        windows::discover,
        windows::cancel
    ]);
    builder
        .setup(move |_app, _api| {
            #[cfg(target_os = "windows")]
            {
                use tauri::Manager;
                _app.manage(windows::DiscoveryState::default());
                let app = _app.clone();
                _app.manage(windows::DiscoveryAdmission(std::sync::Arc::new(
                    move || admission(&app),
                )));
            }
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
