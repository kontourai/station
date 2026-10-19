import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
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

/** An API base as protocol, host and port, with every loopback name equal. */
function endpointOf(base: string): { key: string; loopback: boolean } | null {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback =
    host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  const path = url.pathname.replace(/\/+$/, '');
  return {
    key: `${url.protocol}//${loopback ? 'loopback' : host}:${port}${path}`,
    loopback,
  };
}

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
  const sidecar = endpointOf(bundled.apiBase);
  const window = endpointOf(apiBase);
  if (!sidecar || !window) return 'unknown';
  if (sidecar.key === window.key) return 'sidecar-restarts';
  // Only a server that is plainly elsewhere keeps running. Another
  // loopback address could still be this app's own server behind a proxy
  // or forward, so it is not called safe.
  return window.loopback ? 'unknown' : 'other-server-keeps-running';
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
