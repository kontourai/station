/** @vitest-environment jsdom */

import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  query: {
    isLoading: false,
    error: null as Error | null,
    data: [] as Array<{
      id: string;
      label: string;
      description: string;
      enabled: boolean;
    }>,
    refetch: vi.fn(),
  },
  mutate: vi.fn(),
}));

vi.mock('@kontourai/station-sdk', () => ({
  useFeaturePreviewsQuery: () => state.query,
  useUpdateFeaturePreviewMutation: () => ({
    isPending: false,
    error: null,
    mutate: state.mutate,
  }),
}));

import { FeaturePreviewsSection } from '../FeaturePreviewsSection';

// station#3313: the standalone /feature-previews view retired into this
// Settings section; these are its behavior pins, carried over.
describe('FeaturePreviewsSection', () => {
  test('renders the canonical loading rows while preview truth is pending', () => {
    state.query.isLoading = true;
    render(<FeaturePreviewsSection />);
    expect(
      screen.getByRole('status', { name: 'Loading feature previews' }),
    ).toBeTruthy();
    state.query.isLoading = false;
  });

  test('keeps the experimental framing the standalone view carried', () => {
    render(<FeaturePreviewsSection />);
    expect(
      screen.getByText('Try features that are still being evaluated.'),
    ).toBeTruthy();
  });

  test('distinguishes an honest empty catalog from a failed catalog load', () => {
    const { container, rerender } = render(<FeaturePreviewsSection />);
    expect(screen.getByText('No previews are currently offered')).toBeTruthy();
    // `variant="prominent"`, as the standalone view rendered it — an empty
    // previews catalog is the whole section's state, not one row's.
    expect(
      container.querySelector('.empty--prominent'),
      'the empty catalog must keep the prominent Empty variant',
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Previews appear here only when this Station build can exercise them.',
      ),
    ).toBeTruthy();

    state.query.error = new Error('store unavailable');
    rerender(<FeaturePreviewsSection />);
    expect(screen.getByText('Could not load feature previews')).toBeTruthy();
    expect(
      screen.getByText(
        'Station could not determine which previews this instance currently offers.',
      ),
    ).toBeTruthy();
  });

  test('renders a server-backed toggle for a runtime-offered preview, inside the settings section shell', () => {
    state.query.error = null;
    state.query.data = [
      {
        id: 'fleet-consumer-probes',
        label: 'Fleet consumer probes',
        description: 'Consumes a real branch.',
        enabled: false,
      },
    ];
    const { container } = render(<FeaturePreviewsSection />);
    expect(
      screen.getByRole('switch', { name: 'Enable Fleet consumer probes' }),
    ).toBeTruthy();
    // Two different deep links, two different DOM ids. `?view=` resolves the
    // SECTION id through useSectionNavigation (`section-<view>`)…
    expect(container.querySelector('#section-feature-previews')).toBeTruthy();
    // …while `?highlight=` resolves the CATALOG id through
    // `document.getElementById` and gives up silently if it is absent, which
    // is what made this entry's highlight link go nowhere. It needs both the
    // id and the focusable tabIndex every PageRow-backed entry has.
    const catalogEntry = container.querySelector<HTMLElement>(
      '[data-catalog-id="feature-previews"]',
    );
    expect(catalogEntry).toBeTruthy();
    expect(catalogEntry!.id).toBe('feature-previews');
    expect(catalogEntry!.tabIndex).toBe(-1);
  });
});
