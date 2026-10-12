/** @vitest-environment jsdom */

import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { STATUS_GLYPH_BY_STATE } from '../components/status/StatusGlyph';
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
      '1 needs you, 2 running, 1 done',
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
    expect(board.getAttribute('aria-label')).toBe('1 elsewhere');
    expect(board.textContent).not.toContain('Unanswerable');
  });

  // 'Ready' was the one state no assertion pinned — the exact unguarded hole
  // the derived order closes. One member per canonical state, fed in reverse,
  // must come back as every state in board order.
  test('covers every canonical state, Ready included, in board order', () => {
    const members = [
      session('completed', { status: 'closed', hasActiveTurn: false }),
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
      session('draft', { hasActiveTurn: false, draft: true }),
      session('ready', { hasActiveTurn: false }),
      session('running'),
      session('stopped', { lifecycleState: 'canceled', hasActiveTurn: false }),
      session('failed', { lifecycleState: 'failed', hasActiveTurn: false }),
      session('needs', { lifecycleState: 'needs_input', hasActiveTurn: false }),
    ];
    const states = summarizeRunBoard(members).map((bucket) => bucket.state);
    expect(states).toEqual([
      'Needs attention',
      'Failed',
      'Stopped',
      'Running',
      'Ready',
      'Draft',
      'Unanswerable',
      'Completed',
    ]);
    // A state added to the canonical set without a member here reds, rather
    // than leaving this test claiming coverage it no longer has.
    expect(new Set(states)).toEqual(
      new Set(Object.keys(STATUS_GLYPH_BY_STATE)),
    );
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
      '2 running — focus the one with no recent progress',
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
