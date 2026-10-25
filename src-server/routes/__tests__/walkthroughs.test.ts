import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseWalkthrough,
  WALKTHROUGH_LIMITS,
  type Walkthrough,
  type WalkthroughImportStatus,
  type WalkthroughPage,
} from '@kontourai/station-contracts/walkthrough';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { ProjectFileTransactions } from '../../domain/project-file-transactions.js';
import { bindLocalMediaPreviews } from '../../runtime/bootstrap/local-media-runtime.js';
import { createBrowserProjectAuthorizer } from '../../services/browser/browser-access.js';
import { FeaturePreviewRegistry } from '../../services/feature-previews/feature-preview-registry.js';
import type { MediaToolsResolver } from '../../services/media-tools/media-tools-resolver.js';
import {
  ActionOperationService,
  FileActionOperationStore,
} from '../../services/operations/action-operation-service.js';
import type {
  Transcriber,
  TranscriptionResult,
} from '../../services/transcription/transcriber.js';
import { WalkthroughService } from '../../services/walkthroughs/walkthrough-service.js';
import { createLogger } from '../../utils/logger.js';
import { createWalkthroughRoutes } from '../walkthroughs.js';

const makeTempDir = trackTempDirs();
const capture = vi.hoisted(() => vi.fn());
vi.mock('../../services/devices/device-host-tools.js', () => ({
  runBoundedToolCapture: capture,
}));
const ACTOR = { accountId: 'human:local:operator' };
const JPEG = Buffer.from([255, 216, 1, 2, 255, 217]);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
let home: string, app: Hono, service: WalkthroughService;
let previews: FeaturePreviewRegistry;
let resolver: MediaToolsResolver, transcriber: Transcriber;
let audio: boolean,
  frameGate: ReturnType<typeof deferred> | undefined,
  frameEntered: ReturnType<typeof deferred>,
  frameFailure: boolean;
let transcription: TranscriptionResult;
let videoDuration: string | undefined,
  formatDuration: string | undefined,
  missingFrame: boolean;
