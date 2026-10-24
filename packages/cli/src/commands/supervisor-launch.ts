/**
 * How a lifecycle start runs the core server, and how the CLI talks to the
 * Station process supervisor once it runs one.
 *
 * `station start`, and through it `station service run` (the installed
 * service, the container entrypoint and the archive launcher's service
 * child), starts the supervisor bundle that ships beside the server bundle.
 * The supervisor forks the core server as a supervised generation, holds its
 * listeners, and lets `station restart` hand off to a new generation without
 * refusing a connection. The instance record then names the supervisor: it
 * is the process that owns the instance for as long as it runs, while core
 * generations come and go beneath it.
 *
 * The CLI reaches a running supervisor by running that bundle as a client
 * (`--request`), so the one control-channel client ships with the supervisor
 * it talks to, and synchronous lifecycle code (`station stop`) can wait on it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { resolveInstallerOwnedArchiveVersion } from '@kontourai/station-shared/prebuilt-archive';
import {
  type ControlServerMessage,
  isValidInstanceId,
} from '@kontourai/station-supervisor/protocol';

/**
 * Set to `1` to run the core server directly, without the supervisor, as
 * every start did before the supervisor was adopted.
 */
export const DIRECT_LAUNCH_ENV = 'STATION_DIRECT_LAUNCH';

/**
 * The supervisor bundle's file name in a server build directory. Pinned in a
 * test against the name the build writes (`packages/supervisor/build-options.mjs`).
 */
export const SUPERVISOR_BUNDLE_FILENAME = 'station-supervisor.js';

/** `station-supervisor --request` exits 3 when no supervisor runs there. */
const CLIENT_EXIT_NOT_RUNNING = 3;

type ServerLaunchPlan =
  | {
      supervised: true;
      /** Arguments for `node`: the supervisor bundle and its flags. */
      args: string[];
    }
  | {
      supervised: false;
      /** Why the start is direct, for the operator; null when expected. */
      notice: string | null;
    };

interface ServerLaunchInput {
  /** Absolute server build directory. */
  serverDir: string;
  /** Absolute core server entry inside `serverDir`. */
  entry: string;
  projectHome: string;
  instanceId: string;
  /** The tree the CLI runs from (`CWD`). */
  codeRoot: string;
  /** `--watch` runs the server from source under a watcher. */
  watch: boolean;
  /** `--lifecycle-journal` records the server pid in a journal. */
  lifecycleJournal?: string;
  /**
   * The launcher that supervises this start (`station service run`): the
   * supervisor drains and exits when it dies, as the server's own parent
   * watchdog did for a direct start.
   */
  parentPid?: number;
  env: NodeJS.ProcessEnv;
}

/**
 * Whether this start runs under the supervisor, and with what arguments.
 *
 * Direct, without a notice, when the operator opted out, for `--watch` (a
 * source watcher restarts the server itself), and for a start that keeps a
 * lifecycle journal: the journal pairs the recorded pid with the server's
 * own events, and under the supervisor those name different processes. With
 * a notice when the supervisor cannot run here: a build without the bundle,
 * or an instance id the supervisor's control channel cannot name.
 */
export function planServerLaunch(input: ServerLaunchInput): ServerLaunchPlan {
  if (input.env[DIRECT_LAUNCH_ENV] === '1') {
    return { supervised: false, notice: null };
  }
  if (input.watch || input.lifecycleJournal) {
    return { supervised: false, notice: null };
  }
  const bundle = join(input.serverDir, SUPERVISOR_BUNDLE_FILENAME);
  if (!existsSync(bundle)) {
    return {
      supervised: false,
      notice: `This build has no process supervisor (${bundle}); starting the server directly. Rebuild with \`station build\` to restart it in place later.`,
    };
  }
  if (!isValidInstanceId(input.instanceId)) {
    return {
      supervised: false,
      notice: `Instance id '${input.instanceId}' cannot name a supervisor control channel; starting the server directly.`,
    };
  }
  const buildRoot = supervisorBuildRoot(input.codeRoot);
  return {
    supervised: true,
    args: [
      bundle,
      '--entry',
      input.entry,
      '--home',
      input.projectHome,
      '--instance',
      input.instanceId,
      ...(buildRoot ? ['--build-root', buildRoot] : []),
      ...(input.parentPid !== undefined
        ? ['--parent-pid', String(input.parentPid)]
        : []),
    ],
  };
}

