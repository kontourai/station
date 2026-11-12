import type { ProviderSession } from '@kontourai/station-contracts/provider';
import {
  type CanonicalRuntimeEvent,
  PROVIDER_TURN_TRIGGER,
} from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test } from 'vitest';
import { buildOrchestrationSessionSummary } from '../orchestration-session-state.js';

/**
 * The summary says when the newest turn is one the engine opened on its own
 * (a reply to background work), so an inbox can keep a dismissal through it.
 */
const THREAD = 'thread-trigger';

function turn(sequence: number, engineOpened = false): CanonicalRuntimeEvent {
  return {
    eventId: `evt-${sequence}`,
    provider: 'claude',
    threadId: THREAD,
    createdAt: `2026-11-10T10:00:0${sequence}.000Z`,
    method: 'turn.started',
    turnId: `turn-${sequence}`,
    prompt: engineOpened ? '' : 'hi',
    metadata: engineOpened ? { trigger: PROVIDER_TURN_TRIGGER } : {},
  } as CanonicalRuntimeEvent;
}

function summarize(events: CanonicalRuntimeEvent[]) {
  const persisted: ProviderSession = {
    provider: 'claude',
    threadId: THREAD,
    status: 'ready',
    createdAt: '2026-11-10T10:00:00.000Z',
    updatedAt: '2026-11-10T10:00:00.000Z',
  };
  return buildOrchestrationSessionSummary({
    persisted,
    answerability: {
      threadAttachment: 'detached',
      providerRegistered: true,
      observedBy: 'test',
      observedAt: '2026-11-10T10:00:00.000Z',
    },
    events,
  });
}

describe('latestTurnTrigger on the session summary', () => {
  test('marks an engine-opened latest turn', () => {
    expect(summarize([turn(1), turn(2, true)]).latestTurnTrigger).toBe(
      'provider',
    );
  });

  test('a person’s later turn clears it, and no turns leave it absent', () => {
    expect(summarize([turn(1, true), turn(2)])).not.toHaveProperty(
      'latestTurnTrigger',
    );
    expect(summarize([])).not.toHaveProperty('latestTurnTrigger');
  });
});
