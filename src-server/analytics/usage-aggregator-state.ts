import type {
  EngineUsageCoverage,
  ModelUsageStats,
  TokenReports,
  UnallocatedUsage,
  UsageStats,
} from '@kontourai/station-contracts/usage-stats';

export type {
  EngineUsageCoverage,
  UsageStats,
} from '@kontourai/station-contracts/usage-stats';

import {
  providerPromptCacheInclusivity,
  type SessionUsageAggregate,
  type UsageObservation,
} from '@kontourai/station-shared/usage-fold';
import { UNNAMED_AGENT } from '../../src-shared/monitoring-keys.js';

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
   * Configured conversation identity for existing session consumers.
   * Canonical relay provenance in memoryMirror owns the primary-ledger join.
   */
  conversationId: string;
  /** Absent when the session reported none (archive#3082); never a literal. */
  agentSlug?: string;
  usage: SessionUsageAggregate;
  observations?: UsageObservation[];
  unmeasuredCostTurns?: number;
  memoryMirror?: { agentSlug: string; conversationId: string };
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
  measurementUnavailableReason?: string;
}

export const ACHIEVEMENTS = [
  {
    id: 'first-message',
    name: 'First Steps',
    description: 'Record a message or completed engine turn',
    threshold: 1,
  },
  {
    id: 'conversationalist',
    name: 'Conversationalist',
    description: 'Record 100 messages or completed engine turns',
    threshold: 100,
  },
  {
    id: 'power-user',
    name: 'Power User',
    description: 'Record 1,000 messages or completed engine turns',
    threshold: 1000,
  },
  {
    id: 'model-explorer',
    name: 'Model Explorer',
    description: 'Record 5 models in the lifetime summary',
    threshold: 5,
  },
  {
    id: 'cost-conscious',
    name: 'Cost Conscious',
    description: 'Keep recorded average cost under $0.01/message',
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
    timestamp?: string | number;
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
    byModel: Object.create(null),
    byAgent: Object.create(null),
    byDate: Object.create(null),
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
    // byDate keys are UTC dates; stepping by local days skips one across DST.
    current.setUTCDate(current.getUTCDate() - 1);
  }
  stats.lifetime.streak = streak;
}

