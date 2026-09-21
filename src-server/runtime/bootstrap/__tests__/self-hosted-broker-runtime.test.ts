import { describe, expect, type Mock, test, vi } from 'vitest';
import {
  type BrokerConnectorLifecycle,
  SelfHostedBrokerRuntime,
} from '../self-hosted-broker-runtime.js';

type ConnectorMock = {
  [K in keyof BrokerConnectorLifecycle]: Mock<BrokerConnectorLifecycle[K]>;
};

function fixture() {
  const lifetime = new AbortController();
  const connector: ConnectorMock = {
    register: vi.fn(async () => {}),
    renew: vi.fn(async () => {}),
    poll: vi.fn(async () => {}),
    withdraw: vi.fn(async () => {}),
  };
  return {
    lifetime,
    connector,
    options: {
      origin: 'https://station.example',
      configuredOrigin: 'https://station.example',
      application: { signal: lifetime.signal, fetch: vi.fn() },
      connector,
      heartbeatMs: 30_000,
      renewMs: 60_000,
      pollMs: 60_000,
    },
  };
}
describe('self-hosted broker runtime lifecycle', () => {
  test('is explicit, idempotent and withdraws once after owned work settles', async () => {
    const f = fixture();
    const runtime = new SelfHostedBrokerRuntime(f.options);
    expect(runtime.start()).toBe(runtime.start());
    await runtime.start();
    expect(f.connector.register).toHaveBeenCalled();
    expect(runtime.shutdown()).toBe(runtime.shutdown());
    await runtime.shutdown();
    expect(f.connector.withdraw).toHaveBeenCalledOnce();
  });
  test('refuses a malformed origin and inactive virtual application', () => {
    const f = fixture();
    expect(
      () =>
        new SelfHostedBrokerRuntime({
          ...f.options,
          configuredOrigin: 'https://other.example/with-path',
        }),
    ).toThrow('broker_runtime_origin_mismatch');
    // The factory binds distinct well-formed origins (application vs browser
    // scope), so shape alone is validated here, not equality.
    expect(
      () =>
        new SelfHostedBrokerRuntime({
          ...f.options,
          configuredOrigin: 'https://browser.example',
        }),
    ).not.toThrow();
    f.lifetime.abort();
    expect(() => new SelfHostedBrokerRuntime(f.options)).toThrow(
      'broker_runtime_application_unavailable',
    );
  });
  test('compensates a partial registration failure', async () => {
    const f = fixture();
    f.connector.register.mockRejectedValueOnce(
      new Error('registration failed'),
    );
    const runtime = new SelfHostedBrokerRuntime(f.options);
    await expect(runtime.start()).rejects.toThrow('registration failed');
    expect(f.connector.withdraw).toHaveBeenCalledOnce();
  });
  test('records background poll failure and still withdraws before reporting it', async () => {
    const f = fixture();
    f.connector.poll.mockRejectedValueOnce(new Error('poll failed'));
    const runtime = new SelfHostedBrokerRuntime({
      ...f.options,
      pollMs: 1_000,
    });
    await runtime.start();
    await vi.waitFor(() => expect(f.connector.poll).toHaveBeenCalled());
    await expect(runtime.shutdown()).rejects.toThrow('poll failed');
    expect(f.connector.withdraw).toHaveBeenCalledOnce();
  });
  test('shutdown during a blocked registration fails with unsettled instead of resolving', async () => {
    const f = fixture();
    let releaseRegistration = () => {};
    const blocked = new Promise<unknown>((resolve) => {
      releaseRegistration = () => resolve(undefined);
    });
    const seen: AbortSignal[] = [];
    f.connector.register.mockImplementationOnce((signal: AbortSignal) => {
      seen.push(signal);
      return blocked;
    });
    const runtime = new SelfHostedBrokerRuntime({
      ...f.options,
      operationSettleMs: 50,
    });
    const started = runtime.start();
    await vi.waitFor(() => expect(f.connector.register).toHaveBeenCalled());
    await expect(runtime.shutdown()).rejects.toThrow(
      'broker_runtime_register_unsettled',
    );
    await expect(started).rejects.toThrow('broker_runtime_register_unsettled');
    expect(seen[0]?.aborted).toBe(true);
    expect(f.connector.renew).not.toHaveBeenCalled();
    expect(f.connector.poll).not.toHaveBeenCalled();
    expect(f.connector.withdraw).toHaveBeenCalledOnce();
    releaseRegistration();
  });
  test('application abort cancels a blocked poll and withdraws without waiting for shutdown', async () => {
    const f = fixture();
    const seen: AbortSignal[] = [];
    f.connector.poll.mockImplementation((signal: AbortSignal) => {
      seen.push(signal);
      return new Promise<unknown>(() => {
        // Hangs deliberately: ignores the abort signal and never settles, so
        // the runtime must bound the join instead of waiting forever.
      });
    });
    const runtime = new SelfHostedBrokerRuntime({
      ...f.options,
      pollMs: 1_000,
      operationSettleMs: 50,
    });
    await runtime.start();
    await vi.waitFor(() => expect(f.connector.poll).toHaveBeenCalled());
    f.lifetime.abort(new Error('application gone'));
    await vi.waitFor(
      () => expect(f.connector.withdraw).toHaveBeenCalledOnce(),
      { timeout: 5_000 },
    );
    expect(seen[0]?.aborted).toBe(true);
    await expect(runtime.shutdown()).rejects.toThrow(
      'broker_runtime_poll_unsettled',
    );
    expect(f.connector.withdraw).toHaveBeenCalledOnce();
  });
  test('background poll failure withdraws automatically before any shutdown call', async () => {
    const f = fixture();
    f.connector.poll.mockRejectedValueOnce(new Error('poll failed'));
    const runtime = new SelfHostedBrokerRuntime({
      ...f.options,
      pollMs: 1_000,
    });
    await runtime.start();
    await vi.waitFor(
      () => expect(f.connector.withdraw).toHaveBeenCalledOnce(),
      { timeout: 5_000 },
    );
    await expect(runtime.shutdown()).rejects.toThrow('poll failed');
    expect(f.connector.withdraw).toHaveBeenCalledOnce();
  });
  test('startup failure preserves both primary and compensation errors', async () => {
    const f = fixture();
    const primary = new Error('registration failed');
    const cleanup = new Error('withdraw failed');
    f.connector.register.mockRejectedValueOnce(primary);
    f.connector.withdraw.mockRejectedValueOnce(cleanup);
    const runtime = new SelfHostedBrokerRuntime(f.options);
    const error = await runtime.start().then(
      () => {
        throw new Error('expected start to reject');
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError;
    expect(aggregate.message).toBe('registration failed');
    expect(aggregate.errors[0]).toBe(primary);
    expect(aggregate.errors[1]).toBe(cleanup);
    expect((aggregate.errors[0] as Error).message).toBe('registration failed');
    expect(f.connector.withdraw).toHaveBeenCalledOnce();
  });
  test('startup failure preserves nested primary cause inside AggregateError', async () => {
    const f = fixture();
    const root = new Error('root cause');
    const primary = new Error('registration failed', { cause: root });
    const cleanup = new Error('withdraw failed');
    f.connector.register.mockRejectedValueOnce(primary);
    f.connector.withdraw.mockRejectedValueOnce(cleanup);
    const runtime = new SelfHostedBrokerRuntime(f.options);
    const error = await runtime.start().then(
      () => {
        throw new Error('expected start to reject');
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError;
    expect(aggregate.message).toBe('registration failed');
    expect(aggregate.errors[0]).toBe(primary);
    expect((aggregate.errors[0] as Error).cause).toBe(root);
    expect(aggregate.errors[1]).toBe(cleanup);
  });
  test('application abort during idle withdraws automatically without shutdown', async () => {
    const f = fixture();
    const runtime = new SelfHostedBrokerRuntime(f.options);
    await runtime.start();
    await vi.waitFor(() => expect(f.connector.poll).toHaveBeenCalled());
    f.lifetime.abort(new Error('application gone'));
    await vi.waitFor(
      () => expect(f.connector.withdraw).toHaveBeenCalledOnce(),
      { timeout: 5_000 },
    );
    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(f.connector.withdraw).toHaveBeenCalledOnce();
  });
  test('clean abort-aware poll during shutdown resolves without reporting shutdown as failure', async () => {
    const f = fixture();
    f.connector.poll.mockImplementation(
      (signal: AbortSignal) =>
        new Promise<unknown>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    const runtime = new SelfHostedBrokerRuntime({
      ...f.options,
      pollMs: 1_000,
      operationSettleMs: 50,
    });
    await runtime.start();
    await vi.waitFor(() => expect(f.connector.poll).toHaveBeenCalled());
    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(f.connector.withdraw).toHaveBeenCalledOnce();
  });
  test('non-Error primary preserves cleanup failure in AggregateError', async () => {
    const f = fixture();
    f.connector.register.mockRejectedValueOnce(
      'registration string failure' as never,
    );
    f.connector.withdraw.mockRejectedValueOnce(new Error('withdraw failed'));
    const runtime = new SelfHostedBrokerRuntime(f.options);
    const error = await runtime.start().then(
      () => {
        throw new Error('expected start to reject');
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError;
    expect(aggregate.message).toBe('registration string failure');
    expect(aggregate.errors).toContain('registration string failure');
    expect(aggregate.errors).toContainEqual(
      expect.objectContaining({ message: 'withdraw failed' }),
    );
    expect(f.connector.withdraw).toHaveBeenCalledOnce();
  });
  test('abort race that settles with an unexpected rejection preserves the actual failure', async () => {
    const f = fixture();
    const actual = new Error('poll exploded');
    let rejectOperation!: (error: unknown) => void;
    const gate = new Promise<unknown>((_resolve, reject) => {
      rejectOperation = reject;
    });
    // Never settles on its own: lets shutdown() win the race with the abort,
    // then settles with a distinct failure inside the settle window.
    f.connector.poll.mockImplementationOnce(() => gate);
    const runtime = new SelfHostedBrokerRuntime({
      ...f.options,
      pollMs: 1_000,
      operationSettleMs: 500,
    });
    await runtime.start();
    await vi.waitFor(() => expect(f.connector.poll).toHaveBeenCalled());
    const shuttingDown = runtime.shutdown();
    rejectOperation(actual);
    const error = await shuttingDown.then(
      () => {
        throw new Error('expected shutdown to reject');
      },
      (caught: unknown) => caught,
    );
    expect(error).toBe(actual);
  });
  test('distinct broker_runtime_shutdown error during normal shutdown remains a failure', async () => {
    const f = fixture();
    const impostor = new Error('broker_runtime_shutdown');
    let rejectOperation!: (error: unknown) => void;
    const gate = new Promise<unknown>((_resolve, reject) => {
      rejectOperation = reject;
    });
    f.connector.poll.mockImplementationOnce(() => gate);
    const runtime = new SelfHostedBrokerRuntime({
      ...f.options,
      pollMs: 1_000,
      operationSettleMs: 500,
    });
    await runtime.start();
    await vi.waitFor(() => expect(f.connector.poll).toHaveBeenCalled());
    const shuttingDown = runtime.shutdown();
    // Same message as the owned abort reason but a distinct object: must not
    // be treated as a clean abort cancellation.
    rejectOperation(impostor);
    await expect(shuttingDown).rejects.toBe(impostor);
  });
});
