/** @vitest-environment jsdom */

import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

/**
 * archive#3677, 1. The hook must require BOTH the host
 * capability and the server's eligibility answer. Selecting the native path
 * from the capability alone dead-ended every caller whose credential is not
 * local-grant minted — a paired phone, or a desktop app pointed at a remote
 * Station — because the routes 403 and the click had already left the web
 * path behind.
 */

const adapter = vi.hoisted(() => ({
  capabilityState: 'enabled' as string,
  reviewConsentNatively: vi.fn(async (_requestId: string) => ({
    status: 'ok',
    value: { status: 'approved' },
  })),
}));

vi.mock('../index', () => ({
  nativePlatformPromise: Promise.resolve({
    capability: () => ({ state: adapter.capabilityState, reason: 'test' }),
    reviewConsentNatively: (id: string) => adapter.reviewConsentNatively(id),
  }),
}));

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@kontourai/station-sdk', () => ({
  authenticatedFetch: (...args: unknown[]) => fetchMock(...args),
}));

const connection = vi.hoisted(() => ({ apiBase: 'http://localhost:3141' }));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useApiBase: () => ({ apiBase: connection.apiBase }),
}));

import { useNativeConsentBroker } from '../useNativeConsentBroker';

function eligibilityResponse(eligible: boolean, ok = true): Response {
  return { ok, json: async () => ({ eligible }) } as unknown as Response;
}

beforeEach(() => {
  connection.apiBase = 'http://localhost:3141';
  adapter.capabilityState = 'enabled';
  fetchMock.mockReset();
  adapter.reviewConsentNatively.mockClear();
});

test('capability enabled AND server-eligible: the native reviewer is exposed', async () => {
  fetchMock.mockResolvedValue(eligibilityResponse(true));
  const { result } = renderHook(() => useNativeConsentBroker());

  await waitFor(() => expect(result.current).not.toBeNull());
  expect(fetchMock).toHaveBeenCalledWith(
    'http://localhost:3141/api/consent/native-eligibility',
  );
  await result.current?.('txn-1');
  expect(adapter.reviewConsentNatively).toHaveBeenCalledWith('txn-1');
});

test('capability enabled but server says NOT eligible: stays on the consent page', async () => {
  fetchMock.mockResolvedValue(eligibilityResponse(false));
  const { result } = renderHook(() => useNativeConsentBroker());

// Let the adapter + eligibility promises settle before asserting absence,
// or this test would pass on timing rather than on the decision.
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  await waitFor(() => expect(result.current).toBeNull());
});

test('capability disabled: no eligibility call is made at all', async () => {
  adapter.capabilityState = 'disabled';
  fetchMock.mockResolvedValue(eligibilityResponse(true));
  const { result } = renderHook(() => useNativeConsentBroker());

  await waitFor(() => expect(result.current).toBeNull());
  expect(fetchMock).not.toHaveBeenCalled();
});

test('an unreachable or refused eligibility read resolves toward the consent page', async () => {
  for (const outcome of [
    () => Promise.reject(new Error('offline')),
    () => Promise.resolve(eligibilityResponse(true, false)),
    () => Promise.resolve({ ok: true, json: async () => ({}) } as Response),
  ]) {
    fetchMock.mockReset();
    fetchMock.mockImplementation(outcome);
    const { result } = renderHook(() => useNativeConsentBroker());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(result.current).toBeNull());
  }
});

test('switching connections drops the previous authority before the new answer arrives', async () => {
  fetchMock.mockResolvedValue(eligibilityResponse(true));
  const { result, rerender } = renderHook(() => useNativeConsentBroker());
  await waitFor(() => expect(result.current).not.toBeNull());

// A Station that refuses. The old reviewer must not survive the switch —
// it would invoke native review with the NEW connection's credential,
 // which enforcement refuses with no fallback ( 2).
  let releaseSecond: (value: Response) => void = () => {};
  fetchMock.mockReset();
  fetchMock.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        releaseSecond = resolve;
      }),
  );
  connection.apiBase = 'http://remote.station:3141';
  rerender();

// Cleared while the new answer is still in flight, not after it lands.
  await waitFor(() => expect(result.current).toBeNull());
  expect(fetchMock).toHaveBeenCalledWith(
    'http://remote.station:3141/api/consent/native-eligibility',
  );

  releaseSecond(eligibilityResponse(false));
  await waitFor(() => expect(result.current).toBeNull());
});

// Coverage note, recorded after a SURVIVED: replacing the
// `: null` arm with an early return leaves every test green, because the
// clear at the top of the effect already dropped the reviewer before the
// read began. The two spellings are equivalent given that clear, so this is
// redundancy rather than an uncovered branch — the leading clear is what
// carries the behaviour, and injection C proves that. What genuinely is not
// covered: a credential that changes WITHOUT `apiBase` changing (a local
// re-provision on the same origin) does not re-run this effect in either
// spelling. Its failure direction is a stale eligible reviewer whose decide
// the server then refuses — an error the user sees, never a silent grant.
test('a connection that becomes ineligible clears an already-exposed reviewer', async () => {
  fetchMock.mockResolvedValue(eligibilityResponse(true));
  const { result, rerender } = renderHook(() => useNativeConsentBroker());
  await waitFor(() => expect(result.current).not.toBeNull());

  fetchMock.mockReset();
  fetchMock.mockResolvedValue(eligibilityResponse(false));
  connection.apiBase = 'http://other.station:3141';
  rerender();

  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  await waitFor(() => expect(result.current).toBeNull());
});
