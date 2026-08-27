//! Pure state machine for the desktop-owned Command Station sidecar.
//!
//! This module deliberately has no Tauri or process dependency. The future
//! supervisor performs I/O separately; these transitions and the stdout
//! listening handshake are deterministic and unit-testable on their own.

use serde::Serialize;

/// The supervisor gives up once this many crash restarts have been attempted.
/// A user-requested restart resets the counter.
pub const MAX_ATTEMPTS: u32 = 5;

const BACKOFF_BASE_MS: u64 = 500;
const BACKOFF_CAP_MS: u64 = 15_000;

/// Lifecycle phase of the desktop-owned sidecar. Serialized camelCase to
/// match the existing native/webview payload contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ServerPhase {
    Starting,
    Running,
    Restarting,
    Stopping,
    Failed,
    Stopped,
}

/// The authoritative sidecar status snapshot. The payload type name remains
/// stable because it crosses the native/webview boundary.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledServerStatus {
    pub phase: ServerPhase,
    pub attempt: u32,
    pub max_attempts: u32,
    pub api_base: Option<String>,
    pub port: Option<u16>,
    /// One sidecar child generation; absent when no desktop-owned child exists.
    pub generation: Option<u64>,
    /// Stable server identity for the selected desktop channel installation.
    pub instance_id: Option<String>,
    /// Per-child server boot identity; rotates on every supervised restart.
    pub boot_id: Option<String>,
    pub last_exit_code: Option<i32>,
    pub next_retry_in_ms: Option<u64>,
    pub log_path: Option<String>,
    pub error_log_path: Option<String>,
    pub desktop_log_path: Option<String>,
    pub ownership: ServerOwnership,
    pub can_run_in_background: bool,
    pub fail_closed: bool,
    pub message: String,
    pub detail: Option<String>,
}

impl BundledServerStatus {
    pub fn initial(_log_path: String, _error_log_path: String) -> Self {
        Self {
            phase: ServerPhase::Starting,
            attempt: 0,
            max_attempts: MAX_ATTEMPTS,
            api_base: None,
            port: None,
            generation: None,
            instance_id: None,
            boot_id: None,
            last_exit_code: None,
            next_retry_in_ms: None,
            // The desktop host captures its own log through the Tauri log
            // plugin. The sidecar pipes are used for readiness/fail-closed
            // detection, not persisted files, so do not advertise paths that
            // this implementation does not write.
            log_path: None,
            error_log_path: None,
            desktop_log_path: None,
            ownership: ServerOwnership::Sidecar,
            can_run_in_background: true,
            fail_closed: false,
            message: message_for(ServerPhase::Starting, 0, MAX_ATTEMPTS),
            detail: None,
        }
    }
}

/// Exactly one local process is selected for a desktop home at a time.
/// `None` means the registry decision failed closed or has not completed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ServerOwnership {
    Sidecar,
    Service,
    None,
}

/// A home-schema failure is deterministic, so retrying cannot repair it.
pub const HOME_RESET_MARKER: &str = "STATION_HOME_RESET_REQUIRED";

