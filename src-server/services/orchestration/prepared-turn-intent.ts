import { createHash, randomUUID } from 'node:crypto';
import type { PreparedTurnIntent } from '@kontourai/monument';
import {
  CHAT_FILE_MIME_TYPES,
  CHAT_IMAGE_MIME_TYPES,
} from '@kontourai/station-contracts/chat-attachment';
import { z } from 'zod';
import type { ProviderSendTurnInput } from '../../providers/adapter-shape.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const retainedInputSchema = z
  .object({
    text: z.string(),
    displayInput: z.string().optional(),
    ambientContext: z.string().optional(),
    modelId: z.string().optional(),
    modelOptions: z.record(z.string(), z.unknown()).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    recoveryCorrelationId: z.string().optional(),
    confinement: z.enum(['host', 'workspace']).optional(),
    reviewIsolation: z
      .object({
        workspaceAccess: z.literal('read-only'),
        requestId: z.string(),
        reviewerId: z.string(),
      })
      .strict()
      .optional(),
    attachments: z
      .array(
        z
          .object({
            kind: z.enum(['image', 'file']),
            name: z.string(),
            mimeType: z.enum([
              ...CHAT_IMAGE_MIME_TYPES,
              ...CHAT_FILE_MIME_TYPES,
            ]),
            size: z.number().int().nonnegative(),
            dataUrl: z.string(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
const retainedEnvelopeSchema = z
  .object({
    schema: z.literal('station.prepared-turn/v1'),
    invocationId: z.uuid(),
    threadId: z.string(),
    clientTurnId: z.string().optional(),
    input: retainedInputSchema,
    resumeGuard: z
      .object({
        binding: z.record(z.string(), z.unknown()),
        requiresFreshCompanions: z.boolean(),
      })
      .strict(),
  })
  .strict();
export type PreparedTurnIntentView = {
  invocationId: string;
  threadId: string;
  clientTurnId?: string;
  inputDigest: string;
  intentDigest: string;
  state:
    | 'reserved'
    | 'prepared'
    | 'invoking'
    | 'accepted'
    | 'indeterminate'
    | 'settled'
    | 'lifecycle';
  input: z.infer<typeof retainedInputSchema>;
};

/** Reject values JSON would silently drop or reinterpret before retaining an input. */
function canonical(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (typeof value !== 'object' || value === null || ancestors.has(value))
    throw new Error(
      'Prepared turn input must contain only finite JSON values.',
    );
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) && prototype !== Array.prototype)
    throw new Error('Prepared turn input cannot contain array subclasses.');
  if (
    prototype !== Object.prototype &&
    prototype !== null &&
    !Array.isArray(value)
  )
    throw new Error('Prepared turn input must contain plain JSON objects.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some((key) => typeof key === 'symbol') ||
    Object.values(descriptors).some((field) => !('value' in field))
  )
    throw new Error('Prepared turn input cannot contain symbols or accessors.');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        Reflect.ownKeys(value).length !== value.length + 1 ||
        Array.from(
          { length: value.length },
          (_, index) => descriptors[index],
        ).some((descriptor) => !descriptor?.enumerable)
      )
        throw new Error(
          'Prepared turn input cannot contain sparse or decorated arrays.',
        );
      return `[${value.map((item) => canonical(item, ancestors)).join(',')}]`;
    }
    if (Reflect.ownKeys(value).length !== Object.keys(value).length)
      throw new Error('Prepared turn input cannot contain hidden fields.');
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical(descriptors[key].value, ancestors)}`,
      )
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function digest(domain: string, bytes: string): string {
  return createHash('sha256').update(`${domain}\0`).update(bytes).digest('hex');
}

export interface CapturedTurnIntent {
  readonly intent: PreparedTurnIntent;
  readonly envelopeJson: string;
  readonly threadId: string;
  readonly clientTurnId?: string;
  readonly byteLength: number;
  readonly adapterInput: ProviderSendTurnInput;
  readonly resumeGuard: {
    binding: Record<string, unknown>;
    requiresFreshCompanions: boolean;
  };
}

/** Capture at the final effect seam. Signals and live capabilities never enter the DTO. */
export function captureTurnIntent(
  input: ProviderSendTurnInput,
  resumeGuard: CapturedTurnIntent['resumeGuard'],
): CapturedTurnIntent {
  const dto: Record<string, unknown> = { text: input.input };
  for (const key of [
    'displayInput',
    'ambientContext',
    'attachments',
    'modelId',
    'modelOptions',
    'reviewIsolation',
    'confinement',
    'metadata',
    'recoveryCorrelationId',
  ] as const) {
    if (input[key] !== undefined) dto[key] = input[key];
  }
  const inputJson = canonical(dto);
  const invocationId = randomUUID();
  const inputDigest = digest('station.prepared-turn-input/v1', inputJson);
  const envelopeJson = canonical({
    schema: 'station.prepared-turn/v1',
    invocationId,
    threadId: input.threadId,
    ...(input.clientTurnId === undefined
      ? {}
      : { clientTurnId: input.clientTurnId }),
    input: JSON.parse(inputJson) as Json,
    resumeGuard,
  });
  const intentDigest = digest(
    'station.prepared-turn-envelope/v1',
    envelopeJson,
  );
  const owned = JSON.parse(inputJson) as Omit<
    ProviderSendTurnInput,
    'input'
  > & { text: string };
  const { text, ...options } = owned;
  return {
    intent: { invocationId, inputDigest, intentDigest, bodyRef: intentDigest },
    envelopeJson,
    threadId: input.threadId,
    clientTurnId: input.clientTurnId,
    byteLength: Buffer.byteLength(envelopeJson),
    adapterInput: {
      ...options,
      threadId: input.threadId,
      invocationId,
      input: text,
      ...(input.clientTurnId === undefined
        ? {}
        : { clientTurnId: input.clientTurnId }),
      ...(input.signal ? { signal: input.signal } : {}),
    },
    resumeGuard: JSON.parse(canonical(resumeGuard)),
  };
}

/** Retained bytes are checked against both digest domains before any resume decision. */
export function decodeTurnIntent(row: {
  envelopeJson: string;
  inputDigest: string;
  intentDigest: string;
  invocationId: string;
  threadId: string;
}): CapturedTurnIntent & { input: z.infer<typeof retainedInputSchema> } {
  const envelope = retainedEnvelopeSchema.parse(JSON.parse(row.envelopeJson));
  if (
    envelope.invocationId !== row.invocationId ||
    envelope.threadId !== row.threadId ||
    canonical(envelope) !== row.envelopeJson ||
    digest('station.prepared-turn-input/v1', canonical(envelope.input)) !==
      row.inputDigest ||
    digest('station.prepared-turn-envelope/v1', row.envelopeJson) !==
      row.intentDigest
  )
    throw new Error('Prepared turn input is unavailable.');
  const { text, ...options } = envelope.input;
  return {
    intent: {
      invocationId: row.invocationId,
      inputDigest: row.inputDigest,
      intentDigest: row.intentDigest,
      bodyRef: row.intentDigest,
    },
    envelopeJson: row.envelopeJson,
    threadId: row.threadId,
    input: envelope.input,
    resumeGuard: envelope.resumeGuard,
    clientTurnId: envelope.clientTurnId,
    byteLength: Buffer.byteLength(row.envelopeJson),
    adapterInput: {
      ...options,
      input: text,
      threadId: row.threadId,
      invocationId: row.invocationId,
      ...(envelope.clientTurnId === undefined
        ? {}
        : { clientTurnId: envelope.clientTurnId }),
    },
  };
}

/** Compare fresh preparation facts without changing the captured adapter payload. */
export function samePreparedValue(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}
