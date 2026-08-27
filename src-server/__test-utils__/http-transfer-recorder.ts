import { request as nodeRequest } from 'node:http';
import { Readable, Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import type { ClientAuthenticatedTransport } from '../../packages/sdk/src/client/http.js';

export type TransferAttempt = {
  requestPath: string;
  contentEncoding: 'identity' | 'gzip';
  compressionRatio: number | null;
  socketBytesRead: number;
  encodedBodyBytes: number;
  decodedBodyBytes: number;
  frames: number;
  complete: boolean;
  abortedByClient: boolean;
};

function responseHeaders(
  headers: Record<string, string | string[] | undefined>,
) {
  const normalized = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) normalized.append(name, item);
    } else normalized.set(name, value);
  }
  return normalized;
}

/**
 * Node's HTTP transport gives this proof the wire-adjacent bytes that Fetch
 * deliberately hides: socket bytes include the HTTP/1 response headers and
 * chunk framing (but never TCP/IP/TLS), while the Transform counts body bytes.
 */
export class HttpTransferRecorder {
  readonly attempts: TransferAttempt[] = [];
  #checkpoint:
    | {
        socketBytes: number;
        encodedBodyBytes: number;
        decodedBodyBytes: number;
        frames: number;
      }
    | undefined;

  constructor(private readonly baseUrl: string) {}

  /**
   * Starts a phase at the next byte after an observed protocol barrier.  The
   * live phase uses this immediately after `orchestration:caughtUp`, so its
   * wire bytes exclude HTTP headers plus snapshot/caught-up SSE framing.
   */
  checkpoint(): void {
    const active = this.#active;
    if (!active) throw new Error('transfer recorder has no active response');
    this.#checkpoint = {
      socketBytes: active.socket.bytesRead,
      encodedBodyBytes: active.encodedBodyBytes(),
      decodedBodyBytes: active.decodedBodyBytes(),
      frames: active.frames(),
    };
  }

  #active:
    | {
        socket: { bytesRead: number };
        encodedBodyBytes: () => number;
        decodedBodyBytes: () => number;
        frames: () => number;
      }
    | undefined;

  readonly transport: ClientAuthenticatedTransport = async (input, init) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      this.baseUrl,
    );
    if (url.origin !== new URL(this.baseUrl).origin)
      throw new Error(`recorder refused cross-origin request: ${url.origin}`);
    return new Promise<Response>((resolve, reject) => {
      const request = nodeRequest({
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: init?.method ?? 'GET',
        headers: {
          'Accept-Encoding': 'gzip',
          ...(init?.headers as Record<string, string> | undefined),
        },
        agent: false,
      });
      let startingBytes = 0;
      request.once('socket', (socket) => {
        startingBytes = socket.bytesRead;
      });
      let abortedByClient = false;
      const abort = () => {
        abortedByClient = true;
        request.destroy(new DOMException('Aborted', 'AbortError'));
      };
      init?.signal?.addEventListener('abort', abort, { once: true });
      request.once('error', reject);
      request.once('response', (response) => {
        const encoding = response.headers['content-encoding'];
        if (encoding && encoding !== 'identity' && encoding !== 'gzip') {
          response.destroy();
          reject(new Error(`unsupported content encoding: ${encoding}`));
          return;
        }
        const contentEncoding = encoding === 'gzip' ? 'gzip' : 'identity';
        let encodedBodyBytes = 0;
        let decodedBodyBytes = 0;
        let frames = 0;
        let frameBuffer = '';
        let complete = false;
        let settled = false;
        this.#active = {
          socket: response.socket,
          encodedBodyBytes: () => encodedBodyBytes,
          decodedBodyBytes: () => decodedBodyBytes,
          frames: () => frames,
        };
        const counter = new Transform({
          transform(chunk, _encoding, callback) {
            decodedBodyBytes += Buffer.byteLength(chunk);
            frameBuffer += Buffer.from(chunk).toString('utf8');
            let boundary = frameBuffer.indexOf('\n\n');
            while (boundary >= 0) {
              const frame = frameBuffer.slice(0, boundary);
              frameBuffer = frameBuffer.slice(boundary + 2);
              if (frame.startsWith('event: ')) frames += 1;
              boundary = frameBuffer.indexOf('\n\n');
            }
            callback(null, chunk);
          },
        });
        response.on('data', (chunk) => {
          encodedBodyBytes += Buffer.byteLength(chunk);
        });
        if (contentEncoding === 'gzip')
          response.pipe(createGunzip()).pipe(counter);
        else response.pipe(counter);
        const finalize = () => {
          if (settled) return;
          settled = true;
          init?.signal?.removeEventListener('abort', abort);
          const socketBytesRead = response.socket.bytesRead - startingBytes;
          const checkpoint = this.#checkpoint;
          const phaseEncodedBodyBytes = checkpoint
            ? encodedBodyBytes - checkpoint.encodedBodyBytes
            : encodedBodyBytes;
          const phaseDecodedBodyBytes = checkpoint
            ? decodedBodyBytes - checkpoint.decodedBodyBytes
            : decodedBodyBytes;
          this.#active = undefined;
          this.#checkpoint = undefined;
          this.attempts.push({
            requestPath: `${url.pathname}${url.search}`,
            contentEncoding,
            compressionRatio:
              contentEncoding === 'gzip' && phaseDecodedBodyBytes > 0
                ? phaseEncodedBodyBytes / phaseDecodedBodyBytes
                : null,
            socketBytesRead: checkpoint
              ? response.socket.bytesRead - checkpoint.socketBytes
              : socketBytesRead,
            encodedBodyBytes: phaseEncodedBodyBytes,
            decodedBodyBytes: phaseDecodedBodyBytes,
            frames: checkpoint ? frames - checkpoint.frames : frames,
            complete,
            abortedByClient,
          });
        };
        // `response.close` can beat gunzip's final output. Settle on the
        // decoded stream, otherwise a complete gzip body can be reported as
        // zero decoded bytes with a null ratio.
        counter.once('end', () => {
          complete = true;
          finalize();
        });
        counter.once('close', () => {
          if (abortedByClient) finalize();
        });
        resolve(
          new Response(Readable.toWeb(counter) as ReadableStream, {
            status: response.statusCode ?? 500,
            headers: responseHeaders(response.headers),
          }),
        );
      });
      if (init?.body) request.write(init.body as string);
      request.end();
    });
  };
}
