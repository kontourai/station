import {
  type ProviderPromptCacheInclusivity,
  providerPromptCacheInclusivity,
  type SessionUsageAggregate,
} from '@kontourai/station-shared/usage-fold';
import { UNNAMED_AGENT } from '../../src-shared/monitoring-keys.js';

export interface DailyStats {
  messages: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  byAgent: Record<string, number>;
}

/**
 * What the lifetime figures below are a sum OVER, for the half of the corpus
 * where "not reported" is a real state (archive#3245).
 *
 * A lifetime total is a sum, and a sum is exactly where archive#3201's rule —
 * *optional/`undefined` = never reported; a number, including `0` = reported*
 * — silently dies: adding an absent measurement as `0` turns "nobody measured
 * this" back into "measured zero", which is the defect that issue exists to
 * close. So the sum never absorbs an absence, and instead publishes its own
 * denominator: `sessionsReportingCost` of `sessions` engine sessions
 * contributed to `totalCost`, and the rest contributed **nothing** rather
 * than a zero.
 *
 * The denominator counts ENGINE (orchestration) sessions only, and that is
 * the same rule rather than a convenient scope: archive#3201 defines
 * `station-memory` absence as Station's own recorded zero with nothing to
 * disclose, and `engine-events` absence as a question nobody asked
 * (`SessionMeasurementView.source` in
 * `packages/shared/src/usage-measurement.ts`). Only the second class has
 * coverage to state.
 *
 * It is a statement about SESSIONS, not about the printed number, so it stays
 * true even when `mergeRescannedUsageStats` keeps a larger previously-latched
 * total than this rescan derived.
 */
export interface EngineUsageCoverage {
  /** Engine sessions folded into the lifetime totals by the last rescan. */
  sessions: number;
  /** ...that reported at least one token count. */
  sessionsReportingTokens: number;
  /** ...that reported a cost. */
  sessionsReportingCost: number;
}

/**
 * One orchestration session as lifetime analytics consumes it: its identity,
 * who to attribute it to, and the ONE shared derivation of what it used
 * (`foldUsageEvents`, reached through `OrchestrationService.readSessionUsage`).
 * There is deliberately no reducer, scope handling, or event access here —
 * archive#3245's whole point is that the aggregator gains a consumer of the
 * existing fold rather than a second one.
 */
export interface OrchestrationSessionUsage {
  threadId: string;
  /**
   * The id this session writes its transcript under — `session.configured`'s
   * `metadata.conversationId`, falling back to the thread id. It is the join
   * key against the legacy memory substrate, which names its files
   * `agents/<slug>/memory/sessions/<conversationId>.ndjson`.
   */
  conversationId: string;
  /** Absent when the session reported none (archive#3082); never a literal. */
  agentSlug?: string;
  usage: SessionUsageAggregate;
}

export interface UsageStats {
  lifetime: {
    totalMessages: number;
    totalConversations: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    /**
     * Prompt-cache tokens engines reported, kept as SEPARATE counters
     * (archive#4196). Deliberately never blended into `totalInputTokens`:
     * whether a provider's input figure already contains its cache figures
     * differs per provider and is unresolved for some
     * (`PROVIDER_PROMPT_CACHE_INCLUSIVITY`,
     * `@kontourai/station-shared/usage-fold`), so folding cache into the
     * input counter would double-count a subset reporter invisibly.
     * Optional because older persisted stores predate them and absence
     * means "no session ever reported a cache figure", not a measured zero
     * (archive#3201).
     */
    totalCacheReadTokens?: number;
    totalCacheWriteTokens?: number;
    totalCost: number;
    uniqueAgents: string[];
    firstMessageDate?: string;
    lastMessageDate?: string;
    streak?: number;
    daysActive?: number;
    /** See {@link EngineUsageCoverage}. Written only by a full rescan. */
    engineUsageCoverage?: EngineUsageCoverage;
  };
  byModel: Record<string, ModelUsageStats>;
  byAgent: Record<
    string,
    {
      conversations: number;
      messages: number;
      cost: number;
    }
  >;
  byDate: Record<string, DailyStats>;
}

