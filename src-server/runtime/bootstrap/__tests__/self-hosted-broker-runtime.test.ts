import { describe, expect, test, vi } from 'vitest';
import { SelfHostedBrokerRuntime } from '../self-hosted-broker-runtime.js';

function fixture() {
  const lifetime = new AbortController();
  const connector = {
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
  test('refuses an origin mismatch and inactive virtual application', () => {
    const f = fixture();
    expect(
      () =>
        new SelfHostedBrokerRuntime({
          ...f.options,
          configuredOrigin: 'https://other.example',
        }),
    ).toThrow('broker_runtime_origin_mismatch');
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
});
