import type {
  ComposerAttachmentStageSnapshot,
  UnsentMessageRecord,
} from '../types';
import type { PlanArtifact } from '../utils/planArtifacts';

/**
 * Restore-time shape checks for the chat state `activeChatsStore` keeps in
 * sessionStorage.
 *
 * sessionStorage outlives a UI build: a server update reloads the tab into new
 * code that reads the previous build's payload. `hydrateActiveChats` used to
 * trust every nested field, so one entry in an older (or corrupted) shape —
 * `attachmentStages` that was not an array was the reproduced case — threw
 * inside render (`stages.some is not a function`) and "Chat could not open"
 * came back on every retry, because retry rehydrated the same payload.
 *
 * Each reader returns the value when it has the shape the UI reads, and drops
 * it otherwise. Dropping loses only restore-time convenience state: an
 * attachment stage without its File bytes, a malformed history line. User-held
 * content with a known shape (queued and unsent messages) is kept entry by
 * entry, so one bad entry never costs its siblings.
 */

export function isPlainRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export function plainRecordOrUndefined(
  value: unknown,
): Record<string, unknown> | undefined {
  return isPlainRecord(value) ? value : undefined;
}

const STAGE_STATES = new Set<ComposerAttachmentStageSnapshot['state']>([
  'queued',
  'uploading',
  'retryable',
  'complete',
  'accepted',
  'cancelled',
  'failed',
]);

function readStage(value: unknown): ComposerAttachmentStageSnapshot | null {
  if (!isPlainRecord(value)) return null;
  const {
    clientAttachmentId,
    name,
    mimeType,
    size,
    state,
    progress,
    stageId,
    reference,
    delivery,
    needsFile,
    expired,
    error,
    transformation,
  } = value;
  if (
    typeof clientAttachmentId !== 'string' ||
    typeof name !== 'string' ||
    typeof mimeType !== 'string' ||
    typeof size !== 'number' ||
    typeof state !== 'string' ||
    !STAGE_STATES.has(state as ComposerAttachmentStageSnapshot['state'])
  ) {
    return null;
  }
  // A committed reference is the send authority for a `complete` stage; one
  // that is not the object the dispatcher reads is no reference at all.
  const validReference =
    isPlainRecord(reference) &&
    typeof reference.stageId === 'string' &&
    typeof reference.expiresAt === 'string';
  return {
    clientAttachmentId,
    name,
    mimeType,
    size,
    state: state as ComposerAttachmentStageSnapshot['state'],
    progress: typeof progress === 'number' ? progress : 0,
    ...(typeof stageId === 'string' ? { stageId } : {}),
    ...(validReference
      ? {
          reference:
            reference as unknown as ComposerAttachmentStageSnapshot['reference'],
        }
      : {}),
    ...(delivery === 'legacy-inline' || delivery === 'staged'
      ? { delivery }
      : {}),
    ...(typeof needsFile === 'boolean' ? { needsFile } : {}),
    ...(expired === true ? { expired: true } : {}),
    ...(typeof error === 'string' ? { error } : {}),
    ...(isPlainRecord(transformation)
      ? {
          transformation:
            transformation as unknown as ComposerAttachmentStageSnapshot['transformation'],
        }
      : {}),
  };
}

/**
 * A `complete` stage whose reference did not survive is not sendable; it is
 * restored as needing its file again rather than claiming "Ready".
 */
export function readAttachmentStages(
  value: unknown,
): ComposerAttachmentStageSnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const stage = readStage(entry);
    if (!stage) return [];
    if (stage.state === 'complete' && !stage.reference) {
      return [
        {
          ...stage,
          state: 'failed' as const,
          progress: 0,
          needsFile: true,
          error: 'Choose this file again to send it.',
        },
      ];
    }
    return [stage];
  });
}

export function readUnsentMessages(value: unknown): UnsentMessageRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is UnsentMessageRecord =>
      isPlainRecord(entry) &&
      typeof entry.id === 'string' &&
      typeof entry.content === 'string' &&
      typeof entry.reason === 'string' &&
      typeof entry.at === 'number',
  );
}

export function readQueuedMessageFailure(value: unknown):
  | {
      reviewReason?: 'execution-binding-changed';
      message: string;
      code?: string;
      at: number;
    }
  | undefined {
  if (
    !isPlainRecord(value) ||
    typeof value.message !== 'string' ||
    typeof value.at !== 'number'
  ) {
    return undefined;
  }
  return {
    message: value.message,
    at: value.at,
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
    ...(value.reviewReason === 'execution-binding-changed'
      ? { reviewReason: 'execution-binding-changed' as const }
      : {}),
  };
}

export function readPlanArtifact(value: unknown): PlanArtifact | null {
  return isPlainRecord(value) &&
    typeof value.rawText === 'string' &&
    typeof value.updatedAt === 'string' &&
    Array.isArray(value.steps) &&
    value.steps.every(isPlainRecord)
    ? (value as unknown as PlanArtifact)
    : null;
}

export function readFlowRunBinding<T>(value: unknown): T | null {
  return isPlainRecord(value) &&
    typeof value.runId === 'string' &&
    typeof value.definitionId === 'string'
    ? (value as T)
    : null;
}

export { optionalString };
