/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

const h = vi.hoisted(() => ({ mutate: vi.fn(), windowOpen: vi.fn() }));
vi.mock('@kontourai/station-sdk/private-insights-query', () => ({
  useAnalyticsSetupMutation: () => ({
    mutateAsync: h.mutate,
    isPending: false,
  }),
  useAnalyticsReceiverInfo: () => ({
    data: { stationId: 'receiver', origin: 'https://receiver.example.test' },
  }),
  useAnalyticsSourceOffers: () => ({ data: [] }),
  useAnalyticsReceivingProof: () => ({ data: undefined, error: null }),
  useAnalyticsSetupReview: () => ({ data: undefined, error: null }),
  parseAnalyticsTransfer: JSON.parse,
  analyticsReviewUrl: (_scope: unknown, v: { reviewUrl: string }) =>
    v.reviewUrl,
}));

import { AnalyticsSourceSetup } from './AnalyticsSourceSetup';

const scope = {
  apiBase: 'https://source.example.test',
  authorityKey: 'person',
  isCurrent: () => true,
};
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  h.mutate.mockReset();
});
test('a blocked requester window does not create consent or substitute a native/operator decision', async () => {
  vi.spyOn(window, 'open').mockReturnValue(null);
  render(<AnalyticsSourceSetup scope={scope} sources={[]} />);
  fireEvent.click(screen.getByText('Connect or manage private sources'));
  fireEvent.click(screen.getByRole('button', { name: 'Share this Station' }));
  fireEvent.change(screen.getByLabelText('Public receiving-key proof'), {
    target: { value: '{}' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Review source permission' }),
  );
  expect(h.mutate).not.toHaveBeenCalled();
  expect(screen.getByText(/could not open the trusted requester/)).toBeTruthy();
});
test('source review opens a detached trusted page and never renders an approve decision in the main UI', async () => {
  const replace = vi.fn(),
    close = vi.fn();
  let opener: Window | null = window;
  const location = { ...window.location, replace };
  const popup = new Proxy(window, {
    get: (target, key) =>
      key === 'location'
        ? location
        : key === 'close'
          ? close
          : key === 'opener'
            ? opener
            : Reflect.get(target, key),
    set: (target, key, value) => {
      if (key === 'opener' && value === null) {
        opener = null;
        return true;
      }
      return Reflect.set(target, key, value);
    },
  });
  vi.spyOn(window, 'open').mockReturnValue(popup);
  const id = '11234567-89ab-4cde-8fab-0123456789ab';
  h.mutate.mockResolvedValue({
    review: {
      kind: 'source',
      subject: id,
      id,
      status: 'pending',
      reviewUrl: `https://source.example.test:444/consent/${id}`,
    },
  });
  render(<AnalyticsSourceSetup scope={scope} sources={[]} />);
  fireEvent.click(screen.getByText('Connect or manage private sources'));
  fireEvent.click(screen.getByRole('button', { name: 'Share this Station' }));
  fireEvent.change(screen.getByLabelText('Public receiving-key proof'), {
    target: { value: '{"claims":{}}' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Review source permission' }),
  );
  await waitFor(() =>
    expect(replace).toHaveBeenCalledWith(
      `https://source.example.test:444/consent/${id}`,
    ),
  );
  expect(popup.opener).toBeNull();
  expect(h.mutate).toHaveBeenCalledWith({
    kind: 'source-review',
    proof: { claims: {} },
  });
  expect(
    screen.queryByRole('button', { name: 'Approve this source and key' }),
  ).toBeNull();
  expect(close).not.toHaveBeenCalled();
});
