import { dirname } from 'node:path';
import { sanitizePath } from '@kontourai/station-shared/launch-path';
import type {
  CommandRunner,
  ServiceFs,
  ServiceRegistration,
} from './service.js';

/**
 * The PATH a service install would write into its unit right now: the Node
 * directory, the user's login-shell PATH, then the system directories, all
 * through `sanitizePath`. `loginShell` records whether the login shell
 * actually answered; when it did not, the candidates came from this
 * process's own PATH instead.
 */
export interface ServicePathCandidates {
  accepted: string[];
  loginShell: boolean;
  nodeDir: string;
}

const SERVICE_PATH_MARKER = '__STATION_SERVICE_PATH__';

export function collectServicePathCandidates(
  run: CommandRunner,
  fs: ServiceFs,
  options: { timeoutMs?: number } = {},
): ServicePathCandidates {
  const shell = process.env.SHELL || '/bin/sh';
  const result = run(
    shell,
    [
      '-l',
      '-c',
      `printf '${SERVICE_PATH_MARKER}%s${SERVICE_PATH_MARKER}\\n' "$PATH"`,
    ],
    {
      env: process.env,
      // SIGKILL, not spawnSync's default SIGTERM: a profile that traps TERM
      // would otherwise outlive the cap.
      ...(options.timeoutMs === undefined
        ? {}
        : { killSignal: 'SIGKILL', timeout: options.timeoutMs }),
    },
  );
  const match =
    result.status === 0 && !result.error
      ? result.stdout?.match(
          new RegExp(`${SERVICE_PATH_MARKER}(.*)${SERVICE_PATH_MARKER}`),
        )
      : null;
  const nodeDir = dirname(fs.realpathSync(process.execPath));
  const candidates = [
    nodeDir,
    ...(match?.[1] ?? process.env.PATH ?? '').split(':'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  const sanitized = sanitizePath(candidates.join(':'), {
    lstatSync: fs.lstatSync,
    realpathSync: fs.realpathSync,
  });
  return { accepted: sanitized.accepted, loginShell: Boolean(match), nodeDir };
}

/**
 * Comparison of the PATH frozen into the installed unit against the PATH a
 * reinstall would capture now (#2663). A unit's PATH is fixed at install, so
 * a directory added to the login profile later — or a Nix/home-manager
 * generation that moved on — never reaches the service until it is
 * reinstalled.
 *
 * - `missing`: directories a reinstall would capture now that the unit lacks.
 * - `stale`: directories in the unit that a reinstall would no longer capture.
 * - `reordered`: the directories both sides share appear in a different
 *   order, which changes which same-named binary wins. `position` is the
 *   zero-based index within that shared sequence.
 * - `unknown`: one side could not be read; nothing is compared or claimed.
 */
export interface ServicePathDrift {
  missing: string[];
  reason?: string;
  reordered?: { current: string; position: number; unit: string };
  stale: string[];
  status: 'current' | 'drifted' | 'unknown';
}

/** Bounds the login-shell spawn so a hung profile cannot hang `status`. */
const STATUS_LOGIN_SHELL_TIMEOUT_MS = 5_000;

function unknown(reason: string): ServicePathDrift {
  return { missing: [], reason, stale: [], status: 'unknown' };
}

/**
 * Reverse of `unitQuote` in service-systemd.ts, generalized to the
 * whitespace-separated assignment list systemd accepts on one
 * `Environment=` line. Returns the value of the last PATH assignment.
 */
function systemdEnvironmentPath(value: string): string | undefined {
  let found: string | undefined;
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /\s/u.test(value[index])) index += 1;
    if (index >= value.length) break;
    let token = '';
    if (value[index] === '"') {
      index += 1;
      while (index < value.length && value[index] !== '"') {
        if (value[index] === '\\' && index + 1 < value.length) index += 1;
        token += value[index];
        index += 1;
      }
      if (index >= value.length) {
        throw new Error('unterminated quote in the unit Environment= line');
      }
      index += 1;
    } else {
      while (index < value.length && !/\s/u.test(value[index])) {
        token += value[index];
        index += 1;
      }
    }
    if (token.startsWith('PATH=')) found = token.slice('PATH='.length);
  }
  return found;
}

