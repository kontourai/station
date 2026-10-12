export type InsightsScanIssue =
  | 'history-missing'
  | 'malformed-row'
  | 'invalid-timestamp'
  | 'unreadable-file';

/** Completeness describes the retained scan, not every operation ever executed. */
export interface InsightsScanCoverage {
  state: 'complete' | 'partial' | 'unknown';
  scope: 'retained-monitoring';
  evaluatedAt: string;
  /** Bounded classifications, without other principals' counts, contents or paths. */
  issues: InsightsScanIssue[];
}

export interface UsageInsights {
  toolUsage: Record<
    string,
    {
      calls: number;
      errors: number;
      outcomeUnknown?: number;
      unresolved?: number;
    }
  >;
  hourlyActivity: number[];
  /**
   * Per-agent chat counts. There is no per-agent token figure (#463): the
   * route never measured one, and retained spans cannot be summed honestly
   * because older Codex turn spans carry session-cumulative totals. Stations
   * before this change sent an unmeasured `tokens: 0`; ignore it.
   */
  agentUsage: Record<string, { chats: number }>;
  modelUsage: Record<string, number>;
  totalChats: number;
  totalToolCalls: number;
  totalErrors: number;
  totalOutcomeUnknown?: number;
  totalUnresolved?: number;
  days: number;
  applied?: { agent?: string; tool?: string; engine?: string; limit?: number };
  /** Older Stations omit this field; consumers treat their scan as unknown. */
  coverage?: InsightsScanCoverage;
}
