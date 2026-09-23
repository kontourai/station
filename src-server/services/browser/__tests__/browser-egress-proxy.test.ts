import { createServer, request, type Server } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import {
  BrowserEgressProxy,
  type EgressDecisionEvent,
  type EgressLookup,
} from '../browser-egress-proxy.js';
import type { EgressReach, RegisteredLocalTarget } from '../egress-policy.js';
import {
  deriveStationListeners,
  type StationListeners,
} from '../station-listeners.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  );
  return (server.address() as AddressInfo).port;
}

async function harness(
  options: {
    listeners?: () => StationListeners;
    reach?: EgressReach;
    lookup?: EgressLookup;
    connectTimeoutMs?: number;
  } = {},
) {
  const stationHits: string[] = [];
  const station = createServer((req, res) => {
    stationHits.push(`http ${req.url}`);
    res.end('station');
  });
  station.on('upgrade', (req, socket) => {
    stationHits.push(`upgrade ${req.url}`);
    socket.destroy();
  });
  station.on('connection', (socket) =>
    stationHits.push(`tcp ${socket.remotePort}`),
  );
  const stationPort = await listen(station);
  // Ephemeral ports are often sequential: keep re-binding until the dev
  // server sits outside the Station block (server..consent = +0..+3).
  let devPort = 0;
  const devHits: string[] = [];
  for (;;) {
    const dev = createServer((req, res) => {
      devHits.push(`http ${req.url}`);
      res.setHeader('x-dev', 'yes');
      res.end(`dev ${req.method} ${req.url} host=${req.headers.host}`);
    });
    devPort = await listen(dev);
    if (devPort < stationPort || devPort > stationPort + 3) break;
  }
  const refused: EgressDecisionEvent[] = [];
  let listeners = deriveStationListeners({
    serverPort: stationPort,
    configuredOrigins: [],
  });
  const proxy = new BrowserEgressProxy({
    policy: {
      listeners: options.listeners ?? (() => listeners),
      interfaceAddresses: () => ['192.0.2.10'],
      reach: options.reach ?? { kind: 'operator' },
    },
    lookup:
      options.lookup ??
      (async (hostname) => {
        if (
          hostname === 'rebind.test' ||
          hostname === 'dev.test' ||
          hostname.endsWith('.localhost')
        )
          return [{ address: '127.0.0.1' }];
        if (hostname === 'split.test')
          return [{ address: '93.184.216.34' }, { address: '127.0.0.1' }];
        throw new Error('ENOTFOUND');
      }),
    onRefused: (event) => refused.push(event),
    ...(options.connectTimeoutMs
      ? { connectTimeoutMs: options.connectTimeoutMs }
      : {}),
  });
  const proxyPort = await proxy.start();
  cleanups.push(() => proxy.close());
  return {
    stationPort,
    devPort,
    proxyPort,
    proxy,
    stationHits,
    devHits,
    refused,
    setListeners: (next: StationListeners) => {
      listeners = next;
    },
  };
}

/** A plain-HTTP request sent through the proxy in absolute form. */
function viaProxy(
  proxyPort: number,
  url: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'GET',
      path: url,
      headers: { host: target.host },
    });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Open a CONNECT tunnel (how Chromium sends HTTPS and every WebSocket). */
