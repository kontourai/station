/**
 * @vitest-environment jsdom
 *
* archive#4463: `Empty` is the canonical empty-state primitive every
 * split-pane detail pane and hand-rolled "Nothing selected" box is being
 * migrated onto. This pins the behavioral contract Station's consumers rely
 * on — icon/title/description/action slots, and the two a11y properties the
 * design brief calls out: the box is not a focus trap, and its title is not
 * announced through a live region (a static message, not an interruption).
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { Empty } from '../Empty';

describe('Empty', () => {
  test('renders the icon, title, description and action slots', () => {
    const onAction = vi.fn();
    render(
      <Empty
        variant="prominent"
        icon={<span data-testid="empty-icon">*</span>}
        label="Nothing here yet"
        description="Add one to get started."
        action={
          <button type="button" onClick={onAction}>
            Add item
          </button>
        }
      />,
    );

    expect(screen.getByTestId('empty-icon')).toBeTruthy();
    expect(screen.getByText('Nothing here yet')).toBeTruthy();
    expect(screen.getByText('Add one to get started.')).toBeTruthy();
    const action = screen.getByRole('button', { name: 'Add item' });
    fireEvent.click(action);
    expect(onAction).toHaveBeenCalledOnce();
  });

  test('renders with only the required label when no other slot is supplied', () => {
    render(<Empty label="Nothing selected" />);

    expect(screen.getByText('Nothing selected')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  test('the title sits in a static region, not a live one — no aria-live anywhere in the box', () => {
    const { container } = render(
      <Empty
        variant="prominent"
        label="Nothing selected"
        description="Select an item from the list."
      />,
    );

// A screen-reader interruption on every render of an empty state would be
// exactly the "second message" the double-empty rule exists to prevent —
// this asserts the primitive never grows one, in either direction.
    expect(container.querySelector('[aria-live]')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  test('is not a focus trap: its action does not intercept or cancel Tab', () => {
    const onAction = vi.fn();
    render(
      <div>
        <button type="button">before</button>
        <Empty
          variant="prominent"
          label="Nothing selected"
          action={
            <button type="button" onClick={onAction}>
              Add item
            </button>
          }
        />
        <button type="button">after</button>
      </div>,
    );

    const action = screen.getByRole('button', { name: 'Add item' });
    action.focus();
    expect(document.activeElement).toBe(action);

// Nothing in Empty owns a keydown/keyup handler, so natural Tab
// traversal is never preventDefault'd — a real trap would report
// defaultPrevented: true here.
    const forward = fireEvent.keyDown(action, { key: 'Tab' });
    expect(forward).toBe(true);
    const backward = fireEvent.keyDown(action, { key: 'Tab', shiftKey: true });
    expect(backward).toBe(true);

// No element in the box is given a tabIndex that would pull focus back
// onto itself or skip it entirely.
    expect(action.getAttribute('tabindex')).toBeNull();
  });
});
