import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionUsageAggregate } from '@kontourai/station-shared/usage-fold';
import { afterEach, describe, expect, test } from 'vitest';
import {
  type OrchestrationUsageRef,
  UsageAggregator,
} from '../usage-aggregator.js';
import type { OrchestrationSessionUsage } from '../usage-aggregator-state.js';

/** An engine session's fold, with only what that engine actually reported. */
const session = (
  conversationId: string,
  usage: Partial<SessionUsageAggregate> & { turns?: number },
  agentSlug?: string,
): OrchestrationSessionUsage => ({
  threadId: `thread-${conversationId}`,
  conversationId,
  ...(agentSlug ? { agentSlug } : {}),
  usage: { turns: 1, toolCalls: 0, ...usage },
});

const orchestrationRef = (
  sessions: OrchestrationSessionUsage[],
): OrchestrationUsageRef => ({
  get: () => ({ listSessionUsage: () => sessions }),
});

/** Writes one assistant message with Station-counted usage, as FileMemory does. */
async function writeMemorySession(
  home: string,
  agentSlug: string,
  conversationId: string,
  usage?: { inputTokens: number; outputTokens: number; estimatedCost: number },
): Promise<void> {
  const dir = join(home, 'agents', agentSlug, 'memory', 'sessions');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${conversationId}.ndjson`),
    `${JSON.stringify({
      id: 'm1',
      role: 'assistant',
      parts: [],
      metadata: {
        timestamp: '2026-08-01T00:00:00.000Z',
        model: 'station-model',
        ...(usage ? { usage } : {}),
      },
    })}\n`,
    'utf-8',
  );
}

describe('UsageAggregator', () => {
  const homes: string[] = [];
  afterEach(async () => {
    await Promise.all(
      homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
    );
  });

  test('a stray temp file does not inflate the conversation count', async () => {
    // archive#2252 made destructive message rewrites publish via
    // `<conv>.ndjson.<pid>.<uuid>.tmp` in this very directory, so a crash
    // between the write and the rename leaves one behind. The count Set was
    // built from an unfiltered readdir, and `.replace('.ndjson','')` leaves
    // such a name as a DISTINCT id — so every stray added a phantom
    // conversation. `mergeRescannedUsageStats` merges lifetime totals with
    // `Math.max`, so the inflated number would never come back down.
    const home = await mkdtemp(join(tmpdir(), 'station-usage-tmp-'));
    homes.push(home);
    const sessions = join(home, 'agents', 'codex', 'memory', 'sessions');
    await mkdir(sessions, { recursive: true });
    const line = `${JSON.stringify({ id: 'm1', role: 'user', parts: [] })}\n`;
    await writeFile(join(sessions, 'conv-1.ndjson'), line, 'utf-8');
    await writeFile(
      join(sessions, 'conv-1.ndjson.4242.abcd.tmp'),
      line,
      'utf-8',
    );

    const stats = await new UsageAggregator(home).fullRescan();

    expect(stats.lifetime.totalConversations).toBe(1);
  });

  test('serializes concurrent incremental updates without dropping usage', async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-usage-'));
    homes.push(home);
    const aggregator = new UsageAggregator(home);
    const count = 12;
    await Promise.all(
      Array.from({ length: count }, (_, index) =>
        aggregator.incrementalUpdate(
          {
            role: 'assistant',
            metadata: {
              timestamp: Date.now(),
              model: 'gpt-5',
              usage: { inputTokens: index + 1, outputTokens: 2 },
            },
          },
          'codex',
          `conversation-${index}`,
        ),
      ),
    );
    const stats = JSON.parse(
      await readFile(join(home, 'analytics', 'stats.json'), 'utf8'),
    );
    expect(stats.lifetime).toMatchObject({
      totalMessages: count,
      totalInputTokens: (count * (count + 1)) / 2,
      totalOutputTokens: count * 2,
    });
  });
});

describe('UsageAggregator orchestration substrate (station#3245)', () => {
  const homes: string[] = [];
  afterEach(async () => {
    await Promise.all(
      homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
    );
  });
  const newHome = async () => {
    const home = await mkdtemp(join(tmpdir(), 'station-usage-orch-'));
    homes.push(home);
    return home;
  };

  test('an orchestration-only home no longer reports zero lifetime usage', async () => {
    // The filed defect: `fullRescan` walked `agents/*/memory/sessions` only,
    // so a home whose entire history is external-engine turns showed a
    // Profile of zeros even after archive#3243 made the per-session numbers
    // real.
    const home = await newHome();
    const stats = await new UsageAggregator(
      home,
      orchestrationRef([
        session(
          'conv-claude',
          {
            turns: 3,
            inputTokens: 1200,
            outputTokens: 340,
            reportedCostUsd: 0.25,
            lastModelId: 'claude-sonnet-4',
          },
          'claude',
        ),
      ]),
    ).fullRescan();

    expect(stats.lifetime).toMatchObject({
      totalConversations: 1,
      totalMessages: 3,
      totalInputTokens: 1200,
      totalOutputTokens: 340,
      totalCost: 0.25,
      uniqueAgents: ['claude'],
    });
    expect(stats.byAgent.claude).toMatchObject({
      conversations: 1,
      messages: 3,
      cost: 0.25,
    });
    expect(stats.byModel['claude-sonnet-4']).toMatchObject({
      messages: 3,
      inputTokens: 1200,
      outputTokens: 340,
      cost: 0.25,
    });
  });

  test('a memory-only home is unaffected by the new pass', async () => {
    const home = await newHome();
    await writeMemorySession(home, 'station', 'conv-memory', {
      inputTokens: 10,
      outputTokens: 20,
      estimatedCost: 0.5,
    });

    const withoutSource = await new UsageAggregator(home).fullRescan();
    expect(withoutSource.lifetime).toMatchObject({
      totalConversations: 1,
      totalMessages: 1,
      totalInputTokens: 10,
      totalOutputTokens: 20,
      totalCost: 0.5,
    });
    // Absent orchestration substrate => nothing to say about coverage, rather
    // than a claim of zero engine sessions.
    expect(withoutSource.lifetime.engineUsageCoverage).toBeUndefined();

    const emptyHome = await newHome();
    await writeMemorySession(emptyHome, 'station', 'conv-memory', {
      inputTokens: 10,
      outputTokens: 20,
      estimatedCost: 0.5,
    });
    const withEmptySource = await new UsageAggregator(
      emptyHome,
      orchestrationRef([]),
    ).fullRescan();
    expect(withEmptySource.lifetime).toMatchObject({
      totalConversations: 1,
      totalMessages: 1,
      totalInputTokens: 10,
      totalOutputTokens: 20,
      totalCost: 0.5,
    });
  });

  test('a mixed home sums both substrates', async () => {
    const home = await newHome();
    await writeMemorySession(home, 'station', 'conv-memory', {
      inputTokens: 10,
      outputTokens: 20,
      estimatedCost: 0.5,
    });
    const stats = await new UsageAggregator(
      home,
      orchestrationRef([
        session(
          'conv-codex',
          { turns: 2, inputTokens: 100, outputTokens: 200 },
          'codex',
        ),
      ]),
    ).fullRescan();

    expect(stats.lifetime).toMatchObject({
      totalConversations: 2,
      totalMessages: 3,
      totalInputTokens: 110,
      totalOutputTokens: 220,
      totalCost: 0.5,
    });
    expect(stats.lifetime.uniqueAgents.sort()).toEqual(['codex', 'station']);
  });

  test('a session present in BOTH substrates is counted exactly once', async () => {
    // A Station-engine chat: the `station-agent` relay writes the FileMemory
    // transcript AND the orchestration event store records the same session
    // under the same conversation id. Counting both would double every
    // Station-engine figure on the Profile.
    const home = await newHome();
    await writeMemorySession(home, 'station', 'conv-shared', {
      inputTokens: 10,
      outputTokens: 20,
      estimatedCost: 0.5,
    });
    const stats = await new UsageAggregator(
      home,
      orchestrationRef([
        session(
          'conv-shared',
          {
            turns: 1,
            inputTokens: 10,
            outputTokens: 20,
            reportedCostUsd: 0.5,
          },
          'station',
        ),
      ]),
    ).fullRescan();

    expect(stats.lifetime).toMatchObject({
      totalConversations: 1,
      totalMessages: 1,
      totalInputTokens: 10,
      totalOutputTokens: 20,
      totalCost: 0.5,
    });
    expect(stats.byAgent.station).toMatchObject({
      conversations: 1,
      messages: 1,
      cost: 0.5,
    });
    expect(stats.lifetime.engineUsageCoverage).toEqual({
      sessions: 0,
      sessionsReportingTokens: 0,
      sessionsReportingCost: 0,
    });
  });

  test('an unreported measurement contributes nothing, and the total says so', async () => {
    // archive#3201's rule inside a SUM: `undefined` is "never reported", and
    // adding it as 0 would republish the fabrication that issue removed. The
    // partial sum therefore ships with its own denominator.
    const home = await newHome();
    const stats = await new UsageAggregator(
      home,
      orchestrationRef([
        // Claude: tokens and cost.
        session(
          'conv-claude',
          {
            turns: 1,
            inputTokens: 100,
            outputTokens: 50,
            reportedCostUsd: 0.25,
          },
          'claude',
        ),
        // Codex: tokens, no cost.
        session(
          'conv-codex',
          { turns: 1, inputTokens: 400, outputTokens: 20 },
          'codex',
        ),
        // ACP/OpenCode: context occupancy only — no tokens, no cost.
        session('conv-acp', { turns: 1, contextTokens: 27554 }, 'kiro'),
      ]),
    ).fullRescan();

    expect(stats.lifetime.totalCost).toBe(0.25);
    expect(stats.lifetime.totalInputTokens).toBe(500);
    expect(stats.lifetime.totalOutputTokens).toBe(70);
    // All three turns are still messages: Station counts turns itself, so a
    // turn count of zero would be a real zero, not an absence.
    expect(stats.lifetime.totalMessages).toBe(3);
    expect(stats.lifetime.engineUsageCoverage).toEqual({
      sessions: 3,
      sessionsReportingTokens: 2,
      sessionsReportingCost: 1,
    });
    // The engines that reported nothing must not have opened a cost bucket.
    expect(stats.byAgent.codex?.cost).toBe(0);
    expect(stats.byAgent.kiro?.cost).toBe(0);
  });

  test('a reported zero cost is a measurement and counts toward coverage', async () => {
    const home = await newHome();
    const stats = await new UsageAggregator(
      home,
      orchestrationRef([
        session('conv-free', { turns: 1, reportedCostUsd: 0 }, 'ollama'),
      ]),
    ).fullRescan();

    expect(stats.lifetime.totalCost).toBe(0);
    expect(stats.lifetime.engineUsageCoverage).toMatchObject({
      sessions: 1,
      sessionsReportingCost: 1,
    });
  });

  test('coverage is replaced by the newest rescan, never latched upward', async () => {
    // Every other lifetime figure merges with `Math.max`. Coverage must not:
    // it describes the corpus THIS rescan read, and a stale larger count
    // would be a claim about sessions that are no longer there.
    const home = await newHome();
    const sessions = [
      session('conv-a', { turns: 1, reportedCostUsd: 1 }, 'claude'),
      session('conv-b', { turns: 1, reportedCostUsd: 1 }, 'claude'),
    ];
    const aggregator = new UsageAggregator(home, {
      get: () => ({ listSessionUsage: () => sessions }),
    });
    await aggregator.fullRescan();
    expect((await aggregator.loadStats()).lifetime.engineUsageCoverage).toEqual(
      { sessions: 2, sessionsReportingTokens: 0, sessionsReportingCost: 2 },
    );

    sessions.pop();
    const after = await aggregator.fullRescan();
    expect(after.lifetime.engineUsageCoverage).toEqual({
      sessions: 1,
      sessionsReportingTokens: 0,
      sessionsReportingCost: 1,
    });
  });

  test('an orchestration read that throws leaves the memory totals intact', async () => {
    const home = await newHome();
    await writeMemorySession(home, 'station', 'conv-memory', {
      inputTokens: 10,
      outputTokens: 20,
      estimatedCost: 0.5,
    });
    const stats = await new UsageAggregator(home, {
      get: () => ({
        listSessionUsage: () => {
          throw new Error('event store closed');
        },
      }),
    }).fullRescan();

    expect(stats.lifetime.totalMessages).toBe(1);
    expect(stats.lifetime.engineUsageCoverage).toBeUndefined();
  });
});
