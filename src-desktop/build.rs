fn main() {
    println!("cargo:rustc-env=STATION_NODE_ENGINE={}", read_node_engine());
    stage_client_build_provenance();
    tauri_build::build()
}

/// Native targets cannot trust a backend (a phone can be unpaired or attached
/// to another Station), so bake only the source-derived client stamp staged by
/// the build scripts. There is intentionally no environment/mtime fallback.
fn stage_client_build_provenance() {
    const MANIFEST: &str = "station-client-build.json";
    println!("cargo:rerun-if-changed={MANIFEST}");
    let Ok(raw) = std::fs::read_to_string(MANIFEST) else {
        return;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return;
    };
    let Some(object) = value.as_object() else {
        return;
    };
    for (source, target, valid) in [
        ("sha", "STATION_CLIENT_BUILD_SHA", valid_sha as fn(&str) -> bool),
        ("branch", "STATION_CLIENT_BUILD_BRANCH", valid_branch as fn(&str) -> bool),
        ("builtAt", "STATION_CLIENT_BUILT_AT", valid_utc_timestamp as fn(&str) -> bool),
    ] {
        if let Some(value) = object.get(source).and_then(serde_json::Value::as_str) {
            if valid(value) {
                println!("cargo:rustc-env={target}={value}");
            }
        }
    }
}

fn valid_sha(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_branch(value: &str) -> bool {
    !value.trim().is_empty()
        && value == value.trim()
        && value.len() <= 256
        && !value.chars().any(char::is_control)
}

fn valid_utc_timestamp(value: &str) -> bool {
    // Canonical timestamps come from Date#toISOString(). This deliberately
    // refuses time-zone-less or malformed values rather than creating a
    // plausible local date from mutable host configuration.
    value.len() == 24
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
        && value.as_bytes().get(10) == Some(&b'T')
        && value.as_bytes().get(13) == Some(&b':')
        && value.as_bytes().get(16) == Some(&b':')
        && value.as_bytes().get(19) == Some(&b'.')
        && value.ends_with('Z')
        && value
            .bytes()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 23) || byte.is_ascii_digit())
}

fn read_node_engine() -> String {
    let package =
        std::fs::read_to_string("../package.json").expect("read package.json for engines.node");
    let engines = package
        .split_once("\"engines\"")
        .expect("package.json engines")
        .1;
    let node = engines
        .split_once("\"node\"")
        .expect("package.json engines.node")
        .1;
    node.split_once(':')
        .and_then(|(_, value)| value.split('"').nth(1))
        .expect("package.json engines.node string")
        .to_string()
}
