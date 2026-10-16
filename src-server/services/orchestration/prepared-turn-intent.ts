import { createHash, randomUUID } from 'node:crypto';
import type { PreparedTurnIntent } from '@kontourai/monument';
import type { ProviderSendTurnInput } from '../../providers/adapter-shape.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

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
      if (Object.keys(value).length !== value.length)
        throw new Error(
          'Prepared turn input cannot contain sparse or decorated arrays.',
        );
      return `[${value.map((item) => canonical(item, ancestors)).join(',')}]`;
    }
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
}

/** Capture at the final effect seam. Signals and live capabilities never enter the DTO. */
export function captureTurnIntent(
  input: ProviderSendTurnInput,
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
      input: text,
      ...(input.clientTurnId === undefined
        ? {}
        : { clientTurnId: input.clientTurnId }),
      ...(input.signal ? { signal: input.signal } : {}),
    },
  };
}