/**
 * Per-model lifetime usage. Cache counters are optional for the same reason
 * as the session-fold fields: absent means the model's sessions never
 * reported that component, while zero is a provider measurement.
 *
 * A cache-inclusive prompt sum is allowed only when every token-bearing
 * session assigned to this model had the same named provider. The
 * `cacheProviderAttribution` marker makes a mixed or missing identity fail
 * closed rather than letting a later session accidentally restore a provider
 * declaration over earlier un-attributed data.
 */
export interface ModelUsageStats {
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheProvider?: string;
  cacheInclusivity?: ProviderPromptCacheInclusivity;
  cacheProviderAttribution?: 'single' | 'indeterminate';
}

export interface Achievement {
  id: string;
  name: string;
  description: string;
  unlocked: boolean;
  unlockedAt?: string;
  progress?: number;
  threshold?: number;
  progressPercent?: number;
  lowerIsBetter?: boolean;
  precondition?: { label: string; current: number; threshold: number };
}

export const ACHIEVEMENTS = [
  {
    id: 'first-message',
    name: 'First Steps',
    description: 'Send your first message',
    threshold: 1,
  },
  {
    id: 'conversationalist',
    name: 'Conversationalist',
    description: 'Send 100 messages',
    threshold: 100,
  },
  {
    id: 'power-user',
    name: 'Power User',
    description: 'Send 1,000 messages',
    threshold: 1000,
  },
  {
    id: 'model-explorer',
    name: 'Model Explorer',
    description: 'Use 5 different models',
    threshold: 5,
  },
  {
    id: 'cost-conscious',
    name: 'Cost Conscious',
    description: 'Keep average cost under $0.01/message',
    threshold: 0.01,
  },
] as const;

interface UsageLike {
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: number;
}

interface MessageLike {
  metadata?: {
    usage?: UsageLike;
    model?: string;
    timestamp?: string;
  };
}

export function createEmptyUsageStats(): UsageStats {
  return {
    lifetime: {
      totalMessages: 0,
      totalConversations: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      uniqueAgents: [],
    },
    byModel: {},
    byAgent: {},
    byDate: {},
  };
}

