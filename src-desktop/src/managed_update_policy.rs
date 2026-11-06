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
//! The organization's device management can deliver the policy instead of
//! the file: a macOS configuration profile (#4523) or the Windows Policies
//! registry key (#4524). The shell does not parse either, so it never holds a
//! second reader that could disagree with the server's. When either is
//! present, the shell turns its own updates off, whatever the file says: it
//! cannot tell what that source allows, and a file beside it is a startup
//! error on the server anyway. A mirror delivered that way therefore leaves
//! desktop updates off rather than mirrored; the guide tells administrators to
//! install the policy as the file to route desktop updates to a mirror.
//!
//! On Windows the file and every ancestor are checked through their open
//! handles: only Administrators, SYSTEM or TrustedInstaller may own them,
//! untrusted write grants are refused according to the server's object roles,
//! and reparse points refuse updates. An unreadable descriptor fails closed.
//!
//! This module depends only on `std`, `serde`, `serde_json`, `url` and (on
//! unix) `libc`, or (on Windows) `windows-sys`, so its tests compile and run
//! standalone (`rustc --test` or a scratch crate) without building the
//! desktop crate.

#[cfg(windows)]
#[path = "managed_policy_windows_security.rs"]
mod windows_security;

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

/// Where a System-scope macOS configuration profile for Station's preference
/// domain is installed, relative to the filesystem root (#4523). The server
/// reads it; the shell only checks that it is there.
pub const MACOS_MANAGED_PREFERENCES: &str =
    "Library/Managed Preferences/io.kontourai.station.plist";

/// The Windows Policies key, relative to `HKEY_LOCAL_MACHINE`, that Group
/// Policy or Intune writes (#4524). The server reads it; the shell only
/// checks that it exists.
pub const WINDOWS_POLICY_SUBKEY: &str = "SOFTWARE\\Policies\\Kontour\\Station";

/// The sentence the window shows when device management delivers the policy.
pub const DEVICE_MANAGED_SENTENCE: &str = "Station's update policy comes from your organization's device management; desktop updates are managed there";

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
    /// Device management (a configuration profile or the Policies registry
    /// key) delivers a policy, which the shell does not read.
    DeviceManaged,
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

/// Who must own a system policy and its directories, and the highest
/// directory checked (inclusive); `SYSTEM_MANAGED_POLICY_OWNERSHIP` on the
/// server. Tests use their own uid and a scratch root.
#[derive(Clone, Debug)]
#[cfg_attr(not(unix), allow(dead_code))]
struct Ownership {
    uid: u32,
    root: PathBuf,
}

/// Reads the installed policy: device management first, then the system
/// path, then the test override.
pub fn load_installed(test_override: Option<&str>) -> InstalledPolicy {
    let system = Ownership {
        uid: 0,
        root: PathBuf::from("/"),
    };
    load_with_device_management(
        device_managed_policy_present(),
        Path::new(system_policy_path()),
        Some(&system),
        test_override,
    )
}

/// Device-management sources remain conservative: the updater does not parse them.
fn load_with_device_management(
    device_managed: bool,
    system: &Path,
    ownership: Option<&Ownership>,
    test_override: Option<&str>,
) -> InstalledPolicy {
    if device_managed {
        return InstalledPolicy::DeviceManaged;
    }
    load_from(system, ownership, test_override)
}

/// Whether this OS's device-management source is present.
fn device_managed_policy_present() -> bool {
    if cfg!(target_os = "macos") {
        macos_profile_present(Path::new("/"))
    } else {
        windows_policy_key_present(WINDOWS_POLICY_SUBKEY)
    }
}

/// Whether `<root>/Library/Managed Preferences/io.kontourai.station.plist`
/// exists. `lstat`, so a link counts without being followed. Any error but
/// "not found" counts as present: the shell fails closed when it cannot
/// tell.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn macos_profile_present(root: &Path) -> bool {
    match std::fs::symlink_metadata(root.join(MACOS_MANAGED_PREFERENCES)) {
        Ok(_) => true,
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    }
}

