import { z } from 'zod';
import {
  arrayData,
  bindingSchema,
  canonical,
  decode,
  digest,
  encode,
  hash,
  text,
  unsupported,
} from './encoding.js';
import type { Bodies, CodecId, EntryPin } from './types.js';

export function ownFields(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return unsupported();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some(
      (k) => typeof k !== 'string' || !allowed.includes(k),
    ) ||
    Object.values(descriptors).some((d) => !d.enumerable || !('value' in d))
  )
    return unsupported();
  return Object.fromEntries(
    Object.entries(descriptors)
      .filter(([, d]) => d.value !== undefined)
      .map(([k, d]) => [k, d.value]),
  );
}
// Zod 4.6.5 adds this non-wire descriptor to its finalized JSON Schema.
// Shape admission is not producer authentication; none of these functions run.
function schemaData(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return unsupported();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const sidecar = descriptors['~standard'];
  if (!sidecar) return ownFields(value, Object.keys(descriptors));
  if (
    !('value' in sidecar) ||
    sidecar.enumerable ||
    sidecar.writable ||
    sidecar.configurable
  )
    return unsupported();
  const dataDescriptors = (item: unknown, keys: readonly string[]) => {
    if (
      !item ||
      typeof item !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(item))
    )
      return unsupported();
    const d = Object.getOwnPropertyDescriptors(item);
    if (
      Reflect.ownKeys(item).length !== keys.length ||
      Reflect.ownKeys(item).some(
        (k) => typeof k !== 'string' || !keys.includes(k),
      ) ||
      Object.values(d).some((v) => !v.enumerable || !('value' in v))
    )
      return unsupported();
    return d;
  };
  const standard = dataDescriptors(sidecar.value, [
    'validate',
    'vendor',
    'version',
    'jsonSchema',
  ]);
  if (
    standard.vendor!.value !== 'zod' ||
    standard.version!.value !== 1 ||
    typeof standard.validate!.value !== 'function'
  )
    return unsupported();
  const conversion = dataDescriptors(standard.jsonSchema!.value, [
    'input',
    'output',
  ]);
  if (
    typeof conversion.input!.value !== 'function' ||
    typeof conversion.output!.value !== 'function'
  )
    return unsupported();
  if (
    Reflect.ownKeys(value).some((k) => typeof k !== 'string') ||
    Object.entries(descriptors).some(
      ([k, d]) => k !== '~standard' && (!d.enumerable || !('value' in d)),
    )
  )
    return unsupported();
  return Object.fromEntries(
    Object.entries(descriptors)
      .filter(([k]) => k !== '~standard')
      .map(([k, d]) => [k, d.value]),
  );
}
const empty = z.object({}).strict();
const finite = z.number().finite();
const json: z.ZodType<
  null | boolean | number | string | Json[] | { [k: string]: Json }
> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    finite,
    z.string(),
    z.array(json),
    z.record(z.string(), json),
  ]),
);
type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const schema = z.record(z.string(), json);
const contentPart = z
  .object({
    type: z.enum(['text', 'reasoning']),
    text: z.string(),
    providerOptions: empty.optional(),
  })
  .strict();
const promptMessage = z.union([
  z
    .object({
      role: z.literal('system'),
      content: z.string(),
      providerOptions: empty.optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal('user'),
      content: z.array(contentPart.extend({ type: z.literal('text') })),
      providerOptions: empty.optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal('assistant'),
      content: z.array(contentPart),
      providerOptions: empty.optional(),
    })
    .strict(),
]);
const functionSchema = z
  .object({
    type: z.literal('function'),
    name: text,
    description: z.string().optional(),
    inputSchema: schema,
    strict: z.boolean().optional(),
    providerOptions: empty.optional(),
  })
  .strict();
