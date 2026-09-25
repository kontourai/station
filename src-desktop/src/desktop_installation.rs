//! A stable id for this desktop installation (#2587).
//!
//! Station's delivery router addresses the desktop app's OS alerts to the
//! surface `local:desktop-<installationId>`. Per-document client session ids
//! change on every reload, so a preference stored under one (hide content on
//! the lock screen, minimum urgency) would never be found again. This id is
//! generated once and persisted in the app config directory.
//!
//! It is an address, not a credential: the delivery feed is gated on the
//! local-operator credential server-side, and knowing the id grants nothing.

use std::path::Path;

const FILE_NAME: &str = "desktop-installation-id";

/// Read the persisted id, creating it on first use. An unreadable or
/// malformed file is replaced: the only cost is that per-surface preferences
/// stored under the old id stop applying, which is better than no id.
pub fn read_or_create(dir: &Path) -> Result<String, String> {
    let path = dir.join(FILE_NAME);
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let existing = existing.trim();
        if is_installation_id(existing) {
            return Ok(existing.to_string());
        }
    }
    std::fs::create_dir_all(dir)
        .map_err(|error| format!("create the desktop config directory: {error}"))?;
    let id = uuid::Uuid::new_v4().to_string();
    // Write-then-rename so a crash never leaves a half-written id behind.
    let temporary = dir.join(format!("{FILE_NAME}.{}.tmp", std::process::id()));
    std::fs::write(&temporary, &id)
        .map_err(|error| format!("write the desktop installation id: {error}"))?;
    std::fs::rename(&temporary, &path)
        .map_err(|error| format!("persist the desktop installation id: {error}"))?;
    Ok(id)
}

/// A lowercase hyphenated UUID, which also satisfies the server's
/// `local:desktop-[A-Za-z0-9-]{8,64}` surface pattern.
pub fn is_installation_id(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .map(|parsed| parsed.hyphenated().to_string() == value)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_id_is_created_once_and_stable_across_reads() {
        let dir = tempfile::tempdir().unwrap();
        let first = read_or_create(dir.path()).unwrap();
        assert!(is_installation_id(&first));
        assert_eq!(read_or_create(dir.path()).unwrap(), first);
    }

    #[test]
    fn a_malformed_file_is_replaced_with_a_valid_id() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FILE_NAME), "not-an-id\n").unwrap();
        let id = read_or_create(dir.path()).unwrap();
        assert!(is_installation_id(&id));
        assert_eq!(read_or_create(dir.path()).unwrap(), id);
    }

    #[test]
    fn a_missing_directory_is_created() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("nested");
        assert!(is_installation_id(&read_or_create(&nested).unwrap()));
    }
}
