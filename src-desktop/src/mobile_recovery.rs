use std::collections::VecDeque;
use std::time::Duration;

#[derive(Default)]
pub(crate) struct RendererRecovery {
    attempts: VecDeque<Duration>,
    pending: bool,
}
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RecoveryAction {
    Deferred,
    Reload,
    ShowError,
}
impl RendererRecovery {
    pub(crate) fn terminated(&mut self, now: Duration, foreground: bool) -> RecoveryAction {
        self.pending = true;
        if foreground {
            self.foreground(now)
        } else {
            RecoveryAction::Deferred
        }
    }
    pub(crate) fn foreground(&mut self, now: Duration) -> RecoveryAction {
        if !self.pending {
            return RecoveryAction::Deferred;
        }
        self.pending = false;
        while self
            .attempts
            .front()
            .is_some_and(|at| now.saturating_sub(*at) >= Duration::from_secs(60))
        {
            self.attempts.pop_front();
        }
        if self.attempts.len() >= 3 {
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
    fn renderer_death_defers_in_background_and_stops_after_three_foreground_reloads() {
        let mut state = RendererRecovery::default();
        for second in 0..3 {
            assert_eq!(
                state.terminated(Duration::from_secs(second), false),
                RecoveryAction::Deferred
            );
            assert_eq!(
                state.foreground(Duration::from_secs(second)),
                RecoveryAction::Reload
            );
            assert_eq!(
                state.foreground(Duration::from_secs(second)),
                RecoveryAction::Deferred
            );
        }
        assert_eq!(
            state.terminated(Duration::from_secs(3), true),
            RecoveryAction::ShowError
        );
        assert_eq!(
            state.terminated(Duration::from_secs(60), true),
            RecoveryAction::Reload
        );
    }
}
