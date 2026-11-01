import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { buildUiServerScript } from '../commands/lifecycle.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

// #3994: the phone reaches Station through this UI proxy (tailnet name,
// reverse proxy). Without upgrade forwarding the same-origin terminal socket
// closes with 1006 exactly as the old port + 1 listener did.
it('forwards only the terminal socket upgrade through the spawned UI proxy, stripping attestation headers', async () => {
  const seen: Record<string, string | string[] | undefined>[] = [];
  const upstream = createServer((_req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) =>
      protocols.has('station.terminal.v1') ? 'station.terminal.v1' : false,
  });
  upstream.on('upgrade', (request, socket, head) => {
    seen.push({ url: request.url, ...request.headers });
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.on('message', (data) => ws.send(`echo:${data}`));
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const upstreamAddress = upstream.address();
  const upstreamPort =
    typeof upstreamAddress === 'object' && upstreamAddress
      ? upstreamAddress.port
      : 0;
  cleanups.push(() => {
    wss.close();
    upstream.close();
  });

  const uiDir = mkdtempSync(join(tmpdir(), 'station-ui-upgrade-'));
  writeFileSync(join(uiDir, 'index.html'), '<head></head><body>app</body>');
  const uiPort = 40600 + (process.pid % 400);
  const child = spawn(
    process.execPath,
    ['-e', buildUiServerScript({ uiDir, upstreamPort, uiPort })],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, STATION_INTERNAL_API_TOKEN: 'test-only-token' },
    },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  cleanups.push(() => {
    child.kill('SIGKILL');
    rmSync(uiDir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${uiPort}/`)).ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline)
      throw new Error(`UI proxy did not start ${stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const ticket = `station.terminal.ticket.${'T'.repeat(43)}`;
  const client = new WebSocket(
    `ws://127.0.0.1:${uiPort}/api/terminal/socket`,
    ['station.terminal.v1', ticket],
    {
      headers: {
        'x-station-internal-token': 'forged',
        'x-station-proxy-peer': '127.0.0.1',
        'x-forwarded-for': '10.0.0.9',
        'tailscale-user-login': 'someone@example.test',
      },
    },
  );
  cleanups.push(() => client.terminate());
  await once(client, 'open');
  expect(client.protocol).toBe('station.terminal.v1');
  client.send('ping');
  const [reply] = (await once(client, 'message')) as [Buffer];
  expect(String(reply)).toBe('echo:ping');

  expect(seen).toHaveLength(1);
  const forwarded = seen[0]!;
  expect(forwarded.url).toBe('/api/terminal/socket');
  // The ticket rides through untouched; nothing the client claims about its
  // network position or identity reaches the API listener.
  expect(
    String(forwarded['sec-websocket-protocol'])
      .split(',')
      .map((value) => value.trim()),
  ).toEqual(['station.terminal.v1', ticket]);
  for (const name of Object.keys(forwarded))
    expect(name).not.toMatch(/^(x-station-|tailscale-|x-forwarded-)/);

  // Any other upgrade is dropped by the proxy, never forwarded.
  const other = new WebSocket(`ws://127.0.0.1:${uiPort}/api/voice`);
  other.on('error', () => undefined);
  cleanups.push(() => other.terminate());
  // events.once would reject on the expected 'error'; wait for close itself.
  await new Promise<void>((resolve) => other.once('close', () => resolve()));
  expect(seen).toHaveLength(1);
}, 30_000);