function createEmptyModelUsageStats(): ModelUsageStats {
  return { messages: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
}

interface ModelPromptCacheWrite {
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  provider?: string;
}

function usageHasPromptOrCacheComponent(usage: ModelPromptCacheWrite): boolean {
  return (
    usage.inputTokens !== undefined ||
    usage.cacheReadTokens !== undefined ||
    usage.cacheWriteTokens !== undefined
  );
}

/**
 * Every writer into a model's prompt/cache figures calls this one helper.
 * Records the provider declaration only while it remains true for every
 * prompt/cache-bearing write in the bucket. One missing or different provider
 * makes the bucket indeterminate permanently, so legacy message/enrichment
 * totals cannot later be relabeled as a verified Claude-only total.
 */
function applyModelPromptCacheAttribution(
  model: ModelUsageStats,
  usage: ModelPromptCacheWrite,
): void {
  if (!usageHasPromptOrCacheComponent(usage)) return;

  if (model.cacheProviderAttribution === undefined) {
    if (usage.provider === undefined) {
      model.cacheProviderAttribution = 'indeterminate';
      return;
    }
    model.cacheProviderAttribution = 'single';
    model.cacheProvider = usage.provider;
    model.cacheInclusivity = providerPromptCacheInclusivity(usage.provider);
    return;
  }

  if (
    model.cacheProviderAttribution !== 'single' ||
    model.cacheProvider !== usage.provider
  ) {
    model.cacheProviderAttribution = 'indeterminate';
    delete model.cacheProvider;
    delete model.cacheInclusivity;
  }
}

function updateDailyUsage(
  stats: UsageStats,
  date: string,
  agentSlug: string,
  usage?: UsageLike,
): void {
  if (!stats.byDate[date]) {
    stats.byDate[date] = {
      messages: 0,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      byAgent: {},
    };
  }
  const day = stats.byDate[date];
  day.messages++;
  if (usage) {
    day.inputTokens += usage.inputTokens || 0;
    day.outputTokens += usage.outputTokens || 0;
    day.cost += usage.estimatedCost || 0;
  }
  day.byAgent[agentSlug] = (day.byAgent[agentSlug] || 0) + 1;
}

/**
 * Apply the usage fields that arrive after an assistant message has already
 * been persisted and counted. This deliberately leaves lifetime/day/agent
 * message counts alone; the by-model message entry is established here only
 * when the enriched model identity was absent from the original write.
 */
export function applyEnrichmentUsageToUsageStats(
  stats: UsageStats,
  message: MessageLike,
  agentSlug: string,
  fallbackModelId = '',
  previousModelId = '',
): void {
  const usage = message.metadata?.usage;
  if (!usage) return;

  const modelId = message.metadata?.model || fallbackModelId;
  const timestamp = message.metadata?.timestamp;
  const date = timestamp
    ? new Date(timestamp).toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0];

  const inputTokens = usage.inputTokens || 0;
  const outputTokens = usage.outputTokens || 0;
  const cost = usage.estimatedCost || 0;
  stats.lifetime.totalInputTokens += inputTokens;
  stats.lifetime.totalOutputTokens += outputTokens;
  stats.lifetime.totalCost += cost;

  if (!stats.byDate[date]) {
    stats.byDate[date] = {
      messages: 0,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      byAgent: {},
    };
  }
  const day = stats.byDate[date];
  day.inputTokens += inputTokens;
  day.outputTokens += outputTokens;
  day.cost += cost;

  if (modelId) {
    if (!stats.byModel[modelId]) {
      stats.byModel[modelId] = createEmptyModelUsageStats();
    }
    applyModelPromptCacheAttribution(stats.byModel[modelId], usage);
    if (previousModelId !== modelId) {
      // A first write without model metadata could not create this bucket. Add
      // its one already-counted message while assigning the enriched model.
      // If it had a different model, move that existing count instead.
      if (previousModelId && stats.byModel[previousModelId]) {
        const previous = stats.byModel[previousModelId];
        previous.messages--;
        if (
          previous.messages === 0 &&
          previous.inputTokens === 0 &&
          previous.outputTokens === 0 &&
          previous.cost === 0
        ) {
          delete stats.byModel[previousModelId];
        }
      }
      stats.byModel[modelId].messages++;
    }
    stats.byModel[modelId].inputTokens += inputTokens;
    stats.byModel[modelId].outputTokens += outputTokens;
    stats.byModel[modelId].cost += cost;
  }

  if (!stats.byAgent[agentSlug]) {
    stats.byAgent[agentSlug] = { conversations: 0, messages: 0, cost: 0 };
  }
  stats.byAgent[agentSlug].cost += cost;
}

export function computeStreakStats(stats: UsageStats): void {
  const dates = Object.keys(stats.byDate).sort();
  stats.lifetime.daysActive = dates.length;
  if (!dates.length) {
    stats.lifetime.streak = 0;
    return;
  }

  const today = new Date().toISOString().split('T')[0];
  let streak = 0;
  const current = new Date(today);
  while (true) {
    const key = current.toISOString().split('T')[0];
    if (!stats.byDate[key]) break;
    streak++;
    current.setDate(current.getDate() - 1);
  }
  stats.lifetime.streak = streak;
}

