import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type { UsageReceipt } from '@kontourai/station-contracts/usage-rollup';
import type { OverlappingUsageMeasurements } from '@kontourai/station-contracts/usage-stats';
import { createLogger } from '../utils/logger.js';
import {
  ACHIEVEMENTS,
  type Achievement,
  applyMessageToUsageStats,
  applyOrchestrationUsageToUsageStats,
  checkAchievement,
  computeStreakStats,
  createEmptyUsageStats,
  getAchievementProgress,
  getCostConsciousProgressPercent,
  getCostMeasurementGap,
  mergeRescannedUsageStats,
  type OrchestrationSessionUsage,
  type UsageStats,
} from './usage-aggregator-state.js';

const logger = createLogger({ name: 'usage-aggregator' });

/**
 * The orchestration substrate as lifetime analytics reads it (archive#3245):
 * every session, already folded by the one shared derivation.
 *
 * This is a CONSUMER interface — the aggregator states what it needs and the
 * orchestration service satisfies it — so the aggregator never touches the
 * event store, never re-implements per-turn vs session-cumulative scope, and
 * inherits archive#3201's unreported-vs-zero discipline from the fold for
 * free. `OrchestrationService.listSessionUsage` is the only implementation.
 */
interface OrchestrationUsageSource {
  listSessionUsage(): OrchestrationSessionUsage[];
  /**
   * The request-scoped version keeps hosted analytics inside the same
   * user/tenant predicate as every other session-derived read.
   */
  listUsageReceipts?(
    authority: SessionReadAuthority,
    stationId: string,
    request: {
      from: string;
      to: string;
      cursor?: string;
      pageSize?: number;
      aggregate?: boolean;
    },
  ): {
    receipts: UsageReceipt[];
    nextCursor?: string;
    coverage?: import('@kontourai/station-contracts/usage-rollup').UsageCoverage;
  };
}

/**
 * Resolved per rescan rather than captured once: `StationRuntime` replaces
 * its `OrchestrationService` on every reload while reusing this aggregator,
 * so a captured instance would go stale against a closed event store. Mirrors
 * the `usageAggregatorRef` shape the runtime already uses in the other
 * direction.
 */
export interface OrchestrationUsageRef {
  get(): OrchestrationUsageSource | undefined;
}

export class UsageAggregator {
  private projectHomeDir: string;
  private statsPath: string;
  private achievementsPath: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private rescanInFlight?: Promise<UsageStats>;
  private lastRescanAt?: number;
  private orchestrationUsage?: OrchestrationUsageRef;

  constructor(
    projectHomeDir: string,
    orchestrationUsage?: OrchestrationUsageRef,
  ) {
    this.projectHomeDir = projectHomeDir;
    this.orchestrationUsage = orchestrationUsage;
    this.statsPath = join(projectHomeDir, 'analytics', 'stats.json');
    this.achievementsPath = join(
      projectHomeDir,
      'analytics',
      'achievements.json',
    );
  }

  private async ensureAnalyticsDir(): Promise<void> {
    await mkdir(join(this.projectHomeDir, 'analytics'), { recursive: true });
  }

  async loadStats(): Promise<UsageStats> {
    if (existsSync(this.statsPath)) {
      const content = await readFile(this.statsPath, 'utf-8');
      const stats = JSON.parse(content);
      // Older resets wrote an empty object instead of a usable accumulator.
      if (Object.keys(stats).length === 0) return createEmptyUsageStats();
      return stats;
    }
    return createEmptyUsageStats();
  }

  /** Active readers refresh at most once a minute; idle Stations keep the startup timer. */
  async readStats(): Promise<UsageStats> {
    if (this.rescanInFlight) return this.rescanInFlight;
    if (
      this.lastRescanAt === undefined ||
      Date.now() - this.lastRescanAt >= 60_000
    ) {
      return this.fullRescan();
    }
    return this.serialize(() => this.loadStats());
  }

  async saveStats(stats: UsageStats): Promise<void> {
    await this.ensureAnalyticsDir();
    // Compute streak + daysActive from byDate
    computeStreakStats(stats);
    await writeFile(this.statsPath, JSON.stringify(stats, null, 2), 'utf-8');
  }

  async reset(): Promise<void> {
    return this.serialize(async () => {
      await this.saveStats(createEmptyUsageStats());
      this.lastRescanAt = undefined;
    });
  }

  async incrementalUpdate(
    _message: unknown,
    _agentSlug: string,
    _conversationId: string,
  ): Promise<void> {
    return this.invalidateSnapshot();
  }

  async applyEnrichmentUsage(
    _message: unknown,
    _agentSlug: string,
    _conversationId: string,
    _previousModelId = '',
  ): Promise<void> {
    return this.invalidateSnapshot();
  }

  private invalidateSnapshot(): Promise<void> {
    return this.serialize(async () => {
      this.lastRescanAt = undefined;
      const stats = await this.loadStats();
      if (stats.snapshot) stats.snapshot.costCoverageChecked = false;
      await this.saveStats(stats);
    });
  }