let operations: ActionOperationService;
let projectId = 'project-a';
let authorizations: { id: string; purpose: string }[];
const diagnostics: unknown[] = [];
beforeEach(async () => {
  home = makeTempDir('station-walkthrough-');
  previews = new FeaturePreviewRegistry(
    home,
    createLogger({ name: 'walkthrough-test', level: 'error' }),
  );
  const { walkthroughsPreview } = bindLocalMediaPreviews(previews);
  await previews.setEnabled('walkthroughs', true);
  audio = true;
  videoDuration = undefined;
  formatDuration = '14';
  missingFrame = false;
  frameFailure = false;
  frameGate = undefined;
  frameEntered = deferred();
  projectId = 'project-a';
  authorizations = [];
  diagnostics.length = 0;
  const files = new ProjectFileTransactions(home);
  await files.createProject('alpha', { id: projectId, slug: 'alpha' });
  transcription = {
    status: 'transcribed',
    durationMs: 14000,
    engine: { runtime: 'fake', model: 'fake' },
    segments: [
      {
        startMs: 1000,
        endMs: 1100,
        text: 'This',
        tokens: [{ startMs: 1000, endMs: 1100, text: 'This' }],
      },
    ],
  };
  resolver = {
    resolveFfmpeg: vi.fn<MediaToolsResolver['resolveFfmpeg']>(async () => ({
      status: 'ready',
      origin: 'host',
      paths: { ffmpeg: '/fake/ffmpeg', ffprobe: '/fake/ffprobe' },
    })),
  };
  transcriber = { transcribeFile: vi.fn(async () => transcription) };
  capture.mockReset();
  capture.mockImplementation(async (command: string, args: string[]) => {
    if (command.endsWith('ffprobe'))
      return JSON.stringify({
        format: { duration: formatDuration },
        streams: [
          {
            codec_type: 'video',
            width: 1920,
            height: 1080,
            duration: videoDuration ?? formatDuration,
          },
          ...(audio ? [{ codec_type: 'audio' }] : []),
        ],
      });
    const out = args.at(-1)!;
    if (out.endsWith('.jpg')) {
      frameEntered.resolve();
      await frameGate?.promise;
      if (frameFailure) throw new Error('frame extraction failed');
      if (
        !missingFrame &&
        (videoDuration === undefined ||
          Number(args[args.indexOf('-ss') + 1]) < Number(videoDuration))
      )
        await writeFile(out, JPEG);
      return '';
    }
    return 'frame:1 pts:100 pts_time:7\nlavfi.scene_score=1';
  });
  operations = new ActionOperationService(new FileActionOperationStore(home));
  service = new WalkthroughService({
    files,
    resolver,
    transcriber,
    operations,
    diagnostic: (e) => diagnostics.push(e),
  });
  const authorize = createBrowserProjectAuthorizer({
    operator: async (request) => {
      if (request.headers.get('x-test-operator') !== 'yes')
        throw new Error('refused');
    },
    authority: () => {
      throw new Error('membership absent');
    },
  });
  app = new Hono();
  app.route(
    '/api/projects/:projectSlug/walkthroughs',
    createWalkthroughRoutes({
      service,
      preview: walkthroughsPreview,
      project: (slug) => (slug === 'alpha' ? { id: projectId } : undefined),
      authorize: async (request, id, purpose) => {
        authorizations.push({ id, purpose });
        return authorize(request, id, purpose);
      },
      actor: () => ACTOR,
      diagnostic: (e) => diagnostics.push(e),
    }),
  );
});
afterEach(async () => {
  frameGate?.resolve();
  await vi.waitFor(
    async () => {
      const entries = await readdir(
        join(home, 'projects', 'alpha', 'walkthroughs'),
      ).catch(() => []);
      expect(entries.filter((e) => e.startsWith('.pending-'))).toEqual([]);
    },
    { timeout: 5000 },
  );
});
const base = '/api/projects/alpha/walkthroughs';
async function request(
  path: string,
  init: RequestInit = {},
  authorized = true,
) {
  return app.request(path, {
    ...init,
    headers: {
      ...(authorized ? { 'x-test-operator': 'yes' } : {}),
      ...init.headers,
    },
  });
}
async function start(id = randomUUID()) {
  const response = await request(`${base}/import?filename=review.mp4`, {
    method: 'POST',
    body: Buffer.from('uploaded video'),
    headers: { 'x-walkthrough-request-id': id },
  });
  return { response, id };
}
async function data<T>(response: Response): Promise<T> {
  const envelope = (await response.json()) as { data: T };
  return envelope.data;
}
async function settled(id: string) {
  let result: WalkthroughImportStatus | undefined;
  await vi.waitFor(
    async () => {
      const response = await request(`${base}/imports/${id}`);
      expect(response.status).toBe(200);
      result = await data<WalkthroughImportStatus>(response);
      expect(result.outcome).toBeDefined();
    },
    { timeout: 5000 },
  );
  if (!result?.outcome) throw new Error('Import outcome missing');
  return { operation: result.operation, outcome: result.outcome };
}

