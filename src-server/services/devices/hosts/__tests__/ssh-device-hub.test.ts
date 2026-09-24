/**
 * The SSH device host's supervised hub (#1973), driven through a fake ssh:
 * the remote start (with the guard and a fresh secret on stdin), the
 * forward, readiness through the forward, the deny-set ports, typed
 * failures, and restart with backoff.
 */

import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { type AddressInfo, createServer } from 'node:net';
import { describe, expect, test } from 'vitest';
import { buildHubGuardSource } from '../../toolchain/device-hub-guard.js';
import { HUB_LAUNCH_ARGS } from '../../toolchain/device-hub-supervisor.js';
import { SshDeviceHub } from '../ssh-device-hub.js';
import { parseSshDeviceTarget } from '../ssh-device-target.js';
import { FakeSsh } from './fake-ssh.js';

const HOST_ID = 'ssh-0123456789ab';

function setup(
  overrides: {
    enabled?: boolean;
    installed?: boolean;
    /** false: forwards never report holding their listener. */
    forwardListens?: boolean;
    reinstall?: () => Promise<boolean>;
    ready?: (
      baseUrl: string,
      headers: Record<string, string>,
      signal: AbortSignal,
    ) => boolean | Promise<boolean>;
  } = {},
) {
  const spawned: FakeSsh[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  let nextPort = 41000;
  const probes: Array<{ baseUrl: string; headers: Record<string, string> }> =
    [];
  let enabled = overrides.enabled ?? true;
  const hub = new SshDeviceHub({
    hostId: HOST_ID,
    owner: 'b'.repeat(24),
    target: () => parseSshDeviceTarget('brian@mac-mini:2222'),
    enabled: () => enabled,
    resolveLaunch: () =>
      overrides.installed === false
        ? undefined
        : { version: '0.10.1', digest: 'd'.repeat(64) },
    spawn: (args) => {
      const child = new FakeSsh(args);
      spawned.push(child);
      // A forward that ssh really bound says so (DEBUG1), like OpenSSH.
      if (child.isForward() && overrides.forwardListens !== false)
        setImmediate(() => child.announceListening());
      return child;
    },
    reservePort: async () => nextPort++,
    probeReady: async (baseUrl, signal, headers) => {
      probes.push({ baseUrl, headers });
      return overrides.ready ? overrides.ready(baseUrl, headers, signal) : true;
    },
    ...(overrides.reinstall ? { reinstall: overrides.reinstall } : {}),
    now: () => 1_000_000,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
  });
  const sessions = () => spawned.filter((child) => !child.isForward());
  const forwards = () => spawned.filter((child) => child.isForward());
  /** The restart timer (the only one with a backoff-sized delay). */
  const restarts = () =>
    timers.filter(
      (timer) =>
        !timer.cleared &&
        timer.ms <= 30_000 &&
        timer.ms >= 1_000 &&
        timer.ms !== 3_000 &&
        timer.ms !== 15_000,
    );
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  /** Wait until the newest session has written its header, then answer. */
  const answer = async (event: Record<string, unknown>) => {
    for (let i = 0; i < 50 && !sessions().at(-1)?.stdinText.includes('\n'); i++)
      await tick();
    sessions()
      .at(-1)!
      .stdout.write(`${JSON.stringify(event)}\n`);
  };
  return {
    hub,
    spawned,
    sessions,
    forwards,
    probes,
    timers,
    restarts,
    tick,
    answer,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
  };
}

describe('the SSH device hub', () => {
  test('starts the hub remotely under the guard with a fresh secret, forwards it, and hands out a connection for this host', async () => {
    const s = setup();
    const started = s.hub.ensureStarted();
    await s.answer({ event: 'ready', port: 50123 });
    const connection = await started;

    const [session] = s.sessions();
    const params = session!.params();
    expect(params.mode).toBe('start');
    expect(params.secret).toMatch(/^[0-9a-f]{64}$/);
    // The SAME guard the local hub preloads, and the same launch.
    expect(params.guardSource).toBe(buildHubGuardSource());
    expect(params.guardSecretEnv).toBe('STATION_HUB_GUARD_SECRET');
    expect(params.args).toEqual(HUB_LAUNCH_ARGS);
    expect(params.digest).toBe('d'.repeat(64));
    // The secret travels on stdin, never on a command line.
    for (const child of s.spawned)
      expect(child.args.join(' ')).not.toContain(params.secret as string);
    // The session keeps stdin open: it is the hub's lifetime.
    expect(session!.stdinEnded).toBe(false);

    const [forward] = s.forwards();
    expect(forward!.args[forward!.args.indexOf('-L') + 1]).toBe(
      '127.0.0.1:41000:127.0.0.1:50123',
    );
    expect(forward!.args).toContain('StrictHostKeyChecking=yes');
    // Readiness was proved THROUGH the forward, with the secret.
    expect(s.probes).toEqual([
      {
        baseUrl: 'http://127.0.0.1:41000',
        headers: { 'x-station-hub-secret': params.secret },
      },
    ]);
    expect(connection.hostId).toBe(HOST_ID);
    expect(connection.baseUrl).toBe('http://127.0.0.1:41000');
    expect(connection.headers).toEqual({
      'x-station-hub-secret': params.secret,
    });
    expect(s.hub.state().state).toBe('running');
    expect(s.hub.connection()).toBe(connection);
  });

  test('the local forward port and the host hub port join the deny set while it runs', async () => {
    const s = setup();
    const started = s.hub.ensureStarted();
    await s.answer({ event: 'ready', port: 50123 });
    await started;
    expect(s.hub.listeningPorts()).toEqual([41000, 50123]);
    const stopping = s.hub.stop();
    s.sessions()[0]!.exit(0);
    await stopping;
    expect(s.hub.listeningPorts()).toEqual([]);
  });

  test('an unconfirmed host key is a typed failure; nothing is retried or forwarded', async () => {
    const s = setup();
    const started = s.hub.ensureStarted();
    await s.tick();
    s.sessions()[0]!.exit(
      255,
      'No ED25519 host key is known for mac-mini and you have requested strict checking.\r\nHost key verification failed.\r\n',
    );
    await expect(started).rejects.toMatchObject({
      failure: 'host-key-unverified',
    });
    expect(s.hub.state()).toEqual({
      state: 'failed',
      failure: 'host-key-unverified',
      attempts: 1,
    });
    expect(s.forwards()).toEqual([]);
    expect(s.restarts()).toEqual([]);
  });

  test('the host program’s own refusal is typed too (hub not installed)', async () => {
    const s = setup();
    const started = s.hub.ensureStarted();
    await s.answer({ event: 'error', failure: 'hub-not-installed' });
    await expect(started).rejects.toMatchObject({
      failure: 'hub-not-installed',
    });
    expect(s.hub.state()).toMatchObject({ state: 'failed' });
  });

  test('a hub the operator did not enable, or with no verified local install, never spawns ssh', async () => {
    const disabled = setup({ enabled: false });
    await expect(disabled.hub.ensureStarted()).rejects.toMatchObject({
      failure: 'hub-not-enabled',
    });
    expect(disabled.spawned).toEqual([]);
    const uninstalled = setup({ installed: false });
    await expect(uninstalled.hub.ensureStarted()).rejects.toMatchObject({
      failure: 'local-hub-not-installed',
    });
    expect(uninstalled.spawned).toEqual([]);
  });

  test('H1: an attacker holding the forward port never receives the secret; the retry is a new session with a new secret', async () => {
    // The "attacker": a local process that took the reserved port before
    // ssh could bind it. It records every request and answers 200.
    const captured: string[] = [];
    const attacker = createServer((socket) => {
      socket.on('data', (data) => {
        captured.push(data.toString());
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
      });
    });
    await new Promise<void>((resolve) =>
      attacker.listen({ host: '127.0.0.1', port: 0 }, () => resolve()),
    );
    const attackerPort = (attacker.address() as AddressInfo).port;
    // The real hub (through the second, genuine forward): 200 only with
    // the secret of the session that started it.
    let genuineSecret = '';
    const hubRequests: string[] = [];
    const genuine = createHttpServer((req, res) => {
      hubRequests.push(String(req.headers['x-station-hub-secret']));
      res.statusCode =
        req.headers['x-station-hub-secret'] === genuineSecret ? 200 : 403;
      res.end();
    });
    await new Promise<void>((resolve) =>
      genuine.listen({ host: '127.0.0.1', port: 0 }, () => resolve()),
    );
    const genuinePort = (genuine.address() as AddressInfo).port;
    const spawned: FakeSsh[] = [];
    const ports = [attackerPort, genuinePort];
    const hub = new SshDeviceHub({
      hostId: HOST_ID,
      owner: 'b'.repeat(24),
      target: () => parseSshDeviceTarget('me@mac-mini'),
      enabled: () => true,
      resolveLaunch: () => ({ version: '0.10.1', digest: 'd'.repeat(64) }),
      reservePort: async () => ports.shift()!,
      spawn: (args) => {
        const child = new FakeSsh(args);
        spawned.push(child);
        if (!child.isForward()) {
          setTimeout(() => {
            if (spawned.filter((c) => !c.isForward()).length === 2)
              genuineSecret = child.params().secret as string;
            child.stdout.write(
              `${JSON.stringify({ event: 'ready', port: 50123 })}\n`,
            );
          }, 10);
        } else if (args.includes(`127.0.0.1:${attackerPort}:127.0.0.1:50123`)) {
          // ssh could not bind: no "listening" line, then it gives up.
          setTimeout(
            () =>
              child.exit(
                255,
                `debug1: Authenticated to mac-mini.\nbind [127.0.0.1]:${attackerPort}: Address already in use\nCould not request local forwarding.\n`,
              ),
            300,
          );
        } else setTimeout(() => child.announceListening(), 10);
        return child;
      },
    });
    try {
      const connection = await hub.ensureStarted();
      const sessions = spawned.filter((child) => !child.isForward());
      const secrets = sessions.map((child) => child.params().secret as string);
      // ZERO requests reached the attacker's listener — with or without the secret.
      expect(captured).toEqual([]);
      // The hub runs against the genuine forward, never the attacker's port.
      expect(connection.baseUrl).toBe(`http://127.0.0.1:${genuinePort}`);
      expect(hub.state().state).toBe('running');
      // The retry was a NEW session with a NEW secret.
      expect(sessions).toHaveLength(2);
      expect(secrets[0]).not.toBe(secrets[1]);
      expect(hubRequests.every((secret) => secret === secrets[1])).toBe(true);
      // The failed session was told to stop its hub.
      expect(sessions[0]!.stdinEnded).toBe(true);
      const stopping = hub.stop();
      sessions[1]!.exit(0);
      await stopping;
    } finally {
      attacker.close();
      genuine.close();
    }
  });

  test('D1: a bind race after a REAL DEBUG1 login is forward-failed and retried with a new session and secret', async () => {
    // The forward's real OpenSSH 10.3p1 DEBUG1 transcript: its login prints
    // "Authentications that can continue: …keyboard-interactive" before
    // the key is accepted, then the bind fails.
    const transcript = readFileSync(
      new URL(
        './fixtures/openssh-10.3p1-debug1-forward-bind-race.txt',
        import.meta.url,
      ),
      'utf8',
    );
    expect(transcript).toMatch(
      /^debug1: Authentications that can continue: .*keyboard-interactive$/m,
    );
    const s = setup({ forwardListens: false });
    const started = s.hub.ensureStarted();
    await s.answer({ event: 'ready', port: 50123 });
    for (let i = 0; i < 50 && s.forwards().length === 0; i++) await s.tick();
    s.forwards()[0]!.exit(255, transcript);
    for (let i = 0; i < 50 && s.sessions().length < 2; i++) await s.tick();
    expect(s.sessions()).toHaveLength(2);
    await s.answer({ event: 'ready', port: 50124 });
    for (let i = 0; i < 50 && s.forwards().length < 2; i++) await s.tick();
    s.forwards()[1]!.announceListening();
    await started;
    expect(s.hub.state().state).toBe('running');
    const [first, second] = s.sessions().map((child) => child.params().secret);
    expect(first).not.toBe(second);
  });

  test('L-c: a forward ssh never confirms is typed forward-unconfirmed and terminal after one start', async () => {
    const s = setup({ forwardListens: false });
    const started = s.hub.ensureStarted();
    started.catch(() => {});
    await s.answer({ event: 'ready', port: 50123 });
    for (let i = 0; i < 50 && s.forwards().length === 0; i++) await s.tick();
    // The forward-ready deadline passes with no listening line.
    const deadline = s.timers.find(
      (timer) => timer.ms === 15_000 && !timer.cleared,
    );
    expect(deadline).toBeDefined();
    deadline!.fn();
    await expect(started).rejects.toMatchObject({
      failure: 'forward-unconfirmed',
    });
    expect(s.hub.state()).toMatchObject({
      state: 'failed',
      failure: 'forward-unconfirmed',
    });
    expect(s.sessions()).toHaveLength(1);
    expect(s.restarts()).toEqual([]);
  });

  test('H1: no request is made before ssh reports it holds the listener', async () => {
    const s = setup({ forwardListens: false });
    const started = s.hub.ensureStarted();
    started.catch(() => {});
    await s.answer({ event: 'ready', port: 50123 });
    for (let i = 0; i < 50 && s.forwards().length === 0; i++) await s.tick();
    // A server-relayed line, or another port, does not count.
    s.forwards()[0]!.stderr.write(
      'debug1: Remote: debug1: Local forwarding listening on 127.0.0.1 port 41000.\ndebug1: Local forwarding listening on 127.0.0.1 port 9.\n',
    );
    for (let i = 0; i < 10; i++) await s.tick();
    expect(s.probes).toEqual([]);
    s.forwards()[0]!.announceListening();
    for (let i = 0; i < 10; i++) await s.tick();
    expect(s.probes.map((probe) => probe.baseUrl)).toEqual([
      'http://127.0.0.1:41000',
    ]);
    await started;
  });

  test('M4: a host without this Station’s verified hub gets it re-sent once, then the start is tried again', async () => {
    let reinstalls = 0;
    const s = setup({
      reinstall: async () => {
        reinstalls += 1;
        return true;
      },
    });
    const started = s.hub.ensureStarted();
    await s.answer({ event: 'error', failure: 'hub-not-installed' });
    s.sessions()[0]!.exit(3);
    for (let i = 0; i < 20 && s.sessions().length < 2; i++) await s.tick();
    await s.answer({ event: 'ready', port: 50123 });
    await started;
    expect(reinstalls).toBe(1);
    expect(s.hub.state().state).toBe('running');
  });

  test('M4: a reinstall that does not fix it stops at failed hub-not-installed (tried once)', async () => {
    let reinstalls = 0;
    const s = setup({
      reinstall: async () => {
        reinstalls += 1;
        return false;
      },
    });
    const started = s.hub.ensureStarted();
    await s.answer({ event: 'error', failure: 'hub-not-installed' });
    await expect(started).rejects.toMatchObject({
      failure: 'hub-not-installed',
    });
    expect(reinstalls).toBe(1);
    expect(s.hub.state()).toMatchObject({
      state: 'failed',
      failure: 'hub-not-installed',
    });
  });

  test('L1: stop() cancels a start in flight; its ports stay denied until the children exit', async () => {
    const s = setup({ forwardListens: false });
    const started = s.hub.ensureStarted();
    started.catch(() => {});
    await s.answer({ event: 'ready', port: 50123 });
    for (let i = 0; i < 50 && s.forwards().length === 0; i++) await s.tick();
    expect(s.hub.listeningPorts()).toEqual([41000, 50123]);
    const stopping = s.hub.stop();
    await s.tick();
    // The forward was killed; the session was told to stop its hub, but has
    // not exited yet: the ports are still denied.
    expect(s.forwards()[0]!.killed).toContain('SIGTERM');
    expect(s.sessions()[0]!.stdinEnded).toBe(true);
    expect(s.hub.listeningPorts()).toEqual([41000, 50123]);
    s.sessions()[0]!.exit(0);
    await stopping;
    expect(s.hub.listeningPorts()).toEqual([]);
    await expect(started).rejects.toBeDefined();
    expect(s.hub.state()).toEqual({ state: 'stopped' });
  });

  test('the forward dying ends the connection and restarts with doubling backoff', async () => {
    const s = setup();
    const started = s.hub.ensureStarted();
    await s.answer({ event: 'ready', port: 50123 });
    const connection = await started;
    const exits: string[] = [];
    connection.onExit((reason) => exits.push(reason));

    s.forwards()[0]!.exit(255, 'Timeout, server mac-mini not responding.\r\n');
    for (let i = 0; i < 10; i++) await s.tick();
    expect(exits).toEqual(['ssh-closed']);
    expect(connection.ready).toBe(false);
    expect(s.hub.connection()).toBeUndefined();
    // The session is told to stop its hub (stdin closed).
    expect(s.sessions()[0]!.stdinEnded).toBe(true);
    expect(s.hub.state()).toMatchObject({ state: 'restarting', attempt: 1 });
    expect(s.restarts().map((timer) => timer.ms)).toEqual([1_000]);

    // The restart itself fails to reach the host: the next delay doubles.
    s.restarts()[0]!.fn();
    s.restarts()[0]!.cleared = true;
    await s.tick();
    s.sessions()[1]!.exit(
      255,
      'ssh: connect to host mac-mini port 2222: Connection refused\r\n',
    );
    for (let i = 0; i < 10; i++) await s.tick();
    expect(s.hub.state()).toMatchObject({ state: 'restarting', attempt: 2 });
    expect(s.restarts().map((timer) => timer.ms)).toEqual([2_000]);
  });

  test('repeated failures stop at `failed` until a person starts it again', async () => {
    const s = setup();
    s.hub.ensureStarted().catch(() => {});
    for (let attempt = 1; attempt <= 5; attempt++) {
      await s.tick();
      s.sessions()
        .at(-1)!
        .exit(255, 'ssh: connect to host x port 22: Connection refused\r\n');
      for (let i = 0; i < 10; i++) await s.tick();
      const pending = s.restarts();
      if (attempt < 5) {
        expect(pending).toHaveLength(1);
        pending[0]!.cleared = true;
        pending[0]!.fn();
      }
    }
    expect(s.hub.state()).toEqual({
      state: 'failed',
      failure: 'unreachable',
      attempts: 5,
    });
    expect(s.restarts()).toEqual([]);
    // A person's Start clears it and tries again.
    s.hub.ensureStarted().catch(() => {});
    await s.tick();
    expect(s.sessions()).toHaveLength(6);
  });

  test('stop closes the session (the host stops its hub) and the forward', async () => {
    const s = setup();
    const started = s.hub.ensureStarted();
    await s.answer({ event: 'ready', port: 50123 });
    const connection = await started;
    const stopping = s.hub.stop();
    await s.tick();
    expect(s.sessions()[0]!.stdinEnded).toBe(true);
    s.sessions()[0]!.exit(0);
    await stopping;
    expect(s.forwards()[0]!.killed).toContain('SIGTERM');
    expect(connection.ready).toBe(false);
    expect(s.hub.state()).toEqual({ state: 'stopped' });
    expect(s.restarts()).toEqual([]);
  });
});
