import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { bindLocalMediaPreviews } from '../../runtime/bootstrap/local-media-runtime.js';
import {
  assertRuntimeHttpRouteCoverage,
  requiredPairingScope,
} from '../../security/pairing-route-scopes.js';
import { FeaturePreviewRegistry } from '../../services/feature-previews/feature-preview-registry.js';
import { createLogger } from '../../utils/logger.js';
import { createMediaToolsRoutes } from '../media-tools.js';
import {
  createTranscriptionRoutes,
  MAX_TRANSCRIPTION_UPLOAD_BYTES,
} from '../transcription.js';

const temp = trackTempDirs();
async function local(enabled = true) {
  const home = temp('station-media-preview-');
  const previews = new FeaturePreviewRegistry(
    home,
    createLogger({ name: 'preview-test', level: 'error' }),
  );
  const runtime = bindLocalMediaPreviews(previews);
  if (enabled) await previews.setEnabled('local-speech', true);
  return { home, previews, ...runtime };
}
async function media(operator = true, enabled = true) {
  const runtime = await local(enabled);
  const tools = {
    status: vi.fn(async () => ({ components: [] })),
    startDownload: vi.fn(async () => ({
      status: { components: [] },
      completion: Promise.resolve(),
    })),
  };
  const app = new Hono().route(
    '/api/media-tools',
    createMediaToolsRoutes({
      tools,
      preview: runtime.mediaToolsPreview,
      authorizeOperator: async () => operator,
      isRequestPrincipalCurrent: () => true,
    }),
  );
  return { app, tools, ...runtime };
}
test('media tools routes authorize the operator before reading or downloading', async () => {
  const { app, tools } = await media(false);
  expect((await app.request('/api/media-tools/status')).status).toBe(403);
  expect(
    (
      await app.request('/api/media-tools/download', {
        method: 'POST',
        body: '{"consent":true}',
      })
    ).status,
  ).toBe(403);
  expect(tools.status).not.toHaveBeenCalled();
  expect(tools.startDownload).not.toHaveBeenCalled();
});
test('download route validates literal consent and exposes accepted progress through status', async () => {
  const { app, tools } = await media();
  for (const consent of [false, 'true', 1, null])
    expect(
      (
        await app.request('/api/media-tools/download', {
          method: 'POST',
          body: JSON.stringify({ consent }),
        })
      ).status,
    ).toBe(400);
  expect(tools.startDownload).not.toHaveBeenCalled();
  const accepted = await app.request('/api/media-tools/download', {
    method: 'POST',
    body: JSON.stringify({ consent: true, components: ['ffmpeg'] }),
  });
  expect(accepted.status).toBe(202);
  expect(tools.startDownload).toHaveBeenCalledWith({
    consent: true,
    components: ['ffmpeg'],
  });
  expect((await app.request('/api/media-tools/status')).status).toBe(200);
});
test('authenticated raw upload reaches transcriber with byte-exact audio then removes the file', async () => {
  let path: string | undefined;
  const transcribeFile = vi.fn(async (request: { inputPath: string }) => {
    path = request.inputPath;
    expect(await readFile(path)).toEqual(Buffer.from([0, 255, 32, 17]));
    return {
      status: 'failed' as const,
      reason: 'invalid-input' as const,
      message: 'fixture invalid codec',
    };
  });
  const app = new Hono().route(
    '/api/transcription',
    createTranscriptionRoutes({
      transcriber: { transcribeFile },
      preview: (await local()).localSpeechPreview,
      isRequestPrincipalCurrent: () => true,
    }),
  );
  const response = await app.request('/api/transcription', {
    method: 'POST',
    body: new Uint8Array([0, 255, 32, 17]),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    success: true,
    data: { status: 'failed', reason: 'invalid-input' },
  });
  expect(transcribeFile).toHaveBeenCalledTimes(1);
  await expect(access(path!)).rejects.toThrow();
});
test('transcription denies anonymous and revoked principals, with no transcription', async () => {
  const transcribeFile = vi.fn();
  const denied = new Hono().route(
    '/api/transcription',
    createTranscriptionRoutes({
      transcriber: { transcribeFile },
      preview: (await local()).localSpeechPreview,
      isRequestPrincipalCurrent: () => false,
    }),
  );
  expect(
    (
      await denied.request('/api/transcription', {
        method: 'POST',
        body: 'audio',
      })
    ).status,
  ).toBe(403);
  let checks = 0;
  const revoked = new Hono().route(
    '/api/transcription',
    createTranscriptionRoutes({
      transcriber: { transcribeFile },
      preview: (await local()).localSpeechPreview,
      isRequestPrincipalCurrent: () => ++checks === 1,
    }),
  );
  expect(
    (
      await revoked.request('/api/transcription', {
        method: 'POST',
        body: 'audio',
      })
    ).status,
  ).toBe(403);
  expect(transcribeFile).not.toHaveBeenCalled();
});
test('transcription refuses declared and streamed over-limit uploads, not only Content-Length', async () => {
  const transcribeFile = vi.fn();
  const app = new Hono().route(
    '/api/transcription',
    createTranscriptionRoutes({
      transcriber: { transcribeFile },
      preview: (await local()).localSpeechPreview,
      isRequestPrincipalCurrent: () => true,
    }),
  );
  const declared = await app.request('/api/transcription', {
    method: 'POST',
    headers: { 'content-length': String(MAX_TRANSCRIPTION_UPLOAD_BYTES + 1) },
    body: 'small',
  });
  expect(declared.status).toBe(413);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(MAX_TRANSCRIPTION_UPLOAD_BYTES));
      c.enqueue(new Uint8Array([1]));
      c.close();
    },
  });
  const streamed = await app.fetch(
    new Request('http://station/api/transcription', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit),
  );
  expect(streamed.status).toBe(413);
  expect(transcribeFile).not.toHaveBeenCalled();
});
test('pairing scopes distinguish tool installation from local transcription', () => {
  expect(requiredPairingScope('GET', '/api/media-tools/status')).toBe(
    'orchestration:read',
  );
  expect(requiredPairingScope('POST', '/api/media-tools/download')).toBe(
    'terminal:operate',
  );
  expect(requiredPairingScope('POST', '/api/transcription')).toBe(
    'orchestration:operate',
  );
});

