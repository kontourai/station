// @vitest-environment node
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, type WebSocketServer } from 'ws';
import {
  type DrainRequest,
  installListenerLink,
  type SupervisorChannelProcess,
  SupervisorLink,
} from '../supervisor-link.js';
import { startWebSocketListener } from '../websocket-listener.js';

const HOST = '127.0.0.1';
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listening(wss: WebSocketServer): Promise<number> {
  await once(wss, 'listening');
  return (wss.address() as net.AddressInfo).port;
}

function connectRefused(port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, HOST);
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('error', (error: NodeJS.ErrnoException) =>
      resolve(error.code ?? error.message),
    );
  });
}

describe('startWebSocketListener', () => {
  it('answers a non-upgrade request as ws does for a port it owns', async () => {
    const wss = startWebSocketListener('voice', { port: 0, host: HOST }, {});
    cleanups.push(() => new Promise((resolve) => wss.close(resolve)));
    const port = await listening(wss);
    const reply = await new Promise<{ status?: number; body: string }>(
      (resolve) => {
        http.get({ host: HOST, port, agent: false }, (res) => {
          let body = '';
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
      },
    );
    expect(reply).toEqual({ status: 426, body: 'Upgrade Required' });
  });

  it('stops listening on close even while a client is still connected', async () => {
    const wss = startWebSocketListener('voice', { port: 0, host: HOST }, {});
    const port = await listening(wss);
    const client = new WebSocket(`ws://${HOST}:${port}/`);
    cleanups.push(() => client.terminate());
    await once(client, 'open');
    wss.close();
    // The port is free at once, as with a ws-owned port, though the client
    // has not gone.
    await expect(connectRefused(port)).resolves.toBe('ECONNREFUSED');
    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  it('under a supervisor, lets a drain stop waiting for open WebSocket clients', async () => {
    const channel = Object.assign(new EventEmitter(), {
      env: {},
      connected: true,
      send: () => true,
      exit: () => {},
    }) as unknown as SupervisorChannelProcess & EventEmitter;
    const link = new SupervisorLink({
      process: channel,
      drainIdleGraceMs: 100,
      log: () => {},
    });
    installListenerLink(link);
    cleanups.push(() => installListenerLink(null));
    let settled: DrainRequest['connectionsSettled'] | undefined;
    link.onDrain((request) => {
      settled = request.connectionsSettled;
    });
    const wss = startWebSocketListener('terminal', { port: 0, host: HOST }, {});
    cleanups.push(() => new Promise((resolve) => wss.close(resolve)));
    const port = await listening(wss);
    const accepted = once(wss, 'connection');
    const client = new WebSocket(`ws://${HOST}:${port}/`);
    cleanups.push(() => client.terminate());
    await Promise.all([once(client, 'open'), accepted]);

    const drainedAt = Date.now();
    channel.emit('message', { type: 'drain', deadlineMs: 10_000 }, undefined);
    // The bound is 8s; an open WebSocket must not hold the drain that long.
    await expect(settled).resolves.toEqual({ lingering: 0 });
    expect(Date.now() - drainedAt).toBeLessThan(4_000);
    expect(client.readyState).toBe(WebSocket.OPEN);
  });

  it.each(['unsupervised', 'supervised'] as const)(
    'answers a late Upgrade request with 426 after close (%s)',
    async (mode) => {
      if (mode === 'supervised') {
        const channel = Object.assign(new EventEmitter(), {
          env: {},
          connected: true,
          send: () => true,
          exit: () => {},
        }) as unknown as SupervisorChannelProcess;
        installListenerLink(
          new SupervisorLink({ process: channel, log: () => {} }),
        );
        cleanups.push(() => installListenerLink(null));
      }
      const wss = startWebSocketListener('voice', { port: 0, host: HOST }, {});
      const port = await listening(wss);
      // A connection with a request still arriving survives the close.
      const socket = net.connect(port, HOST);
      cleanups.push(() => socket.destroy());
      await once(socket, 'connect');
      socket.write('GET / HTTP/1.1\r\nHost: x\r\n');
      await new Promise((resolve) => setTimeout(resolve, 50));
      wss.close();
      const reply = new Promise<string>((resolve, reject) => {
        let text = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk: string) => {
          text += chunk;
          if (text.includes('\r\n\r\n')) resolve(text);
        });
        socket.on('error', reject);
        socket.setTimeout(5_000, () =>
          reject(new Error(`no response to the Upgrade request: ${text}`)),
        );
      });
      socket.write('Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      await expect(reply).resolves.toMatch(/^HTTP\/1\.1 426/);
    },
  );
});