describe('Walkthrough route → service → Project storage', () => {
  test('keeps partial and failed directories invisible until atomic publication', async () => {
    frameGate = deferred();
    const first = await start();
    expect(first.response.status).toBe(202);
    await frameEntered.promise;
    expect((await request(base)).status).toBe(200);
    expect((await data<WalkthroughPage>(await request(base))).items).toEqual(
      [],
    );
    expect((await request(`${base}/${first.id}`)).status).toBe(404);
    frameGate.resolve();
    const status = await settled(first.id);
    expect(status.outcome).toEqual({ status: 'imported', id: first.id });
    expect(status.operation.status).toBe('succeeded');
    const manifest = parseWalkthrough(
      await data<unknown>(await request(`${base}/${first.id}`)),
    );
    expect(manifest.capture).toEqual({
      platform: 'unknown',
      width: 1920,
      height: 1080,
    });
    const frames = manifest.events.filter((e) => e.kind === 'frame');
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]!.width).toBe(1280);
    const image = await request(
      `${base}/${first.id}/frames/${frames[0]!.frameId}`,
    );
    expect(image.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await image.arrayBuffer())).toEqual(JPEG);
    expect(
      JSON.parse(
        await readFile(
          join(
            home,
            'projects',
            'alpha',
            'walkthroughs',
            first.id,
            'manifest.json',
          ),
          'utf8',
        ),
      ),
    ).toEqual(manifest);
    expect(
      authorizations.some((a) => a.purpose === 'drive' && a.id === 'project-a'),
    ).toBe(true);
    expect(authorizations.some((a) => a.purpose === 'view')).toBe(true);
    frameFailure = true;
    frameGate = undefined;
    const failed = await start();
    expect((await settled(failed.id)).outcome.status).toBe('failed');
    expect((await request(`${base}/${failed.id}`)).status).toBe(404);
    expect(
      (await data<WalkthroughPage>(await request(base))).items.map(
        (v: { id: string }) => v.id,
      ),
    ).toEqual([first.id]);
  });
  test('respects portrait display rotation before capping frame dimensions', async () => {
    capture.mockImplementation(async (command: string, args: string[]) => {
      if (command.endsWith('ffprobe'))
        return JSON.stringify({
          format: { duration: 1 },
          streams: [
            {
              codec_type: 'video',
              width: 1920,
              height: 1080,
              side_data_list: [{ rotation: 90 }],
            },
          ],
        });
      const target = args.at(-1)!;
      if (target.endsWith('.jpg')) await writeFile(target, JPEG);
      return '';
    });
    const imported = await start();
    expect((await settled(imported.id)).outcome.status).toBe('imported');
    const manifest = await data<Walkthrough>(
      await request(`${base}/${imported.id}`),
    );
    expect(manifest.capture).toMatchObject({ width: 1080, height: 1920 });
    expect(manifest.events.find((e) => e.kind === 'frame')).toMatchObject({
      width: 720,
      height: 1280,
    });
  });
  test('project authorization refuses every surface before accessing recordings', async () => {
    const id = randomUUID();
    for (const [path, init] of [
      [base, {}],
      [`${base}/${id}`, {}],
      [`${base}/${id}/frames/f`, {}],
      [`${base}/imports/${id}`, {}],
      [
        `${base}/import?filename=x.mp4`,
        {
          method: 'POST',
          body: 'video',
          headers: { 'x-walkthrough-request-id': id },
        },
      ],
    ] as [string, RequestInit][]) {
      const result = await request(path, init, false);
      expect([path, result.status]).toEqual([path, 403]);
    }
    expect(capture).not.toHaveBeenCalled();
    expect((await request('/api/projects/missing/walkthroughs')).status).toBe(
      404,
    );
  });
  test.each(['resolver', 'transcriber'] as const)(
    'returns typed %s unavailable with downloads and never publishes',
    async (dependency) => {
      const downloads = [
        { component: 'speech-model', version: '1', bytes: 1234 },
      ];
      if (dependency === 'resolver')
        vi.mocked(resolver.resolveFfmpeg).mockResolvedValue({
          status: 'needs-consent',
          downloads,
        });
      else
        transcription = {
          status: 'unavailable',
          reason: 'needs-consent',
          downloads,
        };
      const { id, response } = await start();
      expect(response.status).toBe(202);
      const result = await settled(id);
      expect(result.outcome).toEqual({
        status: 'unavailable',
        reason: 'needs-consent',
        downloads,
      });
      expect(result.operation.status).toBe('failed');
      expect((await request(`${base}/${id}`)).status).toBe(404);
    },
  );
  test('silent video declares transcript absent; failed transcription is not empty success', async () => {
    audio = false;
    const silent = await start();
    expect((await settled(silent.id)).outcome.status).toBe('imported');
    const manifest = await data<Walkthrough>(
      await request(`${base}/${silent.id}`),
    );
    expect(manifest.coverage.transcript).toBe('absent');
    expect(
      manifest.events.every((e: { kind: string }) => e.kind !== 'transcript'),
    ).toBe(true);
    audio = true;
    transcription = {
      status: 'failed',
      reason: 'engine-error',
      message: 'private engine diagnostic',
    };
    const failed = await start();
    expect((await settled(failed.id)).outcome).toEqual({
      status: 'failed',
      reason: 'Transcription engine-error',
    });
  });
  test('deduplicates an in-flight request, caps parallel imports, and rechecks Project identity', async () => {
    frameGate = deferred();
    const id = randomUUID();
    const [a, b] = await Promise.all([start(id), start(id)]);
    expect(a.response.status).toBe(202);
    expect(b.response.status).toBe(202);
    expect((await data<WalkthroughImportStatus>(a.response)).operation.id).toBe(
      (await data<WalkthroughImportStatus>(b.response)).operation.id,
    );
    const second = await start();
    expect(second.response.status).toBe(202);
    const third = await start();
    expect(third.response.status).toBe(503);
    projectId = 'replacement-project';
    frameGate.resolve();
    expect((await settled(id)).outcome.status).toBe('failed');
    expect((await settled(second.id)).outcome.status).toBe('failed');
    expect((await data<WalkthroughPage>(await request(base))).items).toEqual(
      [],
    );
  });
  test('refuses excessive uploads, long video, traversal names, and page bounds', async () => {
    const id = randomUUID();
    expect(
      (
        await request(`${base}/import?filename=x.mp4`, {
          method: 'POST',
          body: 'x',
          headers: {
            'x-walkthrough-request-id': id,
            'content-length': String(WALKTHROUGH_LIMITS.uploadBytes + 1),
          },
        })
      ).status,
    ).toBe(413);
    expect(
      (
        await request(`${base}/import?filename=..%2Fx.mp4`, {
          method: 'POST',
          body: 'x',
          headers: { 'x-walkthrough-request-id': id },
        })
      ).status,
    ).toBe(400);
    expect((await request(`${base}?limit=51`)).status).toBe(400);
    capture.mockImplementation(async () =>
      JSON.stringify({
        format: { duration: 1801 },
        streams: [{ codec_type: 'video', width: 100, height: 100 }],
      }),
    );
    const longer = await start();
    expect((await settled(longer.id)).outcome).toEqual({
      status: 'failed',
      reason: 'Invalid video or duration/dimension limit exceeded',
    });
  });
  test('restart reconciles a stored operation without claiming missing output succeeded', async () => {
    await mkdir(join(home, 'projects', 'alpha', 'walkthroughs', '.imports'), {
      recursive: true,
    });
    const operations = new ActionOperationService(
      new FileActionOperationStore(home),
    );
    const id = randomUUID();
    await mkdir(
      join(home, 'projects', 'alpha', 'walkthroughs', `.pending-${id}`),
      { recursive: true },
    );
    await writeFile(
      join(
        home,
        'projects',
        'alpha',
        'walkthroughs',
        `.pending-${id}`,
        'input',
      ),
      'interrupted recording',
    );
    const operation = await operations.create(ACTOR, {
      scope: ACTOR,
      title: 'Import Walkthrough',
      cancellation: 'unsupported',
      domain: {
        kind: 'walkthrough-import',
        projectSlug: 'alpha',
        walkthroughId: id,
      },
      reentry: { kind: 'walkthrough', projectSlug: 'alpha', walkthroughId: id },
    });
    await writeFile(
      join(home, 'projects', 'alpha', 'walkthroughs', '.imports', `${id}.json`),
      JSON.stringify({ operation }),
    );
    expect((await settled(id)).outcome).toEqual({
      status: 'failed',
      reason: 'Import interrupted; submit a new request id',
    });
  });
});

