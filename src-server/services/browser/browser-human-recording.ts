import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  BROWSER_RECORD_MAX_DURATION_MS,
  BROWSER_RECORD_MAX_ENCODED_BYTES,
} from '../../tools/station-browser-policy.js';
import type { LiveSurfaceRegistry } from '../live-surface/registry.js';
import type { MediaToolsResolver } from '../media-tools/media-tools-resolver.js';
import { RecordingLimiter } from '../projects/recording-limiter.js';
import {
  encodeBrowserRecording,
  waitForRecordingCleanup,
} from '../projects/task-browser-recording.js';
import { TaskBrowserRecordingError } from '../projects/task-recording-errors.js';
import type { HumanTaskPreparation } from './browser-human-task-clip.js';
import { redactNetworkUrl } from './browser-network-log.js';
import type {
  BrowserSessionRecord,
  BrowserSessionRegistry,
} from './browser-session-registry.js';

const MAX_FRAMES = 300;
const MAX_RAW_BYTES = 64 * 1024 * 1024;
const RETAIN_MS = 60_000;
const MAX_RETAINED = 4;
type State = 'starting' | 'recording' | 'encoding' | 'ready' | 'failed';
type Job = {
  id: string;
  owner: string;
  sessionId: string;
  generation: number;
  state: State;
  error?: string;
  bytes?: Buffer;
  contact?: Array<{
    data: string;
    atMs: number;
    capturedAt: string;
    url: string;
    viewport: { width: number; height: number };
  }>;
  task: HumanTaskPreparation;
  prepareTask?: () => Promise<HumanTaskPreparation>;
  clip?: { durationMs: number; width: number; height: number };
  publication?: Promise<{ walkthroughId: string }>;
  publishing?: boolean;
  expired?: boolean;
  current?: (force?: boolean) => Promise<void>;
  stop: AbortController;
  cancel: AbortController;
  done: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
};

/** Person-initiated, bounded Browser clips held only until download or expiry. */
export class BrowserHumanRecording {
  private readonly jobs = new Map<string, Job>();
  private readonly cleanupFailures: unknown[] = [];
  private disposed = false;
  private readonly limiter: RecordingLimiter;
  constructor(
    private readonly deps: {
      registry: Pick<BrowserSessionRegistry, 'getSession'>;
      surfaces: Pick<LiveSurfaceRegistry, 'get'>;
      surfaceIdFor(id: string): string | undefined;
      resolver: Pick<MediaToolsResolver, 'resolveFfmpeg'>;
      encode: typeof encodeBrowserRecording;
      limiter?: RecordingLimiter;
    },
  ) {
    this.limiter = deps.limiter ?? new RecordingLimiter();
  }

  start(input: {
    session: BrowserSessionRecord;
    owner: string;
    admissionKey?: string;
    authorize(): Promise<boolean>;
    prepareTask?: () => Promise<HumanTaskPreparation>;
  }): string {
    if (this.disposed) throw new Error('Recording capacity is exhausted.');
    const surfaceId = this.deps.surfaceIdFor(input.session.browserSessionId);
    const entry = surfaceId ? this.deps.surfaces.get(surfaceId) : undefined;
    if (!entry) throw new Error('Browser surface is unavailable.');
    const release = this.limiter.acquire(input.admissionKey ?? input.owner);
    if (!release) throw new Error('Recording capacity is exhausted.');
    const job: Job = {
      id: randomUUID(),
      owner: input.owner,
      sessionId: input.session.browserSessionId,
      generation: input.session.generation,
      state: 'starting',
      task: { kind: 'none' },
      ...(input.prepareTask ? { prepareTask: input.prepareTask } : {}),
      stop: new AbortController(),
      cancel: new AbortController(),
      done: Promise.resolve(),
    };
    this.jobs.set(job.id, job);
    let lastAuthorization = -Infinity;
    const current = async (force = false) => {
      const fence = () => {
        const session = this.deps.registry.getSession(job.sessionId);
        if (job.cancel.signal.aborted) throw new Error('cancelled');
        if (
          !session ||
          session.state !== 'live' ||
          session.generation !== job.generation ||
          this.deps.surfaceIdFor(job.sessionId) !== surfaceId ||
          this.deps.surfaces.get(surfaceId!) !== entry
        )
          throw new Error('session-changed');
      };
      fence();
      if (force || performance.now() - lastAuthorization >= 1000) {
        if (!(await input.authorize())) throw new Error('revoked');
        lastAuthorization = performance.now();
        fence();
      }
    };
    job.current = current;
    let off: () => void;
    try {
      off = entry.onDispose(async () => {
        job.cancel.abort();
        await waitForRecordingCleanup(job.done);
      });
    } catch (error) {
      this.jobs.delete(job.id);
      release();
      throw error;
    }
    if (entry.signal.aborted) job.cancel.abort();
    job.done = this.capture(job, entry, current)
      .catch((error: unknown) => {
        job.state = 'failed';
        const messages: Record<string, string> = {
          'media-tools-unavailable':
            'FFmpeg is unavailable. Set up media tools and try again.',
          revoked: 'Browser access changed during recording.',
          'session-changed': 'The Browser session changed during recording.',
          'too-large': 'The first frame is too large to record.',
          'recording-too-large': 'The encoded recording is too large to save.',
          'no-frames': 'No frames were captured.',
          cancelled: 'Recording was cancelled.',
        };
        const code =
          error instanceof TaskBrowserRecordingError
            ? error.code
            : error instanceof Error
              ? error.message
              : '';
        job.error =
          error instanceof Error
            ? (messages[code] ?? 'The recording could not be completed.')
            : 'The recording could not be completed.';
      })
      .finally(() => {
        release();
        off();
        const retained = [...this.jobs.values()].filter(
          (entry) =>
            entry !== job &&
            !entry.publishing &&
            (entry.state === 'ready' || entry.state === 'failed'),
        );
        for (const stale of retained.slice(
          0,
          Math.max(0, retained.length + 1 - MAX_RETAINED),
        ))
          this.remove(stale.id);
        job.timer = setTimeout(() => {
          if (job.publishing) job.expired = true;
          else this.remove(job.id);
        }, RETAIN_MS);
        job.timer.unref?.();
      });
    return job.id;
  }

