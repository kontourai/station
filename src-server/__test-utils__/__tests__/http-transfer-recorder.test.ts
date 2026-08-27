import { once } from 'node:events';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, test } from 'vitest';
import { HttpTransferRecorder } from '../http-transfer-recorder.js';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe('HttpTransferRecorder', () => {
  test('waits for gunzip output before finalizing a complete gzip response', async () => {
    const server = createServer((_request, response) => {
      const body = gzipSync(
        Buffer.from('event: proof\ndata: gzip\n\n'.repeat(8192)),
      );
      response.writeHead(200, {
        'content-encoding': 'gzip',
        'content-type': 'text/event-stream',
      });
      response.end(body);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no listener');
    closers.push(
      () =>
        new Promise<void>((resolveClose) => server.close(() => resolveClose())),
    );
    const recorder = new HttpTransferRecorder(
      `http://127.0.0.1:${address.port}`,
    );
    const response = await recorder.transport(
      `http://127.0.0.1:${address.port}/gzip`,
      {},
    );
    expect(response.headers.get('content-encoding')).toBe('gzip');
    await response.text();
    expect(recorder.attempts).toHaveLength(1);
    expect(recorder.attempts[0]).toMatchObject({
      contentEncoding: 'gzip',
      complete: true,
      abortedByClient: false,
    });
    expect(recorder.attempts[0]!.decodedBodyBytes).toBeGreaterThan(0);
    expect(recorder.attempts[0]!.compressionRatio).toBeGreaterThan(0);
    expect(recorder.attempts[0]!.frames).toBeGreaterThan(0);
  });

  test('calculates a gzip ratio from checkpointed phase deltas only', async () => {
    const first = Buffer.from('event: first\ndata: first\n\n'.repeat(128));
    const second = Buffer.from('event: second\ndata: second\n\n'.repeat(512));
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-encoding': 'gzip' });
      response.write(gzipSync(first));
      setTimeout(() => response.end(gzipSync(second)), 20);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no listener');
    closers.push(
      () =>
        new Promise<void>((resolveClose) => server.close(() => resolveClose())),
    );
    const recorder = new HttpTransferRecorder(
      `http://127.0.0.1:${address.port}`,
    );
    const response = await recorder.transport(
      `http://127.0.0.1:${address.port}/checkpoint`,
      {},
    );
    const reader = response.body!.getReader();
    await reader.read();
    recorder.checkpoint();
    while (!(await reader.read()).done) {}
    expect(recorder.attempts).toHaveLength(1);
    const phase = recorder.attempts[0]!;
    expect(phase.decodedBodyBytes).toBe(second.byteLength);
    expect(phase.compressionRatio).toBeCloseTo(
      phase.encodedBodyBytes / second.byteLength,
      12,
    );
  });
});