export function applyMessageToUsageStats(
  stats: UsageStats,
  message: MessageLike,
  agentSlug: string,
  fallbackModelId = '',
): void {
  const usage = message.metadata?.usage;
  const modelId = message.metadata?.model || fallbackModelId;
  const timestamp = message.metadata?.timestamp;

  stats.lifetime.totalMessages++;
  if (usage) {
    stats.lifetime.totalInputTokens += usage.inputTokens || 0;
    stats.lifetime.totalOutputTokens += usage.outputTokens || 0;
    stats.lifetime.totalCost += usage.estimatedCost || 0;
  }

  const date = timestamp
    ? new Date(timestamp).toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0];
  if (
    !stats.lifetime.firstMessageDate ||
    date < stats.lifetime.firstMessageDate
  ) {
    stats.lifetime.firstMessageDate = date;
  }
  if (
    !stats.lifetime.lastMessageDate ||
    date > stats.lifetime.lastMessageDate
  ) {
    stats.lifetime.lastMessageDate = date;
  }
  updateDailyUsage(stats, date, agentSlug, usage);

  if (!stats.lifetime.uniqueAgents.includes(agentSlug)) {
    stats.lifetime.uniqueAgents.push(agentSlug);
  }

  if (modelId) {
    if (!stats.byModel[modelId]) {
      stats.byModel[modelId] = createEmptyModelUsageStats();
    }
    stats.byModel[modelId].messages++;
    if (usage) {
      applyModelPromptCacheAttribution(stats.byModel[modelId], usage);
      stats.byModel[modelId].inputTokens += usage.inputTokens || 0;
      stats.byModel[modelId].outputTokens += usage.outputTokens || 0;
      stats.byModel[modelId].cost += usage.estimatedCost || 0;
    }
  }

  if (!stats.byAgent[agentSlug]) {
    stats.byAgent[agentSlug] = { conversations: 0, messages: 0, cost: 0 };
  }
  stats.byAgent[agentSlug].messages++;
  if (usage) {
    stats.byAgent[agentSlug].cost += usage.estimatedCost || 0;
  }
}

/**
 * Add the orchestration substrate's already-folded session totals to a
 * rescan's stats (archive#3245). Orchestration sessions — every
 * external-engine turn — had no path into lifetime analytics at all, so the
 * Profile read zero for that traffic even after archive#3243 made the
 * per-session numbers real.
 *
 * **No double counting, by construction.** `alreadyCountedConversationIds` is
 * the very set the memory walk just built while applying its own messages, in
 * the same pass of the same function — not a second query that could drift
 * from it. A session present in BOTH substrates (a Station-engine chat, whose
 * `station-agent` relay writes the FileMemory transcript AND emits
 * orchestration events under the same conversation id) is therefore filtered
 * out here before it can contribute a second time. The filter is on an
 * OBSERVED id rather than on a provider name: excluding `provider ===
 * 'station-agent'` would be a label-based guard that both mis-drops such a
 * session when its transcript no longer exists and silently stops working the
 * day a relay is renamed.
 *
 * **Absence is never summed as zero.** Each optional measurement is added
 * only when the fold reports it; the returned {@link EngineUsageCoverage}
 * carries how many sessions did. `turns` and `toolCalls` are not optional in
 * the fold (Station counts those itself), so a completed turn is counted as
 * an assistant message unconditionally — the same rule the monitoring bridge
 * used when it owned this ingress.
 *
 * Deliberately NOT written: `byDate`, `firstMessageDate`, `lastMessageDate`.
 * `SessionUsageAggregate` is a whole-session derivation with no per-day
 * resolution, so charging a multi-day session's usage to one calendar day
 * would invent a distribution nothing measured. The date-bucketed surfaces
 * stay honestly memory-only until archive#3093 builds a period selector on a
 * substrate that can answer it.
 */
