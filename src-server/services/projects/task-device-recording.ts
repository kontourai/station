import { randomUUID } from 'node:crypto';
import { BROWSER_RECORD_MAX_DURATION_MS } from '../../tools/station-browser-policy.js';
import type { TaskReviewAccess } from '../orchestration/project-task-room-runtime.js';
import { TaskBrowserCaptureError } from './task-browser-capture.js';
import {
  type RecordingSource,
  type TaskBrowserRecording,
  TaskBrowserRecordingError,
} from './task-browser-recording.js';

const RETAIN_MS = 5 * 60_000;
const MAX_JOBS = 10;
type Result = { walkthroughId: string; commit: string };
type Status =
  | { state: 'starting' | 'recording' | 'stopping' }
  | { state: 'completed'; result: Result }
  | { state: 'failed'; code: string };
type Job = {
  key: string;
  stop: AbortController;
  cancel: AbortController;
  status: Status;
  finishedAt?: number;
  done: Promise<void>;
};

/** Owns bounded, Task-scoped human Device recording jobs. */
export class TaskDeviceRecording {
  private readonly jobs = new Map<string, Job>();
  private closed = false;
  constructor(
    private readonly recorder: Pick<TaskBrowserRecording, 'recordSource'>,
  ) {}
  private key(access: TaskReviewAccess): string {
    if (access.write.author.kind !== 'person' || !access.write.beforeCommit())
      throw new TaskBrowserCaptureError('not-found', 'Task not found.');
    return JSON.stringify([
      access.write.projectId,
      access.write.taskId,
      access.write.taskCreatedAt,
      access.write.author.principalId,
    ]);
  }
  private prune() {
    const now = Date.now();
    for (const [id, job] of this.jobs)
      if (job.finishedAt !== undefined && now - job.finishedAt >= RETAIN_MS)
        this.jobs.delete(id);
  }
  start(
    access: TaskReviewAccess,
    input: { durationMs: number; label?: string },
    resolveSource: () => Promise<RecordingSource>,
  ) {
    const key = this.key(access);
    if (
      !Number.isSafeInteger(input.durationMs) ||
      input.durationMs < 1 ||
      input.durationMs > BROWSER_RECORD_MAX_DURATION_MS
    )
      throw new TaskBrowserCaptureError(
        'invalid-request',
        'Recording duration is out of bounds.',
      );
    this.prune();
    if (
      this.closed ||
      this.jobs.size >= MAX_JOBS ||
      [...this.jobs.values()].filter((job) => job.finishedAt === undefined)
        .length >= 2
    )
      throw new TaskBrowserCaptureError(
        'capture-unavailable',
        'Recording capacity is exhausted.',
      );
    const id = randomUUID();
    const stop = new AbortController();
    const cancel = new AbortController();
    const job: Job = {
      key,
      stop,
      cancel,
      status: { state: 'starting' },
      done: Promise.resolve(),
    };
    this.jobs.set(id, job);
    job.done = this.recorder
      .recordSource(
        access,
        {
          ...input,
          signal: cancel.signal,
          stopSignal: stop.signal,
          onStarted: () => {
            if (!stop.signal.aborted && !cancel.signal.aborted)
              job.status = { state: 'recording' };
          },
        },
        resolveSource,
      )
      .then(
        (manifest) => {
          job.status =
            manifest.source.commit && manifest.source.recording
              ? {
                  state: 'completed',
                  result: {
                    walkthroughId: manifest.id,
                    commit: manifest.source.commit,
                  },
                }
              : { state: 'failed', code: 'recording-unavailable' };
        },
        (error: unknown) => {
          job.status = {
            state: 'failed',
            code:
              error instanceof TaskBrowserRecordingError ||
              error instanceof TaskBrowserCaptureError
                ? error.code
                : 'recording-unavailable',
          };
        },
      )
      .finally(() => {
        job.finishedAt = Date.now();
      });
    return { id, ...job.status };
  }
  status(access: TaskReviewAccess, id: string) {
    const key = this.key(access);
    this.prune();
    const job = this.jobs.get(id);
    if (!job || job.key !== key)
      throw new TaskBrowserCaptureError('not-found', 'Recording not found.');
    return { id, ...job.status };
  }
  stop(access: TaskReviewAccess, id: string) {
    const status = this.status(access, id);
    const job = this.jobs.get(id)!;
    if (status.state === 'starting' || status.state === 'recording') {
      job.status = { state: 'stopping' };
      job.stop.abort();
    }
    return this.status(access, id);
  }
  async dispose() {
    this.closed = true;
    const jobs = [...this.jobs.values()];
    for (const job of jobs)
      if (job.finishedAt === undefined) job.cancel.abort();
    await Promise.all(jobs.map((job) => job.done));
    this.jobs.clear();
  }
}
