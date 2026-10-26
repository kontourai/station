import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ProjectFileTransactions } from '../../../domain/project-file-transactions.js';
import * as hostTools from '../../devices/device-host-tools.js';
import {
  ActionOperationService,
  FileActionOperationStore,
} from '../../operations/action-operation-service.js';
import { WalkthroughService } from '../walkthrough-service.js';

const makeHome = trackTempDirs();
const tools = process.env.STATION_WALKTHROUGH_TEST_FFMPEG_DIR;
async function fixture(home: string, name: string, args: string[]) {
  expect(
    tools &&
      existsSync(join(tools, 'ffmpeg')) &&
      existsSync(join(tools, 'ffprobe')),
    'explicit real-media opt-in requires both binaries',
  ).toBe(true);
  const path = join(home, name);
  await hostTools.runBoundedToolCapture(
    join(tools!, 'ffmpeg'),
    ['-nostdin', '-v', 'error', ...args, path],
    { timeoutMs: 60_000, maxBuffer: 4096 },
  );
  return path;
}
async function importRecording(home: string, path: string) {
  const files = new ProjectFileTransactions(home);
  await files.createProject('alpha', { id: 'alpha', slug: 'alpha' });
  const diagnostics: string[] = [];
  const service = new WalkthroughService({
    files,
    operations: new ActionOperationService(new FileActionOperationStore(home)),
    resolver: {
      resolveFfmpeg: async () => ({
        status: 'ready',
        origin: 'host',
        paths: {
          ffmpeg: join(tools!, 'ffmpeg'),
          ffprobe: join(tools!, 'ffprobe'),
        },
      }),
    },
    transcriber: {
      transcribeFile: async () => ({
        status: 'transcribed',
        durationMs: 12000,
        segments: [],
        engine: { runtime: 'test', model: 'silence' },
      }),
    },
    diagnostic: (e) => diagnostics.push(String(e)),
  });
  const id = randomUUID();
  const actor = { accountId: 'human:local:operator' };
  await service.start({
    projectSlug: 'alpha',
    requestId: id,
    originalName: path.split('/').at(-1)!,
    body: new Blob([await readFile(path)]).stream(),
    actor,
    authorize: async () => {},
  });
  await vi.waitFor(
    async () =>
      expect((await service.status('alpha', id, actor))?.outcome).toBeDefined(),
    { timeout: 30_000, interval: 20 },
  );
  expect(
    (await service.status('alpha', id, actor))?.outcome,
    diagnostics.join('\n'),
  ).toEqual({ status: 'imported', id });
  return (await service.get('alpha', id))!;
}
test.skipIf(!tools)(
  'real AV1 recording imports using the pinned decoder whitelist',
  async () => {
    const home = makeHome('station-av1-');
    const path = await fixture(home, 'av1.webm', [
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x90:rate=5:duration=1',
      '-c:v',
      'libaom-av1',
      '-cpu-used',
      '8',
      '-threads',
      '1',
    ]);
    const manifest = await importRecording(home, path);
    expect(manifest.events.some((e) => e.kind === 'frame')).toBe(true);
  },
  45_000,
);

test.skipIf(!tools)(
  'real duration-tagged WebM bounds frame selection to video when audio outlasts it',
  async () => {
    const home = makeHome('station-webm-duration-');
    const path = await fixture(home, 'short-video.webm', [
      '-f',
      'lavfi',
      '-i',
      'color=c=red:size=160x90:rate=5:duration=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=12',
      '-c:v',
      'libvpx-vp9',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-threads',
      '1',
      '-c:a',
      'libopus',
    ]);
    const probe = JSON.parse(
      await hostTools.runBoundedToolCapture(
        join(tools!, 'ffprobe'),
        [
          '-v',
          'error',
          '-show_entries',
          'format=duration:stream=codec_type,duration:stream_tags=DURATION',
          '-of',
          'json',
          path,
        ],
        { timeoutMs: 15000 },
      ),
    );
    const video = probe.streams.find(
      (s: { codec_type: string }) => s.codec_type === 'video',
    );
    expect(Number(probe.format.duration)).toBeGreaterThan(11);
    expect(video.duration).toBeUndefined();
    expect(video.tags.DURATION).toMatch(/^00:00:03/);
    const manifest = await importRecording(home, path);
    const frames = manifest.events.filter((e) => e.kind === 'frame');
    expect(frames.length).toBeGreaterThan(0);
    expect(
      manifest.frameSelection?.candidates,
      'audio tail must not create frame candidates',
    ).toBe(1);
    expect(frames.every((e) => e.tMs < 3100)).toBe(true);
  },
  45_000,
);

