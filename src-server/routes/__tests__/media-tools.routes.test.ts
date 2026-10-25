import { access, readFile } from 'node:fs/promises';
import { Hono } from 'hono';
import { expect, test, vi } from 'vitest';
import { requiredPairingScope } from '../../security/pairing-route-scopes.js';
import { createMediaToolsRoutes } from '../media-tools.js';
import {
  createTranscriptionRoutes,
  MAX_TRANSCRIPTION_UPLOAD_BYTES,
} from '../transcription.js';

function media(operator = true) {
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
      authorizeOperator: async () => operator,
      isRequestPrincipalCurrent: () => true,
    }),
  );
  return { app, tools };
}
test('media tools routes authorize the operator before reading or downloading', async () => {
  const { app, tools } = media(false);
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
  const { app, tools } = media();
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