/**
 * The directory every handoff entry must live in. An install.sh archive
 * keeps each version in `<installRoot>/versions/<version>`, and the
 * supervisor that one version started must be able to hand off to the next,
 * so the bound is `<installRoot>/versions`. Anything else keeps the
 * supervisor's default, the initial entry's own directory.
 */
function supervisorBuildRoot(codeRoot: string): string | null {
  let physical: string;
  try {
    physical = realpathSync(codeRoot);
  } catch {
    return null;
  }
  const installed = resolveInstallerOwnedArchiveVersion(physical);
  return installed ? join(installed.installRoot, 'versions') : null;
}

interface SupervisorRequestTarget {
  /** Supervisor bundles to try, in order; the first that exists answers. */
  bundles: string[];
  home: string;
  instanceId: string;
}

interface SupervisorRequestResult {
  /** `not-running`: nothing answers there; `unavailable`: no bundle to ask with. */
  status: 'ok' | 'not-running' | 'unavailable' | 'failed';
  messages: ControlServerMessage[];
  /** The client's own explanation, for a status other than `ok`. */
  detail: string;
}

function firstBundle(target: SupervisorRequestTarget): string | null {
  return target.bundles.find((bundle) => existsSync(bundle)) ?? null;
}

function requestArgs(
  bundle: string,
  target: SupervisorRequestTarget,
  request: 'status' | 'stop' | 'handoff',
): string[] {
  return [
    bundle,
    '--request',
    request,
    '--home',
    target.home,
    '--instance',
    target.instanceId,
  ];
}

function parseMessages(stdout: string): ControlServerMessage[] {
  const messages: ControlServerMessage[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      messages.push(JSON.parse(line) as ControlServerMessage);
    } catch {
      // Not ours: the client writes only NDJSON to stdout.
    }
  }
  return messages;
}

function settle(
  code: number | null,
  stdout: string,
  stderr: string,
): SupervisorRequestResult {
  const detail = stderr.trim().replace(/^station-supervisor: /, '');
  return {
    status:
      code === 0
        ? 'ok'
        : code === CLIENT_EXIT_NOT_RUNNING
          ? 'not-running'
          : 'failed',
    messages: parseMessages(stdout),
    detail,
  };
}

/** Sends one control request and waits for it; for synchronous lifecycle code. */
export function requestSupervisorSync(
  target: SupervisorRequestTarget,
  request: 'status' | 'stop',
  timeoutMs: number,
): SupervisorRequestResult {
  const bundle = firstBundle(target);
  if (!bundle) {
    return {
      status: 'unavailable',
      messages: [],
      detail: 'no supervisor bundle to send the request with',
    };
  }
  const result = spawnSync(
    process.execPath,
    requestArgs(bundle, target, request),
    {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.error) {
    return {
      status: 'failed',
      messages: parseMessages(result.stdout ?? ''),
      detail: result.error.message,
    };
  }
  return settle(result.status, result.stdout ?? '', result.stderr ?? '');
}

/**
 * Asks for a handoff and reports each progress message as it arrives.
 * Resolves once the client exits with the handoff's result.
 */
export function runSupervisorHandoff(
  target: SupervisorRequestTarget,
  onMessage: (message: ControlServerMessage) => void,
): Promise<SupervisorRequestResult> {
  const bundle = firstBundle(target);
  if (!bundle) {
    return Promise.resolve({
      status: 'unavailable',
      messages: [],
      detail: 'no supervisor bundle to send the request with',
    });
  }
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      requestArgs(bundle, target, 'handoff'),
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let pending = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      pending += chunk;
      for (
        let newline = pending.indexOf('\n');
        newline >= 0;
        newline = pending.indexOf('\n')
      ) {
        const [message] = parseMessages(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        if (message) onMessage(message);
      }
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) =>
      resolve({ status: 'failed', messages: [], detail: error.message }),
    );
    child.on('close', (code) => resolve(settle(code, stdout, stderr)));
  });
}
