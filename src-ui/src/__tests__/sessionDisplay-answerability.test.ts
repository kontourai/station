import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { describe, expect, test } from 'vitest';
import { isSessionUnanswerable } from '../utils/answerability';
import { isTerminalSession } from '../utils/sessionDisplay';

/**
 * archive#1781 — the session-display fold family, made answerability-aware:
 * terminal and unanswerable are separate facts, and surfaces render both.
 * (The delegated-task rank this file also pinned went with the delegated-work
 * coordinator card it ordered.)
 */

const observation = {
  answerable: false,
  qualification: 'provider_absent',
  observedBy: 'station-7f3a',
  observedAt: '2026-08-03T12:04:03.000Z',
} as const;

function task(
  overrides: Partial<OrchestrationSessionSummary>,
): OrchestrationSessionSummary {
  return {
    provider: 'acme',
    threadId: 'thread-x',
    status: 'ready',
    controlMode: 'station-owned',
    answerability: { answerable: true },
    delegation: { taskId: 'task-x' },
    isLoaded: true,
    isPersisted: true,
    eventCount: 1,
    createdAt: '2026-08-03T00:00:00.000Z',
    updatedAt: '2026-08-03T00:00:01.000Z',
    ...overrides,
  };
}

describe('terminal and unanswerable are independent facts', () => {
  test('AC5 (control): a failed session is terminal but NOT unanswerable', () => {
    // `past_resume` is `{completed, canceled}` only — `failed -> queued |
    // running` is a live retry path (archive#1090). A predicate that treated
    // `failed` as unanswerable would defeat that retry design, which is why
    // `open-requests.ts` carries a predicate pin for it.
    const failed = task({ lifecycleState: 'failed' });
    expect(isTerminalSession(failed)).toBe(true);
    expect(isSessionUnanswerable(failed)).toBe(false);
  });

  test('and a non-terminal session can be unanswerable', () => {
    // The two questions cross, which is why the surfaces read them
    // separately rather than through one conjunction — see the note in
    // `sessionDisplay.ts` on archive#1781's suggested `isActionableSession`.
    const stranded = task({
      lifecycleState: 'needs_input',
      answerability: observation,
    });
    expect(isTerminalSession(stranded)).toBe(false);
    expect(isSessionUnanswerable(stranded)).toBe(true);
    expect(isSessionUnanswerable(task({ lifecycleState: 'needs_input' }))).toBe(
      false,
    );
  });
});