  status(id: string, owner: string, sessionId: string, generation: number) {
    const job = this.jobs.get(id);
    if (
      !job ||
      job.owner !== owner ||
      job.sessionId !== sessionId ||
      job.generation !== generation
    )
      return undefined;
    return {
      id: job.id,
      state: job.state,
      ...(job.error ? { error: job.error } : {}),
      ...(job.task.kind === 'ready'
        ? { task: { kind: 'ready' as const, taskId: job.task.clip.taskId } }
        : job.task.kind === 'unavailable'
          ? { task: job.task }
          : {}),
    };
  }

  stop(
    id: string,
    owner: string,
    sessionId: string,
    generation: number,
  ): boolean {
    const job = this.jobs.get(id);
    if (
      !job ||
      job.owner !== owner ||
      job.sessionId !== sessionId ||
      job.generation !== generation
    )
      return false;
    if (job.state === 'encoding' || job.state === 'ready') return true;
    if (!['starting', 'recording'].includes(job.state)) return false;
    job.stop.abort();
    return true;
  }

  cancel(
    id: string,
    owner: string,
    sessionId: string,
    generation: number,
  ): boolean {
    const job = this.jobs.get(id);
    if (
      !job ||
      job.owner !== owner ||
      job.sessionId !== sessionId ||
      job.generation !== generation
    )
      return false;
    job.cancel.abort();
    job.stop.abort();
    void job.done.finally(() => this.remove(id));
    return true;
  }

  video(
    id: string,
    owner: string,
    sessionId: string,
    generation: number,
  ): Buffer | undefined {
    const job = this.jobs.get(id);
    if (
      !job ||
      job.owner !== owner ||
      job.sessionId !== sessionId ||
      job.generation !== generation ||
      job.state !== 'ready' ||
      !job.bytes
    )
      return undefined;
    return job.bytes;
  }

  publishTask(
    id: string,
    owner: string,
    sessionId: string,
    generation: number,
    request: Request,
  ) {
    const job = this.jobs.get(id);
    if (
      !job ||
      job.owner !== owner ||
      job.sessionId !== sessionId ||
      job.generation !== generation ||
      job.state !== 'ready' ||
      job.task.kind !== 'ready' ||
      !job.bytes ||
      !job.clip
    )
      return undefined;
    if (!job.publication) {
      job.publishing = true;
      job.publication = job.task.clip
        .publish({
          ...job.clip,
          bytes: job.bytes,
          request,
          signal: AbortSignal.any([job.cancel.signal, request.signal]),
          onCleanupFailure: (error) => this.cleanupFailures.push(error),
          browserCurrent: async () => {
            try {
              await job.current?.(true);
              return !job.cancel.signal.aborted && !!job.current;
            } catch {
              return false;
            }
          },
        })
        .catch((error: unknown) => {
          job.publication = undefined;
          job.publishing = false;
          if (job.expired) this.remove(job.id);
          throw error;
        })
        .then((result) => {
          job.publishing = false;
          if (job.expired) this.remove(job.id);
          return result;
        });
    }
    return job.publication;
  }

