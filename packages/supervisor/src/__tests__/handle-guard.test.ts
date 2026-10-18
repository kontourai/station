/**
 * The supervisor relies on Node internals: a listening `net.Server` exposes its
 * raw handle as `_handle`, the raw handle can be sent over the fork IPC channel
 * and held by a process that never accepts, and `server.listen(handle)` adopts
 * it in another process. If a Node upgrade breaks any of that, this fails
 * before the supervisor silently starts refusing connections.
 */
import { type ChildProcess, fork } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const CHILD = fileURLToPath(
  new URL('./__fixtures__/handle-guard-child.mjs', import.meta.url),
);
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL');
  }
});

function start(mode: 'bind' | 'adopt'): ChildProcess {
  const child = fork(CHILD, [mode], {
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
  });
  children.push(child);
  return child;
}

function nextMessage<T>(
  child: ChildProcess,
): Promise<{ message: T; handle: unknown }> {
  return new Promise((resolve, reject) => {
    child.once('message', (message, handle) =>
      resolve({ message: message as T, handle }),
    );
    child.once('exit', (code) =>
      reject(new Error(`child exited (${code}) before messaging`)),
    );
  });
}

function get(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(
        { host: '127.0.0.1', port, agent: false, timeout: 30_000 },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            body += chunk;
          });
          res.on('end', () => resolve(body));
        },
      )
      .on('error', reject);
  });
}

describe(`listening-handle internals on Node ${process.version}`, () => {
  it('sends a raw listening handle, holds it without accepting, and adopts it elsewhere', async () => {
    const binder = start('bind');
    const bound = await nextMessage<{
      port: number;
      hasHandle: boolean;
      handleClass: string | null;
    }>(binder);
    expect(bound.message.hasHandle).toBe(true);
    expect(bound.message.handleClass).toBe('TCP');
    // Received as the raw handle (Node's `net.Native` conversion), not wrapped
    // in a net.Server that would start accepting in this process.
    const held = bound.handle as
      | { constructor: { name: string }; close(): void }
      | undefined;
    expect(held?.constructor.name).toBe('TCP');
    expect(typeof held?.close).toBe('function');
    expect(held).not.toBeInstanceOf(http.Server);

    const port = bound.message.port;
    // The supervisor tells a listening TCP wrap from a connected one by
    // getpeername: it fails (non-zero) when listening and succeeds (0) when connected.
    const peer = (
      held as unknown as { getpeername(out: object): number }
    ).getpeername({});
    expect(peer).not.toBe(0);
    const client = createConnection(port, '127.0.0.1');
    await once(client, 'connect');
    const connected = (
      client as unknown as { _handle: { getpeername(out: object): number } }
    )._handle;
    expect(connected.getpeername({})).toBe(0);
    client.destroy();
    expect(await get(port)).toBe(`bind:${binder.pid}`);

    binder.send({ type: 'exit' });
    await new Promise((resolve) => binder.once('exit', resolve));

    // Only this process holds the socket now and it never accepts: the
    // connection must queue in the backlog, not be refused.
    const pending = get(port);
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const adopter = start('adopt');
    await once(adopter, 'spawn');
    // A refusal on loopback is immediate; a whole process spawn later the
    // request is still waiting.
    expect(settled).toBe(false);
    adopter.send({ type: 'adopt' }, held as never);
    await nextMessage<{ type: string }>(adopter);
    expect(await pending).toBe(`adopt:${adopter.pid}`);
    expect(await get(port)).toBe(`adopt:${adopter.pid}`);
    held?.close();
  });
});
