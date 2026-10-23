import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lookupProcessBirthFingerprint } from '@kontourai/station-shared/process-identity';
import {
  inspectProcessFingerprint,
  killProcessTree,
  type ProcessFingerprint,
} from '../../../packages/cli/src/commands/platform.js';
import { observeListeningPidsByPort } from '../../station-dogfood-health.mjs';
import {
  assertRuntimeRecoveryCredentials,
  type RuntimeRecoveryReceipt,
  type RuntimeRecoveryRequest,
  readRuntimeRecoveryProcess,
} from './runtime-recovery-linux-bootstrap.mjs';

type FixtureProcessSnapshot = ProcessFingerprint & {
  role: 'server' | 'ui';
  ports: number[];
};

type FixtureOwnerOptions = {
  inspectProcess?: (pid: number) => ProcessFingerprint | null;
  killTree?: (pid: number) => void;
  observeFixtureCwds?: typeof observeFixtureCwds;
  processObservation?: Omit<CwdProcessObservation, 'runtimeRecoveryClosure'>;
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
  | { source: 'none'; reason: string; diagnostic?: string };

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
    ['-n', '-P', '-S', '2', '-a', '-d', 'cwd', '-Ffn'],
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

const runtimeRecoveryWitness = Symbol('verified runtime recovery closure');
type RuntimeRecoveryClosure = {
  [runtimeRecoveryWitness]: true;
  roots: readonly string[];
  uid: number;
};
type RuntimeRecoveryLaunch = {
  version: number;
  root: string;
  release: string;
  scopeNonce: string;
  workerPid: number;
  workerBirth: string;
  uid: number;
  requestPath: string;
  runtimePath: string;
  runtimeDigest: string;
  shim: string;
  boots: Map<
    string,
    { bootId: string; receiptDigest: string; fingerprints: Set<string> }
  >;
};

type CwdProcessObservation = {
  platform: NodeJS.Platform;
  birth: (pid: number) => string | null;
  readProcFile?: (path: string) => string;
  runtimeRecoveryClosure?: RuntimeRecoveryClosure;
};

function readLinuxCwdProcessStat(pid: number, read: (path: string) => string) {
  const value = read(`/proc/${pid}/stat`);
  if (!value.startsWith(`${pid} (`)) throw new Error('invalid pid');
  const fields = value
    .slice(value.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/);
  if (
    !/^[RSDZTtWXxKWPIN]$/.test(fields[0] ?? '') ||
    !/^\d{1,10}$/.test(fields[1] ?? '') ||
    !/^\d{1,20}$/.test(fields[6] ?? '') ||
    !/^\d{1,20}$/.test(fields[19] ?? '')
  )
    throw new Error('invalid stat');
  return fields;
}

function witnessedKernelWorkqueue(
  pid: number,
  originalBirth: string,
  workerBirth: string,
  read: ((path: string) => string) | undefined,
): boolean {
  if (!read || pid <= 2) return false;
  try {
    const boot = read('/proc/sys/kernel/random/boot_id').trim();
    const worker = /^linux:([^:]+):(\d+)$/.exec(workerBirth);
    if (!worker || boot !== worker[1]) return false;
    const candidate = readLinuxCwdProcessStat(pid, read);
    const candidateFlags = BigInt(candidate[6]);
    // Linux 6.17 workqueue.c creates workers through kthreadd; ordinary
    // fork/clone clears these bits. IO/user workers remain user lineage.
    if (
      candidate[1] !== '2' ||
      (candidateFlags & 0x00200020n) !== 0x00200020n ||
      (candidateFlags & 0x00004010n) !== 0n ||
      originalBirth !== `linux:${boot}:${candidate[19]}`
    )
      return false;
    const parent = readLinuxCwdProcessStat(2, read);
    if (
      parent[1] !== '0' ||
      (BigInt(parent[6]) & 0x00200000n) === 0n ||
      BigInt(parent[19]) >= BigInt(worker[2])
    )
      return false;
    const candidateAfter = readLinuxCwdProcessStat(pid, read);
    const parentAfter = readLinuxCwdProcessStat(2, read);
    return (
      [1, 6, 19].every(
        (field) =>
          candidate[field] === candidateAfter[field] &&
          parent[field] === parentAfter[field],
      ) && boot === read('/proc/sys/kernel/random/boot_id').trim()
    );
  } catch {
    return false;
  }
}

function describeDeniedLinuxProcess(
  pid: number,
  workerBirth: string | null,
  read: (path: string) => string,
): string {
  try {
    const before = readLinuxCwdProcessStat(pid, read);
    const boot = read('/proc/sys/kernel/random/boot_id').trim();
    const status = read(`/proc/${pid}/status`);
    const tgid = /^Tgid:[ \t]*(\d{1,10})$/m.exec(status)?.[1];
    const uid =
      /^Uid:[ \t]*(\d{1,10})[ \t]+(\d{1,10})[ \t]+(\d{1,10})[ \t]+(\d{1,10})$/m.exec(
        status,
      );
    const kernel = read('/proc/sys/kernel/osrelease').trim();
    if (!tgid || !uid || !/^[A-Za-z0-9._+-]{1,100}$/.test(kernel))
      return 'proc=malformed';
    const after = readLinuxCwdProcessStat(pid, read);
    const stable =
      before[19] === after[19] &&
      boot === read('/proc/sys/kernel/random/boot_id').trim();
    const worker = /^linux:([^:]+):(\d+)$/.exec(workerBirth ?? '');
    const age = !worker
      ? 'unknown'
      : boot !== worker[1]
        ? 'different-boot'
        : BigInt(before[19]) < BigInt(worker[2])
          ? 'older'
          : before[19] === worker[2]
            ? 'same-tick'
            : 'newer';
    return `proc-state=${before[0]};proc-ppid=${before[1]};proc-tgid=${tgid};proc-flags=${before[6]};proc-uid=${uid.slice(1).join(':')};proc-birth=${age};proc-origin=unbound;proc-birth-samples-stable=${stable};kernel=${kernel}`;
  } catch {
    return 'proc=unavailable';
  }
}

function witnessedOtherRuntimeRecoveryUid(
  pid: number,
  originalBirth: string,
  observation: CwdProcessObservation,
): boolean {
  const closure = observation.runtimeRecoveryClosure;
  if (!closure?.[runtimeRecoveryWitness] || !observation.readProcFile)
    return false;
  try {
    const candidate = readRuntimeRecoveryProcess(pid, observation.readProcFile);
    return (
      candidate.birth === originalBirth &&
      candidate.uids.every((uid: number) => uid !== closure.uid)
    );
  } catch {
    return false;
  }
}

function fixtureBirthRejection(
  pid: number,
  workerBirth: string | null,
  observation: CwdProcessObservation,
): string | null {
  if (observation.platform !== 'linux') return 'birth-platform';
  const before = observation.birth(pid);
  const worker = /^linux:([^:]+):(\d+)$/.exec(workerBirth ?? '');
  const candidate = /^linux:([^:]+):(\d+)$/.exec(before ?? '');
  if (!worker) return 'birth-worker-invalid';
  if (!candidate) return 'birth-candidate-invalid';
  if (candidate[1] !== worker[1]) return 'birth-boot-mismatch';
  if (BigInt(candidate[2]) >= BigInt(worker[2]))
    return witnessedKernelWorkqueue(
      pid,
      candidate[0],
      worker[0],
      observation.readProcFile,
    ) || witnessedOtherRuntimeRecoveryUid(pid, candidate[0], observation)
      ? null
      : 'birth-not-earlier';
  return observation.birth(pid) === before ? null : 'birth-changed';
}

export function observeFixtureCwds(
  roots: readonly string[],
  runLsof: () => LsofResult = runFixtureCwdLsof,
  processObservation?: CwdProcessObservation,
): CwdObservation {
  const canonicalRoots = roots.map(canonicalExistingPath);
  const closure = processObservation?.runtimeRecoveryClosure;
  if (
    processObservation &&
    closure &&
    (closure.roots.length !== canonicalRoots.length ||
      !canonicalRoots.every((root) => closure.roots.includes(root)))
  )
    processObservation = {
      ...processObservation,
      runtimeRecoveryClosure: undefined,
    };
  const workerBirth =
    processObservation?.platform === 'linux'
      ? processObservation.birth(process.pid)
      : null;
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
  const malformed = (kind: string): CwdObservation => ({
    source: 'none',
    reason: 'lsof-malformed-output',
    ...(processObservation
      ? {
          diagnostic: `class=${kind};pid=${pid ?? 'none'}${kind === 'birth-not-earlier' && pid !== undefined && processObservation.platform === 'linux' && processObservation.readProcFile ? `;${describeDeniedLinuxProcess(pid, workerBirth, processObservation.readProcFile)}` : ''}`,
        }
      : {}),
  });
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
      const field =
        line === 'fNOFD'
          ? 'no-fd'
          : line === 'fcwd'
            ? 'cwd'
            : line.startsWith('p')
              ? 'pid'
              : line.startsWith('n')
                ? 'name'
                : 'other';
      return malformed(`unexpected-${state}-${field}`);
    }
    const reportedCwd = line.slice(1).replace(/ \(deleted\)$/, '');
    if (/ \(readlink: [^\n]*\)$/.test(reportedCwd)) {
      // Fixture descendants cannot predate the worker that launched them.
      // Unavailable or reused identities remain unknown; contemporaneous
      // identities need an independently witnessed kernel-workqueue lineage.
      const rejection = !processObservation
        ? 'scope-absent'
        : reportedCwd !== `/proc/${pid}/cwd (readlink: Permission denied)`
          ? 'readlink-name'
          : fixtureBirthRejection(pid, workerBirth, processObservation);
      if (rejection !== null) return malformed(rejection);
      pid = undefined;
      state = 'pid';
      continue;
    }
    if (!isAbsolute(reportedCwd)) return malformed('non-absolute');
    const cwd = canonicalExistingPath(reportedCwd);
    for (const root of canonicalRoots) {
      if (isWithinRoot(cwd, root)) owners.get(root)?.add(pid);
    }
    sawCwd = true;
    pid = undefined;
    state = 'pid';
  }
  if (!sawCwd || state !== 'pid')
    return malformed(state !== 'pid' ? `incomplete-${state}` : 'no-cwd');
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
  readonly #processObservation: Omit<
    CwdProcessObservation,
    'runtimeRecoveryClosure'
  >;
  readonly #runtimeRecoveryLaunches = new Map<string, RuntimeRecoveryLaunch>();

  constructor(options: FixtureOwnerOptions = {}) {
    this.#inspectProcess = options.inspectProcess ?? inspectProcessFingerprint;
    this.#killTree = options.killTree ?? killProcessTree;
    this.#processObservation = options.processObservation ?? {
      platform: process.platform,
      birth: lookupProcessBirthFingerprint,
      readProcFile: (path) => readFileSync(path, 'utf8'),
    };
    this.#observeFixtureCwds = (roots) =>
      (options.observeFixtureCwds ?? observeFixtureCwds)(
        roots,
        runFixtureCwdLsof,
        {
          ...this.#processObservation,
          runtimeRecoveryClosure: this.#runtimeRecoveryClosure(roots),
        },
      );
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

  /** Only the copied runtime-recovery fixture's plain CLI path qualifies. */
  writeRuntimeRecoveryStationShim(
    releasePath: string,
    instance: string,
  ): RuntimeRecoveryRequest | undefined {
    const release = realpathSync(releasePath);
    const root = [...this.#fixtureRoots].find((candidate) =>
      isWithinRoot(release, candidate),
    );
    if (!root || root === release)
      throw new Error(
        'Runtime recovery release is outside a registered fixture root',
      );
    const workspace = fileURLToPath(new URL('../../../', import.meta.url));
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    let command = `${quote(process.execPath)} ${quote(join(workspace, 'node_modules/tsx/dist/cli.mjs'))} ${quote(join(workspace, 'scripts/station-cli.ts'))}`;
    let request: RuntimeRecoveryRequest | undefined;
    if (this.#processObservation.platform === 'linux') {
      const read = this.#processObservation.readProcFile;
      if (!read)
        throw new Error('Runtime recovery lacks Linux credential observation');
      const worker = readRuntimeRecoveryProcess(process.pid, read);
      const uid = worker.uids[0];
      assertRuntimeRecoveryCredentials(worker, uid, false);
      if (this.#processObservation.birth(process.pid) !== worker.birth)
        throw new Error('Runtime recovery worker birth changed');
      const scopeNonce = randomUUID();
      const requestPath = join(release, `.station-fixture-${scopeNonce}.json`);
      if (!/^[a-zA-Z0-9_-]+$/.test(instance))
        throw new Error('Invalid runtime recovery instance');
      const runtimePath = join(
        release,
        `dist-server-${instance}`,
        'command-station.js',
      );
      const runtime = readFileSync(runtimePath);
      if (
        !runtime.equals(
          readFileSync(
            join(
              workspace,
              'scripts/__tests__/fixtures/dogfood-runtime-fixture.mjs',
            ),
          ),
        )
      )
        throw new Error(
          'Runtime recovery closure requires the copied listener-only fixture',
        );
      const runtimeDigest = createHash('sha256').update(runtime).digest('hex');
      request = {
        version: 1,
        root,
        release,
        scopeNonce,
        workerPid: process.pid,
        workerBirth: worker.birth,
        uid,
        runtimePath,
        runtimeDigest,
      };
      writeFileSync(requestPath, JSON.stringify(request), {
        flag: 'wx',
        mode: 0o600,
      });
      writeFileSync(`${requestPath}l`, '', { flag: 'wx', mode: 0o600 });
      this.#runtimeRecoveryLaunches.set(release, {
        ...request,
        requestPath,
        shim: '',
        boots: new Map(),
      });
      command = `/usr/bin/setpriv --no-new-privs ${quote(process.execPath)} ${quote(fileURLToPath(new URL('./runtime-recovery-linux-bootstrap.mjs', import.meta.url)))} ${quote(requestPath)}`;
    }
    const shim = join(release, 'station');
    const contents = `#!/bin/sh\nexec ${command} "$@"\n`;
    writeFileSync(shim, contents, { mode: 0o755 });
    const launch = this.#runtimeRecoveryLaunches.get(release);
    if (launch) launch.shim = contents;
    chmodSync(shim, 0o755);
    return request ? { ...request } : undefined;
  }

  #runtimeRecoveryReceipts(launch: RuntimeRecoveryLaunch) {
    const entries = readFileSync(`${launch.requestPath}l`, 'utf8').trim();
    if (!entries) throw new Error('Runtime recovery has no launch receipt');
    const nonces = new Set<string>();
    return entries.split('\n').map((line) => {
      const receipt: RuntimeRecoveryReceipt = JSON.parse(line);
      if (
        receipt.version !== 1 ||
        receipt.root !== launch.root ||
        receipt.release !== launch.release ||
        receipt.runtimePath !== launch.runtimePath ||
        receipt.runtimeDigest !== launch.runtimeDigest ||
        receipt.scopeNonce !== launch.scopeNonce ||
        receipt.workerPid !== launch.workerPid ||
        receipt.workerBirth !== launch.workerBirth ||
        receipt.uid !== launch.uid ||
        !/^[a-f0-9-]{36}$/.test(receipt.launchNonce) ||
        nonces.has(receipt.launchNonce) ||
        !Number.isSafeInteger(receipt.actor?.pid) ||
        receipt.actor.pid <= 0 ||
        !/^linux:[^:]+:\d+$/.test(receipt.actor?.birth)
      )
        throw new Error('Runtime recovery receipt binding changed');
      nonces.add(receipt.launchNonce);
      assertRuntimeRecoveryCredentials(receipt.actor, launch.uid, true);
      const worker = /^linux:([^:]+):(\d+)$/.exec(launch.workerBirth);
      const actor = /^linux:([^:]+):(\d+)$/.exec(receipt.actor.birth);
      if (
        !worker ||
        !actor ||
        worker[1] !== actor[1] ||
        BigInt(actor[2]) < BigInt(worker[2])
      )
        throw new Error('Runtime recovery actor birth changed');
      return receipt;
    });
  }

  #captureRuntimeRecoveryBoot(
    statePath: string,
    bootId: unknown,
    snapshots: FixtureProcessSnapshot[],
  ): boolean {
    const launch = [...this.#runtimeRecoveryLaunches.values()].find(
      (candidate) => isWithinRoot(resolve(statePath), candidate.release),
    );
    if (!launch) return true;
    if (typeof bootId !== 'string' || !bootId) return false;
    try {
      const receipt = this.#runtimeRecoveryReceipts(launch)
        .filter((entry) => entry.command === 'start')
        .at(-1);
      const read = this.#processObservation.readProcFile;
      if (!receipt || !read || snapshots.length !== 2) return false;
      for (const snapshot of snapshots) {
        const child = readRuntimeRecoveryProcess(snapshot.pid, read);
        assertRuntimeRecoveryCredentials(child, launch.uid, true);
        const childBirth = /^linux:([^:]+):(\d+)$/.exec(child.birth);
        const actorBirth = /^linux:([^:]+):(\d+)$/.exec(receipt.actor.birth);
        if (
          child.birth !== snapshot.startToken ||
          !childBirth ||
          !actorBirth ||
          childBirth[1] !== actorBirth[1] ||
          BigInt(childBirth[2]) < BigInt(actorBirth[2])
        )
          return false;
      }
      launch.boots.set(receipt.launchNonce, {
        bootId,
        receiptDigest: createHash('sha256')
          .update(JSON.stringify(receipt))
          .digest('hex'),
        fingerprints: new Set(snapshots.map(fingerprintKey)),
      });
      return true;
    } catch {
      return false;
    }
  }

  #runtimeRecoveryClosure(
    roots: readonly string[],
  ): RuntimeRecoveryClosure | undefined {
    if (this.#processObservation.platform !== 'linux') return undefined;
    try {
      const launches = [...this.#runtimeRecoveryLaunches.values()];
      if (
        !roots.every((root) => launches.some((launch) => launch.root === root))
      )
        return undefined;
      const uid = launches[0]?.uid;
      if (!uid || !launches.every((launch) => launch.uid === uid))
        return undefined;
      const captured = new Set(
        [...this.#snapshotsByState.values()].flatMap((owned) => [
          ...owned.keys(),
        ]),
      );
      for (const launch of launches) {
        if (
          readFileSync(join(launch.release, 'station'), 'utf8') !==
            launch.shim ||
          createHash('sha256')
            .update(readFileSync(launch.runtimePath))
            .digest('hex') !== launch.runtimeDigest
        )
          return undefined;
        const receipts = this.#runtimeRecoveryReceipts(launch);
        const starts = receipts.filter((entry) => entry.command === 'start');
        if (
          !starts.length ||
          !starts.every((receipt) => {
            const boot = launch.boots.get(receipt.launchNonce);
            return (
              boot &&
              boot.receiptDigest ===
                createHash('sha256')
                  .update(JSON.stringify(receipt))
                  .digest('hex') &&
              [...boot.fingerprints].every((key) => captured.has(key))
            );
          })
        )
          return undefined;
      }
      return { [runtimeRecoveryWitness]: true, roots: [...roots], uid };
    } catch {
      return undefined;
    }
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
    if (!this.#captureRuntimeRecoveryBoot(statePath, state.bootId, snapshots))
      throw new Error(
        'Published runtime recovery boot lacks bound privilege closure evidence',
      );
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
        diagnostics.push(
          `cwd:source=none;reason=${observed.reason}${observed.diagnostic ? `;${observed.diagnostic}` : ''}`,
        );
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
    this.#runtimeRecoveryLaunches.clear();
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
