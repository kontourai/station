// Generated from config/channel-platform-matrix.json by scripts/channel-platform-matrix.mjs.
pub fn normalize_dev_pairing_deep_link_suffix(value: &str) -> String {
    let mut output = String::new();
    for character in value.chars().flat_map(char::to_lowercase) {
        if character.is_ascii_alphanumeric() {
            output.push(character);
        } else if !output.is_empty() && !output.ends_with('-') {
            output.push('-');
        }
    }
    let output = output.trim_end_matches('-').to_string();
    if output.is_empty() {
        "instance".to_string()
    } else {
        output
    }
}

pub fn native_pairing_deep_link_scheme(identifier: &str, dev_build: bool, channel: &str) -> String {
    if dev_build {
        let suffix = identifier
            .strip_prefix("io.kontourai.station.dev.")
            .unwrap_or("instance");
        return format!(
            "station-dev-{}",
            normalize_dev_pairing_deep_link_suffix(suffix)
        );
    }
    match channel {
        "beta" => "station-beta".to_string(),
        "nightly" => "station-nightly".to_string(),
        _ => "station-stable".to_string(),
    }
}
