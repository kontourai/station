import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  BROWSER_RECORD_MAX_DURATION_MS,
  BROWSER_RECORD_MAX_ENCODED_BYTES,
} from '../../tools/station-browser-policy.js';
import type { LiveSurfaceRegistry } from '../live-surface/registry.js';
import type { MediaToolsResolver } from '../media-tools/media-tools-resolver.js';
import {
  encodeBrowserRecording,
  waitForRecordingCleanup,
} from '../projects/task-browser-recording.js';
import type {
  BrowserSessionRecord,
  BrowserSessionRegistry,
} from './browser-session-registry.js';

const MAX_FRAMES = 300;
const MAX_RAW_BYTES = 64 * 1024 * 1024;
const RETAIN_MS = 60_000;
type State = 'starting' | 'recording' | 'encoding' | 'ready' | 'failed';
type Job = {
  id: string;
  owner: string;
  sessionId: string;
  generation: number;
  state: State;
  error?: string;
  bytes?: Buffer;
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
  constructor(
    private readonly deps: {
      registry: Pick<BrowserSessionRegistry, 'getSession'>;
      surfaces: Pick<LiveSurfaceRegistry, 'get'>;
      surfaceIdFor(id: string): string | undefined;
      resolver: Pick<MediaToolsResolver, 'resolveFfmpeg'>;
      encode: typeof encodeBrowserRecording;
    },
  ) {}

  start(input: {
    session: BrowserSessionRecord;
    owner: string;
    authorize(): Promise<boolean>;
  }): string {
    if (this.disposed || this.jobs.size >= 2)
      throw new Error('Recording capacity is exhausted.');
    const surfaceId = this.deps.surfaceIdFor(input.session.browserSessionId);
    const entry = surfaceId ? this.deps.surfaces.get(surfaceId) : undefined;
    if (!entry) throw new Error('Browser surface is unavailable.');
    const job: Job = {
      id: randomUUID(),
      owner: input.owner,
      sessionId: input.session.browserSessionId,
      generation: input.session.generation,
      state: 'starting',
      stop: new AbortController(),
      cancel: new AbortController(),
      done: Promise.resolve(),
    };
    this.jobs.set(job.id, job);
    const current = async () => {
      const session = this.deps.registry.getSession(job.sessionId);
      return (
        !job.cancel.signal.aborted &&
        !!session &&
        session.state === 'live' &&
        session.generation === job.generation &&
        session.url === input.session.url &&
        this.deps.surfaceIdFor(job.sessionId) === surfaceId &&
        this.deps.surfaces.get(surfaceId!) === entry &&
        (await input.authorize())
      );
    };
    const off = entry.onDispose(async () => {
      job.cancel.abort();
      await waitForRecordingCleanup(job.done);
    });
    if (entry.signal.aborted) job.cancel.abort();
    job.done = this.capture(job, entry, current)
      .catch((error: unknown) => {
        job.state = 'failed';
        job.error =
          error instanceof Error && error.message === 'media-tools-unavailable'
            ? 'FFmpeg is unavailable. Set up media tools and try again.'
            : 'The recording could not be completed.';
      })
      .finally(() => {
        off();
        job.timer = setTimeout(() => this.remove(job.id), RETAIN_MS);
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
    this.jobs.delete(id);
  }

  private async capture(
    job: Job,
    entry: NonNullable<ReturnType<LiveSurfaceRegistry['get']>>,
    current: () => Promise<boolean>,
  ) {
    if (!(await current())) throw new Error('Authority changed.');
    const resolution = await this.deps.resolver.resolveFfmpeg();
    if (resolution.status !== 'ready')
      throw new Error('media-tools-unavailable');
    if (!(await current())) throw new Error('Authority changed.');
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
      const frames: { file: string; tMs: number }[] = [];
      let rawBytes = 0;
      job.state = 'recording';
      try {
        while (!signal.aborted) {
          const frame = await viewer.next(signal);
          if (!frame) break;
          if (frame.kind !== 'frame') continue;
          if (!(await current()) || frame.header.codec !== 'jpeg')
            throw new Error('Capture changed.');
          rawBytes += frame.body.byteLength;
          if (rawBytes > MAX_RAW_BYTES || frames.length >= MAX_FRAMES)
            throw new Error('Recording too large.');
          const file = `frame-${String(frames.length).padStart(4, '0')}.jpg`;
          await writeFile(join(stage, file), frame.body, {
            flag: 'wx',
            mode: 0o600,
          });
          frames.push({
            file,
            tMs: frames.length ? Math.floor(performance.now() - started) : 0,
          });
        }
      } finally {
        clearTimeout(timer);
        viewer.close();
      }
      if (
        job.cancel.signal.aborted ||
        !frames.length ||
        (!job.stop.signal.aborted && !limit.signal.aborted) ||
        !(await current())
      )
        throw new Error('Recording cancelled.');
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
      if (!(await current())) throw new Error('Authority changed.');
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
