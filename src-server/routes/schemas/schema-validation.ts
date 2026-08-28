import { sanitizeFreeText } from '@kontourai/station-shared/redaction';
import type { Context, Next } from 'hono';
import { z } from 'zod/v3';

interface ValidationOptions {
  maxBodyBytes?: number;
}

/**
 * Thrown by {@link readRequestText} when a body exceeds its cap — either by
 * declared `Content-Length` or by bytes actually observed on the stream.
 * Exported (archive#1398) so a route that does its own parsing can
 * distinguish "too large" from "unreadable" and answer with its own refusal
 * vocabulary instead of `validate()`'s generic envelope.
 */
export class RequestBodyTooLargeError extends Error {}

/**
 * Reads a request body as text under a byte cap, **streaming**: it refuses an
 * oversized declared `Content-Length` before reading anything, then reads
 * chunk by chunk and `cancel()`s the reader the moment observed bytes exceed
 * the cap. A caller that lies about its length, or sends a chunked body with
 * no length at all, is therefore stopped mid-ingestion rather than buffered
 * in full and measured afterwards.
 *
 * Exported (archive#1398) rather than reimplemented: it already
 * works on both the node-server and the in-process test-harness paths —
 * `PUT /config/app` has ridden it via {@link validate} since it was written.
 * A route that parses its own body should use this instead of
 * `c.req.text()`, which buffers without a bound.
 */
export async function readRequestText(
  request: Request,
  maxBodyBytes?: number,
): Promise<string> {
  if (maxBodyBytes === undefined) return request.text();

  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    throw new RequestBodyTooLargeError();
  }

  const reader = request.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBodyBytes) {
        await reader.cancel();
        throw new RequestBodyTooLargeError();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

export function validate<T>(
  schema: z.ZodSchema<T>,
  options: ValidationOptions = {},
) {
  return async (c: Context, next: Next) => {
    let raw: unknown;
    try {
      raw = JSON.parse(
        await readRequestText(c.req.raw, options.maxBodyBytes),
      ) as unknown;
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        return c.json({ success: false, error: 'Request body too large' }, 413);
      }
      return c.json({ success: false, error: 'Invalid JSON body' }, 400);
    }
    const result = schema.safeParse(raw);
    if (!result.success) {
      return c.json(
        {
          success: false,
          error: 'Validation failed',
          details: result.error.flatten(),
        },
        400,
      );
    }
    c.set('body' as never, result.data);
    await next();
  };
}

/** Retrieve the validated body set by `validate()`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getBody(c: Context): any {
  return (c.get as (key: string) => unknown)('body');
}

/** Get a required route param, throwing 400 if missing. */
export function param(c: Context, name: string): string {
  const value = c.req.param(name);
  if (!value) throw new Error(`Missing param: ${name}`);
  return value;
}

/**
 * Sanitizes an Error message at the common route-catch boundary. Foreign
 * thrown values are deliberately not coerced: arbitrary coercion is itself an
 * egress path for provider/engine data. Route families that need a richer
 * public contract must use typed codes or the correlated generic envelope.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? sanitizeFreeText(error.message)
    : 'Request failed';
}
