import type { PrincipalRef } from './principal.js';

export type ProviderPromptCacheInclusivity =
  | 'disjoint'
  | 'subset'
  | 'unverified';

/** Counts of retained measurement contributions, including an explicitly reported zero. */
export interface TokenReports {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** UTC buckets for recorded facts; cumulative corrections can remain unallocated. */
export interface DailyStats extends UnallocatedUsage {
  byAgent: Record<string, number>;
}

/** Engine-session denominators for the retained-source sums; absence is not zero. */
export interface EngineUsageCoverage {
  /** Engine sessions folded into the lifetime totals by the last rescan. */
  sessions: number;
  /** ...that reported at least one token count. */
  sessionsReportingTokens: number;
  /** ...that reported a cost. */
  sessionsReportingCost: number;
}

export interface UnallocatedUsage {
  messages: number;
  tokenReports?: TokenReports;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  reportedCostUsd?: number;
  estimatedCostUsd?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Measured evidence held outside current totals when source overlap is unknown. */
export interface OverlappingUsageMeasurements {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reportedCostUsd?: number;
}

export interface UsageStats {
  /** Kept once for migration evidence; excluded from every current counter. */
  legacySummary?: {
    evidence: 'unverified';
    lifetime: UsageStats['lifetime'];
    byModel: UsageStats['byModel'];
    byDate: UsageStats['byDate'];
  };
  unallocated?: {
    date: UnallocatedUsage;
    model: UnallocatedUsage;
    principal: UnallocatedUsage;
    provider: UnallocatedUsage;
  };
  byProvider?: Record<string, UnallocatedUsage>;
  byPrincipal?: Record<
    string,
    { principal: PrincipalRef; usage: UnallocatedUsage }
  >;

  snapshot?: {
    rescannedAt: string;
    projection?: 'retained-source-v1';
    dayScope?: 'recorded-observations-utc';
    missingEngineTurnCosts?: number;
    mirroredEngineActivity?: {
      sessions: number;
      completedTurns: number;
      coverage: 'partial';
      reason: string;
    };
    ambiguousRelayActivity?: {
      sessions: number;
      completedTurns: number;
      coverage: 'unknown';
      reason: string;
      measurements?: OverlappingUsageMeasurements;
    };
    engineUsage: 'available' | 'unavailable' | 'not_configured';
    skippedMessages: number;
    missingMessageCosts?: number;
    costCoverageChecked?: boolean;
    retainedUsage?: boolean;
  };
  lifetime: {
    totalMessages: number;
    totalConversations: number;
    tokenReports?: TokenReports;
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
    reportedCostUsd?: number;
    estimatedCostUsd?: number;
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
      reportedCostUsd?: number;
      estimatedCostUsd?: number;
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
  tokenReports?: TokenReports;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  reportedCostUsd?: number;
  estimatedCostUsd?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheProvider?: string;
  cacheInclusivity?: ProviderPromptCacheInclusivity;
  cacheProviderAttribution?: 'single' | 'indeterminate';
}
