/**
 * Polling server watcher for `station start --watch` with
 * `STATION_DEV_WATCH_POLL=1`.
 *
 * `tsx watch` cannot be made to poll: its chokidar picks fsevents before it
 * reads CHOKIDAR_USEPOLLING, so on a host where native events never arrive the
 * server would never restart. This runs the same entry under `tsx` and
 * restarts it when a watched source file changes, using chokidar's polling
 * mode. It watches whole source trees rather than the import graph, which
 * over-restarts slightly and never under-restarts.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import chokidar from 'chokidar';

const root = process.cwd();
const tsxCli = createRequire(path.join(root, 'package.json')).resolve(
  'tsx/cli',
);
const entry = process.argv[2] ?? path.join('src-server', 'index.ts');
const intervalMs = Number(process.env.CHOKIDAR_INTERVAL ?? 300);
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|json)$/;

let child: ChildProcess | undefined;
let stopping = false;
let restarting = false;
let timer: NodeJS.Timeout | undefined;

function launch(): void {
  child = spawn(process.execPath, [tsxCli, entry], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('exit', (code, signal) => {
    child = undefined;
    if (stopping) process.exit(code ?? (signal ? 1 : 0));
    // A crash waits for the next edit; a requested restart relaunches below.
    if (!restarting)
      console.log(
        `[dev-server-watch] exited (${code ?? signal}); waiting for a change`,
      );
  });
}

async function restart(file: string): Promise<void> {
  if (restarting || stopping) return;
  restarting = true;
  console.log(
    `[dev-server-watch] change in ${path.relative(root, file)}; restarting`,
  );
  const running = child;
  if (running) {
    const exited = new Promise<void>((resolve) =>
      running.once('exit', () => resolve()),
    );
    running.kill('SIGTERM');
    const force = setTimeout(() => running.kill('SIGKILL'), 15_000);
    await exited;
    clearTimeout(force);
  }
  restarting = false;
  if (!stopping) launch();
}

const roots = ['src-server', 'src-shared', 'packages'].map((dir) =>
  path.join(root, dir),
);
chokidar
  .watch(roots, {
    usePolling: true,
    interval: intervalMs,
    ignoreInitial: true,
    ignored: (candidate) =>
      /(?:^|[\\/])(?:node_modules|dist|\.[^\\/]+)(?:[\\/]|$)/.test(candidate) ||
      (path.extname(candidate) !== '' && !SOURCE_FILE.test(candidate)),
  })
  .on('all', (_event, file) => {
    if (!SOURCE_FILE.test(file)) return;
    clearTimeout(timer);
    timer = setTimeout(() => void restart(file), 300);
  });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
    if (child) child.kill(signal);
    else process.exit(0);
  });
}
launch();
