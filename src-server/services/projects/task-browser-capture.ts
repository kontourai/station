import type {
  TaskCapture,
  TaskReviewCreateCaptureRequest,
  TaskReviewRefusalCode,
} from '@kontourai/station-contracts/task-review';
import {
  BrowserSessionError,
  type BrowserSessionRecord,
  type BrowserSessionRegistry,
  redactBrowserUrl,
} from '../browser/browser-session-registry.js';
import type { TaskReviewAccess } from '../orchestration/project-task-room-runtime.js';
import type { TaskReviewStore } from '../orchestration/task-review-store.js';
import {
  type TaskCaptureBlobStore,
  TaskCaptureBlobStoreError,
} from './task-capture-blob-store.js';
import type { TaskGraphService } from './task-graph-service.js';
import {
  pinWorkspace,
  WorkspaceCommitPinError,
} from './workspace-commit-pin.js';

export type TaskCaptureBrowserRegistry = Pick<
  BrowserSessionRegistry,
  'getSession' | 'listSessions' | 'captureScreenshot'
>;
export class TaskBrowserCaptureError extends Error {
  constructor(
    readonly code: TaskReviewRefusalCode | 'workspace-unobservable',
    message: string,
  ) {
    super(message);
  }
}

/** Owns the clean-workspace observation, immutable bytes and Task metadata publication. */
export class TaskBrowserCapture {
  constructor(
    private readonly deps: {
      store: TaskReviewStore;
      taskGraph: Pick<TaskGraphService, 'readTaskForOpen'>;
      blobs(): TaskCaptureBlobStore;
    },
  ) {}

  private current(access: TaskReviewAccess) {
    if (!access.write.beforeCommit())
      throw new TaskBrowserCaptureError('not-found', 'Task not found.');
  }

  private async workspace(access: TaskReviewAccess) {
    const task = await this.deps.taskGraph.readTaskForOpen(access.write.taskId);
    if (
      !task ||
      task.createdAt !== access.write.taskCreatedAt ||
      task.projectId !== access.write.projectId
    )
      throw new TaskBrowserCaptureError('not-found', 'Task not found.');
    if (
      task.workspaceBinding?.availability !== 'available' ||
      !task.workspaceBinding.workingDirectory
    )
      throw new TaskBrowserCaptureError(
        'workspace-unobservable',
        'The Task workspace is unavailable.',
      );
    return task.workspaceBinding.workingDirectory;
  }

  private async cleanPin(workspace: string) {
    const pin = await pinWorkspace(workspace);
    if (pin.submodules === 'unobserved')
      throw new TaskBrowserCaptureError(
        'workspace-unobservable',
        'Submodule contents cannot be observed.',
      );
    if (!pin.clean)
      throw new TaskBrowserCaptureError(
        'workspace-changed',
        'Commit workspace changes before capturing.',
      );
    return pin;
  }