test('walkthroughs gates every route including import with no off-state side effects and live toggles', async () => {
  await previews.setEnabled('walkthroughs', false);
  const spies = [
    vi.spyOn(service, 'start'),
    vi.spyOn(service, 'status'),
    vi.spyOn(service, 'list'),
    vi.spyOn(service, 'get'),
    vi.spyOn(service, 'frame'),
  ];
  const refused = async () => {
    const imported = await start();
    const responses = [
      imported.response,
      ...(await Promise.all([
        request(base),
        request(`${base}/${imported.id}`),
        request(`${base}/${imported.id}/frames/f1`),
        request(`${base}/imports/${imported.id}`),
      ])),
    ];
    for (const response of responses) {
      expect(
        response.status,
        'walkthroughs must refuse every route while off',
      ).toBe(404);
      expect(await response.json()).toMatchObject({
        success: false,
        code: 'feature_preview_disabled',
        previewId: 'walkthroughs',
        settingsPath:
          '/settings?view=feature-previews&highlight=feature-previews',
      });
    }
  };
  await refused();
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  expect(resolver.resolveFfmpeg).not.toHaveBeenCalled();
  expect(transcriber.transcribeFile).not.toHaveBeenCalled();
  await expect(
    readdir(join(home, 'projects', 'alpha', 'walkthroughs')),
  ).rejects.toThrow();
  await previews.setEnabled('local-speech', true);
  await refused();
  await previews.setEnabled('walkthroughs', true);
  const imported = await start();
  expect(imported.response.status).toBe(202);
  expect((await settled(imported.id)).outcome.status).toBe('imported');
  for (const spy of spies) spy.mockClear();
  await previews.setEnabled('walkthroughs', false);
  await refused();
  await writeFile(join(home, 'config', 'feature-previews.json'), '{broken');
  await refused();
  for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});

