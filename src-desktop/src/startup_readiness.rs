//! Pure readiness authority for the desktop main window.
//!
//! Starting a sidecar is not evidence that its authenticated UI is ready.  The
//! host owns this small state machine; the renderer may only commit a ticket
//! that exactly matches the sidecar generation and identity advertised by the
//! native supervisor.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupTicket {
    pub generation: u64,
    pub instance_id: String,
    pub boot_id: String,
    pub api_base: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadinessPhase {
    Waiting,
    Ready,
    Failed,
    Bypassed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StartupReadiness {
    pub epoch: u64,
    pub phase: ReadinessPhase,
    pub deadline_ms: u64,
    pub current_generation: Option<u64>,
    pub owned_sidecar: bool,
    pub ticket: Option<StartupTicket>,
    /// A current ticket gets one non-disruptive reprobe. If it does not commit
    /// before the next deadline, the next explicit retry clears it and takes
    /// the ordinary owned-sidecar restart path.
    pub reprobe_attempted: bool,
    pub activation_pending: bool,
    pub diagnostic_shown: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReadinessInput {
    Begin {
        now_ms: u64,
        timeout_ms: u64,
        dev_bypass: bool,
        owned_sidecar: bool,
    },
    ServerTicket(StartupTicket),
    RendererCommitted(StartupTicket),
    RecoveryUiCommitted,
    ServerLost {
        generation: u64,
    },
    DeadlineElapsed {
        epoch: u64,
        now_ms: u64,
    },
    Retry {
        now_ms: u64,
        timeout_ms: u64,
    },
    ActivationRequested,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReadinessEffect {
    RevealMainWindow,
    DeferActivation,
    ShowDiagnostic {
        epoch: u64,
    },
    /// The existing exact ticket is still current. Ask the renderer to prove
    /// it before disrupting a sidecar that may already be healthy.
    ReprobeCurrentTicket,
    RestartOwnedSidecar,
    RecommitRecoverySurface,
    Exit,
}

impl Default for StartupReadiness {
    fn default() -> Self {
        Self {
            epoch: 0,
            phase: ReadinessPhase::Waiting,
            deadline_ms: 0,
            current_generation: None,
            owned_sidecar: false,
            ticket: None,
            reprobe_attempted: false,
            activation_pending: false,
            diagnostic_shown: false,
        }
    }
}

/// Applies one event without touching Tauri, clocks, dialogs, or processes.
pub fn transition(
    state: &StartupReadiness,
    input: ReadinessInput,
) -> (StartupReadiness, Vec<ReadinessEffect>) {
    let mut next = state.clone();
    let mut effects = Vec::new();
    match input {
        ReadinessInput::Begin {
            now_ms,
            timeout_ms,
            dev_bypass,
            owned_sidecar,
        } => {
            next.epoch += 1;
            next.deadline_ms = now_ms.saturating_add(timeout_ms);
            next.ticket = None;
            next.reprobe_attempted = false;
            next.current_generation = None;
            next.owned_sidecar = owned_sidecar;
            next.activation_pending = false;
            next.diagnostic_shown = false;
            next.phase = if dev_bypass {
                ReadinessPhase::Bypassed
            } else {
                ReadinessPhase::Waiting
            };
            if dev_bypass {
                effects.push(ReadinessEffect::RevealMainWindow);
            }
        }
        ReadinessInput::ServerTicket(ticket) => {
            if matches!(next.phase, ReadinessPhase::Waiting)
                && next
                    .current_generation
                    .is_none_or(|current| ticket.generation >= current)
            {
                next.current_generation = Some(ticket.generation);
                next.ticket = Some(ticket);
            }
        }
        ReadinessInput::RendererCommitted(ticket) => {
            if matches!(next.phase, ReadinessPhase::Waiting)
                && next.ticket.as_ref() == Some(&ticket)
            {
                next.phase = ReadinessPhase::Ready;
                effects.push(ReadinessEffect::RevealMainWindow);
            }
        }
        ReadinessInput::RecoveryUiCommitted => {
            if matches!(next.phase, ReadinessPhase::Waiting | ReadinessPhase::Failed)
                && !next.owned_sidecar
            {
                next.phase = ReadinessPhase::Ready;
                effects.push(ReadinessEffect::RevealMainWindow);
            }
        }
        ReadinessInput::ServerLost { generation } => {
            if matches!(next.phase, ReadinessPhase::Waiting | ReadinessPhase::Failed)
                && next.current_generation == Some(generation)
            {
                next.ticket = None;
            }
        }
        ReadinessInput::DeadlineElapsed { epoch, now_ms }
            if matches!(next.phase, ReadinessPhase::Waiting)
                && epoch == next.epoch
                && now_ms >= next.deadline_ms =>
        {
            next.phase = ReadinessPhase::Failed;
            if !next.diagnostic_shown {
                next.diagnostic_shown = true;
                effects.push(ReadinessEffect::ShowDiagnostic { epoch: next.epoch });
            }
        }
        ReadinessInput::Retry { now_ms, timeout_ms } if next.phase == ReadinessPhase::Failed => {
            next.epoch += 1;
            next.phase = ReadinessPhase::Waiting;
            next.deadline_ms = now_ms.saturating_add(timeout_ms);
            next.activation_pending = false;
            next.diagnostic_shown = false;
            effects.push(
                if next.owned_sidecar && next.ticket.is_some() && !next.reprobe_attempted {
                    next.reprobe_attempted = true;
                    ReadinessEffect::ReprobeCurrentTicket
                } else if next.owned_sidecar {
                    next.ticket = None;
                    next.current_generation = None;
                    next.reprobe_attempted = false;
                    ReadinessEffect::RestartOwnedSidecar
                } else {
                    ReadinessEffect::RecommitRecoverySurface
                },
            );
        }
        ReadinessInput::ActivationRequested
            if matches!(next.phase, ReadinessPhase::Waiting | ReadinessPhase::Failed) =>
        {
            next.activation_pending = true;
            effects.push(ReadinessEffect::DeferActivation);
        }
        ReadinessInput::ActivationRequested => effects.push(ReadinessEffect::RevealMainWindow),
        _ => {}
    }
    (next, effects)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ticket(generation: u64) -> StartupTicket {
        StartupTicket {
            generation,
            instance_id: "desktop-sidecar-stable".into(),
            boot_id: format!("boot-{generation}"),
            api_base: "http://127.0.0.1:4123".into(),
        }
    }
    fn begin(owned_sidecar: bool) -> StartupReadiness {
        transition(
            &StartupReadiness::default(),
            ReadinessInput::Begin {
                now_ms: 1,
                timeout_ms: 10,
                dev_bypass: false,
                owned_sidecar,
            },
        )
        .0
    }
    #[test]
    fn commits_only_the_exact_ticket() {
        let (s, _) = transition(
            &StartupReadiness::default(),
            ReadinessInput::Begin {
                now_ms: 1,
                timeout_ms: 10,
                dev_bypass: false,
                owned_sidecar: true,
            },
        );
        let (s, _) = transition(&s, ReadinessInput::ServerTicket(ticket(1)));
        let (s, effects) = transition(&s, ReadinessInput::RendererCommitted(ticket(2)));
        assert_eq!(s.phase, ReadinessPhase::Waiting);
        assert!(effects.is_empty());
        let (s, effects) = transition(&s, ReadinessInput::RendererCommitted(ticket(1)));
        assert_eq!(s.phase, ReadinessPhase::Ready);
        assert_eq!(effects, vec![ReadinessEffect::RevealMainWindow]);
    }
    #[test]
    fn timeout_is_once_per_epoch_and_retry_restarts_owned_sidecar_without_a_ticket() {
        let (s, _) = transition(
            &StartupReadiness::default(),
            ReadinessInput::Begin {
                now_ms: 1,
                timeout_ms: 10,
                dev_bypass: false,
                owned_sidecar: true,
            },
        );
        let (s, effects) = transition(
            &s,
            ReadinessInput::DeadlineElapsed {
                epoch: 1,
                now_ms: 11,
            },
        );
        assert_eq!(effects, vec![ReadinessEffect::ShowDiagnostic { epoch: 1 }]);
        let (_, effects) = transition(
            &s,
            ReadinessInput::DeadlineElapsed {
                epoch: 1,
                now_ms: 12,
            },
        );
        assert!(effects.is_empty());
        let (s, effects) = transition(
            &s,
            ReadinessInput::Retry {
                now_ms: 20,
                timeout_ms: 10,
            },
        );
        assert_eq!(s.epoch, 2);
        assert_eq!(effects, vec![ReadinessEffect::RestartOwnedSidecar]);
    }
    #[test]
    fn retry_reprobes_a_current_ticket_before_restarting_an_owned_sidecar() {
        let (s, _) = transition(
            &StartupReadiness::default(),
            ReadinessInput::Begin {
                now_ms: 1,
                timeout_ms: 10,
                dev_bypass: false,
                owned_sidecar: true,
            },
        );
        let (s, _) = transition(&s, ReadinessInput::ServerTicket(ticket(1)));
        let (s, _) = transition(
            &s,
            ReadinessInput::DeadlineElapsed {
                epoch: 1,
                now_ms: 11,
            },
        );
        let (s, effects) = transition(
            &s,
            ReadinessInput::Retry {
                now_ms: 20,
                timeout_ms: 10,
            },
        );
        assert_eq!(effects, vec![ReadinessEffect::ReprobeCurrentTicket]);
        assert_eq!(s.ticket, Some(ticket(1)));
        let (s, effects) = transition(&s, ReadinessInput::RendererCommitted(ticket(1)));
        assert_eq!(s.phase, ReadinessPhase::Ready);
        assert_eq!(effects, vec![ReadinessEffect::RevealMainWindow]);
    }
    #[test]
    fn unsuccessful_reprobe_escalates_to_an_owned_sidecar_restart_on_the_next_retry() {
        let (s, _) = transition(
            &StartupReadiness::default(),
            ReadinessInput::Begin {
                now_ms: 1,
                timeout_ms: 10,
                dev_bypass: false,
                owned_sidecar: true,
            },
        );
        let (s, _) = transition(&s, ReadinessInput::ServerTicket(ticket(1)));
        let (s, _) = transition(
            &s,
            ReadinessInput::DeadlineElapsed {
                epoch: 1,
                now_ms: 11,
            },
        );
        let (s, effects) = transition(
            &s,
            ReadinessInput::Retry {
                now_ms: 20,
                timeout_ms: 10,
            },
        );
        assert_eq!(effects, vec![ReadinessEffect::ReprobeCurrentTicket]);
        let (s, _) = transition(
            &s,
            ReadinessInput::DeadlineElapsed {
                epoch: 2,
                now_ms: 30,
            },
        );
        let (s, effects) = transition(
            &s,
            ReadinessInput::Retry {
                now_ms: 40,
                timeout_ms: 10,
            },
        );
        assert_eq!(effects, vec![ReadinessEffect::RestartOwnedSidecar]);
        assert!(s.ticket.is_none());
    }
    #[test]
    fn loss_after_the_deadline_clears_the_ticket_before_retry() {
        let (s, _) = transition(
            &StartupReadiness::default(),
            ReadinessInput::Begin {
                now_ms: 1,
                timeout_ms: 10,
                dev_bypass: false,
                owned_sidecar: true,
            },
        );
        let (s, _) = transition(&s, ReadinessInput::ServerTicket(ticket(1)));
        let (s, _) = transition(
            &s,
            ReadinessInput::DeadlineElapsed {
                epoch: 1,
                now_ms: 11,
            },
        );
        let (s, _) = transition(&s, ReadinessInput::ServerLost { generation: 1 });
        assert!(s.ticket.is_none());
        let (_, effects) = transition(
            &s,
            ReadinessInput::Retry {
                now_ms: 20,
                timeout_ms: 10,
            },
        );
        assert_eq!(effects, vec![ReadinessEffect::RestartOwnedSidecar]);
    }
    #[test]
    fn loss_invalidates_pending_ticket_and_activation_defers_but_post_ready_does_not_rehide() {
        let (s, _) = transition(
            &StartupReadiness::default(),
            ReadinessInput::Begin {
                now_ms: 1,
                timeout_ms: 10,
                dev_bypass: false,
                owned_sidecar: true,
            },
        );
        let (s, _) = transition(&s, ReadinessInput::ServerTicket(ticket(1)));
        let (s, _) = transition(&s, ReadinessInput::ServerLost { generation: 1 });
        assert!(s.ticket.is_none());
        let (s, effects) = transition(&s, ReadinessInput::ActivationRequested);
        assert_eq!(effects, vec![ReadinessEffect::DeferActivation]);
        let (s, _) = transition(&s, ReadinessInput::ServerTicket(ticket(1)));
        let (s, _) = transition(&s, ReadinessInput::RendererCommitted(ticket(1)));
        let (_, effects) = transition(&s, ReadinessInput::ActivationRequested);
        assert_eq!(effects, vec![ReadinessEffect::RevealMainWindow]);
    }
    #[test]
    fn stale_generation_and_old_epoch_are_inert() {
        let (s, _) = transition(
            &StartupReadiness::default(),
            ReadinessInput::Begin {
                now_ms: 1,
                timeout_ms: 10,
                dev_bypass: false,
                owned_sidecar: true,
            },
        );
        let (s, _) = transition(&s, ReadinessInput::ServerTicket(ticket(2)));
        let (s, _) = transition(&s, ReadinessInput::ServerTicket(ticket(1)));
        assert_eq!(s.ticket, Some(ticket(2)));
        let (s, _) = transition(&s, ReadinessInput::ServerLost { generation: 1 });
        assert_eq!(s.ticket, Some(ticket(2)));
        let (s, _) = transition(
            &s,
            ReadinessInput::DeadlineElapsed {
                epoch: 1,
                now_ms: 11,
            },
        );
        let (s, effects) = transition(
            &s,
            ReadinessInput::Retry {
                now_ms: 20,
                timeout_ms: 10,
            },
        );
        assert_eq!(effects, vec![ReadinessEffect::ReprobeCurrentTicket]);
        let (_, effects) = transition(
            &s,
            ReadinessInput::DeadlineElapsed {
                epoch: 1,
                now_ms: 30,
            },
        );
        assert!(effects.is_empty());
    }
    #[test]
    fn service_retry_recommits_recovery_instead_of_restarting_it() {
        let (s, _) = transition(
            &StartupReadiness::default(),
            ReadinessInput::Begin {
                now_ms: 1,
                timeout_ms: 10,
                dev_bypass: false,
                owned_sidecar: false,
            },
        );
        let (s, _) = transition(
            &s,
            ReadinessInput::DeadlineElapsed {
                epoch: 1,
                now_ms: 11,
            },
        );
        let (_, effects) = transition(
            &s,
            ReadinessInput::Retry {
                now_ms: 20,
                timeout_ms: 10,
            },
        );
        assert_eq!(effects, vec![ReadinessEffect::RecommitRecoverySurface]);
    }
    #[test]
    fn dev_bypass_reveals_immediately() {
        let (s, effects) = transition(
            &StartupReadiness::default(),
            ReadinessInput::Begin {
                now_ms: 1,
                timeout_ms: 10,
                dev_bypass: true,
                owned_sidecar: true,
            },
        );
        assert_eq!(s.phase, ReadinessPhase::Bypassed);
        assert_eq!(effects, vec![ReadinessEffect::RevealMainWindow]);
    }
    #[test]
    fn concurrent_ticket_loss_activation_and_deadline_keep_a_newer_epoch_intact() {
        use std::sync::{Arc, Barrier, Mutex};
        let state = Arc::new(Mutex::new(begin(true)));
        let barrier = Arc::new(Barrier::new(3));
        let ticket_state = Arc::clone(&state);
        let ticket_barrier = Arc::clone(&barrier);
        let ticket_thread = std::thread::spawn(move || {
            ticket_barrier.wait();
            let mut guard = ticket_state.lock().unwrap();
            let (next, _) = transition(&guard, ReadinessInput::ServerTicket(ticket(2)));
            *guard = next;
        });
        let activation_state = Arc::clone(&state);
        let activation_barrier = Arc::clone(&barrier);
        let activation_thread = std::thread::spawn(move || {
            activation_barrier.wait();
            let mut guard = activation_state.lock().unwrap();
            let (next, _) = transition(&guard, ReadinessInput::ActivationRequested);
            *guard = next;
        });
        barrier.wait();
        ticket_thread.join().unwrap();
        activation_thread.join().unwrap();
        let mut guard = state.lock().unwrap();
        let (next, _) = transition(&guard, ReadinessInput::ServerLost { generation: 1 });
        *guard = next;
        assert_eq!(guard.ticket, Some(ticket(2)));
        let (next, _) = transition(
            &guard,
            ReadinessInput::DeadlineElapsed {
                epoch: 1,
                now_ms: 11,
            },
        );
        *guard = next;
        let (next, _) = transition(
            &guard,
            ReadinessInput::Retry {
                now_ms: 20,
                timeout_ms: 10,
            },
        );
        *guard = next;
        let (next, effects) = transition(
            &guard,
            ReadinessInput::DeadlineElapsed {
                epoch: 1,
                now_ms: 30,
            },
        );
        *guard = next;
        assert!(effects.is_empty());
        assert_eq!(guard.epoch, 2);
    }
}
