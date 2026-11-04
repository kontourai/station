//! The managed policy's `limits.updates` (#4522), read natively by the
//! desktop shell.
//!
//! The desktop updater must honor the machine administrator's policy even
//! when the bundled server never starts, including when it refuses to start
//! BECAUSE the policy is invalid. So the shell reads the policy file itself,
//! at startup, instead of asking the server: a server that is not running
//! cannot answer, and an updater that fell back to "no policy" would update
//! a machine whose administrator turned updates off.
//!
//! The shell reads only what it enforces, `limits.updates`. The server
//! (`@kontourai/station-shared/managed-policy`) validates the whole document
//! and refuses to start on anything it cannot enforce. Here:
//!
//! - no policy file means no policy, as on the server;
//! - a policy file the shell cannot use (unreadable, a link, not root's,
//!   invalid JSON, a repeated key, a newer `schemaVersion`, or a
//!   `limits.updates` it does not understand) turns updates off: the shell
//!   cannot tell what the administrator allowed, so it allows nothing;
//! - a usable `limits.updates` applies even when another part of the
//!   document is something this build's server refuses. That is what lets an
//!   administrator's approved mirror deliver the build that understands the
//!   rest.
//!
//! A mirror reproduces Station's release download tree: an updater endpoint
//! `https://github.com/kontourai/station/releases/download/<tag>/latest.json`
//! becomes `<feedUrl>/<tag>/latest.json`, the same mapping the server and the
//! CLI use (`managedUpdateMirrorUrl` in
//! `@kontourai/station-contracts/managed-policy`). The update the mirror's
//! feed offers must also download from the mirror.
//!
//! This module depends only on `std`, `serde`, `serde_json` and `url`, so its
//! tests compile and run standalone (`rustc --test` or a scratch crate)
//! without building the desktop crate.

use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use std::collections::HashSet;
use std::fmt;
use std::path::{Path, PathBuf};

/// The test-only override the server honors; same rule here: it is used
/// only when no system policy is installed, and is an error otherwise.
pub const TEST_FILE_ENV: &str = "STATION_MANAGED_POLICY_TEST_FILE";

/// Station's default release download location. Mirrors
/// `STATION_RELEASE_DOWNLOAD_BASE` in the contracts package.
pub const RELEASE_DOWNLOAD_BASE: &str = "https://github.com/kontourai/station/releases/download/";

/// Larger than any real policy; a bigger file is refused, as on the server.
const MAX_POLICY_BYTES: u64 = 1024 * 1024;
const FEED_URL_MAX_CHARS: usize = 2048;
const UPDATES_KEYS: [&str; 3] = ["mode", "feedUrl", "allowNightly"];

/// The system path an administrator installs the policy to; the same fixed
/// literals as `managedPolicyFilePath` on the server.
pub fn system_policy_path() -> &'static str {
    if cfg!(target_os = "macos") {
        "/Library/Application Support/Station/policy.json"
    } else if cfg!(windows) {
        "C:\\Program Files\\Station\\policy.json"
    } else {
        "/etc/station/policy.json"
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdatesLimit {
    pub off: bool,
    pub feed_url: Option<String>,
    pub allow_nightly: bool,
}

/// What the shell learned from the installed policy.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InstalledPolicy {
    /// No policy is installed, or it does not limit updates.
    Unlimited,
    Limited(UpdatesLimit),
    /// A policy is installed and the shell cannot use it; why, for the log.
    Unusable(String),
}

/// Where the updater may look, decided once at startup.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UpdateRoute {
    /// The build's own endpoints.
    Default,
    /// The mirror's copies of the build's endpoints, and the mirror base
    /// every download must come from.
    Mirror {
        endpoints: Vec<String>,
        base: String,
    },
    /// No check, download or install; the sentence the window shows.
    Refused(String),
}

/// Reads the installed policy: the system path, then the test override.
pub fn load_installed(test_override: Option<&str>) -> InstalledPolicy {
    load_from(Path::new(system_policy_path()), true, test_override)
}

