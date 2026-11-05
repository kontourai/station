/**
 * Ownership of a Tailscale Serve origin is a security admission, so the
 * runtime origin gate must not keep admitting it on a stale answer after the
 * operator shares the origin with another service or turns Funnel on.
 *
 * Drives the real route-classification gate with the production resolver
 * and origin policy; only the `tailscale` CLI and the clock are faked.
 */
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
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
