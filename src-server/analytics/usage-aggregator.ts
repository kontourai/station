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
  mergeRescannedUsageStats,
  type OrchestrationSessionUsage,
  type UsageStats,
} from './usage-aggregator-state.js';

const logger = createLogger({ name: 'usage-aggregator' });

/**
 * The orchestration substrate as lifetime analytics reads it (station#3245):
 * every session, already folded by the one shared derivation.
 *
 * This is a CONSUMER interface — the aggregator states what it needs and the
 * orchestration service satisfies it — so the aggregator never touches the
 * event store, never re-implements per-turn vs session-cumulative scope, and
 * inherits station#3201's unreported-vs-zero discipline from the fold for
 * free. `OrchestrationService.listSessionUsage` is the only implementation.
 */
export interface OrchestrationUsageSource {
  listSessionUsage(): OrchestrationSessionUsage[];
  /**
   * The request-scoped version keeps hosted analytics inside the same
   * user/tenant predicate as every other session-derived read.
   */
  listUsageReceipts?(
    authority: SessionReadAuthority,
    stationId: string,
    request: { from: string; to: string; cursor?: string; pageSize?: number },
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
      // Clean up legacy "unknown" model bucket
      delete stats.byModel?.unknown;
      return stats;
    }
    return createEmptyUsageStats();
  }

  async saveStats(stats: UsageStats): Promise<void> {
    await this.ensureAnalyticsDir();
    // Compute streak + daysActive from byDate
    computeStreakStats(stats);
    await writeFile(this.statsPath, JSON.stringify(stats, null, 2), 'utf-8');
  }

  async reset(): Promise<void> {
    return this.serialize(async () => {
      if (existsSync(this.statsPath))
        await writeFile(this.statsPath, '{}', 'utf-8');
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
      await this.saveStats(stats);
      await this.updateAchievements(stats);
    });
  }

  async fullRescan(): Promise<UsageStats> {
    return this.serialize(() => this.fullRescanInner());
  }

  private async incrementalUpdateInner(
    message: any,
    agentSlug: string,
  ): Promise<void> {
    const stats = await this.loadStats();
    applyMessageToUsageStats(stats, message, agentSlug);
    await this.saveStats(stats);
    await this.updateAchievements(stats);
  }

  private async fullRescanInner(): Promise<UsageStats> {
    // Load existing stats instead of starting from zero
    const stats = await this.loadStats();
    const agentsDir = join(this.projectHomeDir, 'agents');

    // Track what we've seen in current files
    const currentStats = createEmptyUsageStats();

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
      // conversation count. station#2252 made destructive rewrites publish
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
          } catch (error) {
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

    // station#3245: the orchestration substrate, folded by the SAME
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

    await this.saveStats(stats);
    await this.updateAchievements(stats);
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
   * Read-only bridge for the usage-rollup module. Existing EventStore usage
   * facts have no Station-observed ingestion timestamp, so this deliberately
   * publishes one receipt per canonical folded session with `observedAt`
   * absent and a legacy/unknown coverage result at the caller.
   */
  readLegacyUsageReceipts(stationId = 'local'): UsageReceipt[] | undefined {
    const sessions = this.readOrchestrationSessionUsage();
    if (sessions === undefined) return undefined;
    return sessions.map(({ threadId, conversationId, usage }) => ({
      id: `legacy-session:${threadId}`,
      stationId,
      provider: usage.provider ?? 'unattributed',
      ...(usage.lastModelId ? { model: usage.lastModelId } : {}),
      conversationId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      pricing: { status: 'unpriced' },
      ...(usage.reportedCostUsd === undefined
        ? {}
        : { reportedCost: { amount: usage.reportedCostUsd, currency: 'USD' } }),
    }));
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
    request: { from: string; to: string; cursor?: string; pageSize?: number },
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

  async getAchievements(): Promise<Achievement[]> {
    const stats = await this.loadStats();
    const saved = existsSync(this.achievementsPath)
      ? JSON.parse(await readFile(this.achievementsPath, 'utf-8'))
      : {};

    return ACHIEVEMENTS.map((def) => {
      const unlocked = this.checkAchievement(def, stats);
      const existing = saved[def.id];

      const costConscious = def.id === 'cost-conscious';
      return {
        ...def,
        unlocked,
        unlockedAt:
          unlocked && !existing?.unlocked
            ? new Date().toISOString()
            : existing?.unlockedAt,
        progress: this.getProgress(def, stats),
        ...(costConscious
          ? {
              progressPercent: getCostConsciousProgressPercent(stats),
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

  private async updateAchievements(_stats: UsageStats): Promise<void> {
    const achievements = await this.getAchievements();
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