test.skipIf(!tools)(
  'real HEVC ten-minute scene pass with two-second GOP and shifted start stays cheap',
  async () => {
    const home = makeHome('station-hevc-scene-');
    const path = await fixture(home, 'scene.mp4', [
      '-f',
      'lavfi',
      '-i',
      'color=c=red:size=64x64:rate=60:duration=600',
      '-c:v',
      'libx265',
      '-preset',
      'ultrafast',
      '-x265-params',
      'pools=none:frame-threads=1:keyint=120:min-keyint=120:scenecut=0',
      '-threads',
      '1',
      '-output_ts_offset',
      '120',
    ]);
    const decoded = join(home, 'decoded.txt');
    const original = hostTools.runBoundedToolCapture;
    let sceneRan = false;
    const spy = vi
      .spyOn(hostTools, 'runBoundedToolCapture')
      .mockImplementation((command, args, options) => {
        const next = [...args];
        const filter = next.indexOf('-vf') + 1;
        if (filter > 0 && next[filter]!.includes('select=gt(scene')) {
          sceneRan = true;
          // Count actual decoded frames BEFORE fps/scale/select can discard them.
          next[filter] =
            `metadata=mode=add:key=station_decoded:value=1,metadata=print:file=${decoded},${next[filter]}`;
        }
        return original(command, next, options);
      });
    try {
      await importRecording(home, path);
      expect(sceneRan).toBe(true);
      const count =
        (await readFile(decoded, 'utf8')).match(/^frame:/gm)?.length ?? 0;
      expect(count).toBeGreaterThanOrEqual(299);
      expect(count, 'scene pass still decoded every source frame').toBeLessThan(
        325,
      );
    } finally {
      spy.mockRestore();
    }
  },
  45_000,
);

test.skipIf(!tools).each([8, 16])(
  'real %s-second single-keyframe VP8 recording retains all three hard cuts',
  async (duration) => {
    const home = makeHome('station-sparse-scenes-');
    const path = await fixture(home, 'sparse.webm', [
      '-f',
      'lavfi',
      '-i',
      `color=c=red:size=160x90:rate=10:duration=${duration}`,
      '-vf',
      `drawbox=color=blue:t=fill:enable='gte(t,${duration / 4})',drawbox=color=white:t=fill:enable='gte(t,${duration / 2})',drawbox=color=black:t=fill:enable='gte(t,${(duration * 3) / 4})'`,
      '-c:v',
      'libvpx',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-g',
      '10000',
      '-keyint_min',
      '10000',
      '-auto-alt-ref',
      '0',
      '-threads',
      '1',
    ]);
    const keyframes = await hostTools.runBoundedToolCapture(
      join(tools!, 'ffprobe'),
      [
        '-v',
        'error',
        '-skip_frame',
        'nokey',
        '-select_streams',
        'v:0',
        '-show_entries',
        'frame=pts_time',
        '-of',
        'csv=p=0',
        path,
      ],
      { timeoutMs: 15000, maxBuffer: 4096 },
    );
    expect(
      keyframes
        .trim()
        .split('\n')
        .filter((line) => /^\d/.test(line)),
    ).toHaveLength(1);
    const manifest = await importRecording(home, path);
    const cuts = manifest.events.filter(
      (e) => e.kind === 'frame' && e.reasons.includes('scene-change'),
    );
    expect(cuts).toHaveLength(3);
    for (const time of [duration * 250, duration * 500, duration * 750])
      expect(cuts.some((e) => Math.abs(e.tMs - time) <= 250)).toBe(true);
  },
  45_000,
);

test.skipIf(!tools).each(['probe', 'scene', 'all-scenes'])(
  'real recording still publishes after a forced %s timeout',
  async (failure) => {
    const home = makeHome('station-scene-fallback-');
    const path = await fixture(home, 'fallback.webm', [
      '-f',
      'lavfi',
      '-i',
      'color=c=red:size=160x90:rate=10:duration=16',
      '-c:v',
      'libvpx',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-g',
      '10000',
      '-threads',
      '1',
    ]);
    const original = hostTools.runBoundedToolCapture;
    let forced = 0;
    const spy = vi
      .spyOn(hostTools, 'runBoundedToolCapture')
      .mockImplementation((command, args, options) => {
        const timingProbe =
          args.includes('packet=pts_time,flags') ||
          args.includes('frame=pts_time');
        const scene = args.some((a) => a.includes('select=gt(scene'));
        if (
          (failure === 'probe' && timingProbe) ||
          (failure !== 'probe' &&
            scene &&
            (failure === 'all-scenes' || forced === 0))
        ) {
          forced++;
          return original(command, args, { ...options, timeoutMs: 1 });
        }
        return original(command, args, options);
      });
    try {
      const manifest = await importRecording(home, path);
      expect(
        forced,
        'the named real process timeout must be reached',
      ).toBeGreaterThan(0);
      expect(manifest.events.some((e) => e.kind === 'frame')).toBe(true);
    } finally {
      spy.mockRestore();
    }
  },
  45_000,
);

