/**
 * #5389: a conversation whose lineage changes engine keeps each engine's
 * usage. Composed from the real pieces: the REAL `OrchestrationService` over a
 * REAL `EventStore` (lineage reserved through the store's own API) and the
 * REAL conversation stats route. The runtime events are written in the exact
 * shapes the adapters publish:
 *
 * - Claude Code: one per-turn `token-usage.updated` per `result` message
 *   (`claude-adapter-events.ts`), with `totalTokens` derived from the two
 *   components, cache fields, `contextTokens` and the query's running
 *   `reportedCostUsd`.
 * - Codex: `thread/tokenUsage/updated` mapped from `tokenUsage.total`, the
 *   running total since the thread started (`codex-adapter-notifications.ts`),
 *   with no cost and no cache-write figure.
 */
import { join } from 'node:path';
import type { ConversationStatsResponse } from '@kontourai/station-contracts/runtime';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createConversationRoutes } from '../conversations.js';

// Created before the cleanup hook below, so its directories are removed
// after the service and store close (after-hooks run in reverse order).
const makeTempDir = trackTempDirs();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const OWNER = 'owner';
const SLUG = 'assistant';
const CONVERSATION = 'conv';

type Provider = 'claude' | 'codex';

interface ClaudeTurn {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** The `query()` call's running `total_cost_usd`. */
  runningCostUsd: number;
}

/** Codex's `tokenUsage.total`: since the thread started. */
interface CodexRunningTotal {
  input: number;
  output: number;
  total: number;
  cachedInput: number;
}

function fixture() {
  const directory = makeTempDir('station-stats-engine-change-');
  const store = new EventStore(join(directory, 'events.sqlite'));
  const service = new OrchestrationService({
    adapterRegistry: { register() {}, get: () => undefined, list: () => [] },
    eventBus: new EventBus(),
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() },
  } as never);
  service.initialize();
  cleanups.push(async () => {
    await service.shutdown();
    store.close();
  });
  let clock = Date.parse('2026-11-20T10:00:00.000Z');
  const at = () => {
    clock += 1_000;
    return new Date(clock).toISOString();
  };
  let predecessor: string | undefined;

  /** One execution Session of the conversation, appended to its lineage. */
  function session(threadId: string, provider: Provider) {
    if (predecessor)
      store.reserveNextConversationSession({
        conversationId: CONVERSATION,
        predecessorSessionId: predecessor,
        proposedSessionId: threadId,
        createdAt: at(),
      });
    predecessor = threadId;
    const createdAt = at();
    store.upsertSession({
      provider,
      threadId,
      status: 'closed',
      createdAt,
      updatedAt: createdAt,
    });
    store.appendEvent({
      eventId: `${threadId}:start`,
      threadId,
      sessionId: threadId,
      provider,
      method: 'session.started',
      createdAt,
      metadata: { userId: OWNER },
    } as CanonicalRuntimeEvent);
    let turns = 0;
    const nextTurnId = () => {
      turns += 1;
      return `${threadId}:turn-${turns}`;
    };
    const completeTurn = (turnId: string) =>
      store.appendEvent({
        eventId: `${turnId}:completed`,
        threadId,
        provider,
        method: 'turn.completed',
        createdAt: at(),
        turnId,
        finishReason: 'stop',
      } as CanonicalRuntimeEvent);
    return {
      claudeTurn(figures: ClaudeTurn) {
        const turnId = nextTurnId();
        store.appendEvent({
          eventId: `${turnId}:usage`,
          provider: 'claude',
          threadId,
          createdAt: at(),
          turnId,
          method: 'token-usage.updated',
          promptTokens: figures.input,
          completionTokens: figures.output,
          totalTokens: figures.input + figures.output,
          cacheReadTokens: figures.cacheRead,
          cacheWriteTokens: figures.cacheWrite,
          contextTokens: figures.input + figures.cacheRead + figures.cacheWrite,
          reportedCostUsd: figures.runningCostUsd,
        } as CanonicalRuntimeEvent);
        completeTurn(turnId);
      },
      codexTurn(running: CodexRunningTotal) {
        const turnId = nextTurnId();
        store.appendEvent({
          eventId: `${turnId}:usage`,
          provider: 'codex',
          threadId,
          createdAt: at(),
          method: 'token-usage.updated',
          turnId,
          promptTokens: running.input,
          completionTokens: running.output,
          totalTokens: running.total,
          cacheReadTokens: running.cachedInput,
        } as CanonicalRuntimeEvent);
        completeTurn(turnId);
      },
    };
  }

  const routes = createConversationRoutes(
    new Map(),
    { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    new Map(),
    new Map(),
    { loadAgent: async () => ({ model: 'configured-model' }) } as never,
    { defaultModel: 'configured-model' } as never,
    undefined,
    undefined,
    service as never,
    () => OWNER,
  );

  async function stats(): Promise<ConversationStatsResponse> {
    const response = await routes.request(
      `/${SLUG}/conversations/${CONVERSATION}/stats`,
    );
    expect(response.status).toBe(200);
    return ((await response.json()) as { data: ConversationStatsResponse })
      .data;
  }

  return { session, stats, store };
}