test('disabling an admitted import prevents publication and preserves its failed receipt', async () => {
  frameGate = deferred();
  const imported = await start();
  expect(imported.response.status).toBe(202);
  await frameEntered.promise;
  await previews.setEnabled('walkthroughs', false);
  frameGate.resolve();
  await vi.waitFor(
    async () => {
      const status = await service.status('alpha', imported.id, ACTOR);
      expect(status?.outcome?.status).toBe('failed');
    },
    { timeout: 5000 },
  );
  expect((await request(`${base}/imports/${imported.id}`)).status).toBe(404);
  await expect(
    readdir(join(home, 'projects', 'alpha', 'walkthroughs', imported.id)),
  ).rejects.toThrow();
  const restarted = new FeaturePreviewRegistry(
    home,
    createLogger({ name: 'preview-restart', level: 'error' }),
  );
  const { walkthroughsPreview } = bindLocalMediaPreviews(restarted);
  const appAfterRestart = new Hono().route(
    '/api/projects/:projectSlug/walkthroughs',
    createWalkthroughRoutes({
      service,
      preview: walkthroughsPreview,
      project: () => ({ id: projectId }),
      authorize: async () => ({ kind: 'operator' }),
      actor: () => ACTOR,
      diagnostic: () => {},
    }),
  );
  expect((await appAfterRestart.request(base)).status).toBe(404);
  await restarted.setEnabled('walkthroughs', true);
  const status = await data<WalkthroughImportStatus>(
    await request(`${base}/imports/${imported.id}`),
  );
  expect(status.outcome?.status).toBe('failed');
  expect((await appAfterRestart.request(base)).status).toBe(200);
});

test('audio outlasting video bounds frame selection and tolerates a missing trailing JPEG', async () => {
  videoDuration = '5';
  const { id, response } = await start();
  expect(response.status).toBe(202);
  expect((await settled(id)).outcome).toEqual({ status: 'imported', id });
  const manifest = await service.get('alpha', id);
  expect(manifest).not.toBeNull();
  const frames = manifest!.events.filter((e) => e.kind === 'frame');
  expect(frames.every((f) => f.tMs < 5000)).toBe(true);
  const seeks = capture.mock.calls
    .filter(([, args]) => args.at(-1).endsWith('.jpg'))
    .map(([, args]) => Number(args[args.indexOf('-ss') + 1]));
  expect(Math.max(...seeks)).toBeLessThan(5);
  expect(manifest!.source.durationMs).toBe(14000);
  expect(manifest!.frameSelection!.kept).toBe(frames.length);
  for (const frame of frames)
    expect(await service.frame('alpha', id, frame.frameId)).toEqual(JPEG);
});
test('missing frame output is skipped and zero decoded frames fails without publication', async () => {
  const original = capture.getMockImplementation()!;
  let skipped = false;
  capture.mockImplementation(async (command: string, args: string[]) => {
    if (args.at(-1)!.endsWith('.jpg') && !skipped) {
      skipped = true;
      return '';
    }
    return original(command, args);
  });
  const { id } = await start();
  expect((await settled(id)).outcome.status).toBe('imported');
  const manifest = (await service.get('alpha', id))!;
  expect(manifest.frameSelection!.kept).toBe(
    manifest.events.filter((e) => e.kind === 'frame').length,
  );
  expect(manifest.coverage.frames).toBe('present');
  missingFrame = true;
  const empty = await start();
  expect((await settled(empty.id)).outcome).toMatchObject({
    status: 'failed',
    reason: expect.stringContaining('No video frames'),
  });
  expect(await service.get('alpha', empty.id)).toBeNull();
});
test('an admitted import retries a busy dictation queue then publishes once', async () => {
  vi.mocked(transcriber.transcribeFile).mockResolvedValueOnce({
    status: 'failed',
    reason: 'busy',
    message: 'full',
  });
  const { id } = await start();
  expect((await settled(id)).outcome).toEqual({ status: 'imported', id });
  expect(transcriber.transcribeFile).toHaveBeenCalledTimes(2);
});
test('receipt write failure after operation creation terminalizes the operation', async () => {
  const create = operations.create.bind(operations);
  let operationId = '';
  vi.spyOn(operations, 'create').mockImplementation(async (...args) => {
    const op = await create(...args);
    operationId = op!.id;
    await mkdir(
      join(
        home,
        'projects',
        'alpha',
        'walkthroughs',
        '.imports',
        `${args[1].domain.kind === 'walkthrough-import' ? args[1].domain.walkthroughId : ''}.json`,
      ),
      { recursive: true },
    );
    return op;
  });
  const { response } = await start();
  expect(response.status).toBe(503);
  expect((await operations.get(ACTOR, operationId))?.status).toBe('failed');
});

