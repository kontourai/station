/**
 * @vitest-environment jsdom
 */

import { buildUserProfileContextBlock } from '@kontourai/station-contracts/user-profile';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { AboutYouStep } from '../AboutYouStep';

afterEach(cleanup);

function renderStep(
  overrides: Partial<Parameters<typeof AboutYouStep>[0]> = {},
) {
  const onComplete = vi.fn();
  render(<AboutYouStep onComplete={onComplete} {...overrides} />);
  return { onComplete };
}

describe('AboutYouStep — nothing is assumed', () => {
  test('opens with no answer preselected', () => {
    renderStep();
    for (const radio of screen.getAllByRole('radio')) {
      expect((radio as HTMLInputElement).checked).toBe(false);
    }
    // And it says so, rather than leaving the user to infer it.
    expect(screen.getByTestId('first-run-profile-preview-empty')).toBeTruthy();
  });

  test.each([
    ['Start your first chat', 'chat'],
    ['Take the tour', 'tour'],
  ] as const)('%s leaves unanswered questions absent', (label, destination) => {
    const { onComplete } = renderStep();
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(onComplete).toHaveBeenCalledWith(undefined, destination);
  });

  test('both exits are disabled while answers are saving', () => {
    const { onComplete } = renderStep({ saving: true });
    for (const button of screen.getAllByRole('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(onComplete).not.toHaveBeenCalled();
  });
});

describe('AboutYouStep — the preview is the payload', () => {
  test('shows the exact block the server will inject', () => {
    renderStep();
    fireEvent.click(screen.getByRole('radio', { name: 'Engineer' }));
    expect(screen.getByTestId('first-run-profile-preview').textContent).toBe(
      buildUserProfileContextBlock({ role: 'engineer' }),
    );
  });

  test('grows the preview as the second question is answered', () => {
    renderStep();
    fireEvent.click(screen.getByRole('radio', { name: 'Engineer' }));
    fireEvent.click(screen.getByRole('radio', { name: 'I build them' }));
    expect(screen.getByTestId('first-run-profile-preview').textContent).toBe(
      buildUserProfileContextBlock({ role: 'engineer', comfort: 'expert' }),
    );
  });

  test.each([
    ['Start your first chat', 'chat'],
    ['Take the tour', 'tour'],
  ] as const)('%s saves only answered questions', (label, destination) => {
    const { onComplete } = renderStep();
    fireEvent.click(screen.getByRole('radio', { name: 'Researcher' }));
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(onComplete).toHaveBeenCalledWith(
      { role: 'researcher' },
      destination,
    );
  });

  test('restores previously persisted answers when revisited', () => {
    renderStep({ initial: { role: 'manager', comfort: 'comfortable' } });
    expect(
      (
        screen.getByRole('radio', {
          name: 'Manager or lead',
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      (
        screen.getByRole('radio', {
          name: 'Comfortable with them',
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });
});

describe('AboutYouStep — the reach is stated', () => {
  test('says external engines are unaffected instead of implying universality', () => {
    renderStep();
    // A user who has bound their agent to Claude Code must not be left to
    // discover that this setting does nothing there.
    expect(
      screen.getByText(/External engines .* build their own context/i),
    ).toBeTruthy();
  });
});