describe('GET /:slug/conversations/:conversationId/stats after an engine change (#5389)', () => {
  test("Claude Code's per-turn counts survive a move to Codex, and nothing is summed across the two", async () => {
    const f = fixture();
    const claude = f.session(CONVERSATION, 'claude');
    claude.claudeTurn({
      input: 10,
      output: 5,
      cacheRead: 100,
      cacheWrite: 20,
      runningCostUsd: 0.1,
    });
    claude.claudeTurn({
      input: 4,
      output: 6,
      cacheRead: 120,
      cacheWrite: 0,
      runningCostUsd: 0.25,
    });
    const codex = f.session(`${CONVERSATION}:session:codex`, 'codex');
    codex.codexTurn({ input: 300, output: 40, total: 340, cachedInput: 200 });
    codex.codexTurn({ input: 700, output: 90, total: 790, cachedInput: 500 });
    expect(f.store.conversationSessions(CONVERSATION)).toHaveLength(2);

    const stats = await f.stats();

    // No token figure claims to be one total over two engines' scales:
    // neither Codex's running total in place of Claude Code's count, nor a
    // sum of the two.
    for (const field of [
      'inputTokens',
      'outputTokens',
      'totalTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
    ] as const)
      expect(stats[field], field).toBeUndefined();
    // Each engine keeps what it counted, in lineage order.
    expect(stats.engines).toEqual([
      {
        provider: 'claude',
        turns: 2,
        toolCalls: 0,
        inputTokens: 14,
        outputTokens: 11,
        totalTokens: 25,
        cacheReadTokens: 220,
        cacheWriteTokens: 20,
        estimatedCost: 0.25,
      },
      {
        provider: 'codex',
        turns: 2,
        toolCalls: 0,
        inputTokens: 700,
        outputTokens: 90,
        totalTokens: 790,
        cacheReadTokens: 500,
      },
    ]);
    // Counts Station observes itself, and USD, are one scale.
    expect(stats).toMatchObject({
      turns: 4,
      toolCalls: 0,
      estimatedCost: 0.25,
      measurement: { source: 'engine-events', provider: 'codex' },
    });
  });

  test('a return to Codex starts a new Codex thread whose running total adds to the first one', async () => {
    const f = fixture();
    f.session(CONVERSATION, 'codex').codexTurn({
      input: 500,
      output: 50,
      total: 550,
      cachedInput: 100,
    });
    f.session(`${CONVERSATION}:session:claude`, 'claude').claudeTurn({
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      runningCostUsd: 0.01,
    });
    // An engine change resets the provider cursor, so this is a fresh Codex
    // thread and its running total starts again from zero.
    f.session(`${CONVERSATION}:session:codex-again`, 'codex').codexTurn({
      input: 80,
      output: 8,
      total: 88,
      cachedInput: 0,
    });

    const stats = await f.stats();

    expect(stats.engines?.map((engine) => engine.provider)).toEqual([
      'codex',
      'claude',
    ]);
    expect(stats.engines?.[0]).toMatchObject({
      provider: 'codex',
      turns: 2,
      inputTokens: 580,
      outputTokens: 58,
      totalTokens: 638,
      cacheReadTokens: 100,
    });
    expect(stats.turns).toBe(3);
  });

  test('a single-engine lineage reads exactly as before: its successor continues the running total it resumed', async () => {
    const f = fixture();
    f.session(CONVERSATION, 'codex').codexTurn({
      input: 300,
      output: 30,
      total: 330,
      cachedInput: 50,
    });
    // A same-engine successor may resume the predecessor's native thread,
    // whose counter already includes the first Session's usage.
    f.session(`${CONVERSATION}:session:resumed`, 'codex').codexTurn({
      input: 450,
      output: 45,
      total: 495,
      cachedInput: 80,
    });

    const stats = await f.stats();

    expect(stats).toMatchObject({
      inputTokens: 450,
      outputTokens: 45,
      totalTokens: 495,
      cacheReadTokens: 80,
      turns: 2,
      measurement: { source: 'engine-events', provider: 'codex' },
    });
    expect(stats.engines).toEqual([
      {
        provider: 'codex',
        turns: 2,
        toolCalls: 0,
        inputTokens: 450,
        outputTokens: 45,
        totalTokens: 495,
        cacheReadTokens: 80,
      },
    ]);
  });
});
