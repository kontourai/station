import { describe, expect, test } from 'vitest';
import {
  createPublicIngressOriginResolver,
  parseMagicDnsHost,
  parseServePublicOrigin,
  type TailscaleCliResult,
} from '../public-ingress-origin.js';

/**
 * Captured verbatim from `tailscale status --json` / `tailscale serve status
 * --json` on a real node (fields this code does not read are trimmed). The
 * shapes are the contract: a hand-invented fixture would prove only that the
 * parser matches itself.
 */
const STATUS_JSON = JSON.stringify({
  Self: { DNSName: 'kontour.python-smelt.ts.net.', Online: true },
});

const SERVE_JSON = JSON.stringify({
  TCP: { '443': { HTTPS: true }, '8090': { HTTPS: true } },
  Web: {
    'kontour.python-smelt.ts.net:443': {
      Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } },
    },
    'kontour.python-smelt.ts.net:8090': {
      Handlers: { '/': { Proxy: 'http://127.0.0.1:8080' } },
    },
  },
});

describe('parseMagicDnsHost', () => {
  test('reads the node name and drops the trailing dot', () => {
    expect(parseMagicDnsHost(STATUS_JSON)).toBe('kontour.python-smelt.ts.net');
  });

  test('refuses a node that is offline, unnamed, or not a ts.net host', () => {
    // Each is a case where publishing an endpoint would hand a device an
    // address that does not belong to this node.
    expect(
      parseMagicDnsHost(
        JSON.stringify({
          Self: { DNSName: 'kontour.python-smelt.ts.net.', Online: false },
        }),
      ),
    ).toBeUndefined();
    expect(parseMagicDnsHost(JSON.stringify({ Self: {} }))).toBeUndefined();
    expect(
      parseMagicDnsHost(
        JSON.stringify({ Self: { DNSName: 'evil.example.com.' } }),
      ),
    ).toBeUndefined();
    expect(parseMagicDnsHost('not json')).toBeUndefined();
    expect(parseMagicDnsHost(JSON.stringify({}))).toBeUndefined();
  });
});

describe('parseServePublicOrigin', () => {
  const host = 'kontour.python-smelt.ts.net';

  test('finds the origin serving the UI proxy port', () => {
    // The topology that actually ships: serve fronts the UI proxy, which
    // forwards the pairing paths to the API.
    expect(parseServePublicOrigin(SERVE_JSON, host, [3141, 3000])).toBe(
      'https://kontour.python-smelt.ts.net',
    );
  });

  test('finds the origin serving the API port directly', () => {
    const serve = JSON.stringify({
      Web: {
        [`${host}:443`]: {
          Handlers: { '/': { Proxy: 'http://127.0.0.1:3141' } },
        },
      },
    });
    expect(parseServePublicOrigin(serve, host, [3141, 3000])).toBe(
      'https://kontour.python-smelt.ts.net',
    );
  });

  test('keeps a non-default serve port in the origin', () => {
    const serve = JSON.stringify({
      Web: {
        [`${host}:8443`]: {
          Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } },
        },
      },
    });
    expect(parseServePublicOrigin(serve, host, [3000])).toBe(
      'https://kontour.python-smelt.ts.net:8443',
    );
  });

  test('ignores mappings that are not this Station', () => {
    // A serve config routinely carries unrelated mappings; claiming one of
    // them would publish another service's address as a pairing endpoint.
    expect(parseServePublicOrigin(SERVE_JSON, host, [3141])).toBeUndefined();
  });

  test('ignores a mapping published for a different host', () => {
    const serve = JSON.stringify({
      Web: {
        'other-node.python-smelt.ts.net:443': {
          Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } },
        },
      },
    });
    expect(parseServePublicOrigin(serve, host, [3000])).toBeUndefined();
  });

  test('ignores a mapping that only serves a subpath', () => {
    // The device resolves pairing paths against the origin, so a prefixed
    // mount would send it somewhere that does not answer.
    const serve = JSON.stringify({
      Web: {
        [`${host}:443`]: {
          Handlers: { '/station': { Proxy: 'http://127.0.0.1:3000' } },
        },
      },
    });
    expect(parseServePublicOrigin(serve, host, [3000])).toBeUndefined();
  });

  test('ignores a proxy target that is not loopback', () => {
    const serve = JSON.stringify({
      Web: {
        [`${host}:443`]: {
          Handlers: { '/': { Proxy: 'http://10.0.0.5:3000' } },
        },
      },
    });
    expect(parseServePublicOrigin(serve, host, [3000])).toBeUndefined();
  });

  test('prefers the default HTTPS port when several listeners reach it', () => {
    const serve = JSON.stringify({
      Web: {
        [`${host}:8443`]: {
          Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } },
        },
        [`${host}:443`]: {
          Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } },
        },
      },
    });
    expect(parseServePublicOrigin(serve, host, [3000])).toBe(
      'https://kontour.python-smelt.ts.net',
    );
  });

  test('survives malformed serve output', () => {
    expect(parseServePublicOrigin('not json', host, [3000])).toBeUndefined();
    expect(
      parseServePublicOrigin(JSON.stringify({}), host, [3000]),
    ).toBeUndefined();
  });
});

