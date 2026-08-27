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
  const onSave = vi.fn();
  const onSkip = vi.fn();
  render(<AboutYouStep onSave={onSave} onSkip={onSkip} {...overrides} />);
  return { onSave, onSkip };
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

  test('Save is unavailable until something is actually answered', () => {
    renderStep();
    const save = screen.getByRole('button', { name: 'Save and finish' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
  });

  test('skipping persists no profile at all — not an empty or default one', () => {
    const { onSave, onSkip } = renderStep();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(onSkip).toHaveBeenCalledTimes(1);
    // The whole honesty property: a skip must reach the server as ABSENT.
    // Persisting `{}` here would still be absent-equivalent today, but
    // persisting a default role would be a fabricated observation, and this
    // asserts the save path was not taken at all.
    expect(onSave).not.toHaveBeenCalled();
  });

  test('a programmatic click cannot save an unanswered profile', () => {
    const { onSave } = renderStep();
    const save = screen.getByRole('button', { name: 'Save and finish' });
    // Bypass the disabled attribute the way a stray script or a test-id-driven
    // automation would.
    save.removeAttribute('disabled');
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
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

  test('saves only the questions that were answered', () => {
    const { onSave } = renderStep();
    fireEvent.click(screen.getByRole('radio', { name: 'Researcher' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save and finish' }));
    expect(onSave).toHaveBeenCalledWith({ role: 'researcher' });
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
