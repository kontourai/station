import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const token = randomUUID();
const network = `station-ingress-${token}`;
const upstream = `${network}-upstream`;
const proxy = `${network}-proxy`;
const label = `com.kontourai.station.ingress-smoke=${token}`;
const temp = mkdtempSync(join(tmpdir(), 'station-ingress-smoke-'));
const docker = (args, options = {}) =>
  execFileSync('docker', args, {
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  })
    .toString()
    .trim();
const pause = (ms) =>
  new Promise((resolvePause) => setTimeout(resolvePause, ms));
let ownsNetwork = false;
const containers = [];
function request(url, options = {}) {
  return new Promise((resolveRequest, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { timeout: 5000, ...options }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () =>
        resolveRequest({ status: res.statusCode, headers: res.headers, body }),
      );
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
  });
}
try {
  const env = {
    ...process.env,
    STATION_IMAGE: 'station-qualification-fixture:unused',
    STATION_PUBLIC_HOST: 'localhost',
  };
  const composed = JSON.parse(
    docker(
      [
        'compose',
        '-f',
        join(root, 'docker-compose.yml'),
        '-f',
        join(root, 'deploy/public-ingress/compose.yaml'),
        'config',
        '--format',
        'json',
      ],
      { env },
    ),
  );
  assert.deepEqual(composed.services.station.ports ?? [], []);
  assert.deepEqual(
    composed.services.ingress.ports
      .map((port) => String(port.published))
      .sort(),
    ['443', '80'],
  );
  assert.equal(
    composed.services.station.environment.ALLOWED_ORIGINS,
    'https://localhost',
  );
  const image = composed.services.ingress.image;
  assert.match(image, /@sha256:[a-f0-9]{64}$/);
  // This fixture is an HTTP codec, not a fake Station authority. Holding SSE
  // open until a second request proves streaming without a timing threshold.
  writeFileSync(
    join(temp, 'upstream.mjs'),
    `
import http from 'node:http';
import { createHash } from 'node:crypto';
let stream;
let cancelled = false;
const server = http.createServer((req, res) => {
  if (req.url === '/events') {
    stream = res;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('data: first\\n\\n');
  } else if (req.url === '/cancel') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.on('close', () => { cancelled = true; });
    res.write('data: cancellation-probe\\n\\n');
  } else if (req.url === '/cancelled') {
    res.end(JSON.stringify({ cancelled }));
  } else if (req.url === '/release') {
    stream?.end('data: second\\n\\n'); res.end('released');
  } else { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.headers)); }
});
server.on('upgrade', (req, socket) => {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
  // Server-to-client text frame after a real upgrade; no frame parser needed.
  socket.write(Buffer.from([0x81, 4, 112, 111, 110, 103]));
});
server.listen(3000, '0.0.0.0');
`,
  );
  docker(['network', 'create', '--label', label, network]);
  ownsNetwork = true;
  // Reuse the repository's reviewed runtime base image, not a second pin.
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
  const runtimeImage = dockerfile.match(/^FROM (\S+) AS runtime$/m)?.[1];
  assert.match(runtimeImage ?? '', /@sha256:[a-f0-9]{64}$/);
  // Docker may create a container before reporting a start failure. Track the
  // attempted name first; cleanup still verifies existence and exact ownership.
  containers.push(upstream);
  docker([
    'run',
    '-d',
    '--name',
    upstream,
    '--label',
    label,
    '--network',
    network,
    '--network-alias',
    'station',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '-v',
    `${join(temp, 'upstream.mjs')}:/upstream.mjs:ro`,
    '--entrypoint',
    'node',
    runtimeImage,
    '/upstream.mjs',
  ]);
  containers.push(proxy);
  docker([
    'run',
    '-d',
    '--name',
    proxy,
    '--label',
    label,
    '--network',
    network,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--cap-add',
    'NET_BIND_SERVICE',
    '--security-opt',
    'no-new-privileges:true',
    '--tmpfs',
    '/data',
    '--tmpfs',
    '/config',
    '-p',
    '127.0.0.1::443',
    '-p',
    '127.0.0.1::80',
    '-e',
    'STATION_PUBLIC_HOST=localhost',
    '-v',
    `${join(root, 'deploy/public-ingress/Caddyfile')}:/etc/caddy/Caddyfile:ro`,
    image,
  ]);
  const port = Number(docker(['port', proxy, '443/tcp']).split(':').at(-1));
  const httpPort = Number(docker(['port', proxy, '80/tcp']).split(':').at(-1));
  const base = `https://localhost:${port}`;
  let ca;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      ca = docker([
        'exec',
        proxy,
        'cat',
        '/data/caddy/pki/authorities/local/root.crt',
      ]);
      if (ca) break;
    } catch {}
    await pause(100);
  }
  assert.ok(ca, 'local TLS test CA was not created');
  const tls = { ca, family: 4 };
  let response;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      response = await request(base, tls);
      if (response.status === 200) break;
    } catch {}
    await pause(100);
  }
  assert.equal(response?.status, 200, 'TLS proxy did not reach the upstream');
  const redirect = await request(`http://127.0.0.1:${httpPort}/path`, {
    headers: { Host: 'localhost' },
  });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, 'https://localhost/path');
  const headers = JSON.parse(
    (
      await request(base, {
        ...tls,
        headers: {
          Authorization: 'Bearer synthetic-token',
          Cookie: 'fixture=value',
          'Tailscale-User-Login': 'forged@example.invalid',
          'Remote-User': 'forged',
          'X-Forwarded-User': 'forged',
          'X-Auth-Request-Email': 'forged',
          'Cf-Access-Jwt-Assertion': 'forged',
          'X-Forwarded-Proto': 'http',
        },
      })
    ).body,
  );
  assert.equal(headers.authorization, 'Bearer synthetic-token');
  assert.equal(headers.cookie, 'fixture=value');
  assert.equal(headers['x-forwarded-proto'], 'https');
  for (const header of [
    'tailscale-user-login',
    'remote-user',
    'x-forwarded-user',
    'x-auth-request-email',
    'cf-access-jwt-assertion',
  ])
    assert.equal(headers[header], undefined);
  let first;
  const firstChunk = new Promise((resolveFirst) => {
    first = resolveFirst;
  });
  const ended = new Promise((resolveEnd, reject) => {
    const req = https.get(
      `${base}/events`,
      { ...tls, timeout: 5000 },
      (res) => {
        res.once('data', (chunk) => first(chunk.toString()));
        res.on('data', () => {});
        res.on('end', resolveEnd);
        res.on('error', reject);
      },
    );
    req.on('timeout', () =>
      req.destroy(new Error('SSE was buffered or timed out')),
    );
    req.on('error', reject);
  });
  // A failed stream must reject readiness too, without an unhandled rejection.
  const chunk = await Promise.race([
    firstChunk,
    ended.then(() => {
      throw new Error('SSE ended before its first event');
    }),
  ]);
  assert.match(chunk, /data: first/);
  await request(`${base}/release`, tls);
  await ended;
  await new Promise((resolveCancelled, reject) => {
    const req = https.get(
      `${base}/cancel`,
      { ...tls, timeout: 5000 },
      (res) => {
        res.once('data', () => {
          res.destroy();
          req.destroy();
          resolveCancelled();
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () =>
      req.destroy(new Error('Cancellation probe timed out')),
    );
    req.on('error', reject);
  });
  let cancelled = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    cancelled = JSON.parse(
      (await request(`${base}/cancelled`, tls)).body,
    ).cancelled;
    if (cancelled) break;
    await pause(100);
  }
  assert.equal(
    cancelled,
    true,
    'Client disconnect did not cancel the upstream stream',
  );
  await new Promise((resolveSocket, reject) => {
    const socket = new WebSocket(`${base.replace('https:', 'wss:')}/socket`, {
      ...tls,
      handshakeTimeout: 5000,
    });
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error('WebSocket timed out'));
    }, 5000);
    socket.once('message', (data) => {
      clearTimeout(timeout);
      try {
        assert.equal(data.toString(), 'pong');
        socket.terminate();
        resolveSocket();
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  console.log(
    'PASS: composed port isolation, verified TLS, redirect, identity-header stripping, authorization forwarding, unbuffered SSE, disconnect cancellation and WebSocket upgrade.',
  );
} catch (error) {
  for (const name of containers) {
    try {
      console.error(
        docker([
          'inspect',
          '--format',
          '{{json .State}} {{json .NetworkSettings.Ports}}',
          name,
        ]),
      );
      console.error(docker(['logs', '--tail', '30', name]));
    } catch {}
  }
  throw error;
} finally {
  let cleanupFailed = false;
  for (const name of containers.reverse()) {
    try {
      if (!docker(['ps', '--all', '--quiet', '--filter', `name=^/${name}$`]))
        continue;
      assert.equal(
        docker([
          'inspect',
          '--format',
          '{{ index .Config.Labels "com.kontourai.station.ingress-smoke" }}',
          name,
        ]),
        token,
      );
      docker(['rm', '-f', '-v', name]);
    } catch (error) {
      console.error(
        `Owned ingress test cleanup failed: ${name}: ${error.message}`,
      );
      cleanupFailed = true;
    }
  }
  if (ownsNetwork) {
    try {
      assert.equal(
        docker([
          'network',
          'inspect',
          '--format',
          '{{ index .Labels "com.kontourai.station.ingress-smoke" }}',
          network,
        ]),
        token,
      );
      docker(['network', 'rm', network]);
    } catch (error) {
      console.error(`Owned test network cleanup failed: ${error.message}`);
      cleanupFailed = true;
    }
  }
  rmSync(temp, { recursive: true, force: true });
  if (cleanupFailed) process.exitCode = 1;
}
