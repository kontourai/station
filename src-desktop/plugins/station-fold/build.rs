fn main() {
    tauri_plugin::Builder::new(&["state", "register_listener", "remove_listener"])
        .ios_path("ios")
        .build();
}
