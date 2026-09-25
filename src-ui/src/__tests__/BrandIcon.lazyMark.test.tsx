/**
 * @vitest-environment jsdom
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

// The inline brand marks are their own chunk (epic #61). A chunk that fails to
// load — a stale tab after an upgrade — must cost only the mark, never the
// surface around the icon, and a later mount must be able to load it.
const chunk = vi.hoisted(() => ({ fail: true }));

vi.mock('../components/icons/BrandMarks', async (importOriginal) => {
  if (chunk.fail)
    throw new Error('Failed to fetch dynamically imported module');
  return importOriginal();
});

import { BrandIcon } from '../components/icons/BrandIcon';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BrandIcon when the brand-mark chunk fails to load', () => {
  test('keeps the tile and its surroundings, then loads the mark on a later mount', async () => {
    chunk.fail = true;
    // React reports the caught error; it is expected here.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const first = render(
      <section>
        <BrandIcon name="Codex" engineId="codex" />
        <p>sibling content</p>
      </section>,
    );

    // Let the rejected import settle and React commit whatever handles it.
    await act(async () => {
      await import('../components/icons/BrandMarks').catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByText('sibling content')).toBeTruthy();
    expect(
      first.container.querySelector('[data-brand-key="codex"]'),
    ).not.toBeNull();
    expect(first.container.querySelector('svg')).toBeNull();
    first.unmount();

    chunk.fail = false;
    const second = render(<BrandIcon name="Codex" engineId="codex" />);
    await waitFor(() =>
      expect(
        second.container
          .querySelector('[data-brand-key="codex"] svg')
          ?.getAttribute('viewBox'),
      ).toBe('0 0 256 260'),
    );
  });
});
