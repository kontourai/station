import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Digest } from './types.js';

export class RuntimeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'RuntimeError';
  }
}
export function unsupported(): never {
  throw new RuntimeError('DURABLE_UNSUPPORTED');
}
export function digestBytes(bytes: Uint8Array): Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
/** Own dense array elements, inspected before any caller property is read. */
export function arrayData(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    return unsupported();
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  const size: unknown = length?.value;
  if (
    !length ||
    !('value' in length) ||
    length.enumerable ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    Reflect.ownKeys(value).length !== size + 1
  )
    return unsupported();
  const result: unknown[] = [];
  for (let index = 0; index < size; index++) {
    const item = Object.getOwnPropertyDescriptor(value, String(index));
    if (!item?.enumerable || !('value' in item)) return unsupported();
    result.push(item.value);
  }
  return result;
}
// JSON is an immutable wire representation. Accessors, prototypes and omitted
// meaningful values are refused before schema decoding or canonicalization.
export function canonical(value: unknown): string {
  const visit = (item: unknown, depth: number): string => {
    if (depth > 64) return unsupported();
    if (item === null || typeof item === 'boolean' || typeof item === 'string')
      return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item))
      return JSON.stringify(item);
    if (Array.isArray(item)) {
      return `[${arrayData(item)
        .map((x) => visit(x, depth + 1))
        .join(',')}]`;
    }
    if (
      !item ||
      typeof item !== 'object' ||
      Object.getPrototypeOf(item) !== Object.prototype
    )
      return unsupported();
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (
      Reflect.ownKeys(item).some((k) => typeof k !== 'string') ||
      Object.values(descriptors).some((d) => !d.enumerable || !('value' in d))
    )
      return unsupported();
    return `{${Object.keys(descriptors)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${visit(descriptors[k]!.value, depth + 1)}`,
      )
      .join(',')}}`;
  };
  return visit(value, 0);
}
export const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(canonical(value));
export function decode(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
export const hash = (value: unknown): Digest => digestBytes(encode(value));
export const text = z.string().min(1).max(4096);
export const digest = z.templateLiteral([
  'sha256:',
  z.string().regex(/^[a-f0-9]{64}$/),
]);
export const owner = z.discriminatedUnion('identityKind', [
  z
    .object({
      identityKind: z.literal('exact'),
      id: text,
      pid: z.number().int().positive(),
      birth: text,
    })
    .strict(),
  z
    .object({
      identityKind: z.literal('unverified'),
      id: text,
      pid: z.number().int().positive(),
    })
    .strict(),
]);
export const runKey = z
  .object({ scopeId: text, conversationId: text, invocationId: text })
  .strict();
export const fence = z
  .object({ owner, revision: z.string().regex(/^(0|[1-9][0-9]*)$/) })
  .strict();
export const codecId = z.enum([
  'runtime-volt-entry/1',
  'runtime-strands-entry/1',
  'runtime-ai-sdk-v3-request/1',
  'runtime-ai-sdk-v3-tape/1',
  'runtime-ai-sdk-v3-part/1',
]);
export const bodyRef = z
  .object({
    codec: codecId,
    digest,
    byteLength: z
      .number()
      .int()
      .min(1)
      .max(32 * 1024 * 1024),
  })
  .strict();
export const bindingSchema = z
  .object({
    framework: z.enum(['voltagent', 'strands-vercel']),
    frameworkVersion: z.enum(['2.10.0', '1.19.0']),
    adapterDigest: digest,
    modelImplementationDigest: digest,
    connectionId: text,
    connectionRevision: text,
    provider: text,
    modelId: text,
    transport: z.literal('ai-sdk-v3-stateless/1'),
  })
  .strict()
  .refine(
    (v) =>
      v.frameworkVersion ===
      (v.framework === 'voltagent' ? '2.10.0' : '1.19.0'),
  );
const entryPin = z
  .object({
    body: bodyRef,
    sourceCutoff: text,
    originalAuthoredDigest: digest,
    effectivePrefixDigest: digest,
  })
  .strict();
export const specSchema = z
  .object({ key: runKey, binding: bindingSchema, entry: entryPin })
  .strict();
export const pinSchema = z
  .object({
    requestId: text,
    ordinal: z.number().int().nonnegative(),
    entryDigest: digest,
    previousResponseDigest: digest.nullable(),
    request: bodyRef,
  })
  .strict();
export const attemptSchema = z
  .object({
    requestId: text,
    number: z.number().int().positive(),
    owner,
    grantId: text,
  })
  .strict();
export const projectionSchema = z
  .object({
    id: text.max(65536),
    key: runKey,
    requestId: text,
    attempt: z.number().int().positive(),
    sequence: z.number().int().nonnegative(),
    kind: z.enum(['partial', 'aborted', 'completed']),
    body: bodyRef.nullable(),
  })
  .strict()
  .refine((v) => (v.kind === 'aborted') === (v.body === null));
