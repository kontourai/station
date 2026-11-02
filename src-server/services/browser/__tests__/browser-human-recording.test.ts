import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { describe, expect, it, vi } from 'vitest';
import { locateExecutable } from '../../devices/device-host-tools.js';
import type { LiveSurfaceRegistry } from '../../live-surface/registry.js';
import { RecordingLimiter } from '../../projects/recording-limiter.js';
import {
  encodeBrowserRecording,
  TaskBrowserRecording,
  TaskBrowserRecordingError,
} from '../../projects/task-browser-recording.js';
import { BrowserHumanRecording } from '../browser-human-recording.js';
import type { BrowserSessionRecord } from '../browser-session-registry.js';

function fixture(
  real?: { ffmpeg: string; jpeg: Buffer },
  frameLimit = 1,
  limiter?: RecordingLimiter,
) {
  const session = {
    browserSessionId: 'bs_test',
    generation: 3,
    state: 'live',
    url: 'https://example.test/',
  } as BrowserSessionRecord;
  let dispose: (() => Promise<void>) | undefined;
  let waiting:
    | ((
        value: {
          kind: 'frame';
          header: {
            codec: 'jpeg';
            width: number;
            height: number;
            deviceScaleFactor: number;
            capturedAt: number;
          };
          body: Uint8Array;
        } | null,
      ) => void)
    | undefined;
  const close = vi.fn();
  const entry = {
    signal: new AbortController().signal,
    onDispose: (callback: () => Promise<void>) => {
      dispose = callback;
      return () => {
        dispose = undefined;
      };
    },
    hub: {
      attach: () => {
        let delivered = 0;
        return {
          close,
          next: async (signal: AbortSignal) => {
            if (delivered < frameLimit) {
              delivered++;
              return {
                kind: 'frame',
                header: {
                  codec: 'jpeg',
                  width: 640,
                  height: 480,
                  deviceScaleFactor: 1,
                  capturedAt: 1_700_000_000_000,
                },
                body: real?.jpeg ?? new Uint8Array([1, 2, 3]),
              };
            }
            return new Promise<{
              kind: 'frame';
              header: {
                codec: 'jpeg';
                width: number;
                height: number;
                deviceScaleFactor: number;
                capturedAt: number;
              };
              body: Uint8Array;
            } | null>((resolve) => {
              waiting = resolve;
              if (signal.aborted) resolve(null);
              else
                signal.addEventListener(
                  'abort',
                  () => {
                    waiting = undefined;
                    resolve(null);
                  },
                  {
                    once: true,
                  },
                );
            });
          },
        };
      },
    },
  };
  let stage = '';
  const encode = vi.fn(
    async (
      binary: string,
      concat: string,
      duration: number,
      maxBytes: number,
      signal: AbortSignal,
    ) => {
      stage = concat;
      expect(readFileSync(concat, 'utf8')).toContain("file 'frame-0000.jpg'");
      return real
        ? encodeBrowserRecording(binary, concat, duration, maxBytes, signal)
        : Buffer.from('webm');
    },
  );
  const recorder = new BrowserHumanRecording({
    registry: { getSession: () => session },
    surfaces: {
      get: () => entry as unknown as ReturnType<LiveSurfaceRegistry['get']>,
    },
    surfaceIdFor: () => 'surface',
    resolver: {
      resolveFfmpeg: async () => ({
        status: 'ready',
        paths: { ffmpeg: real?.ffmpeg ?? '/fake', ffprobe: '/fake' },
        origin: 'host',
      }),
    },
    encode,
    limiter,
  });
  return {
    recorder,
    session,
    close,
    encode,
    stage: () => stage,
    canDeliver: () => !!waiting,
    deliver: (body = new Uint8Array([1, 2, 3])) => {
      const resolve = waiting;
      waiting = undefined;
      resolve?.({
        kind: 'frame',
        header: {
          codec: 'jpeg',
          width: 640,
          height: 480,
          deviceScaleFactor: 1,
          capturedAt: 1_700_000_000_000,
        },
        body,
      });
    },
    disposeSurface: () => dispose?.(),
  };
}

