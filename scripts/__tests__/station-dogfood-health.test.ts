import { execFileSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import {
  createServer as createTcpServer,
  type Socket,
  type Server as TcpServer,
} from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocketServer } from 'ws';
import { attachVoiceWebSocket } from '../../src-server/routes/operations/voice.js';
import { TerminalWebSocketServer } from '../../src-server/services/terminal/terminal-ws-server.js';
import {
  assertListenerOwnership,
  inspectProcessFingerprints,
  listeningPidsByPort,
  observeListeningPidsByPort,
  probeDogfoodHealth,
} from '../station-dogfood-health.mjs';

type CloseableServer = HttpServer | TcpServer | WebSocketServer;

const SOCKET_INTEGRATION_TEST_TIMEOUT_MS = 15_000;
const CONSECUTIVE_PORT_MIN = 20_000;
const CONSECUTIVE_PORT_MAX = 55_000;
const CONSECUTIVE_PORT_ATTEMPTS = 25;
const closers: Array<() => Promise<void>> = [];

function closeServer(server: CloseableServer): Promise<void> {
  return new Promise((resolveClose) => {
    try {
      server.close(() => resolveClose());
    } catch {
      resolveClose();
    }
  });
}

function listenNodeServer(
  server: HttpServer | TcpServer,
  port: number,
): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    const onError = (error: Error) => {
      cleanup();
      rejectListen(error);
    };
    const onListening = () => {
      cleanup();
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

function waitForWebSocketServer(server: WebSocketServer): Promise<void> {
  if (server.address() !== null) return Promise.resolve();
  return new Promise((resolveListen, rejectListen) => {
    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    const onError = (error: Error) => {
      cleanup();
      rejectListen(error);
    };
    const onListening = () => {
      cleanup();
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
  });
}

/**
 * A healthy Station listens on FOUR consecutive ports from `serverPort`:
 * api, terminal (+1), voice (+2) and consent (+3). `assertListenerOwnership`
 * requires all four, so a fixture that reserves three leaves the consent port
 * to whatever else on the host happens to hold it (station#3754).
 */
async function reserveConsecutivePorts(count = 4): Promise<number> {
  let lastError: unknown;
  for (let attempt = 0; attempt < CONSECUTIVE_PORT_ATTEMPTS; attempt += 1) {
    const base = randomInt(CONSECUTIVE_PORT_MIN, CONSECUTIVE_PORT_MAX - count);
    const reservations = Array.from({ length: count }, () => createTcpServer());
    try {
      for (let offset = 0; offset < count; offset += 1) {
        await listenNodeServer(reservations[offset], base + offset);
      }
      return base;
    } catch (error) {
      lastError = error;
    } finally {
      await Promise.all(reservations.map((server) => closeServer(server)));
    }
  }
  throw new Error(`Could not reserve ${count} consecutive loopback ports`, {
    cause: lastError,
  });
}

afterEach(async () => {
  await Promise.allSettled(
    closers
      .splice(0)
      .reverse()
      .map((close) => close()),
  );
});

function currentProcessFingerprint(pid = process.pid) {
  const output = execFileSync(
    'ps',
    ['-o', 'lstart=', '-o', 'command=', '-p', String(pid)],
    // Same pin as the production probe (#3049): tokens are env-independent.
    { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } },
  ).trim();
  const match = output.match(/^(.{24})\s+([\s\S]+)$/);
  if (!match) throw new Error('test process fingerprint unavailable');
  return {
    pid,
    startToken: match[1].trim(),
    commandDigest: createHash('sha256').update(match[2].trim()).digest('hex'),
  };
}

describe('dogfood authenticated health', () => {
  it('runs the CLI entrypoint when invoked through a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-health-symlink-'));
    const link = join(root, 'health-link.mjs');
    symlinkSync(
      fileURLToPath(new URL('../station-dogfood-health.mjs', import.meta.url)),
      link,
    );

    let stderr = '';
    try {
      execFileSync(process.execPath, [link], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      stderr = String((error as { stderr?: string }).stderr ?? '');
    }

    expect(stderr).toContain(
      'usage: station-dogfood-health.mjs --instance-state=/absolute/path',
    );
  });

  it('snapshots all expected processes and listener ports once per phase', () => {
    const deadline = Date.now() + 1_000;
    const ps = vi
      .fn()
      .mockReturnValue(
        '  41 Mon Jul 13 10:00:00 2026 node server.js\n  42 Mon Jul 13 10:00:01 2026 node ui.js\n',
      );
    const fingerprints = inspectProcessFingerprints([41, 42, 41], deadline, ps);

    expect(ps).toHaveBeenCalledTimes(1);
    expect(ps.mock.calls[0]?.[1]).toContain('41,42');
    expect(fingerprints.get(41)).toMatchObject({ pid: 41 });
    expect(fingerprints.get(42)).toMatchObject({ pid: 42 });

    const lsof = vi
      .fn()
      .mockReturnValue(
        'p41\nn127.0.0.1:3141\nn127.0.0.1:3142\np42\nn127.0.0.1:3000\n',
      );
    const owners = listeningPidsByPort(
      [3141, 3142, 3141, 3000],
      deadline,
      lsof,
    );

    expect(lsof).toHaveBeenCalledTimes(1);
    expect(lsof.mock.calls[0]?.[1]).toEqual(
      expect.arrayContaining(['-iTCP:3141', '-iTCP:3142', '-iTCP:3000']),
    );
    expect([...owners.get(3141)!]).toEqual([41]);
    expect([...owners.get(3142)!]).toEqual([41]);
    expect([...owners.get(3000)!]).toEqual([42]);
  });

  it('falls back to ss listener ownership when lsof is unavailable', () => {
    const deadline = Date.now() + 1_000;
    const runSync = vi.fn((command: string) => {
      if (command === 'lsof') {
        const error = new Error('spawn lsof ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      if (command === 'ss') {
        return [
          'LISTEN 0 511 127.0.0.1:3141 0.0.0.0:* users:(("node",pid=41,fd=22))',
          'LISTEN 0 511 127.0.0.1:3142 0.0.0.0:* users:(("node",pid=41,fd=23))',
          'LISTEN 0 511 [::1]:3000 [::]:* users:(("node",pid=42,fd=24))',
        ].join('\n');
      }
      throw new Error(`unexpected command ${command}`);
    });

    const owners = listeningPidsByPort([3141, 3142, 3000], deadline, runSync);

    expect(runSync).toHaveBeenCalledTimes(2);
    expect(runSync.mock.calls[1]?.[0]).toBe('ss');
    expect(runSync.mock.calls[1]?.[1]).toEqual(['-H', '-ltnp']);
    expect([...owners.get(3141)!]).toEqual([41]);
    expect([...owners.get(3142)!]).toEqual([41]);
    expect([...owners.get(3000)!]).toEqual([42]);
  });

  it('never treats an lsof exit 1 as authoritative ownership, whatever it printed', () => {
    const deadline = Date.now() + 1_000;
    const exit1 = (stdout: string) => {
      const error = new Error('lsof failed') as NodeJS.ErrnoException & {
        status?: number;
        stdout?: string;
      };
      error.status = 1;
      error.stdout = stdout;
      return error;
    };
    // No `ss` on this path either, so nothing corroborates the lsof run.
    const withoutSs = (stdout: string) =>
      vi.fn((command: string) => {
        if (command === 'lsof') throw exit1(stdout);
        const error = new Error('spawn ss ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

    // Nothing matched: an empty observation, and not authoritative.
    const empty = observeListeningPidsByPort([3141], deadline, withoutSs(''));
    expect([...empty.owners.get(3141)!]).toEqual([]);
    expect(empty.authoritative).toBe(false);

    // station#3754: exit 1 still prints the ports it DID find. Those records
    // are kept so a missing listener can be NAMED as missing...
    const partial = observeListeningPidsByPort(
      [3141, 3144],
      deadline,
      withoutSs('p41\nn127.0.0.1:3141\n'),
    );
    expect([...partial.owners.get(3141)!]).toEqual([41]);
    expect([...partial.owners.get(3144)!]).toEqual([]);
    expect(partial.authoritative).toBe(false);

    // ...but a COMPLETE-looking exit 1 must not become health (review round
    // 1, BLOCKING). exit 1 means "any error was detected", so a listing that
    // silently omitted a co-owner looks exactly like exclusive ownership.
    const complete = observeListeningPidsByPort(
      [3141, 3144],
      deadline,
      withoutSs('p41\nn127.0.0.1:3141\nn127.0.0.1:3144\n'),
    );
    expect([...complete.owners.get(3141)!]).toEqual([41]);
    expect([...complete.owners.get(3144)!]).toEqual([41]);
    expect(complete.authoritative).toBe(false);
    expect(complete.reason).toMatch(/incomplete observation/);

    // A malformed process record attributes nothing: `p41garbage` used to
    // parse as pid 41, which would misattribute the sockets that follow it.
    const malformed = observeListeningPidsByPort(
      [3141],
      deadline,
      withoutSs('p41garbage\nn127.0.0.1:3141\n'),
    );
    expect([...malformed.owners.get(3141)!]).toEqual([]);

    // The `ss` corroboration is still attempted after an exit 1, and a
    // successful one IS authoritative.
    const ss = vi.fn((command: string) => {
      if (command === 'lsof') throw exit1('p41\nn127.0.0.1:3141\n');
      return 'LISTEN 0 511 127.0.0.1:3141 0.0.0.0:* users:(("node",pid=41,fd=20))\n';
    });
    const corroborated = observeListeningPidsByPort([3141], deadline, ss);
    expect(ss).toHaveBeenCalledTimes(2);
    expect(corroborated).toMatchObject({ source: 'ss', authoritative: true });
    expect([...corroborated.owners.get(3141)!]).toEqual([41]);
  });

  it('refuses to call ownership proven when no tool vouched for the observation (station#3754)', () => {
    const record = {
      instanceId: 'phone',
      build: { sha: 'a'.repeat(40) },
      bootId: '11111111-1111-4111-8111-111111111111',
      serverPid: 41,
      uiPid: 41,
      serverPort: 3141,
      uiPort: 3000,
    };
    const ports = [3141, 3142, 3143, 3144, 3000];
    const owners = (authoritative: boolean) => ({
      owners: new Map(ports.map((port) => [port, new Set([41])])),
      source: 'lsof',
      reason: authoritative
        ? undefined
        : 'lsof: incomplete observation (exit 1)',
      authoritative,
    });

    // Every expected port looks correctly owned by the recorded pid. With a
    // vouched-for observation that is health.
    expect(() =>
      assertListenerOwnership(record, Date.now() + 1_000, () => owners(true)),
    ).not.toThrow();

    // The SAME owners, from an observation nothing vouched for, must not be.
    // This is the review's false-healthy scenario: a permission-limited
    // listing that omitted a co-owner is indistinguishable from exclusive
    // ownership, so agreement proves nothing.
    expect(() =>
      assertListenerOwnership(record, Date.now() + 1_000, () => owners(false)),
    ).toThrow(/listener ownership could not be observed/);
  });

  it('reports bounded probe source and failure reasons when neither listener tool is available', () => {
    const deadline = Date.now() + 1_000;
    const runSync = vi.fn((command: string) => {
      const error = new Error(
        `spawn ${command} ENOENT`,
      ) as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });

    const observation = observeListeningPidsByPort([3141], deadline, runSync);

    expect(observation.source).toBe('none');
    expect(observation.reason).toContain('lsof ENOENT');
    expect(observation.reason).toContain('ss ENOENT');
    expect(observation.reason?.length).toBeLessThanOrEqual(240);
    expect([...observation.owners.get(3141)!]).toEqual([]);
  });

  it('requires an exact opt-in for legacy wildcard records', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-health-host-'));
    const state = join(root, 'phone.json');
    const record = {
      instanceId: 'phone',
      bootId: '11111111-1111-4111-8111-111111111111',
      build: { sha: 'a'.repeat(40) },
      serverPid: process.pid,
      serverFingerprint: currentProcessFingerprint(),
      uiPid: process.pid,
      uiFingerprint: currentProcessFingerprint(),
      serverPort: 1,
      uiPort: 2,
    };
    const writeHost = (host: string) =>
      writeFileSync(state, JSON.stringify({ ...record, host }), {
        mode: 0o600,
      });

    writeHost('0.0.0.0');
    await expect(probeDogfoodHealth(state)).rejects.toThrow(
      'instance state lacks managed boot identity',
    );
    await expect(
      probeDogfoodHealth(state, { allowWildcardHost: true, timeoutMs: 20 }),
    ).resolves.toMatchObject({ healthy: false });

    for (const host of ['127.0.0.1', '192.0.2.10', '::']) {
      writeHost(host);
      await expect(
        probeDogfoodHealth(state, { allowWildcardHost: true, timeoutMs: 20 }),
      ).rejects.toThrow('instance state lacks managed boot identity');
    }
  });

  it('accepts real header-free websocket listeners and rejects stale identity or process ownership', {
    timeout: SOCKET_INTEGRATION_TEST_TIMEOUT_MS,
  }, async () => {
    const identity = {
      instanceId: 'phone',
      sha: 'a'.repeat(40),
      bootId: '11111111-1111-4111-8111-111111111111',
    };
    const apiPaths: string[] = [];
    const apiPort = await reserveConsecutivePorts();
    const api = createServer((req, res) => {
      apiPaths.push(req.url ?? '');
      if (req.url === '/api/system/status') return;
      res.end(JSON.stringify(identity));
    });
    await listenNodeServer(api, apiPort);
    closers.push(() => closeServer(api));
    const terminal = new TerminalWebSocketServer({
      subscribe: () => () => {},
      close: () => {},
    } as any).start(apiPort + 1, '127.0.0.1');
    closers.push(() => closeServer(terminal));
    await waitForWebSocketServer(terminal);
    const voice = attachVoiceWebSocket(
      apiPort + 2,
      { createSession: () => undefined, getActiveCount: () => 0 } as any,
      '127.0.0.1',
    );
    if (!voice) throw new Error('voice websocket was not created');
    closers.push(() => closeServer(voice));
    await waitForWebSocketServer(voice);
    const websocketPaths: string[] = [];
    for (const server of [terminal, voice]) {
      server.on('connection', (_socket, request) =>
        websocketPaths.push(request.url ?? ''),
      );
    }
    // The consent listener (serverPort + 3). Health checks it by listener
    // OWNERSHIP only — no protocol probe — so a plain server owned by this
    // process is the whole contract. Without it `listeners` and its
    // `ownership-post` re-run both fail, which is what made this test red on
    // main after consent became the fifth port (station#3754).
    const consent = createServer((_req, res) => res.end('{}'));
    await listenNodeServer(consent, apiPort + 3);
    closers.push(() => closeServer(consent));
    const ui = createServer((_req, res) => res.end(JSON.stringify(identity)));
    await listenNodeServer(ui, 0);
    closers.push(() => closeServer(ui));
    const root = mkdtempSync(join(tmpdir(), 'station-health-'));
    mkdirSync(join(root, '.station', 'instances'), { recursive: true });
    const state = join(root, '.station', 'instances', 'phone.json');
    writeFileSync(
      state,
      JSON.stringify({
        ...identity,
        build: { sha: identity.sha },
        serverPid: process.pid,
        serverFingerprint: currentProcessFingerprint(),
        uiPid: process.pid,
        uiFingerprint: currentProcessFingerprint(),
        serverPort: apiPort,
        uiPort: (ui.address() as { port: number }).port,
        host: '127.0.0.1',
      }),
      { mode: 0o600 },
    );
    await expect(probeDogfoodHealth(state)).resolves.toMatchObject({
      healthy: true,
      failedChecks: [],
    });
    expect(apiPaths).toEqual(['/api/system/identity']);
    expect(websocketPaths).toEqual(['/__station/health', '/__station/health']);
    writeFileSync(
      state,
      JSON.stringify({
        ...JSON.parse(readFileSync(state, 'utf8')),
        bootId: '22222222-2222-4222-8222-222222222222',
      }),
      { mode: 0o600 },
    );
    await expect(probeDogfoodHealth(state)).resolves.toMatchObject({
      healthy: false,
      failedChecks: expect.arrayContaining(['api', 'ui']),
    });
    await expect(probeDogfoodHealth(state)).resolves.toMatchObject({
      checks: expect.arrayContaining([
        expect.objectContaining({ name: 'terminal', healthy: true }),
        expect.objectContaining({ name: 'voice', healthy: true }),
      ]),
    });

    writeFileSync(
      state,
      JSON.stringify({
        ...JSON.parse(readFileSync(state, 'utf8')),
        bootId: identity.bootId,
        serverFingerprint: {
          ...currentProcessFingerprint(),
          commandDigest: '0'.repeat(64),
        },
      }),
      { mode: 0o600 },
    );
    await expect(probeDogfoodHealth(state)).resolves.toMatchObject({
      healthy: false,
      failedChecks: expect.arrayContaining(['process']),
    });

    writeFileSync(
      state,
      JSON.stringify({
        ...JSON.parse(readFileSync(state, 'utf8')),
        serverPort: apiPort + 10,
        serverFingerprint: currentProcessFingerprint(),
      }),
      { mode: 0o600 },
    );
    await expect(
      probeDogfoodHealth(state, { timeoutMs: 1500 }),
    ).resolves.toMatchObject({
      healthy: false,
      failedChecks: expect.arrayContaining(['listeners']),
    });
  });

  it('reports a Station that is missing its consent listener as unhealthy (station#3754)', {
    timeout: SOCKET_INTEGRATION_TEST_TIMEOUT_MS,
  }, async () => {
    // The rejection path for the fifth port. Everything else about this
    // instance is well-formed — api, terminal, voice and ui all listen under
    // this process — and ONLY the consent listener at serverPort + 3 is
    // absent. Without this, nothing proved the prober REQUIRES consent:
    // deleting that entry from `assertListenerOwnership` left the whole file
    // green, because a fixture that satisfies a requirement cannot notice the
    // requirement being dropped.
    const identity = {
      instanceId: 'phone',
      sha: 'a'.repeat(40),
      bootId: '11111111-1111-4111-8111-111111111111',
    };
    const apiPort = await reserveConsecutivePorts();
    const api = createServer((_req, res) => res.end(JSON.stringify(identity)));
    await listenNodeServer(api, apiPort);
    closers.push(() => closeServer(api));
    const terminal = new TerminalWebSocketServer({
      subscribe: () => () => {},
      close: () => {},
    } as any).start(apiPort + 1, '127.0.0.1');
    closers.push(() => closeServer(terminal));
    await waitForWebSocketServer(terminal);
    const voice = attachVoiceWebSocket(
      apiPort + 2,
      { createSession: () => undefined, getActiveCount: () => 0 } as any,
      '127.0.0.1',
    );
    if (!voice) throw new Error('voice websocket was not created');
    closers.push(() => closeServer(voice));
    await waitForWebSocketServer(voice);
    // No consent listener on apiPort + 3 — the one difference.
    const ui = createServer((_req, res) => res.end(JSON.stringify(identity)));
    await listenNodeServer(ui, 0);
    closers.push(() => closeServer(ui));
    const root = mkdtempSync(join(tmpdir(), 'station-health-no-consent-'));
    const state = join(root, 'phone.json');
    writeFileSync(
      state,
      JSON.stringify({
        ...identity,
        build: { sha: identity.sha },
        serverPid: process.pid,
        serverFingerprint: currentProcessFingerprint(),
        uiPid: process.pid,
        uiFingerprint: currentProcessFingerprint(),
        serverPort: apiPort,
        uiPort: (ui.address() as { port: number }).port,
        host: '127.0.0.1',
      }),
      { mode: 0o600 },
    );

    const health = await probeDogfoodHealth(state);
    expect(health).toMatchObject({
      healthy: false,
      failedChecks: expect.arrayContaining(['listeners', 'ownership-post']),
    });
    // The reason names the missing listener, so an operator reading a red
    // health report learns which port is absent rather than that "listeners"
    // failed.
    expect(
      health.checks.find(
        (check: { name: string }) => check.name === 'listeners',
      )?.reason,
    ).toMatch(/consent listener ownership mismatch/);
    // The surfaces that ARE up must not be blamed for it.
    expect(health.failedChecks).not.toContain('api');
    expect(health.failedChecks).not.toContain('terminal');
    expect(health.failedChecks).not.toContain('voice');
    expect(health.failedChecks).not.toContain('ui');
  });

  it('rejects non-101 and hung websocket upgrades under one shared deadline', {
    timeout: SOCKET_INTEGRATION_TEST_TIMEOUT_MS,
  }, async () => {
    const identity = {
      instanceId: 'phone',
      sha: 'a'.repeat(40),
      bootId: '11111111-1111-4111-8111-111111111111',
    };
    const apiPort = await reserveConsecutivePorts();
    const api = createServer((_req, res) => res.end(JSON.stringify(identity)));
    await listenNodeServer(api, apiPort);
    closers.push(() => closeServer(api));
    const heldSockets = new Set<Socket>();
    const terminal = createTcpServer((socket) => {
      heldSockets.add(socket);
      socket.once('close', () => heldSockets.delete(socket));
    });
    await listenNodeServer(terminal, apiPort + 1);
    closers.push(async () => {
      for (const socket of heldSockets) socket.destroy();
      await closeServer(terminal);
    });
    const voice = createServer();
    voice.on('upgrade', (_request, socket) => {
      socket.end(
        'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
    });
    await listenNodeServer(voice, apiPort + 2);
    closers.push(() => closeServer(voice));
    const consent = createServer((_req, res) => res.end('{}'));
    await listenNodeServer(consent, apiPort + 3);
    closers.push(() => closeServer(consent));
    const ui = createServer((_req, res) => res.end(JSON.stringify(identity)));
    await listenNodeServer(ui, 0);
    closers.push(() => closeServer(ui));
    const root = mkdtempSync(join(tmpdir(), 'station-health-deadline-'));
    const state = join(root, 'phone.json');
    writeFileSync(
      state,
      JSON.stringify({
        ...identity,
        build: { sha: identity.sha },
        serverPid: process.pid,
        serverFingerprint: currentProcessFingerprint(),
        uiPid: process.pid,
        uiFingerprint: currentProcessFingerprint(),
        serverPort: apiPort,
        uiPort: (ui.address() as { port: number }).port,
        host: '127.0.0.1',
      }),
      { mode: 0o600 },
    );
    const started = Date.now();
    await expect(
      probeDogfoodHealth(state, { timeoutMs: 2500 }),
    ).resolves.toMatchObject({
      healthy: false,
      failedChecks: expect.arrayContaining(['terminal', 'voice']),
      checks: expect.arrayContaining([
        expect.objectContaining({
          name: 'voice',
          reason: 'upgrade rejected with HTTP 403',
        }),
      ]),
    });
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
