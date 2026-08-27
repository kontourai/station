export interface TaskInputHandlerMark {
  readonly taskId: string;
  readonly workingRevision: string;
  readonly text: string;
  readonly enteredEpochMs: number;
  readonly exitedEpochMs: number;
}

export interface TaskEditorCommitMark {
  readonly taskId: string;
  readonly workingRevision: string;
  readonly text: string;
  readonly committedEpochMs: number;
}

export interface TaskDocumentApplyMark {
  readonly taskId: string;
  readonly workingRevision: string;
  readonly appliedEpochMs: number;
}

export interface DiffSurfaceCommitMark {
  readonly workingDir: string;
  readonly patchBytes: number;
  readonly fileCount: number;
  readonly committedEpochMs: number;
}

export interface FilePreviewCommitMark {
  readonly projectSlug: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly lineCount: number;
  readonly renderedLineCount: number;
  /** Present only for a reference-mode invalidation/refetch, never file data. */
  readonly refreshNonce?: string;
  readonly committedEpochMs: number;
}

export interface FilePreviewScrollMark {
  readonly projectSlug: string;
  readonly path: string;
  readonly scrollTop: number;
  readonly committedEpochMs: number;
}

export interface RoomPresenceCommitMark {
  readonly taskId: string;
  readonly viewerActorId: string;
  readonly participantActorIds: readonly string[];
  readonly committedEpochMs: number;
}

export interface RemoteCursorCommitMark {
  readonly taskId: string;
  readonly actorId: string;
  readonly workingRevision: string;
  readonly anchor: number;
  readonly focus: number;
  /** Per-sample diagnostic identity; deliberately bounded and content-free. */
  readonly sampleNonce?: string;
  readonly committedEpochMs: number;
}

export interface ReconnectStrategyMark {
  readonly taskId: string;
  readonly strategy: 'delta' | 'snapshot' | 'gap';
  readonly revision?: string;
  readonly receivedEpochMs: number;
}
export interface ReconnectCheckpointMark {
  readonly taskId: string;
  readonly id: string;
  readonly receivedEpochMs: number;
}

export type InteractiveWorkspacePerformanceProductMark =
  | { readonly kind: 'task-input'; readonly mark: TaskInputHandlerMark }
  | { readonly kind: 'task-apply'; readonly mark: TaskDocumentApplyMark }
  | { readonly kind: 'task-commit'; readonly mark: TaskEditorCommitMark }
  | { readonly kind: 'diff-commit'; readonly mark: DiffSurfaceCommitMark }
  | {
      readonly kind: 'file-preview-commit';
      readonly mark: FilePreviewCommitMark;
    }
  | {
      readonly kind: 'file-preview-scroll';
      readonly mark: FilePreviewScrollMark;
    }
  | {
      readonly kind: 'room-presence-commit';
      readonly mark: RoomPresenceCommitMark;
    }
  | {
      readonly kind: 'remote-cursor-commit';
      readonly mark: RemoteCursorCommitMark;
    }
  | {
      readonly kind: 'reconnect-strategy';
      readonly mark: ReconnectStrategyMark;
    };
const reconnectCheckpoints = new Map<string, ReconnectCheckpointMark>();

const listeners = new Set<
  (event: InteractiveWorkspacePerformanceProductMark) => void
>();
const perOperationBookkeeping = new Map<string, number>();
const taskRoomListeners = new Set<string>();
export const INTERACTIVE_WORKSPACE_STREAM_RESTART_EVENT =
  'station:performance:project-task-room-stream-restart';
export const INTERACTIVE_WORKSPACE_FILE_PREVIEW_REFRESH_EVENT =
  'station:performance:file-preview-refresh';
export const INTERACTIVE_WORKSPACE_REMOTE_CURSOR_NONCE_EVENT =
  'station:performance:remote-cursor-nonce';

export function subscribeInteractiveWorkspacePerformanceMarks(
  listener: (event: InteractiveWorkspacePerformanceProductMark) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Bounded diagnostic-only retention facts for the reference long-session run. */
export function interactiveWorkspacePerformanceRetention() {
  return {
    listeners: taskRoomListeners.size,
    perOperationBookkeeping: [...perOperationBookkeeping.values()].reduce(
      (total, count) => total + count,
      0,
    ),
  };
}

export function registerInteractiveWorkspaceTaskRoomListener(
  identity: string,
): () => void {
  taskRoomListeners.add(identity);
  return () => taskRoomListeners.delete(identity);
}

export function setInteractiveWorkspacePerformanceBookkeeping(
  taskId: string,
  count: number,
): void {
  if (Number.isSafeInteger(count) && count >= 0)
    perOperationBookkeeping.set(taskId, count);
}

export function clearInteractiveWorkspacePerformanceBookkeeping(
  taskId: string,
): void {
  perOperationBookkeeping.delete(taskId);
}

export function emitTaskInputPerformanceMark(mark: TaskInputHandlerMark): void {
  for (const listener of listeners) listener({ kind: 'task-input', mark });
}

export function emitTaskDocumentApplyPerformanceMark(
  mark: TaskDocumentApplyMark,
): void {
  for (const listener of listeners) listener({ kind: 'task-apply', mark });
}

export function emitTaskCommitPerformanceMark(
  mark: TaskEditorCommitMark,
): void {
  for (const listener of listeners) listener({ kind: 'task-commit', mark });
}

export function emitDiffCommitPerformanceMark(
  mark: DiffSurfaceCommitMark,
): void {
  for (const listener of listeners) listener({ kind: 'diff-commit', mark });
}

export function emitFilePreviewCommitPerformanceMark(
  mark: FilePreviewCommitMark,
): void {
  for (const listener of listeners)
    listener({ kind: 'file-preview-commit', mark });
}

export function emitFilePreviewScrollPerformanceMark(
  mark: FilePreviewScrollMark,
): void {
  for (const listener of listeners)
    listener({ kind: 'file-preview-scroll', mark });
}

export function emitRoomPresenceCommitPerformanceMark(
  mark: RoomPresenceCommitMark,
): void {
  for (const listener of listeners)
    listener({ kind: 'room-presence-commit', mark });
}

export function emitRemoteCursorCommitPerformanceMark(
  mark: RemoteCursorCommitMark,
): void {
  for (const listener of listeners)
    listener({ kind: 'remote-cursor-commit', mark });
}

export function emitReconnectStrategyPerformanceMark(
  mark: ReconnectStrategyMark,
): void {
  for (const listener of listeners)
    listener({ kind: 'reconnect-strategy', mark });
}
export function emitReconnectCheckpointPerformanceMark(
  mark: ReconnectCheckpointMark,
): void {
  reconnectCheckpoints.set(mark.taskId, mark);
}
export function latestReconnectCheckpoint(taskId: string) {
  return reconnectCheckpoints.get(taskId);
}

export function browserEpochMs(): number {
  return performance.timeOrigin + performance.now();
}
