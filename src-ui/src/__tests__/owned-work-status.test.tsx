// @vitest-environment jsdom

import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { sessionLadderWord } from '@kontourai/station-contracts/session-attention';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { groupMobileActivity } from '../components/chat-dock/mobile-activity-groups';
import { InboxRowStatusLine } from '../components/inbox-row/InboxRowStatus';
import { buildOrchestrationItems } from '../views/home/home-view-model';
import { buildWorkFacts } from '../views/home/work-facts';
import {
  partitionSessionLanes,
  sessionWorkStatus,
} from '../views/sessions/sessions-lane-model';

afterEach(cleanup);
const now = Date.parse('2026-11-01T00:00:00Z');

test.each([
  ['stopping', 'local', 'Stopping', false, 'running'],
  [
    'waiting-on-peer',
    'peer',
    'Waiting on another Station process',
    false,
    'running',
  ],
  ['unknown', 'unknown', 'Unknown', false, 'idle'],
  ['unknown', 'unknown', 'Unknown', true, 'running'],
] as const)(
  'owned cleanup %s (%s) with label %s and active turn %s appears under %s',
  (state, custody, word, hasActiveTurn, laneId) => {
    const summary: OrchestrationSessionSummary = {
      threadId: 'parent',
      provider: 'claude',
      status: hasActiveTurn ? 'running' : 'closed',
      lifecycleState: 'running',
      hasActiveTurn,
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
    expect(screen.getByText(word, { exact: true }).textContent).toBe(word);
    if (state === 'unknown')
      expect(screen.getByTestId('inbox-row-status').textContent).toContain(
        'Station cannot verify which process owns the child.',
      );
    expect(sessionLadderWord(summary)).toBe(word);
    expect(
      partitionSessionLanes({ sessions: [summary], agents: [], now }).find(
        (lane) => lane.sessions.includes(summary),
      )?.id,
    ).toBe(laneId);
    const items = buildOrchestrationItems([summary], []);
    const facts = buildWorkFacts({ items, sessions: [summary] });
    const inboxLane = (resolution: ReadonlySet<string>) =>
      groupMobileActivity(items, now, {}, facts, resolution).find((group) =>
        group.items.some(({ id }) => id === summary.threadId),
      )?.id;
    expect(inboxLane(new Set())).toBe(laneId === 'idle' ? 'open' : 'running');
    expect(inboxLane(new Set([summary.threadId]))).toBe(
      laneId === 'idle' ? 'settled' : 'running',
    );
  },
);
