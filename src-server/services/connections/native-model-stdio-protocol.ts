// UNWIRED #91: confined native launch and authority composition remain required.

import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod/v3';

export const NATIVE_MODEL_CHANNEL_LIMITS = {
  bodyBytes: 2 * 1024 * 1024,
  frameBytes: 3 * 1024 * 1024,
  lifetimeBytes: 64 * 1024 * 1024,
  simultaneousRequests: 4,
  totalRequests: 1024,
  chunkBytes: 64 * 1024,
} as const;

const body = z
  .string()
  .max(Math.ceil(NATIVE_MODEL_CHANNEL_LIMITS.bodyBytes / 3) * 4)
  .refine((value) => {
    const decoded = Buffer.from(value, 'base64');
    return (
      decoded.length <= NATIVE_MODEL_CHANNEL_LIMITS.bodyBytes &&
      decoded.toString('base64') === value
    );
  });
const headers = z
  .array(z.tuple([z.string().min(1).max(128), z.string().max(8192)]))
  .max(16);
const id = z.string().uuid();
const modelPaths = new Set([
  '/v1/messages',
  '/v1/messages/count_tokens',
  '/v1/responses',
  '/v1/responses/input_tokens',
  '/v1/responses/compact',
  '/v1/models',
]);
const modelPath = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    if (!value.startsWith('/') || value.startsWith('//')) return false;
    const url = new URL(value, 'http://127.0.0.1');
    return (
      url.origin === 'http://127.0.0.1' &&
      !url.hash &&
      modelPaths.has(url.pathname) &&
      `${url.pathname}${url.search}` === value
    );
  });
export const nativeModelWorkerFrame = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('ready'),
      port: z.number().int().min(1).max(65535),
      uid: z.number().int().nonnegative().nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('request'),
      id,
      method: z.enum(['GET', 'POST']),
      path: modelPath,
      headers: headers.refine((items) =>
        items.every(
          ([name, value]) =>
            [
              'accept',
              'content-type',
              'content-encoding',
              'anthropic-version',
              'anthropic-beta',
              'openai-beta',
              'x-codex-turn-state',
            ].includes(name) && !/[\r\n]/.test(value),
        ),
      ),
      body,
    })
    .strict(),
  z.object({ type: z.literal('cancel'), id }).strict(),
]);
export const nativeModelHostFrame = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('init'), token: z.string().min(32).max(128) })
    .strict(),
  z
    .object({
      type: z.literal('head'),
      id,
      status: z.number().int().min(200).max(599),
      headers,
    })
    .strict(),
  z.object({ type: z.literal('data'), id, body }).strict(),
  z.object({ type: z.literal('end'), id }).strict(),
  z.object({ type: z.literal('error'), id }).strict(),
  z.object({ type: z.literal('shutdown') }).strict(),
]);
export type NativeModelWorkerFrame = z.infer<typeof nativeModelWorkerFrame>;
export type NativeModelHostFrame = z.infer<typeof nativeModelHostFrame>;

/** This port carries request bytes, never an authority, credential or caller identity. */
export interface NativeModelRequest {
  id: string;
  method: 'GET' | 'POST';
  path: string;
  headers: readonly (readonly [string, string])[];
  body: Buffer;
}

/** Bound before parsing, and split only at LF (JSON permits raw U+2028/U+2029). */
export async function readNativeModelFrames<T>(
  stream: Readable,
  schema: z.ZodType<T>,
  consume: (frame: T) => void | Promise<void>,
): Promise<void> {
  const decoder = new StringDecoder('utf8');
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let lifetimeBytes = 0;
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    lifetimeBytes += chunk.length;
    if (lifetimeBytes > NATIVE_MODEL_CHANNEL_LIMITS.lifetimeBytes)
      throw new Error('native_model_channel_lifetime_limit');
    utf8.decode(chunk, { stream: true });
    pending += decoder.write(chunk);
    for (;;) {
      const newline = pending.indexOf('\n');
      if (newline === -1) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (Buffer.byteLength(line) > NATIVE_MODEL_CHANNEL_LIMITS.frameBytes)
        throw new Error('native_model_channel_frame_limit');
      await consume(schema.parse(JSON.parse(line)));
    }
    if (Buffer.byteLength(pending) > NATIVE_MODEL_CHANNEL_LIMITS.frameBytes)
      throw new Error('native_model_channel_frame_limit');
  }
  utf8.decode();
  pending += decoder.end();
  if (pending.length) throw new Error('native_model_channel_incomplete_frame');
}

/** One shared writer serializes concurrent streams and honors pipe backpressure. */
export function nativeModelFrameWriter(stream: Writable) {
  let tail: Promise<void> = Promise.resolve();
  let lifetimeBytes = 0;
  return (
    frame: NativeModelHostFrame | NativeModelWorkerFrame,
    invokeCurrent: (write: () => void) => Promise<void> = async (write) =>
      write(),
  ): Promise<void> => {
    const encoded = Buffer.from(`${JSON.stringify(frame)}\n`);
    lifetimeBytes += encoded.length;
    const pending = tail.then(async () => {
      if (
        encoded.length > NATIVE_MODEL_CHANNEL_LIMITS.frameBytes ||
        lifetimeBytes > NATIVE_MODEL_CHANNEL_LIMITS.lifetimeBytes
      )
        throw new Error('native_model_channel_write_limit');
      let complete!: () => void;
      let failed!: (error: unknown) => void;
      const written = new Promise<void>((resolve, reject) => {
        complete = resolve;
        failed = reject;
      });
      void written.catch(() => {});
      let invoked = false;
      stream.once('error', failed);
      try {
        await invokeCurrent(() => {
          if (invoked) throw new Error('native_model_duplicate_delivery');
          if (stream.destroyed || stream.writableEnded)
            throw new Error('native_model_channel_write_closed');
          invoked = true;
          stream.write(encoded, (error) =>
            error ? failed(error) : complete(),
          );
        });
        if (!invoked) throw new Error('native_model_delivery_unavailable');
        await written;
      } finally {
        stream.removeListener('error', failed);
      }
    });
    tail = pending;
    return pending;
  };
}
