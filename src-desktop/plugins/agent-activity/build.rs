const COMMANDS: &[&str] = &[
    "status",
    "configure",
    "clear",
    "preview",
    "push_token",
    "open_live_update_settings",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
