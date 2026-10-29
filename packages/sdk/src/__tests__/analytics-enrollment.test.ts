import { afterEach, expect, test, vi } from 'vitest';
import {
  type AnalyticsReview,
  analyticsReviewUrl,
  fetchAnalyticsReview,
  parseAnalyticsTransfer,
  performAnalyticsSetup,
} from '../client/analytics-enrollment';
import {
  StationRequestAuthorityError,
  setClientCredentialResolver,
} from '../client/http';

const scope = {
  apiBase: 'https://station.example.test',
  authorityKey: 'source-person',
};
const id = '11234567-89ab-4cde-8fab-0123456789ab';
const review: AnalyticsReview = {
  kind: 'source',
  subject: id,
  id,
  status: 'pending',
  reviewUrl: `https://station.example.test:444/consent/${id}?scope=analytics:fixture`,
};
afterEach(() => {
  setClientCredentialResolver(undefined);
  vi.unstubAllGlobals();
});
test('requester review is a separate same-host same-scheme exact transaction, never arbitrary navigation', () => {
  expect(analyticsReviewUrl(scope, review)).toBe(review.reviewUrl);
  expect(
    analyticsReviewUrl(
      { ...scope, apiBase: 'http://station.example.test' },
      review,
    ),
  ).toBe(review.reviewUrl);
  for (const url of [
    `https://station.example.test/consent/${id}`,
    `https://evil.example/consent/${id}`,
    `http://station.example.test:444/consent/${id}`,
    `https://user:secret@station.example.test:444/consent/${id}`,
    `https://station.example.test:444/consent/21234567-89ab-4cde-8fab-0123456789ab`,
  ])
    expect(() =>
      analyticsReviewUrl(scope, { ...review, reviewUrl: url }),
    ).toThrow('review address');
});
test('invalid or plaintext credential packets are rejected before transport, and transfer bytes are bounded', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  await expect(
    performAnalyticsSetup(scope, {
      kind: 'store-delivery',
      delivery: { credential: 'stax_plaintext' },
    }),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  expect(() => parseAnalyticsTransfer('x'.repeat(24577))).toThrow('size limit');
  expect(() => parseAnalyticsTransfer('stax_plaintext')).toThrow();
});
test('address review sends only an empty intent, and status stays server-owned under captured authority', async () => {
  let live = true;
  setClientCredentialResolver(() => ({
    origin: scope.apiBase,
    requestAuthority: { ...scope, isCurrent: () => live },
  }));
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  fetch.mockImplementation(async (url, init) => {
    if (init?.method === 'POST') {
      expect(JSON.parse(String(init.body))).toEqual({});
      return Response.json({
        approval: {
          id,
          status: 'pending',
          reviewUrl: `https://station.example.test:444/consent/${id}`,
        },
      });
    }
    expect(String(url)).toContain(`/source-confirmation/requests/${id}`);
    return Response.json({ approval: { id, status: 'denied' } });
  });
  const started = await performAnalyticsSetup(scope, {
    kind: 'address-review',
    recipientId: id,
  });
  expect(started.review).toMatchObject({
    kind: 'address',
    subject: id,
    status: 'pending',
  });
  expect((await fetchAnalyticsReview(scope, started.review!)).status).toBe(
    'denied',
  );
  live = false;
  await expect(
    fetchAnalyticsReview(scope, started.review!),
  ).rejects.toBeInstanceOf(StationRequestAuthorityError);
});
