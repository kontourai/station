use std::collections::VecDeque;
use std::time::{Duration, Instant};

#[derive(Default)]
pub(crate) struct RendererRecovery {
    attempts: VecDeque<Instant>,
    pending: bool,
    error_shown: bool,
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RecoveryAction {
    Deferred,
    Reload,
    ShowError,
}
impl RendererRecovery {
    pub(crate) fn terminated(&mut self, now: Instant, foreground: bool) -> RecoveryAction {
        self.pending = true;
        if foreground {
            self.foreground(now)
        } else {
            RecoveryAction::Deferred
        }
    }
    pub(crate) fn foreground(&mut self, now: Instant) -> RecoveryAction {
        if !self.pending {
            return RecoveryAction::Deferred;
        }
        self.pending = false;
        while self
            .attempts
            .front()
            .is_some_and(|at| now.saturating_duration_since(*at) >= Duration::from_secs(60))
        {
            self.attempts.pop_front();
        }
        if self.error_shown {
            RecoveryAction::Deferred
        } else if self.attempts.len() >= 3 {
            self.error_shown = true;
            RecoveryAction::ShowError
        } else {
            self.attempts.push_back(now);
            RecoveryAction::Reload
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_window_expires_on_monotonic_elapsed_time() {
        let mut state = RendererRecovery::default();
        let start = Instant::now();
        for second in 0..3 {
            assert_eq!(
                state.terminated(start + Duration::from_secs(second), true),
                RecoveryAction::Reload
            );
        }
        assert_eq!(
            state.terminated(start + Duration::from_secs(60), true),
            RecoveryAction::Reload
        );
    }
    #[test]
    fn renderer_death_defers_in_background_and_stops_after_three_foreground_reloads() {
        let mut state = RendererRecovery::default();
        let start = Instant::now();
        for second in 0..3 {
            assert_eq!(
                state.terminated(start + Duration::from_secs(second), false),
                RecoveryAction::Deferred
            );
            assert_eq!(
                state.foreground(start + Duration::from_secs(second)),
                RecoveryAction::Reload
            );
            assert_eq!(
                state.foreground(start + Duration::from_secs(second)),
                RecoveryAction::Deferred
            );
        }
        assert_eq!(
            state.terminated(start + Duration::from_secs(3), true),
            RecoveryAction::ShowError
        );
        for second in [4, 5, 60] {
            assert_eq!(
                state.terminated(start + Duration::from_secs(second), true),
                RecoveryAction::Deferred
            );
        }
        // An explicit Reload replaces this state, rather than stacking alerts.
        state = RendererRecovery::default();
        assert_eq!(
            state.terminated(start + Duration::from_secs(60), true),
            RecoveryAction::Reload
        );
    }
}
