/**
 * @vitest-environment jsdom
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { firstRunStore } from '../first-run-store';
import { FIRST_RUN_TOUR_STEPS } from '../tour-steps';
import { UnpairedSampleWorkspace } from '../UnpairedSampleWorkspace';

beforeEach(() => {
  firstRunStore.reset();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('UnpairedSampleWorkspace', () => {
  test('starts the receipts tour on a labeled sample card', async () => {
    render(<UnpairedSampleWorkspace onConnect={vi.fn()} />);

    expect(screen.getByTestId('unpaired-sample-workspace')).toBeTruthy();
    expect(
      screen.getByText(/Sample workspace for Getting started/),
    ).toBeTruthy();
    expect(
      screen.getByTestId(
        `unpaired-sample-surface-${FIRST_RUN_TOUR_STEPS[0].anchor}`,
      ),
    ).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('first-run-coachmark')).toBeTruthy();
    });
    expect(screen.getByText(FIRST_RUN_TOUR_STEPS[0].title)).toBeTruthy();
    expect(firstRunStore.getSnapshot()).toEqual({
      chapter: 'tour',
      tourStepId: FIRST_RUN_TOUR_STEPS[0].id,
    });
  });

  test('walks every tour step and keeps an anchor on the sample card', async () => {
    render(<UnpairedSampleWorkspace onConnect={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('first-run-coachmark')).toBeTruthy();
    });

    for (const [index, step] of FIRST_RUN_TOUR_STEPS.entries()) {
      expect(
        screen
          .getByTestId(`unpaired-sample-surface-${step.anchor}`)
          .getAttribute('data-first-run-anchor'),
      ).toBe(step.anchor);
      expect(screen.getByText(step.title)).toBeTruthy();
      if (index < FIRST_RUN_TOUR_STEPS.length - 1) {
        fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      }
    }
  });

  test('skip ends the tour without pairing and leaves connect available', async () => {
    const onConnect = vi.fn();
    render(<UnpairedSampleWorkspace onConnect={onConnect} />);
    await waitFor(() => {
      expect(screen.getByTestId('first-run-coachmark')).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Skip the tour' }));

    expect(screen.queryByTestId('first-run-coachmark')).toBeNull();
    expect(firstRunStore.getSnapshot().chapter).toBe('done');
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Connect your Station' })[0],
    );
    expect(onConnect).toHaveBeenCalledTimes(1);
  });
});