export function applyOrchestrationUsageToUsageStats(
  stats: UsageStats,
  sessions: readonly OrchestrationSessionUsage[],
  alreadyCountedConversationIds: ReadonlySet<string>,
): EngineUsageCoverage {
  const coverage: EngineUsageCoverage = {
    sessions: 0,
    sessionsReportingTokens: 0,
    sessionsReportingCost: 0,
  };

  for (const session of sessions) {
    if (alreadyCountedConversationIds.has(session.conversationId)) continue;
    const usage = session.usage;
    // The analytics store keys by slug and has no absent-key concept; its own
    // '(unnamed)' bucket is a rollup key, not a claim about what the session
    // reported — the same key the monitoring bridge rolls up under.
    const agentSlug = session.agentSlug || UNNAMED_AGENT;
    coverage.sessions += 1;

    stats.lifetime.totalConversations += 1;
    stats.lifetime.totalMessages += usage.turns;
    if (!stats.lifetime.uniqueAgents.includes(agentSlug)) {
      stats.lifetime.uniqueAgents.push(agentSlug);
    }

    if (!stats.byAgent[agentSlug]) {
      stats.byAgent[agentSlug] = { conversations: 0, messages: 0, cost: 0 };
    }
    const agent = stats.byAgent[agentSlug];
    agent.conversations += 1;
    agent.messages += usage.turns;

    const modelId = usage.lastModelId;
    if (modelId && !stats.byModel[modelId]) {
      stats.byModel[modelId] = createEmptyModelUsageStats();
    }
    const model = modelId ? stats.byModel[modelId] : undefined;
    if (model) {
      model.messages += usage.turns;
      applyModelPromptCacheAttribution(model, usage);
    }

    if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
      coverage.sessionsReportingTokens += 1;
    }
    if (usage.inputTokens !== undefined) {
      stats.lifetime.totalInputTokens += usage.inputTokens;
      if (model) model.inputTokens += usage.inputTokens;
    }
    if (usage.outputTokens !== undefined) {
      stats.lifetime.totalOutputTokens += usage.outputTokens;
      if (model) model.outputTokens += usage.outputTokens;
    }
    // archive#4196: separate cache counters, never added to
    // totalInputTokens — see the field docblock on UsageStats.lifetime.
    // A counter comes into existence only when a session actually reports
    // the figure.
    if (usage.cacheReadTokens !== undefined) {
      stats.lifetime.totalCacheReadTokens =
        (stats.lifetime.totalCacheReadTokens ?? 0) + usage.cacheReadTokens;
      if (model) {
        model.cacheReadTokens =
          (model.cacheReadTokens ?? 0) + usage.cacheReadTokens;
      }
    }
    if (usage.cacheWriteTokens !== undefined) {
      stats.lifetime.totalCacheWriteTokens =
        (stats.lifetime.totalCacheWriteTokens ?? 0) + usage.cacheWriteTokens;
      if (model) {
        model.cacheWriteTokens =
          (model.cacheWriteTokens ?? 0) + usage.cacheWriteTokens;
      }
    }
    if (usage.reportedCostUsd !== undefined) {
      coverage.sessionsReportingCost += 1;
      stats.lifetime.totalCost += usage.reportedCostUsd;
      agent.cost += usage.reportedCostUsd;
      if (model) model.cost += usage.reportedCostUsd;
    }
  }

  return coverage;
}

