import type { PairedDevice } from '@kontourai/station-contracts';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { PendingPairingExchange } from '../core/devicePairing';
import {
  type CompletePaired,
  type CompletePendingPairingOptions,
  createPendingPairingCompletion,
  type PendingPairingExchangeResult,
} from '../core/pendingPairingCompletion';
import {
  type CompletePendingPairing,
  createPendingPairingCompletionLoader,
} from '../core/pendingPairingCompletionLoader';

const endpoint = 'https://station.example.test';

function pending(
  overrides: Partial<PendingPairingExchange> = {},
): PendingPairingExchange {
  return {
    endpoint,
    offerId: 'offer-1',
    proof: 'proof-1',
    requestId: 'request-1',
    expiresAt: 60_000,
    expectedEnvironmentId: 'environment-1',
    browserSession: false,
    requestKind: 'direct',
    ...overrides,
  };
}

function pairedResult(
  overrides: Partial<PendingPairingExchangeResult> = {},
): PendingPairingExchangeResult {
  return {
    environmentId: 'environment-1',
    clientInstanceId: '11111111-1111-4111-8111-111111111111',
    device: {
      id: 'device-1',
      name: 'This device',
      scope: 'station:interactive',
      kind: 'device',
      createdAt: 1,
      lastUsedAt: 1,
      revokedAt: null,
    } as PairedDevice,
    credential: 'credential-1',
    browserSession: false,
    ...overrides,
  };
}

function deferred<Value>() {
  let resolve: (value: Value) => void;
  let reject: (reason?: unknown) => void;
  const promise = new Promise<Value>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject: reject!, resolve: resolve! };
}

const completePaired: CompletePaired = async () => ({ status: 'completed' });
type ExchangePendingPairing = NonNullable<
  NonNullable<Parameters<typeof createPendingPairingCompletion>[0]>['exchange']
>;

function completionOptions(
  overrides: Omit<CompletePendingPairingOptions, 'completePaired'> = {},
): CompletePendingPairingOptions {
  return { completePaired, ...overrides };
}

function harness(
  exchange: ReturnType<typeof vi.fn<ExchangePendingPairing>> = vi
    .fn<ExchangePendingPairing>()
    .mockResolvedValue(pairedResult()),
) {
  let now = 0;
  const clearPending = vi.fn();
  const waits: number[] = [];
  const complete = createPendingPairingCompletion({
    clearPending,
    exchange,
    now: () => now,
    waitUntil: vi.fn(async (timestamp, signal) => {
      waits.push(timestamp);
      now = timestamp;
      return !signal?.aborted;
    }),
  });
  return { clearPending, complete, waits };
}

