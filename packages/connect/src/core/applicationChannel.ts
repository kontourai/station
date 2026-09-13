import {
  APPLICATION_CHANNEL_CHUNK_BYTES,
  decodeApplicationBytes,
  encodeApplicationBytes,
  readApplicationFrame,
  writeApplicationFrame,
} from './applicationChannelFrames.js';

function headerEntries(headers: Headers): [string, string][] {
  const entries: [string, string][] = [];
  headers.forEach((value, name) => entries.push([name, value]));
  return entries;
}

/** The transport owner supplies an authenticated, reliable, ordered channel. */
export interface ApplicationChannel {
  send(message: string): void;
  close(): void;
  subscribe(message: (value: unknown) => void, closed: () => void): () => void;
}
export interface ApplicationChannelTarget {
  readonly signal: AbortSignal;
  fetch(request: Request): Promise<Response>;
}

/** One request per channel; no automatic retry or reconnection of an operation. */
export function serveApplicationChannel(
  channel: ApplicationChannel,
  origin: string,
  application: ApplicationChannelTarget,
): () => void {
  if (new URL(origin).origin !== origin)
    throw new Error('Canonical Station origin required');
  const controller = new AbortController();
  let phase: 'request' | 'dispatch' | 'response' | 'end' | 'closed' = 'request';
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let remainder: Uint8Array = new Uint8Array(0);
  let pulling = false;
  let unsubscribe = () => {};
  const close = () => {
    if (phase === 'closed') return;
    phase = 'closed';
    unsubscribe();
    application.signal.removeEventListener('abort', close);
    controller.abort();
    void reader?.cancel().catch(() => {});
    channel.close();
  };
  const fail = (code: 'protocol_invalid' | 'application_failed') => {
    if (phase === 'closed') return;
    try {
      channel.send(writeApplicationFrame({ type: 'error', code }));
    } catch {
      // A disconnected peer may receive only transport closure, never success.
    } finally {
      close();
    }
  };
  const sendNext = async () => {
    pulling = true;
    try {
      let emptyChunks = 0;
      while (!remainder.byteLength) {
        if (++emptyChunks > 16)
          throw new Error('Application producer made no byte progress');
        const result = reader ? await reader.read() : { done: true as const };
        if (controller.signal.aborted) return;
        if (result.done) {
          phase = 'end';
          channel.send(writeApplicationFrame({ type: 'end' }));
          return;
        }
        if (
          !(result.value instanceof Uint8Array) ||
          result.value.byteLength > 1024 * 1024
        )
          throw new Error('Application producer chunk exceeds bound');
        remainder = result.value;
      }
      const bytes = remainder.slice(0, APPLICATION_CHANNEL_CHUNK_BYTES);
      remainder = remainder.subarray(bytes.byteLength);
      channel.send(
        writeApplicationFrame({
          type: 'chunk',
          bytes: encodeApplicationBytes(bytes),
        }),
      );
    } catch {
      fail('application_failed');
    } finally {
      pulling = false;
    }
  };
  const dispatch = async (
    frame: Extract<
      ReturnType<typeof readApplicationFrame>,
      { type: 'request' }
    >,
  ) => {
    phase = 'dispatch';
    try {
      const url = new URL(frame.path, origin);
      if (url.origin !== origin) throw new Error('Application target changed');
      const response = await application.fetch(
        new Request(url, {
          method: frame.method,
          headers: frame.headers,
          body:
            frame.body === null
              ? null
              : new Uint8Array(decodeApplicationBytes(frame.body)),
          signal: controller.signal,
          redirect: 'error',
          credentials: 'omit',
        }),
      );
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        return;
      }
      if (
        response.headers.has('set-cookie') ||
        response.headers.has('set-cookie2')
      ) {
        void response.body?.cancel().catch(() => {});
        throw new Error('Virtual cookie response forbidden');
      }
      reader = response.body?.getReader();
      phase = 'response';
      channel.send(
        writeApplicationFrame({
          type: 'response',
          status: response.status,
          headers: headerEntries(response.headers),
        }),
      );
    } catch {
      fail('application_failed');
    }
  };
  unsubscribe = channel.subscribe((value) => {
    if (phase === 'closed') return;
    try {
      const frame = readApplicationFrame(value);
      if (frame.type === 'request' && phase === 'request') void dispatch(frame);
      else if (frame.type === 'credit' && phase === 'response' && !pulling)
        void sendNext();
      else fail('protocol_invalid');
    } catch {
      fail('protocol_invalid');
    }
  }, close);
  application.signal.addEventListener('abort', close, { once: true });
  if (application.signal.aborted) close();
  return close;
}

