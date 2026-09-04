/**
 * @vitest-environment jsdom
 *
 * FirstRunFlow is the TOUR now (UX audit RT-02/SHELL-12 moved the questions to
 * `FirstRunHomeChapter`). What these cover is what the `Coachmark` tests below
 * it cannot see: that the tour only ever opens because someone asked for it,
 * that focus is captured and restored across a whole run, and that a chapter
 * value this build cannot render repairs instead of dead-ending.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const navigate = vi.fn();
const showSurface = vi.fn();

vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate }),
}));
vi.mock('../../../contexts/RegionModelContext', () => ({}));
vi.mock('../../../contexts/useShowSurface', () => ({
  useShowSurface: () => showSurface,
}));

import { FirstRunFlow } from '../FirstRunFlow';
import { firstRunStore, requestFirstRunTour } from '../first-run-store';
import { FIRST_RUN_TOUR_STEPS, tourStepPath } from '../tour-steps';

beforeEach(() => {
  navigate.mockReset();
  showSurface.mockReset();
  firstRunStore.reset();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('the tour opens only when it is asked for', () => {
  test('a cold mount renders nothing at all', () => {
    // The whole RT-02 defect in one assertion: nothing about mounting, about a
    // readiness probe, or about how long the page has been open may put a
    // first-run surface on screen.
    render(<FirstRunFlow />);
    expect(screen.queryByTestId('first-run-coachmark')).toBeNull();
    expect(firstRunStore.getSnapshot().chapter).toBe('connect');
  });

  test('a run interrupted mid-tour resumes where it stopped', async () => {
    firstRunStore.recordTourStep(FIRST_RUN_TOUR_STEPS[1].id);
    render(<FirstRunFlow />);
    await waitFor(() =>
      expect(screen.getByTestId('first-run-coachmark')).toBeTruthy(),
    );
    expect(showSurface).toHaveBeenLastCalledWith('activity');
  });

  test('a finished run stays finished until someone asks again', async () => {
    firstRunStore.finish();
    render(<FirstRunFlow />);
    expect(screen.queryByTestId('first-run-coachmark')).toBeNull();

    act(() => requestFirstRunTour());
    await waitFor(() =>
      expect(screen.getByTestId('first-run-coachmark')).toBeTruthy(),
    );
  });
});

describe('return focus across the run (review H2, MEDIUM-2)', () => {
  test('returns to a persistent trigger exactly', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Take the tour';
    document.body.appendChild(trigger);
    render(<FirstRunFlow />);

    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    fireEvent(window, new CustomEvent('station-start-first-run-tour'));

    await waitFor(() =>
      expect(screen.getByTestId('first-run-coachmark')).toBeTruthy(),
    );
    expect(document.activeElement).toBe(
      screen.getByTestId('first-run-coachmark'),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Skip the tour' }));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test('falls back to a surviving ancestor when the trigger unmounts', async () => {
    // THE PRODUCTION PATH. `CommandPalette.runCommand` is `close;
    // command.run;` and `close` is a batched setState, so when we capture,
    // focus is still on the palette's own input — a node that unmounts a tick
    // later.
    const shell = document.createElement('div');
    shell.id = 'app-shell';
    const overlay = document.createElement('div');
    const input = document.createElement('input');
    overlay.appendChild(input);
    shell.appendChild(overlay);
    document.body.appendChild(shell);
    render(<FirstRunFlow />);

    input.focus();
    expect(document.activeElement).toBe(input);
    fireEvent(window, new CustomEvent('station-start-first-run-tour'));
    // The overlay tears itself down right after invoking us.
    overlay.remove();

    await waitFor(() =>
      expect(screen.getByTestId('first-run-coachmark')).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Skip the tour' }));

    // The captured node is gone, so the shared helper walks to the nearest
    // surviving ancestor. What matters is that it is NOT <body> — that is the
    // archive#1126 defect this whole mechanism exists to avoid.
    await waitFor(() => expect(document.activeElement).toBe(shell));
    expect(document.activeElement).not.toBe(document.body);
  });

  test('a run started from no gesture captures nothing and restores nothing', async () => {
    // `FirstRunHomeChapter` completes and dispatches the event from its own
    // teardown, so `document.activeElement` can legitimately be <body>:
    // `captureReturnFocus` returns an empty chain and `endRun` correctly skips
    // the restore. Asserted rather than left as an undocumented no-op.
    render(<FirstRunFlow />);
    act(() => requestFirstRunTour());
    await waitFor(() =>
      expect(screen.getByTestId('first-run-coachmark')).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Skip the tour' }));
    await waitFor(() =>
      expect(firstRunStore.getSnapshot().chapter).toBe('done'),
    );
    expect(document.activeElement).toBe(document.body);
  });
});

describe('downgrade safety (review MEDIUM-4)', () => {
  test('a chapter written by a newer Station repairs instead of sticking', () => {
    // `firstRunProgress` is a composite device setting persisted verbatim, so
    // this survives a downgrade byte-for-byte, and `resolveResumePoint`'s
    // documented restart fallback is inert unless something reads its chapter.
    firstRunStore.enterChapter('from-a-newer-station' as never);
    render(<FirstRunFlow />);
    expect(firstRunStore.getSnapshot().chapter).toBe('connect');
  });

  test('the repaired run can still be asked for', async () => {
    firstRunStore.enterChapter('from-a-newer-station' as never);
    render(<FirstRunFlow />);
    act(() => requestFirstRunTour());
    await waitFor(() =>
      expect(screen.getByTestId('first-run-coachmark')).toBeTruthy(),
    );
  });
});

describe('re-entry (review L1, L3)', () => {
  test('"Take the tour" opens the tour, not a chapter it was left on', async () => {
    firstRunStore.enterChapter('about-you');
    render(<FirstRunFlow />);
    act(() => requestFirstRunTour());

    await waitFor(() =>
      expect(screen.getByTestId('first-run-coachmark')).toBeTruthy(),
    );
    expect(firstRunStore.getSnapshot().chapter).toBe('tour');
  });

  test('re-entry navigates again instead of stranding an unanchored card', async () => {
    render(<FirstRunFlow />);

    act(() => requestFirstRunTour());
    await waitFor(() => expect(navigate).toHaveBeenCalled());
    const firstPath = tourStepPath(FIRST_RUN_TOUR_STEPS[0]);
    expect(navigate).toHaveBeenLastCalledWith(firstPath);

    fireEvent.click(screen.getByRole('button', { name: 'Skip the tour' }));
    navigate.mockClear();

    // Without clearing the "already navigated" latch, this second run would
    // render its coachmark on whatever page the user happened to be on.
    act(() => requestFirstRunTour());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(firstPath));
  });
});
