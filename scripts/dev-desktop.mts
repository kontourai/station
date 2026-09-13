import type { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
import {
  executeOwnedCommand,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './lib/owned-process.mjs';

interface DesktopDevContract {
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
export function desktopDevEnvironment(
  contract: DesktopDevContract,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const spawned: NodeJS.ProcessEnv = {
    ...env,
    STATION_HOME: contract.home,
    STATION_DESKTOP_PORT: String(contract.serverPort),
    STATION_SERVER_PORT: String(contract.serverPort),
    STATION_UI_PORT: String(contract.uiPort),
  };
  // Set or REMOVED, never merged: spreading an object that omits the key
  // leaves whatever `...env` contributed, so an inherited `undefined` would
  // reach `spawn` as a non-string environment value.
  //
  // Correct by construction rather than by an invariant about callers. A
  // paired call cannot collide, since `contract.home` is
  // `<root>/instances/dev/<id>` -- but nothing stops a caller passing an env
  // whose STATION_HOME already IS that home, and naming the root then makes
  // the child's admission guard refuse it. `spawnedStationRoot` answers
  // exactly that question, so a future caller cannot reintroduce it.
  const root = spawnedStationRoot(contract.home, env);
  if (root) spawned.STATION_ROOT = root;
  else delete spawned.STATION_ROOT;
  return spawned;
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
/** The launcher settles complete process trees before releasing its config. */
export async function runDesktopDevProcesses(
  commands: readonly { executable: string; args: string[]; label: string }[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signals?: Pick<EventEmitter, 'once' | 'removeListener'>;
  },
): Promise<number> {
  const signals = options.signals ?? process;
  const executions: ReturnType<typeof executeOwnedCommand>[] = [];
  let interrupted!: (code: number) => void;
  const signalExit = new Promise<number>((resolveExit) => {
    interrupted = resolveExit;
  });
  const onInterrupt = () => interrupted(130);
  const onTerminate = () => interrupted(143);
  signals.once('SIGINT', onInterrupt);
  signals.once('SIGTERM', onTerminate);
  let startError: unknown;
  let exitCode = 1;
  try {
    for (const command of commands)
      executions.push(
        executeOwnedCommand(
          command.executable,
          command.args,
          undefined,
          command.label,
          {
            cwd: options.cwd,
            env: options.env,
            stdio: 'inherit',
            windowsHide: true,
          },
        ),
      );
    exitCode = await Promise.race([
      signalExit,
      ...executions.map(async (execution) => {
        const result = await execution.completion;
        return result.status ?? 1;
      }),
    ]);
  } catch (error) {
    startError = error;
  }
  {
    const outcomes = await Promise.allSettled(
      executions.map((execution) =>
        terminateSuiteExecution(execution, {
          processLabel: 'desktop development',
          terminationGraceMs: 5000,
          terminationForceMs: 5000,
          waitForSuiteSettlement,
        }),
      ),
    );
    signals.removeListener('SIGINT', onInterrupt);
    signals.removeListener('SIGTERM', onTerminate);
    if (
      outcomes.some(
        (outcome) => outcome.status === 'rejected' || !outcome.value.settled,
      )
    )
      throw new Error(
        'Desktop development process cleanup is incomplete; temporary configuration was retained.',
      );
  }
  if (startError) throw startError;
  return exitCode;
}

async function main() {
  const cwd = resolve(process.cwd());
  const contract = await resolveDesktopDevContract({ cwd });
  const env = desktopDevEnvironment(contract);
  const temp = mkdtempSync(join(tmpdir(), 'station-desktop-dev-'));
  const config = join(temp, 'tauri.dev.json');
  writeFileSync(config, `${JSON.stringify(desktopDevTauriConfig(contract))}\n`);
  const require = createRequire(import.meta.url);
  const vite = join(
    dirname(require.resolve('vite/package.json')),
    'bin/vite.js',
  );
  const tauri = join(
    dirname(require.resolve('@tauri-apps/cli/package.json')),
    'tauri.js',
  );
  process.exitCode = await runDesktopDevProcesses(
    [
      {
        executable: process.execPath,
        args: [
          vite,
          'dev',
          '--host',
          '127.0.0.1',
          '--port',
          String(contract.uiPort),
          '--strictPort',
        ],
        label: 'desktop Vite',
      },
      {
        executable: process.execPath,
        args: [tauri, 'dev', '--config', config],
        label: 'desktop Tauri',
      },
    ],
    { cwd, env },
  );
  rmSync(temp, { recursive: true, force: true });
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
)
  void main();
