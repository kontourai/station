/**
 * Ownership of a Tailscale Serve origin is a security admission, so the
 * runtime origin gate must not keep admitting it on a stale answer after the
 * operator shares the origin with another service or turns Funnel on.
 *
 * Drives the real route-classification gate with the production resolver
 * and origin policy; only the `tailscale` CLI and the clock are faked.
 */
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import { createStationOriginPolicy } from '../../../security/station-browser-origins.js';
import { createPublicIngressOriginResolver } from '../../../services/tailscale/public-ingress-origin.js';
import { configureRuntimeRouteClassificationGate } from '../runtime-http.js';

const HOST = 'station.example.ts.net';
const ORIGIN = `https://${HOST}`;
const PATH = '/.well-known/station/v1/pairing/access-request';

function harness(cli?: (args: readonly string[]) => Promise<unknown>) {
  const serve: Record<string, unknown> = {
    TCP: { 443: { HTTPS: true } },
    Web: {
      [`${HOST}:443`]: {
        Handlers: { '/': { Proxy: 'http://127.0.0.1:3141' } },
      },
    },
  };
  const clock = { now: 100_000 };
  const calls: string[][] = [];
  const resolver = createPublicIngressOriginResolver({
    localPorts: [3141],
    now: () => clock.now,
    admissionTimeoutMs: 50,
    cli:
      (cli as never) ??
      (async (args: readonly string[]) => {
        calls.push([...args]);
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            args[0] === 'status'
              ? { Self: { DNSName: `${HOST}.`, Online: true } }
              : serve,
          ),
        };
      }),
  });
  const app = new Hono();
  configureRuntimeRouteClassificationGate(
    app as never,
    {
      originPolicy: createStationOriginPolicy({
        configured: [],
        isOwnedOrigin: resolver.isOwnedOrigin,
      }),
    },
    (path) => path,
  );
  app.post(PATH, (c) => c.json({ reached: true }, 202));
  const request = async () =>
    (
      await app.request(PATH, {
        method: 'POST',
        headers: { Origin: ORIGIN },
      })
    ).status;
  /** The reviewer's change: a foreign handler beside Station, and Funnel on. */
  const share = () => {
    const web = serve.Web as Record<string, { Handlers: object }>;
    web[`${HOST}:443`]!.Handlers = {
      ...web[`${HOST}:443`]!.Handlers,
      '/evil': { Proxy: 'http://127.0.0.1:9000' },
    };
    serve.AllowFunnel = { [`${HOST}:443`]: true };
  };
  return { request, share, clock, calls, resolver };
}

