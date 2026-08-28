/** @vitest-environment jsdom */

import type { CompletePaired } from '@kontourai/station-connect';
import { act, cleanup, render } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PendingPairingReconciler } from '../components/PendingPairingReconciler';

const mocks = vi.hoisted(() => ({
  checkHostCompatibility: vi.fn(),
  completePendingPairing: vi.fn(),
  completeVerifiedPairing: vi.fn(),
  connections: [] as Array<{ id: string; name: string }>,
  markDeviceSession: vi.fn(),
  reconcileHandshake: vi.fn(),
  setActiveConnection: vi.fn(),
  setCredential: vi.fn(),
}));

vi.mock('@kontourai/station-connect', () => ({
  completePendingPairing: mocks.completePendingPairing,
  completeVerifiedPairing: mocks.completeVerifiedPairing,
  useConnections: () => ({
    connections: mocks.connections,
    commitVerifiedPairing: vi.fn(),
    markDeviceSession: mocks.markDeviceSession,
    reconcileHandshake: mocks.reconcileHandshake,
    setActiveConnection: mocks.setActiveConnection,
    setCredential: mocks.setCredential,
  }),
}));

vi.mock('../lib/compatibilityLoader', () => ({
  checkHostCompatibility: mocks.checkHostCompatibility,
}));

const target = { id: 'target-station', name: 'Exact target' };
const result = {
  endpoint: 'https://target.example.test',
  environmentId: 'env-target',
  device: {
    id: 'device-1',
    name: 'This browser',
    scope: 'station:interactive',
    createdAt: 1,
    lastUsedAt: 1,
    revokedAt: null,
  },
  browserSession: true,
};

function pending(overrides: Record<string, unknown> = {}) {
  return {
    endpoint: 'https://target.example.test',
    offerId: 'offer-1',
    proof: 'proof-1',
    requestId: 'request-1',
    expiresAt: Date.now() + 60_000,
    expectedEnvironmentId: 'env-target',
    browserSession: true,
    requestKind: 'direct' as const,
    targetConnectionId: target.id,
    targetConnectionLabel: target.name,
    ...overrides,
  };
}

