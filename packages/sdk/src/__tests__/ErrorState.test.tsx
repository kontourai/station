/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ErrorState } from '../components/ErrorState';

/**
 * Render pin for the published error primitive (station#4201 step 1).
 *
 * `ErrorState` moved here FROM `src-ui/src/components/state/ErrorState.tsx`,
 * which now re-exports it — the move must not change a byte of what any
 * consumer renders. The class names below are load-bearing twice over: the
 * shell's `ErrorState.css` targets `error-state__icon`, and downstream
 * styling/tests key on the `error-state` root. A rename here would restyle
 * every consumer silently, so this test pins the exact classes, the alert
 * role, and the warning glyph's path (the shell icon set's `WarningGlyph`,
 * inlined — see the component docblock).
 */
describe('ErrorState (published primitive)', () => {
  test('pins the rendered contract: root class, alert role, icon class, glyph', () => {
    const { container } = render(<ErrorState title="Failed to load" />);

    const root = container.querySelector('.error-state');
    expect(root).toBeTruthy();
    expect(root?.getAttribute('role')).toBe('alert');

    const icon = container.querySelector('.error-state__icon');
    expect(icon).toBeTruthy();
    expect(icon?.getAttribute('aria-hidden')).toBe('true');

    // The exact warning-triangle path the shell's icon set draws.
    expect(icon?.querySelector('svg path')?.getAttribute('d')).toBe(
      'M8 2 14 13H2L8 2Zm0 4v3.5m0 2h.01',
    );
  });

  test('renders label, description and a live action slot', () => {
    const onRetry = vi.fn();
    render(
      <ErrorState
        title="Something went wrong"
        description="Try again in a moment."
        action={
          <button type="button" onClick={onRetry}>
            Retry
          </button>
        }
      />,
    );

    expect(screen.getByText('Something went wrong')).toBeTruthy();
    expect(screen.getByText('Try again in a moment.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test('appends the caller className to the pinned root class', () => {
    const { container } = render(
      <ErrorState title="Not found" className="board-error" />,
    );
    expect(container.querySelector('.error-state.board-error')).toBeTruthy();
  });
});
