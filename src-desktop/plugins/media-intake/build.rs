/// `register_listener`/`remove_listener` back `addPluginListener`, which the
/// web layer uses for the Android `sharedImages` nudge.
const COMMANDS: &[&str] = &[
    "read_clipboard_images",
    "take_shared_images",
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .ios_path("ios")
        .build();
}