describe('runtime origin gate: owned Serve origin admission is not stale', () => {
  test('stops admitting within a second of the origin being shared and exposed through Funnel', async () => {
    const h = harness();
    expect(await h.request()).toBe(202);
    h.share();
    h.clock.now += 1_001;
    expect(await h.request()).toBe(403);
    // Well inside the 30-second endpoint-suggestion TTL the reviewer hit.
    h.clock.now += 27_000;
    expect(await h.request()).toBe(403);
  });

  test('a slow daemon reply never extends trust: the bound counts from when the read began', async () => {
    const host = HOST;
    const config: Record<string, unknown> = {
      TCP: { 443: { HTTPS: true } },
      Web: {
        [`${host}:443`]: {
          Handlers: { '/': { Proxy: 'http://127.0.0.1:3141' } },
        },
      },
    };
    const clock = { now: 100_000 };
    let release!: (reply: { exitCode: number; stdout: string }) => void;
    let first = true;
    const resolver = createPublicIngressOriginResolver({
      localPorts: [3141],
      now: () => clock.now,
      admissionTimeoutMs: 10_000,
      cli: async (args: readonly string[]) => {
        if (args[0] === 'status')
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              Self: { DNSName: `${host}.`, Online: true },
            }),
          };
        const stdout = JSON.stringify(config);
        if (!first) return { exitCode: 0, stdout };
        first = false;
        // The daemon answered with the owned configuration, but the reply
        // is slow to arrive.
        return new Promise((resolve) => {
          release = () => resolve({ exitCode: 0, stdout });
        });
      },
    });
    const app = new Hono();
    configureRuntimeRouteClassificationGate(
      app as never,
      {
        originPolicy: createStationOriginPolicy({
          configured: [],
          isOwnedOrigin: resolver.isOwnedOrigin,
        }),
      },
      (path) => path,
    );
    app.post(PATH, (c) => c.json({ reached: true }, 202));
    const request = async () =>
      (await app.request(PATH, { method: 'POST', headers: { Origin: ORIGIN } }))
        .status;
    const pending = request();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Meanwhile the origin is shared and exposed through Funnel.
    (config.Web as Record<string, { Handlers: object }>)[
      `${host}:443`
    ]!.Handlers = {
      '/': { Proxy: 'http://127.0.0.1:3141' },
      '/evil': { Proxy: 'http://127.0.0.1:9000' },
    };
    config.AllowFunnel = { [`${host}:443`]: true };
    clock.now += 2_500;
    release({ exitCode: 0, stdout: '' });
    // Evidence 2.5 s old is past the 1 s bound: refused.
    expect(await pending).toBe(403);
    // 3.5 s after the evidence was taken: not admitted on it either.
    clock.now += 999;
    expect(await request()).toBe(403);
  });

  test('the wall clock moving back never makes old evidence fresh (the default clock is monotonic)', async () => {
    const config: Record<string, unknown> = {
      TCP: { 443: { HTTPS: true } },
      Web: {
        [`${HOST}:443`]: {
          Handlers: { '/': { Proxy: 'http://127.0.0.1:3141' } },
        },
      },
    };
    let release!: (stdout: string) => void;
    let first = true;
    // No injected clock: the production default.
    const resolver = createPublicIngressOriginResolver({
      localPorts: [3141],
      cli: async (args: readonly string[]) => {
        if (args[0] === 'status')
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              Self: { DNSName: `${HOST}.`, Online: true },
            }),
          };
        const stdout = JSON.stringify(config);
        if (!first) return { exitCode: 0, stdout };
        first = false;
        return new Promise((resolve) => {
          release = (value) => resolve({ exitCode: 0, stdout: value });
        });
      },
    });
    const pending = resolver.isOwnedOrigin(ORIGIN);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const owned = JSON.stringify(config);
    (config.Web as Record<string, { Handlers: object }>)[
      `${HOST}:443`
    ]!.Handlers = {
      '/': { Proxy: 'http://127.0.0.1:3141' },
      '/evil': { Proxy: 'http://127.0.0.1:9000' },
    };
    config.AllowFunnel = { [`${HOST}:443`]: true };
    const realNow = Date.now;
    const wall = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => realNow() - 500);
    try {
      // 1.1 s of real time passes while the wall clock is set back 0.5 s:
      // by the wall clock the evidence is 0.6 s old, by real time 1.1 s.
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      release(owned);
      expect(await pending).toBe(false);
      // Nor is that old answer served from the cache.
      expect(await resolver.isOwnedOrigin(ORIGIN)).toBe(false);
    } finally {
      wall.mockRestore();
    }
  });

  test('an injected clock that goes backwards expires trust rather than extending it', async () => {
    const h = harness();
    expect(await h.request()).toBe(202);
    expect(h.calls).toHaveLength(2);
    h.share();
    h.clock.now -= 60_000;
    expect(await h.request()).toBe(403);
    expect(h.calls).toHaveLength(4);
  });

  test('a burst of admissions shares one daemon read', async () => {
    const h = harness();
    const statuses = await Promise.all(
      Array.from({ length: 8 }, () => h.request()),
    );
    expect(statuses).toEqual(Array(8).fill(202));
    expect(h.calls).toEqual([
      ['status', '--json'],
      ['serve', 'status', '--json'],
    ]);
  });

  test('a daemon that does not answer in time refuses (fail closed)', async () => {
    const h = harness(() => new Promise(() => {}));
    expect(await h.request()).toBe(403);
  });
});
