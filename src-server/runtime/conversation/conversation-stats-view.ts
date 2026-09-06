import type { ConversationStatsMeasurement } from '@kontourai/station-contracts/runtime';
import {
  calculateContextWindowPercentage,
  getMessageTextContent,
} from './usage-stats.js';

/**
 * Every figure an engine may or may not report is optional: absent means
 * "nothing measured this", never "measured zero" (archive#3201). `turns`
 * and `toolCalls` stay required — Station counts those events itself.
 */
export interface ConversationStats {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /**
   * Prompt-cache figures the engine reported (archive#4196). Absent when
   * no event ever carried one — the station-memory path has no cache
   * concept, so its views legitimately never set these, and the empty view
   * does NOT invent zeros for them.
   */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  contextTokens?: number;
  turns: number;
  toolCalls: number;
  estimatedCost?: number;
  tokenBreakdown?: {
    userMessageTokens?: number;
    assistantMessageTokens?: number;
    systemPromptTokens?: number;
    mcpServerTokens?: number;
  };
}

export interface ConversationStatsViewInput {
  stats?: Omit<ConversationStats, 'estimatedCost'> & {
    estimatedCost?: number | null;
  };
  conversationId?: string;
  modelId: string;
  modelStats?: Record<string, unknown>;
  /**
   * Station's own estimate of what IT would send as a system prompt / tool
   * schema for this agent. Omitted for an engine-events view: the external
   * engine composed its own context, so Station's spec-derived figure would
   * describe a prompt that engine never sent (archive#3201's `MCP Tools: 1`,
   * which was `Math.ceil(len('[]') / 4)`).
   */
  systemPromptTokens?: number;
  mcpServerTokens?: number;
  userMessageTokens?: number;
  assistantMessageTokens?: number;
  notFound?: boolean;
  /** See `calculateContextWindowPercentage` (archive#1299 item 3a). */
  contextWindowTokens?: number;
  measurement?: ConversationStatsMeasurement;
}

export function buildEmptyConversationStatsView({
  modelId,
  systemPromptTokens,
  mcpServerTokens,
  notFound = false,
  contextWindowTokens,
}: {
  modelId: string;
  systemPromptTokens: number;
  mcpServerTokens: number;
  notFound?: boolean;
  contextWindowTokens?: number;
}) {
  const contextTokens = systemPromptTokens + mcpServerTokens;
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    contextTokens,
    turns: 0,
    toolCalls: 0,
    estimatedCost: 0,
    contextWindowPercentage: calculateContextWindowPercentage(
      contextTokens,
      contextWindowTokens,
    ),
    modelId,
    systemPromptTokens,
    mcpServerTokens,
    userMessageTokens: 0,
    assistantMessageTokens: 0,
    contextFilesTokens: 0,
    // Station's own accounting is what this view represents: it covers
    // every turn it ran, so its zeros are counted zeros.
    measurement: { source: 'station-memory' as const },
    ...(notFound ? { notFound: true } : {}),
  };
}

export function resolveConversationUserMessageTokens(
  messages: any[] = [],
): number {
  return messages
    .filter((message) => message.role === 'user')
    .reduce((sum, message) => {
      const content = getMessageTextContent(message);
      return sum + Math.ceil(content.length / 4);
    }, 0);
}

export function buildConversationStatsView({
  stats,
  conversationId,
  modelId,
  modelStats = {},
  systemPromptTokens,
  mcpServerTokens,
  userMessageTokens,
  assistantMessageTokens,
  notFound,
  contextWindowTokens,
  measurement = { source: 'station-memory' as const },
}: ConversationStatsViewInput) {
  if (!stats) {
    return buildEmptyConversationStatsView({
      modelId,
      systemPromptTokens: systemPromptTokens ?? 0,
      mcpServerTokens: mcpServerTokens ?? 0,
      notFound,
      contextWindowTokens,
    });
  }

  const fromStationMemory = measurement.source === 'station-memory';
  /**
   * Station's own accounting tracks a real `contextTokens`; when an older
   * record predates that field, its `totalTokens` is still Station's own
   * measurement of the same conversation, so the fallback stays for that
   * path. It must NOT extend to an engine-events view: there `totalTokens`
   * is a SUM ACROSS TURNS of what each turn sent and received, which is not
   * context occupancy and overstates it without bound as a session grows
   * (archive#1299's "contextTokens formula double-counts"). An engine that
   * reports no context observation has none here.
   */
  const contextTokens = fromStationMemory
    ? (stats.contextTokens ?? stats.totalTokens)
    : stats.contextTokens;

  return {
    ...stats,
    // A cost figure survives only if it is usable; an absent one stays
    // absent instead of collapsing to a `$0.0000` nobody measured.
    estimatedCost:
      typeof stats.estimatedCost === 'number' &&
      Number.isFinite(stats.estimatedCost) &&
      stats.estimatedCost >= 0
        ? stats.estimatedCost
        : undefined,
    contextTokens,
    contextWindowPercentage: calculateContextWindowPercentage(
      contextTokens,
      contextWindowTokens,
    ),
    conversationId,
    modelId,
    modelStats: modelStatsForWire(modelStats),
    systemPromptTokens,
    mcpServerTokens,
    userMessageTokens,
    assistantMessageTokens: assistantMessageTokens ?? stats.outputTokens,
    // Station's context-file injection is accounted only on its own path;
    // an engine-events view has no measurement of it at all.
    contextFilesTokens: fromStationMemory ? 0 : undefined,
    measurement,
  };
}

/** Storage uses null for an unpriced model; the wire represents it by absence. */
function modelStatsForWire(modelStats: Record<string, unknown>) {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' &&
    value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null);
  // Preserve malformed containers/rows for the shared validator to reject.
  if (!isRecord(modelStats)) return modelStats;
  return Object.fromEntries(
    Object.entries(modelStats).map(([modelId, stats]) => {
      if (!isRecord(stats) || stats.estimatedCost !== null)
        return [modelId, stats];
      const { estimatedCost: _unreportedCost, ...measured } = stats;
      return [modelId, measured];
    }),
  );
}
