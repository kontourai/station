import { useEffect } from 'react';
import {
  firstRunDockNudge,
  markDockFirstRunSeen,
  shouldOpenDockForFirstRun,
} from './chat-dock-utils';

/**
 * First-run nudge: surface the chat dock once so a new user discovers the
 * primary surface (skipped for automated/e2e sessions -- see
 * `shouldOpenDockForFirstRun`). The localStorage flag, not the deps, is
 * what makes this fire once; re-runs are a no-op once the flag is set.
 *
 * #2151: the nudge waits for the inbox to be KNOWN and opens only when it
 * holds something -- `firstRunDockNudge` is the decision, this hook applies
 * it. It only ever moves the dock toward open: a dock the user opened
 * (`dock=open`, ⌘D) is never closed here.
 */
export function useFirstRunDockNudge(input: {
  isFullscreenPlacement: boolean;
  sessionsStatus: 'pending' | 'success' | 'error';
  sessionCount: number;
  isDockOpen: boolean;
  setDockState: (open: boolean) => void;
}): void {
  const {
    isFullscreenPlacement,
    sessionsStatus,
    sessionCount,
    isDockOpen,
    setDockState,
  } = input;
  useEffect(() => {
    const decision = firstRunDockNudge({
      isFullscreenPlacement,
      sessionsStatus,
      sessionCount,
      firstRunPending: shouldOpenDockForFirstRun(),
    });
    if (decision === 'wait' || decision === 'skip') return;
    markDockFirstRunSeen();
    if (decision === 'open' && !isDockOpen) setDockState(true);
  }, [
    isFullscreenPlacement,
    sessionsStatus,
    sessionCount,
    isDockOpen,
    setDockState,
  ]);
}
