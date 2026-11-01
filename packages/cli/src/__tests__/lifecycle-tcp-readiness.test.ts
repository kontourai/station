import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.js';
import {
  describeSocketError,
  lastFatalServerLogLine,
  serverStartFailureContext,
  waitForTcpOk,
} from '../commands/lifecycle.js';

const makeTempDir = trackTempDirs();

const servers: Server[] = [];

/** A port that is free now: bound, read and released. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const timers: ReturnType<typeof setTimeout>[] = [];

function listenAfter(port: number, delayMs: number): void {
  timers.push(
    setTimeout(() => {
      const server = createServer();
      servers.push(server);
      server.listen(port, '127.0.0.1');
    }, delayMs),
  );
}

afterEach(async () => {
  for (const timer of timers.splice(0)) clearTimeout(timer);
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

describe('waitForTcpOk slow-boot extension (#2964)', () => {
  test('a listener that opens after the base deadline is reached while the child is alive', async () => {
    const port = await freePort();
    const lines: string[] = [];
    listenAfter(port, 450);
    await waitForTcpOk('127.0.0.1', port, 150, {
      childAlive: () => true,
      // Generous: the wait returns on connect, so a wide extension only
      // costs time when the listener never opens.
      extensionMs: 1_000,
      maxExtensions: 2,
      log: (line) => lines.push(line),
    });
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toContain(`TCP listener 127.0.0.1:${port}`);
    expect(lines[0]).toContain('1/2');
  });

  test('without a child probe the base deadline is the whole budget', async () => {
    const port = await freePort();
    listenAfter(port, 450);
    await expect(waitForTcpOk('127.0.0.1', port, 150)).rejects.toThrow(
      `Timed out waiting for TCP listener 127.0.0.1:${port}`,
    );
  });

  test('extensions are bounded: a listener that never opens still times out', async () => {
    const port = await freePort();
    const lines: string[] = [];
    const started = Date.now();
    await expect(
      waitForTcpOk('127.0.0.1', port, 100, {
        childAlive: () => true,
        extensionMs: 100,
        maxExtensions: 2,
        log: (line) => lines.push(line),
      }),
    ).rejects.toThrow(`Timed out waiting for TCP listener 127.0.0.1:${port}`);
    expect(lines).toHaveLength(2);
    // Base plus two extensions, and not a third.
    expect(Date.now() - started).toBeGreaterThanOrEqual(280);
  });

  test('stops at once when the child has exited', async () => {
    const port = await freePort();
    const started = Date.now();
    await expect(
      waitForTcpOk('127.0.0.1', port, 5_000, { childAlive: () => false }),
    ).rejects.toThrow(
      `Managed server exited before TCP listener 127.0.0.1:${port} was ready`,
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('start failure names its cause (#4382)', () => {
  test('a refused localhost connect is not an empty ()', async () => {
    // `localhost` resolves to ::1 and 127.0.0.1 on Windows; when both refuse,
    // Node raises an AggregateError whose own message is empty.
    const port = await freePort();
    const failure = await waitForTcpOk('localhost', port, 5_000, {
      childAlive: () => false,
    }).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    const { message } = failure as Error;
    expect(message).toContain(
      `Managed server exited before TCP listener localhost:${port} was ready (`,
    );
    expect(message).not.toMatch(/\(\)$/);
  });

  test('an AggregateError reads as its inner failures, or its code', () => {
    const refused = (address: string) =>
      Object.assign(new Error(`connect ECONNREFUSED ${address}`), {
        code: 'ECONNREFUSED',
      });
    expect(
      describeSocketError(
        new AggregateError([refused('::1:4'), refused('127.0.0.1:4')], ''),
      ),
    ).toBe('connect ECONNREFUSED ::1:4; connect ECONNREFUSED 127.0.0.1:4');
    expect(
      describeSocketError(
        Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' }),
      ),
    ).toBe('ECONNREFUSED');
    expect(describeSocketError(new Error('timeout'))).toBe('timeout');
  });

  test("names the server log's last fatal line since this start, and the log", () => {
    const dir = makeTempDir('station-start-failure-');
    const log = join(dir, 'station-x.log');
    const fatal =
      "Error: STATION_HOME_RESET_REQUIRED: Station home '/h' uses an incompatible schema.";
    writeFileSync(
      log,
      [
        '--- 2026-10-31T19:00:00.000Z station lifecycle start instance=x build=a pid=1 ---',
        'Error: listen EADDRINUSE: address already in use 127.0.0.1:1',
        '',
        '--- 2026-10-31T19:16:29.000Z station lifecycle start instance=x build=a pid=2 supervised ---',
        '[station-supervisor] 2026-10-31T19:16:29.260Z generation 1 started (pid 3)',
        `\u001b[31m${fatal}\u001b[39m`,
        '    at reset (file:///x/command-station.js:1:1)',
        '    at main (file:///x/command-station.js:2:2)',
        '[station-supervisor] 2026-10-31T19:16:54.262Z generation 1 exited code=1 signal=null',
        '',
      ].join('\n'),
    );
    expect(lastFatalServerLogLine(log)).toBe(fatal);
    expect(serverStartFailureContext(log)).toEqual([
      `Last server error: ${fatal}`,
      `Server log: ${log}`,
    ]);

    // No error since this start's header: an earlier boot's is not named.
    writeFileSync(
      log,
      [
        'Error: an earlier boot',
        '--- 2026-10-31T19:20:00.000Z station lifecycle start instance=x build=a pid=4 ---',
        'starting',
      ].join('\n'),
    );
    expect(lastFatalServerLogLine(log)).toBeNull();
    const missing = join(dir, 'missing.log');
    expect(serverStartFailureContext(missing)).toEqual([
      `Server log: ${missing}`,
    ]);
  });
});
