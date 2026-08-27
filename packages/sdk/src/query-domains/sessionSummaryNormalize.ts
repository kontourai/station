import type {
  ConversationIntentSummaryContextBoundary,
  ConversationIntentSummaryRelatedEvidenceRef,
  ConversationIntentSummaryV2,
  ConversationIntentSummaryVerificationRef,
} from '@kontourai/station-contracts/conversation-intent-summary';
import { CONVERSATION_INTENT_SUMMARY_MAX_ITEMS } from '@kontourai/station-contracts/conversation-intent-summary';

export type NormalizedSessionSummary = ConversationIntentSummaryV2 & {
  summarizedFromMessageId?: string;
  summarizedThroughMessageId?: string;
  summarizedMessageCount?: number;
};

export function normalizeSessionSummary(
  value: unknown,
): NormalizedSessionSummary | null {
  if (!isRecord(value)) return null;
  if (value.version === 2) return normalizeV2(value);
  if (value.version === 1) return normalizeV1(value);
  return null;
}

function normalizeV2(
  raw: Record<string, unknown>,
): NormalizedSessionSummary | null {
  const sourceRange = isSummaryRange(raw.sourceRange) ? raw.sourceRange : null;
  const sourceRanges = summaryRanges(raw.sourceRanges);
  const usage = summaryUsage(raw.generationUsage);
  const refs = summaryRefs(raw.verificationRefs);
  const relatedEvidenceRefs = parseRelatedEvidenceRefs(raw.relatedEvidenceRefs);
  const contextBoundaries = parseContextBoundaries(raw.contextBoundaries);
  const lists = [
    stringList(raw.goals),
    stringList(raw.constraints),
    stringList(raw.progress),
    stringList(raw.nextSteps),
    stringList(raw.reportedCompletion),
  ];
  if (
    !isNonBlank(raw.text) ||
    !isNonBlank(raw.overview) ||
    !isNonBlank(raw.model) ||
    !isNonBlank(raw.generatedAt) ||
    !isNonBlank(raw.sourceRevision) ||
    !sourceRange ||
    !sourceRanges ||
    !usage ||
    !refs ||
    !relatedEvidenceRefs ||
    !contextBoundaries ||
    lists.some((list) => !list) ||
    !isCount(raw.sourceMessageCount) ||
    !isCount(raw.contextBoundaryCount) ||
    typeof raw.partialMessageIncluded !== 'boolean' ||
    typeof raw.stale !== 'boolean'
  )
    return null;
  return {
    version: 2,
    text: raw.text,
    overview: raw.overview,
    goals: lists[0]!,
    constraints: lists[1]!,
    progress: lists[2]!,
    nextSteps: lists[3]!,
    reportedCompletion: lists[4]!,
    relatedEvidenceRefs,
    verificationRefs: refs,
    model: raw.model,
    generatedAt: raw.generatedAt,
    sourceRange,
    sourceRanges,
    sourceRevision: raw.sourceRevision,
    sourceMessageCount: raw.sourceMessageCount,
    partialMessageIncluded: raw.partialMessageIncluded,
    contextBoundaryCount: raw.contextBoundaryCount,
    contextBoundaries,
    generationUsage: usage,
    stale: raw.stale,
  };
}

