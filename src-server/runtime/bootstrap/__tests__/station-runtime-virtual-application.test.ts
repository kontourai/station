import { describe, expect, test, vi } from 'vitest';
import { BrokerTransientRequestError } from '../../../services/connections/self-hosted-broker-client.js';
import type { VirtualApplication } from '../../../services/connections/virtual-application.js';
import { SelfHostedBrokerRuntime } from '../self-hosted-broker-runtime.js';
import { StationRuntime } from '../station-runtime.js';

// Lifecycle unit fixture: the real initialize/shutdown owners run, while the
// heavyweight agent/model bootstrap is controlled. This does not prove the
// real route-composition callback; the encrypted runtime lab owns that proof.
function runtimeFixture() {
  let ready: VirtualApplication | undefined;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const runtime = Object.create(StationRuntime.prototype) as StationRuntime;
  // Object.assign avoids pretending that this fixture constructs production
  // storage or listeners; only the lifecycle fields consumed here are supplied.
  Object.assign(runtime, {
    virtualApplicationLifetime: new AbortController(),
    virtualApplicationConfiguration: {
      origin: 'https://station.example',
      ready: (app: VirtualApplication) => {
        ready = app;
      },
    },
    runInitialize: vi.fn(async () => {
      Reflect.get(runtime, 'virtualApplication').bind({
        fetch: () => Response.json({ data: 'protected-app-placeholder' }),
      });
      await started;
    }),
    stopObservingRuntimeConfigurationSources: vi.fn(),
    shutdownAfterConfigurationDrain: vi.fn(async () => {}),
  });
  return { runtime: runtime as StationRuntime, finish, ready: () => ready };
}

describe('StationRuntime virtual application publication', () => {
  test('keeps local application ready while optional broker registration recovers', async () => {
    const fixture = runtimeFixture();
    let online = false;
    let broker!: SelfHostedBrokerRuntime;
    const register = vi.fn(async () => {
      if (!online)
        throw new BrokerTransientRequestError(new TypeError('offline'));
      return { expiresAt: Date.now() + 60_000 };
    });
    const withdraw = vi.fn(async () => {});
    Object.assign(fixture.runtime, {
      selfHostedBrokerConfiguration: {
        create: (application: VirtualApplication) => {
          broker = new SelfHostedBrokerRuntime({
            origin: 'https://station.example',
            configuredOrigin: 'https://station.example',
            application,
            connector: {
              register,
              renew: async () => {},
              poll: async () => {},
              withdraw,
            },
            heartbeatMs: 30_000,
            renewMs: 60_000,
            pollMs: 60_000,
            retryDelayMs: 1,
          });
          return broker;
        },
      },
    });
    const initialized = fixture.runtime.initialize();
    fixture.finish();
    await initialized;
    expect(
      (
        await fixture
          .ready()!
          .fetch(new Request('https://station.example/api/projects'))
      ).status,
    ).toBe(200);
    await vi.waitFor(() =>
      expect(register.mock.calls.length).toBeGreaterThan(3),
    );
    online = true;
    await broker.start();
    expect(withdraw).not.toHaveBeenCalled();
    await fixture.runtime.shutdown();
    expect(withdraw).toHaveBeenCalledOnce();
  });
  test('shutdown cancels detached broker startup without a false failure report', async () => {
    const fixture = runtimeFixture();
    const warn = vi.fn();
    const register = vi.fn(async () => {
      throw new BrokerTransientRequestError(new TypeError('offline'));
    });
    const withdraw = vi.fn(async () => {});
    Object.assign(fixture.runtime, {
      logger: { warn },
      selfHostedBrokerConfiguration: {
        create: (application: VirtualApplication) =>
          new SelfHostedBrokerRuntime({
            origin: 'https://station.example',
            configuredOrigin: 'https://station.example',
            application,
            connector: {
              register,
              renew: async () => {},
              poll: async () => {},
              withdraw,
            },
            heartbeatMs: 30_000,
            renewMs: 60_000,
            pollMs: 60_000,
            retryDelayMs: 1_000,
          }),
      },
    });
    const initialized = fixture.runtime.initialize();
    fixture.finish();
    await initialized;
    await vi.waitFor(() => expect(register).toHaveBeenCalledOnce());
    await fixture.runtime.shutdown();
    await vi.waitFor(() => expect(withdraw).toHaveBeenCalledOnce());
    expect(register).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });
  test('starts the opt-in broker after application activation and stops it before ingress retirement', async () => {
    const fixture = runtimeFixture();
    const start = vi.fn(async () => {});
    const shutdown = vi.fn(async () => {
      expect(fixture.ready()?.signal.aborted).toBe(false);
    });
    Object.assign(fixture.runtime, {
      selfHostedBrokerConfiguration: {
        create: (application: VirtualApplication) => {
          expect(application).toBe(fixture.ready());
          return { start, shutdown };
        },
      },
    });
    const initialized = fixture.runtime.initialize();
    expect(start).not.toHaveBeenCalled();
    fixture.finish();
    await initialized;
    expect(start).toHaveBeenCalledOnce();
    await fixture.runtime.shutdown();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(fixture.ready()?.signal.aborted).toBe(true);
  });
  test('publishes only after bootstrap resolves and revokes on shutdown', async () => {
    const fixture = runtimeFixture();
    const initialized = fixture.runtime.initialize();
    expect(fixture.ready()).toBeUndefined();
    fixture.finish();
    await initialized;
    const app = fixture.ready()!;
    expect(
      (await app.fetch(new Request('https://station.example/api/projects')))
        .status,
    ).toBe(200);
    await fixture.runtime.shutdown();
    expect(app.signal.aborted).toBe(true);
    expect(
      (await app.fetch(new Request('https://station.example/api/projects')))
        .status,
    ).toBe(503);
  });
  test('shutdown during bootstrap prevents late publication', async () => {
    const fixture = runtimeFixture();
    const initialized = fixture.runtime.initialize();
    const rejected = expect(initialized).rejects.toThrow();
    const stopped = fixture.runtime.shutdown();
    fixture.finish();
    await rejected;
    await stopped;
    expect(fixture.ready()).toBeUndefined();
    await expect(fixture.runtime.initialize()).rejects.toThrow();
  });
});