fn load_from(system: &Path, check_ownership: bool, test_override: Option<&str>) -> InstalledPolicy {
    let override_path = test_override.filter(|value| !value.is_empty());
    match read_source(system, check_ownership) {
        Err(reason) => InstalledPolicy::Unusable(reason),
        Ok(Some(_)) if override_path.is_some() => InstalledPolicy::Unusable(format!(
            "{TEST_FILE_ENV} is set, but a system policy is installed and the test override cannot replace it"
        )),
        Ok(Some(text)) => parse_policy(&text),
        Ok(None) => match override_path {
            None => InstalledPolicy::Unlimited,
            Some(path) if !Path::new(path).is_absolute() => {
                InstalledPolicy::Unusable(format!("{TEST_FILE_ENV} must be an absolute path"))
            }
            Some(path) => match read_source(Path::new(path), false) {
                Err(reason) => InstalledPolicy::Unusable(reason),
                Ok(None) => InstalledPolicy::Unusable(format!(
                    "{TEST_FILE_ENV} names a file that does not exist"
                )),
                Ok(Some(text)) => parse_policy(&text),
            },
        },
    }
}

/// The file's text, `None` when nothing is at `path`, or why it cannot be
/// used. Only an absent entry means "no policy".
fn read_source(path: &Path, check_ownership: bool) -> Result<Option<String>, String> {
    let link = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "the policy at {} cannot be read ({error})",
                path.display()
            ))
        }
    };
    if link.file_type().is_symlink() {
        return Err(format!(
            "the policy at {} is a symbolic link",
            path.display()
        ));
    }
    if !link.is_file() {
        return Err(format!(
            "the policy at {} is not a regular file",
            path.display()
        ));
    }
    if link.len() > MAX_POLICY_BYTES {
        return Err(format!(
            "the policy at {} is larger than 1 MiB",
            path.display()
        ));
    }
    if check_ownership {
        if let Some(problem) = ownership_problem(path) {
            return Err(problem);
        }
    }
    std::fs::read_to_string(path)
        .map(Some)
        .map_err(|error| format!("the policy at {} cannot be read ({error})", path.display()))
}

/// The file and every directory above it must be root's and not writable by
/// group or others, as the server requires of a system policy.
#[cfg(unix)]
fn ownership_problem(path: &Path) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    let mut current: Option<PathBuf> = Some(path.to_path_buf());
    while let Some(entry) = current {
        let metadata = match std::fs::symlink_metadata(&entry) {
            Ok(metadata) => metadata,
            Err(error) => {
                return Some(format!("{} cannot be inspected ({error})", entry.display()))
            }
        };
        if metadata.uid() != 0 {
            return Some(format!("{} is not owned by root", entry.display()));
        }
        if metadata.file_type().is_symlink() {
            // A root-owned link among the parents: what it leads to must
            // pass too.
            match std::fs::metadata(&entry) {
                Ok(target) if target.uid() == 0 && target.mode() & 0o022 == 0 => {}
                _ => {
                    return Some(format!(
                        "{} leads somewhere not owned by root",
                        entry.display()
                    ))
                }
            }
        } else if metadata.mode() & 0o022 != 0 {
            return Some(format!(
                "{} is writable by its group or other users",
                entry.display()
            ));
        }
        current = entry.parent().map(Path::to_path_buf);
    }
    None
}

/// Windows ownership is a server follow-up (#4524); the shell matches it.
#[cfg(not(unix))]
fn ownership_problem(_path: &Path) -> Option<String> {
    None
}

/// A JSON value that refuses a repeated member name in any object, which
/// `serde_json::Value` would silently resolve to the last one.
struct StrictValue(Value);

impl<'de> Deserialize<'de> for StrictValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(StrictVisitor).map(StrictValue)
    }
}

struct StrictVisitor;

impl<'de> Visitor<'de> for StrictVisitor {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON value")
    }
    fn visit_bool<E>(self, value: bool) -> Result<Value, E> {
        Ok(Value::Bool(value))
    }
    fn visit_i64<E>(self, value: i64) -> Result<Value, E> {
        Ok(Value::Number(value.into()))
    }
    fn visit_u64<E>(self, value: u64) -> Result<Value, E> {
        Ok(Value::Number(value.into()))
    }
    fn visit_f64<E>(self, value: f64) -> Result<Value, E> {
        Ok(Number::from_f64(value).map_or(Value::Null, Value::Number))
    }
    fn visit_str<E>(self, value: &str) -> Result<Value, E> {
        Ok(Value::String(value.to_owned()))
    }
    fn visit_string<E>(self, value: String) -> Result<Value, E> {
        Ok(Value::String(value))
    }
    fn visit_unit<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut values = Vec::new();
        while let Some(StrictValue(value)) = seq.next_element()? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut object = Map::new();
        let mut seen = HashSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !seen.insert(key.clone()) {
                return Err(de::Error::custom(format!("duplicate key {key:?}")));
            }
            let StrictValue(value) = map.next_value()?;
            object.insert(key, value);
        }
        Ok(Value::Object(object))
    }
}

