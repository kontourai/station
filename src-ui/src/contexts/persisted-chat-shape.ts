import type { StagedAttachmentReference } from '@kontourai/station-contracts/attachment-staging';
import type { FlowRunFreshness } from '@kontourai/station-contracts/runtime-events';
import type {
  ComposerAttachmentStageSnapshot,
  UnsentMessageRecord,
} from '../types';
import type { TransformationReceipt } from '../utils/heif-normalizer';
import type { PlanArtifact } from '../utils/planArtifacts';
import type { FlowRunBinding } from './active-chats-state';

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

type StageState = ComposerAttachmentStageSnapshot['state'];
const STAGE_STATES: readonly StageState[] = [
  'queued',
  'uploading',
  'retryable',
  'complete',
  'accepted',
  'cancelled',
  'failed',
];

function isStageState(value: unknown): value is StageState {
  return STAGE_STATES.some((state) => state === value);
}

/** The committed send authority a `complete` stage dispatches with. */
function isStagedReference(value: unknown): value is StagedAttachmentReference {
  return (
    isPlainRecord(value) &&
    typeof value.stageId === 'string' &&
    typeof value.clientAttachmentId === 'string' &&
    value.source === 'current-composer' &&
    (value.kind === 'image' || value.kind === 'file') &&
    typeof value.name === 'string' &&
    typeof value.mimeType === 'string' &&
    typeof value.size === 'number' &&
    typeof value.digest === 'string' &&
    value.digest.startsWith('sha256-') &&
    typeof value.expiresAt === 'string'
  );
}

function isByteSummary(
  value: unknown,
): value is { mimeType: string; bytes: number; sha256: string } {
  return (
    isPlainRecord(value) &&
    typeof value.mimeType === 'string' &&
    typeof value.bytes === 'number' &&
    typeof value.sha256 === 'string'
  );
}

function isTransformationReceipt(
  value: unknown,
): value is TransformationReceipt {
  return (
    isPlainRecord(value) &&
    value.kind === 'heif-to-jpeg' &&
    value.adapter === 'browser-native' &&
    isByteSummary(value.source) &&
    isPlainRecord(value.output) &&
    typeof value.output.name === 'string' &&
    isByteSummary(value.output)
  );
}

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
    !isStageState(state)
  ) {
    return null;
  }
  return {
    clientAttachmentId,
    name,
    mimeType,
    size,
    state,
    progress: typeof progress === 'number' ? progress : 0,
    ...(typeof stageId === 'string' ? { stageId } : {}),
    // A reference that is not the object the dispatcher reads is no
    // reference at all; `readAttachmentStages` then asks for the file.
    ...(isStagedReference(reference) ? { reference } : {}),
    ...(delivery === 'legacy-inline' || delivery === 'staged'
      ? { delivery }
      : {}),
    ...(typeof needsFile === 'boolean' ? { needsFile } : {}),
    ...(expired === true ? { expired: true } : {}),
    ...(value.capacityFull === true ? { capacityFull: true } : {}),
    ...(typeof error === 'string' ? { error } : {}),
    ...(isTransformationReceipt(transformation) ? { transformation } : {}),
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

const PLAN_SOURCES = ['assistant', 'reasoning', 'canonical'] as const;
const PLAN_STEP_STATUSES = ['pending', 'in_progress', 'completed'] as const;

export function readPlanArtifact(value: unknown): PlanArtifact | null {
  if (
    !isPlainRecord(value) ||
    typeof value.rawText !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !Array.isArray(value.steps)
  ) {
    return null;
  }
  const source = PLAN_SOURCES.find((candidate) => candidate === value.source);
  if (!source) return null;
  const steps: PlanArtifact['steps'] = [];
  for (const step of value.steps) {
    if (!isPlainRecord(step) || typeof step.content !== 'string') return null;
    const status = PLAN_STEP_STATUSES.find(
      (candidate) => candidate === step.status,
    );
    if (!status) return null;
    steps.push({ content: step.content, status });
  }
  return {
    source,
    rawText: value.rawText,
    steps,
    updatedAt: value.updatedAt,
  };
}

function isFlowRunFreshness(value: unknown): value is FlowRunFreshness {
  return (
    isPlainRecord(value) &&
    (value.lastEvaluatedAt === null ||
      typeof value.lastEvaluatedAt === 'string') &&
    (value.blockedReason === undefined ||
      value.blockedReason === 'ungated-step') &&
    typeof value.gateOutcomeCount === 'number' &&
    typeof value.evidenceCount === 'number'
  );
}

export function readFlowRunBinding(value: unknown): FlowRunBinding | null {
  if (
    !isPlainRecord(value) ||
    typeof value.runId !== 'string' ||
    typeof value.definitionId !== 'string' ||
    typeof value.resumed !== 'boolean'
  ) {
    return null;
  }
  return {
    runId: value.runId,
    definitionId: value.definitionId,
    resumed: value.resumed,
    ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
    ...(typeof value.currentStep === 'string'
      ? { currentStep: value.currentStep }
      : {}),
    ...(isFlowRunFreshness(value.freshness)
      ? { freshness: value.freshness }
      : {}),
  };
}

export { optionalString };
