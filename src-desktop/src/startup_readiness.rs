//! Pure readiness authority for the desktop main window.
//!
//! Starting a sidecar is not evidence that its authenticated UI is ready.  The
//! host owns this small state machine; the renderer may only commit a ticket
//! that exactly matches the sidecar generation and identity advertised by the
//! native supervisor.
//!
//! A readiness deadline is a user-experience threshold, not a liveness
//! verdict. A cold sidecar boot can legitimately outlast it, so an elapsed
//! deadline only marks the epoch overdue and asks the host to offer recovery.
//! It never restarts a sidecar by itself, and an overdue epoch keeps accepting
//! the exact current proof so a late boot still reveals the window.

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
    /// This epoch's deadline elapsed while still waiting, and the host was
    /// asked (once) to offer the slow-start recovery choice. The phase stays
    /// `Waiting`: exact late proof is still admitted and reveals normally.
    pub overdue: bool,
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
    RendererPageStarted,
    RendererMounted,
    ServerLost {
        generation: u64,
    },
    DeadlineElapsed {
        epoch: u64,
        now_ms: u64,
    },
    /// An explicit user choice from the slow-start recovery surface shown for
    /// `epoch`. Only an overdue epoch accepts it.
    Retry {
        epoch: u64,
        now_ms: u64,
        timeout_ms: u64,
    },
    MainWindowRecreated {
        now_ms: u64,
        timeout_ms: u64,
        dev_bypass: bool,
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
    /// Offer the user Restart/Quit for this overdue epoch. Emitted at most
    /// once per epoch; it carries no process effect of its own.
    ShowSlowStartRecovery {
        epoch: u64,
    },
    /// The existing exact ticket is still current. Ask the renderer to prove
    /// it before disrupting a sidecar that may already be healthy.
    ReprobeCurrentTicket,
    /// Emitted only for an explicit user retry. A deadline alone must never
    /// kill an owned sidecar that may still be booting.
    RestartOwnedSidecar,
    RecommitRecoverySurface,
    Exit,
}

/// What the native startup cover should show for a readiness state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartupCoverContent {
    Waiting,
    Overdue { epoch: u64 },
}

/// The cover content for the current state, or `None` once the window has
/// been admitted (startup readiness never re-covers a ready window).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn startup_cover_content(state: &StartupReadiness) -> Option<StartupCoverContent> {
    match state.phase {
        ReadinessPhase::Waiting if state.overdue => {
            Some(StartupCoverContent::Overdue { epoch: state.epoch })
        }
        ReadinessPhase::Waiting => Some(StartupCoverContent::Waiting),
        ReadinessPhase::Ready | ReadinessPhase::Bypassed => None,
    }
}

/// Whether a Quit/Exit chosen on the recovery surface for `epoch` still
/// applies. A late reveal or a newer epoch makes that earlier choice inert.
pub fn overdue_for_epoch(state: &StartupReadiness, epoch: u64) -> bool {
    state.phase == ReadinessPhase::Waiting && state.overdue && state.epoch == epoch
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
            overdue: false,
        }
    }
}