/// `limits.updates` from a policy document's text.
pub fn parse_policy(text: &str) -> InstalledPolicy {
    let document = match serde_json::from_str::<StrictValue>(text) {
        Ok(StrictValue(value)) => value,
        Err(error) => {
            return InstalledPolicy::Unusable(format!("the policy is not usable JSON ({error})"))
        }
    };
    let Some(document) = document.as_object() else {
        return InstalledPolicy::Unusable("the policy must be a JSON object".into());
    };
    // A newer schema may give `limits.updates` another meaning.
    if document.get("schemaVersion") != Some(&Value::from(1)) {
        return InstalledPolicy::Unusable("schemaVersion must be 1".into());
    }
    let limits = match document.get("limits") {
        None => return InstalledPolicy::Unlimited,
        Some(Value::Object(limits)) => limits,
        Some(_) => return InstalledPolicy::Unusable("limits must be an object".into()),
    };
    let updates = match limits.get("updates") {
        None => return InstalledPolicy::Unlimited,
        Some(Value::Object(updates)) => updates,
        Some(_) => return InstalledPolicy::Unusable("limits.updates must be an object".into()),
    };
    if let Some(key) = updates
        .keys()
        .find(|key| !UPDATES_KEYS.contains(&key.as_str()))
    {
        return InstalledPolicy::Unusable(format!(
            "limits.updates.{key} is not a key this version understands"
        ));
    }
    let off = match updates.get("mode") {
        None => false,
        Some(Value::String(mode)) if mode == "auto" => false,
        Some(Value::String(mode)) if mode == "off" => true,
        Some(_) => {
            return InstalledPolicy::Unusable(
                "limits.updates.mode must be \"auto\" or \"off\"".into(),
            )
        }
    };
    let allow_nightly = match updates.get("allowNightly") {
        None => true,
        Some(Value::Bool(allow)) => *allow,
        Some(_) => {
            return InstalledPolicy::Unusable(
                "limits.updates.allowNightly must be true or false".into(),
            )
        }
    };
    let feed_url = match updates.get("feedUrl") {
        None => None,
        Some(Value::String(feed)) => match feed_url_problem(feed) {
            None => Some(feed.clone()),
            Some(problem) => {
                return InstalledPolicy::Unusable(format!("limits.updates.feedUrl {problem}"))
            }
        },
        Some(_) => {
            return InstalledPolicy::Unusable("limits.updates.feedUrl must be an https URL".into())
        }
    };
    InstalledPolicy::Limited(UpdatesLimit {
        off,
        feed_url,
        allow_nightly,
    })
}

/// The same rules as the contracts parser's `updateFeedUrlProblem`.
fn feed_url_problem(value: &str) -> Option<&'static str> {
    if value.is_empty() {
        return Some("must be an https URL");
    }
    if value.chars().count() > FEED_URL_MAX_CHARS {
        return Some("is too long");
    }
    let Ok(url) = url::Url::parse(value) else {
        return Some("must be an https URL");
    };
    if url.scheme() != "https" {
        return Some("must be an https URL");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Some("must not contain a user name or password");
    }
    if value.contains('?') || value.contains('#') {
        return Some("must not contain a query or fragment");
    }
    if url.as_str() != value && url.as_str() != format!("{value}/") {
        return Some("must be a plain URL in canonical form");
    }
    None
}

fn with_slash(base: &str) -> String {
    if base.ends_with('/') {
        base.to_owned()
    } else {
        format!("{base}/")
    }
}

