/**
 * #4769: the Seatbelt profile's restricted network under the real kernel.
 * Every case runs a real `sandbox-exec` child through the production
 * provider (`confine`), the production profile builder and the production
 * spawn wrapper (`confinedClaudeSpawn` with an egress broker), and reads
 * what the kernel allowed.
 *
 * Nothing reaches the internet: an "outside" host is a local listener on a
 * port the profile does not allow (another loopback port, standing in for
 * Station's own, and this host's non-loopback address when it has one), and
 * the broker's upstreams are local stand-ins reached through its `lookup`
 * and `dial` seams. What is under test here is the kernel's refusal of every
 * connection but the broker's port, and the broker's answer through it; the
 * broker's policy is unit-tested in `egress-broker.test.ts`.
 *
 * Skips LOUDLY (the reason is on stderr) where the production profile does
 * not apply. Titles are fixed on every host: `scripts/required-test-profiles.json`
 * pins them in the `seatbelt-kernel` profile.
 */
import { spawn as spawnChild, spawnSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import {
  connect,
  createServer,
  type Server,
  type Socket,
  connect as tcpConnect,
} from 'node:net';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createClaudeEngineProcess } from '../../../providers/adapters/claude-code-spawn.js';
import {
  confinedClaudeSpawn,
  prepareConfinedClaudeLaunch,
} from '../../../providers/adapters/claude-seatbelt.js';
import {
  type EgressBroker,
  parseEgressHostRule,
  startEgressBroker,
} from '../egress-broker.js';
import {
  canonicalPath,
  createSeatbeltConfinementProvider,
  probeSeatbelt,
  SANDBOX_EXEC,
  seatbeltProfileNetwork,
} from '../seatbelt.js';

const probe =
  process.platform === 'darwin'
    ? probeSeatbelt()
    : {
        ok: false,
        reason: `Seatbelt is macOS-only; this host is ${process.platform}`,
      };
if (!probe.ok)
  process.stderr.write(
    `\n[seatbelt-network.process] SKIPPED: the production Seatbelt profile cannot apply here: ${probe.reason}\n`,
  );