/// Whether `HKEY_LOCAL_MACHINE\<subkey>` exists, in the 64-bit view (the
/// Policies key is shared by both views). Any error but "not found" counts
/// as present: the shell fails closed when it cannot tell.
#[cfg(windows)]
fn windows_policy_key_present(subkey: &str) -> bool {
    use windows_sys::Win32::Foundation::{
        ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS,
    };
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE, KEY_QUERY_VALUE, KEY_WOW64_64KEY,
    };
    let wide: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();
    let mut key: HKEY = std::ptr::null_mut();
    // SAFETY: `wide` is a NUL-terminated UTF-16 string that outlives the
    // call, and `key` is a valid out pointer; the handle is closed below.
    let status = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            wide.as_ptr(),
            0,
            KEY_QUERY_VALUE | KEY_WOW64_64KEY,
            &mut key,
        )
    };
    if status == ERROR_SUCCESS {
        // SAFETY: `key` was opened by the successful call above.
        unsafe { RegCloseKey(key) };
        return true;
    }
    status != ERROR_FILE_NOT_FOUND && status != ERROR_PATH_NOT_FOUND
}

#[cfg(not(windows))]
fn windows_policy_key_present(_subkey: &str) -> bool {
    false
}

fn load_from(
    system: &Path,
    ownership: Option<&Ownership>,
    test_override: Option<&str>,
) -> InstalledPolicy {
    let override_path = test_override.filter(|value| !value.is_empty());
    match read_source(system, ownership) {
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
            Some(path) => match read_source(Path::new(path), None) {
                Err(reason) => InstalledPolicy::Unusable(reason),
                Ok(None) => InstalledPolicy::Unusable(format!(
                    "{TEST_FILE_ENV} names a file that does not exist"
                )),
                Ok(Some(text)) => parse_policy(&text),
            },
        },
    }
}

const SYMLINK_REASON: &str =
    "is a symbolic link or reparse point; install the policy as a regular file";

/// The file's text, `None` when nothing is at `path`, or why it cannot be
/// used. Only an absent entry means "no policy". The same steps, in the same
/// order, as `readManagedPolicyFile` on the server: `lstat` the entry; open
/// it without following a link and without blocking (a FIFO cannot hang
/// startup); on the descriptor, require a regular file that is the entry
/// `lstat` saw; with `ownership`, check the file's owner and mode and the
/// directory chain; then read at most one byte past the cap, so a file that
/// grew after `fstat` is refused, never truncated. A UTF-8 byte-order mark
/// is dropped, as the server's decoder does. Bytes that are not UTF-8 are
/// refused here, where the server substitutes U+FFFD: this side fails
/// closed.
fn read_source(path: &Path, ownership: Option<&Ownership>) -> Result<Option<String>, String> {
    let shown = path.display();
    let entry = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("the policy at {shown} cannot be read ({error})")),
    };
    if entry.file_type().is_symlink() {
        return Err(format!("the policy at {shown} {SYMLINK_REASON}"));
    }
    if entry.is_dir() {
        return Err(format!("the policy at {shown} is a directory, not a file"));
    }
    let mut file = open_no_follow(path).map_err(|error| {
        if is_loop(&error) {
            format!("the policy at {shown} {SYMLINK_REASON}")
        } else {
            format!("the policy at {shown} cannot be read ({error})")
        }
    })?;
    let stats = file
        .metadata()
        .map_err(|error| format!("the policy at {shown} cannot be read ({error})"))?;
    if stats.is_dir() {
        return Err(format!("the policy at {shown} is a directory, not a file"));
    }
    if !stats.is_file() {
        return Err(format!("the policy at {shown} is not a regular file"));
    }
    if !same_entry(path, &entry, &file, &stats) {
        return Err(format!(
            "the policy at {shown} changed while Station was opening it"
        ));
    }
    #[cfg(windows)]
    if ownership.is_some() {
        windows_security::validate_path_chain(path, &file)
            .map_err(|problem| format!("the policy at {shown} cannot be used: {problem}"))?;
    }
    #[cfg(not(windows))]
    if let Some(ownership) = ownership {
        if let Some(problem) = file_ownership_problem(path, &stats, ownership).or_else(|| {
            path.parent()
                .and_then(|parent| directory_problem(parent, ownership))
        }) {
            return Err(format!("the policy at {shown} cannot be used: {problem}"));
        }
    }
    if stats.len() > MAX_POLICY_BYTES {
        return Err(format!("the policy at {shown} is larger than 1 MiB"));
    }
    let bytes = read_bounded(&mut file, MAX_POLICY_BYTES)
        .map_err(|problem| format!("the policy at {shown} {problem}"))?;
    let text =
        String::from_utf8(bytes).map_err(|_| format!("the policy at {shown} is not UTF-8 text"))?;
    Ok(Some(match text.strip_prefix('\u{feff}') {
        Some(rest) => rest.to_owned(),
        None => text,
    }))
}

