import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
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
import { inspectProcessFingerprint as recordProcessFingerprint } from '../../packages/cli/src/commands/platform.js';
import { lookupProcessBirthFingerprint } from '../../packages/shared/src/process-identity.mjs';
import { attachVoiceWebSocket } from '../../src-server/routes/operations/voice.js';
import { TerminalWebSocketServer } from '../../src-server/services/terminal/terminal-ws-server.js';
import {
  assertListenerOwnership,
  inspectProcessFingerprints,
  linuxProcessBirthFingerprint,
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

/**
 * The fingerprint `station start` would record for `pid`, taken through the
 * CLI's own recorder rather than a test-local `ps -o lstart=` probe. On Linux
 * the recorder (and the health probe) use the shared `/proc` birth token, so
 * an lstart-built fixture would read as a stale identity on every Linux
 * runner and the healthy baseline below could never pass there.
 */
function currentProcessFingerprint(pid = process.pid) {
  const fingerprint = recordProcessFingerprint(pid);
  if (!fingerprint) throw new Error('test process fingerprint unavailable');
  return fingerprint;
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

  it('runs as the lone file install-macos.zsh installs into bin/ (#2696)', async () => {
    // install-macos.zsh copies ONLY this helper to
    // "$SUPPORT_DIR/bin/station-dogfood-health.mjs" (`install -m 0755`) and
    // runs that copy. Reproduce that shape: nothing beside it, no repo tree
    // above it. A relative import of repo modules fails here at load time
    // with ERR_MODULE_NOT_FOUND before main() ever runs.
    const bin = join(
      mkdtempSync(join(tmpdir(), 'station-health-installed-')),
      'bin',
    );
    mkdirSync(bin, { mode: 0o700 });
    const installed = join(bin, 'station-dogfood-health.mjs');
    copyFileSync(
      fileURLToPath(new URL('../station-dogfood-health.mjs', import.meta.url)),
      installed,
    );
    chmodSync(installed, 0o755);

    // A well-formed record for a Station that is not serving: the probe runs
    // every check, reports JSON, and exits 1 through main()'s normal path.
    const apiPort = await reserveConsecutivePorts();
    const state = join(bin, '..', 'instance.json');
    writeFileSync(
      state,
      JSON.stringify({
        instanceId: 'phone',
        bootId: '11111111-1111-4111-8111-111111111111',
        build: { sha: 'a'.repeat(40) },
        serverPid: process.pid,
        serverFingerprint: currentProcessFingerprint(),
        uiPid: process.pid,
        uiFingerprint: currentProcessFingerprint(),
        serverPort: apiPort,
        uiPort: apiPort + 3,
        host: '127.0.0.1',
      }),
      { mode: 0o600 },
    );

    let status = 0;
    let stdout = '';
    let stderr = '';
    try {
      stdout = execFileSync(
        process.execPath,
        [installed, `--instance-state=${state}`, '--timeout-ms=1500'],
        { cwd: bin, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    } catch (error) {
      const failure = error as {
        status?: number;
        stdout?: string;
        stderr?: string;
      };
      status = failure.status ?? -1;
      stdout = String(failure.stdout ?? '');
      stderr = String(failure.stderr ?? '');
    }

    expect(stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(status).toBe(1);
    const report = JSON.parse(stdout.trim());
    expect(report).toMatchObject({
      healthy: false,
      pid: process.pid,
      failedChecks: expect.arrayContaining(['api', 'ui']),
    });
  });

  it('keeps the inlined Linux birth probe identical to the shared lookup (#2696)', () => {
    // The helper inlines the Linux branch of lookupProcessBirthFingerprint so
    // it can run as a lone installed file. Drive both through the same
    // injected /proc reads and require identical results, including every
    // null (fail-closed) case, so the copy cannot drift from the authority.
    const statWith = (command: string, startTime: string) =>
      [
        '4242',
        `(${command})`,
        'S',
        ...Array.from({ length: 18 }, (_, index) => String(index + 1)),
        startTime,
        '99',
        '100',
      ].join(' ');
    const cases: Array<{ name: string; stat: unknown; boot: unknown }> = [
      { name: 'plain', stat: statWith('node', '8675309'), boot: 'boot-a\n' },
      {
        name: 'parens and spaces in comm',
        stat: statWith('we) ird (x', '31337'),
        boot: 'boot-b',
      },
      { name: 'non-numeric start', stat: statWith('node', '12ab'), boot: 'b' },
      { name: 'empty boot id', stat: statWith('node', '1'), boot: '  \n' },
      { name: 'no command close', stat: '4242 node S 1 2 3', boot: 'b' },
      { name: 'close too early', stat: '4) S 1', boot: 'b' },
      { name: 'truncated fields', stat: '4242 (node) S 1 2 3', boot: 'b' },
      { name: 'empty stat', stat: '', boot: 'b' },
      { name: 'stat read throws', stat: new Error('ENOENT'), boot: 'b' },
      {
        name: 'boot read throws',
        stat: statWith('node', '5'),
        boot: new Error('EACCES'),
      },
    ];
    let nonNull = 0;
    for (const { name, stat, boot } of cases) {
      const readFile = ((file: string) => {
        const value = file.endsWith('/stat') ? stat : boot;
        if (value instanceof Error) throw value;
        if (file !== '/proc/4242/stat' && !file.endsWith('/boot_id'))
          throw new Error(`unexpected read ${file}`);
        return value;
      }) as unknown as typeof readFileSync;
      const shared = lookupProcessBirthFingerprint(4242, {
        platform: 'linux',
        readFile,
      });
      const inlined = linuxProcessBirthFingerprint(4242, readFile);
      expect({ name, inlined }).toEqual({ name, inlined: shared });
      if (shared !== null) nonNull += 1;
    }
    // Both the success and the null branches were reached.
    expect(nonNull).toBe(2);
    expect(
      linuxProcessBirthFingerprint(4242, ((file: string) =>
        file.endsWith('/stat')
          ? statWith('node', '8675309')
          : 'boot-a\n') as unknown as typeof readFileSync),
    ).toBe('linux:boot-a:8675309');
  });

  it('snapshots all expected processes and listener ports once per phase', () => {
    const deadline = Date.now() + 1_000;
    const ps = vi
      .fn()
      .mockReturnValue(
        '  41 Mon Jul 13 10:00:00 2026 node server.js\n  42 Mon Jul 13 10:00:01 2026 node ui.js\n',
      );
    const fingerprints = inspectProcessFingerprints(
      [41, 42, 41],
      deadline,
      ps,
      // The lstart-shaped fixture is the non-Linux probe; the Linux probe
      // (next test) observes birth through /proc and would not parse it.
      { platform: 'darwin' },
    );

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

  it('observes a Linux pid through the /proc birth token the CLI records (#2332)', () => {
    // #2325 moved `station start`'s Linux fingerprint to the shared /proc
    // birth token. The health probe kept `ps -o lstart=`, which can never
    // equal it, so every Linux probe reported `process` / `ownership-post`.
    // Record through the CLI's own recorder and observe through the probe,
    // with the same injected /proc and `ps`, and require identical output.
    const births = new Map([
      [41, ['linux:boot-a:1000']],
      [42, ['linux:boot-a:2000']],
    ]);
    const birth = (pid: number) => births.get(pid)?.[0] ?? null;
    const commands = new Map([
      [41, 'node dist-server/server.js --instance=stagephone'],
      [42, 'node dist-server/ui-proxy.js --instance=stagephone'],
    ]);
    const cliExec = ((_: string, args: readonly string[]) =>
      commands.get(Number(args.at(-1))) ?? '') as typeof execFileSync;
    const recorded = [41, 42].map((pid) =>
      recordProcessFingerprint(pid, {
        platform: 'linux',
        birth,
        exec: cliExec,
      }),
    );
    expect(recorded[0]?.startToken).toBe('linux:boot-a:1000');

    const ps = vi.fn(
      () =>
        `   41 ${commands.get(41)}\n   42 ${commands.get(42)}\n   43 not asked\n`,
    );
    const observed = inspectProcessFingerprints(
      [41, 42, 41, 44],
      Date.now() + 1_000,
      ps,
      { platform: 'linux', birth },
    );

    expect(observed.get(41)).toEqual(recorded[0]);
    expect(observed.get(42)).toEqual(recorded[1]);
    // No birth for 44 (no /proc entry): it is not asked for, and not observed.
    expect(ps).toHaveBeenCalledTimes(1);
    expect(ps.mock.calls[0]?.[1]).toEqual([
      '-o',
      'pid=',
      '-o',
      'command=',
      '-p',
      '41,42',
    ]);
    expect(observed.has(44)).toBe(false);
    expect(observed.has(43)).toBe(false);
  });

  it('leaves a Linux pid unobserved when it is reused between the birth and command reads', () => {
    let reads = 0;
    const birth = () =>
      reads++ === 0 ? 'linux:boot-a:1000' : 'linux:boot-a:9999';
    const observed = inspectProcessFingerprints(
      [41],
      Date.now() + 1_000,
      () => '   41 node something-else.js\n',
      { platform: 'linux', birth },
    );
    expect(observed.has(41)).toBe(false);
  });

  it('agrees with the CLI recorder on a live process on this host', () => {
    // Real probes, no injection: whichever platform runs this, the token the
    // health probe observes must be the token `station start` records. On a
    // Linux runner this is the /proc path, on macOS the pinned lstart path.
    const recorded = recordProcessFingerprint(process.pid);
    expect(recorded).not.toBeNull();
    const observed = inspectProcessFingerprints(
      [process.pid],
      Date.now() + 5_000,
    );
    expect(observed.get(process.pid)).toEqual(recorded);
    // ...and it is the shared identity authority's birth token.
    expect(observed.get(process.pid)?.startToken).toBe(
      lookupProcessBirthFingerprint(process.pid),
    );
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
