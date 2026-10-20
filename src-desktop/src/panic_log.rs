//! Process panic hook that leaves a diagnosable record (#759, #370).
//!
//! A bundled GUI app's stderr goes nowhere, so the default hook's message is
//! lost, and a panic inside an AppKit/tao `extern "C"` callback aborts the
//! process (`panic_cannot_unwind`) right after the hook runs. The hook is the
//! last code that sees the panic's message and location, so it records them
//! before chaining to the previous hook.
//!
//! This only records. It does not stop the abort: unwinding cannot cross the
//! foreign frames, and an ObjC exception (`__rust_foreign_exception`) never
//! reaches a Rust panic hook at all.

use std::backtrace::Backtrace;
use std::io::Write;
use std::panic::PanicHookInfo;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Sits beside the desktop log file in the same log directory.
pub(crate) const CRASH_LOG_FILE_NAME: &str = "crash.log";

/// The panic payload as text. `panic!` with a literal yields `&str`, with
/// format arguments `String`; anything else (`panic_any`) has no message.
fn panic_payload_message(info: &PanicHookInfo<'_>) -> String {
    let payload = info.payload();
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_string()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

pub(crate) fn format_panic_record(
    unix_seconds: u64,
    thread: &str,
    message: &str,
    location: Option<&str>,
    backtrace: &str,
) -> String {
    format!(
        "=== station desktop panic at unix {unix_seconds} ===\n\
thread: {thread}\n\
location: {}\n\
message: {message}\n\
backtrace:\n{backtrace}\n",
        location.unwrap_or("<unknown>"),
    )
}

fn append_record(log_dir: &Path, record: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(log_dir)?;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join(CRASH_LOG_FILE_NAME))?;
    file.write_all(record.as_bytes())?;
    file.sync_all()
}

/// Installs the recording hook, chaining whatever hook was installed before.
///
/// With a `log_dir`, the record is appended synchronously to
/// `<log_dir>/crash.log` only: that works before the log plugin exists, and it
/// never re-enters the logger, which would deadlock if the panic happened
/// while this thread held the logger's lock. Without one (mobile), `log::error!`
/// is the only channel, and that re-entrancy risk is accepted there. A desktop
/// whose log directory is not writable is installed without one, so it falls
/// back to the logger the same way.
/// Errors are ignored, because a panic inside a panic hook aborts.
pub(crate) fn install(log_dir: Option<PathBuf>) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = panic_payload_message(info);
        let location = info.location().map(|location| {
            format!(
                "{}:{}:{}",
                location.file(),
                location.line(),
                location.column()
            )
        });
        let thread = std::thread::current();
        let thread_name = thread.name().unwrap_or("<unnamed>");
        let unix_seconds = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or(0);
        let backtrace = Backtrace::force_capture().to_string();
        let record = format_panic_record(
            unix_seconds,
            thread_name,
            &message,
            location.as_deref(),
            &backtrace,
        );
        if let Some(dir) = log_dir.as_deref() {
            let _ = append_record(dir, &record);
        } else {
            log::error!(
                "panic on thread '{thread_name}' at {}: {message}",
                location.as_deref().unwrap_or("<unknown>")
            );
        }
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_panic_record_carries_message_location_and_thread() {
        let record = format_panic_record(
            1_760_000_000,
            "main",
            "window lookup failed",
            Some("src/lib.rs:12:5"),
            "0: frame",
        );
        assert!(record.contains("unix 1760000000"));
        assert!(record.contains("thread: main\n"));
        assert!(record.contains("location: src/lib.rs:12:5\n"));
        assert!(record.contains("message: window lookup failed\n"));
        assert!(record.contains("backtrace:\n0: frame"));
        assert!(format_panic_record(0, "t", "m", None, "").contains("location: <unknown>\n"));
    }

    /// Drives the installed hook with a real panic. The hook is process-wide,
    /// so it is removed again afterwards; it chains the previous hook, so a
    /// concurrently panicking test still gets its usual output meanwhile.
    #[test]
    fn installed_hook_appends_the_panic_message_and_location_to_crash_log() {
        let dir = tempfile::tempdir().expect("temp dir");
        let log_dir = dir.path().join("logs");
        install(Some(log_dir.clone()));
        let marker = "panic-log-probe-7f3c";
        let line = line!() + 2;
        let outcome = std::thread::spawn(move || {
            let _ = std::panic::catch_unwind(|| panic!("{marker}: reopen"));
        })
        .join();
        drop(std::panic::take_hook());
        outcome.expect("probe thread");

        let crash_log = std::fs::read_to_string(log_dir.join(CRASH_LOG_FILE_NAME))
            .expect("crash.log written by the hook");
        assert!(
            crash_log.contains(&format!("message: {marker}: reopen\n")),
            "{crash_log}"
        );
        assert!(
            crash_log.contains(&format!("panic_log.rs:{line}:")),
            "{crash_log}"
        );
    }
}
