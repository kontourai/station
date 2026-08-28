/** @vitest-environment jsdom */

import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import {
  RunBoardSummary,
  summarizeRunBoard,
} from '../views/sessions/RunBoardSummary';

function session(
  threadId: string,
  overrides: Partial<OrchestrationSessionSummary> = {},
): OrchestrationSessionSummary {
  return {
    provider: 'claude',
    threadId,
    status: 'ready',
    controlMode: 'station-owned',
    answerability: { answerable: true },
    isLoaded: true,
    isPersisted: true,
    eventCount: 0,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    lifecycleState: 'running',
    hasActiveTurn: true,
    ...overrides,
  };
}

describe('RunBoardSummary', () => {
  test('renders exact canonical-state counts in priority order and omits zero states', () => {
    const members = [
      session('running-a'),
      session('running-b'),
      session('needs', { lifecycleState: 'needs_input', hasActiveTurn: false }),
      session('completed', { status: 'closed', hasActiveTurn: false }),
    ];
    render(<RunBoardSummary members={members} onFocusMember={vi.fn()} />);

    expect(screen.getByTestId('run-board').getAttribute('aria-label')).toBe(
      '1 needs attention, 2 running, 1 completed',
    );
    expect(
      screen.getByTestId('run-board-cluster-Needs attention').textContent,
    ).toBe('!1');
    expect(screen.getByTestId('run-board-cluster-Running').textContent).toBe(
      '●2',
    );
    expect(screen.getByTestId('run-board-cluster-Completed').textContent).toBe(
      '✓1',
    );
    expect(screen.queryByTestId('run-board-cluster-Failed')).toBeNull();
    expect(screen.queryByTestId('run-board-cluster-Stopped')).toBeNull();
  });

  test('uses established user vocabulary in the accessible sentence', () => {
    render(
      <RunBoardSummary
        members={[
          session('unanswerable', {
            lifecycleState: 'needs_input',
            hasActiveTurn: false,
            answerability: {
              answerable: false,
              qualification: 'provider_absent',
              observedBy: 'run-board-summary-test',
              observedAt: '2026-08-24T00:00:00.000Z',
            },
          }),
        ]}
        onFocusMember={vi.fn()}
      />,
    );

    const board = screen.getByTestId('run-board');
    expect(board.getAttribute('aria-label')).toBe("1 can't answer here");
    expect(board.textContent).not.toContain('Unanswerable');
  });

  // 'Ready' was the one state no assertion pinned — the exact
  // unguarded hole the derived order closes. Every SessionStateLabel member
  // must appear in board order (derivation makes it so; this test proves it).
  test('covers every canonical state, Ready included', () => {
    const members = [
      session('ready', { lifecycleState: 'running', hasActiveTurn: false }),
    ];
    const board = summarizeRunBoard(members);
    expect(board).toEqual([
      expect.objectContaining({ state: 'Ready', count: 1 }),
    ]);
  });

  // a STALE observation (turn no longer active) must not
  // emphasize the board — the member rows gate on hasActiveTurn and the
  // board uses the same shared gate, so they can never contradict on screen.
  test('a stale quiet observation on an inactive turn does not emphasize', () => {
    const board = summarizeRunBoard([
      session('stale-quiet', {
        lifecycleState: 'completed',
        hasActiveTurn: false,
        turnProgress: {
          lastProgressEventAt: '2026-08-24T00:00:00.000Z',
          progressSilence: {
            detectedAt: '2026-08-24T00:01:00.000Z',
            silentSinceEventAt: '2026-08-24T00:00:00.000Z',
            windowMs: 30_000,
            provider: 'claude',
          },
        },
      }),
    ]);
    expect(board).toEqual([
      expect.objectContaining({ state: 'Completed', emphasized: false }),
    ]);
  });

  // activation of a quiet-driven cluster lands on the member that
  // CAUSED the emphasis, and its accessible name says why.
  test('a quiet-driven cluster names and targets the quiet member', () => {
    const healthy = session('healthy-first');
    const quiet = session('quiet-cause', {
      turnProgress: {
        lastProgressEventAt: '2026-08-24T00:00:00.000Z',
        progressSilence: {
          detectedAt: '2026-08-24T00:01:00.000Z',
          silentSinceEventAt: '2026-08-24T00:00:00.000Z',
          windowMs: 30_000,
          provider: 'claude',
        },
      },
    });
    const board = summarizeRunBoard([healthy, quiet]);
    expect(board).toEqual([
      expect.objectContaining({
        state: 'Running',
        emphasized: true,
        firstMemberId: 'healthy-first',
        firstQuietMemberId: 'quiet-cause',
      }),
    ]);

    const onFocusMember = vi.fn();
    render(
      <RunBoardSummary
        members={[healthy, quiet]}
        onFocusMember={onFocusMember}
      />,
    );
    const cluster = screen.getByTestId('run-board-cluster-Running');
    // The user's words for the observation (ProgressSilenceObservation's
    // copy family), never the internal 'quiet' term.
    expect(cluster.getAttribute('aria-label')).toBe(
      'Focus running member with no recent progress (2 running)',
    );
    fireEvent.click(cluster);
    expect(onFocusMember).toHaveBeenCalledWith('quiet-cause');
  });

  test('emphasizes exactly actionable, failed, stopped, and quiet-turn buckets', () => {
    const ordinary = summarizeRunBoard([session('ordinary')]);
    expect(ordinary).toEqual([
      expect.objectContaining({ state: 'Running', emphasized: false }),
    ]);

    const emphasized = summarizeRunBoard([
      session('needs', { lifecycleState: 'needs_input', hasActiveTurn: false }),
      session('failed', { lifecycleState: 'failed', hasActiveTurn: false }),
      session('stopped', { lifecycleState: 'canceled', hasActiveTurn: false }),
      session('quiet', {
        turnProgress: {
          lastProgressEventAt: '2026-08-24T00:00:00.000Z',
          progressSilence: {
            detectedAt: '2026-08-24T00:01:00.000Z',
            silentSinceEventAt: '2026-08-24T00:00:00.000Z',
            windowMs: 30_000,
            provider: 'claude',
          },
        },
      }),
    ]);
    expect(
      emphasized.map(({ state, emphasized: isEmphasized }) => [
        state,
        isEmphasized,
      ]),
    ).toEqual([
      ['Needs attention', true],
      ['Failed', true],
      ['Stopped', true],
      ['Running', true],
    ]);
  });
});
