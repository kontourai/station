import type {
  OrchestrationEvent,
  OrchestrationSnapshotPayload,
} from '../types';
import type { ReplayHistoryState } from './history';

interface CaptureSink {
  runtime(
    apiBase: string,
    event: OrchestrationEvent,
    provenance?: unknown,
  ): void;
  history(apiBase: string, threadId: string, state: ReplayHistoryState): void;
  connection(
    apiBase: string,
    status: 'receiving' | 'interrupted' | 'closed' | 'caught-up',
  ): void;
  snapshot(
    apiBase: string,
    payload: OrchestrationSnapshotPayload,
    reconnect: boolean,
  ): void;
}
let sink: CaptureSink | null = null;
const readers = new Map<string, ReplayHistoryState>();
export function attachReplayCapture(next: CaptureSink | null) {
  sink = next;
}
export function currentReplayCaptureHistory(apiBase: string, threadId: string) {
  return readers.get(`${apiBase}\0${threadId}`);
}
export function recordReplayRuntime(
  apiBase: string,
  event: OrchestrationEvent,
  provenance?: unknown,
) {
  sink?.runtime(apiBase, event, provenance);
}
export function recordReplayConnection(
  apiBase: string,
  status: 'receiving' | 'interrupted' | 'closed' | 'caught-up',
) {
  sink?.connection(apiBase, status);
}
export function recordReplaySnapshot(
  apiBase: string,
  payload: OrchestrationSnapshotPayload,
  reconnect: boolean,
) {
  sink?.snapshot(apiBase, payload, reconnect);
}
export function publishHistoryForCapture(
  apiBase: string,
  threadId: string,
  state: ReplayHistoryState,
) {
  readers.set(`${apiBase}\0${threadId}`, state);
  sink?.history(apiBase, threadId, state);
}
export function removeHistoryForCapture(apiBase: string, threadId: string) {
  readers.delete(`${apiBase}\0${threadId}`);
}