/// Reads to the end, at most one byte past `max`; more than `max` is
/// refused rather than truncated.
fn read_bounded(reader: &mut impl std::io::Read, max: u64) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let mut bytes = Vec::new();
    reader
        .take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("cannot be read ({error})"))?;
    if bytes.len() as u64 > max {
        return Err("is larger than 1 MiB".into());
    }
    Ok(bytes)
}

#[cfg(unix)]
fn open_no_follow(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
}

/// Windows has no O_NOFOLLOW. `FILE_FLAG_OPEN_REPARSE_POINT` opens a link
/// or junction itself instead of its target, so an entry swapped for one
/// after `lstat` yields a handle `same_entry` refuses as a reparse point.
#[cfg(windows)]
fn open_no_follow(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
    std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

#[cfg(unix)]
fn is_loop(error: &std::io::Error) -> bool {
    error.raw_os_error() == Some(libc::ELOOP)
}

#[cfg(windows)]
fn is_loop(_error: &std::io::Error) -> bool {
    false
}

/// Whether the opened file is the entry `lstat` saw at `path`.
#[cfg(unix)]
fn same_entry(
    _path: &Path,
    entry: &std::fs::Metadata,
    _file: &std::fs::File,
    opened: &std::fs::Metadata,
) -> bool {
    use std::os::unix::fs::MetadataExt;
    entry.dev() == opened.dev() && entry.ino() == opened.ino()
}

/// Windows (#4522 round 2): stable std exposes no file index, so the
/// identity comes from `GetFileInformationByHandle` (volume serial number
/// and 64-bit file index, what Node reports as `dev`/`ino` there). `path`
/// is opened again without following a reparse point, standing in for the
/// `lstat` identity as libuv's own `lstat` does, and both handles must name
/// the same file and neither may be a reparse point. Any failure to read an
/// identity refuses the policy: an identity Station cannot establish is not
/// a match.
#[cfg(windows)]
fn same_entry(
    path: &Path,
    _entry: &std::fs::Metadata,
    file: &std::fs::File,
    _opened: &std::fs::Metadata,
) -> bool {
    let Ok(entry_file) = open_no_follow(path) else {
        return false;
    };
    match (windows_identity(&entry_file), windows_identity(file)) {
        (Some(entry), Some(opened)) => entry == opened,
        _ => false,
    }
}

/// Volume serial number and file index of a handle that is not a reparse
/// point or a directory; `None` otherwise, or when Windows cannot say.
#[cfg(windows)]
fn windows_identity(file: &std::fs::File) -> Option<(u32, u64)> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_REPARSE_POINT,
    };
    // SAFETY: an all-zero BY_HANDLE_FILE_INFORMATION is a valid value of
    // this plain C struct, and the call only writes into it.
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: the handle is owned by `file`, which outlives the call.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
        return None;
    }
    if info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != 0 {
        return None;
    }
    Some((
        info.dwVolumeSerialNumber,
        (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
    ))
}

#[cfg(unix)]
fn owner_problem(
    entry: &Path,
    metadata: &std::fs::Metadata,
    ownership: &Ownership,
    check_mode: bool,
) -> Option<String> {
    use std::os::unix::fs::MetadataExt;
    if metadata.uid() != ownership.uid {
        let owner = if ownership.uid == 0 {
            "root".to_owned()
        } else {
            format!("uid {}", ownership.uid)
        };
        return Some(format!("{} is not owned by {owner}", entry.display()));
    }
    if check_mode && metadata.mode() & 0o022 != 0 {
        return Some(format!(
            "{} is writable by its group or other users",
            entry.display()
        ));
    }
    None
}

#[cfg(unix)]
fn file_ownership_problem(
    path: &Path,
    stats: &std::fs::Metadata,
    ownership: &Ownership,
) -> Option<String> {
    owner_problem(path, stats, ownership, true)
}