test.skipIf(!tools)(
  'real H264 eight-second GOP recording retains cuts between keyframes',
  async () => {
    const home = makeHome('station-h264-cuts-');
    const path = await fixture(home, 'cuts.mp4', [
      '-f',
      'lavfi',
      '-i',
      'color=c=red:size=160x90:rate=60:duration=24',
      '-vf',
      "drawbox=color=blue:t=fill:enable='gte(t,3)',drawbox=color=white:t=fill:enable='gte(t,13)',drawbox=color=black:t=fill:enable='gte(t,14)'",
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-x264-params',
      'keyint=480:min-keyint=480:scenecut=0',
      '-threads',
      '1',
    ]);
    const manifest = await importRecording(home, path);
    const cuts = manifest.events.filter(
      (e) => e.kind === 'frame' && e.reasons.includes('scene-change'),
    );
    expect(cuts.length).toBeGreaterThanOrEqual(3);
    for (const time of [3000, 13000, 14000])
      expect(cuts.some((e) => Math.abs(e.tMs - time) <= 250)).toBe(true);
  },
  45_000,
);

test.skipIf(!tools).each(['timeout', 'failure', 'empty'] as const)(
  'real sparse recording preserves cheap scene cuts when enrichment returns %s',
  async (failure) => {
    const home = makeHome('station-scene-baseline-');
    const path = await fixture(home, 'baseline.mp4', [
      '-f',
      'lavfi',
      '-i',
      'color=c=red:size=160x90:rate=10:duration=24',
      '-vf',
      "drawbox=color=blue:t=fill:enable='gte(t,8)',drawbox=color=white:t=fill:enable='gte(t,16)'",
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-x264-params',
      'keyint=80:min-keyint=80:scenecut=0:bframes=0',
      '-threads',
      '1',
    ]);
    const original = hostTools.runBoundedToolCapture;
    const passes: string[] = [];
    let baseline = '';
    const spy = vi
      .spyOn(hostTools, 'runBoundedToolCapture')
      .mockImplementation(async (command, args, options) => {
        if (!args.some((arg) => arg.includes('select=gt(scene')))
          return original(command, args, options);
        const mode = args[args.indexOf('-skip_frame') + 1]!;
        passes.push(mode);
        if (mode === 'nokey') {
          expect(options!.timeoutMs).toBeLessThanOrEqual(15_000);
          baseline = await original(command, args, options);
          return baseline;
        }
        if (failure === 'failure') throw new Error('enrichment failed');
        if (failure === 'timeout')
          return original(command, args, { ...options, timeoutMs: 1 });
        return original(
          command,
          args.map((arg) => arg.replace('scene\\,0.3', 'scene\\,1')),
          options,
        );
      });
    try {
      const manifest = await importRecording(home, path);
      expect(passes).toEqual(['nokey', 'noref']);
      const baselineTimes = [...baseline.matchAll(/pts_time:([\d.]+)/g)].map(
        (match) => Number(match[1]) * 1000,
      );
      expect(baselineTimes).toHaveLength(2);
      const cuts = manifest.events.filter(
        (e) => e.kind === 'frame' && e.reasons.includes('scene-change'),
      );
      for (const time of baselineTimes)
        expect(cuts.some((cut) => Math.abs(cut.tMs - time) <= 250)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  },
  45_000,
);

test.skipIf(!tools).each(['partial', 'exhausted'] as const)(
  'scene enrichment shares the cheap pass deadline after %s budget consumption',
  async (failure) => {
    const home = makeHome('station-scene-budget-');
    const path = await fixture(home, 'budget.webm', [
      '-f',
      'lavfi',
      '-i',
      'color=c=red:size=160x90:rate=10:duration=16',
      '-c:v',
      'libvpx',
      '-deadline',
      'realtime',
      '-g',
      '10000',
      '-threads',
      '1',
    ]);
    const original = hostTools.runBoundedToolCapture;
    const now = Date.now.bind(Date);
    let elapsed = 0;
    const clock = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => now() + elapsed);
    const budgets: number[] = [];
    const spy = vi
      .spyOn(hostTools, 'runBoundedToolCapture')
      .mockImplementation(async (command, args, options) => {
        if (!args.some((arg) => arg.includes('select=gt(scene')))
          return original(command, args, options);
        budgets.push(options!.timeoutMs!);
        const result = await original(command, args, options);
        if (budgets.length === 1)
          elapsed += failure === 'partial' ? 30_000 : 38_001;
        return result;
      });
    try {
      const manifest = await importRecording(home, path);
      expect(manifest.events.some((e) => e.kind === 'frame')).toBe(true);
      expect(budgets[0]).toBeLessThanOrEqual(15_000);
      if (failure === 'exhausted') expect(budgets).toHaveLength(1);
      else {
        expect(budgets).toHaveLength(2);
        expect(budgets[1]).toBeLessThanOrEqual(8_000);
      }
    } finally {
      spy.mockRestore();
      clock.mockRestore();
    }
  },
  45_000,
);