  contact(id: string, owner: string, sessionId: string, generation: number) {
    const job = this.jobs.get(id);
    if (
      !job ||
      job.owner !== owner ||
      job.sessionId !== sessionId ||
      job.generation !== generation ||
      job.state !== 'ready'
    )
      return undefined;
    return job.contact;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const job of this.jobs.values()) {
      job.cancel.abort();
      job.stop.abort();
    }
    await waitForRecordingCleanup(
      Promise.allSettled([...this.jobs.values()].map((job) => job.done)).then(
        () => {},
      ),
    );
    for (const id of this.jobs.keys()) this.remove(id);
    if (this.cleanupFailures.length)
      throw new AggregateError(
        this.cleanupFailures,
        'Recording staging cleanup failed.',
      );
  }

  private remove(id: string) {
    const job = this.jobs.get(id);
    if (job?.timer) clearTimeout(job.timer);
    job?.cancel.abort();
    this.jobs.delete(id);
  }

  private async capture(
    job: Job,
    entry: NonNullable<ReturnType<LiveSurfaceRegistry['get']>>,
    current: (force?: boolean) => Promise<void>,
  ) {
    await current(true);
    if (job.prepareTask) job.task = await job.prepareTask();
    await current(true);
    const resolution = await this.deps.resolver.resolveFfmpeg();
    if (resolution.status !== 'ready')
      throw new Error('media-tools-unavailable');
    await current(true);
    const stage = await mkdtemp(join(tmpdir(), 'station-browser-recording-'));
    try {
      const viewer = entry.hub.attach({
        maxFps: 10,
        quality: 70,
        maxWidth: 1280,
        maxHeight: 1280,
      });
      const limit = new AbortController();
      const signal = AbortSignal.any([
        job.stop.signal,
        job.cancel.signal,
        limit.signal,
      ]);
      const timer = setTimeout(
        () => limit.abort(),
        BROWSER_RECORD_MAX_DURATION_MS,
      );
      const started = performance.now();
      const frames: {
        file: string;
        tMs: number;
        size: number;
        capturedAt: string;
        url: string;
        viewport: { width: number; height: number };
        imageWidth: number;
        imageHeight: number;
      }[] = [];
      let rawBytes = 0;
      job.state = 'recording';
      try {
        while (!signal.aborted) {
          const frame = await viewer.next(signal);
          if (!frame) break;
          if (frame.kind !== 'frame') continue;
          await current();
          if (frame.header.codec !== 'jpeg') throw new Error('session-changed');
          if (
            rawBytes + frame.body.byteLength > MAX_RAW_BYTES ||
            frames.length >= MAX_FRAMES
          ) {
            if (!frames.length) throw new Error('too-large');
            limit.abort();
            break;
          }
          rawBytes += frame.body.byteLength;
          const file = `frame-${String(frames.length).padStart(4, '0')}.jpg`;
          await writeFile(join(stage, file), frame.body, {
            flag: 'wx',
            mode: 0o600,
          });
          const session = this.deps.registry.getSession(job.sessionId);
          if (!session) throw new Error('session-changed');
          frames.push({
            file,
            tMs: frames.length ? Math.floor(performance.now() - started) : 0,
            size: frame.body.byteLength,
            imageWidth: frame.header.width,
            imageHeight: frame.header.height,
            capturedAt: new Date(frame.header.capturedAt).toISOString(),
            url: redactNetworkUrl(session.url),
            viewport: {
              width: frame.header.width / frame.header.deviceScaleFactor,
              height: frame.header.height / frame.header.deviceScaleFactor,
            },
          });
        }
      } finally {
        clearTimeout(timer);
        viewer.close();
      }
      if (job.cancel.signal.aborted) throw new Error('cancelled');
      if (!frames.length) throw new Error('no-frames');
      if (!job.stop.signal.aborted && !limit.signal.aborted)
        throw new Error('session-changed');
      await current(true);
      const duration = Math.max(
        1,
        Math.min(
          BROWSER_RECORD_MAX_DURATION_MS,
          Math.floor(performance.now() - started),
        ),
      );
      const lines = ['ffconcat version 1.0'];
      for (let i = 0; i < frames.length; i++)
        lines.push(
          `file '${frames[i]!.file}'`,
          `duration ${(Math.max(1, (frames[i + 1]?.tMs ?? duration) - frames[i]!.tMs) / 1000).toFixed(3)}`,
        );
      lines.push(`file '${frames.at(-1)!.file}'`);
      const concat = join(stage, 'frames.txt');
      await writeFile(concat, `${lines.join('\n')}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
      job.state = 'encoding';
      const bytes = await this.deps.encode(
        resolution.paths.ffmpeg,
        concat,
        duration,
        BROWSER_RECORD_MAX_ENCODED_BYTES,
        job.cancel.signal,
      );
      await current(true);
      const selected = Array.from({ length: 4 }, (_, i) => {
        const target = (i * duration) / 3;
        return frames.reduce((best, frame) =>
          Math.abs(frame.tMs - target) < Math.abs(best.tMs - target)
            ? frame
            : best,
        );
      });
      if (
        selected.reduce((sum, frame) => sum + frame.size, 0) <=
        16 * 1024 * 1024
      ) {
        const contact = await Promise.all(
          selected.map(async (frame) => ({
            data: (await readFile(join(stage, frame.file))).toString('base64'),
            atMs: frame.tMs,
            capturedAt: frame.capturedAt,
            url: frame.url,
            viewport: frame.viewport,
          })),
        );
        await current(true);
        job.contact = contact;
      }
      job.clip = {
        durationMs: duration,
        width: frames[0]!.imageWidth,
        height: frames[0]!.imageHeight,
      };
      job.bytes = bytes;
      job.state = 'ready';
    } finally {
      await rm(stage, { recursive: true, force: true }).catch(
        (error: unknown) => {
          this.cleanupFailures.push(error);
          throw error;
        },
      );
    }
  }
}
