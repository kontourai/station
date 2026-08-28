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
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Coachmark, type CoachmarkProps } from '../Coachmark';
import { FIRST_RUN_ANCHOR_ATTRIBUTE } from '../tour-steps';

function renderCoachmark(overrides: Partial<CoachmarkProps> = {}) {
  const props: CoachmarkProps = {
    anchor: 'schedule',
    title: 'Unattended work is held to the same standard',
    body: 'A scheduled job produces the same evidence as work you start yourself.',
    stepNumber: 2,
    stepCount: 4,
    onNext: vi.fn(),
    onBack: vi.fn(),
    onSkip: vi.fn(),
    isLastStep: false,
    ...overrides,
  };
  return { props, ...render(<Coachmark {...props} />) };
}

function mountAnchor(name: string) {
  const element = document.createElement('div');
  element.setAttribute(FIRST_RUN_ANCHOR_ATTRIBUTE, name);
  element.getBoundingClientRect = () =>
    ({
      left: 100,
      top: 100,
      width: 200,
      height: 40,
      bottom: 140,
      right: 300,
    }) as DOMRect;
  document.body.appendChild(element);
  return element;
}

afterEach(() => {
 // Unmount through first; wiping innerHTML underneath it makes its own
// cleanup throw on a container it no longer owns.
  cleanup();
  for (const stale of document.querySelectorAll(
    `[${FIRST_RUN_ANCHOR_ATTRIBUTE}]`,
  )) {
    stale.remove();
  }
  document.documentElement.style.removeProperty('--dock-slot-size');
  document.documentElement.style.removeProperty(
    '--visual-viewport-bottom-inset',
  );
});

describe('Coachmark accessibility', () => {
  test('announces itself as a dialog labelled by its title and body', () => {
    mountAnchor('schedule');
    renderCoachmark();
    const dialog = screen.getByRole('dialog');
// Not modal: the coachmark annotates the surface behind it, which must
// stay visible and reachable — sealing off the page during a tour ABOUT
// the page is self-defeating.
    expect(dialog.getAttribute('aria-modal')).toBe('false');
// Resolve the ARIA relationships by hand — the accessible name and
// description must come from the step's own title and body, not from a
// generic "Tour" label that tells a screen-reader user nothing.
    const labelledBy = dialog.getAttribute('aria-labelledby');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(document.getElementById(labelledBy!)?.textContent).toBe(
      'Unattended work is held to the same standard',
    );
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      'A scheduled job produces the same evidence as work you start yourself.',
    );
  });

  test('moves focus into the card so the step is announced before its controls', () => {
    mountAnchor('schedule');
    renderCoachmark();
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  test('Escape ends the tour', () => {
    mountAnchor('schedule');
    const { props } = renderCoachmark();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(props.onSkip).toHaveBeenCalledTimes(1);
  });

  test('Tab wraps inside the card instead of dropping the user into the page', () => {
    mountAnchor('schedule');
    renderCoachmark();
    const dialog = screen.getByRole('dialog');
    const buttons = screen.getAllByRole('button');
    const last = buttons[buttons.length - 1];

    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(buttons[0]);

    buttons[0].focus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});

describe('Coachmark anchoring', () => {
  test('anchors to a real element carrying the first-run anchor attribute', () => {
    mountAnchor('schedule');
    renderCoachmark();
    expect(
      screen.getByTestId('first-run-coachmark').getAttribute('data-anchored'),
    ).toBe('true');
  });

  test('falls back to an unanchored card rather than pointing at nothing', () => {
// No anchor element in the document at all.
    renderCoachmark({ anchor: 'a-surface-that-is-not-mounted' });
    const card = screen.getByTestId('first-run-coachmark');
    expect(card.getAttribute('data-anchored')).toBe('false');
    expect(card.className).toContain('first-run-coachmark--unanchored');
  });

  test('waits for an anchor that only appears after the step navigates', async () => {
// The real failure this covers: a step mounts its coachmark and navigates
// in the same commit, so the anchor is NEVER present on the first
// measurement. Two fixed retries (60ms/300ms) looked fine in tests that
// mount the anchor first, and on a real machine gave up before the
// review-queue route had painted — the card silently fell back to
// unanchored while its anchor sat in the DOM.
    renderCoachmark();
    expect(
      screen.getByTestId('first-run-coachmark').getAttribute('data-anchored'),
    ).toBe('false');

// Well past the old 300ms window.
    await new Promise((resolve) => setTimeout(resolve, 400));
    mountAnchor('schedule');

    await waitFor(() =>
      expect(
        screen.getByTestId('first-run-coachmark').getAttribute('data-anchored'),
      ).toBe('true'),
    );
  });

  test('treats a zero-area anchor as absent', () => {
    const element = document.createElement('div');
    element.setAttribute(FIRST_RUN_ANCHOR_ATTRIBUTE, 'schedule');
    element.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        bottom: 0,
        right: 0,
      }) as DOMRect;
    document.body.appendChild(element);
    renderCoachmark();
    expect(
      screen.getByTestId('first-run-coachmark').getAttribute('data-anchored'),
    ).toBe('false');
  });

  test('keeps the card inside the viewport when its anchor fills the page', () => {
    Object.defineProperty(window, 'innerHeight', {
      configurable: true,
      value: 720,
    });
    document.documentElement.style.setProperty('--dock-slot-size', '40px');
    document.documentElement.style.setProperty(
      '--visual-viewport-bottom-inset',
      '300px',
    );
    const element = document.createElement('div');
    element.setAttribute(FIRST_RUN_ANCHOR_ATTRIBUTE, 'schedule');
    element.getBoundingClientRect = () =>
      ({
        left: 240,
        top: 0,
        width: 1040,
        height: 684,
        bottom: 684,
        right: 1280,
      }) as DOMRect;
    document.body.appendChild(element);

    renderCoachmark();

    const card = screen.getByTestId('first-run-coachmark');
    expect(card.className).toContain('first-run-coachmark--below');
    expect(Number.parseFloat(card.style.top)).toBeLessThanOrEqual(64);
  });
});

describe('Coachmark controls', () => {
  test('shows Back only after the first step', () => {
    mountAnchor('schedule');
    renderCoachmark({ stepNumber: 1 });
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  });

  test('offers Done instead of Next on the last step', () => {
    mountAnchor('schedule');
    renderCoachmark({ stepNumber: 4, isLastStep: true });
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
  });

  test('reports its position in the tour', () => {
    mountAnchor('schedule');
    renderCoachmark();
    expect(screen.getByText('Step 2 of 4')).toBeTruthy();
  });
});
