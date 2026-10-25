import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Hono } from 'hono';
import type { Transcriber } from '../services/transcription/transcriber.js';

export const MAX_TRANSCRIPTION_UPLOAD_BYTES = 32 * 1024 * 1024;
class UploadTooLarge extends Error {}

/** Project-independent, authenticated raw audio/video upload. Never accepts host paths. */
export function createTranscriptionRoutes(deps: {
  transcriber: Transcriber;
  isRequestPrincipalCurrent(request: Request): boolean;
}) {
  const app = new Hono();
  app.post('/', async (c) => {
    const request = c.req.raw;
    if (!deps.isRequestPrincipalCurrent(request))
      return c.json({ success: false, code: 'unauthorized' }, 403);
    const length = request.headers.get('content-length');
    if (
      length !== null &&
      (!/^\d+$/.test(length) || Number(length) > MAX_TRANSCRIPTION_UPLOAD_BYTES)
    )
      return c.json({ success: false, code: 'upload-too-large' }, 413);
    if (!request.body)
      return c.json({ success: false, code: 'invalid-input' }, 400);
    const temp = await mkdtemp(join(tmpdir(), 'station-audio-upload-'));
    const path = join(temp, 'audio');
    try {
      let bytes = 0;
      const bound = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.byteLength;
          callback(
            bytes > MAX_TRANSCRIPTION_UPLOAD_BYTES
              ? new UploadTooLarge()
              : null,
            chunk,
          );
        },
      });
      try {
        await pipeline(
          Readable.fromWeb(request.body),
          bound,
          createWriteStream(path, { flags: 'wx', mode: 0o600 }),
          {
            signal: AbortSignal.any([
              request.signal,
              AbortSignal.timeout(60_000),
            ]),
          },
        );
      } catch (error) {
        return c.json(
          {
            success: false,
            code:
              error instanceof UploadTooLarge
                ? 'upload-too-large'
                : 'invalid-input',
          },
          error instanceof UploadTooLarge ? 413 : 400,
        );
      }
      if (bytes === 0)
        return c.json({ success: false, code: 'invalid-input' }, 400);
      if (!deps.isRequestPrincipalCurrent(request))
        return c.json({ success: false, code: 'unauthorized' }, 403);
      const result = await deps.transcriber.transcribeFile({
        inputPath: path,
        signal: request.signal,
      });
      if (!deps.isRequestPrincipalCurrent(request))
        return c.json({ success: false, code: 'unauthorized' }, 403);
      return c.json({ success: true, data: result });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
  return app;
}