  async fullRescan(): Promise<UsageStats> {
    if (this.rescanInFlight) return this.rescanInFlight;
    this.rescanInFlight = this.serialize(() => this.fullRescanInner());
    try {
      return await this.rescanInFlight;
    } finally {
      this.rescanInFlight = undefined;
    }
  }

  private async fullRescanInner(): Promise<UsageStats> {
    const previousStats = await this.loadStats();
    const agentsDir = join(this.projectHomeDir, 'agents');

    // Track what we've seen in current files
    const currentStats = createEmptyUsageStats();
    let skippedMessages = 0;
    let missingMessageCosts = 0;

    const agents = existsSync(agentsDir)
      ? await readdir(agentsDir, { withFileTypes: true })
      : [];
    const sessionCounts = new Map<string, Set<string>>();

    for (const agent of agents) {
      if (!agent.isDirectory()) continue;
      const agentSlug = agent.name;

      const sessionsDir = join(agentsDir, agentSlug, 'memory', 'sessions');

      if (!existsSync(sessionsDir)) continue;

      const sessionFiles = await readdir(sessionsDir);
      // Crash-leftover temporary rewrite files are not transcripts.
      sessionCounts.set(
        agentSlug,
        new Set(
          sessionFiles
            .filter((f) => f.endsWith('.ndjson'))
            .map((f) => f.replace('.ndjson', '')),
        ),
      );

      for (const file of sessionFiles) {
        if (!file.endsWith('.ndjson')) continue;
        const filePath = join(sessionsDir, file);

        const stream = createReadStream(filePath, 'utf-8');
        const rl = createInterface({ input: stream, crlfDelay: Infinity });

        for await (const line of rl) {
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line);
            applyMessageToUsageStats(currentStats, message, agentSlug);
            const cost = message.metadata?.usage?.estimatedCost;
            if (
              (message.role === 'assistant' || message.metadata?.usage) &&
              !(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0)
            ) {
              missingMessageCosts += 1;
            }
          } catch (error) {
            skippedMessages += 1;
            logger.error('Failed to parse message', { file, error });
          }
        }
      }
    }

    currentStats.lifetime.uniqueAgents = Array.from(sessionCounts.keys());
    currentStats.lifetime.totalConversations = Array.from(
      sessionCounts.values(),
    ).reduce((sum, set) => sum + set.size, 0);

    for (const [agent, sessions] of sessionCounts) {
      if (currentStats.byAgent[agent]) {
        currentStats.byAgent[agent].conversations = sessions.size;
      }
    }

    // Relay provenance selects the primary ledger; coincidental ids do not.
    const orchestrationSessions = this.readOrchestrationSessionUsage();
    const memorySessionKeys = new Set<string>();
    for (const [agentSlug, ids] of sessionCounts)
      for (const id of ids) memorySessionKeys.add(`${agentSlug}\0${id}`);
    const mirroredSessions =
      orchestrationSessions?.filter(
        (session) =>
          session.memoryMirror &&
          memorySessionKeys.has(
            `${session.memoryMirror.agentSlug}\0${session.memoryMirror.conversationId}`,
          ),
      ) ?? [];
    const mirroredSessionSet = new Set(mirroredSessions);
    const memoryConversationIds = new Set(
      [...sessionCounts.values()].flatMap((ids) => [...ids]),
    );
    const ambiguousRelaySessions =
      orchestrationSessions?.filter(
        (session) =>
          session.usage.provider === 'station-agent' &&
          !session.memoryMirror &&
          (memoryConversationIds.has(session.threadId) ||
            memoryConversationIds.has(session.conversationId)),
      ) ?? [];
    const ambiguousRelaySet = new Set(ambiguousRelaySessions);
    const ambiguousMeasurements: OverlappingUsageMeasurements = {};
    for (const session of ambiguousRelaySessions) {
      for (const field of [
        'inputTokens',
        'outputTokens',
        'cacheReadTokens',
        'cacheWriteTokens',
        'reportedCostUsd',
      ] as const) {
        const value = session.usage[field];
        if (value !== undefined)
          ambiguousMeasurements[field] =
            (ambiguousMeasurements[field] ?? 0) + value;
      }
    }
    if (orchestrationSessions) {
      currentStats.lifetime.engineUsageCoverage =
        applyOrchestrationUsageToUsageStats(
          currentStats,
          orchestrationSessions.filter(
            (session) => !ambiguousRelaySet.has(session),
          ),
          memorySessionKeys,
        );
    }

    const stats = mergeRescannedUsageStats(previousStats, currentStats);

    const rescannedAt = Date.now();
    stats.snapshot = {
      rescannedAt: new Date(rescannedAt).toISOString(),
      engineUsage: orchestrationSessions
        ? 'available'
        : this.orchestrationUsage
          ? 'unavailable'
          : 'not_configured',
      skippedMessages,
      missingMessageCosts,
      costCoverageChecked: true,
      projection: 'retained-source-v1',
      dayScope: 'recorded-observations-utc',
      missingEngineTurnCosts:
        orchestrationSessions
          ?.filter(
            (session) =>
              !mirroredSessionSet.has(session) &&
              !ambiguousRelaySet.has(session),
          )
          .reduce(
            (sum, session) => sum + (session.unmeasuredCostTurns ?? 0),
            0,
          ) ?? 0,
      retainedUsage: false,
      ...(ambiguousRelaySessions.length
        ? {
            ambiguousRelayActivity: {
              sessions: ambiguousRelaySessions.length,
              completedTurns: ambiguousRelaySessions.reduce(
                (sum, session) => sum + session.usage.turns,
                0,
              ),
              coverage: 'unknown' as const,
              measurements: ambiguousMeasurements,
              reason:
                'Relay provenance cannot establish a saved-message join; potentially overlapping engine activity is held outside current totals.',
            },
          }
        : {}),
      ...(mirroredSessions.length
        ? {
            mirroredEngineActivity: {
              sessions: mirroredSessions.length,
              completedTurns: mirroredSessions.reduce(
                (sum, session) => sum + session.usage.turns,
                0,
              ),
              coverage: 'partial' as const,
              reason:
                'Relay activity overlaps saved messages; exact per-turn overlap is unavailable. Saved messages are the primary ledger.',
            },
          }
        : {}),
    };

    await this.saveStats(stats);
    await this.updateAchievements(stats);
    this.lastRescanAt = rescannedAt;
    return stats;
  }

  /**
   * `undefined` — not `[]` — when this deployment has no orchestration
   * substrate to read, so the coverage field stays absent rather than
   * claiming a measured zero sessions. A read that throws (a closed store on
   * a mid-reload rescan) is the same "could not read" answer, logged.
   */
  private readOrchestrationSessionUsage():
    | OrchestrationSessionUsage[]
    | undefined {
    const source = this.orchestrationUsage?.get();
    if (!source) return undefined;
    try {
      return source.listSessionUsage();
    } catch (error) {
      logger.error('Failed to read orchestration session usage', { error });
      return undefined;
    }
  }

  /**
   * A usage rollup has a request authority, unlike the historic lifetime
   * stats projection. Prefer the authoritative event-store receipts when the
   * runtime provides them; the legacy fold remains visible but explicitly
   * lacks Station ingestion time.
   */
  readUsageReceipts(
    stationId: string,
    authority: SessionReadAuthority,
    request: {
      from: string;
      to: string;
      cursor?: string;
      pageSize?: number;
      aggregate?: boolean;
    },
  ):
    | {
        receipts: UsageReceipt[];
        nextCursor?: string;
        coverage?: import('@kontourai/station-contracts/usage-rollup').UsageCoverage;
      }
    | undefined {
    const source = this.orchestrationUsage?.get();
    if (!source) return undefined;
    try {
      return (
        source.listUsageReceipts?.(authority, stationId, request) ?? {
          // Legacy rows have no Station observation clock and therefore do
          // not belong to an ordinary date window. Keep that fact visible in
          // coverage, but never quietly return it for every range.
          receipts: [],
        }
      );
    } catch (error) {
      logger.error('Failed to read authorized usage receipts', { error });
      return undefined;
    }
  }

  async getAchievements(currentStats?: UsageStats): Promise<Achievement[]> {
    const stats = currentStats ?? (await this.readStats());
    const saved = existsSync(this.achievementsPath)
      ? JSON.parse(await readFile(this.achievementsPath, 'utf-8'))
      : {};

    return ACHIEVEMENTS.map((def) => {
      const unlocked = this.checkAchievement(def, stats);
      const existing = saved[def.id];

      const costConscious = def.id === 'cost-conscious';
      const costGap = costConscious ? getCostMeasurementGap(stats) : null;
      return {
        ...def,
        unlocked,
        unlockedAt:
          unlocked && !existing?.unlocked
            ? new Date().toISOString()
            : existing?.unlockedAt,
        ...(costGap
          ? { measurementUnavailableReason: costGap }
          : { progress: this.getProgress(def, stats) }),
        ...(costConscious
          ? {
              ...(!costGap
                ? { progressPercent: getCostConsciousProgressPercent(stats) }
                : {}),
              lowerIsBetter: true,
              precondition: {
                label: 'Messages analyzed',
                current: stats.lifetime.totalMessages,
                threshold: 50,
              },
            }
          : {}),
      };
    });
  }

  private checkAchievement(
    def: (typeof ACHIEVEMENTS)[number],
    stats: UsageStats,
  ): boolean {
    return checkAchievement(def, stats);
  }

  private getProgress(
    def: (typeof ACHIEVEMENTS)[number],
    stats: UsageStats,
  ): number {
    return getAchievementProgress(def, stats);
  }

  private async updateAchievements(stats: UsageStats): Promise<void> {
    const achievements = await this.getAchievements(stats);
    const saved: Record<string, any> = {};

    for (const achievement of achievements) {
      saved[achievement.id] = {
        unlocked: achievement.unlocked,
        unlockedAt: achievement.unlockedAt,
      };
    }

    await this.ensureAnalyticsDir();
    await writeFile(
      this.achievementsPath,
      JSON.stringify(saved, null, 2),
      'utf-8',
    );
  }

  /** A single server process owns this store; serialize every disk RMW cycle. */
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(operation);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
