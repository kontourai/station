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
    pub timeout_ms: u64,
    pub current_generation: Option<u64>,
    pub owned_sidecar: bool,
    pub ticket: Option<StartupTicket>,
    /// Native identity/recovery proof for the current readiness epoch. This is
    /// deliberately independent from renderer liveness: a page-start callback
    /// is not evidence that React mounted a usable application tree.
    pub identity_committed: bool,
    /// A post-React-layout commit from the exact main WebView.
    pub renderer_mounted: bool,
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
    /// Native host identity proof. It never implies that React mounted.
    NativeIdentityCommitted(StartupTicket),
    /// Native recovery proof for an attached/non-sidecar owner. It never
    /// implies that React mounted.
    NativeRecoveryCommitted,
    /// Compatibility renderer recovery commit; the caller is mounted.
    RecoveryUiCommitted,
    RendererPageStarted,
    RendererMounted,
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
    /// An explicit activation may make only the native-owned startup cover
    /// visible so macOS can render the ticket proof; it never reveals content.
    PresentStartupRecoverySurface,
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
            timeout_ms: 0,
            current_generation: None,
            owned_sidecar: false,
            ticket: None,
            identity_committed: false,
            renderer_mounted: false,
            reprobe_attempted: false,
            activation_pending: false,
            diagnostic_shown: false,
        }
    }
}

fn restart_readiness(next: &mut StartupReadiness, now_ms: u64, timeout_ms: u64) -> ReadinessEffect {
    next.epoch += 1;
    next.phase = ReadinessPhase::Waiting;
    next.timeout_ms = timeout_ms;
    next.deadline_ms = now_ms.saturating_add(timeout_ms);
    next.activation_pending = false;
    next.diagnostic_shown = false;
    next.identity_committed = false;
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
    }
}

