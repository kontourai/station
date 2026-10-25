import { randomUUID } from 'node:crypto';
import { existsSync, openAsBlob } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import {
  getWalkthrough,
  getWalkthroughFrame,
  getWalkthroughImport,
  importWalkthrough,
} from '@kontourai/station-sdk/client';
import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ProjectFileTransactions } from '../../../domain/project-file-transactions.js';
import { createWalkthroughRoutes } from '../../../routes/walkthroughs.js';
import {
  locateExecutable,
  runBoundedToolCapture,
} from '../../devices/device-host-tools.js';
import {
  ActionOperationService,
  FileActionOperationStore,
} from '../../operations/action-operation-service.js';
import { WalkthroughService } from '../walkthrough-service.js';

const makeTempDir = trackTempDirs();
const override = process.env.STATION_WALKTHROUGH_TEST_FFMPEG_DIR;
const ffmpeg = override
  ? join(override, 'ffmpeg')
  : await locateExecutable('ffmpeg', []);
const ffprobe = override
  ? join(override, 'ffprobe')
  : await locateExecutable('ffprobe', []);
const ready =
  !!ffmpeg && !!ffprobe && existsSync(ffmpeg) && existsSync(ffprobe);
if (!ready)
  console.warn(
    'SKIP real Walkthrough video pipeline: ffmpeg/ffprobe absent; set STATION_WALKTHROUGH_TEST_FFMPEG_DIR to explicit installed test tools.',
  );

test.skipIf(!ready)(
  'real FFmpeg upload → probe → scene selection → JPEG → atomic manifest, with timestamped fake transcription',
  async () => {
    const home = makeTempDir('station-walkthrough-video-');
    let server: ReturnType<typeof serve> | undefined;
    try {
      const video = join(home, 'review.mp4');
      const narration = '/tmp/fbspike/n.wav';
      const audio = existsSync(narration)
        ? ['-i', narration]
        : ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=14'];
      await runBoundedToolCapture(
        ffmpeg!,
        [
          '-nostdin',
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=red:s=640x360:r=10:d=7',
          '-f',
          'lavfi',
          '-i',
          'color=c=blue:s=640x360:r=10:d=7',
          ...audio,
          '-filter_complex',
          '[0:v][1:v]concat=n=2:v=1:a=0[v]',
          '-map',
          '[v]',
          '-map',
          '2:a',
          '-c:v',
          'libx264',
          '-threads',
          '1',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-t',
          '14',
          video,
        ],
        { timeoutMs: 30000, maxBuffer: 4096 },
      );
      const files = new ProjectFileTransactions(home);
      await files.createProject('alpha', {
        id: 'project-alpha',
        slug: 'alpha',
      });
      const operations = new ActionOperationService(
        new FileActionOperationStore(home),
      );
      const phases: string[] = [];
      const original = operations.update.bind(operations);
      vi.spyOn(operations, 'update').mockImplementation(async (...args) => {
        const result = await original(...args);
        if (
          result.kind === 'updated' &&
          result.operation.progress.kind === 'phase'
        )
          phases.push(result.operation.progress.code);
        return result;
      });
      const service = new WalkthroughService({
        files,
        operations,
        resolver: {
          resolveFfmpeg: async () => ({
            status: 'ready',
            origin: 'host',
            paths: { ffmpeg: ffmpeg!, ffprobe: ffprobe! },
          }),
        },
        transcriber: {
          transcribeFile: async ({ inputPath }) => {
            expect(existsSync(inputPath)).toBe(true);
            return {
              status: 'transcribed',
              durationMs: 14000,
              engine: { runtime: 'test', model: 'timestamp-fixture' },
              segments: [
                {
                  startMs: 1760,
                  endMs: 13000,
                  text: 'This is a test. Look here. That.',
                  tokens: [
                    { startMs: 1760, endMs: 1900, text: 'This' },
                    { startMs: 6000, endMs: 6080, text: ' test.' },
                    { startMs: 7920, endMs: 8100, text: ' A' },
                    { startMs: 9520, endMs: 9650, text: ' L' },
                    { startMs: 9680, endMs: 9800, text: 'ook' },
                    { startMs: 10240, endMs: 10400, text: ' here.' },
                    { startMs: 12720, endMs: 13000, text: ' That.' },
                  ],
                },
              ],
            };
          },
        },
        diagnostic: (error) => {
          throw error;
        },
      });
      const app = new Hono();
      app.route(
        '/api/projects/:projectSlug/walkthroughs',
        createWalkthroughRoutes({
          service,
          preview: { select: (branches) => branches.enabled() },
          project: () => ({ id: 'project-alpha' }),
          authorize: async () => ({ kind: 'operator' }),
          actor: () => ({ accountId: 'human:local:operator' }),
          diagnostic: (error) => {
            throw error;
          },
        }),
      );
      const base = await new Promise<string>((resolve) => {
        server = serve(
          { fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
          (info) => resolve(`http://127.0.0.1:${info.port}`),
        );
      });
      const requestId = randomUUID();
      const initial = await importWalkthrough(
        base,
        'alpha',
        await openAsBlob(video),
        'review.mp4',
        requestId,
      );
      expect(initial.operation.status).toBe('accepted');
      let outcome: unknown;
      await vi.waitFor(
        async () => {
          const status = await getWalkthroughImport(base, 'alpha', requestId);
          outcome = status.outcome;
          expect(status.outcome?.status).toBe('imported');
        },
        { timeout: 30000, interval: 50 },
      );
      expect(outcome).toEqual({ status: 'imported', id: requestId });
      const manifest = await getWalkthrough(base, 'alpha', requestId);
      const frames = manifest.events.filter((e) => e.kind === 'frame');
      expect(
        frames.filter((f) => f.reasons.includes('deictic')).map((f) => f.tMs),
      ).toEqual([1760, 9520, 10240, 12720]);
      expect(
        frames.some(
          (f) =>
            f.reasons.includes('scene-change') && Math.abs(f.tMs - 7000) < 150,
        ),
      ).toBe(true);
      expect(
        frames.some((f) => f.reasons.includes('pause') && f.tMs === 6280),
      ).toBe(true);
      expect(manifest.frameSelection?.candidates).toBeGreaterThanOrEqual(
        frames.length,
      );
      for (const frame of frames) {
        const bytes = await getWalkthroughFrame(
          base,
          'alpha',
          requestId,
          frame.frameId,
        );
        expect([...bytes.slice(0, 2)]).toEqual([255, 216]);
        expect([...bytes.slice(-2)]).toEqual([255, 217]);
        const probe = JSON.parse(
          await runBoundedToolCapture(
            ffprobe!,
            [
              '-v',
              'error',
              '-show_entries',
              'stream=width,height',
              '-of',
              'json',
              join(
                home,
                'projects',
                'alpha',
                'walkthroughs',
                requestId,
                frame.file,
              ),
            ],
            { timeoutMs: 15000 },
          ),
        );
        expect(probe.streams[0]).toMatchObject({ width: 640, height: 360 });
      }
      expect(phases).toEqual(
        expect.arrayContaining(['probe', 'transcribe', 'frames', 'write']),
      );
      expect(
        (await readdir(join(home, 'projects', 'alpha', 'walkthroughs'))).some(
          (n) => n.startsWith('.pending-'),
        ),
      ).toBe(false);
    } finally {
      await new Promise<void>((resolve) =>
        server ? server.close(() => resolve()) : resolve(),
      );
    }
  },
  60000,
);
