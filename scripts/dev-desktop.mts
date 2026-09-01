import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  allocateDevPorts,
  deriveDevInstanceAndHome,
  type IsPortFree,
  resolveDevOffset,
  resolveWorktreePath,
} from '../packages/cli/src/commands/dev-ports.js';
import { devPairingDeepLinkScheme } from '../packages/connect/src/core/pairingDeepLinkChannels.generated.js';
import {
  resolveStationRoot,
  spawnedStationRoot,
} from '../packages/shared/src/runtime-path-resolver.js';

export interface DesktopDevContract {
  readonly productName: string;
  readonly identifier: string;
  readonly instance: string;
  readonly home: string;
  readonly serverPort: number;
  readonly uiPort: number;
  readonly devUrl: string;
  readonly pairingDeepLinkScheme: string;
}
export function desktopTauriIdentifier(instance: string) {
  const label = instance
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `io.kontourai.station.dev.${label || 'instance'}`;
}
export function desktopDevPairingDeepLinkScheme(instance: string) {
  return devPairingDeepLinkScheme(instance);
}
function probePort(port: number): Promise<boolean> {
  return new Promise((done) => {
    const server = createServer();
    server.once('error', () => done(false));
    server.once('listening', () => server.close(() => done(true)));
    server.listen(port, '127.0.0.1');
  });
}
export async function resolveDesktopDevContract({
  cwd = process.cwd(),
  env = process.env,
  isPortFree = probePort,
  resolveWorktree = resolveWorktreePath,
}: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  isPortFree?: IsPortFree;
  resolveWorktree?: typeof resolveWorktreePath;
} = {}): Promise<DesktopDevContract> {
  const worktreePath = resolveWorktree(cwd);
  const { offset } = resolveDevOffset({
    worktreePath,
    devInstance: env.STATION_DEV_INSTANCE,
    portOffset: env.STATION_PORT_OFFSET
      ? Number(env.STATION_PORT_OFFSET)
      : undefined,
  });
  const ports = await allocateDevPorts(offset, isPortFree);
  const { instance, home } = deriveDevInstanceAndHome({
    cwd,
    worktreePath,
    devInstance: env.STATION_DEV_INSTANCE,
    // Derived, not read raw -- see dev-command.ts: a self-rooted external
    // STATION_HOME leaves STATION_ROOT unset by design.
    stationRoot: resolveStationRoot(env),
  });
  return {
    productName: `Station Dev (${instance})`,
    instance,
    identifier: desktopTauriIdentifier(instance),
    home,
    serverPort: ports.serverPort,
    uiPort: ports.uiPort,
    devUrl: `http://127.0.0.1:${ports.uiPort}`,
    pairingDeepLinkScheme: desktopDevPairingDeepLinkScheme(instance),
  };
}
/** `{ STATION_ROOT }` when the child needs it, and `{}` when naming it would
 * make the runtime home guard refuse the home (#1109). */
function spawnRootEnv(
  home: string,
  env: NodeJS.ProcessEnv,
): { STATION_ROOT?: string } {
  const root = spawnedStationRoot(home, env);
  return root ? { STATION_ROOT: root } : {};
}

export function desktopDevEnvironment(
  contract: DesktopDevContract,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...env,
    // Correct by construction rather than by an invariant about callers: a
    // paired call cannot collide, because `contract.home` is
    // `<root>/instances/dev/<id>`, but nothing stops a caller passing an env
    // whose STATION_HOME already IS that home -- and naming the root then
    // makes the child's admission guard refuse it. `spawnedStationRoot`
    // answers exactly that question, so the collision cannot be reintroduced
    // by a future caller.
    ...spawnRootEnv(contract.home, env),
    STATION_HOME: contract.home,
    STATION_DESKTOP_PORT: String(contract.serverPort),
    STATION_SERVER_PORT: String(contract.serverPort),
    STATION_UI_PORT: String(contract.uiPort),
  };
}
export function desktopDevTauriConfig(contract: DesktopDevContract) {
  return {
    productName: contract.productName,
    identifier: contract.identifier,
    build: { devUrl: contract.devUrl },
    app: { windows: [{ title: contract.productName }] },
    plugins: {
      'deep-link': {
        mobile: [{ scheme: [contract.pairingDeepLinkScheme], appLink: false }],
        desktop: { schemes: [contract.pairingDeepLinkScheme] },
      },
    },
    bundle: {
      icon: [
        'icons/dev/32x32.png',
        'icons/dev/128x128.png',
        'icons/dev/128x128@2x.png',
        'icons/dev/icon.icns',
        'icons/dev/icon.ico',
      ],
    },
  };
}
function onceExit(child: ChildProcess): Promise<number> {
  return new Promise((done) => child.once('exit', (code) => done(code ?? 1)));
}
async function main() {
  const cwd = resolve(process.cwd());
  const contract = await resolveDesktopDevContract({ cwd });
  const env = desktopDevEnvironment(contract);
  const temp = mkdtempSync(join(tmpdir(), 'station-desktop-dev-'));
  const config = join(temp, 'tauri.dev.json');
  writeFileSync(config, `${JSON.stringify(desktopDevTauriConfig(contract))}\n`);
  const vite = spawn(
    'npx',
    ['vite', 'dev', '--host', '127.0.0.1', '--port', String(contract.uiPort)],
    { cwd, env, stdio: 'inherit' },
  );
  const tauri = spawn('npx', ['tauri', 'dev', '--config', config], {
    cwd,
    env,
    stdio: 'inherit',
  });
  const stop = () => {
    if (!vite.killed) vite.kill('SIGTERM');
    if (!tauri.killed) tauri.kill('SIGTERM');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    process.exitCode = await Promise.race([onceExit(vite), onceExit(tauri)]);
  } finally {
    stop();
    rmSync(temp, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
)
  void main();
