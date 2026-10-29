/**
 * A core must send its raw listening handle (`server._handle`). Sending the
 * net.Server makes Node rebuild a listening server in the supervisor, which
 * would accept connections and never answer them while status said serving.
 */
import { createConnection } from 'node:net';
import { describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.ts';
import { startSupervisor, writeCoreVariant } from './harness.ts';

const makeTempDir = trackTempDirs();

function connectOutcome(port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = createConnection(port, '127.0.0.1');
    socket.setTimeout(3_000, () => {
      socket.destroy();
      resolve('ACCEPTED_NO_ANSWER');
    });
    socket.on('connect', () =>
      socket.write('GET /boot HTTP/1.1\r\nHost: x\r\n\r\n'),
    );
    socket.on('data', () => {
      socket.destroy();
      resolve('ANSWERED');
    });
    socket.on('error', (error: NodeJS.ErrnoException) =>
      resolve(error.code ?? 'ERROR'),
    );
  });
}

describe('listener handle type (real processes)', () => {
  it('fails a core that sends its net.Server and never holds an accepting server', async () => {
    const entry = writeCoreVariant(makeTempDir('sup-netserver-'), 'core', {
      FAKE_CORE_SEND_SERVER: '1',
    });
    const supervisor = await startSupervisor({
      home: makeTempDir('sup-netserver-home-'),
      entry,
      args: ['--restart-backoff-ms', '20', '--restart-max-failures', '3'],
      waitForServing: false,
    });
    const outcome = await Promise.race([
      supervisor.exited,
      // real-time: bounds how long a black-holing supervisor may keep running.
      new Promise((resolve) =>
        setTimeout(() => resolve('STILL_RUNNING'), 20_000),
      ),
    ]);
    expect(outcome, supervisor.output()).toEqual({ code: 1, signal: null });
    expect(supervisor.output()).toContain(
      'refused listener.bound from generation 1',
    );
    expect(supervisor.output()).toContain('giving up after 3 failures');
    // Nothing accepts on the port any more: refused, not swallowed.
    expect(await connectOutcome(supervisor.port)).toBe('ECONNREFUSED');
  }, 60_000);
});
