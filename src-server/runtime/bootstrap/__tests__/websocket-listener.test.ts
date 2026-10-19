// @vitest-environment node
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, type WebSocketServer } from 'ws';
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
});
