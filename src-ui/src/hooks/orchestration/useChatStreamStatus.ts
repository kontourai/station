import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ChatReplayState } from '../../contexts/active-chats-state';
import {
  getStreamConnectionState,
  subscribeStreamConnectionState,
} from './streamConnectionState';

/** Transport recovery is not a claim that the remote execution stopped. */
export function useChatStreamStatus(apiBase: string, replay?: ChatReplayState) {
  const state = useSyncExternalStore(
    subscribeStreamConnectionState,
    () => getStreamConnectionState(apiBase),
    () => getStreamConnectionState(apiBase),
  );
  const phase = replay ? (replay.connectionPhase ?? 'unknown') : state.phase;
  const [graceElapsed, setGraceElapsed] = useState(false);
  useEffect(() => {
    setGraceElapsed(false);
    if (replay || !['receiving', 'interrupted'].includes(phase)) return;
    const timer = setTimeout(
      () => setGraceElapsed(true),
      Math.max(0, 1_000 - (Date.now() - state.since)),
    );
    return () => clearTimeout(timer);
  }, [phase, state.since, replay]);
  const show = replay
    ? (replay.connectionElapsedMs ?? 0) >= 1_000
    : graceElapsed;
  if (phase === 'closed')
    return { label: 'Connection needs attention', blocked: true };
  if (!show) return undefined;
  if (phase === 'interrupted')
    return { label: 'Reconnecting…', blocked: false };
  if (phase === 'receiving') return { label: 'Catching up…', blocked: false };
  return undefined;
}
