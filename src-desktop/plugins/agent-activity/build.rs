const COMMANDS: &[&str] = &[
    "status",
    "configure",
    "clear",
    "preview",
    "push_token",
    "open_live_update_settings",
];

/// The iOS side (a Swift plugin plus the Live Activity widget it feeds) is
/// built only when STATION_IOS_LIVE_ACTIVITY=1, so TestFlight output stays
/// unchanged until the push-enabled signing it needs exists (#2513 slice D).
/// Without it the plugin still registers on iOS, with no native half.
///
/// Xcode runs cargo through `tauri ios xcode-script`, which does not pass the
/// shell's environment through, so an iOS build sets it as cargo config:
/// `tauri ios build ... -- --config <file>` where the file holds
/// `[env] STATION_IOS_LIVE_ACTIVITY = { value = "1", force = true }` (the
/// same route STATION_MOBILE_DEFAULT_ENDPOINT takes in testflight-delivery).
const IOS_FEATURE_ENV: &str = "STATION_IOS_LIVE_ACTIVITY";

fn main() {
    println!("cargo::rerun-if-env-changed={IOS_FEATURE_ENV}");
    println!("cargo::rustc-check-cfg=cfg(station_ios_live_activity)");
    let ios = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios");
    let ios_feature = ios && std::env::var(IOS_FEATURE_ENV).as_deref() == Ok("1");

    let builder = tauri_plugin::Builder::new(COMMANDS).android_path("android");
    let builder = if ios_feature {
        println!("cargo::rustc-cfg=station_ios_live_activity");
        builder.ios_path("ios")
    } else {
        builder
    };
    builder.build();
}
