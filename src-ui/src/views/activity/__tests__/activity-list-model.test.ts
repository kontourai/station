import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { describe, expect, test } from 'vitest';
import {
  activityOriginKey,
  activityOriginShortLabel,
} from '../activity-list-model';

const NOW = new Date(2026, 8, 29, 15, 0, 0).getTime();

function summary(
  overrides: Partial<OrchestrationSessionSummary> = {},
): OrchestrationSessionSummary {
  const base: OrchestrationSessionSummary = {
    provider: 'claude',
    threadId: 'thread-1',
    status: 'ready',
    controlMode: 'station-owned',
    answerability: { answerable: true },
    isLoaded: true,
    isPersisted: true,
    eventCount: 1,
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  };
  return { ...base, ...overrides };
}

describe('origin', () => {
  test('an attached transcript is started in its engine; an unrecorded one is said so', () => {
    const attached = summary({ controlMode: 'read-only-attached' });
    expect(activityOriginKey(attached)).toBe('Started in Claude Code');
    expect(activityOriginShortLabel(attached)).toBe('Claude Code');
    expect(activityOriginKey(summary())).toBe('Origin not recorded');
    expect(activityOriginShortLabel(summary())).toBeNull();
  });
});