function emptyUnallocatedUsage(): UnallocatedUsage {
  return { messages: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
}

function usableFigure(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function recordedDate(value: unknown): string | undefined {
  if (
    typeof value !== 'string' &&
    (typeof value !== 'number' || !Number.isFinite(value))
  )
    return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toISOString().slice(0, 10)
    : undefined;
}

function addTokenReports(
  target: { tokenReports?: TokenReports },
  observation: UsageObservation,
): void {
  if (
    observation.inputTokens === undefined &&
    observation.outputTokens === undefined &&
    observation.cacheReadTokens === undefined &&
    observation.cacheWriteTokens === undefined
  )
    return;
  target.tokenReports ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (observation.inputTokens !== undefined) target.tokenReports.input += 1;
  if (observation.outputTokens !== undefined) target.tokenReports.output += 1;
  if (observation.cacheReadTokens !== undefined)
    target.tokenReports.cacheRead += 1;
  if (observation.cacheWriteTokens !== undefined)
    target.tokenReports.cacheWrite += 1;
}

function addUsage(
  target: UnallocatedUsage,
  observation: UsageObservation,
  cost: number,
): void {
  addTokenReports(target, observation);
  target.messages += observation.messages;
  target.inputTokens += observation.inputTokens ?? 0;
  target.outputTokens += observation.outputTokens ?? 0;
  target.cost += cost;
  if (observation.reportedCostUsd !== undefined)
    target.reportedCostUsd =
      (target.reportedCostUsd ?? 0) + observation.reportedCostUsd;
  if (observation.estimatedCostUsd !== undefined)
    target.estimatedCostUsd =
      (target.estimatedCostUsd ?? 0) + observation.estimatedCostUsd;
  if (observation.cacheReadTokens !== undefined)
    target.cacheReadTokens =
      (target.cacheReadTokens ?? 0) + observation.cacheReadTokens;
  if (observation.cacheWriteTokens !== undefined)
    target.cacheWriteTokens =
      (target.cacheWriteTokens ?? 0) + observation.cacheWriteTokens;
}

/** Applies only retained record evidence; never guesses a model, date, or person. */
function applyObservationAttribution(
  stats: UsageStats,
  observation: UsageObservation,
  agentSlug: string,
  cost: number,
): void {
  addTokenReports(stats.lifetime, observation);
  stats.unallocated ??= {
    date: emptyUnallocatedUsage(),
    model: emptyUnallocatedUsage(),
    principal: emptyUnallocatedUsage(),
    provider: emptyUnallocatedUsage(),
  };
  const date = recordedDate(observation.recordedAt);
  if (date) {
    stats.byDate[date] ??= {
      ...emptyUnallocatedUsage(),
      byAgent: Object.create(null),
    };
    const day = stats.byDate[date];
    addUsage(day, observation, cost);
    if (observation.messages) {
      day.byAgent[agentSlug] =
        (day.byAgent[agentSlug] ?? 0) + observation.messages;
      if (
        !stats.lifetime.firstMessageDate ||
        date < stats.lifetime.firstMessageDate
      )
        stats.lifetime.firstMessageDate = date;
      if (
        !stats.lifetime.lastMessageDate ||
        date > stats.lifetime.lastMessageDate
      )
        stats.lifetime.lastMessageDate = date;
    }
  } else addUsage(stats.unallocated.date, observation, cost);
  if (observation.modelId) {
    stats.byModel[observation.modelId] ??= createEmptyModelUsageStats();
    const model = stats.byModel[observation.modelId];
    addUsage(model, observation, cost);
    applyModelPromptCacheAttribution(model, observation);
  } else addUsage(stats.unallocated.model, observation, cost);
  if (observation.provider) {
    const byProvider: NonNullable<UsageStats['byProvider']> =
      stats.byProvider ?? Object.create(null);
    stats.byProvider = byProvider;
    byProvider[observation.provider] ??= emptyUnallocatedUsage();
    const provider = byProvider[observation.provider];
    addUsage(provider, observation, cost);
  } else addUsage(stats.unallocated.provider, observation, cost);
  if (observation.principal) {
    const byPrincipal: NonNullable<UsageStats['byPrincipal']> =
      stats.byPrincipal ?? Object.create(null);
    stats.byPrincipal = byPrincipal;
    byPrincipal[observation.principal.id] ??= {
      principal: observation.principal,
      usage: emptyUnallocatedUsage(),
    };
    const principal = byPrincipal[observation.principal.id];
    addUsage(principal.usage, observation, cost);
  } else addUsage(stats.unallocated.principal, observation, cost);
}

export function applyMessageToUsageStats(
  stats: UsageStats,
  message: MessageLike,
  agentSlug: string,
): void {
  const usage = message.metadata?.usage;
  const inputTokens = usableFigure(usage?.inputTokens);
  const outputTokens = usableFigure(usage?.outputTokens);
  const cost = usableFigure(usage?.estimatedCost) ?? 0;
  stats.lifetime.totalMessages += 1;
  stats.lifetime.totalInputTokens += inputTokens ?? 0;
  stats.lifetime.totalOutputTokens += outputTokens ?? 0;
  stats.lifetime.totalCost += cost;
  if (usableFigure(usage?.estimatedCost) !== undefined)
    stats.lifetime.estimatedCostUsd =
      (stats.lifetime.estimatedCostUsd ?? 0) + cost;
  if (!stats.lifetime.uniqueAgents.includes(agentSlug))
    stats.lifetime.uniqueAgents.push(agentSlug);
  stats.byAgent[agentSlug] ??= { conversations: 0, messages: 0, cost: 0 };
  const agent = stats.byAgent[agentSlug];
  agent.messages += 1;
  agent.cost += cost;
  if (usableFigure(usage?.estimatedCost) !== undefined)
    agent.estimatedCostUsd = (agent.estimatedCostUsd ?? 0) + cost;
  const timestamp = message.metadata?.timestamp;
  applyObservationAttribution(
    stats,
    {
      sourceEventId: '',
      messages: 1,
      recordedAt: recordedDate(timestamp)
        ? new Date(timestamp!).toISOString()
        : undefined,
      modelId:
        typeof message.metadata?.model === 'string'
          ? message.metadata.model
          : undefined,
      inputTokens,
      outputTokens,
      estimatedCostUsd: usableFigure(usage?.estimatedCost),
    },
    agentSlug,
    cost,
  );
}

/** Full session totals stay canonical; only proven record allocations enter breakdowns. */
export function applyOrchestrationUsageToUsageStats(
  stats: UsageStats,
  sessions: readonly OrchestrationSessionUsage[],
  memorySessionKeys: ReadonlySet<string>,
): EngineUsageCoverage {
  const coverage: EngineUsageCoverage = {
    sessions: 0,
    sessionsReportingTokens: 0,
    sessionsReportingCost: 0,
  };
  for (const session of sessions) {
    const usage = session.usage;
    // Canonical relay provenance chooses a saved-message primary ledger.
    // Exact per-turn overlap remains separately disclosed, including partial
    // transcripts. A coincidental conversation id is not a mirror proof.
    const agentSlug = session.agentSlug || UNNAMED_AGENT;
    if (
      session.memoryMirror &&
      memorySessionKeys.has(
        `${session.memoryMirror.agentSlug}\0${session.memoryMirror.conversationId}`,
      )
    )
      continue;
    coverage.sessions += 1;
    stats.lifetime.totalConversations += 1;
    stats.lifetime.totalMessages += usage.turns;
    if (!stats.lifetime.uniqueAgents.includes(agentSlug))
      stats.lifetime.uniqueAgents.push(agentSlug);
    stats.byAgent[agentSlug] ??= { conversations: 0, messages: 0, cost: 0 };
    const agent = stats.byAgent[agentSlug];
    agent.conversations += 1;
    agent.messages += usage.turns;
    agent.cost += usage.reportedCostUsd ?? 0;
    if (usage.reportedCostUsd !== undefined)
      agent.reportedCostUsd =
        (agent.reportedCostUsd ?? 0) + usage.reportedCostUsd;
    if (
      usage.inputTokens !== undefined ||
      usage.outputTokens !== undefined ||
      usage.totalTokens !== undefined ||
      usage.cacheReadTokens !== undefined ||
      usage.cacheWriteTokens !== undefined
    )
      coverage.sessionsReportingTokens += 1;
    if (usage.reportedCostUsd !== undefined)
      coverage.sessionsReportingCost += 1;
    stats.lifetime.totalInputTokens += usage.inputTokens ?? 0;
    stats.lifetime.totalOutputTokens += usage.outputTokens ?? 0;
    stats.lifetime.totalCost += usage.reportedCostUsd ?? 0;
    if (usage.reportedCostUsd !== undefined)
      stats.lifetime.reportedCostUsd =
        (stats.lifetime.reportedCostUsd ?? 0) + usage.reportedCostUsd;
    if (usage.cacheReadTokens !== undefined)
      stats.lifetime.totalCacheReadTokens =
        (stats.lifetime.totalCacheReadTokens ?? 0) + usage.cacheReadTokens;
    if (usage.cacheWriteTokens !== undefined)
      stats.lifetime.totalCacheWriteTokens =
        (stats.lifetime.totalCacheWriteTokens ?? 0) + usage.cacheWriteTokens;
    const observations = session.observations ?? [
      {
        sourceEventId: '',
        messages: usage.turns,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        reportedCostUsd: usage.reportedCostUsd,
        provider: usage.provider,
      },
    ];
    for (const observation of observations)
      applyObservationAttribution(
        stats,
        observation,
        agentSlug,
        observation.reportedCostUsd ?? 0,
      );
  }
  return coverage;
}

/** Replace the projection, preserving pre-migration evidence outside current totals. */
export function mergeRescannedUsageStats(
  existing: UsageStats,
  rescanned: UsageStats,
): UsageStats {
  const legacySummary =
    existing.legacySummary ??
    (existing.snapshot?.projection !== 'retained-source-v1' &&
    (existing.lifetime.totalMessages > 0 ||
      existing.lifetime.totalInputTokens > 0 ||
      existing.lifetime.totalCost > 0 ||
      Object.keys(existing.byModel).length > 0)
      ? {
          evidence: 'unverified' as const,
          lifetime: existing.lifetime,
          byModel: existing.byModel,
          byDate: existing.byDate,
        }
      : undefined);
  if (legacySummary) rescanned.legacySummary = legacySummary;
  return rescanned;
}

export function getCostMeasurementGap(stats: UsageStats): string | null {
  if (stats.lifetime.totalMessages === 0) {
    return 'No recorded messages are available to calculate an average cost.';
  }
  if (!stats.snapshot?.costCoverageChecked) {
    return 'Cost coverage has not been checked for the current saved messages.';
  }
  if (stats.snapshot.skippedMessages > 0) {
    return 'Some saved messages could not be read, so their cost is unknown.';
  }
  if (stats.snapshot.ambiguousRelayActivity) {
    return 'Relay provenance cannot establish whether saved-message and engine activity overlap.';
  }
  if (stats.snapshot.mirroredEngineActivity?.coverage === 'partial') {
    return 'Relay activity overlaps saved messages; complete cost coverage cannot be established.';
  }
  if (stats.snapshot.missingEngineTurnCosts) {
    return 'Some completed engine turns did not report cost. Missing cost is not zero.';
  }
  if (stats.snapshot.missingMessageCosts) {
    return 'Some saved assistant messages did not report cost. Missing cost is not zero.';
  }
  if (stats.snapshot?.engineUsage === 'unavailable') {
    return 'Engine cost could not be checked during the last rebuild.';
  }
  if (stats.snapshot?.retainedUsage) {
    return 'Cost coverage is unavailable for retained usage that could not be remeasured.';
  }
  const coverage = stats.lifetime.engineUsageCoverage;
  if (coverage && coverage.sessionsReportingCost < coverage.sessions) {
    return 'Some engine sessions did not report cost. Missing cost is not zero.';
  }
  return null;
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
        getCostMeasurementGap(stats) === null &&
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
