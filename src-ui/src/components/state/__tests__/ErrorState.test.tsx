/**
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import { WarningGlyph } from '../../icons/Glyph';
import { ErrorState } from '../ErrorState';

describe('ErrorState', () => {
  test('renders label, description and action', () => {
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

  test('defaults to the prominent variant and renders an aria-hidden icon', () => {
    const { container } = render(<ErrorState title="Failed to load" />);

    const icon = container.querySelector('.error-state__icon');
    expect(icon).toBeTruthy();
    expect(icon?.getAttribute('aria-hidden')).toBe('true');
  });

  test('renders without a description or action', () => {
    render(<ErrorState title="Not found" />);
    expect(screen.getByText('Not found')).toBeTruthy();
  });

  test('carries role="alert" so error surfaces are announced (repo-wide convention)', () => {
    render(<ErrorState title="Something went wrong" />);
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});

/**
 * The SDK's published `ErrorState` inlines the warning glyph rather than
 * importing the shell's icon set, and its docblock claims the two stay
 * identical. Nothing derived that claim: the SDK's own test hardcodes the
 * path string, and this file asserted only the icon's CLASS. `WarningGlyph`
 * has nine other live consumers, so editing it moved nine surfaces while
 * `ErrorState` silently did not — with both tests still green.
 *
 * This is the derivation behind the claim. It is in the SHELL's home on
 * purpose: this is the side that owns `WarningGlyph`, so a change to it
 * reddens here, next to the component that must follow.
 */
describe('ErrorState glyph parity', () => {
  test('renders byte-identical path data to the shell WarningGlyph', () => {
    const { container: errorStateTree } = render(
      <ErrorState title="Something went wrong" />,
    );
    const { container: glyphTree } = render(<WarningGlyph />);

    const pathOf = (root: HTMLElement) =>
      Array.from(root.querySelectorAll('path'))
        .map((node) => node.getAttribute('d'))
        .filter(Boolean);

    const errorStatePaths = pathOf(errorStateTree);
    expect(errorStatePaths.length).toBeGreaterThan(0);
    expect(errorStatePaths).toEqual(pathOf(glyphTree));
  });
});
