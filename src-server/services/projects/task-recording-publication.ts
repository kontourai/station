import { createHash } from 'node:crypto';
import {
  parseWalkthrough,
  WALKTHROUGH_SCHEMA,
  type WalkthroughFrame,
} from '@kontourai/station-contracts/walkthrough';
import type { TaskReviewAccess } from '../orchestration/project-task-room-runtime.js';
import type { TaskWalkthroughStore } from '../walkthroughs/task-walkthrough-store.js';
import {
  type TaskBrowserCapture,
  TaskBrowserCaptureError,
} from './task-browser-capture.js';
import { TaskBrowserRecordingError } from './task-recording-errors.js';
import { verifyTaskReviewEvidence } from './task-review-evidence.js';

type Pin = Awaited<ReturnType<TaskBrowserCapture['pin']>>;
type Stage = Awaited<ReturnType<TaskWalkthroughStore['stage']>>;

/** Publishes a staged recording with workspace and caller authority fences. */
export async function publishTaskRecording(input: {
  access: TaskReviewAccess;
  before: Pin;
  stage: Stage;
  bytes: Buffer;
  signal: AbortSignal;
  captures: Pick<TaskBrowserCapture, 'pin'>;
  store: Pick<TaskWalkthroughStore, 'publish' | 'discard'>;
  durationMs: number;
  width: number;
  height: number;
  label?: string;
  candidates: number;
  retained: WalkthroughFrame[];
  recheck(): Promise<boolean>;
  onCleanupFailure?(error: unknown): void;
}) {
  const { access, before, stage, signal } = input;
  const current = async () => {
    signal.throwIfAborted();
    if (!(await input.recheck()))
      throw new TaskBrowserRecordingError(
        'recording-unavailable',
        'Recording authority changed.',
      );
    const pin = await input.captures.pin(access);
    signal.throwIfAborted();
    if (
      pin.workspace !== before.workspace ||
      pin.pin.commit !== before.pin.commit ||
      pin.pin.statusDigest !== before.pin.statusDigest
    )
      throw new TaskBrowserCaptureError(
        'workspace-changed',
        'The workspace changed during recording.',
      );
    if (!(await input.recheck()))
      throw new TaskBrowserRecordingError(
        'recording-unavailable',
        'Recording authority changed.',
      );
    return true;
  };
  try {
    await current();
    const evidence = await verifyTaskReviewEvidence({
      workspace: before.workspace,
      evidence: { commit: before.pin.commit },
      authorize: () => !signal.aborted && access.write.beforeCommit(),
      taskGateReferences: [],
      readGate: async () => undefined,
    });
    signal.throwIfAborted();
    if (!evidence.commitVerified)
      throw new Error('The Task commit could not be verified.');
    const manifest = parseWalkthrough({
      schema: WALKTHROUGH_SCHEMA,
      id: stage.id,
      createdAt: new Date().toISOString(),
      ...(input.label ? { title: input.label } : {}),
      source: {
        adapter: 'browser-screencast',
        adapterVersion: '1',
        durationMs: input.durationMs,
        commit: before.pin.commit,
        recording: {
          file: 'recording.webm',
          mediaType: 'video/webm',
          byteLength: input.bytes.length,
          digest: `sha256:${createHash('sha256').update(input.bytes).digest('hex')}`,
        },
      },
      capture: { platform: 'web', width: input.width, height: input.height },
      coverage: {
        transcript: 'absent',
        frames: input.retained.length ? 'present' : 'absent',
        marks: 'absent',
        elements: 'absent',
        route: 'absent',
        console: 'absent',
        network: 'absent',
      },
      frameSelection: {
        candidates: input.candidates,
        kept: input.retained.length,
      },
      events: input.retained,
    });
    await input.store.publish(access, stage, manifest, current, signal);
    return manifest;
  } finally {
    try {
      await input.store.discard(stage);
    } catch (error) {
      input.onCleanupFailure?.(error);
    }
  }
}
