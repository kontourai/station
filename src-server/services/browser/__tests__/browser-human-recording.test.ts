import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { locateExecutable } from '../../devices/device-host-tools.js';
import type { LiveSurfaceRegistry } from '../../live-surface/registry.js';
import { encodeBrowserRecording } from '../../projects/task-browser-recording.js';
import { BrowserHumanRecording } from '../browser-human-recording.js';
import type { BrowserSessionRecord } from '../browser-session-registry.js';

function fixture(real?: { ffmpeg: string; jpeg: Buffer }, frameLimit = 1) {
  const session = {
    browserSessionId: 'bs_test',
    generation: 3,
    state: 'live',
    url: 'https://example.test/',
  } as BrowserSessionRecord;
  let delivered = 0;
  let dispose: (() => Promise<void>) | undefined;
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
      attach: () => ({
        close,
        next: async (signal: AbortSignal) => {
          if (delivered < frameLimit) {
            delivered++;
            return {
              kind: 'frame',
              header: { codec: 'jpeg' },
              body: real?.jpeg ?? new Uint8Array([1, 2, 3]),
            };
          }
          return new Promise<null>((resolve) => {
            if (signal.aborted) resolve(null);
            else
              signal.addEventListener('abort', () => resolve(null), {
                once: true,
              });
          });
        },
      }),
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
  });
  return {
    recorder,
    session,
    close,
    encode,
    stage: () => stage,
    disposeSurface: () => dispose?.(),
  };
}

describe('human Browser recording', () => {
  it('refuses a capture that exceeds the 300-frame bound', async () => {
    const h = fixture(undefined, 301);
    const id = h.recorder.start({
      session: h.session,
      owner: 'alice',
      authorize: async () => true,
    });
    await vi.waitFor(() =>
      expect(h.recorder.status(id, 'alice', 'bs_test', 3)?.state).toBe(
        'failed',
      ),
    );
    expect(h.encode).not.toHaveBeenCalled();
    expect(h.recorder.video(id, 'alice', 'bs_test', 3)).toBeUndefined();
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
    await vi.waitFor(() => expect(h.close).not.toHaveBeenCalled());
    expect(h.recorder.stop(id, 'bob', 'bs_test', 3)).toBe(false);
    expect(h.recorder.stop(id, 'alice', 'bs_test', 3)).toBe(true);
    await vi.waitFor(() =>
      expect(h.recorder.status(id, 'alice', 'bs_test', 3)?.state).toBe('ready'),
    );
    expect(h.encode).toHaveBeenCalledOnce();
    expect(existsSync(h.stage())).toBe(false);
    expect(h.recorder.video(id, 'bob', 'bs_test', 3)).toBeUndefined();
    expect(h.recorder.video(id, 'alice', 'bs_test', 4)).toBeUndefined();
    expect(h.recorder.video(id, 'alice', 'bs_test', 3)?.toString()).toBe(
      'webm',
    );
    expect(h.recorder.video(id, 'alice', 'bs_test', 3)?.toString()).toBe(
      'webm',
    );
    await h.recorder.dispose();
  });
  it('does not publish after authority is revoked or the surface closes', async () => {
    const h = fixture();
    let allowed = true;
    const id = h.recorder.start({
      session: h.session,
      owner: 'alice',
      authorize: async () => allowed,
    });
    await vi.waitFor(() =>
      expect(h.recorder.status(id, 'alice', 'bs_test', 3)?.state).toBe(
        'recording',
      ),
    );
    allowed = false;
    await h.disposeSurface();
    expect(h.recorder.status(id, 'alice', 'bs_test', 3)?.state).toBe('failed');
    expect(h.encode).not.toHaveBeenCalled();
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
