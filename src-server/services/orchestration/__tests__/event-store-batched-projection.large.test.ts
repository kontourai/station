import { mkdtempSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { EventStore, type PersistedRuntimeEvent } from '../event-store.js';

describe('EventStore high-cardinality batched projection', () => {
  let dir: string;
  let store: EventStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'event-store-batched-projection-'));
    store = new EventStore(join(dir, 'orchestration.sqlite'));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seedProjectionThread(threadId: string): void {
    const base = '2026-08-20T00:00:00.000Z';
    store.upsertSession({
      provider: 'claude',
      threadId,
      status: 'ready',
      createdAt: base,
      updatedAt: base,
    });
    store.appendEvent({
      eventId: `${threadId}-started`,
      provider: 'claude',
      threadId,
      createdAt: base,
      method: 'session.started',
      sessionId: threadId,
      metadata: { agentSlug: 'claude', userId: 'owner-user' },
    });
    store.appendEvent({
      eventId: `${threadId}-configured`,
      provider: 'claude',
      threadId,
      createdAt: base,
      method: 'session.configured',
      sessionId: threadId,
      model: 'claude-sonnet-4-5',
    });
    store.appendEvent({
      eventId: `${threadId}-flow-attached`,
      provider: 'claude',
      threadId,
      createdAt: base,
      method: 'flow.run-attached',
      runId: `run-${threadId}`,
    } as any);
    store.appendEvent({
      eventId: `${threadId}-turn1-started`,
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: base,
      method: 'turn.started',
      prompt: `prompt for ${threadId}`,
    });
    store.appendEvent({
      eventId: `${threadId}-turn1-completed`,
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: base,
      method: 'turn.completed',
      finishReason: 'stop',
    } as any);
    store.appendEvent({
      eventId: `${threadId}-request-opened`,
      provider: 'claude',
      threadId,
      turnId: 'turn-1',
      createdAt: base,
      method: 'request.opened',
      requestId: `${threadId}-req-1`,
      kind: 'approval',
    } as any);
    store.appendEvent({
      eventId: `${threadId}-turn2-started`,
      provider: 'claude',
      threadId,
      turnId: 'turn-2',
      createdAt: base,
      method: 'turn.started',
      prompt: `follow-up for ${threadId}`,
    });
  }

  function withoutObservedAt(
    events: readonly PersistedRuntimeEvent[],
  ): unknown[] {
    return events.map(({ observedAt: _observedAt, ...rest }) => rest);
  }

  function expectBatchedMatchesIndividual(threadId: string): void {
    const individual = store.listSessionProjectionEvents(threadId);
    const batched = store
      .listSessionProjectionEventsForThreads([threadId])
      .get(threadId);
    expect(withoutObservedAt(batched ?? [])).toEqual(
      withoutObservedAt(individual),
    );
  }

  // archive#4466 review remediation: id/thread/pair lists are chunked at 500.
  // The complete seed, batched read, and comparisons retain the original 10s
  // product-law bound; isolation moves no setup into a wider hook allowance.
  test('a population crossing the 500-id chunk boundary is folded completely and correctly', async () => {
    const startedAt = performance.now();
    let phase = 'profiler';
    const trace = (
      event: string,
      details: Record<string, string | number> = {},
    ): void => {
      writeSync(
        1,
        `@@LARGE_PROJECTION_DIAGNOSTIC@@${JSON.stringify({
          phase,
          event,
          elapsedMs: performance.now() - startedAt,
          ...details,
        })}@@END_LARGE_PROJECTION_DIAGNOSTIC@@\n`,
      );
    };
    const profiler = new Session();
    const profilePath = join(
      mkdtempSync(join(tmpdir(), 'station-large-projection-profile-')),
      'projection.cpuprofile',
    );
    let profiling = false;
    try {
      trace('entry');
      profiler.connect();
      await profiler.post('Profiler.enable');
      await profiler.post('Profiler.start');
      profiling = true;
      trace('exit');
      phase = 'seed';
      trace('entry');
      const totalThreads = 1200;
      const threadIds = Array.from(
        { length: totalThreads },
        (_, index) => `batch-equiv-chunk-${index}`,
      );
      threadIds.forEach((threadId, index) => {
        seedProjectionThread(threadId);
        if ((index + 1) % 200 === 0) {
          trace('progress', { completedSessions: index + 1 });
        }
      });
      trace('exit', { completedSessions: threadIds.length });

      phase = 'batched-read';
      trace('entry');
      const batched = store.listSessionProjectionEventsForThreads(threadIds);
      trace('exit', { resultSize: batched.size });
      expect(batched.size).toBe(totalThreads);
      phase = 'comparisons';
      trace('entry');
      for (const index of [0, 1, 250, 499, 500, 501, 750, 999, 1199]) {
        trace('sample-entry', { index });
        expectBatchedMatchesIndividual(threadIds[index]!);
        trace('sample-exit', { index });
      }
      trace('exit');
    } catch (error) {
      trace('error', {
        error: String(error).slice(0, 2000),
        stack: error instanceof Error ? (error.stack ?? '').slice(0, 4000) : '',
      });
      throw error;
    } finally {
      phase = 'profile-retention';
      trace('entry');
      try {
        if (profiling) {
          const { profile } = await profiler.post('Profiler.stop');
          writeFileSync(profilePath, JSON.stringify(profile));
          trace('exit', { profilePath });
        }
      } finally {
        profiler.disconnect();
      }
    }
  }, 10_000);
});
