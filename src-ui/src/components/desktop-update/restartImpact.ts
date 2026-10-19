import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { sameBase } from '../../hooks/useStationOutlivesApp';
import type { BundledServerStatus } from '../../platform/native/types';
import { sessionTitle } from '../../utils/sessionDisplay';

/**
 * What restarting the desktop app does to the Station server this window
 * talks to (#3851). Only a desktop-owned sidecar serving this window stops
 * with the app; an installed service and any other server keep running.
 * Anything the desktop host has not reported is `unknown`, never a guess.
 */
export type DesktopRestartServerImpact =
  | 'sidecar-restarts'
  | 'service-keeps-running'
  | 'other-server-keeps-running'
  | 'unknown';

export function desktopRestartServerImpact(input: {
  supervisesBundledServer: boolean;
  bundled: BundledServerStatus | null;
  apiBase: string;
}): DesktopRestartServerImpact {
  const { supervisesBundledServer, bundled, apiBase } = input;
  if (!supervisesBundledServer) return 'other-server-keeps-running';
  if (!bundled) return 'unknown';
  if (bundled.ownership === 'service') return 'service-keeps-running';
  if (bundled.ownership !== 'sidecar' || !bundled.apiBase) return 'unknown';
  return sameBase(bundled.apiBase, apiBase)
    ? 'sidecar-restarts'
    : 'other-server-keeps-running';
}

export interface RunningTurn {
  id: string;
  title: string;
}

/**
 * Sessions whose turn the server reports open (`hasActiveTurn`). Nothing
 * computes whether a turn could resume after a restart yet, so the dialog
 * calls every one of these interrupted.
 */
export function runningTurns(
  sessions: readonly OrchestrationSessionSummary[],
): RunningTurn[] {
  return sessions
    .filter((session) => session.hasActiveTurn === true)
    .map((session) => ({ id: session.threadId, title: sessionTitle(session) }));
}
