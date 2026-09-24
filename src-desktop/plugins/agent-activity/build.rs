const COMMANDS: &[&str] = &[
    "status",
    "configure",
    "clear",
    "preview",
    "push_token",
    "open_live_update_settings",
    "take_launch_route",
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
