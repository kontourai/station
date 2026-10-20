import { createHash } from 'node:crypto';
import {
  type ChatAttachmentInput,
  parseChatAttachmentDataUrl,
  validateChatAttachments,
} from '@kontourai/station-contracts/chat-attachment';
import type { ExecutionTarget } from '@kontourai/station-contracts/execution-target';
import {
  CLIENT_TURN_INPUT_UNSUPPORTED_CODE,
  type ProviderSendTurnInput,
} from '@kontourai/station-contracts/provider';
import type { SkillExperienceStartInputV1 } from '@kontourai/station-contracts/skill-experience';
import { SendTurnRefusedError } from '../../providers/adapter-shape.js';

export class TurnSubmissionUnsupportedError extends SendTurnRefusedError {
  readonly code = CLIENT_TURN_INPUT_UNSUPPORTED_CODE;
  constructor() {
    super(
      'This keyed turn contains input that cannot be represented by the submission digest contract.',
      'input_unsupported',
    );
    this.name = 'TurnSubmissionUnsupportedError';
  }
}

/** JSON only: JSON.stringify must never silently drop part of the intent. */
function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (typeof value !== 'object' || value === null || ancestors.has(value))
    throw new TurnSubmissionUnsupportedError();
  const array = Array.isArray(value);
  if (array && Object.getPrototypeOf(value) !== Array.prototype)
    throw new TurnSubmissionUnsupportedError();
  if (
    !array &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    throw new TurnSubmissionUnsupportedError();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string'))
    throw new TurnSubmissionUnsupportedError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of keys) {
    if (array && key === 'length') continue;
    const descriptor = descriptors[key as string];
    if (!descriptor.enumerable || !('value' in descriptor))
      throw new TurnSubmissionUnsupportedError();
  }
  ancestors.add(value);
  try {
    if (array) {
      if (
        keys.length !== value.length + 1 ||
        !Array.from({ length: value.length }, (_, index) =>
          Object.hasOwn(value, index),
        ).every(Boolean)
      )
        throw new TurnSubmissionUnsupportedError();
      return `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`;
    }
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(descriptors[key].value, ancestors)}`,
      )
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Own JSON intent without JSON.stringify silently discarding unsupported values. */
export function snapshotTurnSubmissionValue<T>(value: T): T {
  return JSON.parse(canonicalJson(value));
}

/** Snapshot only named intent fields; authority objects remain live references. */
export function snapshotTurnSubmissionFields<T extends object>(
  input: T,
  fields: readonly (keyof T)[],
): T {
  const captured = { ...input };
  for (const field of fields) {
    if (input[field] !== undefined)
      captured[field] = snapshotTurnSubmissionValue(input[field]);
  }
  return captured;
}

/** Copy client intent while keeping cancellation and server authority references live. */
export function snapshotDirectTurnInput<
  T extends ProviderSendTurnInput & { expectedInputRequest?: unknown },
>(input: T): T {
  return snapshotTurnSubmissionFields(input, [
    'modelOptions',
    'metadata',
    'attachments',
    'expectedInputRequest',
  ]);
}

/** Captured authorized client intent, before transcript/prompt/model preparation. */
function turnSubmissionDigest(input: {
  text: string;
  ambientContext?: string;
  modelId?: string;
  modelOptions?: Record<string, unknown>;
  attachments?: ChatAttachmentInput[];
  skillExperience?: SkillExperienceStartInputV1;
  scope?: unknown;
}): string {
  if (validateChatAttachments(input.attachments ?? []))
    throw new TurnSubmissionUnsupportedError();
  const attachments = (input.attachments ?? []).map((attachment) => {
    const parsed = parseChatAttachmentDataUrl(attachment.dataUrl);
    if (!parsed) throw new TurnSubmissionUnsupportedError();
    return {
      kind: attachment.kind,
      name: attachment.name,
      mimeType: attachment.mimeType,
      contentDigest: createHash('sha256')
        .update(Buffer.from(parsed.base64, 'base64'))
        .digest('hex'),
    };
  });
  const document = {
    domain: 'station.orchestration.turn-submission',
    version: 1,
    text: input.text,
    ambientContext: input.ambientContext ?? null,
    modelId: input.modelId ?? null,
    modelOptions: input.modelOptions ?? null,
    attachments,
    skillExperience: input.skillExperience ?? null,
    scope: input.scope ?? null,
  };
  return `station-turn-submission/v1:sha256:${createHash('sha256').update(canonicalJson(document)).digest('hex')}`;
}

/** Direct orchestration callers have no earlier foreground composition step. */
export function directTurnSubmissionDigest(
  input: ProviderSendTurnInput & { expectedInputRequest?: unknown },
  skillExperience?: SkillExperienceStartInputV1,
): string {
  // These server-owned bags can contain effects outside this bounded contract.
  // Refuse them rather than promise a digest of an incomplete input.
  if (input.metadata && Object.keys(input.metadata).length > 0)
    throw new TurnSubmissionUnsupportedError();
  return turnSubmissionDigest({
    text: input.input,
    ...(input.ambientContext !== undefined
      ? { ambientContext: input.ambientContext }
      : {}),
    ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
    ...(input.modelOptions !== undefined
      ? { modelOptions: input.modelOptions }
      : {}),
    ...(input.attachments !== undefined
      ? { attachments: input.attachments }
      : {}),
    ...(skillExperience ? { skillExperience } : {}),
    scope: {
      threadId: input.threadId,
      displayInput: input.displayInput ?? null,
      expectedInputRequest: input.expectedInputRequest ?? null,
    },
  });
}

/** Foreground identity is shared by live sends and their durable inbox placement. */
export function foregroundTurnSubmissionDigest(input: {
  message: string;
  target: ExecutionTarget;
  ambientContext?: string;
  attachments?: ChatAttachmentInput[];
  skillExperience?: SkillExperienceStartInputV1;
  ephemeral?: boolean;
  expectedInputRequest?: unknown;
  setApprovalMode?: unknown;
  setApprovalModeBasedOn?: unknown;
}): string {
  return turnSubmissionDigest({
    text: input.message,
    ...(input.ambientContext !== undefined
      ? { ambientContext: input.ambientContext }
      : {}),
    ...(input.target.model?.override !== undefined
      ? { modelId: input.target.model.override }
      : {}),
    ...(input.attachments ? { attachments: input.attachments } : {}),
    ...(input.skillExperience
      ? { skillExperience: input.skillExperience }
      : {}),
    scope: {
      target: input.target,
      ephemeral: input.ephemeral ?? false,
      expectedInputRequest: input.expectedInputRequest ?? null,
      setApprovalMode: input.setApprovalMode ?? null,
      setApprovalModeBasedOn: input.setApprovalModeBasedOn ?? null,
    },
  });
}