#[cfg(all(not(unix), not(windows)))]
fn file_ownership_problem(
    _path: &Path,
    _stats: &std::fs::Metadata,
    _ownership: &Ownership,
) -> Option<String> {
    None
}

/// `start` and each parent up to and including `root`, or `None` when
/// `root` is not among them.
fn ancestors_up_to(start: &Path, root: &Path) -> Option<Vec<PathBuf>> {
    let mut chain = Vec::new();
    for ancestor in start.ancestors() {
        chain.push(ancestor.to_path_buf());
        if ancestor == root {
            return Some(chain);
        }
    }
    None
}

/// `managedPolicyDirectoryProblem` on the server: the LITERAL chain is
/// checked with `lstat` (a link's own mode means nothing, so only its owner
/// is checked), and the RESOLVED chain (every ancestor of the directory's
/// real path) is checked too, so a root-owned link cannot lead into a
/// directory someone else can change.
#[cfg(unix)]
fn directory_problem(directory: &Path, ownership: &Ownership) -> Option<String> {
    let literal = ancestors_up_to(directory, &ownership.root);
    let (real_root, real_directory) = match (
        std::fs::canonicalize(&ownership.root),
        std::fs::canonicalize(directory),
    ) {
        (Ok(root), Ok(directory)) => (root, directory),
        (Err(error), _) | (_, Err(error)) => {
            return Some(format!(
                "{} cannot be resolved ({error})",
                directory.display()
            ))
        }
    };
    let real = ancestors_up_to(&real_directory, &real_root);
    let (Some(literal), Some(real)) = (literal, real) else {
        return Some(format!(
            "{} is not under {}",
            directory.display(),
            ownership.root.display()
        ));
    };
    for (chain, resolved) in [(literal, false), (real, true)] {
        for entry in chain {
            let metadata = match std::fs::symlink_metadata(&entry) {
                Ok(metadata) => metadata,
                Err(error) => {
                    return Some(format!("{} cannot be inspected ({error})", entry.display()))
                }
            };
            if resolved && !metadata.is_dir() {
                return Some(format!("{} is not a directory", entry.display()));
            }
            let is_link = metadata.file_type().is_symlink();
            if let Some(problem) = owner_problem(&entry, &metadata, ownership, !is_link) {
                return Some(problem);
            }
        }
    }
    None
}

#[cfg(all(not(unix), not(windows)))]
fn directory_problem(_directory: &Path, _ownership: &Ownership) -> Option<String> {
    None
}

/// The most redirects an update request follows on a mirror route; one more
/// is refused. The same bound as the server's manifest check.
pub const MIRROR_MAX_REDIRECTS: usize = 5;

/// Why a redirect to `next`, after `previous_hops` hops, must not be
/// followed on a mirror whose base is `mirror_base`, or `None` to follow
/// it. Every hop stays on the mirror's origin (scheme, host and port): the
/// policy approves that server, not wherever it points.
pub fn mirror_redirect_refusal(
    mirror_base: &str,
    next: &url::Url,
    previous_hops: usize,
) -> Option<&'static str> {
    if previous_hops >= MIRROR_MAX_REDIRECTS {
        return Some("the update request redirected too many times");
    }
    match url::Url::parse(mirror_base) {
        Ok(base) if base.origin().is_tuple() && base.origin() == next.origin() => None,
        _ => Some("the update request redirected outside the managed policy's mirror"),
    }
}

