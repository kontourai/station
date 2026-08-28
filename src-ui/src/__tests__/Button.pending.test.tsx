/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import type React from 'react';
import { describe, expect, test, vi } from 'vitest';
import { Button } from '../components/Button';

describe('Button pending state (SHELL-01 / SHELL-12 / SHELL-16)', () => {
  test('a pending button REFUSES a second click, it does not merely look busy', () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" pending onClick={onClick}>
        Create
      </Button>,
    );

    const button = screen.getByRole('button');
    fireEvent.click(button);

// The whole point of the audit finding: Create fired with no
// acknowledgement for 6-8 seconds, which is what invited the
// double-submit that rendered as an error.
    expect(onClick).not.toHaveBeenCalled();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  test('pending renders a spinner and can swap the label', () => {
    const { container } = render(
      <Button variant="primary" pending pendingLabel="Creating…">
        Create
      </Button>,
    );

    expect(container.querySelector('.button__spinner')).toBeTruthy();
    expect(screen.getByRole('button').textContent).toContain('Creating…');
    expect(screen.getByRole('button').textContent).not.toContain('Create ');
  });

  test('a settled button is clickable and carries no busy marks', () => {
    const onClick = vi.fn();
    const { container } = render(
      <Button variant="primary" onClick={onClick}>
        Create
      </Button>,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(container.querySelector('.button__spinner')).toBeNull();
    expect(screen.getByRole('button').getAttribute('aria-busy')).toBeNull();
  });

 // Review of named two behaviours that were argued in the source
// ("a disabled submit button should not be the form's implicit Enter
// submitter", "the same DOM button survives the spinner/label swap") and
// asserted nowhere. Both are the difference between a pending state and a
// pending-looking one.
  test('Enter in a form field does not submit while the primary is pending', () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    function PendingForm({ pending }: { pending: boolean }) {
      return (
        <form onSubmit={onSubmit}>
          <input aria-label="Name" />
          <Button type="submit" variant="primary" pending={pending}>
            Create
          </Button>
        </form>
      );
    }

    const { rerender } = render(<PendingForm pending />);
    const field = screen.getByLabelText('Name');
    fireEvent.keyDown(field, { key: 'Enter', code: 'Enter' });
    fireEvent.submit(field.closest('form') as HTMLFormElement, {});

// jsdom does not implement implicit submission, so the meaningful
// assertion is the mechanism that governs it in a real browser: the only
// submit button is `disabled`, and a disabled control is never the form's
// default submitter.
    const submit = screen.getByRole('button') as HTMLButtonElement;
    expect(submit.type).toBe('submit');
    expect(submit.disabled).toBe(true);

// And once it settles, it is a live submitter again.
    rerender(<PendingForm pending={false} />);
    const settled = screen.getByRole('button') as HTMLButtonElement;
    expect(settled.type).toBe('submit');
    expect(settled.disabled).toBe(false);
  });

  test('the pending swap keeps the SAME DOM node, so focus is not thrown away', () => {
    function Toggle({ pending }: { pending: boolean }) {
      return (
        <Button variant="primary" pending={pending} pendingLabel="Creating…">
          Create
        </Button>
      );
    }

    const { rerender } = render(<Toggle pending={false} />);
    const before = screen.getByRole('button');
    before.focus();
    expect(document.activeElement).toBe(before);

    rerender(<Toggle pending />);
    const after = screen.getByRole('button');

// A remounted button would leave <body> focused — the archive#1126
// outcome. Identity, not a re-query, is the fact being pinned.
    expect(after).toBe(before);
    expect(after.textContent).toContain('Creating…');
    expect(document.activeElement).toBe(after);
  });

  test('an explicitly disabled button stays disabled without a spinner', () => {
 // measured a disabled `Save Changes` painted as a full-strength
// primary — `opacity: 1`, `cursor: pointer`, no tooltip. `disabled` must
// reach the DOM so `.button:disabled`'s treatment applies; it is not a
// pending state and must not grow a spinner.
    const { container } = render(
      <Button variant="primary" disabled>
        Save Changes
      </Button>,
    );

    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(container.querySelector('.button__spinner')).toBeNull();
  });
});