function readSystemdUnitPath(
  registration: ServiceRegistration,
  fs: ServiceFs,
): string | undefined {
  const content = fs.readFileSync(registration.unitPath, 'utf8');
  let section: string | undefined;
  let found: string | undefined;
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    const sectionMatch = line.match(/^\[([A-Za-z][A-Za-z0-9]*)\]$/u);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    if (section !== 'Service' || !line.startsWith('Environment=')) continue;
    found = systemdEnvironmentPath(line.slice('Environment='.length)) ?? found;
  }
  return found;
}

function readLaunchdUnitPath(
  registration: ServiceRegistration,
  run: CommandRunner,
): string | undefined {
  const result = run('plutil', [
    '-convert',
    'json',
    '-o',
    '-',
    registration.unitPath,
  ]);
  if (result.error || result.status !== 0) {
    throw new Error(
      result.error?.message ??
        result.stderr?.trim() ??
        `plutil exited ${result.status}`,
    );
  }
  const parsed: unknown = JSON.parse(result.stdout ?? '');
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('plutil did not produce a top-level plist dictionary');
  }
  const environment = (parsed as Record<string, unknown>).EnvironmentVariables;
  if (
    environment === null ||
    Array.isArray(environment) ||
    typeof environment !== 'object'
  ) {
    return undefined;
  }
  const path = (environment as Record<string, unknown>).PATH;
  return typeof path === 'string' ? path : undefined;
}

/**
 * Only meaningful on the machine that owns the unit: both the unit file and
 * the login shell are read locally. Windows services do not freeze a PATH,
 * so there is nothing to compare there.
 */
export function inspectServicePathDrift(
  registration: ServiceRegistration,
  dependencies: { fs: ServiceFs; run: CommandRunner },
): ServicePathDrift | null {
  if (registration.platform === 'win32') return null;
  let unitPath: string | undefined;
  try {
    unitPath =
      registration.platform === 'linux'
        ? readSystemdUnitPath(registration, dependencies.fs)
        : readLaunchdUnitPath(registration, dependencies.run);
  } catch (error) {
    return unknown(
      `the installed unit could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (unitPath === undefined) {
    return unknown('the installed unit does not set PATH');
  }
  let current: ServicePathCandidates;
  try {
    current = collectServicePathCandidates(dependencies.run, dependencies.fs, {
      timeoutMs: STATUS_LOGIN_SHELL_TIMEOUT_MS,
    });
  } catch (error) {
    return unknown(
      `the current PATH could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Without the login shell's answer the comparison would be against this
  // process's PATH, which is not what a reinstall captures from a working
  // profile — so say nothing rather than report that as drift.
  if (!current.loginShell) {
    return unknown('your login shell did not report its PATH');
  }
  const unitDirs = unitPath.split(':').filter(Boolean);
  const unitSet = new Set(unitDirs);
  const currentSet = new Set(current.accepted);
  const missing = current.accepted.filter((dir) => !unitSet.has(dir));
  const stale = unitDirs.filter((dir) => !currentSet.has(dir));
  const sharedInUnit = unitDirs.filter((dir) => currentSet.has(dir));
  const sharedInCurrent = current.accepted.filter((dir) => unitSet.has(dir));
  const position = sharedInUnit.findIndex(
    (dir, index) => dir !== sharedInCurrent[index],
  );
  const reordered =
    position === -1
      ? undefined
      : {
          current: sharedInCurrent[position],
          position,
          unit: sharedInUnit[position],
        };
  return {
    missing,
    ...(reordered ? { reordered } : {}),
    stale,
    status:
      missing.length > 0 || stale.length > 0 || reordered
        ? 'drifted'
        : 'current',
  };
}
