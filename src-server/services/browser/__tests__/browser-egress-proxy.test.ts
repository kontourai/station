import { createServer, request, type Server } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import {
  BrowserEgressProxy,
  type EgressDecisionEvent,
} from '../browser-egress-proxy.js';
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

async function harness(options: { listeners?: () => StationListeners } = {}) {
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
  for (;;) {
    const dev = createServer((req, res) => {
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
    listeners: options.listeners ?? (() => listeners),
    interfaceAddresses: () => ['192.0.2.10'],
    lookup: async (hostname) => {
      if (hostname === 'rebind.test' || hostname === 'dev.test')
        return [{ address: '127.0.0.1' }];
      if (hostname === 'split.test')
        return [{ address: '93.184.216.34' }, { address: '127.0.0.1' }];
      throw new Error('ENOTFOUND');
    },
    onRefused: (event) => refused.push(event),
  });
  const proxyPort = await proxy.start();
  cleanups.push(() => proxy.close());
  return {
    stationPort,
    devPort,
    proxyPort,
    proxy,
    stationHits,
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
        },
        {
          host: 'split.test',
          port: h.stationPort,
          refusal: 'station-listener',
          address: '127.0.0.1',
        },
      ]),
    );
    const benign = await viaProxy(
      h.proxyPort,
      `http://dev.test:${h.devPort}/named`,
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
});