test('media-tools refuses both routes when neither preview is on and follows either live toggle', async () => {
  const { app, tools, previews, home } = await media(true, false);
  const status = () => app.request('/api/media-tools/status');
  const download = () =>
    app.request('/api/media-tools/download', {
      method: 'POST',
      body: '{"consent":true}',
    });
  const refused = async () => {
    for (const request of [status, download]) {
      const result = await request();
      expect(
        result.status,
        'media-tools must refuse while both previews are off',
      ).toBe(404);
      expect(await result.json()).toMatchObject({
        success: false,
        code: 'feature_preview_disabled',
        previewId: 'walkthroughs',
        settingsPath:
          '/settings?view=feature-previews&highlight=feature-previews',
      });
    }
  };
  await refused();
  expect(tools.status).not.toHaveBeenCalled();
  expect(tools.startDownload).not.toHaveBeenCalled();
  for (const id of ['walkthroughs', 'local-speech']) {
    await previews.setEnabled(id, true);
    expect((await status()).status).toBe(200);
    expect((await download()).status).toBe(202);
    await previews.setEnabled(id, false);
    await refused();
  }
  const calls = tools.startDownload.mock.calls.length;
  await writeFile(join(home, 'config', 'feature-previews.json'), '{broken');
  await refused();
  expect(tools.startDownload).toHaveBeenCalledTimes(calls);
});

test('local-speech refuses transcription before reading bytes and follows live toggles', async () => {
  const { previews, localSpeechPreview, home } = await local(false);
  const transcribeFile = vi.fn(async () => ({
    status: 'failed' as const,
    reason: 'invalid-input' as const,
    message: 'fixture',
  }));
  const app = new Hono().route(
    '/api/transcription',
    createTranscriptionRoutes({
      transcriber: { transcribeFile },
      preview: localSpeechPreview,
      isRequestPrincipalCurrent: () => true,
    }),
  );
  const post = () =>
    app.request('/api/transcription', { method: 'POST', body: 'audio' });
  const refused = async () => {
    const response = await post();
    expect(
      response.status,
      'local-speech must refuse transcription while off',
    ).toBe(404);
    expect(await response.json()).toMatchObject({
      success: false,
      code: 'feature_preview_disabled',
      previewId: 'local-speech',
      settingsPath:
        '/settings?view=feature-previews&highlight=feature-previews',
    });
  };
  await refused();
  expect(transcribeFile).not.toHaveBeenCalled();
  await previews.setEnabled('walkthroughs', true);
  await refused();
  await previews.setEnabled('local-speech', true);
  expect((await post()).status).toBe(200);
  expect(transcribeFile).toHaveBeenCalledTimes(1);
  await previews.setEnabled('local-speech', false);
  await refused();
  await writeFile(join(home, 'config', 'feature-previews.json'), '{broken');
  await refused();
  expect(transcribeFile).toHaveBeenCalledTimes(1);
});

