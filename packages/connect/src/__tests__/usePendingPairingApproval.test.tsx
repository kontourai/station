// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearPendingExchange,
  type PendingPairingExchange,
  savePendingExchange,
} from '../core/devicePairing';
import { usePendingPairingApproval } from '../react/usePendingPairingApproval';

const ENDPOINT = 'https://station.example.test';

function pendingExchange(
  overrides: Partial<PendingPairingExchange> = {},
): PendingPairingExchange {
  return {
    endpoint: ENDPOINT,
    offerId: 'offer-1',
    proof: 'proof-1',
    requestId: 'request-1',
    requestedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    browserSession: false,
    requestKind: 'direct',
    ...overrides,
  };
}

/**
 * station#4512 review (M1/L1) — this hook had no dedicated test file: its
 * only coverage was indirect, through `ConnectionBannerSource`/`HeaderActions`
 * mocking it away entirely. That left both the expiry-fallback behavior and
 * the M2 fix (tick gated on an actual pending record, re-armed on a store
 * change) unpinned — a revert of either would have stayed green everywhere
 * else.
 */
describe('usePendingPairingApproval', () => {
  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('returns null and starts no interval when nothing is pending', () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const { result } = renderHook(() => usePendingPairingApproval(ENDPOINT));

    expect(result.current).toBeNull();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it('reads an existing pending record on mount and ticks its remaining time down', () => {
    vi.useFakeTimers();
    savePendingExchange(pendingExchange({ expiresAt: Date.now() + 5_000 }));
    const { result } = renderHook(() => usePendingPairingApproval(ENDPOINT));

    expect(result.current).not.toBeNull();
    const firstRemaining = result.current?.remainingMs ?? 0;

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(result.current?.remainingMs).toBeLessThan(firstRemaining);
  });

  // The expiry fallback the M1 gap named: a fake clock pushed past
  // `expiresAt` must clear the state, not keep reporting a stale record.
  it('clears once the fake clock passes expiresAt', () => {
    vi.useFakeTimers();
    savePendingExchange(pendingExchange({ expiresAt: Date.now() + 2_500 }));
    const { result } = renderHook(() => usePendingPairingApproval(ENDPOINT));
    expect(result.current).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(3_000);
    });

    expect(result.current).toBeNull();
  });

  // M2: the interval is gated on the record's existence, so it must stop
  // itself the moment a tick observes expiry — not keep ticking a `null`
  // state forever.
  it('stops its own interval once the record it was ticking for expires', () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');
    savePendingExchange(pendingExchange({ expiresAt: Date.now() + 2_500 }));
    renderHook(() => usePendingPairingApproval(ENDPOINT));

    act(() => {
      vi.advanceTimersByTime(3_000);
    });

    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  // M2's core claim: nothing pending means no 1Hz tick runs at all, even
  // while mounted for a while — the defect this replaces gated the interval
  // on the CALLER's `status === 'error'`, which ticked for the full length
  // of any outage, pending or not.
  it('never arms the interval for an unreachable host with nothing pending', () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    renderHook(() => usePendingPairingApproval(ENDPOINT));

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  // M2's re-arm claim: a same-tab write (the pairing flow, mounted
  // elsewhere in the same page) must be picked up without this hook's owner
  // remounting or the caller passing any new prop.
  it('re-arms on a same-tab store write', async () => {
    const { result } = renderHook(() => usePendingPairingApproval(ENDPOINT));
    expect(result.current).toBeNull();

    act(() => {
      savePendingExchange(pendingExchange());
    });

    await waitFor(() => expect(result.current).not.toBeNull());
  });

  it('re-arms (clears) on a same-tab store removal', async () => {
    savePendingExchange(pendingExchange());
    const { result } = renderHook(() => usePendingPairingApproval(ENDPOINT));
    await waitFor(() => expect(result.current).not.toBeNull());

    act(() => {
      clearPendingExchange(ENDPOINT, 'direct');
    });

    await waitFor(() => expect(result.current).toBeNull());
  });

  it('re-reads fresh when the endpoint itself changes', () => {
    savePendingExchange(pendingExchange({ endpoint: ENDPOINT }));
    const other = 'https://other-station.example.test';
    const { result, rerender } = renderHook(
      ({ endpoint }: { endpoint: string }) =>
        usePendingPairingApproval(endpoint),
      { initialProps: { endpoint: ENDPOINT } },
    );
    expect(result.current).not.toBeNull();

    rerender({ endpoint: other });
    expect(result.current).toBeNull();
  });
});
