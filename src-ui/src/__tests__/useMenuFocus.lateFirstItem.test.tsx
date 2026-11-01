/**
 * @vitest-environment jsdom
 *
 * #4406: the user-message ⋯ menu opened with focus on its SECOND item. Its
 * first row ("Add to Task") loads lazily, so focus entry found only the row
 * below it, and the late row then rendered above the focused one. Until the
 * reader moves, focus entry follows the menu's first item.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { useMenuFocus } from '../hooks/useMenuFocus';

afterEach(cleanup);

let showLateRow: (() => void) | null = null;

function Menu() {
  const [late, setLate] = useState(false);
  showLateRow = () => setLate(true);
  const ref = useMenuFocus<HTMLDivElement>(true, () => undefined);
  return (
    <div ref={ref} role="menu" tabIndex={-1} aria-label="Message actions">
      {late && (
        <button type="button" role="menuitem">
          Add to Task
        </button>
      )}
      <button type="button" role="menuitem">
        New chat from this message
      </button>
    </div>
  );
}

describe('useMenuFocus with a first item that arrives late', () => {
  test('focus moves to the new first item while the reader has not moved', async () => {
    render(<Menu />);
    expect(document.activeElement).toBe(
      screen.getByRole('menuitem', { name: 'New chat from this message' }),
    );
    await act(async () => showLateRow?.());
    expect(document.activeElement).toBe(
      screen.getByRole('menuitem', { name: 'Add to Task' }),
    );
  });

  test("a reader's own key press is not overridden by a late row", async () => {
    render(<Menu />);
    const current = screen.getByRole('menuitem', {
      name: 'New chat from this message',
    });
    fireEvent.keyDown(current, { key: 'ArrowDown' });
    await act(async () => showLateRow?.());
    expect(document.activeElement).toBe(current);
  });
});