test('mounted media and transcription inventories satisfy the runtime boot classification', async () => {
  const { app } = await media();
  app.route(
    '/api/transcription',
    createTranscriptionRoutes({
      transcriber: { transcribeFile: vi.fn() },
      preview: (await local()).localSpeechPreview,
      isRequestPrincipalCurrent: () => true,
    }),
  );
  expect(() => assertRuntimeHttpRouteCoverage(app.routes)).not.toThrow();
});

test('transcription queue overflow is retryable HTTP 503 with a distinct busy code', async () => {
  const app = createTranscriptionRoutes({
    transcriber: {
      transcribeFile: async () => ({
        status: 'failed',
        reason: 'busy',
        message: 'Recognizer queue is full.',
      }),
    },
    preview: (await local()).localSpeechPreview,
    isRequestPrincipalCurrent: () => true,
  });
  const response = await app.request('/', { method: 'POST', body: 'audio' });
  expect(response.status).toBe(503);
  expect(response.headers.get('Retry-After')).toBe('5');
  expect(await response.json()).toEqual({
    success: false,
    code: 'busy',
    error: 'The local recognizer queue is full. Retry shortly.',
  });
});

test('transcription entry gate rejects a disabled stream before consuming bytes', async () => {
  let consumed = false;
  const transcribeFile = vi.fn();
  const app = createTranscriptionRoutes({
    transcriber: { transcribeFile },
    preview: (await local(false)).localSpeechPreview,
    isRequestPrincipalCurrent: () => true,
  });
  const body = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        consumed = true;
        c.enqueue(new Uint8Array([1]));
        c.close();
      },
    },
    { highWaterMark: 0 },
  );
  const response = await app.request(
    new Request('http://station.test/', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit),
  );
  expect(response.status).toBe(404);
  expect(consumed, 'disabled upload must not be consumed').toBe(false);
  expect(transcribeFile).not.toHaveBeenCalled();
});
test.each(['media', 'transcription'] as const)(
  '%s rechecks preview after a streamed body changes the persisted choice',
  async (family) => {
    const runtime = await local();
    const effect = vi.fn(async () => ({
      status: { components: [] },
      completion: Promise.resolve(),
    }));
    const transcribeFile = vi.fn(async () => ({
      status: 'transcribed' as const,
      durationMs: 1,
      engine: { runtime: 'fixture', model: 'fixture' },
      segments: [],
    }));
    const app =
      family === 'media'
        ? createMediaToolsRoutes({
            tools: {
              status: async () => ({ components: [] }),
              startDownload: effect,
            },
            preview: runtime.mediaToolsPreview,
            authorizeOperator: async () => true,
            isRequestPrincipalCurrent: () => true,
          })
        : createTranscriptionRoutes({
            transcriber: { transcribeFile },
            preview: runtime.localSpeechPreview,
            isRequestPrincipalCurrent: () => true,
          });
    let consumed = false;
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(c) {
          consumed = true;
          await runtime.previews.setEnabled('local-speech', false);
          c.enqueue(
            new TextEncoder().encode(
              family === 'media' ? '{"consent":true}' : 'audio',
            ),
          );
          c.close();
        },
      },
      { highWaterMark: 0 },
    );
    const response = await app.request(
      new Request(
        `http://station.test/${family === 'media' ? 'download' : ''}`,
        { method: 'POST', body, duplex: 'half' } as RequestInit,
      ),
    );
    expect(consumed).toBe(true);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      code: 'feature_preview_disabled',
    });
    expect(effect).not.toHaveBeenCalled();
    expect(transcribeFile).not.toHaveBeenCalled();
  },
);
