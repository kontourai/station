import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  FOLD_FIXTURE_KEYS,
  FOLD_FIXTURES,
  FOLD_OBSERVED_AT,
  FOLD_SESSION_CREATED_AT,
  type FoldFixture,
  type FoldFixtureName,
} from '../../../../tests/helpers/session-summary-fold-fixtures.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConversationTurnActivityProjection } from '../conversation-turn-activity.js';
import { EventStore } from '../event-store.js';
import {
  buildOrchestrationSessionSummary,
  projectOrchestrationEventToReadModel,
} from '../orchestration-session-state.js';
import { TurnProgressTracker } from '../turn-progress-tracker.js';

/**
 * Runs each fixture's literal event sequence through the production pieces
 * a session summary is made of, and requires the fields the client's inbox
 * status code reads (`FOLD_FIXTURE_KEYS`) to equal the fixture's literal
 * summary exactly. A fold change fails here; the client tests import the
 * same literals.
 *
 * Real, not stubbed: the event store, the session read model's event
 * projection (so `updatedAt` moves as it does in production), the turn-stall
 * watchdog behind `TurnProgressTracker` (so the silence marker is the one
 * the watchdog writes, on its own clock), the conversation activity
 * projection, the store's draft-lineage read, and
 * `buildOrchestrationSessionSummary`. Constructed here: the engine's report
 * of running children and the serving process's answerability observation,
 * both of which are process-local inputs the builder is handed.
 */
const makeTempDir = trackTempDirs();
const THREAD = 'T';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function fold({
  events,
  options = {},
}: Pick<FoldFixture, 'events' | 'options'>) {
  const store = new EventStore(join(makeTempDir('fold-fixtures-'), 'o.sqlite'));
  const tracker = new TurnProgressTracker({
    providerForThread: () => 'claude',
    publishProjectionChange: () => {},
    logger: { warn: () => {} },
  });
  const projection = new ConversationTurnActivityProjection({
    eventStore: store,
    readTurnProgress: (threadId) => tracker.read(threadId),
    readRunningChildWork: () =>
      Array.from({ length: options.runningChildren ?? 0 }, (_, index) => ({
        producer: 'engine-subagent' as const,
        reporterThreadId: THREAD,
        childId: `child-${index}`,
        status: 'running' as const,
      })),
    logger: { warn: () => {} },
  });
  try {
    let clock = Date.parse(FOLD_SESSION_CREATED_AT) + 1000;
    vi.setSystemTime(clock);
    const sessionReadModel = new Map();
    const created = {
      provider: 'claude',
      threadId: THREAD,
      status: 'running' as const,
      createdAt: FOLD_SESSION_CREATED_AT,
      updatedAt: new Date(clock).toISOString(),
    };
    sessionReadModel.set(THREAD, created);
    store.upsertSession(created as never);
    projection.readForThread(THREAD);
    const written = events.map((fields, index) => {
      clock += 1000;
      vi.setSystemTime(clock);
      const event = {
        eventId: `e${index}`,
        provider: 'claude',
        threadId: THREAD,
        createdAt: new Date(clock).toISOString(),
        ...fields,
      } as unknown as CanonicalRuntimeEvent;
      tracker.observe(event);
      store.appendEvent(event);
      projectOrchestrationEventToReadModel({
        event,
        threadProviders: new Map(),
        sessionReadModel,
        eventStore: store,
      });
      return event;
    });
    if (options.silentForMs) vi.advanceTimersByTime(options.silentForMs);
    const summary = buildOrchestrationSessionSummary({
      persisted: sessionReadModel.get(THREAD),
      events: written,
      answerability: {
        threadAttachment: options.detached ? 'detached' : 'attached',
        providerRegistered: !options.detached,
        observedBy: 'station-a',
        observedAt: FOLD_OBSERVED_AT,
      },
      turnProgress: tracker.read(THREAD),
      conversationActivity: projection.readForThread(THREAD),
      conversationDraftFacts: store.conversationDraftFacts(THREAD),
    });
    return JSON.parse(
      JSON.stringify(
        Object.fromEntries(FOLD_FIXTURE_KEYS.map((key) => [key, summary[key]])),
      ),
    );
  } finally {
    tracker.dispose();
    projection.dispose();
    store.close();
  }
}

const NAMES = Object.keys(FOLD_FIXTURES) as FoldFixtureName[];

describe('the client fixtures are what the server folds', () => {
  test('covers the states the inbox ladder reads', () => {
    expect([...NAMES].sort()).toEqual([
      'approvalInOpenTurn',
      'approvalSettledByInterruption',
      'blocked',
      'detachedApproval',
      'draft',
      'failed',
      'idleWithChildren',
      'interrupted',
      'questionInOpenTurn',
      'runningTool',
      'runningWithChildren',
      'silentRun',
      'turnCompleted',
    ]);
  });

  test.each(NAMES)('%s', (name) => {
    const folded = fold(FOLD_FIXTURES[name]);
    if (process.env.FOLD_FIXTURES_DUMP) {
      writeFileSync(
        `${process.env.FOLD_FIXTURES_DUMP}.${name}.json`,
        JSON.stringify(folded, null, 2),
      );
    }
    expect(folded).toEqual(FOLD_FIXTURES[name].summary);
  });
});
