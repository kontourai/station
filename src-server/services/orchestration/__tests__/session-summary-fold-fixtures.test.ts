import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test } from 'vitest';
import {
  FOLD_FIXTURE_KEYS,
  FOLD_FIXTURES,
  FOLD_OBSERVED_AT,
  FOLD_SESSION_CREATED_AT,
  type FoldFixture,
} from '../../../../tests/helpers/session-summary-fold-fixtures.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConversationTurnActivityProjection } from '../conversation-turn-activity.js';
import { EventStore } from '../event-store.js';
import { buildOrchestrationSessionSummary } from '../orchestration-session-state.js';

/**
 * Runs each fixture's literal event sequence through the real event store,
 * activity projection and summary builder, and requires the fields the
 * client's inbox status code reads to equal the fixture's literal summary.
 * A fold change fails here; the client tests import the same literals.
 */
const makeTempDir = trackTempDirs();

function fold({
  events,
  options = {},
}: Pick<FoldFixture, 'events' | 'options'>) {
  const threadId = 'T';
  const store = new EventStore(join(makeTempDir('fold-fixtures-'), 'o.sqlite'));
  const projection = new ConversationTurnActivityProjection({
    eventStore: store,
    readTurnProgress: () => undefined,
    readRunningChildWork: () =>
      Array.from({ length: options.runningChildren ?? 0 }, (_, index) => ({
        producer: 'engine-subagent' as const,
        reporterThreadId: threadId,
        childId: `child-${index}`,
        status: 'running' as const,
      })),
    logger: { warn: () => {} },
  });
  try {
    let clock = Date.parse(FOLD_SESSION_CREATED_AT) + 1000;
    const persisted = {
      provider: 'claude',
      threadId,
      status: 'running' as const,
      createdAt: FOLD_SESSION_CREATED_AT,
      updatedAt: new Date(clock).toISOString(),
      ...(options.workspaceIsolation
        ? { workspaceIsolation: options.workspaceIsolation }
        : {}),
    };
    store.upsertSession(persisted as never);
    projection.readForThread(threadId);
    const written = events.map((fields, index) => {
      clock += 1000;
      return {
        eventId: `e${index}`,
        provider: 'claude',
        threadId,
        createdAt: new Date(clock).toISOString(),
        ...fields,
      } as unknown as CanonicalRuntimeEvent;
    });
    for (const event of written) store.appendEvent(event);
    const summary = buildOrchestrationSessionSummary({
      persisted: persisted as never,
      events: written,
      answerability: {
        threadAttachment: options.detached ? 'detached' : 'attached',
        providerRegistered: !options.detached,
        observedBy: 'station-a',
        observedAt: FOLD_OBSERVED_AT,
      },
      conversationActivity: projection.readForThread(threadId),
    });
    return Object.fromEntries(
      FOLD_FIXTURE_KEYS.filter((key) => summary[key] !== undefined).map(
        (key) => [key, summary[key]],
      ),
    );
  } finally {
    projection.dispose();
    store.close();
  }
}

describe('the client fixtures are what the server folds', () => {
  test('covers the states the inbox ladder reads', () => {
    expect(Object.keys(FOLD_FIXTURES).sort()).toEqual([
      'approvalInOpenTurn',
      'blocked',
      'detachedApproval',
      'failed',
      'interrupted',
      'questionInOpenTurn',
      'runningTool',
      'runningWithChildren',
      'staleApprovalAfterInterruption',
      'turnCompleted',
      'worktreeSession',
    ]);
  });

  test.each(Object.keys(FOLD_FIXTURES) as (keyof typeof FOLD_FIXTURES)[])(
    '%s',
    (name) => {
      expect(fold(FOLD_FIXTURES[name])).toEqual(FOLD_FIXTURES[name].summary);
    },
  );
});
