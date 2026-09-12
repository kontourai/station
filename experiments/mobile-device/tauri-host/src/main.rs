//! Isolated runtime experiment, with no Station service, commands, or capabilities.
//! A successful run establishes only this host's rendering/input behavior.

fn main() {
    let requested = std::env::args()
        .nth(1)
        .expect("Pass an explicit http://127.0.0.1:<non-default-port>/ device-hub URL");
    let target: tauri::Url = requested.parse().expect("Invalid device-hub URL");
    assert!(
        target.scheme() == "http"
            && target.host_str() == Some("127.0.0.1")
            && target.username().is_empty()
            && target.password().is_none()
            && target
                .port()
                .is_some_and(|port| port > 1024 && port != 3000 && port != 3141),
        "The experiment requires numeric loopback and a non-default port"
    );
    let origin = target.origin();
    tauri::Builder::default()
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(
                app,
                "device-experiment",
                tauri::WebviewUrl::External(target),
            )
            .title("Station mobile-device hosting experiment — not a product pane")
            .inner_size(1280.0, 820.0)
            .incognito(true)
            .on_navigation(move |url| url.origin() == origin)
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
            .on_download(|_, _| false)
            .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Could not run the device-host experiment");
}
