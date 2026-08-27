import { describe, expect, test, vi } from 'vitest';
import {
  resolveTailscaleOfferEndpoint,
  type TailscaleCommand,
} from '../commands/tailscale-serve.js';

const LOCAL_API = 'http://127.0.0.1:43141';
const ORIGIN = 'https://station.tailnet.ts.net';
const ENVIRONMENT_ID = 'environment-local';

function status() {
  return JSON.stringify({
    Self: { DNSName: 'station.tailnet.ts.net.', Online: true },
  });
}

function emptyServe() {
  return JSON.stringify({ Web: {} });
}

function serveTo(proxy: string) {
  return JSON.stringify({
    Web: {
      'station.tailnet.ts.net:443': {
        Handlers: { '/': { Proxy: proxy } },
      },
    },
  });
}

function canonicalHttpsServeTo(proxy: string) {
  return JSON.stringify({
    TCP: { '443': { HTTPS: true } },
    Web: {
      'station.tailnet.ts.net:443': {
        Handlers: { '/': { Proxy: proxy } },
      },
    },
  });
}

function commandWith(serveStatus: string): TailscaleCommand & {
  calls: string[][];
} {
  const calls: string[][] = [];
  const command = (async (args) => {
    calls.push([...args]);
    if (args[0] === 'status')
      return { exitCode: 0, stdout: status(), stderr: '' };
    if (args[0] === 'serve' && args[1] === 'status') {
      return { exitCode: 0, stdout: serveStatus, stderr: '' };
    }
    if (args[0] === 'serve') return { exitCode: 0, stdout: '', stderr: '' };
    throw new Error(`unexpected tailscale args: ${args.join(' ')}`);
  }) as TailscaleCommand & { calls: string[][] };
  command.calls = calls;
  return command;
}

