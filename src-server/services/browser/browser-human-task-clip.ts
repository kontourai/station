import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseWalkthrough,
  WALKTHROUGH_SCHEMA,
} from '@kontourai/station-contracts/walkthrough';
import type { FeaturePreviewSelector } from '../feature-previews/feature-preview-registry.js';
import type {
  ProjectTaskRoomRuntime,
  TaskReviewAccess,
} from '../orchestration/project-task-room-runtime.js';
import {
  TaskBrowserCapture,
  TaskBrowserCaptureError,
} from '../projects/task-browser-capture.js';
import { verifyTaskReviewEvidence } from '../projects/task-review-evidence.js';
import type { TaskWalkthroughStore } from '../walkthroughs/task-walkthrough-store.js';
import type { BrowserSessionRecord } from './browser-session-registry.js';

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
      reason:
        'Commit or stash changes to add recordings to the Task, and ensure you have Task access.',
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
      if (error instanceof TaskBrowserCaptureError) return unavailable;
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
          const after = await this.deps.captures.pin(access);
          if (
            before.workspace !== after.workspace ||
            before.pin.commit !== after.pin.commit ||
            before.pin.statusDigest !== after.pin.statusDigest
          )
            throw new Error('The Task workspace changed during recording.');
          const evidence = await verifyTaskReviewEvidence({
            workspace: after.workspace,
            evidence: { commit: before.pin.commit },
            authorize: () =>
              !signal.aborted &&
              access.write.beforeCommit() &&
              this.deps.isCurrent(next) &&
              enabled(),
            taskGateReferences: [],
            readGate: async () => undefined,
          });
          if (!evidence.commitVerified)
            throw new Error('The Task commit could not be verified.');
          const stage = await this.deps.store.stage(access, after.workspace);
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
            const manifest = parseWalkthrough({
              schema: WALKTHROUGH_SCHEMA,
              id: stage.id,
              createdAt: new Date().toISOString(),
              source: {
                adapter: 'browser-screencast',
                adapterVersion: '1',
                durationMs,
                commit: before.pin.commit,
                recording: {
                  file: 'recording.webm',
                  mediaType: 'video/webm',
                  byteLength: bytes.length,
                  digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
                },
              },
              capture: { platform: 'web', width, height },
              coverage: {
                transcript: 'absent',
                frames: 'absent',
                marks: 'absent',
                elements: 'absent',
                route: 'absent',
                console: 'absent',
                network: 'absent',
              },
              frameSelection: { candidates: 0, kept: 0 },
              events: [],
            });
            await this.deps.store.publish(
              access,
              stage,
              manifest,
              async () => {
                const now = await current(next);
                if (!now || !(await browserCurrent())) return false;
                const final = await this.deps.captures.pin(now);
                return (
                  !signal.aborted &&
                  final.workspace === before.workspace &&
                  final.pin.commit === before.pin.commit &&
                  final.pin.statusDigest === before.pin.statusDigest &&
                  !!(await current(next)) &&
                  (await browserCurrent())
                );
              },
              signal,
            );
            return { walkthroughId: stage.id };
          } finally {
            await this.deps.store.discard(stage);
          }
        },
      },
    };
  }
}