fn maybe_reveal(next: &mut StartupReadiness, effects: &mut Vec<ReadinessEffect>) {
    let phase_admits = matches!(next.phase, ReadinessPhase::Waiting)
        || (!next.owned_sidecar && matches!(next.phase, ReadinessPhase::Failed));
    if phase_admits && next.identity_committed && next.renderer_mounted {
        next.phase = ReadinessPhase::Ready;
        effects.push(ReadinessEffect::RevealMainWindow);
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
            next.timeout_ms = timeout_ms;
            next.ticket = None;
            next.identity_committed = false;
            next.renderer_mounted = false;
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
                if next.ticket.as_ref() != Some(&ticket) {
                    next.identity_committed = false;
                }
                next.current_generation = Some(ticket.generation);
                next.ticket = Some(ticket);
            }
        }
        ReadinessInput::NativeIdentityCommitted(ticket) => {
            if matches!(next.phase, ReadinessPhase::Waiting)
                && next.ticket.as_ref() == Some(&ticket)
            {
                next.identity_committed = true;
                maybe_reveal(&mut next, &mut effects);
            }
        }
        ReadinessInput::NativeRecoveryCommitted => {
            if matches!(next.phase, ReadinessPhase::Waiting | ReadinessPhase::Failed)
                && !next.owned_sidecar
            {
                next.identity_committed = true;
                maybe_reveal(&mut next, &mut effects);
            }
        }
        ReadinessInput::RecoveryUiCommitted => {
            if matches!(next.phase, ReadinessPhase::Waiting | ReadinessPhase::Failed)
                && !next.owned_sidecar
            {
                next.identity_committed = true;
                next.renderer_mounted = true;
                maybe_reveal(&mut next, &mut effects);
            }
        }
        ReadinessInput::RendererPageStarted
            if !matches!(next.phase, ReadinessPhase::Ready | ReadinessPhase::Bypassed) =>
        {
            next.renderer_mounted = false;
        }
        ReadinessInput::RendererMounted
            if !matches!(next.phase, ReadinessPhase::Ready | ReadinessPhase::Bypassed) =>
        {
            next.renderer_mounted = true;
            maybe_reveal(&mut next, &mut effects);
        }
        ReadinessInput::ServerLost { generation } => {
            if matches!(next.phase, ReadinessPhase::Waiting | ReadinessPhase::Failed)
                && next.current_generation == Some(generation)
            {
                next.ticket = None;
                next.identity_committed = false;
            }
        }
        ReadinessInput::DeadlineElapsed { epoch, now_ms }
            if matches!(next.phase, ReadinessPhase::Waiting)
                && epoch == next.epoch
                && now_ms >= next.deadline_ms =>
        {
            // An activation is an explicit user request to recover an
            // initially-hidden window. Do not strand it behind a timeout
            // dialog: begin a new authenticated readiness epoch and let the
            // renderer reprobe the current exact ticket (or restart only the
            // owned sidecar when no ticket exists). No effect reveals a
            // window until a matching renderer commit arrives.
            if next.activation_pending {
                let timeout_ms = next.timeout_ms;
                // Native deadline timers measure each epoch from zero; the
                // replacement epoch must do the same or its next 30-second
                // callback would look stale before it can recover.
                effects.push(restart_readiness(&mut next, 0, timeout_ms));
            } else {
                next.phase = ReadinessPhase::Failed;
                if !next.diagnostic_shown {
                    next.diagnostic_shown = true;
                    effects.push(ReadinessEffect::ShowDiagnostic { epoch: next.epoch });
                }
            }
        }
        ReadinessInput::Retry { now_ms, timeout_ms } if next.phase == ReadinessPhase::Failed => {
            effects.push(restart_readiness(&mut next, now_ms, timeout_ms));
        }
        ReadinessInput::ActivationRequested if next.phase == ReadinessPhase::Waiting => {
            next.activation_pending = true;
            effects.push(ReadinessEffect::PresentStartupRecoverySurface);
            effects.push(ReadinessEffect::DeferActivation);
        }
        ReadinessInput::ActivationRequested if next.phase == ReadinessPhase::Failed => {
            effects.push(ReadinessEffect::PresentStartupRecoverySurface);
            effects.push(restart_readiness(&mut next, 0, 30_000));
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
    fn commit(
        state: &StartupReadiness,
        ticket: StartupTicket,
    ) -> (StartupReadiness, Vec<ReadinessEffect>) {
        let (state, mut effects) = transition(
            state,
            ReadinessInput::NativeIdentityCommitted(ticket),
        );
        let (state, mount_effects) = transition(&state, ReadinessInput::RendererMounted);
        effects.extend(mount_effects);
        (state, effects)
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
        let (s, effects) = commit(&s, ticket(2));
        assert_eq!(s.phase, ReadinessPhase::Waiting);
        assert!(effects.is_empty());
        let (s, effects) = commit(&s, ticket(1));
        assert_eq!(s.phase, ReadinessPhase::Ready);
        assert_eq!(effects, vec![ReadinessEffect::RevealMainWindow]);
    }

    #[test]
    fn native_identity_and_react_mount_are_independent_reveal_prerequisites() {
        let s = begin(true);
        let (s, _) = transition(&s, ReadinessInput::ServerTicket(ticket(1)));
        let (s, effects) = transition(&s, ReadinessInput::NativeIdentityCommitted(ticket(1)));
        assert!(s.identity_committed);
        assert!(!s.renderer_mounted);
        assert_eq!(s.phase, ReadinessPhase::Waiting);
        assert!(effects.is_empty());

        let (s, effects) = transition(&s, ReadinessInput::RendererMounted);
        assert_eq!(s.phase, ReadinessPhase::Ready);
        assert_eq!(effects, vec![ReadinessEffect::RevealMainWindow]);

        let s = begin(true);
        let (s, _) = transition(&s, ReadinessInput::ServerTicket(ticket(1)));
        let (s, effects) = transition(&s, ReadinessInput::RendererMounted);
        assert!(s.renderer_mounted);
        assert!(!s.identity_committed);
        assert!(effects.is_empty());
        let (s, effects) = transition(&s, ReadinessInput::NativeIdentityCommitted(ticket(1)));
        assert_eq!(s.phase, ReadinessPhase::Ready);
        assert_eq!(effects, vec![ReadinessEffect::RevealMainWindow]);
    }

    #[test]
    fn page_restart_and_server_loss_invalidate_only_the_prerequisite_they_own() {
        let s = begin(true);
        let (s, _) = transition(&s, ReadinessInput::ServerTicket(ticket(1)));
        let (s, _) = transition(&s, ReadinessInput::RendererMounted);
        let (s, _) = transition(&s, ReadinessInput::RendererPageStarted);
        assert!(!s.renderer_mounted);

        let (s, _) = transition(&s, ReadinessInput::NativeIdentityCommitted(ticket(1)));
        let (s, _) = transition(&s, ReadinessInput::RendererMounted);
        assert_eq!(s.phase, ReadinessPhase::Ready);
        let (s, effects) = transition(&s, ReadinessInput::RendererPageStarted);
        assert_eq!(s.phase, ReadinessPhase::Ready);
        assert!(s.renderer_mounted);
        assert!(effects.is_empty());

        let s = begin(true);
        let (s, _) = transition(&s, ReadinessInput::ServerTicket(ticket(1)));
        let (s, _) = transition(&s, ReadinessInput::RendererMounted);
        let (s, _) = transition(&s, ReadinessInput::ServerLost { generation: 1 });
        assert!(!s.identity_committed);
        assert!(s.renderer_mounted);

        let s = begin(true);
        let (s, _) = transition(&s, ReadinessInput::ServerTicket(ticket(1)));
        let (s, _) = transition(&s, ReadinessInput::NativeIdentityCommitted(ticket(1)));
        let (s, _) = transition(&s, ReadinessInput::ServerLost { generation: 1 });
        assert!(!s.identity_committed);
        assert!(!s.renderer_mounted);
    }

    #[test]
    fn native_attached_recovery_waits_for_the_react_mount() {
        let s = begin(false);
        let (s, effects) = transition(&s, ReadinessInput::NativeRecoveryCommitted);
        assert!(s.identity_committed);
        assert!(!s.renderer_mounted);
        assert!(effects.is_empty());
        let (s, effects) = transition(&s, ReadinessInput::RendererMounted);
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
        let (s, effects) = commit(&s, ticket(1));
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
        assert_eq!(
            effects,
            vec![
                ReadinessEffect::PresentStartupRecoverySurface,
                ReadinessEffect::DeferActivation,
            ]
        );
        let (s, _) = transition(&s, ReadinessInput::ServerTicket(ticket(1)));
        let (s, _) = commit(&s, ticket(1));
        let (_, effects) = transition(&s, ReadinessInput::ActivationRequested);
        assert_eq!(effects, vec![ReadinessEffect::RevealMainWindow]);
    }
    #[test]
    fn pending_activation_through_timeout_reprobes_without_revealing_unready_content() {
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
        let (s, effects) = transition(&s, ReadinessInput::ActivationRequested);
        assert_eq!(
            effects,
            vec![
                ReadinessEffect::PresentStartupRecoverySurface,
                ReadinessEffect::DeferActivation,
            ]
        );
        let (s, effects) = transition(
            &s,
            ReadinessInput::DeadlineElapsed {
                epoch: 1,
                now_ms: 11,
            },
        );
        assert_eq!(s.phase, ReadinessPhase::Waiting);
        assert_eq!(s.epoch, 2);
        assert_eq!(s.deadline_ms, 10, "the replacement epoch gets a full timeout");
        assert_eq!(
            effects,
            vec![ReadinessEffect::ReprobeCurrentTicket]
        );
        assert!(
            !effects.contains(&ReadinessEffect::RevealMainWindow),
            "a timeout recovery may only ask the renderer to prove the exact ticket"
        );
        let (_, effects) = commit(&s, ticket(1));
        assert_eq!(effects, vec![ReadinessEffect::RevealMainWindow]);
    }
    #[test]
    fn activation_after_timeout_restarts_readiness_and_rejects_stale_epoch_or_ticket() {
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
        let (s, effects) = transition(
            &s,
            ReadinessInput::DeadlineElapsed {
                epoch: 1,
                now_ms: 11,
            },
        );
        assert_eq!(effects, vec![ReadinessEffect::ShowDiagnostic { epoch: 1 }]);
        let (s, effects) = transition(&s, ReadinessInput::ActivationRequested);
        assert_eq!(s.phase, ReadinessPhase::Waiting);
        assert_eq!(s.epoch, 2);
        assert_eq!(
            effects,
            vec![
                ReadinessEffect::PresentStartupRecoverySurface,
                ReadinessEffect::ReprobeCurrentTicket,
            ]
        );
        assert!(!effects.contains(&ReadinessEffect::RevealMainWindow));

        let (s, repeated) = transition(&s, ReadinessInput::ActivationRequested);
        assert_eq!(
            repeated,
            vec![
                ReadinessEffect::PresentStartupRecoverySurface,
                ReadinessEffect::DeferActivation,
            ]
        );
        let (s, stale_deadline) = transition(
            &s,
            ReadinessInput::DeadlineElapsed {
                epoch: 1,
                now_ms: 30,
            },
        );
        assert!(stale_deadline.is_empty());
        let (s, _) = transition(&s, ReadinessInput::ServerTicket(ticket(2)));
        let (s, stale_ticket) = commit(&s, ticket(1));
        assert!(stale_ticket.is_empty());
        assert_eq!(s.phase, ReadinessPhase::Waiting);
        let (_, effects) = commit(&s, ticket(2));
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
