import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  inspectProcessFingerprint,
  killProcessTree,
  type ProcessFingerprint,
} from '../../../packages/cli/src/commands/platform.js';
import { observeListeningPidsByPort } from '../../station-dogfood-health.mjs';

type FixtureProcessSnapshot = ProcessFingerprint & {
  role: 'server' | 'ui';
  ports: number[];
};

type FixtureOwnerOptions = {
  inspectProcess?: (pid: number) => ProcessFingerprint | null;
  killTree?: (pid: number) => void;
  observeFixtureCwds?: typeof observeFixtureCwds;
};

type LsofResult = {
  error?: NodeJS.ErrnoException;
  signal: NodeJS.Signals | null;
  status: number | null;
  stderr?: string;
  stdout: string;
};

type SpawnLsof = (
  command: string,
  args: readonly string[],
  options: {
    encoding: 'utf8';
    stdio: ['ignore', 'pipe', 'pipe'];
    timeout: number;
    windowsHide: true;
  },
) => LsofResult;

type CwdObservation =
  | { source: 'lsof'; owners: Map<string, Set<number>> }
  | { source: 'none'; reason: string };

function snapshot(
  role: FixtureProcessSnapshot['role'],
  pid: unknown,
  fingerprint: unknown,
  ports: number[],
): FixtureProcessSnapshot | undefined {
  if (
    !Number.isInteger(pid) ||
    typeof fingerprint !== 'object' ||
    fingerprint === null
  ) {
    return undefined;
  }
  const candidate = fingerprint as Partial<ProcessFingerprint>;
  if (
    candidate.pid !== pid ||
    typeof candidate.startToken !== 'string' ||
    typeof candidate.commandDigest !== 'string'
  ) {
    return undefined;
  }
  return { ...(candidate as ProcessFingerprint), role, ports };
}

function sameProcess(
  actual: ProcessFingerprint | null,
  expected: ProcessFingerprint,
): boolean {
  return (
    actual?.pid === expected.pid &&
    actual.startToken === expected.startToken &&
    actual.commandDigest === expected.commandDigest
  );
}

function statePorts(
  state: Record<string, unknown>,
  role: 'server' | 'ui',
): number[] {
  const serverPort = state.serverPort;
  const uiPort = state.uiPort;
  if (
    role === 'server' &&
    typeof serverPort === 'number' &&
    Number.isInteger(serverPort)
  )
    return [serverPort, serverPort + 1, serverPort + 2, serverPort + 3];
  if (role === 'ui' && typeof uiPort === 'number' && Number.isInteger(uiPort))
    return [uiPort];
  return [];
}

function fingerprintKey(process: FixtureProcessSnapshot): string {
  return `${process.role}:${process.pid}:${process.startToken}:${process.commandDigest}`;
}

export function runFixtureCwdLsof(
  spawnLsof: SpawnLsof = spawnSync as SpawnLsof,
): LsofResult {
  // Read only process cwd descriptors. `+D <root>` recursively walks every
  // fixture file before reporting owners and can exceed the cleanup deadline
  // even when no process remains; one bounded process-table scan covers every
  // registered fixture root without weakening the zero-residue assertion.
  // Let lsof's own minimum kernel-operation timeout bound stat/readlink work.
  // Unlike `-b`, this retains authoritative path resolution on macOS. Any
  // warning (including lsof continuing with incomplete mount information) is
  // captured below and makes the observation fail closed. The outer timeout
  // bounds the tool and its internal timeout machinery as a final backstop.
  const result = spawnLsof(
    'lsof',
    ['-n', '-P', '-S', '2', '-a', '-d', 'cwd', '-Fn'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 3_000,
      windowsHide: true,
    },
  );
  return {
    error: result.error,
    signal: result.signal,
    status: result.status,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  };
}

