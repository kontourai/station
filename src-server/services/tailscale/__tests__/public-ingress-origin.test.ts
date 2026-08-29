import { describe, expect, test } from 'vitest';
import {
  createPublicIngressOriginResolver,
  createTailscaleCli,
  parseMagicDnsHost,
  parseServePublicOrigin,
  parseServePublicOrigins,
  TAILSCALE_MACOS_APP_CLI,
  type TailscaleCliResult,
  tailscaleCliExecutableCandidates,
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

  test('retains every daemon-validated listener targeting the same local port', () => {
    // A live node may deliberately publish several HTTPS listeners for one
    // Station server. The direct route must match its exact Host rather than
    // silently selecting the canonical first listener.
    const serve = JSON.stringify({
      Web: {
        [`${host}:8444`]: {
          Handlers: { '/': { Proxy: 'http://127.0.0.1:38141' } },
        },
        [`${host}:3773`]: {
          Handlers: { '/': { Proxy: 'http://127.0.0.1:38141' } },
        },
      },
    });

    expect(parseServePublicOrigins(serve, host, [38141])).toEqual([
      'https://kontour.python-smelt.ts.net:3773',
      'https://kontour.python-smelt.ts.net:8444',
    ]);
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
    await expect(resolver.resolve()).resolves.toEqual([
      'https://kontour.python-smelt.ts.net',
    ]);
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
    expect(first).toEqual(['https://kontour.python-smelt.ts.net']);
    expect(second).toBe(first);
    expect(calls).toHaveLength(2);
  });
});

describe('Tailscale CLI executable discovery', () => {
  test('tries the official macOS app-bundle binary before the ordinary PATH command', () => {
    expect(tailscaleCliExecutableCandidates('darwin')).toEqual([
      TAILSCALE_MACOS_APP_CLI,
      'tailscale',
    ]);
    expect(tailscaleCliExecutableCandidates('linux')).toEqual(['tailscale']);
  });

  test('uses the official macOS app-bundle binary when the GUI PATH has no tailscale command', async () => {
    const calls: string[] = [];
    const cli = createTailscaleCli({
      platform: 'darwin',
      execute: async (executable) => {
        calls.push(executable);
        return { stdout: STATUS_JSON, exitCode: 0 };
      },
    });

    await expect(cli(['status', '--json'])).resolves.toEqual({
      stdout: STATUS_JSON,
      exitCode: 0,
    });
    expect(calls).toEqual([TAILSCALE_MACOS_APP_CLI]);
  });

  test.each([
    ['missing', { stdout: '', exitCode: null }],
    ['non-executable', { stdout: '', exitCode: null }],
    ['timed out', { stdout: '', exitCode: null }],
    ['non-zero', { stdout: 'daemon unavailable', exitCode: 1 }],
  ] as const)(
    'falls back from a %s official candidate and remains fail-closed when PATH also fails',
    async (_label, official) => {
      const calls: string[] = [];
      const cli = createTailscaleCli({
        platform: 'darwin',
        execute: async (executable) => {
          calls.push(executable);
          return executable === TAILSCALE_MACOS_APP_CLI
            ? official
            : { stdout: '', exitCode: null };
        },
      });

      await expect(cli(['status', '--json'])).resolves.toEqual({
        stdout: '',
        exitCode: null,
      });
      expect(calls).toEqual([TAILSCALE_MACOS_APP_CLI, 'tailscale']);
    },
  );

  test('falls back to the ordinary PATH installation without executing any caller-controlled candidate', async () => {
    const calls: string[] = [];
    const cli = createTailscaleCli({
      platform: 'darwin',
      execute: async (executable) => {
        calls.push(executable);
        return executable === TAILSCALE_MACOS_APP_CLI
          ? { stdout: '', exitCode: null }
          : { stdout: STATUS_JSON, exitCode: 0 };
      },
    });

    await expect(cli(['status', '--json'])).resolves.toEqual({
      stdout: STATUS_JSON,
      exitCode: 0,
    });
    expect(calls).toEqual([TAILSCALE_MACOS_APP_CLI, 'tailscale']);
  });

  test('resolves a real Serve origin through PATH fallback when the app-bundle command is unavailable', async () => {
    const calls: string[] = [];
    const cli = createTailscaleCli({
      platform: 'darwin',
      execute: async (executable, args) => {
        calls.push(`${executable} ${args.join(' ')}`);
        if (executable === TAILSCALE_MACOS_APP_CLI)
          return { stdout: '', exitCode: null };
        return args[0] === 'status'
          ? { stdout: STATUS_JSON, exitCode: 0 }
          : { stdout: SERVE_JSON, exitCode: 0 };
      },
    });
    const resolver = createPublicIngressOriginResolver({
      localPorts: [3141, 3000],
      cli,
    });

    await expect(resolver.resolve()).resolves.toEqual([
      'https://kontour.python-smelt.ts.net',
    ]);
    expect(calls).toEqual([
      `${TAILSCALE_MACOS_APP_CLI} status --json`,
      'tailscale status --json',
      `${TAILSCALE_MACOS_APP_CLI} serve status --json`,
      'tailscale serve status --json',
    ]);
  });

  test('fails closed on malformed successful CLI output instead of treating another executable as its result', async () => {
    const calls: string[] = [];
    const cli = createTailscaleCli({
      platform: 'darwin',
      execute: async (executable) => {
        calls.push(executable);
        return executable === TAILSCALE_MACOS_APP_CLI
          ? { stdout: 'not json', exitCode: 0 }
          : { stdout: STATUS_JSON, exitCode: 0 };
      },
    });
    const resolver = createPublicIngressOriginResolver({
      localPorts: [3000],
      cli,
    });

    await expect(resolver.resolve()).resolves.toBeUndefined();
    expect(calls).toEqual([TAILSCALE_MACOS_APP_CLI]);
  });

  test('returns no successful result when an executor throws', async () => {
    const cli = createTailscaleCli({
      platform: 'darwin',
      execute: async () => {
        throw new Error('hostile executor');
      },
    });

    await expect(cli(['status', '--json'])).resolves.toEqual({
      stdout: '',
      exitCode: null,
    });
  });
});
