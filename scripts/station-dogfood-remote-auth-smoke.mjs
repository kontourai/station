#!/usr/bin/env node

import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const AUTH_CLOSE_CODE = 4401;
const PROTOCOL_VERSION = 1;

function fail(message) {
  throw new Error(message);
}

function safeOrigin(value, label) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    fail(
      `${label} must be an origin without credentials, path, query, or fragment`,
    );
  }
  return url.origin;
}

function safeRemoteWebSocketUrl(value, label) {
  const url = new URL(value);
  if (url.protocol !== 'wss:' || url.username || url.password) {
    fail(`${label} must be a credential-free wss URL`);
  }
  for (const key of ['credential', 'token', 'access_token', 'auth']) {
    if (url.searchParams.has(key))
      fail(`${label} must not contain credentials`);
  }
  return url.toString();
}

export function readCredential(path) {
  if (!path || path === '-') {
    const credential = readFileSync(0, 'utf8').trim();
    if (credential.length > 4096) fail('credential input is too large');
    return credential;
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) fail('credential input must be a regular file');
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      fail('credential input must be owned by the current user');
    }
    if ((info.mode & 0o077) !== 0) {
      fail('credential input permissions must be 0600');
    }
    if (info.size > 4096) fail('credential input is too large');
    return readFileSync(fd, 'utf8').trim();
  } finally {
    closeSync(fd);
  }
}

async function jsonRequest(fetchImpl, url, credential) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/json',
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
    },
    redirect: 'error',
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

function assertStatus(name, actual, expected) {
  if (actual !== expected)
    fail(`${name} returned HTTP ${actual}; expected ${expected}`);
}

export function probeWebSocket(url, credential, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let acknowledged = false;
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('websocket probe deadline exceeded'));
    }, timeoutMs);
    const finish = (error, result) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.terminate();
      error ? reject(error) : resolve(result);
    };
    socket.once('open', () => {
      if (credential) {
        socket.send(
          JSON.stringify({
            type: 'auth',
            protocolVersion: PROTOCOL_VERSION,
            credential,
          }),
        );
      }
    });
    socket.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return finish(
          new Error('websocket returned malformed authentication ack'),
        );
      }
      if (
        message?.type === 'authenticated' &&
        message.protocolVersion === PROTOCOL_VERSION
      ) {
        acknowledged = true;
        finish(null, { outcome: 'authenticated' });
      }
    });
    socket.once('close', (code) => {
      if (!credential && code === AUTH_CLOSE_CODE) {
        finish(null, { outcome: 'denied', closeCode: code });
      } else if (!acknowledged) {
        finish(new Error(`unexpected websocket close code ${code}`));
      }
    });
    socket.once('error', (error) => finish(error));
  });
}

export async function runRemoteAuthSmoke(
  config,
  { credential, fetchImpl = fetch, websocketProbe = probeWebSocket } = {},
) {
  if (!credential) fail('credential input is empty');
  if (!/^[0-9a-f]{40}$/.test(config.expectedSha)) {
    fail('expected SHA must be a full 40-character lowercase commit SHA');
  }
  const remote = safeOrigin(config.remoteOrigin, 'remote origin');
  const local = safeOrigin(config.localOrigin, 'local origin');

  const handshake = await jsonRequest(
    fetchImpl,
    `${remote}/.well-known/station/v1`,
  );
  assertStatus('public handshake', handshake.status, 200);
  const handshakeKeys = Object.keys(handshake.body ?? {}).sort();
  if (
    JSON.stringify(handshakeKeys) !==
      JSON.stringify([
        'authentication',
        'environmentId',
        'schemaVersion',
        'transports',
      ]) ||
    handshake.body?.schemaVersion !== 1 ||
    handshake.body?.authentication?.scheme !== 'bearer'
  ) {
    fail('public handshake does not match the minimal versioned contract');
  }

  const denied = await jsonRequest(fetchImpl, `${remote}/api/system/identity`);
  assertStatus('unauthenticated remote identity', denied.status, 401);

  const identity = await jsonRequest(
    fetchImpl,
    `${remote}/api/system/identity`,
    credential,
  );
  assertStatus('authenticated remote identity', identity.status, 200);
  const actualSha = identity.body?.sha ?? identity.body?.fullSha;
  if (actualSha !== config.expectedSha) fail('remote build SHA mismatch');

  const health = await jsonRequest(
    fetchImpl,
    `${remote}/api/system/status`,
    credential,
  );
  assertStatus('authenticated remote health', health.status, 200);
  const sessions = await jsonRequest(
    fetchImpl,
    `${remote}/api/orchestration/sessions/read-model`,
    credential,
  );
  assertStatus('authenticated remote sessions', sessions.status, 200);

  const localIdentity = await jsonRequest(
    fetchImpl,
    `${local}/api/system/identity`,
  );
  assertStatus('unauthenticated local identity', localIdentity.status, 200);
  const localSha = localIdentity.body?.sha ?? localIdentity.body?.fullSha;
  if (localSha !== config.expectedSha) fail('local build SHA mismatch');

  const websocket = {};
  for (const [name, url] of Object.entries(config.websocketUrls ?? {})) {
    if (!url) continue;
    const safeUrl = safeRemoteWebSocketUrl(url, `${name} websocket URL`);
    websocket[name] = {
      unauthenticated: await websocketProbe(safeUrl, undefined),
      authenticated: await websocketProbe(safeUrl, credential),
    };
  }

  return {
    ok: true,
    expectedSha: config.expectedSha,
    environmentId: handshake.body.environmentId,
    checks: {
      publicHandshake: 200,
      remoteUnauthenticated: 401,
      remoteAuthenticatedIdentity: 200,
      remoteAuthenticatedHealth: 200,
      remoteAuthenticatedSessions: 200,
      localUnauthenticatedIdentity: 200,
      websocket,
    },
  };
}

function argValue(argv, name) {
  return argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function main(argv = process.argv.slice(2)) {
  const config = {
    remoteOrigin: argValue(argv, '--remote-origin'),
    localOrigin: argValue(argv, '--local-origin'),
    expectedSha: argValue(argv, '--expected-sha'),
    websocketUrls: {
      terminal: argValue(argv, '--terminal-ws'),
      voice: argValue(argv, '--voice-ws'),
    },
  };
  if (!config.remoteOrigin || !config.localOrigin || !config.expectedSha) {
    fail(
      'usage: station-dogfood-remote-auth-smoke.mjs --remote-origin=URL --local-origin=URL --expected-sha=SHA [--credential-file=PATH|-] [--terminal-ws=URL] [--voice-ws=URL]',
    );
  }
  const credential = readCredential(argValue(argv, '--credential-file') ?? '-');
  const result = await runRemoteAuthSmoke(config, { credential });
  console.log(JSON.stringify(result));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
