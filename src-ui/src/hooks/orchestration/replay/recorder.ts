import {
  attachReplayCapture,
  currentReplayCaptureHistory,
} from './capture-tap';

export { publishHistoryForCapture } from './capture-tap';

import { activeChatsStore } from '../../../contexts/active-chats-store';
import type {
  OrchestrationEvent,
  OrchestrationSnapshotPayload,
} from '../types';
import type { ReplayHistoryState } from './history';
import { isReplayThread } from './replay-registry';
import {
  type ReplayFrame,
  SESSION_TAPE_KIND,
  type SessionTape,
  type SessionTapeSource,
} from './tape';

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_CAPTURE_FRAMES = 20_000;
const listeners = new Set<() => void>();
let recording: {
  apiBase: string;
  source: SessionTapeSource;
  tape: SessionTape;
  startedAt: number;
  bytes: number;
} | null = null;
let latestTape: SessionTape | null = null;
let status: {
  recording: boolean;
  sourceThreadId?: string;
  stoppedReason?: string;
} = { recording: false };

function publish() {
  for (const listener of listeners) listener();
}
export function subscribeReplayCapture(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function getReplayCaptureStatus() {
  return status;
}
export function getCapturedTape() {
  return latestTape;
}

export function startReplayCapture(
  apiBase: string,
  source: SessionTapeSource,
): void {
  if (isReplayThread(source.threadId))
    throw new Error('Record the live conversation, not a replay.');
  if (recording) stopReplayCapture();
  const chat = activeChatsStore.getChatForExecutionSession(source.threadId);
  const initialChat = chat
    ? {
        messages: chat.messages,
        streamingMessage: chat.streamingMessage,
        status: chat.status,
        orchestrationStatus: chat.orchestrationStatus,
        orchestrationTurnOpen: chat.orchestrationTurnOpen,
        openTurnId: chat.openTurnId,
        openTurnShellSuperseded: chat.openTurnShellSuperseded,
        activityHint: chat.activityHint,
        model: chat.model,
        provider: chat.provider,
        orchestrationSessionStarted: chat.orchestrationSessionStarted,
      }
    : undefined;
  const tape: SessionTape = structuredClone({
    schemaVersion: 1,
    kind: SESSION_TAPE_KIND,
    recordedAt: new Date().toISOString(),
    source,
    events: [],
    frames: [],
    coverage: 'client-capture',
    initialChat,
    initialHistory: currentReplayCaptureHistory(
      apiBase,
      source.conversationId ?? source.threadId,
    ),
  });
  const bytes = new TextEncoder().encode(JSON.stringify(tape)).length;
  if (bytes > MAX_CAPTURE_BYTES)
    throw new Error(
      'The initial conversation exceeds the 16 MiB capture limit.',
    );
  recording = { apiBase, source, tape, bytes, startedAt: performance.now() };
  attachReplayCapture({
    runtime: recordReplayRuntime,
    history: captureHistory,
    connection: recordReplayConnection,
    snapshot: recordReplaySnapshot,
  });
  latestTape = tape;
  status = { recording: true, sourceThreadId: source.threadId };
  publish();
}

export function stopReplayCapture(reason?: string): SessionTape | null {
  if (recording) {
    if (reason) recording.tape.stoppedReason = reason;
    latestTape = recording.tape;
  }
  recording = null;
  attachReplayCapture(null);
  status = { recording: false, ...(reason ? { stoppedReason: reason } : {}) };
  publish();
  return latestTape;
}

type ReplayFrameInput = ReplayFrame extends infer Frame
  ? Frame extends ReplayFrame
    ? Omit<Frame, 'atMs'>
    : never
  : never;
function append(frame: ReplayFrameInput): void {
  const capture = recording;
  if (!capture) return;
  const value = { ...frame, atMs: performance.now() - capture.startedAt };
  const encoded = JSON.stringify(value);
  const bytes = new TextEncoder().encode(encoded).length;
  if (
    capture.bytes + bytes > MAX_CAPTURE_BYTES ||
    capture.tape.frames!.length >= MAX_CAPTURE_FRAMES
  ) {
    stopReplayCapture(
      'Capture stopped at its 16 MiB / 20,000 frame limit; later activity is not included.',
    );
    return;
  }
  capture.bytes += bytes;
  capture.tape.frames!.push(JSON.parse(encoded) as ReplayFrame);
}

export function recordReplayRuntime(
  apiBase: string,
  event: OrchestrationEvent,
  provenance?: unknown,
): void {
  if (
    !recording ||
    recording.apiBase !== apiBase ||
    recording.source.threadId !== event.threadId
  )
    return;
  append({ kind: 'runtime', event, provenance });
}

/** Only one current reader reference is retained; no event cloning when capture is off. */
function captureHistory(
  apiBase: string,
  threadId: string,
  state: ReplayHistoryState,
): void {
  if (
    !recording ||
    recording.apiBase !== apiBase ||
    ![recording.source.threadId, recording.source.conversationId].includes(
      threadId,
    )
  )
    return;
  append({ kind: 'history', state });
}
export function recordReplayConnection(
  apiBase: string,
  connection: 'receiving' | 'interrupted' | 'closed' | 'caught-up',
): void {
  if (!recording || recording.apiBase !== apiBase) return;
  append({ kind: 'connection', status: connection });
}
export function recordReplaySnapshot(
  apiBase: string,
  payload: OrchestrationSnapshotPayload,
  reconnect: boolean,
): void {
  if (!recording || recording.apiBase !== apiBase) return;
  append({
    kind: 'snapshot',
    payload: {
      ...payload,
      sessions: payload.sessions.filter(
        (session) => session.threadId === recording!.source.threadId,
      ),
    },
    reconnect,
  });
}