describe('completePendingPairing interface', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('retries a failed shared implementation load without consuming the request', async () => {
    const firstLoad = deferred<{
      completePendingPairing: CompletePendingPairing;
    }>();
    const recoveredImplementation = vi.fn(async () => ({
      status: 'aborted' as const,
    }));
    const importImplementation = vi
      .fn()
      .mockReturnValueOnce(firstLoad.promise)
      .mockResolvedValue({ completePendingPairing: recoveredImplementation });
    const loader = createPendingPairingCompletionLoader(importImplementation);

    const first = loader.completePendingPairing(pending(), completionOptions());
    const second = loader.completePendingPairing(
      { ...pending() },
      completionOptions(),
    );
    expect(importImplementation).toHaveBeenCalledOnce();

    firstLoad.reject(new Error('chunk unavailable'));
    await expect(first).resolves.toEqual({ status: 'failed' });
    await expect(second).resolves.toEqual({ status: 'failed' });
    expect(recoveredImplementation).not.toHaveBeenCalled();

    await expect(
      loader.completePendingPairing({ ...pending() }, completionOptions()),
    ).resolves.toEqual({ status: 'aborted' });
    expect(importImplementation).toHaveBeenCalledTimes(2);
    expect(recoveredImplementation).toHaveBeenCalledOnce();

    await expect(
      loader.completePendingPairing({ ...pending() }, completionOptions()),
    ).resolves.toEqual({ status: 'aborted' });
    expect(importImplementation).toHaveBeenCalledTimes(2);
    expect(recoveredImplementation).toHaveBeenCalledTimes(2);
  });

  test('reads the active clock even when the module was created before clock substitution', async () => {
    const exchange = vi.fn().mockResolvedValue(pairedResult());
    const complete = createPendingPairingCompletion({
      clearPending: vi.fn(),
      exchange,
    });
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const completion = complete(pending(), completionOptions());
    await vi.advanceTimersByTimeAsync(500);

    await expect(completion).resolves.toMatchObject({ status: 'paired' });
    expect(exchange).toHaveBeenCalledOnce();
  });

  test('returns the paired result and clears the spent request once', async () => {
    const exchange = vi.fn().mockResolvedValue(pairedResult());
    const { clearPending, complete, waits } = harness(exchange);

    await expect(complete(pending(), completionOptions())).resolves.toEqual({
      status: 'paired',
      result: pairedResult(),
    });

    expect(waits).toEqual([500]);
    expect(exchange).toHaveBeenCalledOnce();
    expect(clearPending).toHaveBeenCalledOnce();
    expect(clearPending).toHaveBeenCalledWith(endpoint, 'direct');
  });

  test('runs one completion owner for concurrent subscribers and clears only after it settles', async () => {
    const durableCompletion = deferred<{ status: 'completed' }>();
    const completePaired = vi.fn(() => durableCompletion.promise);
    const competingCompletion = vi.fn(async () => ({
      status: 'failed' as const,
      failure: 'must not own this request',
    }));
    const exchange = vi.fn().mockResolvedValue(pairedResult());
    const { clearPending, complete } = harness(exchange);

    const first = complete(pending(), { completePaired });
    const second = complete(
      { ...pending() },
      { completePaired: competingCompletion },
    );

    await vi.waitFor(() => expect(completePaired).toHaveBeenCalledOnce());
    expect(exchange).toHaveBeenCalledOnce();
    expect(competingCompletion).not.toHaveBeenCalled();
    expect(clearPending).not.toHaveBeenCalled();

    durableCompletion.resolve({ status: 'completed' });
    await expect(first).resolves.toMatchObject({ status: 'paired' });
    await expect(second).resolves.toMatchObject({ status: 'paired' });
    expect(clearPending).toHaveBeenCalledOnce();
  });

  test('reports caller completion failure as total and clears the spent proof', async () => {
    const failure = { kind: 'storage', reason: 'quota' };
    const completePaired = vi.fn(async () => ({
      status: 'failed' as const,
      failure,
    }));
    const { clearPending, complete } = harness();

    await expect(complete(pending(), { completePaired })).resolves.toEqual({
      status: 'post-exchange-failed',
      failure,
    });
    expect(completePaired).toHaveBeenCalledOnce();
    expect(clearPending).toHaveBeenCalledOnce();
  });

  test('clears the spent proof when completion observes the shared abort', async () => {
    const completionStarted = deferred<void>();
    const controller = new AbortController();
    const completePaired = vi.fn(
      async (
        _result: PendingPairingExchangeResult,
        { signal }: { signal: AbortSignal },
      ) => {
        completionStarted.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return { status: 'failed' as const, failure: 'aborted locally' };
      },
    );
    const { clearPending, complete } = harness();

    const completion = complete(pending(), {
      signal: controller.signal,
      completePaired,
    });
    await completionStarted.promise;
    controller.abort();

    await expect(completion).resolves.toEqual({ status: 'aborted' });
    await vi.waitFor(() => expect(clearPending).toHaveBeenCalledOnce());
  });

  test('retains a spent flight for a late subscriber while aborted completion settles', async () => {
    const completionStarted = deferred<void>();
    const settleCompletion = deferred<{
      status: 'failed';
      failure: string;
    }>();
    const controller = new AbortController();
    const exchange = vi.fn().mockResolvedValue(pairedResult());
    const completePaired = vi.fn(async () => {
      completionStarted.resolve();
      return settleCompletion.promise;
    });
    const { clearPending, complete } = harness(exchange);

    const first = complete(pending(), {
      signal: controller.signal,
      completePaired,
    });
    await completionStarted.promise;

    controller.abort();
    await expect(first).resolves.toEqual({ status: 'aborted' });

    const late = complete({ ...pending() }, completionOptions());
    expect(exchange).toHaveBeenCalledOnce();
    expect(completePaired).toHaveBeenCalledOnce();

    settleCompletion.resolve({ status: 'failed', failure: 'local abort' });
    await expect(late).resolves.toEqual({
      status: 'post-exchange-failed',
      failure: 'local abort',
    });
    expect(clearPending).toHaveBeenCalledOnce();
  });

  test('owns approval, transport, and rate-limit retries behind one call', async () => {
    const transportFailure = Object.assign(new Error('offline'), {
      transport: true,
    });
    const exchange = vi
      .fn()
      .mockRejectedValueOnce({ status: 409 })
      .mockRejectedValueOnce(transportFailure)
      .mockRejectedValueOnce({ status: 429 })
      .mockResolvedValueOnce(pairedResult());
    const progress = vi.fn();
    const { clearPending, complete, waits } = harness(exchange);

    await expect(
      complete(pending(), completionOptions({ onProgress: progress })),
    ).resolves.toMatchObject({ status: 'paired' });

    expect(waits).toEqual([500, 1_250, 2_375, 12_375]);
    expect(progress.mock.calls.map(([value]) => value.status)).toEqual([
      'waiting-for-approval',
      'waiting-for-connection',
      'waiting-for-approval',
    ]);
    expect(exchange).toHaveBeenCalledTimes(4);
    expect(clearPending).toHaveBeenCalledOnce();
  });

  test.each([
    [{ status: 403, code: 'request_denied' }, 'declined'],
    [{ status: 410 }, 'expired'],
    [{ code: 'offer_expired' }, 'expired'],
    [new Error('malformed response'), 'failed'],
  ] as const)(
    'settles terminal exchange failure %# as %s and clears it',
    async (failure, status) => {
      const exchange = vi.fn().mockRejectedValue(failure);
      const { clearPending, complete } = harness(exchange);

      await expect(complete(pending(), completionOptions())).resolves.toEqual({
        status,
      });
      expect(exchange).toHaveBeenCalledOnce();
      expect(clearPending).toHaveBeenCalledOnce();
    },
  );

  test('expires before exchanging and clears the unusable request', async () => {
    const exchange = vi.fn();
    const { clearPending, complete } = harness(exchange);

    await expect(
      complete(pending({ expiresAt: 499 }), completionOptions()),
    ).resolves.toEqual({ status: 'expired' });

    expect(exchange).not.toHaveBeenCalled();
    expect(clearPending).toHaveBeenCalledOnce();
  });

  test('rejects a changed Station identity and clears the spent request', async () => {
    const exchange = vi
      .fn()
      .mockResolvedValue(pairedResult({ environmentId: 'environment-2' }));
    const { clearPending, complete } = harness(exchange);

    await expect(complete(pending(), completionOptions())).resolves.toEqual({
      status: 'identity-changed',
    });
    expect(clearPending).toHaveBeenCalledOnce();
  });

  test('reports abort without exchanging or clearing a live request', async () => {
    const controller = new AbortController();
    controller.abort();
    const exchange = vi.fn();
    const { clearPending, complete } = harness(exchange);

    await expect(
      complete(pending(), completionOptions({ signal: controller.signal })),
    ).resolves.toEqual({ status: 'aborted' });

    expect(exchange).not.toHaveBeenCalled();
    expect(clearPending).not.toHaveBeenCalled();
  });

  test('preserves the request when an in-flight adapter observes abort', async () => {
    const controller = new AbortController();
    const exchange = vi.fn<ExchangePendingPairing>(
      ({ signal }: PendingPairingExchange & { signal?: AbortSignal }) =>
        new Promise<PendingPairingExchangeResult>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () =>
              reject(Object.assign(new Error('aborted'), { transport: true })),
            { once: true },
          );
        }),
    );
    const { clearPending, complete } = harness(exchange);
    const completion = complete(
      pending(),
      completionOptions({ signal: controller.signal }),
    );

    await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());
    controller.abort();

    await expect(completion).resolves.toEqual({ status: 'aborted' });
    expect(clearPending).not.toHaveBeenCalled();
  });

  test('joins an aborted but unsettled exchange so a late success cannot replay its proof', async () => {
    const exchangeResult = deferred<PendingPairingExchangeResult>();
    const exchange = vi.fn(() => exchangeResult.promise);
    const completePaired = vi.fn(async () => ({
      status: 'completed' as const,
    }));
    const competingCompletion = vi.fn(async () => ({
      status: 'failed' as const,
      failure: 'late caller must not persist again',
    }));
    const controller = new AbortController();
    const { clearPending, complete } = harness(exchange);

    const first = complete(pending(), {
      signal: controller.signal,
      completePaired,
    });
    await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());

    controller.abort();
    await expect(first).resolves.toEqual({ status: 'aborted' });

    const late = complete(
      { ...pending() },
      {
        completePaired: competingCompletion,
      },
    );
    expect(exchange).toHaveBeenCalledOnce();

    exchangeResult.resolve(pairedResult());
    await expect(late).resolves.toMatchObject({ status: 'paired' });
    expect(exchange).toHaveBeenCalledOnce();
    expect(completePaired).toHaveBeenCalledOnce();
    expect(competingCompletion).not.toHaveBeenCalled();
    expect(clearPending).toHaveBeenCalledOnce();
  });

  test('settles late subscribers as aborted before spend, then allows a fresh flight', async () => {
    const firstExchange = deferred<PendingPairingExchangeResult>();
    const exchange = vi
      .fn()
      .mockImplementationOnce(() => firstExchange.promise)
      .mockResolvedValueOnce(pairedResult());
    const firstCompletion = vi.fn(async () => ({
      status: 'completed' as const,
    }));
    const lateCompletion = vi.fn(async () => ({
      status: 'completed' as const,
    }));
    const freshCompletion = vi.fn(async () => ({
      status: 'completed' as const,
    }));
    const controller = new AbortController();
    const { clearPending, complete } = harness(exchange);

    const first = complete(pending(), {
      signal: controller.signal,
      completePaired: firstCompletion,
    });
    await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());
    controller.abort();
    await expect(first).resolves.toEqual({ status: 'aborted' });

    const late = complete({ ...pending() }, { completePaired: lateCompletion });
    firstExchange.reject(
      Object.assign(new Error('aborted'), { transport: true }),
    );
    await expect(late).resolves.toEqual({ status: 'aborted' });
    expect(clearPending).not.toHaveBeenCalled();
    expect(firstCompletion).not.toHaveBeenCalled();
    expect(lateCompletion).not.toHaveBeenCalled();

    await expect(
      complete({ ...pending() }, { completePaired: freshCompletion }),
    ).resolves.toMatchObject({ status: 'paired' });
    expect(exchange).toHaveBeenCalledTimes(2);
    expect(freshCompletion).toHaveBeenCalledOnce();
    expect(clearPending).toHaveBeenCalledOnce();
  });

  test('shares one retry flight, projects progress to every subscriber, and clears once', async () => {
    const secondAttempt = deferred<PendingPairingExchangeResult>();
    const exchange = vi
      .fn()
      .mockRejectedValueOnce({ status: 409 })
      .mockImplementationOnce(() => secondAttempt.promise);
    const firstProgress = vi.fn();
    const secondProgress = vi.fn();
    const { clearPending, complete } = harness(exchange);

    const first = complete(
      pending(),
      completionOptions({ onProgress: firstProgress }),
    );
    const second = complete(
      { ...pending() },
      completionOptions({ onProgress: secondProgress }),
    );

    await vi.waitFor(() => expect(exchange).toHaveBeenCalledTimes(2));
    expect(firstProgress).toHaveBeenCalledWith({
      status: 'waiting-for-approval',
    });
    expect(secondProgress).toHaveBeenCalledWith({
      status: 'waiting-for-approval',
    });

    secondAttempt.resolve(pairedResult());
    await expect(first).resolves.toMatchObject({ status: 'paired' });
    await expect(second).resolves.toMatchObject({ status: 'paired' });
    expect(exchange).toHaveBeenCalledTimes(2);
    expect(clearPending).toHaveBeenCalledOnce();
  });

  test('gives a late subscriber the current progress without starting another exchange', async () => {
    const secondAttempt = deferred<PendingPairingExchangeResult>();
    const exchange = vi
      .fn()
      .mockRejectedValueOnce({ status: 409 })
      .mockImplementationOnce(() => secondAttempt.promise);
    const firstProgress = vi.fn();
    const lateProgress = vi.fn();
    const { complete } = harness(exchange);

    const first = complete(
      pending(),
      completionOptions({ onProgress: firstProgress }),
    );
    await vi.waitFor(() => expect(exchange).toHaveBeenCalledTimes(2));

    const late = complete(
      { ...pending() },
      completionOptions({ onProgress: lateProgress }),
    );
    expect(lateProgress).toHaveBeenCalledWith({
      status: 'waiting-for-approval',
    });
    expect(exchange).toHaveBeenCalledTimes(2);

    secondAttempt.resolve(pairedResult());
    await expect(first).resolves.toMatchObject({ status: 'paired' });
    await expect(late).resolves.toMatchObject({ status: 'paired' });
  });

  test('isolates an aborted subscriber while the remaining subscriber completes', async () => {
    const exchangeResult = deferred<PendingPairingExchangeResult>();
    let exchangeSignal: AbortSignal | undefined;
    const exchange = vi.fn(
      ({ signal }: PendingPairingExchange & { signal?: AbortSignal }) => {
        exchangeSignal = signal;
        return exchangeResult.promise;
      },
    );
    const firstController = new AbortController();
    const { clearPending, complete } = harness(exchange);

    const first = complete(
      pending(),
      completionOptions({ signal: firstController.signal }),
    );
    const second = complete({ ...pending() }, completionOptions());
    await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());

    firstController.abort();
    await expect(first).resolves.toEqual({ status: 'aborted' });
    expect(exchangeSignal?.aborted).toBe(false);

    exchangeResult.resolve(pairedResult());
    await expect(second).resolves.toMatchObject({ status: 'paired' });
    expect(clearPending).toHaveBeenCalledOnce();
  });

  test('aborts the shared exchange only when no subscribers remain', async () => {
    let exchangeSignal: AbortSignal | undefined;
    const exchange = vi.fn(
      ({ signal }: PendingPairingExchange & { signal?: AbortSignal }) =>
        new Promise<PendingPairingExchangeResult>((_resolve, reject) => {
          exchangeSignal = signal;
          signal?.addEventListener(
            'abort',
            () =>
              reject(Object.assign(new Error('aborted'), { transport: true })),
            { once: true },
          );
        }),
    );
    const firstController = new AbortController();
    const secondController = new AbortController();
    const { clearPending, complete } = harness(exchange);

    const first = complete(
      pending(),
      completionOptions({ signal: firstController.signal }),
    );
    const second = complete(
      { ...pending() },
      completionOptions({ signal: secondController.signal }),
    );
    await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());

    firstController.abort();
    await expect(first).resolves.toEqual({ status: 'aborted' });
    expect(exchangeSignal?.aborted).toBe(false);

    secondController.abort();
    await expect(second).resolves.toEqual({ status: 'aborted' });
    await vi.waitFor(() => expect(exchangeSignal?.aborted).toBe(true));
    expect(clearPending).not.toHaveBeenCalled();
  });

  test('clears the spent request when an adapter resolves after the shared abort', async () => {
    const exchangeResult = deferred<PendingPairingExchangeResult>();
    let exchangeSignal: AbortSignal | undefined;
    const exchange = vi.fn(
      ({ signal }: PendingPairingExchange & { signal?: AbortSignal }) => {
        exchangeSignal = signal;
        return exchangeResult.promise;
      },
    );
    const controller = new AbortController();
    const { clearPending, complete } = harness(exchange);

    const completion = complete(
      pending(),
      completionOptions({ signal: controller.signal }),
    );
    await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());

    controller.abort();
    await expect(completion).resolves.toEqual({ status: 'aborted' });
    await vi.waitFor(() => expect(exchangeSignal?.aborted).toBe(true));

    exchangeResult.resolve(pairedResult());
    await Promise.resolve();
    await Promise.resolve();
    expect(clearPending).toHaveBeenCalledOnce();
  });

  test('does not let an observer exception break the shared protocol', async () => {
    const secondAttempt = deferred<PendingPairingExchangeResult>();
    const exchange = vi
      .fn()
      .mockRejectedValueOnce({ status: 409 })
      .mockImplementationOnce(() => secondAttempt.promise);
    const throwingProgress = vi.fn(() => {
      throw new Error('observer failed');
    });
    const healthyProgress = vi.fn();
    const { clearPending, complete } = harness(exchange);

    const first = complete(
      pending(),
      completionOptions({ onProgress: throwingProgress }),
    );
    const second = complete(
      { ...pending() },
      completionOptions({ onProgress: healthyProgress }),
    );
    await vi.waitFor(() => expect(exchange).toHaveBeenCalledTimes(2));
    expect(healthyProgress).toHaveBeenCalledWith({
      status: 'waiting-for-approval',
    });

    secondAttempt.resolve(pairedResult());
    await expect(first).resolves.toMatchObject({ status: 'paired' });
    await expect(second).resolves.toMatchObject({ status: 'paired' });
    expect(clearPending).toHaveBeenCalledOnce();
  });
});
