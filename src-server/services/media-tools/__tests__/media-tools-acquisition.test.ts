import { createHash } from 'node:crypto';
import { readdir, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  createStationHomeBackup,
  createStationHomeUpdateBackup,
  restoreStationHomeBackup,
  restoreStationHomeUpdateBackup,
} from '@kontourai/station-shared/station-home-archive';
import { ensureStationHomeSchemaSync } from '@kontourai/station-shared/station-home-schema';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createFfmpegDecoderProvider } from '../../devices/h264-jpeg-decoder.js';
import { mediaInputPolicy } from '../media-input-policy.js';
import { MediaToolsAcquisition } from '../media-tools-acquisition.js';
import {
  MEDIA_TOOLS_PINS,
  type MediaToolAsset,
  type MediaToolPins,
} from '../media-tools-pins.js';

const makeTempDir = trackTempDirs();

/** Minimal real ustar archive: hostile names must reach the production tar guard. */
function tarEntry(name: string, type = '0', link = ''): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000755\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write('00000000000\0', 124);
  h.write('00000000000\0', 136);
  h.fill(32, 148, 156);
  h.write(type, 156);
  h.write(link, 157, 100);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.write(
    [...h]
      .reduce((n, b) => n + b, 0)
      .toString(8)
      .padStart(6, '0') + '\0 ',
    148,
  );
  return Buffer.concat([h, Buffer.alloc(1024)]);
}
async function harness(
  options: {
    sha?: string;
    bytes?: number;
    archive?: Buffer;
    platform?: NodeJS.Platform;
    arch?: string;
  } = {},
) {
  const home = makeTempDir('station-media-test-');

  const binary = gzipSync('#!/bin/sh\nexit 0\n');
  const bodies = options.archive
    ? [options.archive]
    : [binary, binary, Buffer.from('GPL fixture')];
  const assets: MediaToolAsset[] = bodies.map((b, i) => ({
    url: `https://tools.invalid/${i}`,
    bytes: options.bytes ?? b.length,
    sha256: options.sha ?? createHash('sha256').update(b).digest('hex'),
    format: options.archive ? 'tar.bz2' : i === 2 ? 'file' : 'gzip',
    output: ['ffmpeg', 'ffprobe', 'LICENSE'][i],
  }));
  const pins: MediaToolPins = {
    ...MEDIA_TOOLS_PINS,
    ffmpeg: {
      version: 'fixture',
      builds: {
        'darwin-arm64': { assets, required: ['ffmpeg', 'ffprobe', 'LICENSE'] },
      },
    },
  };
  const fetcher = vi.fn(
    async (url: string | URL | Request) =>
      new Response(
        new Uint8Array(bodies[Number(String(url).split('/').at(-1))]!),
        { headers: {} },
      ),
  );
  const tools = new MediaToolsAcquisition(home, {
    platform: options.platform ?? 'darwin',
    arch: options.arch ?? 'arm64',
    env: {},
    locate: async () => null,
    pins,
    fetch: fetcher,
  });
  return { home, tools, fetcher, pins };
}