function normalizeV1(
  raw: Record<string, unknown>,
): NormalizedSessionSummary | null {
  if (
    !isNonBlank(raw.text) ||
    !isNonBlank(raw.model) ||
    !isNonBlank(raw.generatedAt) ||
    !isNonBlank(raw.summarizedFromMessageId) ||
    !isNonBlank(raw.summarizedThroughMessageId) ||
    !isCount(raw.summarizedMessageCount) ||
    !isCount(raw.sourceMessageCount) ||
    typeof raw.partialMessageIncluded !== 'boolean' ||
    typeof raw.stale !== 'boolean'
  )
    return null;
  const range = {
    fromMessageId: raw.summarizedFromMessageId,
    throughMessageId: raw.summarizedThroughMessageId,
    messageCount: raw.summarizedMessageCount,
  };
  return {
    version: 2,
    text: raw.text,
    overview: raw.text,
    goals: [],
    constraints: [],
    progress: [],
    nextSteps: [],
    reportedCompletion: [],
    relatedEvidenceRefs: [],
    verificationRefs: [],
    model: raw.model,
    generatedAt: raw.generatedAt,
    sourceRange: range,
    sourceRanges: [range],
    sourceRevision: 'legacy-v1',
    sourceMessageCount: raw.sourceMessageCount,
    partialMessageIncluded: raw.partialMessageIncluded,
    contextBoundaryCount: 0,
    contextBoundaries: [],
    generationUsage: { state: 'unknown' },
    stale: raw.stale,
    summarizedFromMessageId: raw.summarizedFromMessageId,
    summarizedThroughMessageId: raw.summarizedThroughMessageId,
    summarizedMessageCount: raw.summarizedMessageCount,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isNonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
function isCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 10_000
  );
}
function isSummaryRange(
  value: unknown,
): value is NormalizedSessionSummary['sourceRange'] {
  return (
    isRecord(value) &&
    isNonBlank(value.fromMessageId) &&
    isNonBlank(value.throughMessageId) &&
    isCount(value.messageCount)
  );
}
function stringList(value: unknown): string[] | null {
  return Array.isArray(value) &&
    value.length <= CONVERSATION_INTENT_SUMMARY_MAX_ITEMS &&
    value.every(isNonBlank)
    ? value
    : null;
}
function summaryRanges(
  value: unknown,
): NormalizedSessionSummary['sourceRanges'] | null {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.length <= CONVERSATION_INTENT_SUMMARY_MAX_ITEMS &&
    value.every(isSummaryRange)
    ? value
    : null;
}
function summaryUsage(
  value: unknown,
): NormalizedSessionSummary['generationUsage'] | null {
  if (!isRecord(value)) return null;
  if (value.state === 'unknown') return { state: 'unknown' };
  return value.state === 'observed' &&
    isCount(value.inputTokens) &&
    isCount(value.outputTokens)
    ? {
        state: 'observed',
        inputTokens: value.inputTokens,
        outputTokens: value.outputTokens,
      }
    : null;
}
function summaryRefs(
  value: unknown,
): ConversationIntentSummaryVerificationRef[] | null {
  if (
    !Array.isArray(value) ||
    value.length > CONVERSATION_INTENT_SUMMARY_MAX_ITEMS
  )
    return null;
  const refs: ConversationIntentSummaryVerificationRef[] = [];
  for (const item of value) {
    if (!isRecord(item) || item.kind !== 'task-turn') return null;
    if (
      item.state === 'observed' &&
      isNonBlank(item.taskId) &&
      isNonBlank(item.turnId) &&
      isNonBlank(item.eventId)
    )
      refs.push({
        kind: 'task-turn',
        state: 'observed',
        taskId: item.taskId,
        turnId: item.turnId,
        eventId: item.eventId,
      });
    else if (
      item.state === 'unavailable' &&
      (item.unavailableReason === 'not-captured-by-station' ||
        item.unavailableReason === 'not-authorized' ||
        item.unavailableReason === 'revoked')
    )
      refs.push({
        kind: 'task-turn',
        state: 'unavailable',
        unavailableReason: item.unavailableReason,
      });
    else return null;
  }
  return refs;
}

function parseRelatedEvidenceRefs(
  value: unknown,
): ConversationIntentSummaryRelatedEvidenceRef[] | null {
  if (
    !Array.isArray(value) ||
    value.length > CONVERSATION_INTENT_SUMMARY_MAX_ITEMS
  )
    return null;
  const refs: ConversationIntentSummaryRelatedEvidenceRef[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      item.kind !== 'task-turn' ||
      !isNonBlank(item.taskId) ||
      !isNonBlank(item.turnId) ||
      !isNonBlank(item.eventId)
    )
      return null;
    refs.push({
      kind: 'task-turn',
      taskId: item.taskId,
      turnId: item.turnId,
      eventId: item.eventId,
    });
  }
  return refs;
}

function parseContextBoundaries(
  value: unknown,
): readonly ConversationIntentSummaryContextBoundary[] | null {
  if (
    !Array.isArray(value) ||
    value.length > CONVERSATION_INTENT_SUMMARY_MAX_ITEMS
  )
    return null;
  const boundaries: ConversationIntentSummaryContextBoundary[] = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      !isNonBlank(item.boundaryId) ||
      (item.policy !== 'continue-from-history' &&
        item.policy !== 'empty-next-cold-start') ||
      typeof item.priorTranscriptInjected !== 'boolean'
    )
      return null;
    boundaries.push({
      boundaryId: item.boundaryId,
      policy: item.policy,
      priorTranscriptInjected: item.priorTranscriptInjected,
    });
  }
  return boundaries;
}
