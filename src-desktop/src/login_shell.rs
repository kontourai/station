//! Bounded, process-owned recovery of PATH for GUI-launched desktop commands.
use std::io::{ErrorKind, Read};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

struct LoginPath(std::sync::Mutex<Option<String>>);

impl LoginPath {
    fn resolve(&self, shell: &str) -> String {
        let mut cached = self.0.lock().unwrap_or_else(|error| error.into_inner());
        cached
            .get_or_insert_with(|| {
                resolve_path(shell).unwrap_or_else(|| std::env::var("PATH").unwrap_or_default())
            })
            .clone()
    }

    fn invalidate(&self) {
        *self.0.lock().unwrap_or_else(|error| error.into_inner()) = None;
    }
}

static LOGIN_PATH: LoginPath = LoginPath(std::sync::Mutex::new(None));

pub(super) fn cached_path() -> String {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    LOGIN_PATH.resolve(&shell)
}

pub(super) fn invalidate_path() {
    LOGIN_PATH.invalidate();
}

struct OwnedShell(Child);
impl Drop for OwnedShell {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            // The unreaped leader still owns this id; only our newly created
            // process group is signalled. Never match a process by its name.
            unsafe {
                libc::kill(-(self.0.id() as i32), libc::SIGKILL);
            }
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

pub(super) fn resolve_path(shell: &str) -> Option<String> {
    let mut command = Command::new(shell);
    // Framing excludes startup banners; quoting preserves spaces and glob chars.
    command.args(["-ilc", "printf '\\036%s\\037' \"$PATH\""]);
    capture_path(command, Duration::from_secs(5))
}

fn capture_path(mut command: Command, budget: Duration) -> Option<String> {
    const MAX_BYTES: usize = 64 * 1024;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .process_group(0);
    let mut child = OwnedShell(command.spawn().ok()?);
    let mut stdout = child.0.stdout.take()?;
    let fd = stdout.as_raw_fd();
    // Nonblocking reads keep the same deadline in charge when a shell or one
    // of its startup children retains the output pipe without writing.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return None;
    }
    let start = Instant::now();
    let mut bytes = Vec::new();
    let mut chunk = [0; 4096];
    let mut exited: Option<std::process::ExitStatus> = None;
    loop {
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) => break,
                Ok(count) => {
                    if bytes.len() + count > MAX_BYTES {
                        return None;
                    }
                    bytes.extend_from_slice(&chunk[..count]);
                }
                Err(error) if error.kind() == ErrorKind::WouldBlock => break,
                Err(error) if error.kind() == ErrorKind::Interrupted => continue,
                Err(_) => return None,
            }
        }
        if let Some(status) = exited {
            if !status.success() {
                return None;
            }
            let end = bytes.iter().rposition(|byte| *byte == 0x1f)?;
            let begin = bytes[..end].iter().rposition(|byte| *byte == 0x1e)?;
            let path = String::from_utf8(bytes[begin + 1..end].to_vec()).ok()?;
            return (!path.is_empty()).then_some(path);
        }
        if let Some(status) = child.0.try_wait().ok()? {
            // Drain again after observing exit: the child may have written
            // between our WouldBlock observation and try_wait.
            exited = Some(status);
            continue;
        }
        if start.elapsed() >= budget {
            return None;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn shell(script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]);
        command
    }
    #[test]
    fn resolves_once_until_explicit_refresh() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let shell = directory.path().join("shell");
        let calls = directory.path().join("calls");
        let write_shell = |path: &str| {
            std::fs::write(
                &shell,
                format!(
                    "#!/bin/sh\necho call >> '{}'\nprintf '\\036%s\\037' '{path}'\n",
                    calls.display()
                ),
            )
            .unwrap();
            std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o700)).unwrap();
        };
        let cache = LoginPath(std::sync::Mutex::new(None));
        write_shell("/first:/usr/bin");
        assert_eq!(cache.resolve(shell.to_str().unwrap()), "/first:/usr/bin");
        write_shell("/updated:/usr/bin");
        assert_eq!(cache.resolve(shell.to_str().unwrap()), "/first:/usr/bin");
        assert_eq!(std::fs::read_to_string(&calls).unwrap(), "call\n");
        cache.invalidate();
        assert_eq!(cache.resolve(shell.to_str().unwrap()), "/updated:/usr/bin");
        assert_eq!(std::fs::read_to_string(&calls).unwrap(), "call\ncall\n");
    }
    #[test]
    fn keeps_exact_path_and_ignores_login_banners() {
        assert_eq!(
            capture_path(
                shell("printf 'welcome\\n\\036/space here/*:/usr/bin\\037'"),
                Duration::from_secs(5)
            ),
            Some("/space here/*:/usr/bin".into())
        );
    }
    #[test]
    fn rejects_unframed_or_failed_output() {
        assert_eq!(
            capture_path(shell("echo banner"), Duration::from_secs(5)),
            None
        );
        assert_eq!(
            capture_path(
                shell("printf '\\036/usr/bin\\037'; exit 1"),
                Duration::from_secs(5)
            ),
            None
        );
    }
    #[test]
    fn times_out_a_shell_with_a_silent_child() {
        assert_eq!(
            capture_path(
                shell("sleep 10; printf '\\036/usr/bin\\037'"),
                Duration::from_millis(30)
            ),
            None
        );
    }
    #[test]
    fn bounds_startup_output_before_accepting_a_framed_path() {
        assert_eq!(
            capture_path(
                shell("head -c 131072 /dev/zero; printf '\\036/usr/bin\\037'"),
                Duration::from_secs(5)
            ),
            None
        );
    }
}