/// The mirror's copy of a default release URL, or `None` for a URL outside
/// the release download tree.
pub fn mirror_url(default_url: &str, feed_url: &str) -> Option<String> {
    let rest = default_url.strip_prefix(RELEASE_DOWNLOAD_BASE)?;
    if rest.is_empty() || rest.contains('?') || rest.contains('#') {
        return None;
    }
    Some(format!("{}{rest}", with_slash(feed_url)))
}

/// Where this build's updater may look under `policy`, for a build on
/// `channel` whose configured endpoints are `endpoints`.
pub fn route(policy: &InstalledPolicy, channel: &str, endpoints: &[String]) -> UpdateRoute {
    let limit = match policy {
        InstalledPolicy::Unlimited => return UpdateRoute::Default,
        InstalledPolicy::Unusable(_) => {
            return UpdateRoute::Refused(
                "This machine's managed policy cannot be used, so updates are off until an administrator fixes it"
                    .into(),
            )
        }
        InstalledPolicy::Limited(limit) => limit,
    };
    if limit.off {
        return UpdateRoute::Refused(
            "This machine's managed policy turns off Station updates".into(),
        );
    }
    if !limit.allow_nightly && channel == "nightly" {
        return UpdateRoute::Refused(
            "This machine's managed policy makes the nightly channel unavailable".into(),
        );
    }
    let Some(feed) = &limit.feed_url else {
        return UpdateRoute::Default;
    };
    let mirrored: Option<Vec<String>> = endpoints
        .iter()
        .map(|endpoint| mirror_url(endpoint, feed))
        .collect();
    match mirrored {
        Some(endpoints) if !endpoints.is_empty() => UpdateRoute::Mirror {
            endpoints,
            base: with_slash(feed),
        },
        _ => UpdateRoute::Refused(
            "This machine's managed policy takes updates only from the organization's mirror, which cannot serve this build's update feed"
                .into(),
        ),
    }
}

