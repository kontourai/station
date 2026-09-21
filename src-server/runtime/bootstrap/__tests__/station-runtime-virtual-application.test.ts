import { describe, expect, test, vi } from 'vitest';
import type { VirtualApplication } from '../../../services/connections/virtual-application.js';
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
