// UNWIRED #91: run only through the owned confined-native execution composition.
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  NATIVE_MODEL_CHANNEL_LIMITS,
  nativeModelFrameWriter,
  nativeModelHostFrame,
  readNativeModelFrames,
} from './native-model-stdio-protocol.js';

const requestHeaders = new Set([
  'accept',
  'content-type',
  'content-encoding',
  'anthropic-version',
  'anthropic-beta',
  'openai-beta',
  'x-codex-turn-state',
]);
const modelPaths = new Set([
  '/v1/messages',
  '/v1/messages/count_tokens',
  '/v1/responses',
  '/v1/responses/input_tokens',
  '/v1/responses/compact',
  '/v1/models',
]);

/** No provider key, raw fetch, DNS lookup or provider network connection exists here. */
async function main(): Promise<void> {
  const send = nativeModelFrameWriter(process.stdout);
  const active = new Map<string, ServerResponse>();
  let token: Buffer | undefined;
  let initialized = false;
  let closed = false;
  let received = 0;
  let failure: unknown;
  const refuse = (response: ServerResponse, status: number) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        error: {
          type: 'native_model_unavailable',
          message: 'Native model request unavailable.',
        },
      }),
    );
  };
  const fail = (error: unknown) => {
    failure ??= error;
    closed = true;
    for (const response of active.values()) response.destroy();
    active.clear();
    server.closeAllConnections();
    server.close();
    process.stdin.destroy();
  };
  const server = createServer(
    {
      maxHeaderSize: 16 * 1024,
      requestTimeout: 30_000,
      headersTimeout: 10_000,
    },
    async (request, response) => {
      let id: string | undefined;
      try {
        const authorization = request.headers.authorization;
        const offered = Buffer.from(
          typeof authorization === 'string' &&
            authorization.startsWith('Bearer ')
            ? authorization.slice(7)
            : String(request.headers['x-api-key'] ?? ''),
        );
        if (
          closed ||
          !token ||
          offered.length !== token.length ||
          !timingSafeEqual(offered, token)
        ) {
          request.resume();
          refuse(response, 401);
          return;
        }
        const path = request.url ?? '';
        if (
          !path.startsWith('/') ||
          path.startsWith('//') ||
          !modelPaths.has(new URL(path, 'http://127.0.0.1').pathname) ||
          !['GET', 'POST'].includes(request.method ?? '')
        ) {
          request.resume();
          refuse(response, 404);
          return;
        }
        if (
          active.size >= NATIVE_MODEL_CHANNEL_LIMITS.simultaneousRequests ||
          received >= NATIVE_MODEL_CHANNEL_LIMITS.totalRequests
        ) {
          request.resume();
          refuse(response, 429);
          return;
        }
        id = randomUUID();
        received++;
        active.set(id, response);
        const currentId = id;
        response.once('close', () => {
          if (!active.delete(currentId) || response.writableFinished || closed)
            return;
          void send({ type: 'cancel', id: currentId }).catch(fail);
        });
        let bytes = 0;
        const chunks: Buffer[] = [];
        for await (const raw of request) {
          const chunk = Buffer.from(raw);
          bytes += chunk.length;
          if (bytes > NATIVE_MODEL_CHANNEL_LIMITS.bodyBytes)
            throw new Error('native_model_body_limit');
          chunks.push(chunk);
        }
        if (response.destroyed) return;
        const headers: [string, string][] = [];
        for (const [name, value] of Object.entries(request.headers)) {
          if (!requestHeaders.has(name)) continue;
          if (typeof value !== 'string')
            throw new Error('native_model_header_unsupported');
          headers.push([name, value]);
        }
        await send({
          type: 'request',
          id,
          method: request.method === 'GET' ? 'GET' : 'POST',
          path,
          headers,
          body: Buffer.concat(chunks).toString('base64'),
        });
      } catch {
        if (id) active.delete(id);
        if (!response.headersSent && !response.destroyed) refuse(response, 502);
        else response.destroy();
      }
    },
  );
  server.maxConnections = 16;
  try {
    await readNativeModelFrames(
      process.stdin,
      nativeModelHostFrame,
      async (frame) => {
        if (frame.type === 'init') {
          if (initialized || closed)
            throw new Error('native_model_duplicate_init');
          initialized = true;
          token = Buffer.from(frame.token);
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
              server.removeListener('error', reject);
              resolve();
            });
          });
          const address = server.address();
          if (!address || typeof address === 'string')
            throw new Error('native_model_listen_unavailable');
          await send({
            type: 'ready',
            port: address.port,
            uid: process.getuid?.() ?? null,
          });
          return;
        }
        if (!initialized) throw new Error('native_model_init_required');
        if (frame.type === 'shutdown') {
          closed = true;
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          process.stdin.destroy();
          return;
        }
        const response = active.get(frame.id);
        // A native client can retire while the host's last chunk is in transit.
        if (!response || response.destroyed) return;
        if (frame.type === 'head') {
          if (response.headersSent)
            throw new Error('native_model_duplicate_headers');
          response.writeHead(frame.status, Object.fromEntries(frame.headers));
        } else if (frame.type === 'data') {
          if (!response.headersSent)
            throw new Error('native_model_headers_required');
          await new Promise<void>((resolve, reject) =>
            response.write(Buffer.from(frame.body, 'base64'), (error) =>
              error ? reject(error) : resolve(),
            ),
          );
        } else if (frame.type === 'end') {
          if (!response.headersSent)
            throw new Error('native_model_headers_required');
          active.delete(frame.id);
          response.end();
        } else {
          active.delete(frame.id);
          if (response.headersSent) response.destroy();
          else refuse(response, 502);
        }
      },
    );
  } catch (error) {
    if (!closed) failure = error;
  } finally {
    closed = true;
    for (const [id, response] of active) {
      response.destroy();
      try {
        await send({ type: 'cancel', id });
      } catch {
        /* The host observes channel closure. */
      }
    }
    active.clear();
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (failure)
    throw new Error('native_model_worker_failed', { cause: failure });
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  void main().catch(() => {
    process.stderr.write('Native model worker failed.\n');
    process.exitCode = 1;
  });
