/**
 * @vitest-environment jsdom
 *
 * archive#3238 (bug 2) — the run-history table collapsed `RunStatus` (a
 * 7-member tri-state: queued | starting | running | waiting_for_approval |
 * completed | failed | cancelled) into a boolean by checking only
 * `status === 'completed'`. Every in-flight or user-actionable status
 * rendered identically to a real failure — a red X — including
 * `waiting_for_approval`, which is a run stalled on the user, shown to that
 * same user as already broken.
 *
 * These tests render the real `JobDetail` component (not just the pure
 * `runStatusVisual` mapping) against one run per status and assert the
 * rendered tone via the status cell's accessible name/title, so a
 * regression back to the boolean check would fail here even if it still
 * exported a correct-looking helper nobody wired up.
 */

import type { RunStatus, RunSummary } from '@kontourai/station-contracts/runs';
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

vi.mock('../hooks/useScheduler', () => ({
  useRunsQuery: () => ({ data: (globalThis as any).__jobDetailRuns__ ?? [] }),
  useSchedulerJobs: () => ({ data: [] }),
  useRestartJobMonitor: () => ({ mutate: vi.fn(), isPending: false }),
  useFetchRunOutputRef: () => ({ mutateAsync: vi.fn(), isPending: false }),
  // Added when useScheduler gained it and JobDetail adopted it. This
  // factory must name EVERY export the component reaches, so each new
  // hook reds this suite until listed (archive#4292). The partial-mock
  // form vitest suggests does not work here as-is: falling through to
  // the real hooks needs a QueryClientProvider around the render.
  useResolveIndeterminateJobMonitor: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

import { JobDetail, runStatusVisual } from '../components/scheduler/JobDetail';

const JOB_NAME = 'nightly-sync';

function makeRun(status: RunStatus, runId: string): RunSummary {
  return {
    runId,
    providerId: 'station',
    source: 'schedule',
    sourceId: JOB_NAME,
    status,
    startedAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    retryEligible: false,
    attempt: 1,
  };
}

function renderWithRuns(runs: RunSummary[]) {
  (globalThis as any).__jobDetailRuns__ = runs;
  return render(<JobDetail name={JOB_NAME} />);
}

function statusCell(label: string): HTMLElement {
  const cell = screen.getByText(label).closest('td');
  expect(cell).not.toBeNull();
  return cell!;
}

describe('runStatusVisual', () => {
  test('maps every RunStatus to a tone', () => {
    expect(runStatusVisual('completed').tone).toBe('ok');
    expect(runStatusVisual('failed').tone).toBe('fail');
    expect(runStatusVisual('cancelled').tone).toBe('fail');
    expect(runStatusVisual('waiting_for_approval').tone).toBe('attention');
    expect(runStatusVisual('queued').tone).toBe('pending');
    expect(runStatusVisual('starting').tone).toBe('pending');
    expect(runStatusVisual('running').tone).toBe('pending');
  });
});

describe('JobDetail run-history status column', () => {
  test('completed renders the ok tone', () => {
    renderWithRuns([makeRun('completed', 'r1')]);
    const cell = statusCell('Completed');
    expect(cell.className).toContain('schedule__log-status--ok');
  });

  test.each<RunStatus>(['failed', 'cancelled'])(
    'genuinely-failed status %s renders the fail tone',
    (status) => {
      renderWithRuns([makeRun(status, `r-${status}`)]);
      const cell = statusCell(runStatusVisual(status).label);
      expect(cell.className).toContain('schedule__log-status--fail');
    },
  );

  test.each<RunStatus>(['queued', 'starting', 'running'])(
    'in-flight status %s does NOT render the fail tone',
    (status) => {
      renderWithRuns([makeRun(status, `r-${status}`)]);
      const cell = statusCell(runStatusVisual(status).label);
      expect(cell.className).not.toContain('schedule__log-status--fail');
      expect(cell.className).toContain('schedule__log-status--pending');
    },
  );

  test('waiting_for_approval does NOT render the fail tone, and is distinguishable from plain running', () => {
    renderWithRuns([makeRun('waiting_for_approval', 'r-wait')]);
    const cell = statusCell('Waiting for approval');
    expect(cell.className).not.toContain('schedule__log-status--fail');
    expect(cell.className).toContain('schedule__log-status--attention');
    // Distinct from the plain in-flight tone used for queued/starting/running.
    expect(cell.className).not.toContain('schedule__log-status--pending');
  });

  test('every non-completed, non-failure status in one table renders a non-fail cell', () => {
    const runs: RunSummary[] = [
      makeRun('queued', 'r1'),
      makeRun('starting', 'r2'),
      makeRun('running', 'r3'),
      makeRun('waiting_for_approval', 'r4'),
      makeRun('failed', 'r5'),
      makeRun('cancelled', 'r6'),
      makeRun('completed', 'r7'),
    ];
    renderWithRuns(runs);

    const failCells = document.querySelectorAll('.schedule__log-status--fail');
    // Only the genuinely-failed statuses (failed, cancelled) get the fail tone.
    expect(failCells.length).toBe(2);
    const failLabels = Array.from(failCells).map((el) => el.textContent);
    expect(failLabels.sort()).toEqual(['Cancelled', 'Failed']);
  });
});
