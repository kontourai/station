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
    { timeoutMs: 30_000, maxBuffer: 4096 },
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
  'real HEVC two-minute scene pass stays on the cheap keyframe path',
  async () => {
    const home = makeHome('station-hevc-scene-');
    const path = await fixture(home, 'scene.mp4', [
      '-f',
      'lavfi',
      '-i',
      'color=c=red:size=64x64:rate=60:duration=120',
      '-c:v',
      'libx265',
      '-preset',
      'ultrafast',
      '-x265-params',
      'pools=none:frame-threads=1:keyint=60:min-keyint=60:scenecut=0',
      '-threads',
      '1',
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
      expect(count).toBeGreaterThanOrEqual(119);
      expect(count, 'scene pass still decoded every source frame').toBeLessThan(
        150,
      );
    } finally {
      spy.mockRestore();
    }
  },
  45_000,
);

test.skipIf(!tools)(
  'real sparse-keyframe VP8 recording retains all three hard cuts',
  async () => {
    const home = makeHome('station-sparse-scenes-');
    const path = await fixture(home, 'sparse.webm', [
      '-f',
      'lavfi',
      '-i',
      'color=c=red:size=160x90:rate=10:duration=8',
      '-vf',
      "drawbox=color=blue:t=fill:enable='gte(t,2)',drawbox=color=white:t=fill:enable='gte(t,4)',drawbox=color=black:t=fill:enable='gte(t,6)'",
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
    for (const time of [2000, 4000, 6000])
      expect(cuts.some((e) => Math.abs(e.tMs - time) <= 250)).toBe(true);
  },
  45_000,
);
