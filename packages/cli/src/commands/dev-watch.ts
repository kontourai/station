/**
 * `station start --watch`: a development instance whose server restarts on a
 * source edit and whose UI is the Vite dev server (hot module replacement),
 * for editing Station from inside a running Station.
 *
 * It is `start` with two different children, not a second launcher: the
 * instance record, home registry entry, readiness waits, and `stop` are
 * `start`'s. This module owns only what is specific to watch mode: which
 * processes to spawn.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const DEV_API_PORT_ENV = 'STATION_DEV_API_PORT';

export function isLoopbackHost(host: string): boolean {
  return host === '::1' || host.startsWith('127.');
}

export interface WatchChild {
  command: string;
  args: string[];
}

export interface WatchChildren {
  server: WatchChild & { env: Record<string, string> };
  ui: WatchChild & { env: Record<string, string> };
}

/**
 * The two children of a watch-mode start. `codeRoot` is the checkout whose
 * node_modules provide `tsx` and `vite`; resolution is from there so a CLI
 * launched through a symlink still runs the checkout's own copies.
 */
export function planWatchChildren(opts: {
  nodeExecPath: string;
  codeRoot: string;
  serverPort: number;
  uiPort: number;
  host: string;
  /** `STATION_DEV_WATCH_POLL=1`: poll for changes instead of native events. */
  poll?: boolean;
  resolveFrom?: (specifier: string) => string;
}): WatchChildren {
  const resolve =
    opts.resolveFrom ??
    ((specifier: string) =>
      createRequire(join(opts.codeRoot, 'package.json')).resolve(specifier));
  const tsxCli = resolve('tsx/cli');
  const viteBin = join(dirname(resolve('vite/package.json')), 'bin', 'vite.js');
  return {
    server: {
      command: opts.nodeExecPath,
      // `tsx watch` cannot poll (its chokidar prefers fsevents over
      // CHOKIDAR_USEPOLLING), so the opt-in polling mode runs the same entry
      // under scripts/dev-server-watch.mts. The UI half reads
      // STATION_DEV_WATCH_POLL itself in vite.config.ts.
      args: opts.poll
        ? [tsxCli, join('scripts', 'dev-server-watch.mts')]
        : [
            tsxCli,
            'watch',
            '--clear-screen=false',
            join('src-server', 'index.ts'),
          ],
      env: {},
    },
    ui: {
      command: opts.nodeExecPath,
      args: [
        viteBin,
        'dev',
        '--port',
        String(opts.uiPort),
        '--strictPort',
        '--host',
        opts.host,
      ],
      env: { [DEV_API_PORT_ENV]: String(opts.serverPort) },
    },
  };
}
