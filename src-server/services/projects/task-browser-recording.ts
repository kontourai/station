import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  parseWalkthrough,
  WALKTHROUGH_LIMITS,
  WALKTHROUGH_SCHEMA,
  type Walkthrough,
  type WalkthroughFrame,
} from '@kontourai/station-contracts/walkthrough';
import {
  BROWSER_RECORD_MAX_DURATION_MS,
  BROWSER_RECORD_MAX_ENCODED_BYTES,
} from '../../tools/station-browser-policy.js';
import type { BrowserAgentAuthority } from '../browser/browser-agent-authority.js';
import type { BrowserSessionRecord } from '../browser/browser-session-registry.js';
import type { FeaturePreviewSelector } from '../feature-previews/feature-preview-registry.js';
import type { LiveSurfaceRegistry } from '../live-surface/registry.js';
import type { MediaToolsResolver } from '../media-tools/media-tools-resolver.js';
import type { TaskReviewAccess } from '../orchestration/project-task-room-runtime.js';
import { TaskWalkthroughStore } from '../walkthroughs/task-walkthrough-store.js';
import {
  TaskBrowserCapture,
  TaskBrowserCaptureError,
  type TaskCaptureBrowserRegistry,
} from './task-browser-capture.js';
import { verifyTaskReviewEvidence } from './task-review-evidence.js';

const MAX_RAW_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_FRAMES = 300;
const ENCODE_TIMEOUT_MS = 60_000;
const CLEANUP_TIMEOUT_MS = 10_000;

export class TaskBrowserRecordingError extends Error {
  readonly response: { code: string; error: string };
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TaskBrowserRecordingError';
    this.response = { code, error: message };
  }
}

function cancelled(): TaskBrowserRecordingError {
  return new TaskBrowserRecordingError('cancelled', 'Recording was cancelled.');
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled();
}