/** The installed Claude Code, for the live handshake case. */
const claudeExecutable = (() => {
  if (!probe.ok) return undefined;
  const found = spawnSync('/usr/bin/which', ['claude'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return found.status === 0 && found.stdout.trim()
    ? canonicalPath(found.stdout.trim())
    : undefined;
})();
if (probe.ok && !claudeExecutable)
  process.stderr.write(
    '\n[seatbelt-network.process] SKIPPED live Claude case: no `claude` on PATH\n',
  );

/**
 * A Node client the confined process runs: `tcp <host> <port>`, `unix
 * <path>`, `udp <host> <port>`, or `connect <host:port>` through the broker
 * named by `HTTPS_PROXY`, sending `ping` once tunnelled. It prints one line:
 * what happened.
 */
const CLIENT = `
const net = require('node:net');
const dgram = require('node:dgram');
const [kind, a, b] = process.argv.slice(1);
const done = (text) => { process.stdout.write(text + '\\n'); process.exit(0); };
setTimeout(() => done('TIMEOUT'), 8000).unref();
if (kind === 'udp') {
  const socket = dgram.createSocket('udp4');
  socket.on('error', (error) => done('ERR ' + error.code));
  socket.send('x', Number(b), a, (error) => done(error ? 'ERR ' + error.code : 'SENT'));
} else if (kind === 'connect') {
  const proxy = new URL(process.env.HTTPS_PROXY);
  const socket = net.connect(Number(proxy.port), proxy.hostname);
  let text = '';
  socket.on('connect', () => socket.write('CONNECT ' + a + ' HTTP/1.1\\r\\nHost: ' + a + '\\r\\n\\r\\n'));
  socket.on('data', (chunk) => {
    text += chunk.toString('latin1');
    if (text.startsWith('HTTP/1.1 200') && text.includes('\\r\\n\\r\\n') && !text.includes('upstream:')) socket.write('ping');
    if (text.includes('upstream:ping')) done('TUNNELLED ' + text.split('\\r\\n')[0]);
  });
  socket.on('close', () => done('CLOSED ' + text.split('\\r\\n')[0]));
  socket.on('error', (error) => done('ERR ' + error.code));
} else {
  const socket = kind === 'unix' ? net.connect({ path: a }) : net.connect(Number(b), a);
  socket.on('connect', () => done('CONNECTED'));
  socket.on('error', (error) => done('ERR ' + error.code));
}
`;

/** A stand-in's socket: a client that leaves first is not an error here. */
function quiet(socket: Socket): Socket {
  socket.on('error', () => undefined);
  return socket;
}

async function listen(server: Server, host = '127.0.0.1'): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return address.port;
}

/** An address of this host that is not loopback, when it has one. */
function nonLoopbackAddress(): string | undefined {
  for (const entries of Object.values(networkInterfaces()))
    for (const entry of entries ?? [])
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
  return undefined;
}

describe.skipIf(!probe.ok)(
  // One title on every host, so a skipped run reports the same ids (#4772).
  'Seatbelt restricted network under the real kernel',
  () => {
    const makeTempDir = trackTempDirs({ lifetime: 'file' });
    const provider = createSeatbeltConfinementProvider();
    const servers: Server[] = [];
    let root: string;
    let home: string;
    let stationRoot: string;
    let stationHome: string;
    let workspace: string;
    let socketDir: string;
    let socketPath: string;
    let otherPort: number;
    let upstreamPort: number;
    let outsidePort: number;
    let broker: EgressBroker;

    beforeAll(async () => {
      root = canonicalPath(makeTempDir('seatbelt-network-'));
      home = join(root, 'home');
      stationRoot = join(home, '.station');
      stationHome = join(stationRoot, 'instances', 'test');
      workspace = join(root, 'workspace');
      for (const dir of [home, stationHome, workspace])
        mkdirSync(dir, { recursive: true });
      // A listener on another loopback port: Station's own port, say.
      const other = createServer((socket) => quiet(socket).end('other\n'));
      otherPort = await listen(other);
      // The broker's upstream for an allowed host.
      const upstream = createServer((socket) =>
        quiet(socket).once('data', (chunk) => socket.end(`upstream:${chunk}`)),
      );
      upstreamPort = await listen(upstream);
      // A listener on every address: "outside" when reached by this host's
      // non-loopback address.
      const outside = createServer((socket) => quiet(socket).end('outside\n'));
      outsidePort = await listen(outside, '0.0.0.0');
      // A Unix socket at a known path, as an SSH agent's is (a short one:
      // a socket path is limited to 104 bytes here).
      socketDir = mkdtempSync('/tmp/sbn-');
      socketPath = join(socketDir, 'agent.sock');
      const unix = createServer((socket) => quiet(socket).end('unix\n'));
      await new Promise<void>((resolve) => unix.listen(socketPath, resolve));
      servers.push(other, upstream, outside, unix);
      broker = await startEgressBroker({
        allowedHosts: [parseEgressHostRule('allowed.test')!],
        // Hermetic: documentation addresses, dialled to the local stand-in.
        lookup: async (host) =>
          host === 'allowed.test' ? ['203.0.113.10'] : ['203.0.113.11'],
        dial: () => connect(upstreamPort, '127.0.0.1'),
      });
    });

    afterAll(async () => {
      await broker?.close();
      for (const server of servers) server.close();
      rmSync(socketDir, { recursive: true, force: true });
    });

    /** Runs the client under the production restricted profile. */
    async function confined(...args: string[]) {
      const launch = await prepareConfinedClaudeLaunch({
        workspace: canonicalPath(workspace),
        configDir: join(stationHome, 'confined-homes', 'claude'),
        stationHome,
        home,
        stationRoot,
      });
      const spawn = confinedClaudeSpawn(provider, launch, new Set(), {
        broker,
      });
      const wrapped = spawn.wrap({
        command: process.execPath,
        args: ['-e', CLIENT, ...args],
        cwd: workspace,
        env: { PATH: '/usr/bin:/bin', HOME: home },
      });
      // Asynchronous: the broker answers from this process's event loop.
      const result = await new Promise<{
        status: number | null;
        stdout: string;
        stderr: string;
      }>((resolve, reject) => {
        const child = spawnChild(wrapped.command, wrapped.args, {
          cwd: wrapped.cwd,
          env: wrapped.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30_000,
          windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        child.once('error', reject);
        child.once('close', (status) => resolve({ status, stdout, stderr }));
      });
      launch.cleanup();
      return {
        status: result.status,
        line: result.stdout.trim(),
        stderr: result.stderr,
        wrapped,
        network: spawn.pending()?.network?.(),
      };
    }

    /** Runs the client with no sandbox, as a control. */
    function unconfined(...args: string[]): string {
      return spawnSync(process.execPath, ['-e', CLIENT, ...args], {
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
      }).stdout.trim();
    }

    test('the spawn is the restricted profile: one rule, to the broker port, and the proxy points at it', async () => {
      const result = await confined('tcp', '127.0.0.1', String(broker.port));
      expect(result.wrapped.command).toBe(SANDBOX_EXEC);
      const profile = result.wrapped.args[1]!;
      expect(profile).not.toContain('(allow network*)');
      expect(profile).toContain(
        `(allow network-outbound (remote tcp "localhost:${broker.port}"))`,
      );
      expect(seatbeltProfileNetwork(profile)).toBe('restricted');
      expect(result.network).toBe('restricted');
      expect(result.wrapped.env.HTTPS_PROXY).toBe(
        `http://127.0.0.1:${broker.port}`,
      );
      expect(result.line, result.stderr).toBe('CONNECTED');
    });

    test('a direct TCP connection to another loopback port is refused by the kernel', async () => {
      expect(unconfined('tcp', '127.0.0.1', String(otherPort))).toBe(
        'CONNECTED',
      );
      const result = await confined('tcp', '127.0.0.1', String(otherPort));
      expect(result.line, result.stderr).toBe('ERR EPERM');
    });

    test('a direct TCP connection to an outside address is refused by the kernel', async (ctx) => {
      // Refused before any packet leaves: EPERM, not a timeout.
      const result = await confined('tcp', '192.0.2.1', '443');
      expect(result.line, result.stderr).toBe('ERR EPERM');
      const address = nonLoopbackAddress();
      if (!address) {
        ctx.skip('this host has no non-loopback IPv4 address to compare');
        return;
      }
      expect(unconfined('tcp', address, String(outsidePort))).toBe('CONNECTED');
      expect((await confined('tcp', address, String(outsidePort))).line).toBe(
        'ERR EPERM',
      );
    });

    test('a Unix socket at a known path is refused by the kernel', async () => {
      expect(unconfined('unix', socketPath)).toBe('CONNECTED');
      const result = await confined('unix', socketPath);
      expect(result.line, result.stderr).toBe('ERR EPERM');
    });

    test('a UDP datagram is refused by the kernel', async () => {
      const receiver = createSocket('udp4');
      await new Promise<void>((resolve) =>
        receiver.bind(0, '127.0.0.1', resolve),
      );
      try {
        const port = String(receiver.address().port);
        expect(unconfined('udp', '127.0.0.1', port)).toBe('SENT');
        const result = await confined('udp', '127.0.0.1', port);
        expect(result.line, result.stderr).toBe('ERR EPERM');
      } finally {
        receiver.close();
      }
    });

    test('a connection through the broker to an allowed host is tunnelled to it', async () => {
      const before = broker.decisions().length;
      const result = await confined('connect', 'allowed.test:443');
      expect(result.line, result.stderr).toBe(
        'TUNNELLED HTTP/1.1 200 Connection Established',
      );
      expect(broker.decisions().slice(before)).toEqual([
        {
          at: expect.any(String),
          verdict: 'allowed',
          reason: 'allowed-host',
          host: 'allowed.test',
          port: 443,
        },
      ]);
    });

    test('a connection through the broker to a host that is not allowed gets 403, and is recorded', async () => {
      const before = broker.decisions().length;
      const result = await confined('connect', 'denied.test:443');
      expect(result.line, result.stderr).toBe('CLOSED HTTP/1.1 403 Forbidden');
      expect(broker.decisions().slice(before)).toEqual([
        {
          at: expect.any(String),
          verdict: 'denied',
          reason: 'not-allowed',
          host: 'denied.test',
          port: 443,
        },
      ]);
    });

    test.skipIf(!claudeExecutable)(
      // One title on every host, so a skipped run reports the same id (#4772).
      'the installed Claude Code answers its handshake inside the restricted profile, and its model request reaches the model endpoint only through the broker',
      async () => {
        // The model endpoint is a local stand-in that records the first
        // bytes it receives: a TLS ClientHello arriving there came through
        // the broker's tunnel, since the profile refuses a direct connect.
        let received: Buffer | undefined;
        let arrived: () => void = () => undefined;
        const reached = new Promise<void>((resolve) => {
          arrived = resolve;
        });
        const model = createServer((socket: Socket) => {
          quiet(socket).once('data', (chunk) => {
            received = chunk;
            arrived();
            socket.destroy();
          });
        });
        const modelPort = await listen(model);
        const modelBroker = await startEgressBroker({
          allowedHosts: [],
          lookup: async () => ['127.0.0.1'],
          dial: (_address, port) => tcpConnect(port, '127.0.0.1'),
        });
        const launch = await prepareConfinedClaudeLaunch({
          workspace: canonicalPath(workspace),
          configDir: join(stationHome, 'confined-homes', 'claude'),
          stationHome,
          stationRoot,
        });
        const confinedSpawn = confinedClaudeSpawn(provider, launch, new Set(), {
          broker: modelBroker,
        });
        const engine = createClaudeEngineProcess(undefined, confinedSpawn.wrap);
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let sent = false;
        // One user message once the handshake is answered, then held open.
        const prompt: AsyncIterable<SDKUserMessage> = {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              if (!sent) {
                sent = true;
                return {
                  done: false,
                  value: {
                    type: 'user',
                    message: { role: 'user', content: 'Say ok.' },
                    parent_tool_use_id: null,
                    session_id: '',
                  },
                };
              }
              await held;
              return { done: true, value: undefined };
            },
          }),
        };
        const live = query({
          prompt,
          options: {
            pathToClaudeCodeExecutable: claudeExecutable!,
            cwd: workspace,
            settingSources: [],
            persistSession: false,
            env: {
              PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
              HOME: homedir(),
              USER: process.env.USER ?? 'station',
              // A fake credential: the stand-in never answers, so no model
              // is reached and the operator's login is never involved.
              ANTHROPIC_API_KEY: 'sk-ant-api03-fake-for-station-tests',
              ANTHROPIC_BASE_URL: `https://model.test:${modelPort}`,
              DISABLE_AUTOUPDATER: '1',
            },
            spawnClaudeCodeProcess: engine.spawn,
          },
        });
        let handshake: 'completed' | 'failed' = 'failed';
        const drained = (async () => {
          try {
            for await (const _message of live) {
              // Drained so the engine keeps going; nothing to read.
            }
          } catch {
            // The engine is closed below.
          }
        })();
        try {
          await Promise.race([
            live.initializationResult(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('timed out')), 45_000),
            ),
          ]);
          handshake = 'completed';
          await Promise.race([
            reached,
            new Promise((resolve) => setTimeout(resolve, 45_000)),
          ]);
        } finally {
          release();
          live.close();
          await engine.terminate();
          await drained;
          launch.cleanup();
          await modelBroker.close();
          model.close();
        }
        const spawned = engine.spawned();
        expect(spawned?.command).toBe(SANDBOX_EXEC);
        expect(seatbeltProfileNetwork(spawned?.args[1])).toBe('restricted');
        expect(
          confinedSpawn.pending()?.observe({
            spawned,
            handshake,
            bounds: launch.bounds,
          }),
          engine.stderrTail(),
        ).toBe('confined');
        expect(confinedSpawn.pending()?.network?.()).toBe('restricted');
        // A TLS handshake record (0x16), through the tunnel.
        expect(received?.[0], JSON.stringify(modelBroker.decisions())).toBe(
          0x16,
        );
        expect(modelBroker.decisions()).toContainEqual({
          at: expect.any(String),
          verdict: 'allowed',
          reason: 'model-endpoint',
          host: 'model.test',
          port: modelPort,
        });
      },
      120_000,
    );
  },
);
