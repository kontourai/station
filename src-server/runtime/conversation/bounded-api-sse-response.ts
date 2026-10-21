import { createHash } from 'node:crypto';
export class RawSseUnavailable extends Error {
  readonly code = 'usage_unknown';
}
export interface RawProviderFrame {
  event?: string;
  data: Record<string, unknown>;
}
export interface RawSseEvidence {
  readonly frames: ReadonlyArray<RawProviderFrame>;
  readonly rawBodySha256: string;
  readonly byteLength: number;
}
function freezeFrames(
  frames: RawProviderFrame[],
): ReadonlyArray<RawProviderFrame> {
  const pending: Array<{ value: object; depth: number }> = [
    { value: frames, depth: 0 },
  ];
  let nodes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (!item) break;
    if (++nodes > 100000 || item.depth > 64) fail();
    for (const value of Object.values(item.value))
      if (value && typeof value === 'object')
        pending.push({ value, depth: item.depth + 1 });
    Object.freeze(item.value);
  }
  return frames;
}
export interface RawSseLimits {
  maxBytes: number;
  maxFrameBytes: number;
  maxFrames: number;
}
const fail = (): never => {
  throw new RawSseUnavailable('Complete provider SSE unavailable');
};

function parserFor(limits: RawSseLimits) {
  if (Object.values(limits).some((v) => !Number.isSafeInteger(v) || v < 1))
    fail();
  const hash = createHash('sha256');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const encoder = new TextEncoder();
  const frames: RawProviderFrame[] = [];
  let pending = '',
    total = 0;
  const accept = (frame: string) => {
    if (encoder.encode(frame).byteLength > limits.maxFrameBytes) fail();
    let event: string | undefined;
    const data: string[] = [];
    for (const line of frame.split(/\r\n|\r|\n/)) {
      if (!line || line.startsWith(':')) continue;
      const split = line.indexOf(':');
      const field = split < 0 ? line : line.slice(0, split);
      let value = split < 0 ? '' : line.slice(split + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') {
        if (event !== undefined) fail();
        event = value;
      } else if (field === 'data') data.push(value);
      else fail();
    }
    if (!data.length) {
      if (event !== undefined) fail();
      return;
    }
    const parsed: unknown = JSON.parse(data.join('\n'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail();
    if (frames.length === limits.maxFrames) fail();
    frames.push({
      ...(event === undefined ? {} : { event }),
      data: parsed as Record<string, unknown>,
    });
  };

  return {
    push(value: Uint8Array) {
      total += value.byteLength;
      hash.update(value);
      if (total > limits.maxBytes) fail();
      pending += decoder.decode(value, { stream: true });
      let match = /\r\n\r\n|\n\n|\r\r/.exec(pending);
      while (match) {
        accept(pending.slice(0, match.index));
        pending = pending.slice(match.index + match[0].length);
        match = /\r\n\r\n|\n\n|\r\r/.exec(pending);
      }
      if (encoder.encode(pending).byteLength > limits.maxFrameBytes) fail();
    },
    finish() {
      pending += decoder.decode();
      if (pending.length || frames.length === 0) fail();
      return Object.freeze({
        frames: freezeFrames(frames),
        rawBodySha256: hash.digest('hex'),
        byteLength: total,
      });
    },
  };
}

/** One reader and bounded retained evidence; no tee or response-sized SDK replay buffer. */
export function observeRawProviderSseResponse(
  response: Response,
  limits: RawSseLimits,
  signal: AbortSignal,
): {
  response: Response;
  complete: Promise<RawSseEvidence>;
} {
  const upstream = response.body;
  if (!upstream) return fail();
  let parser: ReturnType<typeof parserFor>;
  try {
    parser = parserFor(limits);
    if (
      response.status !== 200 ||
      response.headers
        .get('content-type')
        ?.split(';')[0]
        .trim()
        .toLowerCase() !== 'text/event-stream'
    )
      fail();
  } catch {
    void upstream.cancel().catch(() => {});
    return fail();
  }
  const reader = upstream.getReader();
  let resolve!: (frames: RawSseEvidence) => void,
    reject!: (reason: unknown) => void;
  const complete = new Promise<RawSseEvidence>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void complete.catch(() => {});
  let ended = false;
  let output: ReadableStreamDefaultController<Uint8Array>;
  const cleanup = () => {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  };
  const refuse = (notify = true) => {
    if (ended) return;
    ended = true;
    const error = new RawSseUnavailable('Complete provider SSE unavailable');
    reject(error);
    if (notify) output.error(error);
    cleanup();
  };
  const abort = () => refuse();
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        output = controller;
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) refuse();
      },
      async pull(controller) {
        if (ended) return;
        try {
          signal.throwIfAborted();
          const item = await reader.read();
          signal.throwIfAborted();
          if (ended) return;
          if (item.done) {
            const frames = parser.finish();
            ended = true;
            resolve(frames);
            controller.close();
            cleanup();
          } else {
            parser.push(item.value);
            controller.enqueue(item.value.slice());
          }
        } catch {
          refuse();
        }
      },
      cancel() {
        refuse(false);
      },
    },
    { highWaterMark: 1 },
  );
  return {
    response: new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    complete,
  };
}

export async function readRawProviderSse(
  response: Response,
  limits: RawSseLimits,
  signal: AbortSignal,
): Promise<ReadonlyArray<RawProviderFrame>> {
  const observed = observeRawProviderSseResponse(response, limits, signal);
  const reader = (observed.response.body ?? fail()).getReader();
  try {
    while (!(await reader.read()).done) {
      /* Drain for callers that only need retained evidence. */
    }
    return (await observed.complete).frames;
  } catch {
    return fail();
  } finally {
    reader.releaseLock();
  }
}