function tunnel(
  proxyPort: number,
  authority: string,
): Promise<{ status: string; socket: ReturnType<typeof connect> }> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, '127.0.0.1', () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`,
      );
    });
    let head = '';
    const onData = (chunk: Buffer) => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.off('data', onData);
      resolve({ status: head.slice(0, head.indexOf('\r\n')), socket });
    };
    socket.on('data', onData);
    socket.on('error', reject);
  });
}

describe('BrowserEgressProxy', () => {
  test('forwards plain HTTP to a non-Station loopback port', async () => {
    const h = await harness();
    const response = await viaProxy(
      h.proxyPort,
      `http://127.0.0.1:${h.devPort}/page?x=1`,
    );
    expect(response).toEqual({
      status: 200,
      body: `dev GET /page?x=1 host=127.0.0.1:${h.devPort}`,
    });
  });

  test('refuses plain HTTP to every Station listener port without connecting', async () => {
    const h = await harness();
    for (const port of [
      h.stationPort,
      h.stationPort + 1,
      h.stationPort + 2,
      h.stationPort + 3,
    ]) {
      const response = await viaProxy(h.proxyPort, `http://127.0.0.1:${port}/`);
      expect(response.status).toBe(403);
    }
    expect(h.stationHits).toEqual([]);
    expect(h.refused.every((e) => e.refusal === 'station-listener')).toBe(true);
  });

  test('tunnels CONNECT to a non-Station port and refuses it to a Station port', async () => {
    const h = await harness();
    const allowed = await tunnel(h.proxyPort, `127.0.0.1:${h.devPort}`);
    expect(allowed.status).toBe('HTTP/1.1 200 Connection Established');
    // Bytes flow end to end through the tunnel.
    const reply = await new Promise<string>((resolve) => {
      allowed.socket.once('data', (chunk) => resolve(chunk.toString()));
      allowed.socket.write(
        `GET /tunnelled HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
      );
    });
    expect(reply).toContain('dev GET /tunnelled');
    allowed.socket.destroy();
    const refused = await tunnel(h.proxyPort, `127.0.0.1:${h.stationPort}`);
    expect(refused.status).toBe('HTTP/1.1 403 Forbidden');
    refused.socket.destroy();
    expect(h.stationHits).toEqual([]);
  });

  test('decides on the resolved address: a rebinding name to loopback is refused, a benign one allowed', async () => {
    const h = await harness();
    const rebind = await tunnel(h.proxyPort, `rebind.test:${h.stationPort}`);
    expect(rebind.status).toBe('HTTP/1.1 403 Forbidden');
    rebind.socket.destroy();
    // Any local address among several answers is enough to refuse.
    const split = await tunnel(h.proxyPort, `split.test:${h.stationPort}`);
    expect(split.status).toBe('HTTP/1.1 403 Forbidden');
    split.socket.destroy();
    expect(h.refused).toEqual(
      expect.arrayContaining([
        {
          host: 'rebind.test',
          port: h.stationPort,
          refusal: 'station-listener',
          address: '127.0.0.1',
          stage: 'resolved',
        },
        {
          host: 'split.test',
          port: h.stationPort,
          refusal: 'station-listener',
          address: '127.0.0.1',
          stage: 'resolved',
        },
      ]),
    );
    // A *.localhost name (resolved locally, not by a page owner's DNS) is fine.
    const benign = await viaProxy(
      h.proxyPort,
      `http://dev.localhost:${h.devPort}/named`,
    );
    expect(benign.status).toBe(200);
    expect(h.stationHits).toEqual([]);
  });

  test('LAN/tailnet addresses of this host are local too', async () => {
    const h = await harness();
    const decision = await h.proxy.resolveDestination(
      '192.0.2.10',
      h.stationPort,
    );
    expect(decision).toEqual({
      ok: false,
      refusal: 'station-listener',
      address: '192.0.2.10',
    });
    expect(
      await h.proxy.resolveDestination('192.0.2.11', h.stationPort),
    ).toEqual({
      ok: true,
      address: '192.0.2.11',
      requestedHost: '192.0.2.11',
    });
  });

  test('refuses a request aimed back at the proxy itself', async () => {
    const h = await harness();
    const response = await viaProxy(
      h.proxyPort,
      `http://127.0.0.1:${h.proxyPort}/`,
    );
    expect(response.status).toBe(403);
  });

  test('an unresolvable name fails closed with 502', async () => {
    const h = await harness();
    expect((await viaProxy(h.proxyPort, 'http://nowhere.test/')).status).toBe(
      502,
    );
    const connectRefused = await tunnel(h.proxyPort, 'nowhere.test:443');
    expect(connectRefused.status).toBe('HTTP/1.1 502 Bad Gateway');
    connectRefused.socket.destroy();
  });

  test('listener changes (another instance starting) apply to the next connection', async () => {
    const h = await harness();
    expect(
      (await viaProxy(h.proxyPort, `http://127.0.0.1:${h.devPort}/`)).status,
    ).toBe(200);
    h.setListeners(
      deriveStationListeners({
        serverPort: h.stationPort,
        configuredOrigins: [],
        otherInstances: [{ port: h.devPort }],
      }),
    );
    expect(
      (await viaProxy(h.proxyPort, `http://127.0.0.1:${h.devPort}/`)).status,
    ).toBe(403);
  });

  test('origin-form requests (a direct, non-proxy client) are refused', async () => {
    const h = await harness();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: h.proxyPort, path: '/' });
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(400);
  });

  test('review H1: IPv4-mapped spellings of loopback are refused (hex, expanded, dotted)', async () => {
    const h = await harness();
    for (const host of [
      '[::ffff:127.0.0.1]',
      '[::ffff:7f00:1]',
      '[0:0:0:0:0:ffff:7f00:1]',
      '[::127.0.0.1]',
    ]) {
      const refused = await tunnel(h.proxyPort, `${host}:${h.stationPort}`);
      expect(refused.status, host).toBe('HTTP/1.1 403 Forbidden');
      refused.socket.destroy();
      expect(
        (await viaProxy(h.proxyPort, `http://${host}:${h.stationPort}/`))
          .status,
        host,
      ).toBe(403);
    }
    expect(h.stationHits).toEqual([]);
  });

  test('review M2: the proxy dials the address it checked, never a re-resolution', async () => {
    // localhost names never reach the resolver, so this uses an ordinary
    // name. The checked (first) answer is a public, unroutable TEST-NET
    // address; a re-resolution would get loopback and reach the dev server.
    let calls = 0;
    const h = await harness({
      connectTimeoutMs: 300,
      lookup: async () => {
        calls += 1;
        return [{ address: calls === 1 ? '192.0.2.1' : '127.0.0.1' }];
      },
    });
    const result = await tunnel(h.proxyPort, `flip.test:${h.devPort}`);
    result.socket.destroy();
    expect(result.status).toBe('HTTP/1.1 502 Bad Gateway');
    expect(calls).toBe(1);
    expect(h.devHits).toEqual([]);
  });

  test('review H1: the CONNECTED address is re-checked before a byte is written', async () => {
    // Listener set that changes between the resolve check and the connect
    // check stands in for any gap between parser and kernel.
    let reads = 0;
    let devPort = 0;
    const h = await harness({
      listeners: () => {
        reads += 1;
        return { ports: reads === 1 ? [] : [devPort], hostnames: [] };
      },
    });
    devPort = h.devPort;
    const refused = await tunnel(h.proxyPort, `127.0.0.1:${h.devPort}`);
    expect(refused.status).toBe('HTTP/1.1 403 Forbidden');
    refused.socket.destroy();
    reads = 0;
    expect(
      (await viaProxy(h.proxyPort, `http://127.0.0.1:${h.devPort}/late`))
        .status,
    ).toBe(403);
    expect(h.devHits).toEqual([]);
    expect(h.refused.map((e) => [e.refusal, e.stage])).toEqual([
      ['station-listener', 'connected'],
      ['station-listener', 'connected'],
    ]);
  });

  test('D7: a Project profile reaches loopback only through a registered target', async () => {
    const targets: RegisteredLocalTarget[] = [];
    const h = await harness({
      reach: { kind: 'project', localTargets: () => targets },
    });
    expect(
      (await viaProxy(h.proxyPort, `http://127.0.0.1:${h.devPort}/`)).status,
    ).toBe(403);
    expect(
      (await viaProxy(h.proxyPort, `http://dev.test:${h.devPort}/`)).status,
    ).toBe(403);
    expect(h.refused.map((e) => e.refusal)).toEqual([
      'non-public-address',
      'hostname-to-non-public',
    ]);
    targets.push({ host: 'localhost', port: h.devPort });
    expect(
      (await viaProxy(h.proxyPort, `http://127.0.0.1:${h.devPort}/ok`)).status,
    ).toBe(200);
    expect(h.devHits).toEqual(['http /ok']);
  });

  test('round 2: an ordinary hostname rebound to loopback is refused for the operator too', async () => {
    const h = await harness(); // operator reach
    expect(
      (await viaProxy(h.proxyPort, `http://dev.test:${h.devPort}/rebound`))
        .status,
    ).toBe(403);
    const tunnelled = await tunnel(h.proxyPort, `dev.test:${h.devPort}`);
    expect(tunnelled.status).toBe('HTTP/1.1 403 Forbidden');
    tunnelled.socket.destroy();
    expect(h.devHits).toEqual([]);
    expect(h.refused.map((e) => [e.host, e.refusal])).toEqual([
      ['dev.test', 'hostname-to-non-public'],
      ['dev.test', 'hostname-to-non-public'],
    ]);
    // The same service by IP literal or *.localhost stays reachable.
    expect(
      (await viaProxy(h.proxyPort, `http://127.0.0.1:${h.devPort}/ip`)).status,
    ).toBe(200);
    expect(
      (await viaProxy(h.proxyPort, `http://app.localhost:${h.devPort}/name`))
        .status,
    ).toBe(200);
  });

  test('round 2: a registered target is not reachable through a rebinding name', async () => {
    const targets: RegisteredLocalTarget[] = [];
    const h = await harness({
      reach: { kind: 'project', localTargets: () => targets },
    });
    targets.push({ host: 'localhost', port: h.devPort });
    expect(
      (await viaProxy(h.proxyPort, `http://127.0.0.1:${h.devPort}/ok`)).status,
    ).toBe(200);
    expect(
      (await viaProxy(h.proxyPort, `http://dev.test:${h.devPort}/rebound`))
        .status,
    ).toBe(403);
    expect(h.devHits).toEqual(['http /ok']);
  });

  test('nit: localhost and *.localhost map to loopback in the proxy, never via the resolver', async () => {
    const asked: string[] = [];
    const h = await harness({
      // A wrongly dialed public answer fails fast instead of hanging.
      connectTimeoutMs: 300,
      lookup: async (hostname) => {
        asked.push(hostname);
        // A resolver that forwards .localhost upstream, to a page owner's DNS.
        return [{ address: '93.184.216.34' }];
      },
    });
    for (const host of [
      'x.localhost',
      'localhost',
      'localhost.',
      'x.localhost.',
    ]) {
      const response = await viaProxy(
        h.proxyPort,
        `http://${host}:${h.devPort}/lh`,
      );
      expect(response.status, host).toBe(200);
    }
    expect(asked).toEqual([]);
    expect(h.devHits).toEqual(['http /lh', 'http /lh', 'http /lh', 'http /lh']);
  });
});
