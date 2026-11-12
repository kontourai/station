// @vitest-environment jsdom

import type { OrchestrationSessionSummary } from '@kontourai/station-sdk';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  buildHomeWorkItems,
  type HomeWorkItem,
} from '../../../views/home/home-view-model';
import { buildWorkFacts } from '../../../views/home/work-facts';
import { renderHomeWorkRow } from '../HomeWorkRow';

// #4695: each Session's latest-turn window, as the plan line reads it.
const useOrchestrationSessionActivityQuery = vi.hoisted(() => vi.fn());
vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  useOrchestrationSessionActivityQuery,
}));

const AT = '2026-11-12T12:00:00.000Z';

function session(
  overrides: Partial<OrchestrationSessionSummary>,
): OrchestrationSessionSummary {
  return {
    provider: 'acp',
    threadId: 'thread-1',
    status: 'running',
    controlMode: 'station-owned',
    answerability: { answerable: true },
    createdAt: AT,
    updatedAt: AT,
    isLoaded: true,
    isPersisted: true,
    eventCount: 4,
    lifecycleState: 'running',
    hasActiveTurn: true,
    ...overrides,
  };
}

function planWindow(
  lifecycleState: string,
  statuses: string[],
  { staleTurn = false } = {},
) {
  return {
    session: { lifecycleState },
    events: [
      { sequence: 1, event: { method: 'turn.started', turnId: 'turn-1' } },
      {
        sequence: 2,
        event: {
          method: 'plan.updated',
          turnId: 'turn-1',
          entries: statuses.map((status, index) => ({
            content: `Step ${index + 1}`,
            status,
          })),
        },
      },
      ...(staleTurn
        ? [{ sequence: 3, event: { method: 'turn.started', turnId: 'turn-2' } }]
        : []),
    ],
  };
}

function renderRow(
  summary: OrchestrationSessionSummary,
  size: 'card' | 'slim' = 'card',
  itemOverrides: Partial<HomeWorkItem> = {},
) {
  const sessions = [summary];
  const items = buildHomeWorkItems({ chats: {}, agents: [], sessions });
  const item = { ...items[0], ...itemOverrides };
  return render(
    <ul>
      {renderHomeWorkRow({
        task: { ...item, stableId: item.id },
        isWoken: false,
        agents: [],
        onOpen: () => {},
        size,
        context: {
          now: Date.parse(AT),
          workFacts: buildWorkFacts({ items, sessions }),
          detailsFor: null,
          setDetailsFor: () => {},
          chrome: 'hover',
        },
      })}
    </ul>,
  );
}

describe("Home rows show the Session's agent-reported plan (#4695)", () => {
  let windows: Record<string, unknown>;
  beforeEach(() => {
    windows = {};
    useOrchestrationSessionActivityQuery.mockReset();
    useOrchestrationSessionActivityQuery.mockImplementation(
      (threadId: string) => ({ data: windows[threadId] }),
    );
  });
  afterEach(cleanup);

  test('a running row shows the fraction under the row, named in words, and keeps refreshing', () => {
    windows['thread-1'] = planWindow('running', [
      'completed',
      'completed',
      'in_progress',
      'pending',
    ]);
    const { container } = renderRow(session({}));
    const line = screen.getByRole('img', {
      name: 'Agent-reported plan: 2 of 4 steps done',
    });
    expect(line.textContent).toBe('Agent plan 2/4');
    // A sibling of the shared row, never a second control inside it.
    expect(line.closest('.inbox-row')).toBeNull();
    expect(container.querySelector('.home-work-row')?.contains(line)).toBe(
      true,
    );
    expect(useOrchestrationSessionActivityQuery).toHaveBeenCalledWith(
      'thread-1',
      undefined,
      expect.objectContaining({ enabled: true, refetchInterval: 5_000 }),
    );
  });

  test('a row waiting on the person reads Waiting; a plan from an earlier turn says so', () => {
    windows['thread-1'] = planWindow('needs_input', ['completed', 'pending']);
    renderRow(session({ lifecycleState: 'needs_input', hasActiveTurn: false }));
    expect(
      screen.getByRole('img', {
        name: 'Agent-reported plan: 1 of 2 steps done, waiting',
      }).textContent,
    ).toBe('Agent plan 1/2 · Waiting');
    cleanup();

    windows['thread-1'] = planWindow('running', ['completed', 'pending'], {
      staleTurn: true,
    });
    renderRow(session({}));
    expect(
      screen.getByRole('img', {
        name: 'Agent-reported plan: 1 of 2 steps done, from an earlier turn',
      }).textContent,
    ).toBe('Agent plan 1/2 · Earlier turn');
  });

  test('an ended Session still shows how far its plan got, read once without refreshing', () => {
    windows['thread-1'] = planWindow('failed', ['completed', 'in_progress']);
    renderRow(session({ lifecycleState: 'failed', hasActiveTurn: false }));
    expect(
      screen.getByRole('img', {
        name: 'Agent-reported plan: 1 of 2 steps done, stopped',
      }).textContent,
    ).toBe('Agent plan 1/2 · Stopped');
    expect(useOrchestrationSessionActivityQuery).toHaveBeenCalledWith(
      'thread-1',
      undefined,
      expect.objectContaining({ enabled: true, refetchInterval: undefined }),
    );
  });

  test('no plan, an empty plan, a Draft, a one-line row and another Station show nothing', () => {
    windows['thread-1'] = {
      session: { lifecycleState: 'running' },
      events: [],
    };
    const { container } = renderRow(session({}));
    expect(container.querySelector('.task-plan-progress')).toBeNull();
    cleanup();

    windows['thread-1'] = planWindow('running', []);
    expect(
      renderRow(session({})).container.querySelector('.task-plan-progress'),
    ).toBeNull();
    cleanup();

    useOrchestrationSessionActivityQuery.mockClear();
    windows['thread-1'] = planWindow('queued', ['completed', 'pending']);
    expect(
      renderRow(
        session({
          lifecycleState: 'queued',
          hasActiveTurn: false,
          draft: true,
        }),
      ).container.querySelector('.task-plan-progress'),
    ).toBeNull();
    cleanup();

    windows['thread-1'] = planWindow('running', ['completed', 'pending']);
    expect(
      renderRow(session({}), 'slim').container.querySelector(
        '.task-plan-progress',
      ),
    ).toBeNull();
    cleanup();

    // A row from another Station names a Session this Station cannot read.
    expect(
      renderRow(session({}), 'card', {
        kind: 'remote-session',
        environmentLabel: 'Build box',
      }).container.querySelector('.task-plan-progress'),
    ).toBeNull();
    // The Draft, one-line and remote rows never read the Session at all.
    expect(useOrchestrationSessionActivityQuery).not.toHaveBeenCalled();
  });
});