function maxOptionalCounter(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

function hasModelCacheEvidence(model: ModelUsageStats): boolean {
  return (
    model.inputTokens !== 0 ||
    // Legacy persisted buckets always had a numeric input field, so a zero
    // alone cannot distinguish "no prompt observed" from "prompt zero
    // reported". If that bucket has messages but no attribution, treat it
    // as indeterminate rather than upgrading it with a later rescan's
    // provider declaration.
    (model.messages > 0 && model.cacheProviderAttribution === undefined) ||
    model.cacheReadTokens !== undefined ||
    model.cacheWriteTokens !== undefined ||
    model.cacheProviderAttribution !== undefined
  );
}

/**
 * Rescans and incremental persistence can meet at this merge seam. Preserve
 * cache components with the same absent-vs-zero rule as lifetime counters,
 * but preserve a sum permission only when BOTH sides attest to the same
 * single provider. A legacy/mixed side is an honest reason to keep the
 * components visible and decline a combined prompt total.
 */
function mergeModelCacheEvidence(
  existing: ModelUsageStats,
  rescanned: ModelUsageStats,
): void {
  const existingHadCacheEvidence = hasModelCacheEvidence(existing);
  const rescannedHasCacheEvidence = hasModelCacheEvidence(rescanned);
  existing.cacheReadTokens = maxOptionalCounter(
    existing.cacheReadTokens,
    rescanned.cacheReadTokens,
  );
  existing.cacheWriteTokens = maxOptionalCounter(
    existing.cacheWriteTokens,
    rescanned.cacheWriteTokens,
  );

  if (!rescannedHasCacheEvidence) return;
  if (!existingHadCacheEvidence) {
    existing.cacheProviderAttribution = rescanned.cacheProviderAttribution;
    existing.cacheProvider = rescanned.cacheProvider;
    existing.cacheInclusivity = rescanned.cacheInclusivity;
    return;
  }

  if (
    existing.cacheProviderAttribution === 'single' &&
    rescanned.cacheProviderAttribution === 'single' &&
    existing.cacheProvider === rescanned.cacheProvider
  ) {
    return;
  }

  existing.cacheProviderAttribution = 'indeterminate';
  delete existing.cacheProvider;
  delete existing.cacheInclusivity;
}

export function mergeRescannedUsageStats(
  existing: UsageStats,
  rescanned: UsageStats,
): UsageStats {
  existing.lifetime.totalMessages = Math.max(
    existing.lifetime.totalMessages,
    rescanned.lifetime.totalMessages,
  );
  existing.lifetime.totalConversations = Math.max(
    existing.lifetime.totalConversations,
    rescanned.lifetime.totalConversations,
  );
  existing.lifetime.totalInputTokens = Math.max(
    existing.lifetime.totalInputTokens,
    rescanned.lifetime.totalInputTokens,
  );
  existing.lifetime.totalOutputTokens = Math.max(
    existing.lifetime.totalOutputTokens,
    rescanned.lifetime.totalOutputTokens,
  );
  existing.lifetime.totalCost = Math.max(
    existing.lifetime.totalCost,
    rescanned.lifetime.totalCost,
  );
  // Optional cache counters: max when both sides have one, whichever exists
  // when only one does, and STILL ABSENT when neither does — a merge must
  // not invent a zero counter nothing reported (archive#3201/#4196).
  existing.lifetime.totalCacheReadTokens = maxOptionalCounter(
    existing.lifetime.totalCacheReadTokens,
    rescanned.lifetime.totalCacheReadTokens,
  );
  existing.lifetime.totalCacheWriteTokens = maxOptionalCounter(
    existing.lifetime.totalCacheWriteTokens,
    rescanned.lifetime.totalCacheWriteTokens,
  );

  existing.lifetime.uniqueAgents = Array.from(
    new Set([
      ...existing.lifetime.uniqueAgents,
      ...rescanned.lifetime.uniqueAgents,
    ]),
  );

  if (
    rescanned.lifetime.firstMessageDate &&
    (!existing.lifetime.firstMessageDate ||
      rescanned.lifetime.firstMessageDate < existing.lifetime.firstMessageDate)
  ) {
    existing.lifetime.firstMessageDate = rescanned.lifetime.firstMessageDate;
  }
  if (
    rescanned.lifetime.lastMessageDate &&
    (!existing.lifetime.lastMessageDate ||
      rescanned.lifetime.lastMessageDate > existing.lifetime.lastMessageDate)
  ) {
    existing.lifetime.lastMessageDate = rescanned.lifetime.lastMessageDate;
  }

  for (const [modelId, modelStats] of Object.entries(rescanned.byModel)) {
    if (!existing.byModel[modelId]) {
      existing.byModel[modelId] = modelStats;
      continue;
    }
    existing.byModel[modelId].messages = Math.max(
      existing.byModel[modelId].messages,
      modelStats.messages,
    );
    existing.byModel[modelId].inputTokens = Math.max(
      existing.byModel[modelId].inputTokens,
      modelStats.inputTokens,
    );
    existing.byModel[modelId].outputTokens = Math.max(
      existing.byModel[modelId].outputTokens,
      modelStats.outputTokens,
    );
    existing.byModel[modelId].cost = Math.max(
      existing.byModel[modelId].cost,
      modelStats.cost,
    );
    mergeModelCacheEvidence(existing.byModel[modelId], modelStats);
  }

  for (const [agentSlug, agentStats] of Object.entries(rescanned.byAgent)) {
    if (!existing.byAgent[agentSlug]) {
      existing.byAgent[agentSlug] = agentStats;
      continue;
    }
    existing.byAgent[agentSlug].conversations = Math.max(
      existing.byAgent[agentSlug].conversations || 0,
      agentStats.conversations || 0,
    );
    existing.byAgent[agentSlug].messages = Math.max(
      existing.byAgent[agentSlug].messages,
      agentStats.messages,
    );
    existing.byAgent[agentSlug].cost = Math.max(
      existing.byAgent[agentSlug].cost,
      agentStats.cost,
    );
  }

  // The rescan is authoritative only for dates it could read. Keep dates that
  // arrived through incremental persistence but were unavailable to the scan.
  existing.byDate = { ...existing.byDate, ...rescanned.byDate };

  // Coverage is REPLACED, not maxed: a full rescan is the only producer, and
  // it is a description of the sessions this rescan could read. Keeping a
  // larger stale count would make it a claim about a corpus that no longer
  // exists. When the rescan had no orchestration substrate to read at all,
  // there is nothing to say and the field stays absent.
  if (rescanned.lifetime.engineUsageCoverage) {
    existing.lifetime.engineUsageCoverage =
      rescanned.lifetime.engineUsageCoverage;
  } else {
    delete existing.lifetime.engineUsageCoverage;
  }
  return existing;
}

export function checkAchievement(
  def: (typeof ACHIEVEMENTS)[number],
  stats: UsageStats,
): boolean {
  switch (def.id) {
    case 'first-message':
    case 'conversationalist':
    case 'power-user':
      return stats.lifetime.totalMessages >= def.threshold;
    case 'model-explorer':
      return Object.keys(stats.byModel).length >= def.threshold;
    case 'cost-conscious':
      return (
        stats.lifetime.totalMessages >= 50 &&
        stats.lifetime.totalCost / stats.lifetime.totalMessages <= def.threshold
      );
    default:
      return false;
  }
}

export function getAchievementProgress(
  def: (typeof ACHIEVEMENTS)[number],
  stats: UsageStats,
): number {
  switch (def.id) {
    case 'first-message':
    case 'conversationalist':
    case 'power-user':
      return Math.min(stats.lifetime.totalMessages, def.threshold);
    case 'model-explorer':
      return Math.min(Object.keys(stats.byModel).length, def.threshold);
    case 'cost-conscious':
      return stats.lifetime.totalMessages > 0
        ? stats.lifetime.totalCost / stats.lifetime.totalMessages
        : 0;
    default:
      return 0;
  }
}

export function getCostConsciousProgressPercent(stats: UsageStats): number {
  const requiredMessages = 50;
  const messageProgress = Math.min(
    stats.lifetime.totalMessages / requiredMessages,
    1,
  );
  if (stats.lifetime.totalMessages === 0) return 0;
  const averageCost = stats.lifetime.totalCost / stats.lifetime.totalMessages;
  const costProgress =
    averageCost <= 0.01 ? 1 : Math.min(0.01 / averageCost, 1);
  return Math.round(messageProgress * costProgress * 100);
}