async function waitForCleanup(done: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      done,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Recording cleanup did not finish in time.')),
          CLEANUP_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function encode(
  ffmpeg: string,
  concat: string,
  durationMs: number,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      [
        '-nostdin',
        '-v',
        'error',
        '-f',
        'concat',
        '-safe',
        '1',
        '-i',
        concat,
        '-t',
        (durationMs / 1000).toFixed(3),
        '-an',
        '-vf',
        'scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v',
        'libvpx',
        '-deadline',
        'realtime',
        '-cpu-used',
        '8',
        '-threads',
        '1',
        '-pix_fmt',
        'yuv420p',
        '-f',
        'webm',
        'pipe:1',
      ],
      { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let abortError: Error | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onCancel);
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    const abort = (error: Error) => {
      if (settled || abortError) return;
      abortError = error;
      try {
        child.kill('SIGKILL');
      } catch {
        // The process may already have exited; its close event still settles it.
      }
    };
    const onCancel = () => abort(cancelled());
    const timer = setTimeout(
      () =>
        abort(
          new TaskBrowserRecordingError(
            'recording-unavailable',
            'Recording encoder timed out.',
          ),
        ),
      ENCODE_TIMEOUT_MS,
    );
    signal.addEventListener('abort', onCancel, { once: true });
    if (signal.aborted) onCancel();
    child.stdout.on('data', (chunk: Buffer) => {
      if (abortError) return;
      size += chunk.length;
      if (size > maxBytes) {
        abort(
          new TaskBrowserRecordingError(
            'recording-too-large',
            'Encoded recording exceeds the byte limit.',
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    child.stdout.on('error', () => {});
    child.on('error', () => {
      if (!child.pid)
        finish(
          abortError ??
            new TaskBrowserRecordingError(
              'recording-unavailable',
              'Recording encoder could not start.',
            ),
        );
    });
    child.on('close', (code) => {
      if (abortError) return finish(abortError);
      if (code !== 0 || size === 0)
        finish(
          new TaskBrowserRecordingError(
            'recording-unavailable',
            'Recording encoder failed.',
          ),
        );
      else finish();
    });
  });
}

export type RecordingSource = {
  entry: NonNullable<ReturnType<LiveSurfaceRegistry['get']>>;
  current(): boolean;
  authorize(): Promise<boolean>;
  platform: Walkthrough['capture']['platform'];
  adapter: string;
  device?: Walkthrough['source']['device'];
  checkEachFrame?: boolean;
};

type RecordingInput = {
  durationMs: number;
  maxBytes?: number;
  label?: string;
  signal?: AbortSignal;
  /** Stops capture and publishes its bounded clip; `signal` cancels it. */
  stopSignal?: AbortSignal;
  onStarted?: () => void;
};

/** Records through a shared live surface, leaving other viewers attached. */
export class TaskBrowserRecording {
  private readonly jobs = new Set<{
    controller: AbortController;
    done: Promise<void>;
  }>();
  private readonly cleanupFailures: unknown[] = [];
  private readonly disposeCallbacks = new Set<() => Promise<void>>();
  private disposed = false;
  constructor(
    private readonly deps: {
      captures: TaskBrowserCapture;
      registry: TaskCaptureBrowserRegistry;
      surfaces: Pick<LiveSurfaceRegistry, 'get'>;
      surfaceIdFor(browserSessionId: string): string | undefined;
      resolver: MediaToolsResolver;
      preview: FeaturePreviewSelector;
      store: TaskWalkthroughStore;
    },
  ) {}

  async dispose(): Promise<void> {
    this.disposed = true;
    const callbacks = [...this.disposeCallbacks];
    this.disposeCallbacks.clear();
    const jobs = [...this.jobs];
    for (const job of jobs) job.controller.abort();
    const callbackResults = Promise.allSettled(
      callbacks.map((callback) => Promise.resolve().then(callback)),
    ).then((results) => {
      for (const result of results)
        if (result.status === 'rejected')
          this.cleanupFailures.push(result.reason);
    });
    await waitForCleanup(
      Promise.allSettled([
        ...jobs.map((job) => job.done),
        callbackResults,
      ]).then(() => {}),
    );
    if (this.cleanupFailures.length)
      throw new AggregateError(
        this.cleanupFailures,
        'Recording cleanup failed.',
      );
  }

  onDispose(callback: () => Promise<void>): void {
    if (this.disposed) throw new Error('Recorder is disposed');
    this.disposeCallbacks.add(callback);
  }

  private enabled() {
    return this.deps.preview.select({
      enabled: () => true,
      disabled: () => false,
    });
  }

  async record(
    access: TaskReviewAccess,
    authority: BrowserAgentAuthority,
    input: {
      browserSessionId?: string;
      durationMs: number;
      maxBytes?: number;
      label?: string;
      signal?: AbortSignal;
      authorize(): Promise<boolean>;
    },
  ) {
    const allowed = (session: BrowserSessionRecord) =>
      session.principalKey === authority.profileKey;
    return this.recordSource(access, input, async () => {
      const session = this.deps.captures.selectSession(
        access,
        input.browserSessionId,
        this.deps.registry,
        allowed,
      );
      const surfaceId = this.deps.surfaceIdFor(session.browserSessionId);
      const entry = surfaceId ? this.deps.surfaces.get(surfaceId) : undefined;
      if (!entry)
        throw new TaskBrowserRecordingError(
          'recording-unavailable',
          'Recording surface is unavailable.',
        );
      return {
        entry,
        platform: 'web',
        adapter: 'browser-screencast',
        current: () => {
          const current = this.deps.captures.selectSession(
            access,
            session.browserSessionId,
            this.deps.registry,
            allowed,
          );
          return (
            current.generation === session.generation &&
            this.deps.surfaceIdFor(session.browserSessionId) === surfaceId &&
            this.deps.surfaces.get(surfaceId!) === entry
          );
        },
        authorize: async () =>
          (await input.authorize()) &&
          (await entry.authorize(authority.principalId, 'view', {
            agentGrant: authority.grant,
          })),
      };
    });
  }

  async recordSource(
    access: TaskReviewAccess,
    input: RecordingInput,
    resolveSource: () => Promise<RecordingSource>,
  ) {
    if (input.signal?.aborted) throw cancelled();
    if (input.stopSignal?.aborted)
      throw new TaskBrowserRecordingError(
        'invalid-request',
        'Recording was stopped before it started.',
      );
    if (
      !Number.isSafeInteger(input.durationMs) ||
      input.durationMs < 1 ||
      input.durationMs > BROWSER_RECORD_MAX_DURATION_MS ||
      (input.maxBytes !== undefined &&
        (!Number.isSafeInteger(input.maxBytes) ||
          input.maxBytes < 1 ||
          input.maxBytes > BROWSER_RECORD_MAX_ENCODED_BYTES))
    )
      throw new TaskBrowserRecordingError(
        'invalid-request',
        'Recording duration or byte limit is out of bounds.',
      );
    if (!this.enabled())
      throw new TaskBrowserRecordingError(
        'feature_preview_disabled',
        'Enable Walkthroughs in feature previews.',
      );
    if (this.disposed || this.jobs.size >= 2)
      throw new TaskBrowserRecordingError(
        'recording-unavailable',
        'Recording capacity is exhausted.',
      );
    const controller = new AbortController();
    const signal = controller.signal;
    const onCancel = () => controller.abort();
    input.signal?.addEventListener('abort', onCancel, { once: true });
    if (input.signal?.aborted) onCancel();
    let finish!: (error?: unknown) => void;
    const done = new Promise<void>((resolve, reject) => {
      finish = (error) => (error === undefined ? resolve() : reject(error));
    });
    void done.catch(() => {});
    const job = { controller, done };
    this.jobs.add(job);
    let offSurface: (() => void) | undefined;
    let cleanupFailure: unknown;
    try {
      throwIfCancelled(signal);
      const source = await resolveSource();
      const { entry } = source;
      const before = await this.deps.captures.pin(access);
      throwIfCancelled(signal);
      const resolution = await this.deps.resolver.resolveFfmpeg();
      throwIfCancelled(signal);
      if (resolution.status !== 'ready')
        throw new TaskBrowserRecordingError(
          'media-tools-unavailable',
          'FFmpeg is unavailable; set up media tools first.',
        );
      offSurface = entry.onDispose(async () => {
        controller.abort();
        await waitForCleanup(done);
      });
      if (entry.signal.aborted) controller.abort();
      throwIfCancelled(signal);
      if (!source.current() || !(await source.authorize()))
        throw new TaskBrowserRecordingError(
          'recording-unavailable',
          'Browser surface is unavailable.',
        );
      throwIfCancelled(signal);
      const stage = await this.deps.store.stage(access, before.workspace);
      try {
        throwIfCancelled(signal);
        if (
          !this.enabled() ||
          !source.current() ||
          !(await source.authorize()) ||
          !this.enabled()
        )
          throw new TaskBrowserRecordingError(
            'recording-unavailable',
            'Recording authority changed.',
          );
        const viewer = entry.hub.attach({
          maxFps: 10,
          quality: 70,
          maxWidth: 1280,
          maxHeight: 1280,
        });
        const duration = new AbortController();
        const captureSignal = AbortSignal.any([signal, duration.signal]);
        const started = performance.now();
        const timer = setTimeout(() => duration.abort(), input.durationMs);
        let stopped = false;
        const onStop = () => {
          stopped = true;
          duration.abort();
        };
        input.stopSignal?.addEventListener('abort', onStop, { once: true });
        if (input.stopSignal?.aborted) onStop();
        const frames: {
          file: string;
          tMs: number;
          width: number;
          height: number;
          bytes: number;
        }[] = [];
        let rawBytes = 0;
        try {
          input.onStarted?.();
          while (!captureSignal.aborted) {
            const record = await viewer.next(captureSignal);
            if (!record) {
              if (!captureSignal.aborted)
                throw new TaskBrowserRecordingError(
                  'recording-unavailable',
                  'The surface closed during recording.',
                );
              break;
            }
            if (record.kind !== 'frame') continue;
            this.deps.captures.current(access);
            if (
              source.checkEachFrame &&
              (!this.enabled() ||
                !source.current() ||
                !(await source.authorize()) ||
                !this.enabled())
            )
              throw new TaskBrowserRecordingError(
                'recording-unavailable',
                'Recording authority changed.',
              );
            if (source.device && record.header.rotation)
              throw new TaskBrowserRecordingError(
                'recording-unavailable',
                'Rotated Device recording is unavailable.',
              );
            if (record.header.codec !== 'jpeg')
              throw new TaskBrowserRecordingError(
                'recording-unavailable',
                'The surface returned an unsupported frame.',
              );
            rawBytes += record.body.byteLength;
            if (rawBytes > MAX_RAW_FRAME_BYTES || frames.length >= MAX_FRAMES)
              throw new TaskBrowserRecordingError(
                'recording-too-large',
                'Frames exceed the recording limit.',
              );
            const file = `frame-${String(frames.length).padStart(4, '0')}.jpg`;
            const tMs =
              frames.length === 0
                ? 0
                : Math.min(
                    input.durationMs - 1,
                    Math.max(0, Math.floor(performance.now() - started)),
                  );
            await writeFile(join(stage.path, file), record.body, {
              flag: 'wx',
              mode: 0o600,
            });
            frames.push({
              file,
              tMs,
              width: record.header.width,
              height: record.header.height,
              bytes: record.body.byteLength,
            });
          }
          throwIfCancelled(signal);
          if (!duration.signal.aborted)
            throw new TaskBrowserRecordingError(
              'recording-unavailable',
              'The surface closed during recording.',
            );
        } finally {
          clearTimeout(timer);
          input.stopSignal?.removeEventListener('abort', onStop);
          viewer.close();
        }
        throwIfCancelled(signal);
        if (!frames.length)
          throw new TaskBrowserRecordingError(
            'recording-unavailable',
            'The surface produced no frames.',
          );
        const durationMs = stopped
          ? Math.min(
              input.durationMs,
              Math.max(1, Math.ceil(performance.now() - started)),
            )
          : input.durationMs;
        const lines = ['ffconcat version 1.0'];
        for (let i = 0; i < frames.length; i++) {
          const frame = frames[i]!;
          const end = frames[i + 1]?.tMs ?? durationMs;
          lines.push(
            `file '${frame.file}'`,
            `duration ${(Math.max(1, end - frame.tMs) / 1000).toFixed(3)}`,
          );
        }
        lines.push(`file '${frames.at(-1)!.file}'`);
        const concat = join(stage.path, 'frames.txt');
        await writeFile(concat, `${lines.join('\n')}\n`, {
          flag: 'wx',
          mode: 0o600,
        });
        throwIfCancelled(signal);
        const bytes = await encode(
          resolution.paths.ffmpeg,
          concat,
          durationMs,
          input.maxBytes ?? BROWSER_RECORD_MAX_ENCODED_BYTES,
          signal,
        );
        throwIfCancelled(signal);
        await rm(concat);
        const video = await open(
          join(stage.path, 'recording.webm'),
          'wx',
          0o600,
        );
        try {
          await video.writeFile(bytes);
          await video.sync();
        } finally {
          await video.close();
        }
        throwIfCancelled(signal);
        const retained: WalkthroughFrame[] = [];
        const retainedCount = Math.min(frames.length, 10);
        const retainedIndexes = new Set(
          Array.from({ length: retainedCount }, (_, i) =>
            retainedCount === 1
              ? 0
              : Math.round((i * (frames.length - 1)) / (retainedCount - 1)),
          ),
        );
        for (const [index, frame] of frames.entries()) {
          throwIfCancelled(signal);
          const keep = retainedIndexes.has(index);
          if (keep && frame.bytes <= WALKTHROUGH_LIMITS.frameBytes) {
            const handle = await open(join(stage.path, frame.file), 'r+');
            try {
              await handle.sync();
            } finally {
              await handle.close();
            }
            retained.push({
              kind: 'frame',
              tMs: frame.tMs,
              frameId: `frame-${retained.length}`,
              file: frame.file,
              width: frame.width,
              height: frame.height,
              reasons: ['interval'],
            });
          } else await rm(join(stage.path, frame.file));
        }
        const after = await this.deps.captures.pin(access);
        throwIfCancelled(signal);
        if (
          before.workspace !== after.workspace ||
          before.pin.commit !== after.pin.commit ||
          before.pin.statusDigest !== after.pin.statusDigest ||
          !source.current()
        )
          throw new TaskBrowserCaptureError(
            'workspace-changed',
            'The workspace or browser session changed during recording.',
          );
        const authorized = await source.authorize();
        throwIfCancelled(signal);
        if (!authorized || !this.enabled())
          throw new TaskBrowserRecordingError(
            'recording-unavailable',
            'Recording authority changed.',
          );
        const evidence = await verifyTaskReviewEvidence({
          workspace: after.workspace,
          evidence: { commit: before.pin.commit },
          authorize: () =>
            !signal.aborted && access.write.beforeCommit() && this.enabled(),
          taskGateReferences: [],
          readGate: async () => undefined,
        });
        throwIfCancelled(signal);
        if (!evidence.commitVerified)
          throw new TaskBrowserRecordingError(
            'recording-unavailable',
            'The workspace commit could not be verified.',
          );
        const manifest = parseWalkthrough({
          schema: WALKTHROUGH_SCHEMA,
          id: stage.id,
          createdAt: new Date().toISOString(),
          ...(input.label ? { title: input.label } : {}),
          source: {
            adapter: source.adapter,
            adapterVersion: '1',
            durationMs,
            commit: before.pin.commit,
            ...(source.device ? { device: source.device } : {}),
            recording: {
              file: 'recording.webm',
              mediaType: 'video/webm',
              byteLength: bytes.length,
              digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
            },
          },
          capture: {
            platform: source.platform,
            width: frames[0]!.width,
            height: frames[0]!.height,
          },
          coverage: {
            transcript: 'absent',
            frames: retained.length ? 'present' : 'absent',
            marks: 'absent',
            elements: 'absent',
            route: 'absent',
            console: 'absent',
            network: 'absent',
          },
          frameSelection: { candidates: frames.length, kept: retained.length },
          events: retained,
        });
        await this.deps.store.publish(
          access,
          stage,
          manifest,
          async () => {
            throwIfCancelled(signal);
            if (!this.enabled() || !(await source.authorize())) return false;
            const final = await this.deps.captures.pin(access);
            throwIfCancelled(signal);
            if (
              final.workspace !== before.workspace ||
              final.pin.commit !== before.pin.commit ||
              final.pin.statusDigest !== before.pin.statusDigest ||
              !source.current()
            )
              throw new TaskBrowserCaptureError(
                'workspace-changed',
                'The workspace or browser session changed during recording.',
              );
            return (
              !signal.aborted &&
              this.enabled() &&
              access.write.beforeCommit() &&
              (await source.authorize()) &&
              source.current() &&
              !signal.aborted &&
              this.enabled() &&
              access.write.beforeCommit()
            );
          },
          signal,
        );
        return manifest;
      } finally {
        await this.deps.store.discard(stage).catch((error: unknown) => {
          cleanupFailure = error;
          this.cleanupFailures.push(error);
          throw error;
        });
      }
    } catch (error) {
      if (signal.aborted && cleanupFailure === undefined) throw cancelled();
      throw error;
    } finally {
      input.signal?.removeEventListener('abort', onCancel);
      offSurface?.();
      this.jobs.delete(job);
      finish(cleanupFailure);
    }
  }
}