function renderReconciler(
  overrides: Partial<ComponentProps<typeof PendingPairingReconciler>> = {},
) {
  const callbacks = {
    onApprovalWaiting: vi.fn(),
    onCompleted: vi.fn(),
    onConnectionWaiting: vi.fn(),
    onTerminalFailure: vi.fn(),
  };
  const view = render(
    <PendingPairingReconciler
      pending={pending()}
      enabled
      {...callbacks}
      {...overrides}
    />,
  );
  return { ...view, callbacks };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('PendingPairingReconciler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.connections = [
      target,
      { id: 'other-station', name: 'Other Station' },
    ];
    mocks.checkHostCompatibility.mockReset();
    mocks.completePendingPairing.mockReset();
    mocks.completeVerifiedPairing.mockReset();
    mocks.markDeviceSession.mockReset();
    mocks.reconcileHandshake.mockReset();
    mocks.setActiveConnection.mockReset();
    mocks.setCredential.mockReset();
    mocks.checkHostCompatibility.mockResolvedValue({ blocking: false });
    mocks.completePendingPairing.mockImplementation(
      async (
        _pending: unknown,
        options: { completePaired: CompletePaired; signal: AbortSignal },
      ) => {
        const completion = await options.completePaired(
          result as unknown as Parameters<CompletePaired>[0],
          {
            signal: options.signal,
          },
        );
        return completion.status === 'completed'
          ? { status: 'paired', result }
          : { status: 'post-exchange-failed', failure: completion.failure };
      },
    );
    mocks.completeVerifiedPairing.mockResolvedValue(target.id);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  test('provides compatibility and durable completion to the pairing module', async () => {
    const { callbacks } = renderReconciler();

    await advance(500);

    expect(mocks.completeVerifiedPairing).toHaveBeenCalledWith(
      expect.any(Object),
      {
        connectionId: target.id,
        endpoint: 'https://target.example.test',
        name: target.name,
      },
      { ...result, endpoint: 'https://target.example.test' },
    );
    expect(mocks.reconcileHandshake).toHaveBeenCalledWith(target.id, {
      environmentId: 'env-target',
      authentication: { scheme: 'bearer', protocolVersion: 1 },
    });
    expect(callbacks.onCompleted).toHaveBeenCalledOnce();
    expect(callbacks.onTerminalFailure).not.toHaveBeenCalled();
    expect(mocks.completePendingPairing).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ completePaired: expect.any(Function) }),
    );
  });

  test('reports the module denial result without retrying', async () => {
    mocks.completePendingPairing.mockResolvedValue({ status: 'declined' });
    const { callbacks } = renderReconciler();

    await advance(500);

    expect(callbacks.onTerminalFailure).toHaveBeenCalledWith(
      'Access request declined',
      // archive#3849: the shared map's DEVICE-subject decline, naming the
      // Station this request was for by its browser-local label — not "the
      // host", and not the Station the reader happens to be looking at.
      'Exact target declined this device. Request access again if that was unexpected.',
    );
    expect(mocks.completePendingPairing).toHaveBeenCalledOnce();
  });

  test('reports the module expiry result', async () => {
    mocks.completePendingPairing.mockResolvedValue({ status: 'expired' });
    const { callbacks } = renderReconciler();

    await advance(500);

    expect(callbacks.onTerminalFailure).toHaveBeenCalledWith(
      'Access request expired',
      'This access request expired before Exact target approved it. Request access again.',
    );
    expect(mocks.completePendingPairing).toHaveBeenCalledOnce();
  });

  test('aborts a cancelled exchange and never reports a stale terminal outcome', async () => {
    let signal: AbortSignal | undefined;
    mocks.completePendingPairing.mockImplementation(
      (_pending: unknown, options: { signal: AbortSignal }) => {
        signal = options.signal;
        return new Promise((resolve) => {
          options.signal.addEventListener(
            'abort',
            () => resolve({ status: 'aborted' }),
            { once: true },
          );
        });
      },
    );
    const { callbacks, unmount } = renderReconciler();

    await advance(500);
    unmount();
    expect(signal?.aborted).toBe(true);
    await advance(0);

    expect(callbacks.onCompleted).not.toHaveBeenCalled();
    expect(callbacks.onTerminalFailure).not.toHaveBeenCalled();
  });

  test('maps post-exchange compatibility failure from the pairing module', async () => {
    mocks.completePendingPairing.mockResolvedValue({
      status: 'post-exchange-failed',
      failure: {
        title: 'Connection could not be verified',
        message: 'compatibility failed',
      },
    });
    const { callbacks } = renderReconciler();

    await advance(0);

    expect(callbacks.onTerminalFailure).toHaveBeenCalledWith(
      'Connection could not be verified',
      'compatibility failed',
    );
    expect(mocks.completeVerifiedPairing).not.toHaveBeenCalled();
  });

  test('passes abort through compatibility completion and never commits after cancellation', async () => {
    let resolveCompatibility:
      | ((value: { blocking: boolean }) => void)
      | undefined;
    let signal: AbortSignal | undefined;
    mocks.checkHostCompatibility.mockImplementation(
      (_endpoint: string, compatibilitySignal: AbortSignal) => {
        signal = compatibilitySignal;
        return new Promise((resolve) => {
          resolveCompatibility = resolve;
        });
      },
    );
    const { callbacks, unmount } = renderReconciler();

    await advance(500);
    unmount();
    expect(signal?.aborted).toBe(true);
    resolveCompatibility?.({ blocking: false });
    await advance(0);

    expect(mocks.completeVerifiedPairing).not.toHaveBeenCalled();
    expect(mocks.reconcileHandshake).not.toHaveBeenCalled();
    expect(callbacks.onCompleted).not.toHaveBeenCalled();
    expect(callbacks.onTerminalFailure).not.toHaveBeenCalled();
  });

  test('projects the pairing module progress without owning its retry policy', async () => {
    mocks.completePendingPairing.mockImplementation(
      async (
        _pending: unknown,
        options: { onProgress: (value: unknown) => void },
      ) => {
        options.onProgress({ status: 'waiting-for-connection' });
        options.onProgress({ status: 'waiting-for-approval' });
        return { status: 'paired', result };
      },
    );
    const { callbacks } = renderReconciler();

    await advance(0);
    expect(callbacks.onConnectionWaiting).toHaveBeenCalledOnce();
    expect(callbacks.onApprovalWaiting).toHaveBeenCalledOnce();

    expect(mocks.completePendingPairing).toHaveBeenCalledOnce();
    expect(callbacks.onCompleted).toHaveBeenCalledOnce();
    expect(callbacks.onTerminalFailure).not.toHaveBeenCalled();
  });

  test('fails loudly when the original target was removed while waiting', async () => {
    mocks.connections = [];
    const { callbacks } = renderReconciler();

    await advance(500);

    expect(callbacks.onTerminalFailure).toHaveBeenCalledWith(
      'Saved Station is no longer available',
      'The saved Station for this request was forgotten on this device. Add Exact target again, then request access.',
    );
    expect(mocks.completeVerifiedPairing).not.toHaveBeenCalled();
  });

  test('reports local persistence failure after approval instead of retrying a spent offer', async () => {
    mocks.completeVerifiedPairing.mockRejectedValue(new Error('storage quota'));
    const { callbacks } = renderReconciler();

    await advance(500);

    expect(callbacks.onTerminalFailure).toHaveBeenCalledWith(
      'Access was approved but not saved',
      'The Station approved this device, but the Station could not be saved on this device. Request access again after checking local storage.',
    );
    expect(mocks.completePendingPairing).toHaveBeenCalledOnce();
  });
});
