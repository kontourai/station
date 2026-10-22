fn main() {
    tauri_plugin::Builder::new(&["discover", "cancel"])
        .android_path("android")
        .ios_path("ios")
        .build();
}
