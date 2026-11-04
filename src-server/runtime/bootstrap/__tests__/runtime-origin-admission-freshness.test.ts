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
