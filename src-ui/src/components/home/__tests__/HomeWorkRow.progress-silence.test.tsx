// @vitest-environment jsdom

import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildHomeWorkItems } from '../../../views/home/home-view-model';
import { buildWorkFacts } from '../../../views/home/work-facts';
import { renderHomeWorkRow } from '../HomeWorkRow';

const LAST_PROGRESS_AT = '2026-08-24T12:00:00.000Z';

/**
 * This is the exact serialized summary shape `listSessionReadModel` writes:
 * the fixture intentionally does not manufacture a Home-only quiet-state
 * field, so a server/UI field-name drift fails at the render boundary (#1715).
 */
function session(
  overrides: Partial<OrchestrationSessionSummary> = {},
): OrchestrationSessionSummary {
  return {
    provider: 'bedrock',
    threadId: 'turn-progress-observation',
    status: 'running',
    controlMode: 'station-owned',
    answerability: { answerable: true },
    createdAt: '2026-08-24T11:59:00.000Z',
    updatedAt: LAST_PROGRESS_AT,
    lastEventAt: LAST_PROGRESS_AT,
    isLoaded: true,
    isPersisted: true,
    eventCount: 2,
    lifecycleState: 'running',
    hasActiveTurn: true,
    ...overrides,
  };
}

function renderSession(
  overrides: Partial<OrchestrationSessionSummary> = {},
): void {
  const sessions = [session(overrides)];
  const items = buildHomeWorkItems({ chats: {}, agents: [], sessions });
  const [item] = items;
  render(
    <ul>
      {renderHomeWorkRow({
        task: { ...item, stableId: item.id },
        isWoken: false,
        agents: [],
        onOpen: () => {},
        context: {
          now: Date.now(),
          workFacts: buildWorkFacts({ items, sessions }),
          detailsFor: null,
          setDetailsFor: () => {},
          chrome: 'touch',
        },
      })}
    </ul>,
  );
}

/** The status line as drawn: screen-reader-only text is not part of it. */
function visibleStatus(): string {
  const clone = screen
    .getByTestId('inbox-row-status')
    .cloneNode(true) as Element;
  for (const hidden of clone.querySelectorAll('.sr-only')) hidden.remove();
  return clone.textContent ?? '';
}

describe('HomeWorkRow status line from the server projections (station#4054)', () => {
  afterEach(() => vi.restoreAllMocks());

  test('a completed parent with a running child says how many are running', () => {
    renderSession({
      lifecycleState: 'completed',
      hasActiveTurn: false,
      conversationActivity: {
        conversationId: 'turn-progress-observation',
        currentThreadId: 'turn-progress-observation',
        asOfSequence: 4,
        runningChildWork: { count: 1, producers: ['engine-subagent'] },
      },
    });
    expect(visibleStatus()).toBe('1 sub-agent');
  });

  test('a stopped parent with a running child still reads as running, never Stopped', () => {
    renderSession({
      lifecycleState: 'canceled',
      hasActiveTurn: false,
      conversationActivity: {
        conversationId: 'turn-progress-observation',
        currentThreadId: 'turn-progress-observation',
        asOfSequence: 5,
        runningChildWork: { count: 1, producers: ['engine-subagent'] },
      },
    });
    expect(screen.getByTestId('inbox-row').dataset.lane).toBe('running');
    expect(screen.queryByText('Active')).toBeNull();
    expect(screen.getByText('1 sub-agent')).toBeTruthy();
    expect(screen.queryByText('Stopped')).toBeNull();
  });

  test('child work reported with no count reads Running', () => {
    renderSession({
      lifecycleState: 'completed',
      hasActiveTurn: false,
      conversationActivity: {
        conversationId: 'turn-progress-observation',
        currentThreadId: 'turn-progress-observation',
        asOfSequence: 6,
        runningChildWork: {
          count: 0,
          producers: ['engine-subagent'],
          followUpPending: true,
        },
      },
    });
    expect(visibleStatus()).toBe('Running');
  });

  test('renders the exact watchdog silence marker on the status line', () => {
    vi.spyOn(Date, 'now').mockReturnValue(
      new Date('2026-08-24T12:04:12.000Z').valueOf(),
    );
    renderSession({
      turnProgress: {
        lastProgressEventAt: LAST_PROGRESS_AT,
        progressSilence: {
          detectedAt: '2026-08-24T12:03:00.000Z',
          windowMs: 180_000,
          silentSinceEventAt: LAST_PROGRESS_AT,
          provider: 'bedrock',
        },
      },
    });

    expect(visibleStatus()).toBe('No progress · 4m');
  });

  test('renders no quiet wording when the watchdog holds no marker', () => {
    vi.spyOn(Date, 'now').mockReturnValue(
      new Date('2026-08-24T12:00:30.000Z').valueOf(),
    );
    renderSession({ turnProgress: { lastProgressEventAt: LAST_PROGRESS_AT } });

    expect(visibleStatus()).toBe('Running');
    expect(screen.queryByText(/no progress/i)).toBeNull();
  });

  test.each([
    [
      'Failed',
      {
        lifecycleState: 'failed' as const,
        terminalAttribution: {
          kind: 'runtime_error' as const,
          detail: 'The engine reported an error: request refused.',
        },
      },
    ],
    [
      'Stopped',
      {
        lifecycleState: 'canceled' as const,
        terminalAttribution: {
          kind: 'requested_stop' as const,
          detail: 'Stopped by request.',
        },
      },
    ],
  ] as const)(
    'renders the compact terminal basis for a %s row',
    (_state, overrides) => {
      renderSession(overrides);
      expect(screen.getByTestId('inbox-row-failure-reason').textContent).toBe(
        overrides.terminalAttribution.detail,
      );
    },
  );

  test.each([
    ['clean completion', { lifecycleState: 'completed' as const }],
    ['failed row without detail', { lifecycleState: 'failed' as const }],
  ] as const)('renders no terminal basis for %s', (_case, overrides) => {
    renderSession(overrides);
    expect(screen.queryByTestId('inbox-row-failure-reason')).toBeNull();
  });
});
