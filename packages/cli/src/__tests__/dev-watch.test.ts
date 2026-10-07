import { describe, expect, it } from 'vitest';
import { isLoopbackHost, planWatchChildren } from '../commands/dev-watch.js';
import { UI_PROXY_BACKEND_PREFIXES } from '../commands/lifecycle.js';
import { UI_PROXY_BACKEND_PREFIXES as SHARED } from '../commands/ui-proxy-prefixes.js';

const base = {
  nodeExecPath: '/node',
  codeRoot: '/repo',
  serverPort: 47310,
  uiPort: 47320,
  host: '127.0.0.1',
  resolveFrom: (specifier: string) =>
    specifier === 'tsx/cli'
      ? '/repo/node_modules/tsx/dist/cli.mjs'
      : '/repo/node_modules/vite/package.json',
};

describe('station start --watch children (#3254)', () => {
  it('runs the server under tsx watch and the UI under vite dev on the instance UI port', () => {
    const plan = planWatchChildren(base);
    expect(plan.server.args).toEqual([
      '/repo/node_modules/tsx/dist/cli.mjs',
      'watch',
      '--clear-screen=false',
      'src-server/index.ts',
    ]);
    expect(plan.ui.args).toEqual([
      '/repo/node_modules/vite/bin/vite.js',
      'dev',
      '--port',
      '47320',
      '--strictPort',
      '--host',
      '127.0.0.1',
    ]);
    expect(plan.ui.env).toEqual({ STATION_DEV_API_PORT: '47310' });
  });

  it('swaps in the polling watcher only when polling is requested', () => {
    expect(planWatchChildren({ ...base, poll: true }).server.args).toEqual([
      '/repo/node_modules/tsx/dist/cli.mjs',
      'scripts/dev-server-watch.mts',
    ]);
  });

  it('serves the UI from the instance UI port so its origin is already allowed', () => {
    expect(planWatchChildren(base).ui.args).toContain('47320');
  });

  it('treats only loopback as a valid watch host', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.5')).toBe(false);
  });

  it('keeps one proxied-path list for the production listener and the dev proxy', () => {
    expect(UI_PROXY_BACKEND_PREFIXES).toBe(SHARED);
  });
});
