import { createServer } from 'node:http';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  devServerOrigin,
  installDevDependencies,
  listenDevServer,
} from '../dev/server.js';

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

describe('plugin dev listener', () => {
  test('binds the production listener seam to explicit IPv4 loopback', async () => {
    const server = createServer((_req, res) => res.end('ok'));
    servers.push(server);
    const address = await listenDevServer(server, 0);
    expect(address.address).toBe('127.0.0.1');
    expect(address.family).toBe('IPv4');
    expect(address.port).toBeGreaterThan(0);
    expect(devServerOrigin(address)).toBe(`http://127.0.0.1:${address.port}`);
  });
});

describe('plugin dev dependencies', () => {
  test('a dependency installed but not active does not leave the dev process exiting 2', async () => {
    const before = process.exitCode;
    process.exitCode = undefined;
    try {
      // What `install` does for a saved-but-inactive dependency.
      const installDependency = vi.fn(async () => {
        process.exitCode = 2;
        return { pluginName: 'dep', version: '1.0.0' };
      });
      await installDevDependencies(
        { dependencies: [{ id: 'dep', source: './dep' }] },
        installDependency,
        '/nonexistent-plugins-dir',
      );
      expect(installDependency).toHaveBeenCalledWith('./dep', []);
      expect(process.exitCode).toBeUndefined();
    } finally {
      process.exitCode = before;
    }
  });
});
