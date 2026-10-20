/**
 * The control server's private directories: created at 0700 when missing,
 * and never adopted (or chmodded) when they already exist and are not
 * private to this user.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ControlServer, type ControlServerOptions } from '../control-server.ts';
import { type ControlEndpoint, supervisorRunDir } from '../protocol.ts';
import { makeShortHome, trackHome } from './harness.ts';

const posixOnly = process.platform === 'win32' ? it.skip : it;

/** What a connection to `path` gets: the first line, 'connected', or the error code. */
function answer(path: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    // real-time: a listener that stays silent this long has accepted the connection.
    const timer = setTimeout(() => {
      socket.destroy();
      resolve('connected');
    }, 500);
    socket.once('data', (chunk) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(chunk.toString().trim());
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve(error.code ?? 'error');
    });
  });
}

function endpointIn(home: string): ControlEndpoint {
  const run = supervisorRunDir(trackHome(home));
  return {
    path: join(run, 's.sock'),
    tokenPath: join(run, 's.token'),
    fallbackDir: null,
  };
}

function server(
  endpoint: ControlEndpoint,
  extra: Partial<ControlServerOptions> = {},
) {
  return new ControlServer({
    endpoint,
    instance: 't',
    version: '0.0.0',
    handlers: {
      status: () => {
        throw new Error('unused');
      },
      handoff: async () => ({ outcome: 'refused' }),
      stop: () => {},
      subscribe: () => () => {},
    },
    ...extra,
  });
}

describe('control server private directories', () => {
  posixOnly('creates a missing run directory at 0700', async () => {
    const home = makeShortHome();
    const control = server(endpointIn(home));
    await control.listen();
    expect(statSync(supervisorRunDir(home)).mode & 0o777).toBe(0o700);
    await control.close();
  });

  posixOnly('refuses a run directory that is a symlink', async () => {
    const home = makeShortHome();
    const target = join(home, 'elsewhere');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, supervisorRunDir(home));
    await expect(server(endpointIn(home)).listen()).rejects.toThrow(
      /is a symlink/,
    );
  });

  posixOnly('refuses a run directory owned by another user', async () => {
    const home = makeShortHome();
    mkdirSync(supervisorRunDir(trackHome(home)), { mode: 0o700 });
    const otherUid = (process.getuid?.() ?? 0) + 1;
    await expect(
      server(endpointIn(home), { currentUid: () => otherUid }).listen(),
    ).rejects.toThrow(/owned by uid \d+, not \d+/);
  });

  posixOnly(
    'refuses an existing run directory broader than 0700 and leaves its mode alone',
    async () => {
      const home = makeShortHome();
      const run = supervisorRunDir(trackHome(home));
      mkdirSync(run);
      chmodSync(run, 0o755);
      await expect(server(endpointIn(home)).listen()).rejects.toThrow(
        /mode 755 is broader than 700/,
      );
      expect(statSync(run).mode & 0o777).toBe(0o755);
    },
  );

  posixOnly(
    'never deletes or steals a socket path another process now listens on',
    async () => {
      const home = makeShortHome();
      const endpoint = endpointIn(home);
      const control = server(endpoint, { mayReplaceStaleSocket: () => true });
      await control.listen();
      // The path is deleted and another process binds it.
      rmSync(endpoint.path);
      const other = createServer((socket) => {
        // The supervisor's probe connects and disconnects at once; on Linux the
        // accepted side then sees ECONNRESET, which must not go unhandled.
        socket.on('error', () => {});
        socket.end('other\n');
      });
      await new Promise<void>((resolve) =>
        other.listen(endpoint.path, resolve),
      );
      try {
        await expect(control.rebind()).rejects.toThrow(
          `a process is already listening at ${endpoint.path}`,
        );
        expect(await answer(endpoint.path)).toBe('other');
        await control.close();
        expect(existsSync(endpoint.path)).toBe(true);
        expect(await answer(endpoint.path)).toBe('other');
      } finally {
        await new Promise((resolve) => other.close(resolve));
      }
    },
  );

  posixOnly(
    'removes its own socket file on close, and only its own',
    async () => {
      const home = makeShortHome();
      const endpoint = endpointIn(home);
      const control = server(endpoint);
      await control.listen();
      expect(await answer(endpoint.path)).toBe('connected');
      await control.close();
      expect(existsSync(endpoint.path)).toBe(false);
    },
  );

  posixOnly(
    'puts back a socket file that was swapped while it was moved aside',
    async () => {
      const home = makeShortHome();
      const endpoint = endpointIn(home);
      // Another process's socket, ready to be swapped in at the moved-aside name.
      const otherPath = join(home, 'other.sock');
      const other = createServer((socket) => {
        socket.on('error', () => {});
        socket.end('other\n');
      });
      await new Promise<void>((resolve) => other.listen(otherPath, resolve));
      const control = server(endpoint, {
        testHooks: {
          afterMoveAside: (aside: string) => renameSync(otherPath, aside),
        },
      });
      await control.listen();
      try {
        await control.close();
        // The swapped-in inode was not ours: it went back to the endpoint path.
        expect(existsSync(endpoint.path)).toBe(true);
        expect(await answer(endpoint.path)).toBe('other');
        expect(
          readdirSync(supervisorRunDir(home)).filter((name) =>
            name.startsWith('.d'),
          ),
        ).toEqual([]);
      } finally {
        await new Promise((resolve) => other.close(resolve));
      }
    },
  );
});