/// Whether the updater may download from `url` on `route`: anywhere on the
/// default route, only under the mirror on a mirror route, nowhere when
/// refused.
pub fn download_allowed(route: &UpdateRoute, url: &str) -> bool {
    match route {
        UpdateRoute::Default => true,
        UpdateRoute::Mirror { base, .. } => url.starts_with(base.as_str()),
        UpdateRoute::Refused(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const STABLE: &str =
        "https://github.com/kontourai/station/releases/download/stable-desktop/latest.json";
    const NIGHTLY: &str =
        "https://github.com/kontourai/station/releases/download/nightly-desktop/latest.json";

    fn limited(text: &str) -> UpdatesLimit {
        match parse_policy(text) {
            InstalledPolicy::Limited(limit) => limit,
            other => panic!("expected a limit, got {other:?}"),
        }
    }

    fn unusable(text: &str) -> String {
        match parse_policy(text) {
            InstalledPolicy::Unusable(reason) => reason,
            other => panic!("expected an unusable policy, got {other:?}"),
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "station-managed-update-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn off_refuses_every_check_and_download() {
        let policy = parse_policy(
            r#"{"schemaVersion":1,"organization":"Acme","limits":{"updates":{"mode":"off"}}}"#,
        );
        let route = route(&policy, "stable", &[STABLE.to_string()]);
        assert_eq!(
            route,
            UpdateRoute::Refused("This machine's managed policy turns off Station updates".into())
        );
        assert!(!download_allowed(&route, STABLE));
    }

    #[test]
    fn a_mirror_replaces_every_endpoint_and_never_keeps_the_default() {
        let policy = parse_policy(
            r#"{"schemaVersion":1,"organization":"Acme","limits":{"updates":{"feedUrl":"https://mirror.example/station/t0ken"}}}"#,
        );
        let route = route(&policy, "stable", &[STABLE.to_string()]);
        assert_eq!(
            route,
            UpdateRoute::Mirror {
                endpoints: vec![
                    "https://mirror.example/station/t0ken/stable-desktop/latest.json".into()
                ],
                base: "https://mirror.example/station/t0ken/".into(),
            }
        );
        let UpdateRoute::Mirror { endpoints, .. } = &route else {
            unreachable!()
        };
        assert!(endpoints
            .iter()
            .all(|endpoint| !endpoint.starts_with(RELEASE_DOWNLOAD_BASE)));
        assert!(download_allowed(
            &route,
            "https://mirror.example/station/t0ken/v1.2.3/Station.app.tar.gz"
        ));
        assert!(!download_allowed(
            &route,
            "https://github.com/kontourai/station/releases/download/v1.2.3/Station.app.tar.gz"
        ));
        // A prefix that is not a path boundary is not the mirror.
        assert!(!download_allowed(
            &route,
            "https://mirror.example/station/t0ken-evil/x"
        ));
    }

    #[test]
    fn a_mirror_refuses_an_endpoint_outside_the_release_tree() {
        let policy = parse_policy(
            r#"{"schemaVersion":1,"organization":"Acme","limits":{"updates":{"feedUrl":"https://mirror.example/"}}}"#,
        );
        assert!(matches!(
            route(
                &policy,
                "stable",
                &["https://example.com/latest.json".into()]
            ),
            UpdateRoute::Refused(_)
        ));
        assert!(matches!(
            route(&policy, "stable", &[]),
            UpdateRoute::Refused(_)
        ));
    }

    #[test]
    fn nightly_is_refused_only_when_not_allowed_and_only_on_nightly() {
        let policy = parse_policy(
            r#"{"schemaVersion":1,"organization":"Acme","limits":{"updates":{"allowNightly":false}}}"#,
        );
        assert_eq!(
            route(&policy, "nightly", &[NIGHTLY.to_string()]),
            UpdateRoute::Refused(
                "This machine's managed policy makes the nightly channel unavailable".into()
            )
        );
        assert_eq!(
            route(&policy, "stable", &[STABLE.to_string()]),
            UpdateRoute::Default
        );
        let allowed = parse_policy(
            r#"{"schemaVersion":1,"organization":"Acme","limits":{"updates":{"allowNightly":true}}}"#,
        );
        assert_eq!(
            route(&allowed, "nightly", &[NIGHTLY.to_string()]),
            UpdateRoute::Default
        );
    }

    #[test]
    fn no_policy_and_a_policy_without_updates_leave_the_default() {
        assert_eq!(
            route(&InstalledPolicy::Unlimited, "nightly", &[NIGHTLY.into()]),
            UpdateRoute::Default
        );
        assert_eq!(
            parse_policy(r#"{"schemaVersion":1,"organization":"Acme"}"#),
            InstalledPolicy::Unlimited
        );
        assert_eq!(
            parse_policy(r#"{"schemaVersion":1,"organization":"Acme","limits":{}}"#),
            InstalledPolicy::Unlimited
        );
    }

    #[test]
    fn a_usable_updates_limit_applies_even_beside_keys_the_server_refuses() {
        // The server refuses `limits.telemetry` in this build and will not
        // start; the shell still applies the updates limit.
        let limit = limited(
            r#"{"schemaVersion":1,"organization":"Acme","limits":{"telemetry":false,"updates":{"mode":"off"}}}"#,
        );
        assert!(limit.off);
    }

    #[test]
    fn a_policy_the_shell_cannot_use_turns_updates_off() {
        for text in [
            "{",
            "[]",
            r#"{"schemaVersion":2,"limits":{"updates":{}}}"#,
            r#"{"schemaVersion":1,"limits":{"updates":{"mode":"sometimes"}}}"#,
            r#"{"schemaVersion":1,"limits":{"updates":{"channel":"stable"}}}"#,
            r#"{"schemaVersion":1,"limits":{"updates":{"allowNightly":"no"}}}"#,
            r#"{"schemaVersion":1,"limits":{"updates":{"feedUrl":"http://mirror.example/"}}}"#,
            r#"{"schemaVersion":1,"limits":{"updates":{"feedUrl":"https://u:p@mirror.example/"}}}"#,
            r#"{"schemaVersion":1,"limits":{"updates":{"feedUrl":"https://mirror.example/?t=1"}}}"#,
            r#"{"schemaVersion":1,"limits":{"updates":false}}"#,
            r#"{"schemaVersion":1,"limits":{"updates":{"mode":"off"}},"limits":{}}"#,
            r#"{"schemaVersion":1,"limits":{"updates":{"mode":"auto","mode":"off"}}}"#,
        ] {
            let policy = parse_policy(text);
            assert!(
                matches!(policy, InstalledPolicy::Unusable(_)),
                "{text}: {policy:?}"
            );
            assert!(
                matches!(
                    route(&policy, "stable", &[STABLE.into()]),
                    UpdateRoute::Refused(_)
                ),
                "{text}"
            );
        }
        assert!(unusable(r#"{"schemaVersion":1,"limits":1,"limits":2}"#).contains("duplicate key"));
    }

    #[test]
    fn the_mirror_mapping_matches_the_contracts_rule() {
        for feed in ["https://mirror.example/s", "https://mirror.example/s/"] {
            assert_eq!(
                mirror_url(NIGHTLY, feed).as_deref(),
                Some("https://mirror.example/s/nightly-desktop/latest.json")
            );
        }
        assert_eq!(
            mirror_url(
                "https://example.com/releases/download/x/y.json",
                "https://m/"
            ),
            None
        );
        assert_eq!(mirror_url(RELEASE_DOWNLOAD_BASE, "https://m/"), None);
    }

    #[test]
    fn the_test_override_is_read_only_when_no_system_policy_exists() {
        let dir = scratch("override");
        let system = dir.join("system-policy.json");
        let override_file = dir.join("override.json");
        std::fs::File::create(&override_file)
            .unwrap()
            .write_all(
                br#"{"schemaVersion":1,"organization":"A","limits":{"updates":{"mode":"off"}}}"#,
            )
            .unwrap();
        let override_path = override_file.to_str().unwrap();
        // No system file: the override applies.
        assert!(matches!(
            load_from(&system, false, Some(override_path)),
            InstalledPolicy::Limited(UpdatesLimit { off: true, .. })
        ));
        // No system file and no override: no policy.
        assert_eq!(load_from(&system, false, None), InstalledPolicy::Unlimited);
        // A missing or relative override is unusable, never "no policy".
        assert!(matches!(
            load_from(
                &system,
                false,
                Some(dir.join("absent.json").to_str().unwrap())
            ),
            InstalledPolicy::Unusable(_)
        ));
        assert!(matches!(
            load_from(&system, false, Some("relative.json")),
            InstalledPolicy::Unusable(_)
        ));
        // A system policy with the override set is an error, as on the server.
        std::fs::write(&system, br#"{"schemaVersion":1,"organization":"A"}"#).unwrap();
        assert!(matches!(
            load_from(&system, false, Some(override_path)),
            InstalledPolicy::Unusable(_)
        ));
        assert_eq!(load_from(&system, false, None), InstalledPolicy::Unlimited);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_system_policy_that_is_a_link_or_not_roots_is_unusable() {
        let dir = scratch("system");
        let target = dir.join("target.json");
        std::fs::write(&target, br#"{"schemaVersion":1,"organization":"A"}"#).unwrap();
        let link = dir.join("policy.json");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(matches!(
            load_from(&link, false, None),
            InstalledPolicy::Unusable(_)
        ));
        // A dangling link is not absence either.
        std::fs::remove_file(&target).unwrap();
        assert!(matches!(
            load_from(&link, false, None),
            InstalledPolicy::Unusable(_)
        ));
        // A file this test (not root) owns fails the ownership rule.
        let owned = dir.join("owned.json");
        std::fs::write(&owned, br#"{"schemaVersion":1,"organization":"A"}"#).unwrap();
        if !running_as_root() {
            match load_from(&owned, true, None) {
                InstalledPolicy::Unusable(reason) => {
                    assert!(reason.contains("not owned by root"), "{reason}")
                }
                other => panic!("expected unusable, got {other:?}"),
            }
        }
        // A directory at the path is not a policy.
        let directory = dir.join("dir.json");
        std::fs::create_dir(&directory).unwrap();
        assert!(matches!(
            load_from(&directory, false, None),
            InstalledPolicy::Unusable(_)
        ));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Whether files this process creates are root's (a root CI runner
    /// would pass the ownership rule, so that half is skipped there).
    #[cfg(unix)]
    fn running_as_root() -> bool {
        use std::os::unix::fs::MetadataExt;
        let probe = std::env::temp_dir().join(format!("station-uid-probe-{}", std::process::id()));
        std::fs::write(&probe, b"").unwrap();
        let uid = std::fs::metadata(&probe).unwrap().uid();
        std::fs::remove_file(&probe).unwrap();
        uid == 0
    }
}
