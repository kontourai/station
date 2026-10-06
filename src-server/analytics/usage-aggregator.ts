import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { SessionReadAuthority } from '@kontourai/station-contracts/tenancy';
import type { UsageReceipt } from '@kontourai/station-contracts/usage-rollup';
import { createLogger } from '../utils/logger.js';
import {
  ACHIEVEMENTS,
  type Achievement,
  applyEnrichmentUsageToUsageStats,
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
      // Clean up legacy "unknown" model bucket
      delete stats.byModel?.unknown;
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
    message: any,
    agentSlug: string,
    _conversationId: string,
  ): Promise<void> {
    return this.serialize(() =>
      this.incrementalUpdateInner(message, agentSlug),
    );
  }

  async applyEnrichmentUsage(
    message: any,
    agentSlug: string,
    _conversationId: string,
    previousModelId = '',
  ): Promise<void> {
    return this.serialize(async () => {
      const stats = await this.loadStats();
      applyEnrichmentUsageToUsageStats(
        stats,
        message,
        agentSlug,
        '',
        previousModelId,
      );
      if (stats.snapshot) stats.snapshot.costCoverageChecked = false;
      await this.saveStats(stats);
      await this.updateAchievements(stats);
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

  private async incrementalUpdateInner(
    message: any,
    agentSlug: string,
  ): Promise<void> {
    const stats = await this.loadStats();
    applyMessageToUsageStats(stats, message, agentSlug);
    if (stats.snapshot) stats.snapshot.costCoverageChecked = false;
    await this.saveStats(stats);
    await this.updateAchievements(stats);
  }

  private async fullRescanInner(): Promise<UsageStats> {
    // Load existing stats instead of starting from zero
    const stats = await this.loadStats();
    const agentsDir = join(this.projectHomeDir, 'agents');

    // Track what we've seen in current files
    const currentStats = createEmptyUsageStats();
    let skippedMessages = 0;
    let missingMessageCosts = 0;

    const agents = existsSync(agentsDir)
      ? await readdir(agentsDir, { withFileTypes: true })
      : [];
    const sessionCounts = new Map<string, Set<string>>();

    // Load app config to get default model
    const appConfigPath = join(this.projectHomeDir, 'config', 'app.json');
    let defaultModel = '';
    try {
      if (existsSync(appConfigPath)) {
        const appConfig = JSON.parse(await readFile(appConfigPath, 'utf-8'));
        defaultModel = appConfig.defaultModel || '';
      }
    } catch (error) {
      logger.error('Failed to load app config', { error });
    }

    for (const agent of agents) {
      if (!agent.isDirectory()) continue;
      const agentSlug = agent.name;

      // Load agent spec to get model
      const agentJsonPath = join(agentsDir, agentSlug, 'agent.json');
      let agentModel = defaultModel;
      try {
        if (existsSync(agentJsonPath)) {
          const agentSpec = JSON.parse(await readFile(agentJsonPath, 'utf-8'));
          agentModel = agentSpec.model || defaultModel;
        }
      } catch (error) {
        logger.error('Failed to load agent spec', { agentSlug, error });
      }

      const sessionsDir = join(agentsDir, agentSlug, 'memory', 'sessions');

      if (!existsSync(sessionsDir)) continue;

      const sessionFiles = await readdir(sessionsDir);
      // Filter to real transcripts before counting. The loop below already
      // does; this Set did not, and `'c.ndjson.<pid>.<uuid>.tmp'` survives
      // `.replace('.ndjson','')` as a DISTINCT id, so any stray inflates the
      // conversation count. archive#2252 made destructive rewrites publish
      // via a temp file in this directory, so a crash between the write and
      // the rename now leaves exactly such a stray — and `mergeRescannedUsageStats`
      // merges lifetime totals with `Math.max`, which latches the inflated
      // number permanently.
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
        const _conversationId = file.replace('.ndjson', '');
        const filePath = join(sessionsDir, file);

        const stream = createReadStream(filePath, 'utf-8');
        const rl = createInterface({ input: stream, crlfDelay: Infinity });

        for await (const line of rl) {
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line);
            applyMessageToUsageStats(
              currentStats,
              message,
              agentSlug,
              agentModel,
            );
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

    // archive#3245: the orchestration substrate, folded by the SAME
    // derivation the stats route uses. It runs after the memory walk and is
    // handed the exact id set that walk just counted, so a session living in
    // both substrates cannot contribute twice — see
    // `applyOrchestrationUsageToUsageStats` for why that filter is on an
    // observed id rather than a provider name.
    const orchestrationSessions = this.readOrchestrationSessionUsage();
    if (orchestrationSessions) {
      const memoryConversationIds = new Set<string>();
      for (const ids of sessionCounts.values()) {
        for (const id of ids) memoryConversationIds.add(id);
      }
      currentStats.lifetime.engineUsageCoverage =
        applyOrchestrationUsageToUsageStats(
          currentStats,
          orchestrationSessions,
          memoryConversationIds,
        );
    }

    mergeRescannedUsageStats(stats, currentStats);

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
      retainedUsage:
        stats.lifetime.totalMessages > currentStats.lifetime.totalMessages ||
        stats.lifetime.totalInputTokens >
          currentStats.lifetime.totalInputTokens ||
        stats.lifetime.totalOutputTokens >
          currentStats.lifetime.totalOutputTokens ||
        stats.lifetime.totalCost - currentStats.lifetime.totalCost >
          Number.EPSILON *
            Math.max(1, stats.lifetime.totalCost) *
            Math.max(
              1,
              stats.lifetime.totalMessages +
                (stats.lifetime.engineUsageCoverage?.sessions ?? 0),
            ) *
            2 ||
        (stats.lifetime.totalCacheReadTokens ?? 0) >
          (currentStats.lifetime.totalCacheReadTokens ?? 0) ||
        (stats.lifetime.totalCacheWriteTokens ?? 0) >
          (currentStats.lifetime.totalCacheWriteTokens ?? 0),
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
