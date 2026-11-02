import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '../../utils/logger.js';
import type { FeaturePreviewSelector } from '../feature-previews/feature-preview-registry.js';
import type {
  ProjectTaskRoomRuntime,
  TaskReviewAccess,
} from '../orchestration/project-task-room-runtime.js';
import {
  TaskBrowserCapture,
  TaskBrowserCaptureError,
} from '../projects/task-browser-capture.js';
import { publishTaskRecording } from '../projects/task-recording-publication.js';
import type { TaskWalkthroughStore } from '../walkthroughs/task-walkthrough-store.js';
import type { BrowserSessionRecord } from './browser-session-registry.js';

const logger = createLogger({ name: 'browser-human-task-clip' });

export type HumanTaskClip = {
  taskId: string;
  publish(input: {
    bytes: Buffer;
    durationMs: number;
    width: number;
    height: number;
    request: Request;
    signal: AbortSignal;
    browserCurrent(): Promise<boolean>;
  }): Promise<{ walkthroughId: string }>;
};
export type HumanTaskPreparation =
  | { kind: 'none' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'ready'; clip: HumanTaskClip };

/** Binds a person's Task and workspace before capture, then rechecks before publication. */
export class BrowserHumanTaskClip {
  constructor(
    private readonly deps: {
      runtime: Pick<
        ProjectTaskRoomRuntime,
        'sessionTaskReviewAccess' | 'personTaskReviewAccess'
      >;
      captures: Pick<TaskBrowserCapture, 'pin'>;
      store: Pick<TaskWalkthroughStore, 'stage' | 'publish' | 'discard'>;
      preview: FeaturePreviewSelector;
      localProjectIdFor(identity: string): string | undefined;
      isCurrent(request: Request): boolean;
    },
  ) {}

  async prepare(
    request: Request,
    conversationId: string,
    browser: BrowserSessionRecord,
  ): Promise<HumanTaskPreparation> {
    const enabled = () =>
      this.deps.preview.select({ enabled: () => true, disabled: () => false });
    if (!enabled() || !this.deps.isCurrent(request)) return { kind: 'none' };
    const unavailable = {
      kind: 'unavailable' as const,
      reason: "You don't have access to this Task.",
    };
    const linked =
      await this.deps.runtime.sessionTaskReviewAccess(conversationId);
    if (linked.kind === 'no-task') return { kind: 'none' };
    if (linked.kind !== 'granted') return unavailable;
    const person = await this.deps.runtime.personTaskReviewAccess({
      taskId: linked.write.taskId,
      request,
    });
    if (
      person.kind !== 'granted' ||
      person.write.author.kind !== 'person' ||
      person.write.taskCreatedAt !== linked.write.taskCreatedAt ||
      this.deps.localProjectIdFor(person.write.projectId) !==
        browser.projectId ||
      !this.deps.isCurrent(request)
    )
      return unavailable;
    let before: Awaited<ReturnType<TaskBrowserCapture['pin']>>;
    try {
      before = await this.deps.captures.pin(person);
    } catch (error) {
      if (error instanceof TaskBrowserCaptureError)
        return {
          kind: 'unavailable',
          reason: 'Commit or stash changes to add recordings to the Task.',
        };
      throw error;
    }
    const taskId = person.write.taskId;
    const ownerId = person.write.author.principalId;
    const current = async (
      next: Request,
    ): Promise<TaskReviewAccess | undefined> => {
      if (!enabled() || !this.deps.isCurrent(next)) return undefined;
      const bound =
        await this.deps.runtime.sessionTaskReviewAccess(conversationId);
      const access = await this.deps.runtime.personTaskReviewAccess({
        taskId,
        request: next,
      });
      if (
        bound.kind !== 'granted' ||
        access.kind !== 'granted' ||
        access.write.author.kind !== 'person' ||
        bound.write.taskId !== taskId ||
        bound.write.taskCreatedAt !== person.write.taskCreatedAt ||
        access.write.taskCreatedAt !== person.write.taskCreatedAt ||
        access.write.author.principalId !== ownerId ||
        this.deps.localProjectIdFor(access.write.projectId) !==
          browser.projectId ||
        !this.deps.isCurrent(next) ||
        !bound.write.beforeCommit() ||
        !access.write.beforeCommit()
      )
        return undefined;
      return access;
    };
    if (!(await current(request))) return unavailable;
    return {
      kind: 'ready',
      clip: {
        taskId,
        publish: async ({
          bytes,
          durationMs,
          width,
          height,
          request: next,
          signal,
          browserCurrent,
        }) => {
          signal.throwIfAborted();
          if (!(await browserCurrent()))
            throw new Error('Browser access changed.');
          const access = await current(next);
          if (!access) throw new Error('Task access changed.');
          const stage = await this.deps.store.stage(access, before.workspace);
          let publishing = false;
          try {
            signal.throwIfAborted();
            const file = await open(
              join(stage.path, 'recording.webm'),
              'wx',
              0o600,
            );
            try {
              await file.writeFile(bytes);
              await file.sync();
            } finally {
              await file.close();
            }
            publishing = true;
            const manifest = await publishTaskRecording({
              access,
              before,
              stage,
              bytes,
              durationMs,
              width,
              height,
              signal,
              captures: this.deps.captures,
              store: this.deps.store,
              candidates: 0,
              retained: [],
              onCleanupFailure: (error) =>
                logger.warn('Task recording staging cleanup failed', {
                  errorName: error instanceof Error ? error.name : typeof error,
                }),
              recheck: async () =>
                !!(await current(next)) && (await browserCurrent()),
            });
            return { walkthroughId: manifest.id };
          } finally {
            if (!publishing) await this.deps.store.discard(stage);
          }
        },
      },
    };
  }
}