const generationSchema = z
  .object({
    maxOutputTokens: finite.int().positive().optional(),
    temperature: finite.optional(),
    topP: finite.optional(),
    topK: finite.int().positive().optional(),
    presencePenalty: finite.optional(),
    frequencyPenalty: finite.optional(),
    seed: finite.int().optional(),
    stopSequences: z.array(z.string()).optional(),
    responseFormat: z
      .union([
        z.object({ type: z.literal('text') }).strict(),
        z
          .object({
            type: z.literal('json'),
            schema: schema.optional(),
            name: text.optional(),
            description: z.string().optional(),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();
export const requestSchema = generationSchema
  .extend({
    prompt: z.array(promptMessage).min(1),
    tools: z.array(functionSchema).optional(),
    toolChoice: z
      .union([
        z.object({ type: z.enum(['auto', 'none', 'required']) }).strict(),
        z.object({ type: z.literal('tool'), toolName: text }).strict(),
      ])
      .optional(),
    providerOptions: empty.optional(),
    includeRawChunks: z.literal(false).optional(),
  })
  .strict();
export function requestBytes(value: unknown): Uint8Array {
  const raw = ownFields(value, [
    ...Object.keys(requestSchema.shape),
    'abortSignal',
    'headers',
  ]);
  if (raw.headers !== undefined) return unsupported();
  delete raw.headers;
  delete raw.abortSignal;
  if (Array.isArray(raw.tools))
    raw.tools = arrayData(raw.tools).map((tool) => {
      const data = ownFields(tool, Object.keys(functionSchema.shape));
      data.inputSchema = schemaData(data.inputSchema);
      return data;
    });
  // SDK conversion commonly creates optional own fields whose value is
  // undefined. Only those known fields may be omitted, including nested ones.
  const clean = (item: unknown): unknown => {
    if (Array.isArray(item)) return arrayData(item).map(clean);
    if (item && typeof item === 'object') {
      const fields = ownFields(item, Object.keys(item));
      return Object.fromEntries(
        Object.entries(fields).map(([k, v]) => [k, clean(v)]),
      );
    }
    return item;
  };
  const cleaned = clean(raw);
  canonical(cleaned);
  return encode(requestSchema.parse(cleaned));
}
const uiMessage = z
  .object({
    id: text,
    role: z.enum(['system', 'user', 'assistant']),
    parts: z
      .array(
        z
          .object({ type: z.enum(['text', 'reasoning']), text: z.string() })
          .strict(),
      )
      .min(1),
  })
  .strict();
const nativeMessage = z
  .object({
    role: z.enum(['user', 'assistant']),
    trackingId: text.optional(),
    content: z
      .array(
        z.union([
          z.object({ text: z.string() }).strict(),
          z
            .object({ reasoning: z.object({ text: z.string() }).strict() })
            .strict(),
        ]),
      )
      .min(1),
  })
  .strict();
const entryCommon = {
  version: z.literal(1),
  binding: bindingSchema,
  sourceCutoff: text,
  authoredDigest: digest,
  tools: z.array(functionSchema),
};
const voltEntrySchema = z
  .object({
    ...entryCommon,
    messages: z.array(uiMessage).min(1),
    generation: generationSchema,
  })
  .strict()
  .refine((v) => v.binding.framework === 'voltagent');
const strandsEntrySchema = z
  .object({
    ...entryCommon,
    prefix: z.array(nativeMessage),
    effectiveInput: z.string(),
    systemPrompt: z.string(),
    vercelConfig: generationSchema,
  })
  .strict()
  .refine((v) => v.binding.framework === 'strands-vercel');
export type VoltEntry = z.infer<typeof voltEntrySchema>;
export type StrandsEntry = z.infer<typeof strandsEntrySchema>;
export function entryData(
  codec: CodecId,
  bytes: Uint8Array,
): VoltEntry | StrandsEntry {
  const value = decode(bytes);
  canonical(value);
  if (codec === 'runtime-volt-entry/1') return voltEntrySchema.parse(value);
  if (codec === 'runtime-strands-entry/1')
    return strandsEntrySchema.parse(value);
  return unsupported();
}
export async function captureEntry(
  bodies: Bodies,
  codec: 'runtime-volt-entry/1' | 'runtime-strands-entry/1',
  value: unknown,
): Promise<{ entry: EntryPin; entryBytes: Uint8Array }> {
  const bytes = encode(value);
  const parsed = entryData(codec, bytes);
  const entryBytes = encode(parsed);
  const body = await bodies.put(codec, entryBytes);
  return {
    entryBytes,
    entry: {
      body,
      sourceCutoff: parsed.sourceCutoff,
      originalAuthoredDigest: parsed.authoredDigest,
      effectivePrefixDigest: prefixDigest(parsed),
    },
  };
}
export function prefixDigest(entry: VoltEntry | StrandsEntry) {
  return hash(
    'messages' in entry
      ? entry.messages
      : {
          prefix: entry.prefix,
          effectiveInput: entry.effectiveInput,
          systemPrompt: entry.systemPrompt,
        },
  );
}
const warning = z.union([
  z
    .object({
      type: z.enum(['unsupported', 'compatibility']),
      feature: text,
      details: z.literal('Runtime warning details omitted.').optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('other'),
      message: z.literal('Runtime warning details omitted.'),
    })
    .strict(),
]);
const count = z.number().int().nonnegative().optional();
const usage = z
  .object({
    inputTokens: z
      .object({
        total: count,
        noCache: count,
        cacheRead: count,
        cacheWrite: count,
      })
      .strict(),
    outputTokens: z
      .object({ total: count, text: count, reasoning: count })
      .strict(),
  })
  .strict();
const block = (
  type:
    | 'text-start'
    | 'text-end'
    | 'reasoning-start'
    | 'reasoning-end'
    | 'tool-input-end',
) => z.object({ type: z.literal(type), id: text }).strict();
const delta = (type: 'text-delta' | 'reasoning-delta' | 'tool-input-delta') =>
  z.object({ type: z.literal(type), id: text, delta: z.string() }).strict();
export const partSchema = z.discriminatedUnion('type', [
  block('text-start'),
  block('text-end'),
  block('reasoning-start'),
  block('reasoning-end'),
  block('tool-input-end'),
  delta('text-delta'),
  delta('reasoning-delta'),
  delta('tool-input-delta'),
  z
    .object({ type: z.literal('tool-input-start'), id: text, toolName: text })
    .strict(),
  z
    .object({
      type: z.literal('tool-call'),
      toolCallId: text,
      toolName: text,
      input: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('stream-start'),
      warnings: z.array(warning).max(128),
    })
    .strict(),
  z
    .object({
      type: z.literal('response-metadata'),
      id: text.optional(),
      modelId: text.optional(),
      timestamp: z.object({ utc: z.iso.datetime() }).strict().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('finish'),
      usage,
      finishReason: z
        .object({
          unified: z.enum([
            'stop',
            'length',
            'content-filter',
            'tool-calls',
            'other',
          ]),
          raw: z.string().optional(),
        })
        .strict(),
    })
    .strict(),
]);
export type WirePart = z.infer<typeof partSchema>;
export function normalizePart(value: unknown): WirePart {
  const discriminated = ownFields(value, [
    ...new Set(partSchema.options.flatMap((s) => Object.keys(s.shape))),
    'providerMetadata',
    'providerExecuted',
    'dynamic',
    'title',
  ]);
  const shape = partSchema.options.find(
    (s) => s.shape.type.value === discriminated.type,
  );
  if (!shape) return unsupported();
  const raw = ownFields(discriminated, [
    ...Object.keys(shape.shape),
    'providerMetadata',
    'providerExecuted',
    'dynamic',
    'title',
  ]);
  if (
    raw.providerExecuted === true ||
    raw.dynamic === true ||
    raw.title !== undefined
  )
    return unsupported();
  delete raw.providerMetadata;
  delete raw.providerExecuted;
  delete raw.dynamic;
  delete raw.title;
  if (raw.type === 'response-metadata' && raw.timestamp !== undefined) {
    if (
      !(raw.timestamp instanceof Date) ||
      !Number.isFinite(raw.timestamp.getTime())
    )
      return unsupported();
    raw.timestamp = { utc: raw.timestamp.toISOString() };
  }
  if (raw.type === 'stream-start') {
    if (!Array.isArray(raw.warnings)) return unsupported();
    raw.warnings = arrayData(raw.warnings).map((w) => {
      const v = ownFields(w, ['type', 'feature', 'details', 'message']);
      if (v.type === 'other' && typeof v.message === 'string')
        return { type: 'other', message: 'Runtime warning details omitted.' };
      if (
        (v.type === 'unsupported' || v.type === 'compatibility') &&
        typeof v.feature === 'string'
      )
        return {
          type: v.type,
          feature: v.feature,
          ...(v.details === undefined
            ? {}
            : { details: 'Runtime warning details omitted.' }),
        };
      return unsupported();
    });
  }
  if (raw.type === 'finish') {
    const u = ownFields(raw.usage, ['inputTokens', 'outputTokens', 'raw']);
    raw.usage = {
      inputTokens: ownFields(u.inputTokens, [
        'total',
        'noCache',
        'cacheRead',
        'cacheWrite',
      ]),
      outputTokens: ownFields(u.outputTokens, ['total', 'text', 'reasoning']),
    };
    raw.finishReason = ownFields(raw.finishReason, ['unified', 'raw']);
  }
  canonical(raw);
  return partSchema.parse(raw);
}
export function heldPart(part: WirePart): boolean {
  return part.type.startsWith('tool-') || part.type === 'finish';
}
export function validateParts(
  parts: readonly WirePart[],
  complete = true,
): void {
  const blocks = new Map<string, 'text' | 'reasoning' | 'tool'>();
  const seen = new Set<string>();
  const inputs = new Map<
    string,
    { name: string; input: string; closed: boolean }
  >();
  const calls = new Set<string>();
  let finished = false;
  let started = false;
  for (const p of parts) {
    if (finished) unsupported();
    if (p.type === 'stream-start') {
      if (started || parts[0] !== p) unsupported();
      started = true;
    }
    if (
      p.type === 'text-start' ||
      p.type === 'reasoning-start' ||
      p.type === 'tool-input-start'
    ) {
      if (seen.has(p.id)) unsupported();
      seen.add(p.id);
      blocks.set(
        p.id,
        p.type === 'text-start'
          ? 'text'
          : p.type === 'reasoning-start'
            ? 'reasoning'
            : 'tool',
      );
      if (p.type === 'tool-input-start')
        inputs.set(p.id, { name: p.toolName, input: '', closed: false });
    }
    if (
      p.type === 'text-delta' ||
      p.type === 'reasoning-delta' ||
      p.type === 'tool-input-delta'
    ) {
      if (
        blocks.get(p.id) !==
        (p.type === 'text-delta'
          ? 'text'
          : p.type === 'reasoning-delta'
            ? 'reasoning'
            : 'tool')
      )
        unsupported();
      if (p.type === 'tool-input-delta') inputs.get(p.id)!.input += p.delta;
    }
    if (
      p.type === 'text-end' ||
      p.type === 'reasoning-end' ||
      p.type === 'tool-input-end'
    ) {
      if (
        blocks.get(p.id) !==
        (p.type === 'text-end'
          ? 'text'
          : p.type === 'reasoning-end'
            ? 'reasoning'
            : 'tool')
      )
        unsupported();
      blocks.delete(p.id);
      if (p.type === 'tool-input-end') {
        const t = inputs.get(p.id)!;
        canonical(JSON.parse(t.input));
        t.closed = true;
      }
    }
    if (p.type === 'tool-call') {
      if (calls.has(p.toolCallId)) unsupported();
      calls.add(p.toolCallId);
      canonical(JSON.parse(p.input));
      const incremental = inputs.get(p.toolCallId);
      if (
        incremental &&
        (!incremental.closed ||
          incremental.name !== p.toolName ||
          incremental.input !== p.input)
      )
        unsupported();
    }
    if (p.type === 'finish') {
      if (blocks.size || [...inputs.keys()].some((k) => !calls.has(k)))
        unsupported();
      finished = true;
    }
  }
  if (complete && !finished) unsupported();
}
const tapeHeader = z
  .object({
    version: z.literal(1),
    envelope: z.literal('stream-only/1'),
    requestId: text,
    attempt: z.number().int().positive(),
  })
  .strict();
export function tapeBytes(
  requestId: string,
  attempt: number,
  parts: readonly WirePart[],
): Uint8Array {
  validateParts(parts);
  const frames = [
    encode(
      tapeHeader.parse({
        version: 1,
        envelope: 'stream-only/1',
        requestId,
        attempt,
      }),
    ),
    ...parts.map((p) => encode(partSchema.parse(p))),
  ];
  const result = new Uint8Array(frames.reduce((n, f) => n + 4 + f.length, 0));
  const view = new DataView(result.buffer);
  let offset = 0;
  for (const frame of frames) {
    view.setUint32(offset, frame.length);
    result.set(frame, offset + 4);
    offset += 4 + frame.length;
  }
  return result;
}
export function readTape(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames: unknown[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) return unsupported();
    const length = view.getUint32(offset);
    offset += 4;
    if (!length || offset + length > bytes.length) return unsupported();
    frames.push(decode(bytes.subarray(offset, offset + length)));
    offset += length;
  }
  const header = tapeHeader.parse(frames.shift());
  const parts = frames.map((f) => partSchema.parse(f));
  validateParts(parts);
  return { ...header, parts };
}
export function validateBody(codec: CodecId, bytes: Uint8Array): void {
  if (codec === 'runtime-ai-sdk-v3-tape/1') {
    readTape(bytes);
    return;
  }
  const value = decode(bytes);
  canonical(value);
  if (codec === 'runtime-ai-sdk-v3-request/1') requestSchema.parse(value);
  else if (codec === 'runtime-ai-sdk-v3-part/1') partSchema.parse(value);
  else entryData(codec, bytes);
}