export class ApplicationChannelError extends Error {
  constructor(
    readonly dispatched: boolean,
    readonly code: string,
  ) {
    super(
      `Station application channel failed (${code}); ${dispatched ? 'the request may have executed' : 'the request was not dispatched'}`,
    );
  }
}

async function readRequestBody(request: Request): Promise<string | null> {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const bytes = new Uint8Array(APPLICATION_CHANNEL_CHUNK_BYTES);
  let length = 0;
  const abort = () => {
    void reader.cancel(request.signal.reason).catch(() => {});
  };
  request.signal.addEventListener('abort', abort, { once: true });
  try {
    request.signal.throwIfAborted();
    while (true) {
      const chunk = await reader.read();
      request.signal.throwIfAborted();
      if (chunk.done) return encodeApplicationBytes(bytes.subarray(0, length));
      length += chunk.value.byteLength;
      if (length > bytes.byteLength)
        throw new Error('Application request body exceeds 16 KiB pilot limit');
      bytes.set(chunk.value, length - chunk.value.byteLength);
    }
  } catch (error) {
    void reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    request.signal.removeEventListener('abort', abort);
  }
}

/** Fetch adapter for a host that already owns endpoint trust and Device custody. */
export function createApplicationChannelFetch(options: {
  origin: string;
  signal: AbortSignal;
  open: (signal: AbortSignal) => Promise<ApplicationChannel>;
  assertCurrent: () => void | Promise<void>;
}) {
  if (new URL(options.origin).origin !== options.origin)
    throw new Error('Canonical Station origin required');
  const configuration = { ...options };
  return async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit & { authorityGuard?: () => void },
  ): Promise<Response> => {
    const signal = AbortSignal.any([
      configuration.signal,
      init?.signal ??
        (input instanceof Request
          ? input.signal
          : new AbortController().signal),
    ]);
    // Chrome's Request guard drops Origin because HTTP would add it later.
    // A virtual transport must retain the explicit SDK origin and proof headers.
    const suppliedHeaders = new Headers(
      init?.headers !== undefined
        ? init.headers
        : input instanceof Request
          ? input.headers
          : undefined,
    );
    const request = new Request(input, {
      ...init,
      signal,
      credentials: 'omit',
    });
    const headers = new Headers(request.headers);
    suppliedHeaders.forEach((value, name) => headers.set(name, value));
    const url = new URL(request.url);
    if (
      url.origin !== configuration.origin ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new ApplicationChannelError(false, 'target_invalid');
    signal.throwIfAborted();
    init?.authorityGuard?.();
    await configuration.assertCurrent();
    const body = await readRequestBody(request);
    const frame = writeApplicationFrame({
      type: 'request',
      method: request.method,
      path: url.pathname + url.search,
      headers: headerEntries(headers),
      body,
    });
    signal.throwIfAborted();
    const channel = await openOwnedChannel(configuration.open, signal);
    try {
      await configuration.assertCurrent();
      signal.throwIfAborted();
      init?.authorityGuard?.();
    } catch (error) {
      channel.close();
      throw error;
    }
    return await fetchOnChannel(
      channel,
      frame,
      request.method,
      signal,
      init?.authorityGuard,
    );
  };
}

function openOwnedChannel(
  open: (signal: AbortSignal) => Promise<ApplicationChannel>,
  signal: AbortSignal,
): Promise<ApplicationChannel> {
  const opening = new AbortController();
  return new Promise((resolve, reject) => {
    const abort = () => {
      opening.abort(signal.reason);
      reject(new ApplicationChannelError(false, 'cancelled'));
      cleanup();
    };
    const timer = setTimeout(() => {
      opening.abort();
      reject(new ApplicationChannelError(false, 'open_timeout'));
      cleanup();
    }, 15000);
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return open(opening.signal);
      })
      .then(
        (channel) => {
          cleanup();
          if (signal.aborted || opening.signal.aborted) {
            channel.close();
          } else resolve(channel);
        },
        (error) => {
          cleanup();
          reject(error);
        },
      );
    if (signal.aborted) abort();
  });
}