function canonicalExistingPath(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

function isWithinRoot(path: string, root: string): boolean {
  const child = relative(root, path);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

export function observeFixtureCwds(
  roots: readonly string[],
  runLsof: () => LsofResult = runFixtureCwdLsof,
): CwdObservation {
  const canonicalRoots = roots.map(canonicalExistingPath);
  const result = runLsof();
  if (result.error || result.signal || result.status !== 0) {
    const code =
      result.error?.code ??
      (result.signal ? `signal-${result.signal}` : `exit-${result.status}`);
    return {
      source: 'none',
      reason: `lsof-${code};partial=${result.stdout.length > 0}`,
    };
  }
  if ((result.stderr ?? '').trim().length > 0) {
    return {
      source: 'none',
      reason: `lsof-warning;partial=${result.stdout.length > 0}`,
    };
  }

  const owners = new Map<string, Set<number>>(
    canonicalRoots.map((root) => [root, new Set()]),
  );
  let pid: number | undefined;
  let state: 'pid' | 'file' | 'name' = 'pid';
  let sawCwd = false;
  for (const line of result.stdout.split('\n')) {
    if (line === '') continue;
    if (state === 'pid' && /^p[1-9]\d*$/.test(line)) {
      pid = Number.parseInt(line.slice(1), 10);
      state = 'file';
      continue;
    }
    if (state === 'file' && line === 'fcwd') {
      state = 'name';
      continue;
    }
    if (state !== 'name' || !line.startsWith('n') || pid === undefined) {
      return { source: 'none', reason: 'lsof-malformed-output' };
    }
    const reportedCwd = line.slice(1).replace(/ \(deleted\)$/, '');
    if (!isAbsolute(reportedCwd)) {
      return { source: 'none', reason: 'lsof-malformed-output' };
    }
    const cwd = canonicalExistingPath(reportedCwd);
    for (const root of canonicalRoots) {
      if (isWithinRoot(cwd, root)) owners.get(root)?.add(pid);
    }
    sawCwd = true;
    pid = undefined;
    state = 'pid';
  }
  if (!sawCwd || state !== 'pid') {
    return { source: 'none', reason: 'lsof-malformed-output' };
  }
  return { source: 'lsof', owners };
}

/**
 * Owns only identities captured immediately after a successful fixture boot.
 * Registration supplies teardown scope, never authority: mutable state files
 * are deliberately ignored after registration so a corrupt replacement cannot
 * cause a cleanup path to signal an unrelated process.
 */
export class StationFixtureOwner {
  readonly #statePaths = new Set<string>();
  readonly #fixtureRoots = new Set<string>();
  readonly #snapshotsByState = new Map<
    string,
    Map<string, FixtureProcessSnapshot>
  >();
  readonly #inspectProcess: (pid: number) => ProcessFingerprint | null;
  readonly #killTree: (pid: number) => void;
  readonly #observeFixtureCwds: typeof observeFixtureCwds;

  constructor(options: FixtureOwnerOptions = {}) {
    this.#inspectProcess = options.inspectProcess ?? inspectProcessFingerprint;
    this.#killTree = options.killTree ?? killProcessTree;
    this.#observeFixtureCwds = options.observeFixtureCwds ?? observeFixtureCwds;
  }

  registerStatePath(statePath: string): void {
    this.#statePaths.add(statePath);
  }

  registerFixtureRoot(root: string): void {
    // Retain the real identity while the root still exists. On macOS, a root
    // registered lexically below /var may be reported by the kernel/lsof below
    // /private/var after the directory itself has been deleted.
    this.#fixtureRoots.add(canonicalExistingPath(resolve(root)));
  }

  /** Call only after a successful `./station start` publication. */
  capturePublishedBoot(statePath: string): void {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<
      string,
      unknown
    >;
    const snapshots = [
      snapshot(
        'server',
        state.serverPid,
        state.serverFingerprint,
        statePorts(state, 'server'),
      ),
      snapshot('ui', state.uiPid, state.uiFingerprint, statePorts(state, 'ui')),
    ].filter(
      (process): process is FixtureProcessSnapshot => process !== undefined,
    );
    if (snapshots.length === 0) {
      throw new Error(
        `Published fixture state lacks process identities: ${statePath}`,
      );
    }
    const owned = this.#snapshotsByState.get(statePath) ?? new Map();
    for (const process of snapshots) {
      if (!sameProcess(this.#inspectProcess(process.pid), process)) {
        throw new Error(
          `Published fixture identity did not match a live process: ${process.role}:${process.pid}`,
        );
      }
      owned.set(fingerprintKey(process), process);
    }
    this.#snapshotsByState.set(statePath, owned);
  }

  dispose(): void {
    const snapshots = [...this.#snapshotsByState.values()].flatMap((owned) => [
      ...owned.values(),
    ]);
    const diagnostics: string[] = [];
    for (const process of snapshots) {
      const actual = this.#inspectProcess(process.pid);
      if (actual === null) continue;
      if (!sameProcess(actual, process)) {
        diagnostics.push(`${process.role}:${process.pid}:identity-changed`);
        continue;
      }
      this.#killTree(process.pid);
      if (sameProcess(this.#inspectProcess(process.pid), process)) {
        diagnostics.push(`${process.role}:${process.pid}:still-running`);
      }
    }
    const ports = [...new Set(snapshots.flatMap((process) => process.ports))];
    if (ports.length > 0) {
      const observed = observeListeningPidsByPort(ports, Date.now() + 1_000);
      if (observed.source === 'none') {
        diagnostics.push(`listeners:source=none;reason=${observed.reason}`);
      } else {
        for (const port of ports) {
          const owners = observed.owners.get(port) ?? new Set();
          if (owners.size > 0)
            diagnostics.push(`listener:${port}:pids=${[...owners].join(',')}`);
        }
      }
    }
    if (process.platform !== 'win32' && this.#fixtureRoots.size > 0) {
      const observed = this.#observeFixtureCwds([...this.#fixtureRoots]);
      if (observed.source === 'none') {
        diagnostics.push(`cwd:source=none;reason=${observed.reason}`);
      } else {
        for (const [root, pids] of observed.owners) {
          if (pids.size > 0)
            diagnostics.push(`cwd:${root}:pids=${[...pids].join(',')}`);
        }
      }
    }
    this.#statePaths.clear();
    this.#fixtureRoots.clear();
    this.#snapshotsByState.clear();
    if (diagnostics.length > 0) {
      throw new Error(
        `Fixture-owned Station cleanup failed: ${diagnostics.join(', ').slice(0, 1_500)}`,
      );
    }
  }

  installAbnormalExitReaper(): void {
    const reap = () => {
      try {
        this.dispose();
      } catch (error) {
        // Signal/exit handlers are best effort only; normal afterEach cleanup
        // still throws diagnostics to fail the test that owns the residue.
        console.error('Fixture cleanup during abnormal exit failed:', error);
      }
    };
    process.once('exit', reap);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const onSignal = () => {
        reap();
        process.removeListener(signal, onSignal);
        process.kill(process.pid, signal);
      };
      process.once(signal, onSignal);
    }
  }
}
