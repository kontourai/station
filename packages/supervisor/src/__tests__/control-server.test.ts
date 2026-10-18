/**
 * The control server's private directories: created at 0700 when missing,
 * and never adopted (or chmodded) when they already exist and are not
 * private to this user.
 */
import { chmodSync, mkdirSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ControlServer, type ControlServerOptions } from '../control-server.ts';
import type { ControlEndpoint } from '../protocol.ts';
import { makeShortHome } from './harness.ts';

const posixOnly = process.platform === 'win32' ? it.skip : it;

function endpointIn(home: string): ControlEndpoint {
  const run = join(home, 'run');
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
    expect(statSync(join(home, 'run')).mode & 0o777).toBe(0o700);
    await control.close();
  });

  posixOnly('refuses a run directory that is a symlink', async () => {
    const home = makeShortHome();
    const target = join(home, 'elsewhere');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, join(home, 'run'));
    await expect(server(endpointIn(home)).listen()).rejects.toThrow(
      /is a symlink/,
    );
  });

  posixOnly('refuses a run directory owned by another user', async () => {
    const home = makeShortHome();
    mkdirSync(join(home, 'run'), { mode: 0o700 });
    const otherUid = (process.getuid?.() ?? 0) + 1;
    await expect(
      server(endpointIn(home), { currentUid: () => otherUid }).listen(),
    ).rejects.toThrow(/owned by uid \d+, not \d+/);
  });

  posixOnly(
    'refuses an existing run directory broader than 0700 and leaves its mode alone',
    async () => {
      const home = makeShortHome();
      const run = join(home, 'run');
      mkdirSync(run);
      chmodSync(run, 0o755);
      await expect(server(endpointIn(home)).listen()).rejects.toThrow(
        /mode 755 is broader than 700/,
      );
      expect(statSync(run).mode & 0o777).toBe(0o755);
    },
  );
});