test('long-video scene work is sampled and deadlines scale with duration', async () => {
  audio = false;
  formatDuration = '1800';
  videoDuration = '1800';
  const { id } = await start();
  expect((await settled(id)).outcome.status).toBe('imported');
  const scenes = capture.mock.calls.find(
    ([, args]) =>
      args.includes('-vf') && args.some((a: string) => a.includes('select=')),
  )!;
  expect(scenes[1][scenes[1].indexOf('-vf') + 1]).toContain(
    "fps=5,scale='min(640,iw)':'min(640,ih)':force_original_aspect_ratio=decrease",
  );
  expect(scenes[2].timeoutMs).toBeGreaterThan(120_000);
  expect(scenes[2].timeoutMs).toBeLessThanOrEqual(300_000);
  const frame = capture.mock.calls.find(([, args]) =>
    args.at(-1).endsWith('.jpg'),
  )!;
  expect(frame[2].timeoutMs).toBeGreaterThan(15_000);
  expect(frame[2].timeoutMs).toBeLessThanOrEqual(90_000);
});

test.each(['idle', 'abort'] as const)(
  'upload %s releases its admission and deletes staging',
  async (kind) => {
    const read = deferred();
    let cancelled = false;
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>(
      {
        start(c) {
          stream = c;
        },
        pull() {
          read.resolve();
          return new Promise(() => {});
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const controller = new AbortController();
    const id = randomUUID();
    vi.useFakeTimers();
    const pending = Promise.resolve(
      app.request(
        new Request(`http://station.test${base}/import?filename=review.mp4`, {
          method: 'POST',
          headers: { 'x-test-operator': 'yes', 'x-walkthrough-request-id': id },
          body,
          signal: controller.signal,
          duplex: 'half',
        } as RequestInit),
      ),
    );
    let response: Response | undefined;
    void pending.then((r) => {
      response = r;
    });
    try {
      await vi.waitFor(() => expect(body.locked).toBe(true));
      await read.promise;
      if (kind === 'abort') controller.abort();
      else await vi.advanceTimersByTimeAsync(60_001);
      await vi.waitFor(() => expect(response).toBeDefined(), { timeout: 1000 });
      expect(response!.status).toBe(kind === 'abort' ? 400 : 408);
      expect(cancelled).toBe(true);
    } finally {
      controller.abort();
      try {
        stream.error(new Error('fixture cleanup'));
      } catch {}
      vi.useRealTimers();
      await pending;
    }
    frameGate = deferred();
    const admitted = await Promise.all([start(), start()]);
    expect(admitted.map(({ response }) => response.status)).toEqual([202, 202]);
  },
);

test('manifest reads allocate for the actual file size within the manifest ceiling', async () => {
  const { id } = await start();
  expect((await settled(id)).outcome.status).toBe('imported');
  const size = (
    await stat(
      join(home, 'projects', 'alpha', 'walkthroughs', id, 'manifest.json'),
    )
  ).size;
  const allocation = vi.spyOn(Buffer, 'alloc');
  try {
    expect(await service.get('alpha', id)).not.toBeNull();
    expect(
      Math.max(0, ...allocation.mock.calls.map(([bytes]) => bytes)),
    ).toBeLessThanOrEqual(size + 1);
  } finally {
    allocation.mockRestore();
  }
});