/// `text` with the path, query and fragment of every URL in it replaced by
/// `/…`, and any user name or password dropped, keeping the scheme, host
/// and port. A mirror's feed URL may carry a path token, so updater error
/// text passes through this before it reaches the window state or a log
/// (reqwest errors are first rebuilt without their URL; this is the
/// backstop for every other text).
///
/// A URL runs to the next whitespace or `"`, `<`, `>` or `` ` ``, which the
/// URL serializer always percent-encodes. Parentheses and apostrophes are
/// legal in a path, so they do not end it: `(…/a(secret)/token)` is
/// replaced whole. Only trailing `.`, `,`, `;` or `:`, and then a final `)`
/// closing a `(` just before the URL (as reqwest's `for url (…)` writes
/// it), are kept.
pub fn redact_urls(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut search = 0;
    while let Some(found) = text[search..].find("://") {
        let marker = search + found;
        let mut start = marker;
        while start > 0 {
            let byte = bytes[start - 1];
            if byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.') {
                start -= 1;
            } else {
                break;
            }
        }
        // Not a scheme: `://` with no letters before it.
        if start == marker || !bytes[start].is_ascii_alphabetic() {
            search = marker + 3;
            continue;
        }
        let rest = &text[marker + 3..];
        let mut end = marker
            + 3
            + rest
                .find(|c: char| c.is_whitespace() || matches!(c, '"' | '<' | '>' | '`'))
                .unwrap_or(rest.len());
        // Trailing sentence punctuation, then reqwest's closing `)`, stay
        // outside the URL; both are replaced along with it otherwise.
        while end > marker + 3 && matches!(bytes[end - 1], b'.' | b',' | b';' | b':') {
            end -= 1;
        }
        if start > 0 && bytes[start - 1] == b'(' && end > marker + 3 && bytes[end - 1] == b')' {
            end -= 1;
        }
        let after_scheme = &text[marker + 3..end];
        let authority_end = after_scheme
            .find(['/', '?', '#'])
            .unwrap_or(after_scheme.len());
        let authority = &after_scheme[..authority_end];
        let host = authority
            .rsplit_once('@')
            .map_or(authority, |(_, host)| host);
        out.push_str(&text[copied..start]);
        out.push_str(&text[start..marker + 3]);
        out.push_str(host);
        if authority_end < after_scheme.len() || host.len() != authority.len() {
            out.push_str("/…");
        }
        copied = end;
        search = end;
    }
    out.push_str(&text[copied..]);
    out
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
        InstalledPolicy::DeviceManaged => {
            return UpdateRoute::Refused(DEVICE_MANAGED_SENTENCE.into())
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

    /// A root holding a System-scope profile for Station's domain, as macOS
    /// installs it, under a scratch directory instead of `/`.
    fn root_with_profile(name: &str) -> PathBuf {
        let root = scratch(name);
        let profile = root.join(MACOS_MANAGED_PREFERENCES);
        std::fs::create_dir_all(profile.parent().unwrap()).unwrap();
        std::fs::write(&profile, b"<plist version=\"1.0\"><dict/></plist>").unwrap();
        root
    }

    #[test]
    fn a_macos_profile_counts_as_present_and_its_absence_does_not() {
        assert!(macos_profile_present(&root_with_profile("profile")));
        assert!(!macos_profile_present(&scratch("no-profile")));
        // An empty Managed Preferences folder holds no configuration profile for Station.
        let empty = scratch("empty-managed-preferences");
        std::fs::create_dir_all(empty.join("Library/Managed Preferences")).unwrap();
        assert!(!macos_profile_present(&empty));
    }

    #[cfg(unix)]
    #[test]
    fn a_link_at_the_profile_path_counts_as_present_without_being_followed() {
        let root = scratch("profile-link");
        let profile = root.join(MACOS_MANAGED_PREFERENCES);
        std::fs::create_dir_all(profile.parent().unwrap()).unwrap();
        // Dangling: following it would find nothing, so only lstat sees it.
        std::os::unix::fs::symlink(root.join("missing.plist"), &profile).unwrap();
        assert!(macos_profile_present(&root));
    }

    #[test]
    fn device_management_turns_desktop_updates_off_whatever_the_file_says() {
        // A usable file that names a mirror, beside a device-managed source.
        let dir = scratch("device-managed");
        let system = dir.join("policy.json");
        std::fs::write(
            &system,
            r#"{"schemaVersion":1,"organization":"Acme","limits":{"updates":{"feedUrl":"https://mirror.example/station"}}}"#,
        )
        .unwrap();
        let device_managed = macos_profile_present(&root_with_profile("device-managed-root"));
        let policy = load_with_device_management(device_managed, &system, None, None);
        assert_eq!(policy, InstalledPolicy::DeviceManaged);
        let route = route(&policy, "stable", &[STABLE.to_string()]);
        assert_eq!(route, UpdateRoute::Refused(DEVICE_MANAGED_SENTENCE.into()));
        assert!(!download_allowed(&route, STABLE));
        assert!(!download_allowed(
            &route,
            "https://mirror.example/station/stable-desktop/latest.json"
        ));
        // Without device management the same file is read as before.
        assert!(matches!(
            load_with_device_management(false, &system, None, None),
            InstalledPolicy::Limited(_)
        ));
        // And with neither, there is no policy.
        assert_eq!(
            load_with_device_management(false, &dir.join("absent.json"), None, None),
            InstalledPolicy::Unlimited
        );
    }

    #[cfg(windows)]
    #[test]
    fn untrusted_windows_policy_ancestor_cannot_select_an_update_mirror() {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::{
            ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW,
            SE_FILE_OBJECT,
        };
        use windows_sys::Win32::Security::{
            GetSecurityDescriptorDacl, GetSecurityDescriptorOwner, DACL_SECURITY_INFORMATION,
            OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
        };
        fn set_fixture_acl(path: &Path, sddl: &str) {
            let input: Vec<u16> = sddl.encode_utf16().chain(std::iter::once(0)).collect();
            let mut name: Vec<u16> = path
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let mut descriptor = std::ptr::null_mut();
            // SAFETY: all strings are terminated and the descriptor allocation
            // remains live until the setter returns. Only owned fixtures change.
            unsafe {
                assert_ne!(
                    ConvertStringSecurityDescriptorToSecurityDescriptorW(
                        input.as_ptr(),
                        1,
                        &mut descriptor,
                        std::ptr::null_mut()
                    ),
                    0
                );
                let mut owner = std::ptr::null_mut();
                let mut dacl = std::ptr::null_mut();
                let mut present = 0;
                let mut defaulted = 0;
                assert_ne!(
                    GetSecurityDescriptorOwner(descriptor, &mut owner, &mut defaulted),
                    0
                );
                assert_ne!(
                    GetSecurityDescriptorDacl(descriptor, &mut present, &mut dacl, &mut defaulted),
                    0
                );
                let status = SetNamedSecurityInfoW(
                    name.as_mut_ptr(),
                    SE_FILE_OBJECT,
                    OWNER_SECURITY_INFORMATION
                        | DACL_SECURITY_INFORMATION
                        | PROTECTED_DACL_SECURITY_INFORMATION,
                    owner,
                    std::ptr::null_mut(),
                    dacl,
                    std::ptr::null_mut(),
                );
                LocalFree(descriptor);
                assert_eq!(
                    status, 0,
                    "fixture setup requires an enabled Administrators token"
                );
            }
        }
        let dir = scratch("untrusted-windows-policy");
        let path = dir.join("policy.json");
        std::fs::write(&path, r#"{"schemaVersion":1,"organization":"Acme","limits":{"updates":{"feedUrl":"https://mirror.example/station"}}}"#).unwrap();
        set_fixture_acl(&path, "O:BAD:P(A;;FA;;;BA)(A;;FA;;;SY)");
        set_fixture_acl(
            &dir,
            "O:BAD:P(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)(A;OICI;FW;;;BU)",
        );
        let ownership = Ownership {
            uid: 0,
            root: PathBuf::from("/"),
        };
        let policy = load_from(&path, Some(&ownership), None);
        std::fs::remove_dir_all(&dir).unwrap();
        let InstalledPolicy::Unusable(problem) = &policy else {
            panic!("untrusted fixture path admitted: {policy:?}");
        };
        assert!(problem.contains(&dir.display().to_string()), "{problem}");
        assert!(problem.contains("grants write rights"), "{problem}");
        let route = route(&policy, "stable", &[STABLE.to_string()]);
        assert!(matches!(route, UpdateRoute::Refused(_)));
        assert!(!download_allowed(
            &route,
            "https://mirror.example/station/stable/latest.json"
        ));
    }

    #[cfg(windows)]
    #[test]
    fn the_windows_policy_key_check_reads_hklm() {
        // A key every Windows installation has, and one none has.
        assert!(windows_policy_key_present(
            "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"
        ));
        assert!(!windows_policy_key_present(
            "SOFTWARE\\Policies\\Kontour\\StationTestKeyThatDoesNotExist"
        ));
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
            load_from(&system, None, Some(override_path)),
            InstalledPolicy::Limited(UpdatesLimit { off: true, .. })
        ));
        // No system file and no override: no policy.
        assert_eq!(load_from(&system, None, None), InstalledPolicy::Unlimited);
        // A missing or relative override is unusable, never "no policy".
        assert!(matches!(
            load_from(
                &system,
                None,
                Some(dir.join("absent.json").to_str().unwrap())
            ),
            InstalledPolicy::Unusable(_)
        ));
        assert!(matches!(
            load_from(&system, None, Some("relative.json")),
            InstalledPolicy::Unusable(_)
        ));
        // A system policy with the override set is an error, as on the server.
        std::fs::write(&system, br#"{"schemaVersion":1,"organization":"A"}"#).unwrap();
        assert!(matches!(
            load_from(&system, None, Some(override_path)),
            InstalledPolicy::Unusable(_)
        ));
        assert_eq!(load_from(&system, None, None), InstalledPolicy::Unlimited);
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
            load_from(&link, None, None),
            InstalledPolicy::Unusable(_)
        ));
        // A dangling link is not absence either.
        std::fs::remove_file(&target).unwrap();
        assert!(matches!(
            load_from(&link, None, None),
            InstalledPolicy::Unusable(_)
        ));
        // A file this test (not root) owns fails the ownership rule.
        let owned = dir.join("owned.json");
        std::fs::write(&owned, br#"{"schemaVersion":1,"organization":"A"}"#).unwrap();
        if !running_as_root() {
            let system = Ownership {
                uid: 0,
                root: PathBuf::from("/"),
            };
            match load_from(&owned, Some(&system), None) {
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
            load_from(&directory, None, None),
            InstalledPolicy::Unusable(_)
        ));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// This test's own uid as the required owner, under a scratch root.
    #[cfg(unix)]
    fn own(root: &Path) -> Ownership {
        Ownership {
            uid: unsafe { libc::getuid() },
            root: std::fs::canonicalize(root).unwrap(),
        }
    }

    #[cfg(unix)]
    fn set_mode(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_directory_is_checked_along_its_resolved_ancestors() {
        let scratch_dir = scratch("resolved-chain");
        let root = std::fs::canonicalize(&scratch_dir).unwrap();
        set_mode(&root, 0o755);
        // `safe/station` is a link (owned by the required owner) into
        // `open/inner`, whose parent anyone may change.
        let safe = root.join("safe");
        let open = root.join("open");
        let inner = open.join("inner");
        std::fs::create_dir_all(&safe).unwrap();
        std::fs::create_dir_all(&inner).unwrap();
        set_mode(&safe, 0o755);
        set_mode(&inner, 0o755);
        set_mode(&open, 0o777);
        std::os::unix::fs::symlink(&inner, safe.join("station")).unwrap();
        let file = inner.join("policy.json");
        std::fs::write(
            &file,
            br#"{"schemaVersion":1,"organization":"A","limits":{"updates":{"mode":"off"}}}"#,
        )
        .unwrap();
        set_mode(&file, 0o644);
        let ownership = own(&root);
        let through_link = safe.join("station").join("policy.json");
        match load_from(&through_link, Some(&ownership), None) {
            InstalledPolicy::Unusable(reason) => assert!(
                reason.contains(&format!(
                    "{} is writable by its group or other users",
                    open.display()
                )),
                "{reason}"
            ),
            other => panic!("expected unusable, got {other:?}"),
        }
        // Control: the same chain with `open` closed again is usable.
        set_mode(&open, 0o755);
        assert!(matches!(
            load_from(&through_link, Some(&ownership), None),
            InstalledPolicy::Limited(UpdatesLimit { off: true, .. })
        ));
        // A writable literal parent is refused too.
        set_mode(&safe, 0o777);
        assert!(matches!(
            load_from(&through_link, Some(&ownership), None),
            InstalledPolicy::Unusable(_)
        ));
        set_mode(&safe, 0o755);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn a_file_that_grows_past_the_cap_is_refused_not_truncated() {
        use std::io::Read;
        // More bytes than the cap: what a file that grew after `fstat`
        // yields. Truncating it to the cap would parse a different document.
        let mut grown = std::io::repeat(b' ').take(MAX_POLICY_BYTES + 1);
        assert_eq!(
            read_bounded(&mut grown, MAX_POLICY_BYTES),
            Err("is larger than 1 MiB".to_string())
        );
        let mut exact = std::io::repeat(b' ').take(MAX_POLICY_BYTES);
        assert_eq!(
            read_bounded(&mut exact, MAX_POLICY_BYTES).map(|bytes| bytes.len() as u64),
            Ok(MAX_POLICY_BYTES)
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_is_refused_without_blocking() {
        let dir = scratch("fifo");
        let fifo = dir.join("policy.json");
        let path = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o644) }, 0);
        // No writer ever opens it: a blocking open would hang here.
        match load_from(&fifo, None, None) {
            InstalledPolicy::Unusable(reason) => {
                assert!(reason.contains("is not a regular file"), "{reason}")
            }
            other => panic!("expected unusable, got {other:?}"),
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_utf8_byte_order_mark_is_accepted() {
        let dir = scratch("bom");
        let file = dir.join("policy.json");
        let mut text = vec![0xEF, 0xBB, 0xBF];
        text.extend_from_slice(
            br#"{"schemaVersion":1,"organization":"A","limits":{"updates":{"mode":"off"}}}"#,
        );
        std::fs::write(&file, text).unwrap();
        assert!(matches!(
            load_from(&file, None, None),
            InstalledPolicy::Limited(UpdatesLimit { off: true, .. })
        ));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_mirror_redirect_is_followed_only_on_the_mirror_origin() {
        let base = "https://mirror.example/station/t0ken/";
        let url = |text: &str| url::Url::parse(text).unwrap();
        assert_eq!(
            mirror_redirect_refusal(base, &url("https://mirror.example/other/latest.json"), 0),
            None
        );
        for escape in [
            "https://github.com/kontourai/station/releases/download/v1/x",
            "https://mirror.example:8443/station/t0ken/x",
            "http://mirror.example/station/t0ken/x",
            "https://cdn.mirror.example/station/t0ken/x",
        ] {
            assert_eq!(
                mirror_redirect_refusal(base, &url(escape), 0),
                Some("the update request redirected outside the managed policy's mirror"),
                "{escape}"
            );
        }
        assert_eq!(
            mirror_redirect_refusal(base, &url("https://mirror.example/x"), MIRROR_MAX_REDIRECTS),
            Some("the update request redirected too many times")
        );
    }

    #[test]
    fn redaction_keeps_the_origin_and_drops_every_path_and_credential() {
        let feed = "https://mirror.example:8443/station/t0ken/stable-desktop/latest.json";
        let redacted = redact_urls(&format!(
            "error sending request for url ({feed}): connection refused"
        ));
        assert_eq!(
            redacted,
            "error sending request for url (https://mirror.example:8443/…): connection refused"
        );
        assert!(!redacted.contains("t0ken"));
        assert_eq!(
            redact_urls("a http://u:secret@host/x?y=1 and ftp://h"),
            "a http://host/… and ftp://h"
        );
        assert_eq!(redact_urls("no url :// here"), "no url :// here");
        assert_eq!(redact_urls("plain text"), "plain text");
    }

    /// #4522 round 2: parentheses and apostrophes are legal in a URL path,
    /// so they must not end the URL and leave the rest of the path showing.
    #[test]
    fn redaction_replaces_a_path_with_parentheses_or_apostrophes_whole() {
        // The reported repro, in reqwest's error shape.
        let repro = "error sending request for url (https://mirror.example/a(secret)/token/stable-desktop/latest.json)";
        assert_eq!(
            redact_urls(repro),
            "error sending request for url (https://mirror.example/…)"
        );
        for (text, expected) in [
            (
                "url (https://m.example/a'secret'/t0ken/latest.json): refused",
                "url (https://m.example/…): refused",
            ),
            (
                "url (https://m.example/(t0ken))",
                "url (https://m.example/…)",
            ),
            (
                "see https://m.example/x)t0ken(y and more",
                "see https://m.example/… and more",
            ),
            (
                "\"https://u:t0ken@m.example/a(b)\" twice https://m.example/c'd",
                "\"https://m.example/…\" twice https://m.example/…",
            ),
        ] {
            let redacted = redact_urls(text);
            assert_eq!(redacted, expected, "{text}");
            assert!(!redacted.contains("t0ken"), "{text}");
            assert!(!redacted.contains("secret"), "{text}");
        }
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