function fetchOnChannel(
  channel: ApplicationChannel,
  frame: string,
  method: string,
  signal: AbortSignal,
  authorityGuard?: () => void,
): Promise<Response> {
  let phase: 'headers' | 'body' | 'end' = 'headers';
  let dispatched = false;
  let awaitingChunk = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let unsubscribe = () => {};
  return new Promise<Response>((resolve, reject) => {
    const cleanup = () => {
      unsubscribe();
      signal.removeEventListener('abort', abort);
      channel.close();
    };
    const fail = (code: string) => {
      if (phase === 'end') return;
      const error = new ApplicationChannelError(dispatched, code);
      const beforeHeaders = phase === 'headers';
      phase = 'end';
      if (beforeHeaders) reject(error);
      else controller?.error(error);
      cleanup();
    };
    const abort = () => fail('cancelled');
    unsubscribe = channel.subscribe(
      (value) => {
        if (phase === 'end') return;
        try {
          authorityGuard?.();
          const message = readApplicationFrame(value);
          if (message.type === 'error') {
            fail(message.code);
            return;
          }
          if (message.type === 'response' && phase === 'headers') {
            const headers = new Headers(message.headers);
            if (headers.has('set-cookie') || headers.has('set-cookie2'))
              throw new Error('Cookie response forbidden');
            phase = 'body';
            const empty =
              method === 'HEAD' || [204, 205, 304].includes(message.status);
            if (empty) {
              resolve(new Response(null, { status: message.status, headers }));
              phase = 'end';
              cleanup();
              return;
            }
            const stream = new ReadableStream<Uint8Array>(
              {
                start(output) {
                  controller = output;
                },
                pull() {
                  if (phase !== 'body' || awaitingChunk) return;
                  try {
                    authorityGuard?.();
                    awaitingChunk = true;
                    channel.send(writeApplicationFrame({ type: 'credit' }));
                  } catch {
                    fail('transport_failed');
                  }
                },
                cancel() {
                  phase = 'end';
                  cleanup();
                },
              },
              { highWaterMark: 0 },
            );
            resolve(new Response(stream, { status: message.status, headers }));
          } else if (
            message.type === 'chunk' &&
            phase === 'body' &&
            awaitingChunk
          ) {
            awaitingChunk = false;
            controller!.enqueue(decodeApplicationBytes(message.bytes));
          } else if (
            message.type === 'end' &&
            phase === 'body' &&
            awaitingChunk
          ) {
            phase = 'end';
            controller!.close();
            cleanup();
          } else throw new Error('Unexpected application frame');
        } catch {
          fail('protocol_invalid');
        }
      },
      () => fail('transport_closed'),
    );
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    try {
      authorityGuard?.();
      dispatched = true;
      channel.send(frame);
    } catch {
      fail('transport_failed');
    }
  });
}

// Structural browser boundary keeps this portable module usable from Node
// without installing browser globals into the server/script type environment.
interface BrowserApplicationDataChannel {
  readonly readyState: string;
  readonly ordered: boolean;
  readonly maxRetransmits: number | null;
  readonly maxPacketLifeTime: number | null;
  readonly bufferedAmount: number;
  send(message: string): void;
  close(): void;
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(type: 'close' | 'error', listener: () => void): void;
  removeEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void,
  ): void;
  removeEventListener(type: 'close' | 'error', listener: () => void): void;
}

/** Adopt an open browser channel only after the connection owner admits its peer. */
export function browserApplicationChannel(
  channel: BrowserApplicationDataChannel,
): ApplicationChannel {
  if (
    channel.readyState !== 'open' ||
    !channel.ordered ||
    channel.maxRetransmits !== null ||
    channel.maxPacketLifeTime !== null
  )
    throw new Error(
      'Application traffic requires an open reliable ordered channel',
    );
  return {
    send(message) {
      // A peer that floods credits must not create an unbounded browser queue.
      if (
        channel.readyState !== 'open' ||
        channel.bufferedAmount + new TextEncoder().encode(message).byteLength >
          96 * 1024
      )
        throw new Error('Application channel send capacity exhausted');
      channel.send(message);
    },
    close: () => channel.close(),
    subscribe(message, closed) {
      const receive = (event: { data: unknown }) => message(event.data);
      channel.addEventListener('message', receive);
      channel.addEventListener('close', closed);
      channel.addEventListener('error', closed);
      return () => {
        channel.removeEventListener('message', receive);
        channel.removeEventListener('close', closed);
        channel.removeEventListener('error', closed);
      };
    },
  };
}