describe('Tailscale Serve pairing endpoint', () => {
  test('publishes a missing HTTPS mapping to the current Station server port', async () => {
    const command = commandWith(emptyServe());

    const result = await resolveTailscaleOfferEndpoint({
      localApiBase: LOCAL_API,
      environmentId: ENVIRONMENT_ID,
      dependencies: { command, probe: async () => 'unreachable' },
    });

    expect(result).toEqual({ endpoint: ORIGIN, configured: true });
    expect(command.calls).toContainEqual([
      'serve',
      '--bg',
      '--https=443',
      'http://127.0.0.1:43141',
    ]);
  });

  test('preserves an IPv6 loopback publish target', async () => {
    const command = commandWith(emptyServe());
    await resolveTailscaleOfferEndpoint({
      localApiBase: 'http://[::1]:43141',
      environmentId: ENVIRONMENT_ID,
      dependencies: { command, probe: async () => 'unreachable' },
    });
    expect(command.calls.at(-1)).toEqual([
      'serve',
      '--bg',
      '--https=443',
      'http://[::1]:43141',
    ]);
  });

  test.each([8441, 8442, 8444])(
    'publishes and returns alternate HTTPS port %i',
    async (servePort) => {
      const command = commandWith(emptyServe());
      const result = await resolveTailscaleOfferEndpoint({
        localApiBase: LOCAL_API,
        environmentId: ENVIRONMENT_ID,
        servePort,
        dependencies: { command, probe: async () => 'unreachable' },
      });
      expect(result).toEqual({
        endpoint: `${ORIGIN}:${servePort}`,
        configured: true,
      });
      expect(command.calls).toContainEqual([
        'serve',
        '--bg',
        `--https=${servePort}`,
        'http://127.0.0.1:43141',
      ]);
    },
  );

  test('leaves a nonselected HTTPS listener untouched', async () => {
    const command = commandWith(serveTo(LOCAL_API));
    await resolveTailscaleOfferEndpoint({
      localApiBase: LOCAL_API,
      environmentId: ENVIRONMENT_ID,
      servePort: 8444,
      dependencies: { command, probe: async () => 'unreachable' },
    });
    expect(command.calls.at(-1)).toEqual([
      'serve',
      '--bg',
      '--https=8444',
      'http://127.0.0.1:43141',
    ]);
  });

  test('refuses a Funnel mapping on the selected listener', async () => {
    const command = commandWith(
      JSON.stringify({
        Web: {
          'station.tailnet.ts.net:8444': {
            Handlers: { '/': { Proxy: LOCAL_API } },
          },
        },
        AllowFunnel: { 'station.tailnet.ts.net:8444': true },
      }),
    );
    await expect(
      resolveTailscaleOfferEndpoint({
        localApiBase: LOCAL_API,
        environmentId: ENVIRONMENT_ID,
        servePort: 8444,
        dependencies: { command, probe: async () => 'same-station' },
      }),
    ).rejects.toThrow(/foreign or unrecognized/);
    expect(command.calls).toHaveLength(2);
  });

  test('refuses case-variant selected Funnel entries', async () => {
    const command = commandWith(
      JSON.stringify({
        Web: {
          'station.tailnet.ts.net:8444': {
            Handlers: { '/': { Proxy: LOCAL_API } },
          },
        },
        AllowFunnel: {
          'station.tailnet.ts.net:8444': false,
          'STATION.TAILNET.TS.NET:8444': true,
        },
      }),
    );
    await expect(
      resolveTailscaleOfferEndpoint({
        localApiBase: LOCAL_API,
        environmentId: ENVIRONMENT_ID,
        servePort: 8444,
        dependencies: { command, probe: async () => 'same-station' },
      }),
    ).rejects.toThrow(/foreign or unrecognized/);
    expect(command.calls).toHaveLength(2);
  });

  test.each([0, -1, 65_536, 1.5])(
    'rejects invalid alternate HTTPS port %s before effects',
    async (servePort) => {
      const command = commandWith(emptyServe());
      await expect(
        resolveTailscaleOfferEndpoint({
          localApiBase: LOCAL_API,
          environmentId: ENVIRONMENT_ID,
          servePort,
          dependencies: { command },
        }),
      ).rejects.toThrow(/1 through 65535/);
      expect(command.calls).toHaveLength(0);
    },
  );

  test('keeps a reachable mapping that already proxies to this Station', async () => {
    const command = commandWith(serveTo(`${LOCAL_API}/`));

    const result = await resolveTailscaleOfferEndpoint({
      localApiBase: LOCAL_API,
      environmentId: ENVIRONMENT_ID,
      dependencies: { command, probe: async () => 'same-station' },
    });

    expect(result).toEqual({ endpoint: ORIGIN, configured: false });
    expect(command.calls).toHaveLength(2);
  });

  test('recognizes the canonical TCP HTTPS companion for an exact Web proxy', async () => {
    const command = commandWith(canonicalHttpsServeTo(`${LOCAL_API}/`));

    const result = await resolveTailscaleOfferEndpoint({
      localApiBase: LOCAL_API,
      environmentId: ENVIRONMENT_ID,
      dependencies: { command, probe: async () => 'same-station' },
    });

    expect(result).toEqual({ endpoint: ORIGIN, configured: false });
    expect(command.calls).toHaveLength(2);
  });

  test('refuses an unrecognized TCP 443 entry even when the Web proxy matches', async () => {
    const command = commandWith(
      JSON.stringify({
        TCP: { '443': { HTTPS: true, TCPForward: '127.0.0.1:22' } },
        Web: {
          'station.tailnet.ts.net:443': {
            Handlers: { '/': { Proxy: LOCAL_API } },
          },
        },
      }),
    );

    await expect(
      resolveTailscaleOfferEndpoint({
        localApiBase: LOCAL_API,
        environmentId: ENVIRONMENT_ID,
        dependencies: { command, probe: async () => 'same-station' },
      }),
    ).rejects.toThrow(/foreign or unrecognized mapping/);
  });

  test('refuses a TCP-only HTTPS listener instead of overwriting it', async () => {
    const command = commandWith(
      JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: {} }),
    );

    await expect(
      resolveTailscaleOfferEndpoint({
        localApiBase: LOCAL_API,
        environmentId: ENVIRONMENT_ID,
        dependencies: { command, probe: async () => 'unreachable' },
      }),
    ).rejects.toThrow(/foreign or unrecognized mapping/);
    expect(command.calls).toHaveLength(2);
  });

  test('refuses a matching root proxy with a shadowing path handler', async () => {
    const command = commandWith(
      JSON.stringify({
        TCP: { '443': { HTTPS: true } },
        Web: {
          'station.tailnet.ts.net:443': {
            Handlers: {
              '/': { Proxy: LOCAL_API },
              '/api/pairing': { Proxy: 'http://127.0.0.1:5000' },
            },
          },
        },
      }),
    );

    await expect(
      resolveTailscaleOfferEndpoint({
        localApiBase: LOCAL_API,
        environmentId: ENVIRONMENT_ID,
        dependencies: { command, probe: async () => 'same-station' },
      }),
    ).rejects.toThrow(/foreign or unrecognized mapping/);
  });

  test('refuses duplicate case-variant listeners for the same HTTPS origin', async () => {
    const command = commandWith(
      JSON.stringify({
        TCP: { '443': { HTTPS: true } },
        Web: {
          'station.tailnet.ts.net:443': {
            Handlers: { '/': { Proxy: LOCAL_API } },
          },
          'STATION.TAILNET.TS.NET:443': {
            Handlers: { '/': { Proxy: LOCAL_API } },
          },
        },
      }),
    );

    await expect(
      resolveTailscaleOfferEndpoint({
        localApiBase: LOCAL_API,
        environmentId: ENVIRONMENT_ID,
        dependencies: { command, probe: async () => 'same-station' },
      }),
    ).rejects.toThrow(/foreign or unrecognized mapping/);
  });

  test('accepts a UI-proxy mapping when the live endpoint proves this Station (#2284)', async () => {
    // The real desktop-win topology: Serve fronts the UI listener (3000),
    // which itself proxies API routes — so the public origin answers the
    // Station identity handshake while the proxy target is NOT the API port.
    // Live identity is the stronger proof; the working publication must be
    // left untouched and the offer minted anyway.
    const command = commandWith(serveTo('http://127.0.0.1:3000'));

    const result = await resolveTailscaleOfferEndpoint({
      localApiBase: LOCAL_API,
      environmentId: ENVIRONMENT_ID,
      dependencies: { command, probe: async () => 'same-station' },
    });

    expect(result.configured).toBe(false);
    // Exactly status + serve-status: NO serve --bg was issued, so the UI
    // publication was not replaced with a bare API mapping.
    expect(command.calls).toHaveLength(2);
    expect(command.calls.some((call) => call.includes('--bg'))).toBe(false);
  });

  test('still refuses an identity-mismatched UI-proxy mapping', async () => {
    // The other direction of the same rule: port mismatch AND no live
    // identity proof stays fail-closed exactly as before.
    const command = commandWith(serveTo('http://127.0.0.1:3000'));

    await expect(
      resolveTailscaleOfferEndpoint({
        localApiBase: LOCAL_API,
        environmentId: ENVIRONMENT_ID,
        dependencies: { command, probe: async () => 'unreachable' },
      }),
    ).rejects.toThrow(/not provably this Station/);
    expect(command.calls.some((call) => call.includes('--bg'))).toBe(false);
  });

  test('repairs an unreachable mapping only when it is already this exact Station target', async () => {
    const command = commandWith(serveTo(LOCAL_API));

    await resolveTailscaleOfferEndpoint({
      localApiBase: LOCAL_API,
      environmentId: ENVIRONMENT_ID,
      dependencies: { command, probe: async () => 'unreachable' },
    });

    expect(command.calls.at(-1)).toEqual([
      'serve',
      '--bg',
      '--https=443',
      'http://127.0.0.1:43141',
    ]);
  });

  test('refuses an unreachable proxy that targets a different local service', async () => {
    const command = commandWith(serveTo('http://127.0.0.1:5000'));

    await expect(
      resolveTailscaleOfferEndpoint({
        localApiBase: LOCAL_API,
        environmentId: ENVIRONMENT_ID,
        dependencies: { command, probe: async () => 'unreachable' },
      }),
    ).rejects.toThrow(/not provably this Station/);
    expect(command.calls).toHaveLength(2);
  });

  test('refuses a foreign mapping without leaking command stderr', async () => {
    const command = commandWith(serveTo('http://127.0.0.1:5000'));

    await expect(
      resolveTailscaleOfferEndpoint({
        localApiBase: LOCAL_API,
        environmentId: ENVIRONMENT_ID,
        dependencies: { command, probe: async () => 'different-station' },
      }),
    ).rejects.toThrow(/different Station environment/);
    expect(command.calls).toHaveLength(2);
  });

  test('fails loudly when status lacks a usable MagicDNS name', async () => {
    const command = vi.fn(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ Self: { Online: true } }),
      stderr: 'sensitive diagnostic text',
    }));

    await expect(
      resolveTailscaleOfferEndpoint({
        localApiBase: LOCAL_API,
        environmentId: ENVIRONMENT_ID,
        dependencies: { command, probe: async () => 'unreachable' },
      }),
    ).rejects.toThrow(/MagicDNS is unavailable/);
  });
});
