import type { ProviderSession } from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test } from 'vitest';
import { buildOrchestrationSessionSummary } from '../orchestration-session-state.js';

/**
 * #4433: the approval mode the engine last reported applying travels on the
 * session summary, so a client that reloads, resyncs or reopens a chat shows
 * it instead of falling back to the inherited "Default".
 */
const THREAD = 'thread-applied';

function event(
  method: 'session.configured' | 'turn.started',
  sequence: number,
  approvalMode?: string,
): CanonicalRuntimeEvent {
  const metadata = approvalMode ? { approvalMode } : {};
  const base = {
    eventId: `evt-${sequence}`,
    provider: 'codex',
    threadId: THREAD,
    createdAt: `2026-11-02T10:00:0${sequence}.000Z`,
    metadata,
  };
  // Both shapes come from the canonical union, so the fixture is checked.
  return method === 'session.configured'
    ? { ...base, method, sessionId: THREAD }
    : { ...base, method, turnId: `turn-${sequence}`, prompt: 'hi' };
}

function summarize(events: CanonicalRuntimeEvent[]) {
  const persisted: ProviderSession = {
    provider: 'codex',
    threadId: THREAD,
    status: 'ready',
    createdAt: '2026-11-02T10:00:00.000Z',
    updatedAt: '2026-11-02T10:00:00.000Z',
  };
  return buildOrchestrationSessionSummary({
    persisted,
    answerability: {
      threadAttachment: 'detached',
      providerRegistered: true,
      observedBy: 'test',
      observedAt: '2026-11-02T10:00:00.000Z',
    },
    events,
  });
}

describe('appliedApprovalMode on the session summary (#4433)', () => {
  test('the start report survives later turns that report nothing', () => {
    const summary = summarize([
      event('session.configured', 1, 'auto'),
      event('turn.started', 2),
      event('turn.started', 3),
    ]);
    expect(summary.appliedApprovalMode).toBe('auto');
  });

  test('a newer turn report wins over the start report', () => {
    expect(
      summarize([
        event('session.configured', 1, 'connection-default'),
        event('turn.started', 2, 'ask'),
      ]).appliedApprovalMode,
    ).toBe('ask');
  });

  test('nothing reported, nothing claimed', () => {
    expect(
      summarize([event('turn.started', 1)]).appliedApprovalMode,
    ).toBeUndefined();
  });
});