describe('human Browser recording', () => {
  it('refuses a third simultaneous recording for the same owner', async () => {
    const h = fixture();
    const input = {
      session: h.session,
      owner: 'alice',
      authorize: async () => true,
    };
    h.recorder.start(input);
    h.recorder.start(input);
    const prepareTask = vi.fn(async () => ({ kind: 'none' as const }));
    expect(() => h.recorder.start({ ...input, prepareTask })).toThrow(
      'capacity',
    );
    expect(prepareTask).not.toHaveBeenCalled();
    await h.recorder.dispose();
  });

  it('shares active capacity with the Task Browser recorder and releases finished jobs', async () => {
    const limiter = new RecordingLimiter();
    const h = fixture(undefined, 1, limiter);
    const input = {
      session: h.session,
      owner: 'alice',
      authorize: async () => true,
    };
    const first = h.recorder.start(input);
    await vi.waitFor(() => expect(h.canDeliver()).toBe(true));
    h.recorder.start(input);
    const task = new TaskBrowserRecording({
      limiter,
      preview: {
        select: ({ enabled }: { enabled: () => boolean }) => enabled(),
      },
      captures: {
        selectSession: () => {
          throw new Error('Task source reached');
        },
      },
    } as never);
    const access = {} as never;
    const authority = { principalId: 'alice', profileKey: 'operator' } as never;
    const options = { durationMs: 1000, authorize: async () => true };
    await expect(task.record(access, authority, options)).rejects.toThrow(
      'capacity',
    );
    expect(h.recorder.stop(first, 'alice', 'bs_test', 3)).toBe(true);
    await vi.waitFor(() =>
      expect(h.recorder.status(first, 'alice', 'bs_test', 3)?.state).toBe(
        'ready',
      ),
    );
    await expect(task.record(access, authority, options)).rejects.toThrow(
      'Task source reached',
    );
    await task.dispose();
    await h.recorder.dispose();
  });

  it('finishes the clip at the 300-frame bound', async () => {
    const h = fixture(undefined, 301);
    const id = h.recorder.start({
      session: h.session,
      owner: 'alice',
      authorize: async () => true,
    });
    await vi.waitFor(() =>
      expect(h.recorder.status(id, 'alice', 'bs_test', 3)?.state).toBe('ready'),
    );
    expect(h.encode).toHaveBeenCalledOnce();
    expect(h.recorder.video(id, 'alice', 'bs_test', 3)).toBeDefined();
    await h.recorder.dispose();
  });
  it('stops, encodes once, serves only the owner and removes staging', async () => {
    const h = fixture();
    const id = h.recorder.start({
      session: h.session,
      owner: 'alice',
      authorize: async () => true,
    });
    await vi.waitFor(() =>
      expect(h.recorder.status(id, 'alice', 'bs_test', 3)?.state).toBe(
        'recording',
      ),
    );
    expect(h.recorder.stop(id, 'bob', 'bs_test', 3)).toBe(false);
    expect(h.recorder.stop(id, 'alice', 'bs_test', 3)).toBe(true);
    await vi.waitFor(() =>
      expect(h.recorder.status(id, 'alice', 'bs_test', 3)?.state).toBe('ready'),
    );
    expect(h.encode).toHaveBeenCalledOnce();
    expect(existsSync(h.stage())).toBe(false);
    expect(h.recorder.video(id, 'bob', 'bs_test', 3)).toBeUndefined();
    expect(h.recorder.video(id, 'alice', 'bs_test', 4)).toBeUndefined();
    const contact = h.recorder.contact(id, 'alice', 'bs_test', 3);
    expect(contact).toHaveLength(4);
    expect(contact?.[0]).toMatchObject({
      atMs: 0,
      url: 'https://example.test/',
      viewport: { width: 640, height: 480 },
    });
    expect(h.recorder.contact(id, 'bob', 'bs_test', 3)).toBeUndefined();
    expect(h.recorder.video(id, 'alice', 'bs_test', 3)?.toString()).toBe(
      'webm',
    );
    expect(h.recorder.video(id, 'alice', 'bs_test', 3)?.toString()).toBe(
      'webm',
    );
    await h.recorder.dispose();
  });
  it('bounds retained contact frames without discarding the encoded clip', async () => {
    const h = fixture({
      ffmpeg: '/fake',
      jpeg: Buffer.alloc(4 * 1024 * 1024 + 1, 1),
    });
    h.encode.mockResolvedValue(Buffer.from('webm'));
    const id = h.recorder.start({
      session: h.session,
      owner: 'alice',
      authorize: async () => true,
    });
    await vi.waitFor(() => expect(h.canDeliver()).toBe(true));
    h.recorder.stop(id, 'alice', 'bs_test', 3);
    await vi.waitFor(() =>
      expect(h.recorder.status(id, 'alice', 'bs_test', 3)?.state).toBe('ready'),
    );
    expect(h.recorder.contact(id, 'alice', 'bs_test', 3)).toBeUndefined();
    expect(h.recorder.video(id, 'alice', 'bs_test', 3)?.toString()).toBe(
      'webm',
    );
    await h.recorder.dispose();
  });

  it('fails before encoding when authority is revoked and a new frame arrives', async () => {
    const h = fixture();
    let allowed = true;
    const now = performance.now.bind(performance);
    let offset = 0;
    const clock = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => now() + offset);
    try {
      const id = h.recorder.start({
        session: h.session,
        owner: 'alice',
        authorize: async () => allowed,
      });
      await vi.waitFor(() => expect(h.canDeliver()).toBe(true));
      allowed = false;
      offset = 1100;
      h.deliver();
      await vi.waitFor(() =>
        expect(h.recorder.status(id, 'alice', 'bs_test', 3)).toMatchObject({
          state: 'failed',
          error: 'Browser access changed during recording.',
        }),
      );
      expect(h.encode).not.toHaveBeenCalled();
      expect(h.recorder.video(id, 'alice', 'bs_test', 3)).toBeUndefined();
    } finally {
      clock.mockRestore();
      await h.recorder.dispose();
    }
  });

  it('fails before encoding when authority is revoked while idle and stopped', async () => {
    const h = fixture();
    let allowed = true;
    const id = h.recorder.start({
      session: h.session,
      owner: 'alice',
      authorize: async () => allowed,
    });
    await vi.waitFor(() => expect(h.canDeliver()).toBe(true));
    allowed = false;
    expect(h.recorder.stop(id, 'alice', 'bs_test', 3)).toBe(true);
    await vi.waitFor(() =>
      expect(h.recorder.status(id, 'alice', 'bs_test', 3)).toMatchObject({
        state: 'failed',
        error: 'Browser access changed during recording.',
      }),
    );
    expect(h.encode).not.toHaveBeenCalled();
    await h.recorder.dispose();
  });

  it('reports no frames and a changed generation separately', async () => {
    const empty = fixture(undefined, 0);
    const id = empty.recorder.start({
      session: empty.session,
      owner: 'alice',
      authorize: async () => true,
    });
    await vi.waitFor(() => expect(empty.canDeliver()).toBe(true));
    empty.recorder.stop(id, 'alice', 'bs_test', 3);
    await vi.waitFor(() =>
      expect(empty.recorder.status(id, 'alice', 'bs_test', 3)).toMatchObject({
        state: 'failed',
        error: 'No frames were captured.',
      }),
    );
    expect(empty.encode).not.toHaveBeenCalled();
    await empty.recorder.dispose();

    const changed = fixture();
    const changedId = changed.recorder.start({
      session: changed.session,
      owner: 'alice',
      authorize: async () => true,
    });
    await vi.waitFor(() => expect(changed.canDeliver()).toBe(true));
    changed.session.generation = 4;
    changed.deliver();
    await vi.waitFor(() =>
      expect(
        changed.recorder.status(changedId, 'alice', 'bs_test', 3),
      ).toMatchObject({
        state: 'failed',
        error: 'The Browser session changed during recording.',
      }),
    );
    expect(changed.encode).not.toHaveBeenCalled();
    await changed.recorder.dispose();
  });

  it('reports an encoded clip that exceeds its byte limit', async () => {
    const h = fixture();
    h.encode.mockRejectedValue(
      new TaskBrowserRecordingError(
        'recording-too-large',
        'Encoded recording exceeds the byte limit.',
      ),
    );
    const id = h.recorder.start({
      session: h.session,
      owner: 'alice',
      authorize: async () => true,
    });
    await vi.waitFor(() => expect(h.canDeliver()).toBe(true));
    h.recorder.stop(id, 'alice', 'bs_test', 3);
    await vi.waitFor(() =>
      expect(h.recorder.status(id, 'alice', 'bs_test', 3)).toMatchObject({
        state: 'failed',
        error: 'The encoded recording is too large to save.',
      }),
    );
    await h.recorder.dispose();
  });

  it('finishes the clip at the raw byte cap', async () => {
    const h = fixture();
    const id = h.recorder.start({
      session: h.session,
      owner: 'alice',
      authorize: async () => true,
    });
    await vi.waitFor(() => expect(h.canDeliver()).toBe(true));
    h.deliver(new Uint8Array(64 * 1024 * 1024));
    await vi.waitFor(() =>
      expect(h.recorder.status(id, 'alice', 'bs_test', 3)?.state).toBe('ready'),
    );
    expect(h.encode).toHaveBeenCalledOnce();
    await h.recorder.dispose();
  });

  it('finishes the clip when the 30-second timer fires', async () => {
    const original = globalThis.setTimeout;
    let expire: (() => void) | undefined;
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
      ms?: number,
    ) => {
      if (ms === 30_000) expire = callback;
      return original(callback, ms);
    }) as typeof setTimeout);
    const h = fixture();
    try {
      const id = h.recorder.start({
        session: h.session,
        owner: 'alice',
        authorize: async () => true,
      });
      await vi.waitFor(() => expect(h.canDeliver()).toBe(true));
      expect(expire).toBeDefined();
      expire?.();
      await vi.waitFor(() =>
        expect(h.recorder.status(id, 'alice', 'bs_test', 3)?.state).toBe(
          'ready',
        ),
      );
      expect(h.encode).toHaveBeenCalledOnce();
    } finally {
      timer.mockRestore();
      await h.recorder.dispose();
    }
  });

  it('continues recording across a URL change within one generation', async () => {
    const h = fixture();
    const id = h.recorder.start({
      session: h.session,
      owner: 'alice',
      authorize: async () => true,
    });
    await vi.waitFor(() => expect(h.canDeliver()).toBe(true));
    h.session.url = 'https://example.test/next';
    h.deliver();
    await vi.waitFor(() => expect(h.canDeliver()).toBe(true));
    h.recorder.stop(id, 'alice', 'bs_test', 3);
    await vi.waitFor(() =>
      expect(h.recorder.status(id, 'alice', 'bs_test', 3)?.state).toBe('ready'),
    );
    expect(h.encode).toHaveBeenCalledOnce();
    await h.recorder.dispose();
  });

  it('retries a transient Task publication failure', async () => {
    const h = fixture();
    const publish = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({ walkthroughId: 'clip' });
    const id = h.recorder.start({
      session: h.session,
      owner: 'alice',
      authorize: async () => true,
      prepareTask: async () => ({
        kind: 'ready',
        clip: { taskId: 'task-a', publish },
      }),
    });
    await vi.waitFor(() => expect(h.canDeliver()).toBe(true));
    h.recorder.stop(id, 'alice', 'bs_test', 3);
    await vi.waitFor(() =>
      expect(h.recorder.status(id, 'alice', 'bs_test', 3)?.state).toBe('ready'),
    );
    const request = new Request('http://station.test');
    await expect(
      h.recorder.publishTask(id, 'alice', 'bs_test', 3, request),
    ).rejects.toThrow('temporary');
    await expect(
      h.recorder.publishTask(id, 'alice', 'bs_test', 3, request),
    ).resolves.toEqual({ walkthroughId: 'clip' });
    await h.recorder.dispose();
  });

  it('retains a recording while Task publication outlives expiry', async () => {
    const h = fixture();
    let finish!: (value: { walkthroughId: string }) => void;
    let signal!: AbortSignal;
    const publish = vi.fn(({ signal: s }: { signal: AbortSignal }) => {
      signal = s;
      return new Promise<{ walkthroughId: string }>((resolve) => {
        finish = resolve;
      });
    });
    const id = h.recorder.start({
      session: h.session,
      owner: 'alice',
      authorize: async () => true,
      prepareTask: async () => ({
        kind: 'ready',
        clip: { taskId: 'task-a', publish },
      }),
    });
    await vi.waitFor(() => expect(h.canDeliver()).toBe(true));
    vi.useFakeTimers();
    try {
      h.recorder.stop(id, 'alice', 'bs_test', 3);
      await vi.waitFor(() =>
        expect(h.recorder.status(id, 'alice', 'bs_test', 3)?.state).toBe(
          'ready',
        ),
      );
      const pending = h.recorder.publishTask(
        id,
        'alice',
        'bs_test',
        3,
        new Request('http://station.test'),
      )!;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(signal.aborted).toBe(false);
      expect(h.recorder.video(id, 'alice', 'bs_test', 3)).toBeDefined();
      finish({ walkthroughId: 'clip' });
      await expect(pending).resolves.toEqual({ walkthroughId: 'clip' });
      expect(h.recorder.status(id, 'alice', 'bs_test', 3)).toBeUndefined();
    } finally {
      vi.useRealTimers();
      await h.recorder.dispose();
    }
  });

  it('keeps a publishing clip through retention eviction', async () => {
    const h = fixture();
    let finish!: (value: { walkthroughId: string }) => void;
    let signal!: AbortSignal;
    const publish = ({ signal: s }: { signal: AbortSignal }) => {
      signal = s;
      return new Promise<{ walkthroughId: string }>((resolve) => {
        finish = resolve;
      });
    };
    const first = h.recorder.start({
      session: h.session,
      owner: 'alice',
      authorize: async () => true,
      prepareTask: async () => ({
        kind: 'ready',
        clip: { taskId: 'task-a', publish },
      }),
    });
    await vi.waitFor(() => expect(h.canDeliver()).toBe(true));
    h.recorder.stop(first, 'alice', 'bs_test', 3);
    await vi.waitFor(() =>
      expect(h.recorder.status(first, 'alice', 'bs_test', 3)?.state).toBe(
        'ready',
      ),
    );
    const pending = h.recorder.publishTask(
      first,
      'alice',
      'bs_test',
      3,
      new Request('http://station.test'),
    )!;
    for (let i = 0; i < 4; i++) {
      const id = h.recorder.start({
        session: h.session,
        owner: 'alice',
        authorize: async () => true,
      });
      await vi.waitFor(() => expect(h.canDeliver()).toBe(true));
      h.recorder.stop(id, 'alice', 'bs_test', 3);
      await vi.waitFor(() =>
        expect(h.recorder.status(id, 'alice', 'bs_test', 3)?.state).toBe(
          'ready',
        ),
      );
    }
    expect(signal.aborted).toBe(false);
    expect(h.recorder.video(first, 'alice', 'bs_test', 3)).toEqual(
      Buffer.from('webm'),
    );
    finish({ walkthroughId: 'clip' });
    await expect(pending).resolves.toEqual({ walkthroughId: 'clip' });
    await h.recorder.dispose();
  });

  it('cancels a pending Task publication when the recording is discarded', async () => {
    const h = fixture();
    let aborted = false;
    const publish = vi.fn(
      async ({ signal }: { signal: AbortSignal }) =>
        new Promise<{ walkthroughId: string }>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('cancelled'));
            },
            { once: true },
          );
        }),
    );
    const id = h.recorder.start({
      session: h.session,
      owner: 'alice',
      authorize: async () => true,
      prepareTask: async () => ({
        kind: 'ready',
        clip: { taskId: 'task-a', publish },
      }),
    });
    await vi.waitFor(() => expect(h.canDeliver()).toBe(true));
    h.recorder.stop(id, 'alice', 'bs_test', 3);
    await vi.waitFor(() =>
      expect(h.recorder.status(id, 'alice', 'bs_test', 3)?.state).toBe('ready'),
    );
    const publication = h.recorder.publishTask(
      id,
      'alice',
      'bs_test',
      3,
      new Request('http://station.test'),
    )!;
    const rejection = expect(publication).rejects.toThrow('cancelled');
    h.recorder.cancel(id, 'alice', 'bs_test', 3);
    await rejection;
    expect(aborted).toBe(true);
    await h.recorder.dispose();
  });

  it('does not publish if cancelled during encoding', async () => {
    const h = fixture();
    let aborted = false;
    h.encode.mockImplementation(
      async (_binary, _concat, _duration, _max, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(new Error('cancelled'));
            },
            { once: true },
          );
        }),
    );
    const id = h.recorder.start({
      session: h.session,
      owner: 'alice',
      authorize: async () => true,
    });
    await vi.waitFor(() => expect(h.canDeliver()).toBe(true));
    h.recorder.stop(id, 'alice', 'bs_test', 3);
    await vi.waitFor(() =>
      expect(h.recorder.status(id, 'alice', 'bs_test', 3)?.state).toBe(
        'encoding',
      ),
    );
    h.recorder.cancel(id, 'alice', 'bs_test', 3);
    await vi.waitFor(() => expect(aborted).toBe(true));
    expect(h.recorder.video(id, 'alice', 'bs_test', 3)).toBeUndefined();
    await h.recorder.dispose();
  });
});

