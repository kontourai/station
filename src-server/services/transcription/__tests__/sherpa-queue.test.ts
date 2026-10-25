import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ProjectFileTransactions } from '../../../domain/project-file-transactions.js';
import {
  ActionOperationService,
  FileActionOperationStore,
} from '../../operations/action-operation-service.js';
import { WalkthroughService } from '../../walkthroughs/walkthrough-service.js';
import { SherpaTranscriber } from '../sherpa-transcriber.js';

const process = vi.hoisted(() => vi.fn());
const capture = vi.hoisted(() => vi.fn());
vi.mock('../../media-tools/media-process.js', async (original) => ({
  ...(await original<object>()),
  runMediaProcess: process,
}));
vi.mock('../../devices/device-host-tools.js', () => ({
  runBoundedToolCapture: capture,
}));
const temp = trackTempDirs();
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
let entered: ReturnType<typeof deferred>[];
let order: string[];
let active: number;
let peak: number;
let home: string;
let transcriber: SherpaTranscriber;
const resolver = {
  resolveFfmpeg: async () => ({
    status: 'ready' as const,
    origin: 'host' as const,
    paths: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
  }),
};
beforeEach(() => {
  home = temp('station-speech-queue-');
  entered = [];
  order = [];
  active = peak = 0;
  transcriber = new SherpaTranscriber({
    ...resolver,
    resolveSpeech: async () => ({
      status: 'ready',
      origin: 'host',
      paths: {
        executable: 'recognize',
        runtimeDir: home,
        encoder: 'encoder',
        decoder: 'decoder',
        joiner: 'joiner',
        tokens: 'tokens',
      },
    }),
  });
  process.mockReset();
  process.mockImplementation(async (command: string, args: string[]) => {
    if (command === 'ffprobe') {
      if (!args.at(-1)!.endsWith('audio.wav')) order.push(args.at(-1)!);
      return {
        stdout: JSON.stringify({
          format: { duration: '2' },
          streams: [{ codec_type: 'audio' }],
        }),
        stderr: '',
      };
    }
    if (command === 'recognize') {
      active++;
      peak = Math.max(peak, active);
      const gate = deferred();
      entered.push(gate);
      await gate.promise;
      active--;
      return {
        stdout: JSON.stringify({
          text: 'Look here.',
          tokens: ['Look here.'],
          timestamps: [0],
          durations: [1],
        }),
        stderr: '',
      };
    }
    return { stdout: '', stderr: '' };
  });
});
afterEach(() => {
  vi.useRealTimers();
});
async function input(name: string) {
  const path = join(home, name);
  await writeFile(path, 'audio');
  return path;
}
async function release(index: number) {
  await vi.waitFor(() => expect(entered).toHaveLength(index + 1));
  entered[index]!.resolve();
}

test('concurrent real SherpaTranscriber calls serialize the engine in FIFO order', async () => {
  const paths = await Promise.all(['first', 'second', 'third'].map(input));
  const pending = paths.map((inputPath) =>
    transcriber.transcribeFile({ inputPath }),
  );
  await vi.waitFor(() => expect(entered).toHaveLength(1));
  expect(order).toEqual([paths[0]]);
  for (let i = 0; i < paths.length; i++) await release(i);
  expect((await Promise.all(pending)).map((r) => r.status)).toEqual([
    'transcribed',
    'transcribed',
    'transcribed',
  ]);
  expect(order).toEqual(paths);
  expect(peak).toBe(1);
});

test('four waiters are admitted, max+1 is busy, and queued abort frees capacity without running', async () => {
  const path = await input('audio');
  const first = transcriber.transcribeFile({ inputPath: path });
  await vi.waitFor(() => expect(entered).toHaveLength(1));
  const control = new AbortController();
  const waiting = Array.from({ length: 4 }, (_, i) =>
    transcriber.transcribeFile({
      inputPath: path,
      signal: i === 1 ? control.signal : undefined,
    }),
  );
  expect(await transcriber.transcribeFile({ inputPath: path })).toMatchObject({
    status: 'failed',
    reason: 'busy',
  });
  control.abort();
  expect(await waiting[1]).toMatchObject({
    status: 'failed',
    reason: 'aborted',
  });
  expect(entered).toHaveLength(1);
  const replacement = transcriber.transcribeFile({ inputPath: path });
  for (let i = 0; i < 5; i++) await release(i);
  expect(
    (
      await Promise.all([
        first,
        ...waiting.filter((_, i) => i !== 1),
        replacement,
      ])
    ).every((r) => r.status === 'transcribed'),
  ).toBe(true);
  expect(peak).toBe(1);
});

test('the fifteen-minute deadline includes queue time and expires without starting work', async () => {
  const path = await input('audio');
  const first = transcriber.transcribeFile({ inputPath: path });
  await vi.waitFor(() => expect(entered).toHaveLength(1));
  vi.useFakeTimers();
  const waiting = transcriber.transcribeFile({ inputPath: path });
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  expect(await waiting).toMatchObject({ status: 'failed', reason: 'timeout' });
  expect(entered).toHaveLength(1);
  vi.useRealTimers();
  entered[0]!.resolve();
  expect(await first).toMatchObject({ status: 'transcribed' });
});

test.each([true, false])('two overlapping audio imports both publish through the shared real SherpaTranscriber (stream duration=%s)', async (streamDuration) => {
  const files = new ProjectFileTransactions(home);
  await files.createProject('alpha', { id: 'project-alpha', slug: 'alpha' });
  capture.mockReset();
  capture.mockImplementation(async (command: string, args: string[]) => {
    if (command === 'ffprobe')
      return JSON.stringify({
        format: { duration: '2' },
        streams: [
          { codec_type: 'video', width: 640, height: 360, ...(streamDuration ? { duration: '2' } : {}) },
          { codec_type: 'audio' },
        ],
      });
    if (args.at(-1)!.endsWith('.jpg'))
      await writeFile(args.at(-1)!, Buffer.from([255, 216, 1, 255, 217]));
    return '';
  });
  const diagnostic = vi.fn();
  const service = new WalkthroughService({
    files,
    resolver,
    transcriber,
    diagnostic,
    operations: new ActionOperationService(new FileActionOperationStore(home)),
  });
  const actor = { accountId: 'human:local:operator' };
  const ids = [randomUUID(), randomUUID()];
  for (const requestId of ids)
    await service.start({
      projectSlug: 'alpha',
      requestId,
      originalName: 'review.mp4',
      body: new Blob(['video']).stream(),
      actor,
      authorize: async () => {},
    });
  await vi.waitFor(async () => {
    const statuses = await Promise.all(
      ids.map((id) => service.status('alpha', id, actor)),
    );
    expect(statuses.map((s) => s?.operation.progress)).toEqual([
      expect.objectContaining({ code: 'transcribe' }),
      expect.objectContaining({ code: 'transcribe' }),
    ]);
  });
  expect(entered).toHaveLength(1);
  await release(0);
  await release(1);
  await vi.waitFor(
    async () => {
      for (const id of ids)
        expect(
          (await service.status('alpha', id, actor))?.outcome,
        ).toMatchObject({ status: 'imported' });
    },
    { timeout: 5000 },
  );
  expect(peak).toBe(1);
  expect(diagnostic).not.toHaveBeenCalled();
});