  async capture(
    access: TaskReviewAccess,
    input: Omit<TaskReviewCreateCaptureRequest, 'sourceSessionId'> & {
      sourceSessionId?: string;
    },
    registry: TaskCaptureBrowserRegistry,
    allows: (session: BrowserSessionRecord) => boolean,
  ) {
    try {
      this.current(access);
      const eligible = (session: BrowserSessionRecord) =>
        session.projectId === access.write.projectId &&
        session.state === 'live' &&
        allows(session);
      const choices =
        input.sourceSessionId === undefined
          ? registry.listSessions(eligible)
          : [];
      const session =
        input.sourceSessionId === undefined
          ? choices.length === 1
            ? registry.getSession(choices[0]!.browserSessionId)
            : undefined
          : registry.getSession(input.sourceSessionId);
      if (!session || !eligible(session))
        throw new TaskBrowserCaptureError(
          'not-found',
          'Select a live browser session in this Task’s Project.',
        );
      const prior = this.deps.store
        .listCaptures(access.write)
        .find((c) => c.operationId === input.operationId);
      if (prior) {
        if (
          prior.sourceKind !== 'browser' ||
          prior.sourceSessionId !== session.browserSessionId ||
          prior.label !== input.label ||
          JSON.stringify(prior.author) !== JSON.stringify(access.write.author)
        )
          throw new TaskBrowserCaptureError(
            'operation-conflict',
            'That operation id already names another capture.',
          );
        const bytes = await this.content(access, prior.captureId);
        return {
          capture: prior,
          screenshot: {
            mimeType: prior.mediaType,
            data: bytes.toString('base64'),
          },
        };
      }
      const workspace = await this.workspace(access);
      const before = await this.cleanPin(workspace);
      const shot = await registry.captureScreenshot(session.browserSessionId);
      const after = await this.cleanPin(workspace);
      if (
        before.commit !== after.commit ||
        before.statusDigest !== after.statusDigest ||
        (await this.workspace(access)) !== workspace
      )
        throw new TaskBrowserCaptureError(
          'workspace-changed',
          'The workspace changed during capture.',
        );
      const now = registry.getSession(session.browserSessionId);
      if (
        !now ||
        !eligible(now) ||
        now.generation !== session.generation ||
        now.url !== session.url
      )
        throw new TaskBrowserCaptureError(
          'capture-unavailable',
          'The browser session changed during capture.',
        );
      this.current(access);
      const blob = await this.deps
        .blobs()
        .put(shot.data, shot.mimeType.toLowerCase());
      this.current(access);
      const pageUrl = redactBrowserUrl(session.url).slice(0, 2048);
      const result = this.deps.store.createCapture({
        ...access.write,
        ...blob,
        sourceKind: 'browser',
        sourceSessionId: session.browserSessionId,
        commit: before.commit,
        mediaType: shot.mimeType,
        operationId: input.operationId,
        ...(pageUrl ? { pageUrl } : {}),
        ...(input.label !== undefined ? { label: input.label } : {}),
        width: session.viewport.width,
        height: session.viewport.height,
      });
      if (!result.success)
        throw new TaskBrowserCaptureError(result.code, result.error);
      return {
        capture: result.data,
        screenshot: {
          mimeType: shot.mimeType,
          data: shot.data.toString('base64'),
        },
      };
    } catch (error) {
      throw this.failure(error);
    }
  }

  metadata(access: TaskReviewAccess, captureId: string): TaskCapture {
    this.current(access);
    const capture = this.deps.store
      .listCaptures(access.write)
      .find((c) => c.captureId === captureId);
    if (!capture)
      throw new TaskBrowserCaptureError('not-found', 'Capture not found.');
    return capture;
  }

  async content(access: TaskReviewAccess, captureId: string): Promise<Buffer> {
    const capture = this.metadata(access, captureId);
    try {
      const bytes = await this.deps.blobs().read(capture.digest);
      if (bytes.length !== capture.byteLength)
        throw new TaskBrowserCaptureError(
          'capture-corrupt',
          'Capture bytes do not match the metadata.',
        );
      this.current(access);
      return bytes;
    } catch (error) {
      throw this.failure(error);
    }
  }

  private failure(error: unknown): Error {
    if (error instanceof TaskBrowserCaptureError) return error;
    if (error instanceof WorkspaceCommitPinError)
      return new TaskBrowserCaptureError(
        error.code === 'workspace-changed'
          ? 'workspace-changed'
          : 'workspace-unobservable',
        'The workspace could not be pinned.',
      );
    if (error instanceof BrowserSessionError)
      return new TaskBrowserCaptureError(
        error.code === 'screenshot-too-large'
          ? 'screenshot-too-large'
          : 'capture-unavailable',
        error.message,
      );
    if (error instanceof TaskCaptureBlobStoreError) {
      const code =
        error.code === 'blob-too-large'
          ? 'screenshot-too-large'
          : error.code === 'home-cap-exceeded'
            ? 'capture-home-limit'
            : error.code === 'digest-mismatch'
              ? 'capture-corrupt'
              : 'capture-unavailable';
      return new TaskBrowserCaptureError(
        code,
        'Capture storage is unavailable or its bytes failed verification.',
      );
    }
    return new TaskBrowserCaptureError(
      'capture-unavailable',
      'The browser capture is unavailable.',
    );
  }
}