pub fn fail_closed_message(detail: Option<&str>) -> Option<String> {
    detail?.contains(HOME_RESET_MARKER).then(|| {
        "Station's data folder was created by an incompatible version \
         (STATION_HOME_RESET_REQUIRED). Restarting cannot fix this: move \
         or reset the Station home shown in the error log, then restart \
         Station."
            .to_string()
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SupervisorInput {
    Spawned,
    Listening {
        port: u16,
    },
    Exited {
        code: Option<i32>,
        detail: Option<String>,
    },
    ManualRestart,
    ShutdownRequested,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SupervisorEffect {
    Respawn { delay_ms: u64 },
    GracefulStopThenRespawn,
    Kill,
    None,
}

/// A parsed listening handshake paired with the child generation that emitted
/// it. The future I/O supervisor discards handshakes from superseded children.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GenerationTaggedListening {
    pub generation: u64,
    pub port: u16,
}

/// Exponential crash backoff: 500ms, 1s, 2s, ... capped at 15s.
pub fn backoff_delay_ms(attempt: u32) -> u64 {
    let factor = 2u64.checked_pow(attempt).unwrap_or(u64::MAX);
    BACKOFF_BASE_MS.saturating_mul(factor).min(BACKOFF_CAP_MS)
}

/// Parses one stdout listening handshake. Other stdout is intentionally ignored.
pub fn parse_listening_line(line: &str) -> Option<u16> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if value.get("event")?.as_str()? != "listening" {
        return None;
    }
    u16::try_from(value.get("port")?.as_u64()?).ok()
}

pub fn parse_generation_tagged_listening(
    generation: u64,
    line: &str,
) -> Option<GenerationTaggedListening> {
    parse_listening_line(line).map(|port| GenerationTaggedListening { generation, port })
}

fn message_for(phase: ServerPhase, attempt: u32, max_attempts: u32) -> String {
    match phase {
        ServerPhase::Starting => "Starting Station on this device…".to_string(),
        ServerPhase::Running => "Station is running on this device.".to_string(),
        ServerPhase::Restarting => format!(
            "Station stopped unexpectedly. Restarting on this device… (attempt {attempt} of {max_attempts})"
        ),
        ServerPhase::Stopping => "Stopping Station on this device…".to_string(),
        ServerPhase::Failed => format!(
            "Station's local sidecar stopped. Station tried to restart it {max_attempts} times without success."
        ),
        ServerPhase::Stopped => "Station on this device is stopped.".to_string(),
    }
}

/// Pure state transition: no spawning, sleeping, logging, or Tauri access.
/// Effects are a vector so the future I/O layer can execute the transition
/// contract without smuggling side effects back into this state machine.
pub fn transition(
    current: &BundledServerStatus,
    input: &SupervisorInput,
) -> (BundledServerStatus, Vec<SupervisorEffect>) {
    let mut next = current.clone();
    next.next_retry_in_ms = None;
    next.fail_closed = false;

    match input {
        SupervisorInput::Spawned => {
            next.phase = ServerPhase::Starting;
            next.api_base = None;
            next.port = None;
            next.generation = None;
            next.boot_id = None;
            next.detail = None;
            next.message = message_for(ServerPhase::Starting, next.attempt, next.max_attempts);
            (next, vec![SupervisorEffect::None])
        }
        SupervisorInput::Listening { port } => {
            next.phase = ServerPhase::Running;
            next.port = Some(*port);
            next.api_base = Some(format!("http://127.0.0.1:{port}"));
            next.detail = None;
            next.message = message_for(ServerPhase::Running, next.attempt, next.max_attempts);
            (next, vec![SupervisorEffect::None])
        }
        SupervisorInput::Exited { code, detail } => {
            next.last_exit_code = *code;
            next.api_base = None;
            next.port = None;
            next.generation = None;
            next.boot_id = None;
            match current.phase {
                ServerPhase::Stopping => {
                    next.phase = ServerPhase::Stopped;
                    next.detail = None;
                    next.message =
                        message_for(ServerPhase::Stopped, next.attempt, next.max_attempts);
                    (next, vec![SupervisorEffect::None])
                }
                ServerPhase::Failed | ServerPhase::Stopped => {
                    next.fail_closed = current.fail_closed;
                    (next, vec![SupervisorEffect::None])
                }
                _ => {
                    let attempt = current.attempt.saturating_add(1);
                    next.attempt = attempt;
                    if let Some(message) = fail_closed_message(detail.as_deref()) {
                        next.phase = ServerPhase::Failed;
                        next.fail_closed = true;
                        next.detail = detail.clone();
                        next.message = message;
                        return (next, vec![SupervisorEffect::None]);
                    }
                    if attempt >= current.max_attempts {
                        next.phase = ServerPhase::Failed;
                        next.detail = detail.clone();
                        next.message = message_for(ServerPhase::Failed, attempt, next.max_attempts);
                        (next, vec![SupervisorEffect::None])
                    } else {
                        let delay = backoff_delay_ms(attempt);
                        next.phase = ServerPhase::Restarting;
                        next.detail = None;
                        next.next_retry_in_ms = Some(delay);
                        next.message =
                            message_for(ServerPhase::Restarting, attempt, next.max_attempts);
                        (next, vec![SupervisorEffect::Respawn { delay_ms: delay }])
                    }
                }
            }
        }
        SupervisorInput::ManualRestart => {
            next.attempt = 0;
            next.api_base = None;
            next.port = None;
            next.generation = None;
            next.boot_id = None;
            next.detail = None;
            next.last_exit_code = None;
            match current.phase {
                ServerPhase::Starting | ServerPhase::Running | ServerPhase::Restarting => {
                    next.phase = ServerPhase::Stopping;
                    next.message = message_for(ServerPhase::Stopping, 0, next.max_attempts);
                    (next, vec![SupervisorEffect::GracefulStopThenRespawn])
                }
                _ => {
                    next.phase = ServerPhase::Starting;
                    next.message = message_for(ServerPhase::Starting, 0, next.max_attempts);
                    (next, vec![SupervisorEffect::Respawn { delay_ms: 0 }])
                }
            }
        }
        SupervisorInput::ShutdownRequested => {
            next.phase = ServerPhase::Stopped;
            next.api_base = None;
            next.port = None;
            next.message = message_for(ServerPhase::Stopped, next.attempt, next.max_attempts);
            (next, vec![SupervisorEffect::Kill])
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(phase: ServerPhase, attempt: u32) -> BundledServerStatus {
        let mut status = BundledServerStatus::initial("/tmp/out.log".into(), "/tmp/err.log".into());
        status.phase = phase;
        status.attempt = attempt;
        status
    }

    fn exited(code: Option<i32>) -> SupervisorInput {
        SupervisorInput::Exited { code, detail: None }
    }

    #[test]
    fn starting_listening_becomes_running_with_api_base() {
        let (next, effect) = transition(
            &at(ServerPhase::Starting, 0),
            &SupervisorInput::Listening { port: 51234 },
        );
        assert_eq!(next.phase, ServerPhase::Running);
        assert_eq!(next.port, Some(51234));
        assert_eq!(next.api_base.as_deref(), Some("http://127.0.0.1:51234"));
        assert_eq!(effect, vec![SupervisorEffect::None]);
    }

    #[test]
    fn crash_retries_until_the_exact_attempt_cap() {
        let mut status = at(ServerPhase::Starting, 0);
        let mut phases = Vec::new();
        for _ in 0..MAX_ATTEMPTS {
            let (next, _) = transition(&status, &exited(Some(2)));
            phases.push((next.phase, next.attempt));
            status = next;
        }
        assert_eq!(
            phases,
            vec![
                (ServerPhase::Restarting, 1),
                (ServerPhase::Restarting, 2),
                (ServerPhase::Restarting, 3),
                (ServerPhase::Restarting, 4),
                (ServerPhase::Failed, 5),
            ]
        );
        assert_eq!(status.attempt, MAX_ATTEMPTS);
    }

    #[test]
    fn home_reset_required_fails_without_a_further_retry_attempt() {
        let (next, effect) = transition(
            &at(ServerPhase::Starting, 0),
            &SupervisorInput::Exited {
                code: Some(1),
                detail: Some("STATION_HOME_RESET_REQUIRED: incompatible schema".into()),
            },
        );
        assert_eq!(next.phase, ServerPhase::Failed);
        assert_eq!(next.attempt, 1);
        assert_eq!(effect, vec![SupervisorEffect::None]);
        assert!(next.fail_closed);
    }

    #[test]
    fn failure_carries_stderr_detail() {
        let (next, effect) = transition(
            &at(ServerPhase::Restarting, MAX_ATTEMPTS - 1),
            &SupervisorInput::Exited {
                code: Some(1),
                detail: Some("Error: EADDRINUSE".into()),
            },
        );
        assert_eq!(next.phase, ServerPhase::Failed);
        assert_eq!(next.detail.as_deref(), Some("Error: EADDRINUSE"));
        assert_eq!(effect, vec![SupervisorEffect::None]);
    }

    #[test]
    fn manual_restart_stops_a_live_sidecar_then_respawns() {
        let (next, effect) = transition(
            &at(ServerPhase::Running, 2),
            &SupervisorInput::ManualRestart,
        );
        assert_eq!(next.phase, ServerPhase::Stopping);
        assert_eq!(next.attempt, 0);
        assert_eq!(effect, vec![SupervisorEffect::GracefulStopThenRespawn]);
    }

    #[test]
    fn manual_restart_recovers_a_terminal_failure_immediately() {
        let (next, effect) = transition(
            &at(ServerPhase::Failed, MAX_ATTEMPTS),
            &SupervisorInput::ManualRestart,
        );
        assert_eq!(next.phase, ServerPhase::Starting);
        assert_eq!(next.attempt, 0);
        assert_eq!(effect, vec![SupervisorEffect::Respawn { delay_ms: 0 }]);
    }

    #[test]
    fn shutdown_kills_each_phase_to_stopped() {
        for phase in [
            ServerPhase::Starting,
            ServerPhase::Running,
            ServerPhase::Restarting,
            ServerPhase::Stopping,
            ServerPhase::Failed,
            ServerPhase::Stopped,
        ] {
            let (next, effect) = transition(&at(phase, 1), &SupervisorInput::ShutdownRequested);
            assert_eq!(next.phase, ServerPhase::Stopped);
            assert_eq!(effect, vec![SupervisorEffect::Kill]);
        }
    }

    #[test]
    fn backoff_is_exponential_and_capped() {
        assert_eq!(
            (0..8).map(backoff_delay_ms).collect::<Vec<_>>(),
            vec![500, 1000, 2000, 4000, 8000, 15000, 15000, 15000]
        );
        assert_eq!(backoff_delay_ms(u32::MAX), BACKOFF_CAP_MS);
    }

    #[test]
    fn generation_tagged_handshake_parses_listening_and_rejects_malformed_input() {
        assert_eq!(
            parse_generation_tagged_listening(42, r#"{"event":"listening","port":38141}"#),
            Some(GenerationTaggedListening {
                generation: 42,
                port: 38141
            })
        );
        assert_eq!(
            parse_generation_tagged_listening(42, r#"{"event":"listening","port":"bad"}"#),
            None
        );
        assert_eq!(parse_generation_tagged_listening(42, "not json"), None);
    }
}
