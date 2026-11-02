// @vitest-environment jsdom

import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { sessionLadderWord } from '@kontourai/station-contracts/session-attention';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { InboxRowStatusLine } from '../components/inbox-row/InboxRowStatus';
import {
  partitionSessionLanes,
  sessionWorkStatus,
} from '../views/sessions/sessions-lane-model';

afterEach(cleanup);
const now = Date.parse('2026-11-01T00:00:00Z');

test.each([
  ['stopping', 'local', 'Stopping'],
  ['waiting-on-peer', 'peer', 'Waiting on another Station process'],
  ['unknown', 'unknown', 'Unknown'],
] as const)(
  'owned cleanup renders %s after the parent stops',
  (state, custody, word) => {
    const summary: OrchestrationSessionSummary = {
      threadId: 'parent',
      provider: 'claude',
      status: 'closed',
      lifecycleState: 'running',
      hasActiveTurn: false,
      controlMode: 'station-owned',
      answerability: { answerable: true },
      isLoaded: false,
      isPersisted: true,
      eventCount: 2,
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
      ownedWork: {
        state,
        ownLifecycleState: 'canceled',
        runningChildCount: 0,
        pendingStopCount: 1,
        pendingStops: [{ custody, reason: 'test-owner', count: 1 }],
      },
    };
    render(
      <InboxRowStatusLine
        status={sessionWorkStatus(summary, [], now)}
        now={now}
        id="owned-stop"
      />,
    );
    expect(screen.getByTestId('inbox-row-status').textContent).toBe(word);
    expect(sessionLadderWord(summary)).toBe(word);
    expect(
      partitionSessionLanes({ sessions: [summary], agents: [], now }).find(
        (lane) => lane.sessions.includes(summary),
      )?.id,
    ).toBe('running');
  },
);