fn restart_readiness(next: &mut StartupReadiness, now_ms: u64, timeout_ms: u64) -> ReadinessEffect {
    next.epoch += 1;
    next.phase = ReadinessPhase::Waiting;
    next.timeout_ms = timeout_ms;
    next.deadline_ms = now_ms.saturating_add(timeout_ms);
    next.overdue = false;
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
    let phase_admits = matches!(next.phase, ReadinessPhase::Waiting);
    if phase_admits && next.identity_committed && next.renderer_mounted {
        next.phase = ReadinessPhase::Ready;
        effects.push(ReadinessEffect::RevealMainWindow);
        next.overdue = false;
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
            next.overdue = false;
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
            // Overdue is still Waiting: a sidecar that outlived the deadline
            // can publish its ticket and reveal without user action.
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
            if matches!(next.phase, ReadinessPhase::Waiting) && !next.owned_sidecar {
                next.identity_committed = true;
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
            if matches!(next.phase, ReadinessPhase::Waiting)
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
            // The deadline only measures how long the user has waited. It is
            // not evidence that the sidecar is unhealthy: a cold boot can take
            // longer, and killing it here restarts the same slow boot forever
            // (observed on a 30-40 s host). Mark the epoch overdue, offer the
            // recovery choice once, and keep admitting the exact late proof.
            if !next.overdue {
                next.overdue = true;
                effects.push(ReadinessEffect::ShowSlowStartRecovery { epoch: next.epoch });
            }
        }
        ReadinessInput::Retry {
            epoch,
            now_ms,
            timeout_ms,
        } if overdue_for_epoch(&next, epoch) => {
            // Explicit user choice: reprobe a current ticket first, otherwise
            // restart only the owned sidecar (never a durable service).
            effects.push(restart_readiness(&mut next, now_ms, timeout_ms));
        }
        ReadinessInput::MainWindowRecreated {
            now_ms,
            timeout_ms,
            dev_bypass,
        } => {
            next.epoch += 1;
            next.phase = if dev_bypass {
                ReadinessPhase::Bypassed
            } else {
                ReadinessPhase::Waiting
            };
            next.deadline_ms = now_ms.saturating_add(timeout_ms);
            next.timeout_ms = timeout_ms;
            next.identity_committed = false;
            next.renderer_mounted = false;
            next.reprobe_attempted = false;
            next.overdue = false;
        }
        ReadinessInput::ActivationRequested if next.phase == ReadinessPhase::Waiting => {
            // Activation is a request to see the app, not to restart it. The
            // cover shows waiting or overdue recovery content; proof still
            // owns the reveal.
            effects.push(ReadinessEffect::PresentStartupRecoverySurface);
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
    fn commit(
        state: &StartupReadiness,
        ticket: StartupTicket,
    ) -> (StartupReadiness, Vec<ReadinessEffect>) {
        let (state, mut effects) =
            transition(state, ReadinessInput::NativeIdentityCommitted(ticket));
        let (state, mount_effects) = transition(&state, ReadinessInput::RendererMounted);
        effects.extend(mount_effects);
        (state, effects)
    }
    fn deadline(state: &StartupReadiness, epoch: u64) -> (StartupReadiness, Vec<ReadinessEffect>) {
        transition(state, ReadinessInput::DeadlineElapsed { epoch, now_ms: 11 })
    }
    fn retry(state: &StartupReadiness, epoch: u64) -> (StartupReadiness, Vec<ReadinessEffect>) {
        transition(
            state,
            ReadinessInput::Retry {
                epoch,
                now_ms: 20,
                timeout_ms: 10,
            },
        )
    }
    fn is_process_effect(effect: &ReadinessEffect) -> bool {
        matches!(
            effect,
            ReadinessEffect::RestartOwnedSidecar | ReadinessEffect::ReprobeCurrentTicket
        )
    }

    #[test]
    fn commits_only_the_exact_ticket() {
        let s = begin(true);
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

    /// A1. The observed defect: a 30-40 s cold boot was killed at every 30 s
    /// deadline, so startup looped forever. The deadline must not restart a
    /// sidecar that has not published a ticket, with or without a pending
    /// activation.
    #[test]
    fn deadline_without_a_ticket_never_restarts_the_owned_sidecar() {
        for activation_requested in [false, true] {
            let mut s = begin(true);
            if activation_requested {
                let (next, effects) = transition(&s, ReadinessInput::ActivationRequested);
                assert_eq!(
                    effects,
                    vec![
                        ReadinessEffect::PresentStartupRecoverySurface,
                        ReadinessEffect::DeferActivation,
                    ]
                );
                s = next;
            }
            let (s, effects) = deadline(&s, 1);
            assert_eq!(
                effects,
                vec![ReadinessEffect::ShowSlowStartRecovery { epoch: 1 }],
                "activation_requested={activation_requested}: a deadline only offers recovery"
            );
            assert!(
                !effects.iter().any(is_process_effect),
                "activation_requested={activation_requested}: a deadline must never restart or reprobe"
            );
            assert_eq!(s.epoch, 1, "a deadline does not start a replacement epoch");
            assert_eq!(s.phase, ReadinessPhase::Waiting);
            assert!(s.overdue);
            assert_eq!(
                startup_cover_content(&s),
                Some(StartupCoverContent::Overdue { epoch: 1 })
            );

            // Activating an overdue launch re-presents the recovery surface;
            // it is not a restart request either.
            let (s, effects) = transition(&s, ReadinessInput::ActivationRequested);
            assert_eq!(
                effects,
                vec![
                    ReadinessEffect::PresentStartupRecoverySurface,
                    ReadinessEffect::DeferActivation,
                ]
            );
            let (_, repeated) = deadline(&s, 1);
            assert!(repeated.is_empty(), "one recovery offer per epoch");
        }
    }

    /// A2. A sidecar that publishes after the deadline still reveals the
    /// window without user action, and the recovery surface goes away.
    #[test]
    fn late_ticket_after_the_deadline_reveals_after_identity_and_mount() {
        let s = begin(true);
        let (s, _) = transition(&s, ReadinessInput::ActivationRequested);
        let (s, _) = transition(&s, ReadinessInput::RendererPageStarted);
        let (s, _) = transition(&s, ReadinessInput::RendererMounted);
        let (s, effects) = deadline(&s, 1);
        assert_eq!(
            effects,
            vec![ReadinessEffect::ShowSlowStartRecovery { epoch: 1 }]
        );
        assert!(overdue_for_epoch(&s, 1));

        let (s, _) = transition(&s, ReadinessInput::ServerTicket(ticket(1)));
        assert_eq!(
            s.ticket,
            Some(ticket(1)),
            "an overdue epoch admits the late ticket"
        );
        let (s, effects) = transition(&s, ReadinessInput::NativeIdentityCommitted(ticket(1)));
        assert_eq!(s.phase, ReadinessPhase::Ready);
        assert_eq!(effects, vec![ReadinessEffect::RevealMainWindow]);
        assert_eq!(
            startup_cover_content(&s),
            None,
            "a ready window is never re-covered"
        );
        assert!(
            !overdue_for_epoch(&s, 1),
            "a Quit chosen on the stale recovery surface must not exit a revealed app"
        );
        let (_, retry_effects) = retry(&s, 1);
        assert!(retry_effects.is_empty(), "Restart after reveal is inert");

        // The same holds when the mount arrives last.
        let s = begin(true);
        let (s, _) = deadline(&s, 1);
        let (s, _) = transition(&s, ReadinessInput::ServerTicket(ticket(1)));
        let (s, effects) = commit(&s, ticket(1));
        assert_eq!(s.phase, ReadinessPhase::Ready);
        assert_eq!(effects, vec![ReadinessEffect::RevealMainWindow]);
    }

    /// A3. An explicit user Restart with no ticket restarts only the owned
    /// sidecar; one recovery offer per epoch.
    #[test]
    fn retry_without_a_ticket_restarts_the_owned_sidecar_once_per_overdue_epoch() {
        let s = begin(true);
        let (_, early) = retry(&s, 1);
        assert!(
            early.is_empty(),
            "Restart is accepted only from an overdue epoch"
        );
        let (s, effects) = deadline(&s, 1);
        assert_eq!(
            effects,
            vec![ReadinessEffect::ShowSlowStartRecovery { epoch: 1 }]
        );
        let (_, stale) = retry(&s, 0);
        assert!(stale.is_empty(), "a choice for another epoch is inert");
        let (s, effects) = retry(&s, 1);
        assert_eq!(s.epoch, 2);
        assert_eq!(s.phase, ReadinessPhase::Waiting);
        assert!(!s.overdue);
        assert_eq!(effects, vec![ReadinessEffect::RestartOwnedSidecar]);
        assert_eq!(
            startup_cover_content(&s),
            Some(StartupCoverContent::Waiting)
        );
        let (_, doubled) = retry(&s, 1);
        assert!(
            doubled.is_empty(),
            "a second click for the old epoch is inert"
        );
    }

    /// A3. With a current ticket, an explicit retry reprobes first.
    #[test]
    fn retry_reprobes_a_current_ticket_before_restarting_an_owned_sidecar() {
        let s = begin(true);
        let (s, _) = transition(&s, ReadinessInput::ServerTicket(ticket(1)));
        let (s, _) = deadline(&s, 1);
        let (s, effects) = retry(&s, 1);
        assert_eq!(effects, vec![ReadinessEffect::ReprobeCurrentTicket]);
        assert_eq!(s.ticket, Some(ticket(1)));
        let (s, effects) = commit(&s, ticket(1));
        assert_eq!(s.phase, ReadinessPhase::Ready);
        assert_eq!(effects, vec![ReadinessEffect::RevealMainWindow]);
    }

    #[test]
    fn unsuccessful_reprobe_escalates_to_an_owned_sidecar_restart_on_the_next_retry() {
        let s = begin(true);
        let (s, _) = transition(&s, ReadinessInput::ServerTicket(ticket(1)));
        let (s, _) = deadline(&s, 1);
        let (s, effects) = retry(&s, 1);
        assert_eq!(effects, vec![ReadinessEffect::ReprobeCurrentTicket]);
        let (s, effects) = transition(
            &s,
            ReadinessInput::DeadlineElapsed {
                epoch: 2,
                now_ms: 30,
            },
        );
        assert_eq!(
            effects,
            vec![ReadinessEffect::ShowSlowStartRecovery { epoch: 2 }],
            "the reprobe deadline also only offers recovery"
        );
        let (s, effects) = retry(&s, 2);
        assert_eq!(effects, vec![ReadinessEffect::RestartOwnedSidecar]);
        assert!(s.ticket.is_none());
    }

    #[test]
    fn loss_after_the_deadline_clears_the_ticket_and_blocks_its_late_commit() {
        let s = begin(true);
        let (s, _) = transition(&s, ReadinessInput::ServerTicket(ticket(1)));
        let (s, _) = transition(&s, ReadinessInput::RendererMounted);
        let (s, _) = deadline(&s, 1);
        let (s, _) = transition(&s, ReadinessInput::ServerLost { generation: 1 });
        assert!(s.ticket.is_none());
        assert!(!s.identity_committed);
        let (lost, effects) = transition(&s, ReadinessInput::NativeIdentityCommitted(ticket(1)));
        assert!(
            effects.is_empty(),
            "a lost ticket cannot reveal after the deadline"
        );
        assert_eq!(lost.phase, ReadinessPhase::Waiting);
        let (_, effects) = retry(&s, 1);
        assert_eq!(effects, vec![ReadinessEffect::RestartOwnedSidecar]);

        // A supervised respawn's newer ticket still reveals the overdue epoch.
        let (s, _) = transition(&s, ReadinessInput::ServerTicket(ticket(2)));
        let (s, effects) = transition(&s, ReadinessInput::NativeIdentityCommitted(ticket(2)));
        assert_eq!(s.phase, ReadinessPhase::Ready);
        assert_eq!(effects, vec![ReadinessEffect::RevealMainWindow]);
    }

    #[test]
    fn loss_invalidates_pending_ticket_and_activation_defers_but_post_ready_does_not_rehide() {
        let s = begin(true);
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
    fn activation_after_timeout_presents_recovery_and_rejects_stale_epoch_or_ticket() {
        let s = begin(true);
        let (s, _) = transition(&s, ReadinessInput::ServerTicket(ticket(1)));
        let (s, effects) = deadline(&s, 1);
        assert_eq!(
            effects,
            vec![ReadinessEffect::ShowSlowStartRecovery { epoch: 1 }]
        );
        let (s, effects) = transition(&s, ReadinessInput::ActivationRequested);
        assert_eq!(s.epoch, 1);
        assert_eq!(
            effects,
            vec![
                ReadinessEffect::PresentStartupRecoverySurface,
                ReadinessEffect::DeferActivation,
            ]
        );
        assert!(!effects.contains(&ReadinessEffect::RevealMainWindow));

        let (s, _) = retry(&s, 1);
        assert_eq!(s.epoch, 2);
        let (s, stale_deadline) = transition(
            &s,
            ReadinessInput::DeadlineElapsed {
                epoch: 1,
                now_ms: 30,
            },
        );
        assert!(stale_deadline.is_empty());
        assert!(!s.overdue);
        let (s, _) = transition(&s, ReadinessInput::ServerTicket(ticket(2)));
        let (s, stale_ticket) = commit(&s, ticket(1));
        assert!(stale_ticket.is_empty());
        assert_eq!(s.phase, ReadinessPhase::Waiting);
        let (_, effects) = commit(&s, ticket(2));
        assert_eq!(effects, vec![ReadinessEffect::RevealMainWindow]);
    }

    #[test]
    fn stale_generation_and_old_epoch_are_inert() {
        let s = begin(true);
        let (s, _) = transition(&s, ReadinessInput::ServerTicket(ticket(2)));
        let (s, _) = transition(&s, ReadinessInput::ServerTicket(ticket(1)));
        assert_eq!(s.ticket, Some(ticket(2)));
        let (s, _) = transition(&s, ReadinessInput::ServerLost { generation: 1 });
        assert_eq!(s.ticket, Some(ticket(2)));
        let (s, early) = transition(
            &s,
            ReadinessInput::DeadlineElapsed {
                epoch: 1,
                now_ms: 10,
            },
        );
        assert!(early.is_empty(), "a deadline before its instant is inert");
        let (s, _) = deadline(&s, 1);
        let (s, effects) = retry(&s, 1);
        assert_eq!(effects, vec![ReadinessEffect::ReprobeCurrentTicket]);
        let (s, effects) = transition(
            &s,
            ReadinessInput::DeadlineElapsed {
                epoch: 1,
                now_ms: 30,
            },
        );
        assert!(
            effects.is_empty(),
            "the superseded epoch's deadline is ignored"
        );
        assert!(!s.overdue);
    }

    #[test]
    fn service_retry_recommits_recovery_instead_of_restarting_it() {
        let s = begin(false);
        let (s, effects) = deadline(&s, 1);
        assert_eq!(
            effects,
            vec![ReadinessEffect::ShowSlowStartRecovery { epoch: 1 }]
        );
        let (s, effects) = retry(&s, 1);
        assert_eq!(effects, vec![ReadinessEffect::RecommitRecoverySurface]);

        // An overdue non-owned launch still admits its recovery surface.
        let (s, _) = transition(
            &s,
            ReadinessInput::DeadlineElapsed {
                epoch: 2,
                now_ms: 30,
            },
        );
        assert!(overdue_for_epoch(&s, 2));
        let (s, _) = transition(&s, ReadinessInput::NativeRecoveryCommitted);
        let (_, effects) = transition(&s, ReadinessInput::RendererMounted);
        assert_eq!(effects, vec![ReadinessEffect::RevealMainWindow]);
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
        assert_eq!(startup_cover_content(&s), None);
        let (_, effects) = deadline(&s, 1);
        assert!(
            effects.is_empty(),
            "the dev bypass never reaches slow-start recovery"
        );
    }

    #[test]
    fn recreated_main_window_must_reprove_identity_and_renderer_mount() {
        let s = begin(true);
        let (s, _) = transition(&s, ReadinessInput::ServerTicket(ticket(1)));
        let (s, _) = commit(&s, ticket(1));
        assert_eq!(s.phase, ReadinessPhase::Ready);

        let (s, effects) = transition(
            &s,
            ReadinessInput::MainWindowRecreated {
                now_ms: 20,
                timeout_ms: 30,
                dev_bypass: false,
            },
        );
        assert!(effects.is_empty());
        assert_eq!(s.phase, ReadinessPhase::Waiting);
        assert_eq!(s.epoch, 2);
        assert_eq!(s.ticket, Some(ticket(1)));
        assert!(!s.identity_committed);
        assert!(!s.renderer_mounted);
        let (s, deferred) = transition(&s, ReadinessInput::ActivationRequested);
        assert!(deferred.contains(&ReadinessEffect::DeferActivation));
        let (_, reveal) = commit(&s, ticket(1));
        assert_eq!(reveal, vec![ReadinessEffect::RevealMainWindow]);
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
        let (next, _) = deadline(&guard, 1);
        *guard = next;
        let (next, _) = retry(&guard, 1);
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
