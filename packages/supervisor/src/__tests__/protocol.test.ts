import { existsSync, readFileSync, statSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.ts';
import { supervisorBuildOptions } from '../../build-options.mjs';
import { ControlRefusedError, connectControl } from '../control-client.ts';
import {
  CONTROL_MAX_CONNECTIONS,
  CONTROL_MAX_LINE_BYTES,
  resolveControlEndpoint,
  SUPERVISOR_PROTOCOL,
  unixSocketPathLimit,
} from '../protocol.ts';
import { makeShortHome, startSupervisor } from './harness.ts';

const makeTempDir = trackTempDirs();
const posixOnly = process.platform === 'win32' ? it.skip : it;

async function refusalOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ControlRefusedError) return error.refusal.reason;
    throw error;
  }
  throw new Error('expected the supervisor to refuse');
}

describe('supervisor control protocol (real processes)', () => {
  it('negotiates versions, capabilities, and authentication', async () => {
    const supervisor = await startSupervisor({ home: makeShortHome() });
    const { endpoint } = supervisor;
    expect(endpoint.fallbackDir).toBeNull();

    // A different major is refused before anything else.
    expect(
      await refusalOf(
        connectControl({
          path: endpoint.path,
          tokenPath: endpoint.tokenPath,
          protocol: { major: SUPERVISOR_PROTOCOL.major + 1, minor: 0 },
        }),
      ),
    ).toBe('protocol-major');

    // A wrong token is refused.
    expect(
      await refusalOf(
        connectControl({ path: endpoint.path, token: 'f'.repeat(64) }),
      ),
    ).toBe('auth');
    expect(
      await refusalOf(connectControl({ path: endpoint.path, token: '' })),
    ).toBe('auth');

    // A newer minor is accepted; unknown capabilities are ignored.
    const connection = await connectControl({
      path: endpoint.path,
      tokenPath: endpoint.tokenPath,
      protocol: {
        major: SUPERVISOR_PROTOCOL.major,
        minor: SUPERVISOR_PROTOCOL.minor + 7,
      },
      capabilities: ['events', 'teleport'],
    });
    expect(connection.welcome).toMatchObject({
      type: 'welcome',
      protocol: SUPERVISOR_PROTOCOL,
      supervisor: { instance: 'test', pid: supervisor.child.pid },
      capabilities: ['events'],
    });

    // Unknown requests are unsupported, not fatal.
    expect(
      await connection.request({ type: 'teleport', id: 'x1' }, [
        'teleport.result',
      ]),
    ).toEqual({
      type: 'error',
      id: 'x1',
      code: 'unsupported',
      message: 'unknown request type: teleport',
    });
    const status = await connection.request({ type: 'status', id: 'x2' }, [
      'status.result',
    ]);
    expect(status).toMatchObject({
      type: 'status.result',
      id: 'x2',
      status: { state: 'serving' },
    });
    expect(
      await connection.request(
        { type: 'handoff', id: 'x3', drainDeadlineMs: -1 },
        ['handoff.result'],
      ),
    ).toMatchObject({ type: 'error', code: 'bad-request' });
    connection.close();

    // Without the events capability, subscribe is unsupported.
    const plain = await connectControl({
      path: endpoint.path,
      tokenPath: endpoint.tokenPath,
    });
    expect(plain.welcome.capabilities).toEqual([]);
    expect(
      await plain.request({ type: 'subscribe', id: 'y1' }, [
        'subscribe.result',
      ]),
    ).toMatchObject({
      type: 'error',
      code: 'unsupported',
    });
    plain.close();
  }, 60_000);

  posixOnly(
    'keeps the socket, token, and run directory private',
    async () => {
      const supervisor = await startSupervisor({ home: makeShortHome() });
      const { endpoint } = supervisor;
      expect(statSync(endpoint.path).isSocket()).toBe(true);
      expect(statSync(endpoint.path).mode & 0o777).toBe(0o600);
      expect(statSync(endpoint.tokenPath).mode & 0o777).toBe(0o600);
      expect(statSync(join(endpoint.tokenPath, '..')).mode & 0o777).toBe(0o700);
    },
    60_000,
  );

  it('streams events to a subscriber and refuses an oversized line', async () => {
    const supervisor = await startSupervisor({
      home: makeTempDir('sup-events-'),
    });
    const subscriber = await supervisor.connect(['events']);
    const events: unknown[] = [];
    subscriber.onMessage((message) => {
      if (message.type === 'event') events.push(message.event);
    });
    expect(
      await subscriber.request({ type: 'subscribe', id: 'e1' }, [
        'subscribe.result',
      ]),
    ).toEqual({
      type: 'subscribe.result',
      id: 'e1',
    });
    expect(await supervisor.handoff()).toMatchObject({ outcome: 'committed' });
    // The event travels on the subscriber's own connection; it may land after the result.
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        type: 'handoff',
        phase: 'committed',
        generation: 2,
      }),
    );
    subscriber.close();

    const oversized = await supervisor.connect();
    const replies: unknown[] = [];
    oversized.onMessage((message) => replies.push(message));
    oversized.send({
      type: 'status',
      id: 'big',
      padding: 'x'.repeat(CONTROL_MAX_LINE_BYTES),
    });
    await oversized.closed;
    expect(replies).toEqual([
      {
        type: 'error',
        code: 'line-too-long',
        message: `line exceeds ${CONTROL_MAX_LINE_BYTES} bytes`,
      },
    ]);
  }, 60_000);

  it('frees the slot of every refused client, even one that keeps its end open', async () => {
    const supervisor = await startSupervisor({
      home: makeTempDir('sup-slots-'),
    });
    const hello = `${JSON.stringify({
      type: 'hello',
      protocol: SUPERVISOR_PROTOCOL,
      token: 'f'.repeat(64),
      client: { kind: 'test', version: '0' },
      capabilities: [],
    })}\n`;
    // Fill every slot with a bad-token client that never closes its own end.
    // A client that lands while an earlier connection still holds a slot is
    // dropped before it is refused; it tries again until it gets its refusal.
    const refusedClient = () =>
      new Promise<{ socket: Socket; closed: Promise<void> }>(
        (resolve, reject) => {
          const socket = createConnection({
            path: supervisor.endpoint.path,
            allowHalfOpen: true,
          });
          const closed = new Promise<void>((done) =>
            socket.once('end', () => done()),
          );
          socket.once('error', reject);
          socket.once('data', (chunk) => {
            if (chunk.toString().includes('"reason":"auth"'))
              resolve({ socket, closed });
            else reject(new Error(`unexpected reply: ${chunk}`));
          });
          socket.write(hello);
        },
      );
    // One at a time: a burst of 64 simultaneous connects is not the behavior
    // under test, and on Windows named pipes it stalls under host load.
    const refused: Array<{ socket: Socket; closed: Promise<void> }> = [];
    for (let i = 0; i < CONTROL_MAX_CONNECTIONS; i += 1) {
      let result: { socket: Socket; closed: Promise<void> } | undefined;
      await vi.waitFor(
        async () => {
          result = await refusedClient();
        },
        { timeout: 10_000, interval: 50 },
      );
      refused.push(result as { socket: Socket; closed: Promise<void> });
    }
    // The supervisor ends every refused connection itself (the clients are
    // half-open by choice, so `end` is the signal, not `close`).
    await Promise.all(refused.map(({ closed }) => closed));
    // Their slots are released promptly: a legitimate client gets in while all
    // 64 refused clients still hold their own ends open.
    await vi.waitFor(
      async () => {
        const good = await supervisor.connect();
        expect(good.welcome.type).toBe('welcome');
        good.close();
      },
      { timeout: 10_000, interval: 100 },
    );
    expect(refused.every(({ socket }) => !socket.destroyed)).toBe(true);
  }, 60_000);

  it('disconnects a client that never says hello', async () => {
    const supervisor = await startSupervisor({
      home: makeTempDir('sup-hello-'),
    });
    const socket = createConnection(supervisor.endpoint.path);
    const closed = await new Promise<string>((resolve) => {
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk.toString();
      });
      socket.on('close', () => resolve(data));
    });
    expect(closed).toBe('');
  }, 60_000);

  posixOnly(
    'falls back to a hashed private socket when the home path is too long',
    async () => {
      // The vitest temp root alone is deep; this home is well past sun_path.
      const home = join(
        makeTempDir('sup-long-'),
        'a'.repeat(40),
        'b'.repeat(40),
      );
      const inHome = join(home, 'run', 'supervisor-test.sock');
      expect(Buffer.byteLength(inHome)).toBeGreaterThan(
        unixSocketPathLimit(process.platform),
      );
      const supervisor = await startSupervisor({ home });
      const { endpoint } = supervisor;
      expect(endpoint).toEqual(
        resolveControlEndpoint({ home, instance: 'test' }),
      );
      expect(endpoint.fallbackDir).not.toBeNull();
      expect(endpoint.path.startsWith(`${endpoint.fallbackDir}/`)).toBe(true);
      expect(existsSync(inHome)).toBe(false);
      expect(statSync(endpoint.fallbackDir as string).mode & 0o777).toBe(0o700);
      expect(statSync(endpoint.path).mode & 0o777).toBe(0o600);
      // The token stays in the home.
      expect(endpoint.tokenPath).toBe(
        join(home, 'run', 'supervisor-test.token'),
      );
      expect((await supervisor.status()).state).toBe('serving');
    },
    60_000,
  );

  it('refuses a second supervisor for the same home and instance', async () => {
    const home = makeTempDir('sup-second-');
    const first = await startSupervisor({ home });
    const token = readFileSync(first.endpoint.tokenPath, 'utf8');
    const second = await startSupervisor({ home, waitForServing: false });
    const exit = await second.exited;
    expect(exit.code).toBe(1);
    expect(second.output()).toContain(
      `another supervisor (pid ${first.child.pid}) holds instance test`,
    );
    // The loser never replaced the running supervisor's token.
    expect(readFileSync(first.endpoint.tokenPath, 'utf8')).toBe(token);
    // The first one still answers with its own token.
    expect((await first.status()).supervisor.pid).toBe(first.child.pid);
  }, 60_000);

  it('drains and exits zero on stop, removing its socket and token', async () => {
    const supervisor = await startSupervisor({
      home: makeTempDir('sup-stop-'),
    });
    const connection = await supervisor.connect();
    expect(
      await connection.request({ type: 'stop', id: 'z1' }, ['stop.result']),
    ).toEqual({
      type: 'stop.result',
      id: 'z1',
      accepted: true,
    });
    expect(await supervisor.exited).toEqual({ code: 0, signal: null });
    expect(existsSync(supervisor.endpoint.tokenPath)).toBe(false);
    expect(existsSync(supervisor.endpoint.path)).toBe(false);
  }, 60_000);

  it('runs from the self-contained bundle with no node_modules in reach', async () => {
    const outDir = makeTempDir('sup-bundle-');
    const outfile = join(outDir, 'station-supervisor.js');
    await esbuild.build(supervisorBuildOptions(outfile));
    const supervisor = await startSupervisor({
      home: makeTempDir('sup-bundle-home-'),
      main: outfile,
    });
    expect((await supervisor.status()).active?.generation).toBe(1);
    expect(await supervisor.handoff()).toMatchObject({
      outcome: 'committed',
      generation: 2,
    });
  }, 60_000);
});