describe('media tool acquisition', () => {
  test('status and resolution never touch the network, even repeatedly', async () => {
    const { tools, fetcher } = await harness();
    for (let i = 0; i < 3; i++) {
      expect((await tools.status()).components[0]?.resolution.status).toBe(
        'needs-consent',
      );
      expect((await tools.resolveFfmpeg()).status).toBe('needs-consent');
      expect((await tools.resolveSpeech()).status).toBe('needs-consent');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  test.each([undefined, false, 'true', 1, {}, null])(
    'refuses nonliteral consent %j before I/O',
    async (consent) => {
      const { tools, fetcher, home } = await harness();
      await expect(
        tools.startDownload({ consent } as { consent: true }),
      ).rejects.toThrow('explicit consent');
      expect(fetcher).not.toHaveBeenCalled();
      expect(await readdir(home)).toEqual([]);
    },
  );
  test.each([
    { sha: '0'.repeat(64), message: 'SHA-256 mismatch' },
    { bytes: 1, message: 'byte length mismatch' },
    { bytes: 999, message: 'byte length mismatch' },
  ])(
    'rejects corrupt archive $message ($bytes)',
    async ({ message, ...options }) => {
      const { tools } = await harness(options);
      await (
        await tools.startDownload({ consent: true, components: ['ffmpeg'] })
      ).completion;
      const status = (await tools.status()).components[0]!;
      expect(status.failure).toContain(message);
      expect((await tools.resolveFfmpeg()).status).toBe('needs-consent');
    },
  );
  test.each(['../escape', '/absolute', 'C:/escape', 'a/../../escape'])(
    'refuses archive traversal %s before extraction',
    async (path) => {
      const { tools, home } = await harness({ archive: tarEntry(path) });
      await (
        await tools.startDownload({ consent: true, components: ['ffmpeg'] })
      ).completion;
      expect((await tools.status()).components[0]!.failure).toContain(
        'traversal refused',
      );
      expect(await readdir(join(home, 'media-tools', 'ffmpeg'))).toEqual([]);
    },
  );
  test.each(['2', '1'])(
    'refuses symlink/hardlink escape type %s before extraction',
    async (type) => {
      const { tools } = await harness({
        archive: tarEntry('link', type, '../../escape'),
      });
      await (
        await tools.startDownload({ consent: true, components: ['ffmpeg'] })
      ).completion;
      expect((await tools.status()).components[0]!.failure).toContain(
        'link or special entry refused',
      );
    },
  );
  test('downloaded tools survive a fresh resolver and the device decoder sees downloaded ffmpeg', async () => {
    const { tools, home, pins, fetcher } = await harness();
    await (await tools.startDownload({ consent: true, components: ['ffmpeg'] }))
      .completion;
    expect((await tools.resolveFfmpeg()).status).toBe('ready');
    const downloaded = await new MediaToolsAcquisition(home, {
      platform: 'darwin',
      arch: 'arm64',
      pins,
      env: {},
      locate: async () => null,
      fetch: fetcher,
    }).resolveFfmpeg();
    expect(downloaded).toMatchObject({ status: 'ready', origin: 'downloaded' });
    const decoder = createFfmpegDecoderProvider({ mediaTools: tools });
    expect(await decoder.availability()).toEqual({
      available: true,
      path: join(home, 'media-tools/ffmpeg/fixture/ffmpeg'),
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  test('concurrent consented requests join one physical download', async () => {
    const { tools, fetcher } = await harness();
    const jobs = await Promise.all([
      tools.startDownload({ consent: true, components: ['ffmpeg'] }),
      tools.startDownload({ consent: true, components: ['ffmpeg'] }),
    ]);
    await Promise.all(jobs.map((job) => job.completion));
    expect((await tools.resolveFfmpeg()).status).toBe('ready');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  test('decoder still uses host ffmpeg when ffprobe is not installed', async () => {
    const { home } = await harness();
    const tools = new MediaToolsAcquisition(home, {
      env: {},
      locate: async (name) => (name === 'ffmpeg' ? '/host/bin/ffmpeg' : null),
    });
    const decoder = createFfmpegDecoderProvider({ mediaTools: tools });
    expect(await decoder.availability()).toEqual({
      available: true,
      path: '/host/bin/ffmpeg',
    });
  });
  test('host tools win and Windows arm64 has no downloadable build', async () => {
    const { home, fetcher } = await harness();
    const host = new MediaToolsAcquisition(home, {
      locate: async (name) => `/host/bin/${name}`,
      fetch: fetcher,
    });
    expect(await host.resolveFfmpeg()).toMatchObject({
      status: 'ready',
      origin: 'host',
    });
    const { tools } = await harness({ platform: 'win32', arch: 'arm64' });
    expect(await tools.resolveFfmpeg()).toEqual({
      status: 'unsupported-platform',
      platform: 'win32-arm64',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

test('verified license files are readable without executable permission', async () => {
  const { home, tools } = await harness();
  await (await tools.startDownload({ consent: true, components: ['ffmpeg'] }))
    .completion;
  expect(
    (await stat(join(home, 'media-tools/ffmpeg/fixture/LICENSE'))).mode & 0o777,
  ).toBe(0o600);
});
test('healthy download progress survives five minutes, while an idle download is cancelled', async () => {
  const { tools, fetcher } = await harness();
  const original = fetcher.getMockImplementation()!;
  let stream!: ReadableStreamDefaultController<Uint8Array>,
    signal!: AbortSignal;
  const bytes = gzipSync('#!/bin/sh\nexit 0\n');
  fetcher.mockImplementationOnce(async (_url, init?: RequestInit) => {
    signal = init!.signal!;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          stream = c;
          signal.addEventListener('abort', () => c.error(signal.reason), {
            once: true,
          });
        },
      }),
    );
  });
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
    const c = new AbortController();
    setTimeout(() => c.abort(new DOMException('Timeout', 'TimeoutError')), ms);
    return c.signal;
  });
  try {
    const job = await tools.startDownload({
      consent: true,
      components: ['ffmpeg'],
    });
    await vi.waitFor(() => expect(stream).toBeDefined());
    for (let i = 0; i < 11; i++) {
      stream.enqueue(new Uint8Array(bytes.subarray(i, i + 1)));
      await vi.waitFor(async () =>
        expect(
          (await tools.status()).components[0]!.progress?.receivedBytes,
        ).toBe(i + 1),
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(
        signal.aborted,
        'active progress must not hit the former five-minute total',
      ).toBe(false);
    }
    stream.enqueue(new Uint8Array(bytes.subarray(11)));
    stream.close();
    await job.completion;
    expect((await tools.resolveFfmpeg()).status).toBe('ready');
  } finally {
    timeout.mockRestore();
    vi.useRealTimers();
    fetcher.mockImplementation(original);
  }
  const idle = await harness();
  let idleSignal!: AbortSignal;
  idle.fetcher.mockImplementationOnce(
    async (_url, init?: RequestInit) =>
      new Response(
        new ReadableStream({
          start(c) {
            idleSignal = init!.signal!;
            idleSignal.addEventListener(
              'abort',
              () => c.error(idleSignal.reason),
              { once: true },
            );
          },
        }),
      ),
  );
  vi.useFakeTimers();
  try {
    const job = await idle.tools.startDownload({
      consent: true,
      components: ['ffmpeg'],
    });
    await vi.waitFor(() => expect(idleSignal).toBeDefined());
    await vi.advanceTimersByTimeAsync(60_001);
    expect(idleSignal.aborted).toBe(true);
    await job.completion;
    expect((await idle.tools.status()).components[0]!.failure).toBeDefined();
  } finally {
    vi.useRealTimers();
  }
});

test('pinned Linux AV1 decoder observations remain admitted by the Walkthrough input policy', async () => {
  const observed = JSON.parse(
    await readFile(
      new URL('./fixtures/linux-av1-decoders.json', import.meta.url),
      'utf8',
    ),
  );
  const policy = mediaInputPolicy(true);
  const admitted = policy[policy.indexOf('-codec_whitelist') + 1]!.split(',');
  for (const platform of ['linux-x64', 'linux-arm64'] as const) {
    const current = MEDIA_TOOLS_PINS.ffmpeg.builds[platform]!.assets.filter(
      (asset) => asset.format === 'gzip',
    ).map(({ url, bytes, sha256 }) => ({ url, bytes, sha256 }));
    expect(current, 'changed pins need fresh decoder inspection').toEqual(
      observed.builds[platform],
    );
  }
  expect(admitted).toEqual(expect.arrayContaining(observed.decoders));
});

test.each(['home', 'update'] as const)(
  '%s backup excludes downloaded media tools',
  async (kind) => {
    const { home, tools } = await harness();
    ensureStationHomeSchemaSync(home);
    await (await tools.startDownload({ consent: true, components: ['ffmpeg'] }))
      .completion;
    expect((await tools.resolveFfmpeg()).status).toBe('ready');
    const output = makeTempDir('station-media-backup-');
    const backup =
      kind === 'home'
        ? createStationHomeBackup({
            homeDir: home,
            outputDir: join(output, 'backup'),
          })
        : createStationHomeUpdateBackup({
            homeDir: home,
            backupDir: join(output, 'backup'),
          });
    expect(
      backup.manifest.files.some((file) => file.path[0] === 'media-tools'),
      're-acquirable downloads must not be copied',
    ).toBe(false);
    if (kind === 'home') {
      const restored = join(output, 'restored');
      restoreStationHomeBackup({
        homeDir: restored,
        backupDir: backup.backupDir,
        confirm: true,
      });
      const fresh = new MediaToolsAcquisition(restored, {
        locate: async () => null,
        env: {},
      });
      expect((await fresh.resolveFfmpeg()).status).toBe('needs-consent');
    }
  },
);

test('backup and rollback retain versioned tools and missing tools require consent', async () => {
  const { home, tools, pins, fetcher } = await harness();
  ensureStationHomeSchemaSync(home);
  await (await tools.startDownload({ consent: true, components: ['ffmpeg'] }))
    .completion;
  const before = await tools.resolveFfmpeg();
  expect(before.status).toBe('ready');
  const backupDir = join(makeTempDir('station-media-update-'), 'backup');
  createStationHomeUpdateBackup({ homeDir: home, backupDir });
  const trial = new MediaToolsAcquisition(home, {
    platform: 'darwin',
    arch: 'arm64',
    env: {},
    locate: async () => null,
    fetch: fetcher,
    pins: { ...pins, ffmpeg: { ...pins.ffmpeg, version: 'trial-next' } },
  });
  await (await trial.startDownload({ consent: true, components: ['ffmpeg'] }))
    .completion;
  expect(
    await tools.resolveFfmpeg(),
    'a trial acquisition must not prune the previous pin',
  ).toEqual(before);
  restoreStationHomeUpdateBackup({ homeDir: home, backupDir });
  expect(await tools.resolveFfmpeg()).toEqual(before);
  expect(
    (await trial.resolveFfmpeg()).status,
    'rollback leaves external version directories intact',
  ).toBe('ready');
  if (before.status !== 'ready') throw new Error('fixture install missing');
  await rm(before.paths.ffprobe);
  const calls = fetcher.mock.calls.length;
  expect((await tools.resolveFfmpeg()).status).toBe('needs-consent');
  expect(fetcher.mock.calls).toHaveLength(calls);
});
