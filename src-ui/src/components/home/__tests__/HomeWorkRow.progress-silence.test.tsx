// @vitest-environment jsdom

import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildHomeWorkItems } from '../../../views/home/home-view-model';
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
  const [item] = buildHomeWorkItems({
    chats: {},
    agents: [],
    sessions: [session(overrides)],
  });
  render(
    <ul>
      {renderHomeWorkRow({
        task: { ...item, stableId: item.id },
        isWoken: false,
        agents: [],
        onOpen: () => {},
      })}
    </ul>,
  );
}

describe('HomeWorkRow turn progress observation (station#4054)', () => {
  afterEach(() => vi.restoreAllMocks());

  test('renders the exact watchdog silence marker and its last-progress timestamp', async () => {
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

    expect(screen.getByText('Last progress 4m ago').textContent).toBe(
      'Last progress 4m ago',
    );
    const indicator = await screen.findByText(
      'No progress events for 4m (window 3m)',
    );
    expect(indicator.textContent).toBe('No progress events for 4m (window 3m)');
    expect(indicator.getAttribute('title')).toBe(LAST_PROGRESS_AT);
  });

  test('renders the active-turn last-progress line but no quiet indicator when the marker is absent', () => {
    vi.spyOn(Date, 'now').mockReturnValue(
      new Date('2026-08-24T12:00:30.000Z').valueOf(),
    );
    renderSession({ turnProgress: { lastProgressEventAt: LAST_PROGRESS_AT } });

    expect(screen.getByText('Last progress just now').textContent).toBe(
      'Last progress just now',
    );
    expect(screen.queryByText(/No progress events for/)).toBeNull();
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
      expect(
        screen.getByTestId('home-row-terminal-attribution').textContent,
      ).toBe(overrides.terminalAttribution.detail);
    },
  );

  test.each([
    ['clean completion', { lifecycleState: 'completed' as const }],
    ['failed row without detail', { lifecycleState: 'failed' as const }],
  ] as const)('renders no terminal basis for %s', (_case, overrides) => {
    renderSession(overrides);
    expect(screen.queryByTestId('home-row-terminal-attribution')).toBeNull();
  });
});