describe('createPublicIngressOriginResolver', () => {
  function cliFrom(
    responses: Record<string, TailscaleCliResult>,
    calls: string[][] = [],
  ) {
    return {
      calls,
      cli: async (args: readonly string[]) => {
        calls.push([...args]);
        return responses[args.join(' ')] ?? { stdout: '', exitCode: 1 };
      },
    };
  }

  const ok = {
    'status --json': { stdout: STATUS_JSON, exitCode: 0 },
    'serve status --json': { stdout: SERVE_JSON, exitCode: 0 },
  } satisfies Record<string, TailscaleCliResult>;

  test('resolves the origin from the daemon', async () => {
    const { cli } = cliFrom(ok);
    const resolver = createPublicIngressOriginResolver({
      localPorts: [3141, 3000],
      cli,
    });
    await expect(resolver.resolve()).resolves.toBe(
      'https://kontour.python-smelt.ts.net',
    );
  });

  test('caches within the TTL and re-reads after it', async () => {
    // An operator can change `tailscale serve` while Station runs, so a value
    // pinned forever would go silently stale; a value never cached would
    // spawn two processes per pairing request.
    const calls: string[][] = [];
    const { cli } = cliFrom(ok, calls);
    let clock = 1_000;
    const resolver = createPublicIngressOriginResolver({
      localPorts: [3000],
      cli,
      ttlMs: 30_000,
      now: () => clock,
    });
    await resolver.resolve();
    await resolver.resolve();
    expect(calls).toHaveLength(2);
    clock += 30_001;
    await resolver.resolve();
    expect(calls).toHaveLength(4);
  });

  test('caches an unresolved lookup too, so an absent CLI is not re-spawned', async () => {
    const calls: string[][] = [];
    const { cli } = cliFrom(
      { 'status --json': { stdout: '', exitCode: null } },
      calls,
    );
    const resolver = createPublicIngressOriginResolver({
      localPorts: [3000],
      cli,
      now: () => 5_000,
    });
    await expect(resolver.resolve()).resolves.toBeUndefined();
    await expect(resolver.resolve()).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  test('never throws when the CLI misbehaves', async () => {
    const resolver = createPublicIngressOriginResolver({
      localPorts: [3000],
      cli: async () => {
        throw new Error('spawn EPERM');
      },
    });
    await expect(resolver.resolve()).resolves.toBeUndefined();
  });

  test('collapses concurrent lookups into one', async () => {
    const calls: string[][] = [];
    const { cli } = cliFrom(ok, calls);
    const resolver = createPublicIngressOriginResolver({
      localPorts: [3000],
      cli,
      now: () => 0,
    });
    const [first, second] = await Promise.all([
      resolver.resolve(),
      resolver.resolve(),
    ]);
    expect(first).toBe('https://kontour.python-smelt.ts.net');
    expect(second).toBe(first);
    expect(calls).toHaveLength(2);
  });
});
