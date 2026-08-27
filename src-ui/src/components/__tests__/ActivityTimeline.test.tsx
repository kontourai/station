// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ActivityTimeline } from '../ActivityTimeline';

let queryData: unknown;
let isLoading = false;
let isError = false;
let error: unknown;
const refetch = vi.fn();

vi.mock('@kontourai/station-sdk', () => ({
  useActivityUsageQuery: () => ({
    data: queryData,
    isLoading,
    isError,
    error,
    refetch,
  }),
}));

/**
 * station#771 regression. `ActivityTimeline` used to destructure only
 * `{ data, isLoading }` and gate on `loading && !data` / `!data?.byDate` — a
 * settled error left both false, so the component returned `null`: no chart,
 * no message, no console trace.
 */
describe('ActivityTimeline (#771)', () => {
  beforeEach(() => {
    queryData = undefined;
    isLoading = false;
    isError = false;
    error = undefined;
    refetch.mockReset();
  });

  test('renders a skeleton while loading', () => {
    isLoading = true;
    const { container } = render(<ActivityTimeline />);
    expect(container.querySelector('.skeleton-block')).toBeTruthy();
  });

  test('renders an error state with retry instead of vanishing when the query fails', () => {
    isError = true;
    error = new Error('activity unavailable');

    render(<ActivityTimeline />);

    expect(screen.getByText('Could not load activity')).toBeTruthy();
    expect(screen.getByText('activity unavailable')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  test('renders nothing when the query settles with no data and no error (genuinely no activity yet)', () => {
    const { container } = render(<ActivityTimeline />);
    expect(container.firstChild).toBeNull();
  });
});
