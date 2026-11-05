/**
 * #4519 round 2, fix 1: a dynamic listener binds before its port can be
 * checked, so nothing may be served while managed admission is pending.
 * Each case drives a real listener (the browser egress proxy, the MCP Apps
 * frame origin, the isolated repair relay): a raw HTTP request is written
 * while admission is held open, and must get no byte back. Refused, the
 * connection is closed unanswered; admitted, the held request is answered.
 */
import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';
import {
  McpUiFrameAdmissionRefused,
  startMcpUiFrameServer,
} from '../../runtime/mcp/mcp-ui-frame-server.js';
import { authorityRelay } from '../../services/automation/repair-worker.mjs';
import { BrowserEgressProxy } from '../../services/browser/browser-egress-proxy.js';
import { deriveStationListeners } from '../../services/browser/station-listeners.js';
import { installManagedListenerAdmission } from '../managed-network-exposure.js';

interface Held {
  port: Promise<number>;
  admit: (listener: { port: number }) => Promise<void>;
  release: () => void;
  refuse: () => void;
}

/** An admission that records the bound port and waits to be settled. */
function heldAdmission(): Held {
  let bound!: (port: number) => void;
  let settle!: (admitted: boolean) => void;
  const port = new Promise<number>((resolve) => {
    bound = resolve;
  });
  const decision = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  return {
    port,
    admit: async ({ port: p }) => {
      bound(p);
      if (!(await decision)) throw new Error('refused by test admission');
    },
    release: () => settle(true),
    refuse: () => settle(false),
  };
}

interface Probe {
  socket: Socket;
  received: () => string;
  closed: Promise<void>;
}

/** Writes one raw request and records every byte that comes back. */
async function probe(port: number, request: string): Promise<Probe> {
  const socket = connect(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  let data = '';
  socket.on('data', (chunk) => {
    data += chunk.toString('latin1');
  });
  socket.on('error', () => {});
  const closed = new Promise<void>((resolve) =>
    socket.once('close', () => resolve()),
  );
  socket.write(request);
  return { socket, received: () => data, closed };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function answered(p: Probe): Promise<string> {
  for (let i = 0; i < 100 && !p.received().includes('HTTP/1.1'); i += 1)
    await pause(20);
  return p.received();
}

const proxyRequest = (target: string) =>
  `GET ${target} HTTP/1.1\r\nHost: ${new URL(target).host}\r\nConnection: keep-alive\r\n\r\n`;
const getRoot =
  'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n';
const relayPost =
  'POST /responses HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n';

function egressProxy() {
  return new BrowserEgressProxy({
    policy: {
      listeners: () =>
        deriveStationListeners({ serverPort: 1, configuredOrigins: [] }),
      interfaceAddresses: () => [],
      reach: { kind: 'operator' },
    },
  });
}

afterEach(() => installManagedListenerAdmission(undefined));

interface ListenerCase {
  name: string;
  request: string;
  /** Starts the listener with `held` as its admission. */
  start(held: Held): Promise<{ close(): Promise<void> }>;
}

const cases: ListenerCase[] = [
  {
    name: 'browser egress proxy',
    request: proxyRequest('http://example.invalid/'),
    async start(held) {
      installManagedListenerAdmission({
        localClientsOnly: true,
        admit: (listener) => held.admit(listener),
      });
      const proxy = egressProxy();
      await proxy.start();
      return proxy;
    },
  },
  {
    name: 'MCP Apps frame origin',
    request: getRoot,
    async start(held) {
      const frame = await startMcpUiFrameServer({
        port: 0,
        stationPort: 1,
        admit: (listener) => held.admit(listener),
      });
      if (!frame) throw new Error('frame server did not bind');
      return frame;
    },
  },
  {
    name: 'isolated repair relay',
    request: relayPost,
    async start(held) {
      return await authorityRelay(
        { baseUrl: 'http://127.0.0.1:9', capability: 'c', model: 'm' },
        async () => {},
        new AbortController().signal,
        { host: '127.0.0.1', admit: (port: number) => held.admit({ port }) },
      );
    },
  },
];

describe.each(cases)('$name while managed admission is pending', (listener) => {
  test('a request is not served, and is closed unanswered on refusal', async () => {
    const held = heldAdmission();
    const started = listener.start(held);
    started.catch(() => {});
    const port = await held.port;
    const p = await probe(port, listener.request);
    await pause(300);
    expect(p.received()).toBe('');

    held.refuse();
    await expect(started).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof McpUiFrameAdmissionRefused ||
        (error instanceof Error &&
          error.message === 'refused by test admission'),
    );
    await Promise.race([
      p.closed,
      pause(3_000).then(() => {
        throw new Error('held connection was not closed on refusal');
      }),
    ]);
    expect(p.received()).toBe('');
  });

  test('a request held during admission is answered once admitted', async () => {
    const held = heldAdmission();
    const started = listener.start(held);
    const port = await held.port;
    const p = await probe(port, listener.request);
    await pause(150);
    expect(p.received()).toBe('');
    held.release();
    const server = await started;
    try {
      expect(await answered(p)).toMatch(/^HTTP\/1\.1 \d{3}/);
    } finally {
      p.socket.destroy();
      await server.close();
    }
  });
});
