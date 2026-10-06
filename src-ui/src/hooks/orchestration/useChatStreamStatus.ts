import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ChatReplayState } from '../../contexts/active-chats-state';
import {
  getStreamConnectionState,
  subscribeStreamConnectionState,
} from './streamConnectionState';

/**
 * How long an outage must last before it is shown. A dropped stream takes a
 * reconnect cycle to come back even when the network blip itself is short —
 * measured on the fake-engine render check, a 600ms drop kept the stream down
 * about 2s (the SDK's first 1s retry, the reconnect, the catch-up). This
 * absorbs one such cycle, so a phone backgrounding or switching networks does
 * not flash a status; a real outage still shows within a few seconds. Timed
 * from the outage's start (`disruptedSince`), so moving from reconnecting to
 * catching up never restarts it.
 */
const STREAM_STATUS_SHOW_AFTER_MS = 2_500;
/**
 * Once shown, the status stays up this long after the stream is live again,
 * as a brief "restored" confirmation, and a new drop inside that window is
 * shown at once instead of vanishing and reappearing.
 */
const STREAM_STATUS_HOLD_MS = 1_200;

export type ChatStreamStatus = {
  label: string;
  blocked: boolean;
  kind: 'reconnecting' | 'catching-up' | 'blocked' | 'restored';
};

/** Transport recovery is not a claim that the remote execution stopped. */
export function useChatStreamStatus(
  apiBase: string,
  replay?: ChatReplayState,
): ChatStreamStatus | undefined {
  const state = useSyncExternalStore(
    subscribeStreamConnectionState,
    () => getStreamConnectionState(apiBase),
    () => getStreamConnectionState(apiBase),
  );
  const phase = replay ? (replay.connectionPhase ?? 'unknown') : state.phase;
  const disrupted = phase === 'interrupted' || phase === 'receiving';
  // Re-render at the one moment the answer changes; no ticking.
  const [, setWake] = useState(0);
  const shownRef = useRef(false);
  const restoredUntilRef = useRef(0);
  const now = Date.now();

  let status: ChatStreamStatus | undefined;
  let wakeAt: number | undefined;
  if (phase === 'closed') {
    status = {
      label: 'Connection needs attention',
      blocked: true,
      kind: 'blocked',
    };
  } else if (replay) {
    if ((replay.connectionElapsedMs ?? 0) >= 1_000 && disrupted)
      status = disruptionStatus(phase);
  } else if (disrupted) {
    const since = state.disruptedSince ?? state.since;
    const due = since + STREAM_STATUS_SHOW_AFTER_MS;
    if (now >= due || shownRef.current || now < restoredUntilRef.current)
      status = disruptionStatus(phase);
    else wakeAt = due;
  } else if (shownRef.current || now < restoredUntilRef.current) {
    // Live again after a shown outage: confirm briefly, then clear.
    if (shownRef.current)
      restoredUntilRef.current = now + STREAM_STATUS_HOLD_MS;
    if (now < restoredUntilRef.current) {
      status = {
        label: 'Live updates restored',
        blocked: false,
        kind: 'restored',
      };
      wakeAt = restoredUntilRef.current;
    }
  }
  shownRef.current = Boolean(
    status && status.kind !== 'restored' && status.kind !== 'blocked',
  );

  useEffect(() => {
    if (wakeAt === undefined) return;
    const timer = setTimeout(
      () => setWake((tick) => tick + 1),
      Math.max(0, wakeAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [wakeAt]);
  return status;
}

function disruptionStatus(phase: string): ChatStreamStatus {
  // Names the subject: the Station itself may still be reachable (the
  // header presence dot says so) while this live-update stream is down.
  // A bare "Reconnecting" reads as contradicting that dot.
  return phase === 'interrupted'
    ? {
        label: 'Reconnecting live updates…',
        blocked: false,
        kind: 'reconnecting',
      }
    : { label: 'Catching up…', blocked: false, kind: 'catching-up' };
}
