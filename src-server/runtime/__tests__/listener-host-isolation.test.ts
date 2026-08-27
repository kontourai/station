import * as crypto from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer, type Server, Socket } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import * as path from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import {
  UI_MIME_TYPES,
  UI_PROXY_BACKEND_PREFIXES,
  uiRequestHandler,
} from '../../../packages/cli/src/commands/lifecycle.js';
import { attachVoiceWebSocket } from '../../routes/operations/voice.js';
import { TerminalWebSocketServer } from '../../services/terminal/terminal-ws-server.js';

const LOOPBACK = '127.0.0.1';
const CONNECT_TIMEOUT_MS = 1_000;

function nonLoopbackIpv4Addresses(): string[] {
  return [
    ...new Set(
      Object.values(networkInterfaces())
        .flatMap((addresses) => addresses ?? [])
        .filter((address) => address.family === 'IPv4' && !address.internal)
        .map((address) => address.address),
    ),
  ].sort();
}

async function connect(
  address: string,
  port: number,
): Promise<'reachable' | 'refused' | 'other'> {
  return new Promise((resolve) => {
    const socket = new Socket();
    let settled = false;
    const finish = (outcome: 'reachable' | 'refused' | 'other') => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(outcome);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once('connect', () => finish('reachable'));
    socket.once('timeout', () => finish('other'));
    socket.once('error', (error: NodeJS.ErrnoException) =>
      finish(error.code === 'ECONNREFUSED' ? 'refused' : 'other'),
    );
    socket.connect(port, address);
  });
}

async function listen(server: Server, host: string): Promise<number> {
  server.listen(0, host);
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Listener did not report an assigned TCP port');
  }
  return address.port;
}

async function close(server: {
  close(callback: (error?: Error) => void): void;
}) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

describe('explicit Station listener host isolation', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    const results = await Promise.allSettled(
      cleanup
        .splice(0)
        .reverse()
        .map((run) => run()),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure) throw failure.reason;
  });

  it('binds API, terminal, voice, and UI to loopback and refuses a control-proven non-loopback route', async () => {
    const control = createTcpServer();
    const controlPort = await listen(control, '0.0.0.0');
    cleanup.push(() => close(control));
    const probativeAddresses: string[] = [];
    for (const address of nonLoopbackIpv4Addresses()) {
      if ((await connect(address, controlPort)) === 'reachable') {
        probativeAddresses.push(address);
      }
    }
    expect(
      probativeAddresses.length,
      'A wildcard control listener must prove at least one non-loopback route before isolation assertions are meaningful',
    ).toBeGreaterThan(0);

    const app = new Hono().get('/api/system/status', (c) =>
      c.json({ ready: true }),
    );
    const apiServer = serve({ fetch: app.fetch, hostname: LOOPBACK, port: 0 });
    if (!apiServer.listening) await once(apiServer, 'listening');
    const apiAddress = apiServer.address();
    if (!apiAddress || typeof apiAddress === 'string') {
      throw new Error('API listener did not report an assigned TCP port');
    }
    cleanup.push(() => close(apiServer));

    const terminal = new TerminalWebSocketServer({
      subscribe: () => () => {},
    } as any);
    const terminalWss = terminal.start(0, LOOPBACK);
    await once(terminalWss, 'listening');
    const terminalAddress = terminalWss.address();
    if (!terminalAddress || typeof terminalAddress === 'string') {
      throw new Error('Terminal listener did not report an assigned TCP port');
    }
    cleanup.push(async () => {
      const closed = once(terminalWss, 'close');
      terminal.stop();
      await closed;
    });

    const voiceWss = attachVoiceWebSocket(
      0,
      { createSession: () => {} } as any,
      LOOPBACK,
    );
    if (!voiceWss) throw new Error('Voice listener was not created');
    await once(voiceWss, 'listening');
    const voiceAddress = voiceWss.address();
    if (!voiceAddress || typeof voiceAddress === 'string') {
      throw new Error('Voice listener did not report an assigned TCP port');
    }
    cleanup.push(() => close(voiceWss));

    const uiDir = await mkdtemp(path.join(tmpdir(), 'station-ui-listener-'));
    await writeFile(path.join(uiDir, 'index.html'), '<head></head>Station');
    cleanup.push(() => rm(uiDir, { recursive: true, force: true }));
    const uiServer = createHttpServer(
      uiRequestHandler({
        backendPrefixes: UI_PROXY_BACKEND_PREFIXES,
        crypto,
        dir: uiDir,
        fs,
        http: await import('node:http'),
        inject: '',
        mime: UI_MIME_TYPES,
        path,
        upstreamPort: apiAddress.port,
      }),
    );
    const uiPort = await listen(uiServer, LOOPBACK);
    cleanup.push(() => close(uiServer));

    const listeners = [
      ['api', apiAddress.port],
      ['terminal', terminalAddress.port],
      ['voice', voiceAddress.port],
      ['ui', uiPort],
    ] as const;
    for (const [name, port] of listeners) {
      expect(await connect(LOOPBACK, port), `${name} loopback readiness`).toBe(
        'reachable',
      );
      for (const address of probativeAddresses) {
        expect(
          await connect(address, port),
          `${name} must refuse ${address}:${port}`,
        ).toBe('refused');
      }
    }
  });
});