const ffmpeg = await locateExecutable('ffmpeg', []);
if (!ffmpeg)
  console.warn('SKIP real human Browser encoding: ffmpeg is absent.');
it.skipIf(!ffmpeg)(
  'encodes a human clip through real FFmpeg as WebM',
  async () => {
    const jpeg = execFileSync(
      ffmpeg!,
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=64x64:r=1',
        '-frames:v',
        '1',
        '-f',
        'image2pipe',
        '-vcodec',
        'mjpeg',
        'pipe:1',
      ],
      { windowsHide: true },
    );
    const h = fixture({ ffmpeg: ffmpeg!, jpeg });
    const id = h.recorder.start({
      session: h.session,
      owner: 'alice',
      authorize: async () => true,
    });
    await vi.waitFor(() =>
      expect(h.recorder.status(id, 'alice', 'bs_test', 3)?.state).toBe(
        'recording',
      ),
    );
    h.recorder.stop(id, 'alice', 'bs_test', 3);
    await vi.waitFor(() =>
      expect(h.recorder.status(id, 'alice', 'bs_test', 3)?.state).toBe('ready'),
    );
    const bytes = h.recorder.video(id, 'alice', 'bs_test', 3);
    expect(bytes?.subarray(0, 4)).toEqual(
      Buffer.from([0x1a, 0x45, 0xdf, 0xa3]),
    );
    await h.recorder.dispose();
  },
);
