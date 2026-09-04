import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import { lookupProcessBirthFingerprint } from '../../packages/shared/src/process-identity.mjs';
import {
  latestE2EEvidenceBinding,
  projectLatestE2EEvidence,
  validateLatestE2EEvidence,
} from '../lib/e2e-latest-evidence.mjs';
import { resolveVerificationToolchain } from '../lib/test-reliability.mjs';
import {
  releaseVerificationArtifactMutation,
  tryAcquireVerificationArtifactMutation,
  verificationArtifactMutationIsHeld,
} from '../lib/verification-artifact-mutation.mjs';
import {
  __verificationCoordinatorInternals,
  coordinateVerification,
  defaultCoordinatorRoot,
  executionEquivalenceKey,
  FULL_WEIGHT_CI_FAST_BYPASS_MS,
  leaseIsLive,
  MAX_COMPLETION_WAITERS,
  verificationStatus,
} from '../lib/verification-coordinator.mjs';
import { createOwnedRunner } from '../lib/verification-execution-lifecycle.mjs';
import { buildHostPressureSample } from '../lib/verification-host-pressure.mjs';
import { createVerificationRequest } from '../lib/verification-receipt.mjs';
import { prepareCoordinatorContext } from '../lib/verification-request-context.mjs';
import { STATION_VERIFICATION_HISTORY_REF } from '../lib/verification-request-environment.mjs';
import { outputDirectory } from '../lib/verification-request-identity.mjs';
import {
  createWslQuarantinedTest,
  WSL_QUARANTINE_REASON,
} from '../lib/wsl-host-class.mjs';
import { FIXTURE_TOOLCHAIN_IDENTITY } from './fixtures/verification-toolchain.mjs';

const ORDINARY_FULL_PHASE_IDS = Object.freeze([
  'test-full-ordinary-1-of-8',
  'test-full-ordinary-2-of-8',
  'test-full-ordinary-3-of-8',
  'test-full-ordinary-4-of-8',
  'test-full-ordinary-5-of-8',
  'test-full-ordinary-6-of-8',
  'test-full-ordinary-7-of-8',
  'test-full-ordinary-8-of-8',
]);

/**
 * station#4177 INTERIM quarantine — WSL2 fleet-runner host class ONLY.
 *
 * Every name below is proven never-green on the fleet runner's host class
 * (`desktop-win` WSL2): a pristine-main baseline run ON that host failed
 * exactly these eleven plus the #4173 counting case (fixed by merged #4176
 * and deliberately NOT quarantined). Evidence: station#4177. On a WSL host
 * each case skips, named, carrying the #4177 reason in reporter output;
 * on every other host all eleven RUN unchanged.
 *
 * This is interim debt, not a fix: station#4177's open scope is making these
 * tests WSL-compatible — removing names from this list is the goal state.
 * Growing it is deliberately loud: an unlisted name handed to
 * `wslQuarantinedTest` throws at collection, and the exact-list pin in
 * `wsl-host-class.test.ts` reds until both sides are edited on purpose.
 */
const WSL_QUARANTINED_TEST_NAMES = Object.freeze([
  'does not extend a phase execution deadline on fresh heartbeats',
  'waits for an early-return orphan process group before releasing capacity',
  'reports a bounded healthy-idle queue diagnostic with exact blockers',
  'request cleanup residue is undiscovered and releases capacity to its successor',
  'bounds a held foreign mutation claim without touching the canonical directory',
  'reclaims a stale owner by terminating its exact detached child group',
  'a held output lock fences canceled pressure publication until release',
  'stale fairness for another blocker does not let a later lane jump FIFO',
  'a healthy FIFO waiter reports its request deadline as timed out',
  'FIFO blocks a later healthy heavy lane while an earlier queued heavy lane waits',
  'status usedWeight counts every capacity-consuming admission state and projects hostPressure',
]);

const wslQuarantinedTest = createWslQuarantinedTest({
  test,
  quarantinedNames: WSL_QUARANTINED_TEST_NAMES,
  reason: WSL_QUARANTINE_REASON,
});

const TEST_TOOLCHAIN = resolveVerificationToolchain();
const FIXTURE_TOOLCHAIN = Object.freeze({
  toolchain: 'npm@fixture',
  identity: FIXTURE_TOOLCHAIN_IDENTITY,
});

/** A deterministic healthy sampler so heavy (gated) lanes admit instantly in
 *  tests that are not exercising host-pressure behavior themselves. */
function healthySampler(busyPercent = 40, now = Date.now) {
  return async () =>
    buildHostPressureSample({
      busyPercent,
      cpuCount: 4,
      sampleMs: 500,
      sampledAt: now(),
      threshold: 85,
      source: 'override',
      load1: busyPercent / 10,
      loadPerCpu: busyPercent / 40,
    });
}

function provenance(workspaceDigest: string, toolchain = FIXTURE_TOOLCHAIN) {
  return {
    repositoryId: 'a'.repeat(64),
    worktree: process.cwd(),
    headSha: 'b'.repeat(40),
    workspaceDigest: createHash('sha256').update(workspaceDigest).digest('hex'),
    environmentDigest: 'e'.repeat(64),
    dependencyDigest: 'c'.repeat(64),
    nodeVersion: process.version,
    toolchain: toolchain.toolchain,
    toolchainIdentity: toolchain.identity,
    platform: process.platform,
    arch: process.arch,
  };
}

function worktreeProvenance(
  worktree: string,
  workspaceDigest: string,
  toolchain = FIXTURE_TOOLCHAIN,
) {
  return { ...provenance(workspaceDigest, toolchain), worktree };
}

// The coordinator binds execution provenance to a live, executable Node/npm
// pair before it derives a request. Tests that pre-compute a coordinator key
// must therefore use that same bound identity; the receipt-only fixture above
// deliberately has no executable paths and is for pure receipt tests only.
function boundCoordinatorProvenance(worktree: string, workspaceDigest: string) {
  return worktreeProvenance(worktree, workspaceDigest, TEST_TOOLCHAIN);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-coordinator-'));
  return {
    root,
    remove: () =>
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      }),
  };
}

test('vitest coordinator state is isolated from a concurrent live host lane', async () => {
  const temp = fixture();
  const liveRoot = join(temp.root, 'live-host');
  const isolatedRunRoot = join(temp.root, 'vitest-run');
  const isolatedRoot = defaultCoordinatorRoot({
    env: { STATION_VITEST_RUN_ROOT: isolatedRunRoot },
  });
  const liveWorktree = join(temp.root, 'live-worktree');
  const isolatedWorktree = join(temp.root, 'isolated-worktree');
  mkdirSync(liveWorktree);
  mkdirSync(isolatedWorktree);
  let releaseLive!: () => void;
  const liveBlocked = new Promise<void>((resolve) => {
    releaseLive = resolve;
  });
  try {
    const live = coordinateVerification({
      laneId: 'test-changed',
      root: liveRoot,
      cwd: liveWorktree,
      collectProvenance: () =>
        worktreeProvenance(liveWorktree, 'concurrent-live-host'),
      runner: async () => {
        await liveBlocked;
        return { status: 0 };
      },
    });
    await waitFor(() => verificationStatus({ root: liveRoot }).usedWeight > 0);

    expect(verificationStatus({ root: isolatedRoot })).toMatchObject({
      usedWeight: 0,
      jobs: [],
    });
    const isolated = await coordinateVerification({
      laneId: 'ci-fast',
      root: isolatedRoot,
      cwd: isolatedWorktree,
      collectProvenance: () =>
        worktreeProvenance(isolatedWorktree, 'isolated-test-run'),
      runner: async () => ({ status: 0 }),
    });
    expect(isolated.disposition).toBe('executed');
    expect(verificationStatus({ root: liveRoot }).usedWeight).toBe(20);
    expect(verificationStatus({ root: liveRoot }).jobs).toHaveLength(1);

    releaseLive();
    await expect(live).resolves.toMatchObject({
      receipt: { terminal: { passed: true } },
    });
  } finally {
    releaseLive?.();
    temp.remove();
  }
});

test('production coordinator root remains host-global without a vitest run root', () => {
  const root = defaultCoordinatorRoot({ env: { XDG_CACHE_HOME: '/cache' } });
  expect(root).toBe(
    join('/cache', 'kontourai-station', 'verification-coordinator', 'v1'),
  );
});

function canonicalRequestKey(seed: string) {
  return createHash('sha256').update(seed).digest('hex');
}

function nativeProcessStart(pid: number | undefined): string | null {
  if (!pid || process.platform === 'win32') return null;
  // CALL the production authority rather than re-deriving it (#1074).
  //
  // Fixture leases are compared to the real probe by STRING EQUALITY, and
  // that probe is platform-shaped: macOS/BSD read `ps -o lstart=`, but Linux
  // reads /proc/<pid>/stat field 22 plus boot_id and returns
  // `linux:<boot_id>:<starttime>`. A hand-rolled `ps` reading here therefore
  // matched on macOS and could never match on Linux, so every fixture lease
  // read as pid-reused-and-dead: capacity went to 0, blockers vanished, held
  // claims read as released, and stale-owner reclamation never fired. That is
  // the whole of #1074's nine failures.
  //
  // #3048 hit the same defect class from the timezone direction and fixed it
  // by pinning LC_ALL/TZ *on the copy*. The Linux /proc branch defeats that
  // pin. A copy of a probe is not the probe — so there is no copy here.
  return lookupProcessBirthFingerprint(pid);
}

function alternateToolchain(
  root: string,
  version = TEST_TOOLCHAIN.toolchain.slice('npm@'.length),
) {
  const npmEntrypoint = join(root, 'alternate-npm-cli.mjs');
  writeFileSync(
    npmEntrypoint,
    `if (process.argv[2] === '--version') process.stdout.write(${JSON.stringify(`${version}\n`)}); else throw new Error('alternate npm fixture must not execute lifecycle commands');`,
  );
  return resolveVerificationToolchain({ npmEntrypoint });
}

function writeAmbientNodeShim(directory: string) {
  if (process.platform === 'win32') {
    const command = join(directory, 'node.cmd');
    writeFileSync(
      command,
      '@echo off\r\n> "%STATION_FIXTURE_AMBIENT_NODE_MARKER%" echo ambient-node-used\r\n"%STATION_FIXTURE_BOUND_NODE%" %*\r\n',
    );
    return;
  }
  const command = join(directory, 'node');
  writeFileSync(
    command,
    '#!/bin/sh\nprintf ambient-node-used > "$STATION_FIXTURE_AMBIENT_NODE_MARKER"\nexec "$STATION_FIXTURE_BOUND_NODE" "$@"\n',
  );
  chmodSync(command, 0o755);
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error('timed out waiting for fixture');
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

function processGroupIsLive(pgid: number | null | undefined): boolean {
  if (process.platform === 'win32' || !pgid) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function processIsLive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function coordinatorChild(root: string, worktree: string, id: string) {
  const moduleUrl = pathToFileURL(
    join(process.cwd(), 'scripts/lib/verification-coordinator.mjs'),
  ).href;
  return spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { createHash } from 'node:crypto'; import { coordinateVerification } from ${JSON.stringify(moduleUrl)}; const [root, worktree, id] = process.argv.slice(1); const hash = (value) => createHash('sha256').update(value).digest('hex'); const provenance = { repositoryId: hash('repository-' + id), worktree, headSha: 'b'.repeat(40), workspaceDigest: hash('workspace-' + id), environmentDigest: 'e'.repeat(64), dependencyDigest: 'c'.repeat(64), nodeVersion: process.version, toolchain: 'npm@fixture', toolchainIdentity: ${JSON.stringify(FIXTURE_TOOLCHAIN_IDENTITY)}, platform: process.platform, arch: process.arch }; const result = await coordinateVerification({ laneId: 'prepush', root, capacity: 40, heartbeatMs: 5, timeoutMs: 5000, cwd: worktree, collectProvenance: () => provenance, runner: async () => { await new Promise((resolve) => setTimeout(resolve, 150)); return { status: 0 }; } }); console.log(JSON.stringify({ disposition: result.disposition, passed: result.receipt.terminal.passed }));`,
      root,
      worktree,
      id,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function completionCoordinatorChild({
  root,
  worktree,
  id,
  laneId,
  binDirectory,
  mode,
  countPath,
  releasePath,
  descendantPath,
}: {
  root: string;
  worktree: string;
  id: string;
  laneId: 'ci-fast' | 'full-regression';
  binDirectory: string;
  mode: 'fast' | 'hold-repo-governance' | 'hold-test-full-ordinary';
  countPath: string;
  releasePath: string;
  descendantPath: string;
}) {
  const coordinatorUrl = pathToFileURL(
    join(process.cwd(), 'scripts/lib/verification-coordinator.mjs'),
  ).href;
  const pressureUrl = pathToFileURL(
    join(process.cwd(), 'scripts/lib/verification-host-pressure.mjs'),
  ).href;
  return spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { createHash } from 'node:crypto'; import { lstatSync, readFileSync, realpathSync } from 'node:fs'; import { coordinateVerification } from ${JSON.stringify(coordinatorUrl)}; import { buildHostPressureSample } from ${JSON.stringify(pressureUrl)}; const [root, worktree, id, laneId] = process.argv.slice(1); const hash = (value) => createHash('sha256').update(value).digest('hex'); const fileIdentity = (path, content = false) => { const resolved = realpathSync(path); const stat = lstatSync(resolved); const identity = { path: resolved, device: stat.dev, inode: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs }; if (content) identity.sha256 = hash(readFileSync(resolved)); return identity; }; const nodeExecutable = realpathSync(process.execPath); const npmExecutable = realpathSync(process.env.STATION_FIXTURE_NPM); const identity = { node: fileIdentity(nodeExecutable), npm: fileIdentity(npmExecutable, true) }; identity.digest = hash(JSON.stringify(identity)); const provenance = { repositoryId: hash('repository-' + id), worktree, headSha: 'b'.repeat(40), workspaceDigest: hash('workspace-' + id), environmentDigest: 'e'.repeat(64), dependencyDigest: 'c'.repeat(64), nodeVersion: process.version, toolchain: 'npm@test', toolchainIdentity: identity, platform: process.platform, arch: process.arch }; const toolchain = { nodeExecutable, npmExecutable, toolchain: 'npm@test', identity }; const result = await coordinateVerification({ laneId, root, cwd: worktree, heartbeatMs: 5, timeoutMs: 15_000, collectProvenance: () => provenance, toolchain, hostCpuSampler: async () => buildHostPressureSample({ busyPercent: 40, cpuCount: 4, sampleMs: 1, sampledAt: Date.now(), threshold: 85, source: 'fixture', load1: 1, loadPerCpu: 0.25 }) }); console.log(JSON.stringify({ disposition: result.disposition, passed: result.receipt.terminal.passed }));`,
      root,
      worktree,
      id,
      laneId,
    ],
    {
      env: {
        ...process.env,
        PATH: `${binDirectory}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
        STATION_FIXTURE_MODE: mode,
        STATION_FIXTURE_COUNT: countPath,
        STATION_FIXTURE_RELEASE: releasePath,
        STATION_FIXTURE_DESCENDANT: descendantPath,
        STATION_FIXTURE_NPM: join(binDirectory, 'npm'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function collectFixtureChild(child: ReturnType<typeof spawn>) {
  return new Promise<{ code: number | null; output: string }>(
    (resolveResult, rejectResult) => {
      let output = '';
      let errors = '';
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        errors += chunk.toString();
      });
      child.once('error', rejectResult);
      child.once('close', (code) => {
        if (code === 0) resolveResult({ code, output });
        else rejectResult(new Error(`fixture child ${code}: ${errors}`));
      });
    },
  );
}

describe('verification coordinator', () => {
  test('binds execution history to the derived request head and overwrites inheritance', () => {
    const temp = fixture();
    try {
      const context = prepareCoordinatorContext({
        laneId: 'test-changed',
        root: temp.root,
        cwd: process.cwd(),
        collectProvenance: () =>
          boundCoordinatorProvenance(
            process.cwd(),
            'request-history-environment',
          ),
        env: { ...process.env, [STATION_VERIFICATION_HISTORY_REF]: 'HEAD' },
      });

      expect(context.env[STATION_VERIFICATION_HISTORY_REF]).toBe(
        context.request.headSha,
      );
      expect(context.request.headSha).toBe('b'.repeat(40));
    } finally {
      temp.remove();
    }
  });

  test('keeps coordinator authorities behind acyclic bounded modules', () => {
    const libraryRoot = join(process.cwd(), 'scripts/lib');
    const coordinator = readFileSync(
      join(libraryRoot, 'verification-coordinator.mjs'),
      'utf8',
    );
    const modules = [
      'verification-admission.mjs',
      'verification-completion-phases.mjs',
      'verification-ci-fast-diagnostics.mjs',
      'verification-lease-ownership.mjs',
      'verification-request-context.mjs',
      'verification-request-identity.mjs',
    ];
    for (const module of modules) {
      expect(coordinator).toContain(`from './${module}'`);
      expect(readFileSync(join(libraryRoot, module), 'utf8')).not.toContain(
        "from './verification-coordinator.mjs'",
      );
    }
    expect(coordinator).not.toContain('function runAdmissionLoop(');
    expect(coordinator).not.toContain('function runCompletionPhaseSequence(');
    expect(coordinator).not.toContain('function changedDiagnosticBinding(');
    expect(coordinator).not.toContain('function acquireLeaseDirectory(');
    expect(coordinator).not.toContain('function executionEquivalenceKey(');
    expect(coordinator).not.toContain('function prepareCoordinatorContext(');
    expect(coordinator.split('\n').length).toBeLessThan(1_900);
    expect(
      readFileSync(
        join(libraryRoot, 'verification-admission.mjs'),
        'utf8',
      ).split('\n').length,
    ).toBeLessThan(500);
    expect(
      readFileSync(
        join(libraryRoot, 'verification-completion-phases.mjs'),
        'utf8',
      ).split('\n').length,
    ).toBeLessThan(500);
    expect(
      readFileSync(
        join(libraryRoot, 'verification-lease-ownership.mjs'),
        'utf8',
      ).split('\n').length,
    ).toBeLessThan(1_000);
    expect(
      readFileSync(
        join(libraryRoot, 'verification-ci-fast-diagnostics.mjs'),
        'utf8',
      ),
    ).not.toContain('run-changed-verification.mjs');
  });

  test('Windows recovery advances only a settled Job-bound exact child', () => {
    const recover = __verificationCoordinatorInternals.recoverExactChild;
    const child = {
      pid: 42,
      processStart: 'birth',
      jobBound: true,
      guard: { pid: 43, processStart: 'guard-birth' },
    };
    expect(
      recover(child, { platform: 'win32', processIdentityFn: () => null }),
    ).toBe(true);
    expect(
      recover(child, {
        platform: 'win32',
        processIdentityFn: (pid: number) => ({
          pid,
          start: pid === 42 ? 'recycled' : 'guard-recycled',
        }),
      }),
    ).toBe(true);
    expect(
      recover(child, {
        platform: 'win32',
        processIdentityFn: () => ({ pid: 42, start: null, unavailable: true }),
      }),
    ).toBe(false);
    expect(
      recover(child, {
        platform: 'win32',
        processIdentityFn: (pid: number) => ({
          pid,
          start: pid === 42 ? 'birth' : 'guard-birth',
        }),
      }),
    ).toBe(false);
    expect(
      recover(
        { ...child, jobBound: false },
        { platform: 'win32', processIdentityFn: () => null },
      ),
    ).toBe(false);
    expect(
      recover(
        { pid: 42, jobBound: true, guard: { pid: 43 } },
        { platform: 'win32', processIdentityFn: () => null },
      ),
    ).toBe(false);
    let probes = 0;
    expect(
      recover(child, {
        platform: 'win32',
        processIdentityFn: (pid: number) => {
          probes += 1;
          // Both first probes look absent; the recheck finds the target alive.
          return probes === 3 ? { pid, start: 'birth' } : null;
        },
      }),
    ).toBe(false);
  });
  test('derives the request key from native Windows request paths', () => {
    expect(
      __verificationCoordinatorInternals.requestDirectoryKey(
        'C:\\cache\\requests\\0abc',
        'win32',
      ),
    ).toBe('0abc');
  });

  test('cannot acquire or write request artifacts while explicit GC owns its request-key mutation fence', async () => {
    const temp = fixture();
    const worktree = join(temp.root, 'worktree');
    mkdirSync(worktree);
    const stable = boundCoordinatorProvenance(worktree, 'artifact-fence');
    const request = createVerificationRequest('prepush', stable);
    const mutation = tryAcquireVerificationArtifactMutation({
      root: temp.root,
      requestKey: request.key,
      now: 1,
    });
    expect(mutation).not.toBeNull();
    let calls = 0;
    const controller = new AbortController();
    try {
      await expect(
        coordinateVerification({
          laneId: 'prepush',
          root: temp.root,
          cwd: worktree,
          collectProvenance: () => stable,
          signal: controller.signal,
          wait: async () => controller.abort(),
          runner: async () => {
            calls += 1;
            return { status: 0 };
          },
        }),
      ).rejects.toThrow('artifact mutation');
      expect(calls).toBe(0);
      expect(
        existsSync(
          join(worktree, '.kontourai/verification-output', request.key),
        ),
      ).toBe(false);
    } finally {
      releaseVerificationArtifactMutation(mutation);
      temp.remove();
    }
  });

  test('keeps a failed lane redacted output directory in its worktree after coordinator cleanup', async () => {
    const temp = fixture();
    const worktree = join(temp.root, 'failed-output');
    mkdirSync(worktree);
    const stable = boundCoordinatorProvenance(
      worktree,
      'failed-output-survival',
    );
    const request = createVerificationRequest('prepush', stable);
    try {
      const result = await coordinateVerification({
        laneId: 'prepush',
        root: temp.root,
        cwd: worktree,
        collectProvenance: () => stable,
        runner: async () => ({
          status: 1,
          output: {
            stdout: { text: 'failing check diagnostic' },
            stderr: { text: '' },
          },
        }),
      });
      expect(result.receipt.terminal.status).toBe('failed');
      expect(result.receipt.artifacts).toHaveLength(2);
      expect(
        existsSync(
          join(worktree, '.kontourai/verification-output', request.key),
        ),
      ).toBe(true);
      expect(existsSync(outputDirectory(temp.root, request))).toBe(false);

      const greenWorktree = join(temp.root, 'green-output');
      mkdirSync(greenWorktree);
      const greenStable = boundCoordinatorProvenance(
        greenWorktree,
        'green-output-cleanup',
      );
      const greenRequest = createVerificationRequest('prepush', greenStable);
      const green = await coordinateVerification({
        laneId: 'prepush',
        root: temp.root,
        cwd: greenWorktree,
        collectProvenance: () => greenStable,
        runner: async () => ({ status: 0 }),
      });
      expect(green.receipt.terminal.passed).toBe(true);
      expect(existsSync(outputDirectory(temp.root, greenRequest))).toBe(false);
    } finally {
      temp.remove();
    }
  });

  test('counts a classified ci-fast infrastructure outcome separately from a failed check', async () => {
    const temp = fixture();
    const worktree = join(temp.root, 'ci-fast-infrastructure');
    mkdirSync(worktree);
    const stable = boundCoordinatorProvenance(
      worktree,
      'ci-fast-infrastructure',
    );
    try {
      const infrastructure = await coordinateVerification({
        laneId: 'ci-fast',
        root: temp.root,
        cwd: worktree,
        collectProvenance: () => stable,
        runner: async () => ({ status: 80, infrastructureError: true }),
      });
      expect(infrastructure.receipt.counts).toMatchObject({
        failed: 0,
        infrastructureErrors: 1,
      });

      const failed = await coordinateVerification({
        laneId: 'ci-fast',
        root: temp.root,
        cwd: worktree,
        force: true,
        collectProvenance: () => stable,
        runner: async () => ({ status: 1 }),
      });
      expect(failed.receipt.counts).toMatchObject({
        failed: 1,
        infrastructureErrors: 0,
      });
    } finally {
      temp.remove();
    }
  });

  test('holds the artifact mutation fence until an owned writer settles', async () => {
    const temp = fixture();
    const worktree = join(temp.root, 'writer-worktree');
    mkdirSync(worktree);
    const stable = boundCoordinatorProvenance(worktree, 'writer-fence');
    const request = createVerificationRequest('prepush', stable);
    let release!: () => void;
    const pending = new Promise<void>((resolvePending) => {
      release = resolvePending;
    });
    try {
      const running = coordinateVerification({
        laneId: 'prepush',
        root: temp.root,
        cwd: worktree,
        collectProvenance: () => stable,
        runner: async () => {
          await pending;
          return { status: 0 };
        },
      });
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      expect(
        verificationArtifactMutationIsHeld({
          root: temp.root,
          requestKey: request.key,
        }),
      ).toBe(true);
      release();
      await running;
      expect(
        verificationArtifactMutationIsHeld({
          root: temp.root,
          requestKey: request.key,
        }),
      ).toBe(false);
    } finally {
      temp.remove();
    }
  });

  test('does not steal a live artifact claim and atomically reclaims a dead claimant', () => {
    const temp = fixture();
    const key = 'd'.repeat(64);
    const live = tryAcquireVerificationArtifactMutation({
      root: temp.root,
      requestKey: key,
    });
    expect(live).not.toBeNull();
    try {
      expect(
        tryAcquireVerificationArtifactMutation({
          root: temp.root,
          requestKey: key,
        }),
      ).toBeNull();
      releaseVerificationArtifactMutation(live);
      const path = join(temp.root, 'artifact-mutations', key);
      mkdirSync(path, { recursive: true });
      writeFileSync(
        join(path, 'claim.json'),
        JSON.stringify({
          owner: { pid: 999999, processStart: 'dead', nonce: 'dead' },
          createdAt: 0,
          heartbeatAt: 0,
        }),
      );
      const reclaimed = tryAcquireVerificationArtifactMutation({
        root: temp.root,
        requestKey: key,
      });
      expect(reclaimed).not.toBeNull();
      expect(reclaimed!.claim.owner.nonce).not.toBe('dead');
      releaseVerificationArtifactMutation(reclaimed);
    } finally {
      temp.remove();
    }
  });

  test('uses unique staged claim paths so a losing contender cannot remove the winner', () => {
    const temp = fixture();
    const key = 'e'.repeat(64);
    let winner: ReturnType<typeof tryAcquireVerificationArtifactMutation>;
    try {
      const loser = tryAcquireVerificationArtifactMutation({
        root: temp.root,
        requestKey: key,
        hooks: {
          afterStage: () => {
            winner = tryAcquireVerificationArtifactMutation({
              root: temp.root,
              requestKey: key,
            });
          },
        },
      });
      expect(loser).toBeNull();
      expect(winner).not.toBeNull();
      expect(
        verificationArtifactMutationIsHeld({
          root: temp.root,
          requestKey: key,
        }),
      ).toBe(true);
      releaseVerificationArtifactMutation(winner);
    } finally {
      temp.remove();
    }
  });

  test('single-flights two equivalent clean or stable-dirty callers and then reuses the pass', async () => {
    const temp = fixture();
    let calls = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolvePending) => {
      release = resolvePending;
    });
    const stable = provenance(`d-${temp.root}`);
    const options = {
      laneId: 'prepush',
      root: temp.root,
      heartbeatMs: 1,
      wait: async () => {},
      collectProvenance: () => stable,
      runner: async () => {
        calls += 1;
        await pending;
        return { status: 0 };
      },
    };
    try {
      const first = coordinateVerification(options);
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      const second = coordinateVerification(options);
      release();
      const [owner, joiner] = await Promise.all([first, second]);
      expect(calls).toBe(1);
      expect([owner.disposition, joiner.disposition].sort()).toEqual([
        'executed',
        'joined',
      ]);
      const reused = await coordinateVerification(options);
      expect(reused.disposition).toBe('reused');
      expect(calls).toBe(1);
    } finally {
      temp.remove();
    }
  });

  test('refuses a pinned submission request that already drifted at coordinator admission', async () => {
    const temp = fixture();
    const before = boundCoordinatorProvenance(temp.root, 'pinned-before');
    let provenanceCalls = 0;
    let runnerCalls = 0;
    try {
      await expect(
        coordinateVerification({
          laneId: 'prepush',
          root: temp.root,
          cwd: temp.root,
          collectProvenance: () => {
            provenanceCalls += 1;
            return provenanceCalls === 1
              ? before
              : boundCoordinatorProvenance(temp.root, 'pinned-after');
          },
          expectedRequest: createVerificationRequest('prepush', before),
          runner: async () => {
            runnerCalls += 1;
            return { status: 0 };
          },
        }),
      ).rejects.toThrow(
        'verification request changed before coordinator admission',
      );
      expect(runnerCalls).toBe(0);
      // The admission check is strictly earlier than the execution-time one, so
      // this fixture — whose provenance has already moved by the second read —
      // must be caught there and never reach a lease (station#1674).
      expect(provenanceCalls).toBe(2);
    } finally {
      temp.remove();
    }
  });

  test('names the lifecycle point that caught a pinned request drift', () => {
    const before = worktreeProvenance('/tmp/stage-before', 'stage-before');
    const after = worktreeProvenance('/tmp/stage-before', 'stage-after');
    const expectedRequest = createVerificationRequest('prepush', before);
    const args = (stage: string) => ({
      lane: { id: 'prepush' },
      cwd: '/tmp/stage-before',
      collectProvenance: () => after,
      expectedRequest,
      stage,
    });

    // Two genuinely different lifecycle points, so they must not collapse into
    // one message: `coordinator admission` means the worktree had already moved
    // before the request was admitted, `execution` means it moved during queue
    // time (station#1674).
    expect(() =>
      __verificationCoordinatorInternals.assertExpectedRequest(
        args('coordinator admission'),
      ),
    ).toThrow('verification request changed before coordinator admission');
    expect(() =>
      __verificationCoordinatorInternals.assertExpectedRequest(
        args('execution'),
      ),
    ).toThrow('verification request changed before execution');
    // An unpinned request is never revalidated at any stage.
    expect(() =>
      __verificationCoordinatorInternals.assertExpectedRequest({
        ...args('execution'),
        expectedRequest: undefined,
      }),
    ).not.toThrow();
    // A request that has not drifted passes every stage.
    expect(() =>
      __verificationCoordinatorInternals.assertExpectedRequest({
        ...args('execution'),
        collectProvenance: () => before,
      }),
    ).not.toThrow();
  });

  test('revalidates a pinned full-regression request before every non-reused phase', async () => {
    const temp = fixture();
    const worktree = join(temp.root, 'worktree');
    mkdirSync(worktree);
    let changed = false;
    const before = boundCoordinatorProvenance(worktree, 'phase-before');
    const started: string[] = [];
    try {
      const result = await coordinateVerification({
        laneId: 'full-regression',
        root: temp.root,
        cwd: worktree,
        heartbeatMs: 1,
        collectProvenance: () =>
          boundCoordinatorProvenance(
            worktree,
            changed ? 'phase-after' : 'phase-before',
          ),
        expectedRequest: createVerificationRequest('full-regression', before),
        hostCpuSampler: healthySampler(),
        phaseRunner: async ({ phase }: { phase: { id: string } }) => {
          started.push(phase.id);
          if (phase.id === 'repo-governance') changed = true;
          return { status: 0 };
        },
      });

      expect(started).toEqual(['repo-governance']);
      expect(result.receipt.terminal.passed).toBe(false);
    } finally {
      temp.remove();
    }
  });

  test('reuses one finished equivalent execution across sibling worktrees', async () => {
    const temp = fixture();
    const firstWorktree = join(temp.root, 'first');
    const secondWorktree = join(temp.root, 'second');
    mkdirSync(firstWorktree);
    mkdirSync(secondWorktree);
    let calls = 0;
    const options = (worktree: string) => ({
      laneId: 'prepush',
      root: temp.root,
      cwd: worktree,
      collectProvenance: () => worktreeProvenance(worktree, 'equivalent'),
      runner: async () => {
        calls += 1;
        return {
          status: 0,
          output: {
            stdout: { text: 'Tests 1 passed' },
            stderr: { text: '' },
          },
        };
      },
    });
    try {
      const first = await coordinateVerification(options(firstWorktree));
      const second = await coordinateVerification(options(secondWorktree));
      expect(calls).toBe(1);
      expect(first.disposition).toBe('executed');
      expect(second.disposition).toBe('reused');
      expect(second.receipt.request.worktree).toBe(secondWorktree);
      expect(second.receipt.request.key).not.toBe(first.receipt.request.key);
      expect(second.receipt.artifacts).toHaveLength(2);
      for (const artifact of first.receipt.artifacts)
        expect(existsSync(join(firstWorktree, artifact.path))).toBe(true);
      for (const artifact of second.receipt.artifacts)
        expect(existsSync(join(secondWorktree, artifact.path))).toBe(true);
      expect(
        existsSync(
          join(
            secondWorktree,
            '.kontourai',
            'verification-receipts',
            `${second.request.key}.canonical.json`,
          ),
        ),
      ).toBe(true);
    } finally {
      temp.remove();
    }
  });

  test('materializes the declared latest E2E pointer in a receiving worktree', async () => {
    const temp = fixture();
    const firstWorktree = join(temp.root, 'first');
    const secondWorktree = join(temp.root, 'second');
    mkdirSync(firstWorktree);
    mkdirSync(secondWorktree);
    let calls = 0;
    const options = (cwd: string) => ({
      laneId: 'verify-e2e-full',
      root: temp.root,
      cwd,
      collectProvenance: () => worktreeProvenance(cwd, 'e2e-equivalent'),
      hostCpuSampler: healthySampler(),
      runner: async () => {
        calls += 1;
        const source = join(cwd, 'evidence-source');
        const latest = join(cwd, '.kontourai', 'e2e-latest');
        mkdirSync(source, { recursive: true });
        writeFileSync(join(source, 'shot.png'), 'image');
        const projected = projectLatestE2EEvidence({
          sourceDir: source,
          destinationDir: latest,
          workspaceRoot: cwd,
          runId: `run-${calls}`,
          revision: 'b'.repeat(40),
          buckets: [{ name: 'product', verdict: 'PASS', counts: {} }],
        });
        return {
          status: 0,
          output: {
            stdout: {
              text: `[e2e-binding] ${Buffer.from(JSON.stringify(projected.projectionBinding)).toString('base64url')}\n`,
            },
            stderr: { text: '' },
          },
        };
      },
    });
    try {
      expect(
        (await coordinateVerification(options(firstWorktree))).disposition,
      ).toBe('executed');
      expect(
        (await coordinateVerification(options(secondWorktree))).disposition,
      ).toBe('reused');
      expect(
        readFileSync(
          join(secondWorktree, '.kontourai', 'e2e-latest', 'manifest.json'),
          'utf8',
        ),
      ).toContain('run-1');
      // The receiving receipt binds both manifest and payload bytes. Changing
      // a same-sized file must reject local reuse and force a new run.
      writeFileSync(
        join(
          secondWorktree,
          '.kontourai',
          'e2e-latest',
          'runs',
          'run-1',
          'shot.png',
        ),
        'other',
      );
      expect(
        (await coordinateVerification(options(secondWorktree))).disposition,
      ).toBe('executed');
      expect(calls).toBe(2);
      expect(
        readFileSync(
          join(
            secondWorktree,
            '.kontourai',
            'e2e-latest',
            'runs',
            'run-2',
            'shot.png',
          ),
          'utf8',
        ),
      ).toBe('image');
    } finally {
      temp.remove();
    }
  }, 30_000);

  test('refuses same-worktree E2E receipt reuse when latest evidence is missing or red', async () => {
    const temp = fixture();
    const cwd = join(temp.root, 'worktree');
    const coordinatorRoot = join(temp.root, 'coordinator');
    mkdirSync(cwd);
    let calls = 0;
    const options = {
      laneId: 'verify-e2e-full',
      root: coordinatorRoot,
      cwd,
      heartbeatMs: 1,
      collectProvenance: () => worktreeProvenance(cwd, 'e2e-local-pointer'),
      hostCpuSampler: healthySampler(),
      runner: async () => {
        calls += 1;
        const source = join(cwd, 'source');
        mkdirSync(source, { recursive: true });
        writeFileSync(join(source, 'shot.png'), 'image');
        const projected = projectLatestE2EEvidence({
          sourceDir: source,
          destinationDir: join(cwd, '.kontourai', 'e2e-latest'),
          workspaceRoot: cwd,
          runId: `run-${calls}`,
          revision: 'b'.repeat(40),
          buckets: [{ name: 'product', verdict: 'PASS', counts: {} }],
        });
        return {
          status: 0,
          reusableOutputs: [projected.projectionBinding],
          output: { stdout: { text: 'ok' }, stderr: { text: '' } },
        };
      },
    };
    try {
      expect((await coordinateVerification(options)).disposition).toBe(
        'executed',
      );
      rmSync(join(cwd, '.kontourai', 'e2e-latest'), {
        recursive: true,
        force: true,
      });
      expect((await coordinateVerification(options)).disposition).toBe(
        'executed',
      );
      expect(calls).toBe(2);
      const manifestPath = join(
        cwd,
        '.kontourai',
        'e2e-latest',
        'manifest.json',
      );
      const red = JSON.parse(readFileSync(manifestPath, 'utf8'));
      red.verdict = 'FAIL';
      red.buckets[0].verdict = 'FAIL';
      writeFileSync(manifestPath, `${JSON.stringify(red, null, 2)}\n`);
      expect((await coordinateVerification(options)).disposition).toBe(
        'executed',
      );
      expect(calls).toBe(3);
    } finally {
      temp.remove();
    }
  }, 15_000);

  test('refuses cross-worktree E2E reuse when the owner payload no longer matches its receipt binding', async () => {
    const temp = fixture();
    const first = join(temp.root, 'first');
    const second = join(temp.root, 'second');
    mkdirSync(first);
    mkdirSync(second);
    let calls = 0;
    const options = (cwd: string) => ({
      laneId: 'verify-e2e-full',
      root: temp.root,
      cwd,
      hostCpuSampler: healthySampler(),
      collectProvenance: () => worktreeProvenance(cwd, 'binding-equivalent'),
      runner: async () => {
        calls += 1;
        const source = join(cwd, 'source');
        mkdirSync(source, { recursive: true });
        writeFileSync(join(source, 'shot.png'), 'image');
        const projected = projectLatestE2EEvidence({
          sourceDir: source,
          destinationDir: join(cwd, '.kontourai', 'e2e-latest'),
          workspaceRoot: cwd,
          runId: `run-${calls}`,
          revision: 'b'.repeat(40),
          buckets: [{ name: 'product', verdict: 'PASS', counts: {} }],
        });
        return {
          status: 0,
          reusableOutputs: [projected.projectionBinding],
          output: { stdout: { text: 'ok' }, stderr: { text: '' } },
        };
      },
    });
    try {
      expect((await coordinateVerification(options(first))).disposition).toBe(
        'executed',
      );
      writeFileSync(
        join(first, '.kontourai', 'e2e-latest', 'runs', 'run-1', 'shot.png'),
        'other',
      );
      expect((await coordinateVerification(options(second))).disposition).toBe(
        'executed',
      );
      expect(calls).toBe(2);
    } finally {
      temp.remove();
    }
  }, 30_000);

  test('rejects a same-sized mutation while materializing reusable E2E evidence', () => {
    const temp = fixture();
    const first = join(temp.root, 'first');
    const second = join(temp.root, 'second');
    const source = join(first, 'source');
    mkdirSync(source, { recursive: true });
    mkdirSync(second);
    writeFileSync(join(source, 'shot.png'), 'image');
    const latest = join(first, '.kontourai', 'e2e-latest');
    projectLatestE2EEvidence({
      sourceDir: source,
      destinationDir: latest,
      workspaceRoot: first,
      runId: 'owner-run',
      revision: 'b'.repeat(40),
      buckets: [{ name: 'product', verdict: 'PASS', counts: {} }],
    });
    const binding = latestE2EEvidenceBinding(latest);
    try {
      expect(() =>
        __verificationCoordinatorInternals.projectLaneReusableOutputs(
          first,
          second,
          'verify-e2e-full',
          {
            request: {
              key: 'owner-request',
              headSha: 'b'.repeat(40),
              worktree: first,
            },
            reusableOutputs: [binding],
          },
          {
            afterProjection: ({ manifest, output, targetRoot }) => {
              writeFileSync(
                join(targetRoot, output, manifest.payloadDirectory, 'shot.png'),
                'other',
              );
            },
          },
        ),
      ).toThrow('does not match the owner payload binding');
    } finally {
      temp.remove();
    }
  });

  test('carries the executed E2E binding when another projector wins before receipt publication', async () => {
    const temp = fixture();
    const cwd = join(temp.root, 'worktree');
    mkdirSync(cwd);
    let replaced = false;
    const result = await coordinateVerification({
      laneId: 'verify-e2e-full',
      root: temp.root,
      cwd,
      hostCpuSampler: healthySampler(),
      collectProvenance: () => worktreeProvenance(cwd, 'receipt-race'),
      runner: async () => {
        const source = join(cwd, 'local-source');
        mkdirSync(source);
        writeFileSync(join(source, 'shot.png'), 'local');
        const projected = projectLatestE2EEvidence({
          sourceDir: source,
          destinationDir: join(cwd, '.kontourai', 'e2e-latest'),
          workspaceRoot: cwd,
          runId: 'local-run',
          revision: 'b'.repeat(40),
          buckets: [{ name: 'product', verdict: 'PASS', counts: {} }],
        });
        return {
          status: 0,
          output: {
            stdout: {
              text: `[e2e-binding] ${Buffer.from(JSON.stringify(projected.projectionBinding)).toString('base64url')}\n`,
            },
            stderr: { text: '' },
          },
        };
      },
      terminalHooks: {
        beforeCanonicalWrite: () => {
          if (replaced) return;
          replaced = true;
          const source = join(cwd, 'sync-source');
          mkdirSync(source);
          writeFileSync(join(source, 'shot.png'), 'sync!');
          projectLatestE2EEvidence({
            sourceDir: source,
            destinationDir: join(cwd, '.kontourai', 'e2e-latest'),
            workspaceRoot: cwd,
            runId: 'sync-run',
            revision: 'b'.repeat(40),
            buckets: [{ name: 'product', verdict: 'PASS', counts: {} }],
          });
        },
      },
    });
    try {
      expect(result.receipt.reusableOutputs[0].runId).toBe('local-run');
      expect(
        validateLatestE2EEvidence(join(cwd, '.kontourai', 'e2e-latest')).runId,
      ).toBe('sync-run');
    } finally {
      temp.remove();
    }
  });

  test('reuses projected full-regression phase evidence locally without re-executing', async () => {
    const temp = fixture();
    const firstWorktree = join(temp.root, 'first');
    const secondWorktree = join(temp.root, 'second');
    mkdirSync(firstWorktree);
    mkdirSync(secondWorktree);
    let phaseCalls = 0;
    const options = (worktree: string) => ({
      laneId: 'full-regression',
      root: temp.root,
      cwd: worktree,
      collectProvenance: () => worktreeProvenance(worktree, 'ci-equivalent'),
      hostCpuSampler: healthySampler(),
      heartbeatMs: 1,
      phaseRunner: async ({ phase }: { phase: { id: string } }) => {
        phaseCalls += 1;
        return { status: 0, output: { stdout: { text: phase.id } } };
      },
    });
    try {
      const first = await coordinateVerification(options(firstWorktree));
      const projected = await coordinateVerification(options(secondWorktree));
      const localReuse = await coordinateVerification(options(secondWorktree));
      expect(first.disposition).toBe('executed');
      expect(projected.disposition).toBe('reused');
      expect(localReuse.disposition).toBe('reused');
      expect(phaseCalls).toBe(18);
      expect(projected.receipt.request.worktree).toBe(secondWorktree);
      expect(localReuse.receipt.request.worktree).toBe(secondWorktree);
      expect(localReuse.receipt.artifacts).toEqual(projected.receipt.artifacts);
    } finally {
      temp.remove();
    }
  });

  test('resumes a failed full-regression from durable resource-group checkpoints', async () => {
    const temp = fixture();
    const worktree = join(temp.root, 'checkpointed');
    mkdirSync(worktree);
    const calls: string[] = [];
    let attempt = 0;
    const options = {
      laneId: 'full-regression',
      root: temp.root,
      cwd: worktree,
      collectProvenance: () =>
        worktreeProvenance(worktree, 'checkpointed-full-regression'),
      hostCpuSampler: healthySampler(),
      heartbeatMs: 1,
      phaseRunner: async ({ phase }: { phase: { id: string } }) => {
        calls.push(`${attempt}:${phase.id}`);
        return {
          status:
            attempt === 0 && phase.id === 'test-full-shared-output' ? 1 : 0,
        };
      },
    };
    try {
      const first = await coordinateVerification(options);
      expect(first.receipt.terminal.passed).toBe(false);
      attempt = 1;
      const resumed = await coordinateVerification(options);
      expect(resumed.receipt.terminal.passed).toBe(true);
      expect(calls).toEqual([
        '0:repo-governance',
        '0:sdk-builds',
        '0:verify-static',
        ...ORDINARY_FULL_PHASE_IDS.map((id) => `0:${id}`),
        '0:test-full-process-heavy',
        '0:test-full-process-exclusive',
        '0:test-full-coordinator-exclusive',
        '0:test-full-credential-ledger-exclusive',
        '0:test-full-shared-output',
        '1:test-full-shared-output',
        '1:test-full-dogfood-reconcile',
        '1:app-builds',
      ]);
    } finally {
      temp.remove();
    }
  });

  test('does not join or reuse when behavior-changing environment identity drifts', async () => {
    const temp = fixture();
    const firstWorktree = join(temp.root, 'first');
    const secondWorktree = join(temp.root, 'second');
    mkdirSync(firstWorktree);
    mkdirSync(secondWorktree);
    let calls = 0;
    const options = (worktree: string, environmentDigest: string) => ({
      laneId: 'prepush',
      root: temp.root,
      cwd: worktree,
      collectProvenance: () => ({
        ...worktreeProvenance(worktree, 'same-workspace'),
        environmentDigest,
      }),
      runner: async () => {
        calls += 1;
        return { status: 0 };
      },
    });
    try {
      const first = await coordinateVerification(
        options(firstWorktree, 'e'.repeat(64)),
      );
      const second = await coordinateVerification(
        options(secondWorktree, 'f'.repeat(64)),
      );
      expect(calls).toBe(2);
      expect(first.disposition).toBe('executed');
      expect(second.disposition).toBe('executed');
      expect(second.request.environmentDigest).toBe('f'.repeat(64));
    } finally {
      temp.remove();
    }
  });

  test('finished reuse fails closed for changed worktree, receipt, artifact, and failed-owner cases', async () => {
    const cases = ['changed', 'receipt', 'artifact', 'failed'] as const;
    for (const scenario of cases) {
      const temp = fixture();
      const firstWorktree = join(temp.root, 'first');
      const secondWorktree = join(temp.root, 'second');
      mkdirSync(firstWorktree);
      mkdirSync(secondWorktree);
      let calls = 0;
      let secondCalls = 0;
      const first = await coordinateVerification({
        laneId: 'prepush',
        root: temp.root,
        cwd: firstWorktree,
        collectProvenance: () =>
          worktreeProvenance(firstWorktree, `case-${scenario}`),
        runner: async () => ({
          status: scenario === 'failed' ? 1 : 0,
          output: { stdout: { text: 'Tests 1 passed' }, stderr: { text: '' } },
        }),
      });
      calls += 1;
      try {
        if (scenario === 'receipt') {
          const path = join(
            firstWorktree,
            '.kontourai',
            'verification-receipts',
            `${first.request.key}.canonical.json`,
          );
          const receipt = JSON.parse(readFileSync(path, 'utf8'));
          receipt.unknown = true;
          writeFileSync(path, JSON.stringify(receipt));
        }
        if (scenario === 'artifact')
          rmSync(join(firstWorktree, first.receipt.artifacts[0].path));
        let reads = 0;
        const second = await coordinateVerification({
          laneId: 'prepush',
          root: temp.root,
          cwd: secondWorktree,
          collectProvenance: () => {
            reads += 1;
            return worktreeProvenance(
              secondWorktree,
              scenario === 'changed' && reads === 2
                ? `changed-${scenario}`
                : `case-${scenario}`,
            );
          },
          runner: async () => {
            calls += 1;
            secondCalls += 1;
            return { status: 0 };
          },
        });
        expect(second.disposition).toBe('executed');
        expect(secondCalls).toBe(1);
        expect(calls).toBe(2);
      } finally {
        temp.remove();
      }
    }
  });

  test.each([
    ['laneId', 'test-full'],
    ['toolchain', undefined],
    ['toolchainIdentity', undefined],
    ['platform', 'different-platform'],
  ])(
    'does not reuse a finished owner when %s changes',
    async (field, value) => {
      const temp = fixture();
      const firstWorktree = join(temp.root, 'first');
      const secondWorktree = join(temp.root, 'second');
      mkdirSync(firstWorktree);
      mkdirSync(secondWorktree);
      let calls = 0;
      const firstProvenance = worktreeProvenance(firstWorktree, 'identity');
      const changedToolchain =
        field === 'toolchain' || field === 'toolchainIdentity'
          ? alternateToolchain(
              temp.root,
              field === 'toolchain' ? '99.0.0' : undefined,
            )
          : TEST_TOOLCHAIN;
      const secondProvenance = {
        ...worktreeProvenance(secondWorktree, 'identity', changedToolchain),
        ...(field === 'platform' ? { platform: value } : {}),
      };
      try {
        await coordinateVerification({
          laneId: 'prepush',
          root: temp.root,
          cwd: firstWorktree,
          collectProvenance: () => firstProvenance,
          toolchain: TEST_TOOLCHAIN,
          hostCpuSampler: healthySampler(),
          runner: async () => ({ status: ++calls === 1 ? 0 : 1 }),
        });
        const second = await coordinateVerification({
          laneId: field === 'laneId' ? value : 'prepush',
          root: temp.root,
          cwd: secondWorktree,
          collectProvenance: () => secondProvenance,
          toolchain: changedToolchain,
          hostCpuSampler: healthySampler(),
          runner: async () => ({ status: ++calls === 2 ? 0 : 1 }),
        });
        expect(second.disposition).toBe('executed');
        expect(calls).toBe(2);
      } finally {
        temp.remove();
      }
    },
  );

  test('does not reuse an execution key when executable identity changes', () => {
    const request = createVerificationRequest(
      'prepush',
      worktreeProvenance('/fixture/worktree', 'identity'),
    );
    expect(
      executionEquivalenceKey({
        ...request,
        toolchainIdentity: 'f'.repeat(64),
      }),
    ).not.toBe(executionEquivalenceKey(request));
  });

  test('invalidated identity executes again and force writes an isolated diagnostic receipt', async () => {
    const temp = fixture();
    let calls = 0;
    let current = provenance(`e-${temp.root}`);
    const options = {
      laneId: 'prepush',
      root: temp.root,
      collectProvenance: () => current,
      runner: async () => {
        calls += 1;
        return { status: 0 };
      },
    };
    try {
      await coordinateVerification(options);
      current = provenance(`f-${temp.root}`);
      const invalidated = await coordinateVerification(options);
      const forced = await coordinateVerification({ ...options, force: true });
      expect(invalidated.disposition).toBe('executed');
      expect(forced.disposition).toBe('forced');
      expect(forced.receipt.terminal.passed).toBe(true);
      expect(calls).toBe(3);
    } finally {
      temp.remove();
    }
  });

  test('a lease with no recorded owner identity expires by heartbeat (station#3187)', () => {
    const now = 1_000_000;
    // `processStart` is `identity?.start ?? null` at lease creation, so it can
    // be absent. When it was, the reuse check was skipped and the tail read
    // `... <= staleMs || Boolean(actual)` — and `actual` is already proven
    // truthy, so that was ALWAYS true. A recycled PID held a 60-unit lease
    // reporting `running, live: true` with no process behind it, while four
    // real jobs queued.
    expect(
      leaseIsLive(
        { owner: { pid: 42, processStart: null }, heartbeatAt: now - 99_999 },
        {
          now,
          processIdentityFn: () => ({ pid: 42, start: 'whoever-has-it-now' }),
        },
      ),
    ).toBe(false);
    // A fresh heartbeat still counts: an unverifiable identity is not assumed
    // dead either, it just does not get the unbounded grant a proven one does.
    expect(
      leaseIsLive(
        { owner: { pid: 42, processStart: null }, heartbeatAt: now },
        {
          now,
          processIdentityFn: () => ({ pid: 42, start: 'whoever-has-it-now' }),
        },
      ),
    ).toBe(true);
  });

  test('exposes queued weighted work and does not treat PID reuse as a live lease', () => {
    const now = 1_000;
    expect(
      leaseIsLive(
        { owner: { pid: 42, processStart: 'old' }, heartbeatAt: now },
        {
          now,
          processIdentityFn: () => ({ pid: 42, start: 'new' }),
        },
      ),
    ).toBe(false);
    expect(
      leaseIsLive(
        { owner: { pid: 42, processStart: 'same' }, heartbeatAt: now - 99_999 },
        {
          now,
          processIdentityFn: () => ({ pid: 42, start: 'same' }),
        },
      ),
    ).toBe(true);
    expect(
      leaseIsLive(
        { owner: { pid: 42, processStart: 'same' }, heartbeatAt: now },
        {
          now,
          processIdentityFn: () => ({
            pid: 42,
            start: null,
            unavailable: true,
          }),
        },
      ),
    ).toBe(true);
    const temp = fixture();
    try {
      expect(verificationStatus({ root: temp.root })).toMatchObject({
        capacity: 100,
        usedWeight: 0,
        waiting: 0,
        jobs: [],
        retention: {
          terminal: { retained: 0, eligible: 0, complete: true },
          handoffs: { launching: 0, coordinating: 0, retryClaims: 0 },
          scan: { truncated: false, invalidSkipped: 0 },
        },
      });
    } finally {
      temp.remove();
    }
  });

  test('queues non-equivalent heavy lanes by weighted host capacity and records cancellation truthfully', async () => {
    const temp = fixture();
    let release!: () => void;
    const blocking = new Promise<void>((resolvePending) => {
      release = resolvePending;
    });
    const controller = new AbortController();
    const options = {
      root: temp.root,
      capacity: 100,
      heartbeatMs: 1,
      collectProvenance: () => provenance(`1-${temp.root}`),
      hostCpuSampler: healthySampler(),
    };
    try {
      const heavy = coordinateVerification({
        ...options,
        laneId: 'verify-static',
        runner: async () => {
          await blocking;
          return { status: 0 };
        },
      });
      // Wait for the gated heavy lane to clear its two healthy samples and hold
      // capacity before the waiting lane starts, so the waiting lane queues
      // behind it deterministically rather than racing admission timing.
      await waitFor(() =>
        verificationStatus({ root: temp.root }).jobs.some(
          (job) => job.state === 'admitted' || job.state === 'running',
        ),
      );
      const waiting = coordinateVerification({
        ...options,
        laneId: 'prepush',
        signal: controller.signal,
        runner: async ({ signal }: { signal: AbortSignal }) => {
          if (signal.aborted)
            throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
          await new Promise<void>((_, reject) =>
            signal.addEventListener(
              'abort',
              () =>
                reject(
                  Object.assign(new Error('cancelled'), { name: 'AbortError' }),
                ),
              { once: true },
            ),
          );
          return { status: 0 };
        },
      });
      await waitFor(() =>
        verificationStatus({ root: temp.root }).jobs.some(
          (job) => job.state === 'queued',
        ),
      );
      controller.abort();
      release();
      const [, canceled] = await Promise.all([heavy, waiting]);
      expect(canceled.receipt.terminal.status).toBe('canceled');
      expect(canceled.receipt.terminal.passed).toBe(false);
    } finally {
      temp.remove();
    }
  });

  test('schedules full-regression by phase, protects its full-corpus phase, and aggregates exact phase receipts', async () => {
    const temp = fixture();
    const worktree = join(temp.root, 'worktree');
    const lightWorktree = join(temp.root, 'light-worktree');
    mkdirSync(worktree);
    mkdirSync(lightWorktree);
    let releaseGovernance!: () => void;
    const governance = new Promise<void>((resolve) => {
      releaseGovernance = resolve;
    });
    let releaseLight!: () => void;
    const light = new Promise<void>((resolve) => {
      releaseLight = resolve;
    });
    const phases: string[] = [];
    const ciOptions = {
      laneId: 'full-regression',
      root: temp.root,
      cwd: worktree,
      capacity: 100,
      heartbeatMs: 1,
      collectProvenance: () => worktreeProvenance(worktree, 'ci-phases'),
      hostCpuSampler: healthySampler(),
      phaseRunner: async ({ phase }: { phase: { id: string } }) => {
        phases.push(phase.id);
        if (phase.id === 'repo-governance') await governance;
        return { status: 0, output: { stdout: { text: phase.id } } };
      },
    };
    try {
      const ci = coordinateVerification(ciOptions);
      await waitFor(() =>
        verificationStatus({ root: temp.root }).jobs.some(
          (job) =>
            job.phase?.id === 'repo-governance' && job.state === 'running',
        ),
      );
      const low = coordinateVerification({
        laneId: 'prepush',
        root: temp.root,
        cwd: lightWorktree,
        capacity: 100,
        heartbeatMs: 1,
        collectProvenance: () =>
          worktreeProvenance(lightWorktree, 'light-phase'),
        runner: async () => {
          await light;
          return { status: 0 };
        },
      });
      await waitFor(
        () => verificationStatus({ root: temp.root }).usedWeight === 60,
      );
      releaseGovernance();
      await waitFor(() =>
        verificationStatus({ root: temp.root }).jobs.some(
          (job) =>
            job.phase?.id === ORDINARY_FULL_PHASE_IDS[0] &&
            job.state === 'queued',
        ),
      );
      expect(phases).toEqual([
        'repo-governance',
        'sdk-builds',
        'verify-static',
      ]);
      releaseLight();
      const [ciResult, lowResult] = await Promise.all([ci, low]);
      expect(lowResult.receipt.terminal.passed).toBe(true);
      expect(ciResult.receipt.terminal.passed).toBe(true);
      expect(phases).toEqual([
        'repo-governance',
        'sdk-builds',
        'verify-static',
        ...ORDINARY_FULL_PHASE_IDS,
        'test-full-process-heavy',
        'test-full-process-exclusive',
        'test-full-coordinator-exclusive',
        'test-full-credential-ledger-exclusive',
        'test-full-shared-output',
        'test-full-dogfood-reconcile',
        'app-builds',
      ]);
      const phaseArtifacts = ciResult.receipt.artifacts.filter((artifact) =>
        artifact.path.includes('/attachment-'),
      );
      expect(phaseArtifacts).toHaveLength(18);
      const records = phaseArtifacts.map((artifact) =>
        JSON.parse(readFileSync(join(worktree, artifact.path), 'utf8')),
      );
      expect(records.map((record) => record.phase.id)).toEqual(phases);
      expect(
        records.every(
          (record) => record.parentRequestKey === ciResult.request.key,
        ),
      ).toBe(true);
      const reused = await coordinateVerification(ciOptions);
      expect(reused.disposition).toBe('reused');
    } finally {
      temp.remove();
    }
  });

  test('does not hold full-regression capacity while waiting for same-worktree output ownership', async () => {
    const temp = fixture();
    const worktree = join(temp.root, 'worktree');
    mkdirSync(worktree);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      const focused = coordinateVerification({
        laneId: 'prepush',
        root: temp.root,
        cwd: worktree,
        capacity: 100,
        heartbeatMs: 1,
        collectProvenance: () => worktreeProvenance(worktree, 'same-output'),
        runner: async () => {
          await blocked;
          return { status: 0 };
        },
      });
      await waitFor(() =>
        verificationStatus({ root: temp.root }).jobs.some(
          (job) => job.state === 'running' && job.weight === 40,
        ),
      );
      const completion = coordinateVerification({
        laneId: 'full-regression',
        root: temp.root,
        cwd: worktree,
        capacity: 100,
        heartbeatMs: 1,
        collectProvenance: () => worktreeProvenance(worktree, 'same-output'),
        hostCpuSampler: healthySampler(),
        phaseRunner: async () => ({ status: 0 }),
      });
      await waitFor(() =>
        verificationStatus({ root: temp.root }).jobs.some(
          (job) =>
            job.request?.laneId === 'full-regression' && job.state === 'queued',
        ),
      );
      await waitFor(
        () => verificationStatus({ root: temp.root }).usedWeight === 40,
      );
      release();
      const [focusedResult, completionResult] = await Promise.all([
        focused,
        completion,
      ]);
      expect(focusedResult.receipt.terminal.passed).toBe(true);
      expect(completionResult.receipt.terminal.passed).toBe(true);
    } finally {
      temp.remove();
    }
  });

  test('serializes distinct full-regression requests in a coordinator-owned FIFO while ci:fast still admits', async () => {
    const temp = fixture();
    const worktrees = ['one', 'two', 'three'].map((name) =>
      join(temp.root, name),
    );
    for (const worktree of worktrees) mkdirSync(worktree);
    const fastWorktree = join(temp.root, 'fast');
    mkdirSync(fastWorktree);
    const gates = new Map<string, () => void>();
    const started: string[] = [];
    let activeOwners = 0;
    let maxActiveOwners = 0;
    let fastCalls = 0;
    const waitForGate = (worktree: string) =>
      new Promise<void>((resolveGate) => gates.set(worktree, resolveGate));
    const options = (worktree: string) => ({
      laneId: 'full-regression',
      root: temp.root,
      cwd: worktree,
      heartbeatMs: 1,
      collectProvenance: () => worktreeProvenance(worktree, `host-${worktree}`),
      hostCpuSampler: healthySampler(),
      phaseRunner: async ({ phase }: { phase: { id: string } }) => {
        activeOwners += 1;
        maxActiveOwners = Math.max(maxActiveOwners, activeOwners);
        try {
          if (phase.id === 'repo-governance') {
            started.push(worktree);
            await waitForGate(worktree);
          }
          return { status: 0 };
        } finally {
          activeOwners -= 1;
        }
      },
    });
    try {
      const first = coordinateVerification(options(worktrees[0]));
      await waitFor(() => started.length === 1 && gates.has(worktrees[0]));
      const second = coordinateVerification(options(worktrees[1]));
      await waitFor(() =>
        verificationStatus({ root: temp.root }).jobs.some(
          (job) => job.queueReason === 'completion_single_flight',
        ),
      );
      const third = coordinateVerification(options(worktrees[2]));
      await waitFor(() => {
        const queued = verificationStatus({ root: temp.root }).jobs.filter(
          (job) => job.queueReason === 'completion_single_flight',
        );
        return queued.length === 2;
      });
      expect(maxActiveOwners).toBe(1);

      const fast = await coordinateVerification({
        laneId: 'ci-fast',
        root: temp.root,
        cwd: fastWorktree,
        heartbeatMs: 1,
        collectProvenance: () =>
          worktreeProvenance(fastWorktree, 'fast-headroom'),
        runner: async () => {
          fastCalls += 1;
          return { status: 0 };
        },
      });
      // #1727 made a `ci-fast` receipt fail closed without real
      // `.kontourai/test-impact/changed-diagnostics.json` evidence, which a
      // stub runner in a fixture worktree never produces — so `passed` is not
      // a claim this test can earn, and asserting it made six admission tests
      // red on `main`. The subject here is admission, and `executed` is
      // exactly it: a rejected, canceled, joined or queued lane is not
      // `executed`. The ci:fast receipt's own pass/fail lives in
      // `verification-terminal-receipt.test.ts`, which #1727 extended for it.
      expect(fast.disposition).toBe('executed');
      expect(fastCalls).toBe(1);

      gates.get(worktrees[0])?.();
      await waitFor(
        () => started.length === 2 && gates.has(worktrees[1]),
        10_000,
      );
      expect(maxActiveOwners).toBe(1);
      gates.get(worktrees[1])?.();
      await waitFor(
        () => started.length === 3 && gates.has(worktrees[2]),
        10_000,
      );
      expect(maxActiveOwners).toBe(1);
      gates.get(worktrees[2])?.();

      const results = await Promise.all([first, second, third]);
      expect(results.every((result) => result.receipt.terminal.passed)).toBe(
        true,
      );
      expect(started).toEqual(worktrees);
      expect(maxActiveOwners).toBe(1);
    } finally {
      temp.remove();
    }
  }, 30_000);

  test('rejects a distinct completion request beyond the bounded waiter cap while ci:fast still admits', async () => {
    const temp = fixture();
    const worktrees = Array.from(
      { length: MAX_COMPLETION_WAITERS + 2 },
      (_value, index) => join(temp.root, `bounded-${index}`),
    );
    const fastWorktree = join(temp.root, 'bounded-fast');
    for (const worktree of [...worktrees, fastWorktree]) mkdirSync(worktree);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    let firstStarted = false;
    let rejectedPhaseCalls = 0;
    const options = (worktree: string) => ({
      laneId: 'full-regression',
      root: temp.root,
      cwd: worktree,
      heartbeatMs: 1,
      collectProvenance: () =>
        worktreeProvenance(worktree, `bounded-${worktree}`),
      hostCpuSampler: healthySampler(),
      phaseRunner: async ({ phase }: { phase: { id: string } }) => {
        if (worktree === worktrees[0] && phase.id === 'repo-governance') {
          firstStarted = true;
          await firstGate;
        }
        if (worktree === worktrees.at(-1)) rejectedPhaseCalls += 1;
        return { status: 0 };
      },
    });
    try {
      const owner = coordinateVerification(options(worktrees[0]));
      await waitFor(() => firstStarted);
      const waiters = [];
      for (const worktree of worktrees.slice(1, -1)) {
        waiters.push(coordinateVerification(options(worktree)));
        await waitFor(
          () =>
            verificationStatus({ root: temp.root }).jobs.filter(
              (job) =>
                job.live &&
                job.state === 'queued' &&
                job.request?.laneId === 'full-regression',
            ).length === waiters.length,
        );
      }

      const rejected = await coordinateVerification(options(worktrees.at(-1)!));
      expect(rejected.disposition).toBe('executed');
      expect(rejected.receipt.terminal).toEqual({
        status: 'rejected',
        exitCode: null,
        passed: false,
      });
      expect(rejected.receipt.counts).toEqual({
        executed: 0,
        passed: 0,
        failed: 0,
        infrastructureErrors: 0,
      });
      expect(rejectedPhaseCalls).toBe(0);

      const fast = await coordinateVerification({
        laneId: 'ci-fast',
        root: temp.root,
        cwd: fastWorktree,
        heartbeatMs: 1,
        collectProvenance: () =>
          worktreeProvenance(fastWorktree, 'bounded-fast'),
        runner: async () => ({ status: 0 }),
      });
      // `passed` is not earnable here — see the note on the first ci:fast
      // admission assertion in this file (#1727 / station#1738).
      expect(fast.disposition).toBe('executed');

      releaseFirst();
      const settled = await Promise.all([owner, ...waiters]);
      expect(settled.map((result) => result.receipt.terminal)).toEqual(
        Array.from({ length: MAX_COMPLETION_WAITERS + 1 }, () => ({
          status: 'completed',
          exitCode: 0,
          passed: true,
        })),
      );
    } finally {
      releaseFirst?.();
      temp.remove();
    }
  }, 30_000);

  test('recovers a killed cross-process completion owner, reaps its fixture group, and selects the next FIFO owner', async () => {
    if (process.platform === 'win32') return;
    const temp = fixture();
    const worktrees = ['one', 'two', 'three'].map((name) =>
      join(temp.root, name),
    );
    const fastWorktree = join(temp.root, 'fast');
    const binDirectory = join(temp.root, 'bin');
    const secondRelease = join(temp.root, 'release-second');
    const descendantPath = join(temp.root, 'first-descendant.json');
    const fakeNpm = join(binDirectory, 'npm');
    const children: ReturnType<typeof spawn>[] = [];
    let monitor: ReturnType<typeof setInterval> | undefined;
    let firstPgid: number | null | undefined;
    let firstDescendantPid: number | null | undefined;
    let maxActiveOwners = 0;
    let maxQueuedOwners = 0;
    const updateObservedTopology = () => {
      const status = verificationStatus({ root: temp.root });
      maxActiveOwners = Math.max(
        maxActiveOwners,
        status.jobs.filter(
          (job) =>
            job.live &&
            job.request?.laneId === 'full-regression' &&
            ['admitted', 'orchestrating', 'output', 'running'].includes(
              job.state,
            ),
        ).length,
      );
      maxQueuedOwners = Math.max(
        maxQueuedOwners,
        status.jobs.filter(
          (job) =>
            job.live &&
            job.request?.laneId === 'full-regression' &&
            job.queueReason === 'completion_single_flight',
        ).length,
      );
    };
    try {
      for (const worktree of [...worktrees, fastWorktree])
        mkdirSync(worktree, { recursive: true });
      mkdirSync(binDirectory, { recursive: true });
      writeFileSync(
        fakeNpm,
        `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const mode = process.env.STATION_FIXTURE_MODE;
const countPath = process.env.STATION_FIXTURE_COUNT;
const count = existsSync(countPath) ? Number(readFileSync(countPath, 'utf8')) + 1 : 1;
writeFileSync(countPath, String(count));
const holds =
  (mode === 'hold-test-full-ordinary' && count === 4) ||
  (mode === 'hold-repo-governance' && count === 1);
if (!holds) process.exit(0);
if (mode === 'hold-test-full-ordinary') {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
    stdio: 'ignore',
  });
  writeFileSync(process.env.STATION_FIXTURE_DESCENDANT, JSON.stringify({ pid: descendant.pid }));
}
const release = process.env.STATION_FIXTURE_RELEASE;
setInterval(() => {
  if (mode === 'hold-repo-governance' && existsSync(release)) process.exit(0);
}, 5);
`,
      );
      chmodSync(fakeNpm, 0o755);

      const first = completionCoordinatorChild({
        root: temp.root,
        worktree: worktrees[0],
        id: 'one',
        laneId: 'full-regression',
        binDirectory,
        mode: 'hold-test-full-ordinary',
        countPath: join(temp.root, 'first-count'),
        releasePath: join(temp.root, 'never-release-first'),
        descendantPath,
      });
      children.push(first);
      const firstResult = collectFixtureChild(first).catch(() => undefined);
      await waitFor(() => {
        const job = verificationStatus({ root: temp.root }).jobs.find(
          (candidate) => candidate.request?.worktree === worktrees[0],
        );
        if (
          !job?.live ||
          job.state !== 'running' ||
          job.phase?.id !== ORDINARY_FULL_PHASE_IDS[0]
        )
          return false;
        firstPgid = job.child?.pgid;
        return (
          typeof firstPgid === 'number' &&
          processGroupIsLive(firstPgid) &&
          existsSync(descendantPath)
        );
      }, 10_000);
      expect(verificationStatus({ root: temp.root }).usedWeight).toBe(80);
      expect(existsSync(descendantPath)).toBe(true);
      firstDescendantPid = JSON.parse(readFileSync(descendantPath, 'utf8')).pid;
      expect(firstPgid).toEqual(expect.any(Number));
      expect(firstDescendantPid).toEqual(expect.any(Number));

      const second = completionCoordinatorChild({
        root: temp.root,
        worktree: worktrees[1],
        id: 'two',
        laneId: 'full-regression',
        binDirectory,
        mode: 'hold-repo-governance',
        countPath: join(temp.root, 'second-count'),
        releasePath: secondRelease,
        descendantPath: join(temp.root, 'second-descendant.json'),
      });
      children.push(second);
      const secondResult = collectFixtureChild(second);
      await waitFor(
        () =>
          verificationStatus({ root: temp.root }).jobs.some(
            (job) =>
              job.request?.worktree === worktrees[1] &&
              job.queueReason === 'completion_single_flight',
          ),
        10_000,
      );

      const third = completionCoordinatorChild({
        root: temp.root,
        worktree: worktrees[2],
        id: 'three',
        laneId: 'full-regression',
        binDirectory,
        mode: 'fast',
        countPath: join(temp.root, 'third-count'),
        releasePath: join(temp.root, 'unused-third-release'),
        descendantPath: join(temp.root, 'third-descendant.json'),
      });
      children.push(third);
      const thirdResult = collectFixtureChild(third);
      await waitFor(() => {
        const queued = verificationStatus({ root: temp.root }).jobs.filter(
          (job) => job.queueReason === 'completion_single_flight',
        );
        return queued.length === 2;
      }, 10_000);

      monitor = setInterval(updateObservedTopology, 5);
      updateObservedTopology();
      const fast = completionCoordinatorChild({
        root: temp.root,
        worktree: fastWorktree,
        id: 'fast',
        laneId: 'ci-fast',
        binDirectory,
        mode: 'fast',
        countPath: join(temp.root, 'fast-count'),
        releasePath: join(temp.root, 'unused-fast-release'),
        descendantPath: join(temp.root, 'fast-descendant.json'),
      });
      children.push(fast);
      const fastResult = await collectFixtureChild(fast);
      // `passed` is not earnable here — see the note on the first ci:fast
      // admission assertion in this file (#1727 / station#1738).
      expect(JSON.parse(fastResult.output)).toMatchObject({
        disposition: 'executed',
      });

      expect(first.kill('SIGKILL')).toBe(true);
      await firstResult;
      await waitFor(() => !processGroupIsLive(firstPgid), 10_000);
      await waitFor(() => !processIsLive(firstDescendantPid), 10_000);
      await waitFor(() => {
        const secondJob = verificationStatus({ root: temp.root }).jobs.find(
          (job) => job.request?.worktree === worktrees[1],
        );
        return (
          secondJob?.live === true &&
          secondJob.state === 'running' &&
          secondJob.phase?.id === 'repo-governance'
        );
      }, 10_000);
      expect(processGroupIsLive(firstPgid)).toBe(false);
      expect(processIsLive(firstDescendantPid)).toBe(false);

      writeFileSync(secondRelease, 'release');
      const [secondTerminal, thirdTerminal] = await Promise.all([
        secondResult,
        thirdResult,
      ]);
      expect(JSON.parse(secondTerminal.output)).toMatchObject({ passed: true });
      expect(JSON.parse(thirdTerminal.output)).toMatchObject({ passed: true });
      updateObservedTopology();
      expect(maxActiveOwners).toBe(1);
      expect(maxQueuedOwners).toBe(2);
      expect(verificationStatus({ root: temp.root }).usedWeight).toBe(0);
    } finally {
      if (monitor) clearInterval(monitor);
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
      }
      if (firstPgid && processGroupIsLive(firstPgid)) {
        try {
          process.kill(-firstPgid, 'SIGKILL');
        } catch {
          // The stale-owner recovery already reaped this fixture-owned group.
        }
      }
      temp.remove();
    }
  }, 45_000);

  test('runs a real npm lifecycle node command with the bound Node runtime ahead of an ambient node shim', async () => {
    const temp = fixture();
    const worktree = join(temp.root, 'worktree');
    const phaseMarker = join(temp.root, 'phase-node-runtime');
    const ambientMarker = join(temp.root, 'ambient-node-was-used');
    const ambientBin = join(temp.root, 'ambient-bin');
    try {
      mkdirSync(worktree, { recursive: true });
      mkdirSync(ambientBin);
      writeAmbientNodeShim(ambientBin);
      writeFileSync(
        join(worktree, 'package.json'),
        JSON.stringify({
          private: true,
          scripts: { 'test:prepush:raw': 'node phase-runtime.cjs' },
        }),
      );
      writeFileSync(
        join(worktree, 'phase-runtime.cjs'),
        "require('node:fs').writeFileSync(process.env.STATION_FIXTURE_PHASE_NODE_MARKER, process.execPath);",
      );
      const env = {
        ...process.env,
        PATH: `${ambientBin}${delimiter}${process.env.PATH ?? ''}`,
        STATION_FIXTURE_AMBIENT_NODE_MARKER: ambientMarker,
        STATION_FIXTURE_BOUND_NODE: process.execPath,
        STATION_FIXTURE_PHASE_NODE_MARKER: phaseMarker,
      };
      const toolchain = resolveVerificationToolchain({
        nodeExecutable: process.execPath,
        env,
      });
      const collectProvenance = () => ({
        ...worktreeProvenance(worktree, 'node24-parent-toolchain'),
        toolchain: toolchain.toolchain,
        toolchainIdentity: toolchain.identity,
      });

      const result = await coordinateVerification({
        laneId: 'prepush',
        root: temp.root,
        cwd: worktree,
        collectProvenance,
        toolchain,
        env,
        hostCpuSampler: healthySampler(),
      });

      expect(result.receipt.terminal.passed).toBe(true);
      expect(result.receipt.provenance.before.toolchainIdentity).toEqual(
        toolchain.identity,
      );
      expect(existsSync(ambientMarker)).toBe(false);
      expect(readFileSync(phaseMarker, 'utf8')).toBe(toolchain.nodeExecutable);
    } finally {
      temp.remove();
    }
  });

  test('aggregates successful full-regression stderr from every phase', async () => {
    const temp = fixture();
    const worktree = join(temp.root, 'worktree');
    mkdirSync(worktree);
    try {
      const result = await coordinateVerification({
        laneId: 'full-regression',
        root: temp.root,
        cwd: worktree,
        collectProvenance: () => worktreeProvenance(worktree, 'phase-stderr'),
        hostCpuSampler: healthySampler(),
        heartbeatMs: 1,
        phaseRunner: async ({ phase }: { phase: { id: string } }) => ({
          status: 0,
          output: {
            stdout: { text: `out:${phase.id}` },
            stderr: { text: `err:${phase.id}` },
          },
        }),
      });
      expect(result.receipt.terminal.passed).toBe(true);
      const stderr = result.receipt.artifacts.find((artifact) =>
        artifact.path.includes('/stderr-'),
      );
      expect(stderr).toBeDefined();
      const text = readFileSync(join(worktree, stderr!.path), 'utf8');
      for (const id of [
        'repo-governance',
        'sdk-builds',
        'verify-static',
        ...ORDINARY_FULL_PHASE_IDS,
        'test-full-process-heavy',
        'test-full-process-exclusive',
        'test-full-coordinator-exclusive',
        'test-full-credential-ledger-exclusive',
        'test-full-shared-output',
        'test-full-dogfood-reconcile',
        'app-builds',
      ])
        expect(text).toContain(`err:${id}`);
    } finally {
      temp.remove();
    }
  });

  test.each([
    ['truncated', { truncated: true }],
    ['invalid UTF-8', { invalidUtf8: true }],
  ])(
    'retries a full-regression phase with %s output instead of checkpointing it',
    async (_name, integrity) => {
      const temp = fixture();
      const worktree = join(temp.root, 'worktree');
      mkdirSync(worktree);
      const calls: string[] = [];
      let attempt = 0;
      const options = {
        laneId: 'full-regression',
        root: temp.root,
        cwd: worktree,
        collectProvenance: () =>
          worktreeProvenance(worktree, `phase-integrity-${_name}`),
        hostCpuSampler: healthySampler(),
        heartbeatMs: 1,
        phaseRunner: async ({ phase }: { phase: { id: string } }) => {
          calls.push(`${attempt}:${phase.id}`);
          return {
            status: 0,
            output: {
              stdout: { text: 'ok' },
              stderr: { text: '' },
              ...(attempt === 0 ? integrity : {}),
            },
          };
        },
      };
      try {
        const first = await coordinateVerification(options);
        expect(first.receipt.terminal.passed).toBe(false);
        expect(first.receipt.terminal.status).toBe('infrastructure_error');
        expect(calls).toEqual(['0:repo-governance']);

        attempt = 1;
        const retried = await coordinateVerification(options);
        expect(retried.receipt.terminal.passed).toBe(true);
        expect(calls).toEqual([
          '0:repo-governance',
          '1:repo-governance',
          '1:sdk-builds',
          '1:verify-static',
          ...ORDINARY_FULL_PHASE_IDS.map((id) => `1:${id}`),
          '1:test-full-process-heavy',
          '1:test-full-process-exclusive',
          '1:test-full-coordinator-exclusive',
          '1:test-full-credential-ledger-exclusive',
          '1:test-full-shared-output',
          '1:test-full-dogfood-reconcile',
          '1:app-builds',
        ]);
      } finally {
        temp.remove();
      }
    },
  );

  test('retries a full-regression phase with failed cleanup instead of checkpointing it', async () => {
    const temp = fixture();
    const worktree = join(temp.root, 'worktree');
    mkdirSync(worktree);
    const calls: string[] = [];
    let attempt = 0;
    const options = {
      laneId: 'full-regression',
      root: temp.root,
      cwd: worktree,
      collectProvenance: () =>
        worktreeProvenance(worktree, 'phase-cleanup-checkpoint'),
      hostCpuSampler: healthySampler(),
      heartbeatMs: 1,
      phaseRunner: async ({ phase }: { phase: { id: string } }) => {
        calls.push(`${attempt}:${phase.id}`);
        return {
          status: 0,
          ...(attempt === 0
            ? { cleanup: { status: 'failed', survivingOwnedChildren: 1 } }
            : {}),
        };
      },
    };
    try {
      const first = await coordinateVerification(options);
      expect(first.receipt.terminal).toMatchObject({
        status: 'completed',
        passed: false,
      });
      expect(calls).toEqual(['0:repo-governance']);

      attempt = 1;
      const retried = await coordinateVerification(options);
      expect(retried.receipt.terminal.passed).toBe(true);
      expect(calls).toEqual([
        '0:repo-governance',
        '1:repo-governance',
        '1:sdk-builds',
        '1:verify-static',
        ...ORDINARY_FULL_PHASE_IDS.map((id) => `1:${id}`),
        '1:test-full-process-heavy',
        '1:test-full-process-exclusive',
        '1:test-full-coordinator-exclusive',
        '1:test-full-credential-ledger-exclusive',
        '1:test-full-shared-output',
        '1:test-full-dogfood-reconcile',
        '1:app-builds',
      ]);
    } finally {
      temp.remove();
    }
  });

  test('retries a valid-JSON checkpoint whose output and cleanup shapes are incomplete', async () => {
    const temp = fixture();
    const worktree = join(temp.root, 'worktree');
    mkdirSync(worktree);
    const executedPhases: string[] = [];
    const options = {
      laneId: 'full-regression',
      root: temp.root,
      cwd: worktree,
      collectProvenance: () =>
        worktreeProvenance(worktree, 'malformed-phase-checkpoint'),
      hostCpuSampler: healthySampler(),
      heartbeatMs: 1,
      phaseRunner: async ({ phase }: { phase: { id: string } }) => {
        executedPhases.push(phase.id);
        return { status: 0 };
      },
    };
    try {
      const first = await coordinateVerification(options);
      expect(first.receipt.terminal.passed).toBe(true);
      expect(executedPhases).toHaveLength(18);

      const path = join(
        worktree,
        '.kontourai',
        'verification-phase-records',
        first.request.key,
        'repo-governance.json',
      );
      const record = JSON.parse(readFileSync(path, 'utf8'));
      record.output = {};
      record.cleanup = {};
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);

      executedPhases.length = 0;
      const retried = await coordinateVerification({ ...options, force: true });
      expect(retried.receipt.terminal.passed).toBe(true);
      expect(executedPhases).toEqual(['repo-governance']);
    } finally {
      temp.remove();
    }
  });

  test('reports a full-regression phase capacity deadline as timed_out', async () => {
    const temp = fixture();
    const ciWorktree = join(temp.root, 'ci');
    const blockingWorktree = join(temp.root, 'blocking');
    mkdirSync(ciWorktree);
    mkdirSync(blockingWorktree);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let clock = 10_000;
    const now = () => clock;
    const wait = async (ms: number) => {
      clock += ms;
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    const sample = () =>
      buildHostPressureSample({
        busyPercent: 40,
        cpuCount: 4,
        sampleMs: 1,
        sampledAt: now(),
        threshold: 85,
        source: 'override',
      });
    try {
      const blocking = coordinateVerification({
        laneId: 'prepush',
        root: temp.root,
        cwd: blockingWorktree,
        capacity: 100,
        heartbeatMs: 1,
        collectProvenance: () =>
          worktreeProvenance(blockingWorktree, 'phase-deadline-blocker'),
        runner: async () => {
          await blocked;
          return { status: 0 };
        },
      });
      await waitFor(() =>
        verificationStatus({ root: temp.root }).jobs.some(
          (job) => job.state === 'running' && job.weight === 40,
        ),
      );
      const timedOut = await coordinateVerification({
        laneId: 'full-regression',
        root: temp.root,
        cwd: ciWorktree,
        capacity: 100,
        heartbeatMs: 1,
        timeoutMs: 60,
        now,
        wait,
        collectProvenance: () =>
          worktreeProvenance(ciWorktree, 'phase-deadline'),
        hostCpuSampler: async () => sample(),
        phaseRunner: async () => ({ status: 0 }),
      });
      expect(timedOut.receipt.terminal.status).toBe('timed_out');
      expect(timedOut.receipt.terminal.passed).toBe(false);
      release();
      await blocking;
    } finally {
      temp.remove();
    }
  });

  test('times out a hung full-regression phase, retains cleanup truth, and releases capacity', async () => {
    const temp = fixture();
    const worktree = join(temp.root, 'completion');
    const nextWorktree = join(temp.root, 'next');
    mkdirSync(worktree);
    mkdirSync(nextWorktree);
    let clock = 10_000;
    const phases: string[] = [];
    try {
      const timedOut = await coordinateVerification({
        laneId: 'full-regression',
        root: temp.root,
        cwd: worktree,
        heartbeatMs: 1,
        now: () => clock,
        collectProvenance: () =>
          worktreeProvenance(worktree, 'hung-completion-phase'),
        hostCpuSampler: async () =>
          buildHostPressureSample({
            busyPercent: 40,
            cpuCount: 4,
            sampleMs: 1,
            sampledAt: clock,
            threshold: 85,
            source: 'override',
          }),
        phaseRunner: async ({
          phase,
          signal,
        }: {
          phase: { id: string; timeoutMs: number };
          signal: AbortSignal;
        }) => {
          phases.push(phase.id);
          if (phase.id !== ORDINARY_FULL_PHASE_IDS[0]) return { status: 0 };
          // Advance after the phase deadline was captured, then wait for the
          // coordinator's timeout signal as an owned hung-child stand-in.
          clock += phase.timeoutMs;
          return new Promise((resolve) =>
            signal.addEventListener(
              'abort',
              () =>
                resolve({
                  status: null,
                  signal: 'SIGTERM',
                  cleanup: { status: 'passed', survivingOwnedChildren: 0 },
                }),
              { once: true },
            ),
          );
        },
      });
      expect(phases).toEqual([
        'repo-governance',
        'sdk-builds',
        'verify-static',
        ORDINARY_FULL_PHASE_IDS[0],
      ]);
      expect(timedOut.receipt.terminal).toMatchObject({
        status: 'timed_out',
        passed: false,
      });
      expect(timedOut.receipt.cleanup).toEqual({
        status: 'passed',
        survivingOwnedChildren: 0,
      });
      expect(
        verificationStatus({ root: temp.root, now: clock }).usedWeight,
      ).toBe(0);

      const next = await coordinateVerification({
        laneId: 'ci-fast',
        root: temp.root,
        cwd: nextWorktree,
        collectProvenance: () =>
          worktreeProvenance(nextWorktree, 'after-hung-phase'),
        runner: async () => ({ status: 0 }),
      });
      // `passed` is not earnable here — see the note on the first ci:fast
      // admission assertion in this file (#1727 / station#1738).
      expect(next.disposition).toBe('executed');
    } finally {
      temp.remove();
    }
  });

  wslQuarantinedTest(
    'does not extend a phase execution deadline on fresh heartbeats',
    async () => {
      const temp = fixture();
      const worktree = join(temp.root, 'heartbeat-deadline');
      mkdirSync(worktree);
      let observed:
        | ReturnType<typeof verificationStatus>['jobs'][number]
        | undefined;
      try {
        const result = await coordinateVerification({
          laneId: 'full-regression',
          root: temp.root,
          cwd: worktree,
          timeoutMs: 500,
          heartbeatMs: 1,
          collectProvenance: () =>
            worktreeProvenance(worktree, 'heartbeat-without-progress'),
          phaseRunner: async ({ signal }: { signal: AbortSignal }) => {
            const aborted = new Promise<{
              status: null;
              signal: 'SIGTERM';
              cleanup: { status: 'passed'; survivingOwnedChildren: 0 };
            }>((resolve) =>
              signal.addEventListener(
                'abort',
                () =>
                  resolve({
                    status: null,
                    signal: 'SIGTERM',
                    cleanup: {
                      status: 'passed',
                      survivingOwnedChildren: 0,
                    },
                  }),
                { once: true },
              ),
            );
            await new Promise((resolve) => setTimeout(resolve, 15));
            observed = verificationStatus({ root: temp.root }).jobs[0];
            return aborted;
          },
        });
        expect(observed).toBeDefined();
        expect(observed!.heartbeatAt).toBeGreaterThan(
          observed!.phase?.executionStartedAt ?? 0,
        );
        expect(observed!.phase).toMatchObject({
          id: 'repo-governance',
          executionDeadlineAt: observed!.deadlineAt,
        });
        expect(result.receipt.terminal).toMatchObject({
          status: 'timed_out',
          passed: false,
        });
        expect(result.receipt.counts).toMatchObject({
          infrastructureErrors: 1,
          passed: 0,
        });
        expect(result.receipt.cleanup).toEqual({
          status: 'passed',
          survivingOwnedChildren: 0,
        });
        expect(result.summary.artifacts.length).toBeLessThanOrEqual(3);
      } finally {
        temp.remove();
      }
    },
  );

  wslQuarantinedTest(
    'waits for an early-return orphan process group before releasing capacity',
    async () => {
      const temp = fixture();
      const worktree = join(temp.root, 'orphan-owner');
      const nextWorktree = join(temp.root, 'after-orphan');
      mkdirSync(worktree);
      mkdirSync(nextWorktree);
      let childLease: { child?: { pgid?: number | null } } = {};
      const orphanRunner = ({ signal }: { signal: AbortSignal }) =>
        createOwnedRunner({
          lane: { id: 'orphan-fixture' },
          worktree,
          outputLock: join(temp.root, 'unused-output-lock'),
          owner: { nonce: 'orphan-fixture' },
          outputOwned: false,
          now: Date.now,
          currentLease: () => childLease,
          updateLease: (next: typeof childLease) => {
            childLease = next;
            return true;
          },
          privateCommand: () => [
            process.execPath,
            [
              '--input-type=module',
              '--eval',
              "import { spawn } from 'node:child_process'; const child = spawn(process.execPath, ['--eval', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)\"], { stdio: 'ignore' }); child.unref(); process.exit(0);",
            ],
          ],
          processIdentity: () => null,
          writeOwnedLease: () => true,
          terminationGraceMs: 25,
          terminationForceMs: 25,
        })({ signal });
      try {
        const orphaned = await coordinateVerification({
          laneId: 'test-full',
          root: temp.root,
          cwd: worktree,
          heartbeatMs: 1,
          timeoutMs: 500,
          collectProvenance: () =>
            worktreeProvenance(worktree, 'early-return-orphan'),
          hostCpuSampler: healthySampler(),
          runner: orphanRunner,
        });
        expect(childLease.child?.pgid).toEqual(expect.any(Number));
        expect(orphaned.receipt.cleanup).toEqual({
          status: 'passed',
          survivingOwnedChildren: 0,
        });
        expect(processGroupIsLive(childLease.child?.pgid)).toBe(false);

        const next = await coordinateVerification({
          laneId: 'test-changed',
          root: temp.root,
          cwd: nextWorktree,
          collectProvenance: () =>
            worktreeProvenance(nextWorktree, 'after-early-return-orphan'),
          runner: async () => ({ status: 0 }),
        });
        expect(next.receipt.terminal.passed).toBe(true);
      } finally {
        temp.remove();
      }
    },
  );

  test('reserves capacity for a queued full-weight lane while allowing ci:fast overlap', async () => {
    const temp = fixture();
    const blockingWorktree = join(temp.root, 'blocking');
    const e2eWorktree = join(temp.root, 'e2e');
    const ordinaryWorktree = join(temp.root, 'ordinary');
    const fastWorktree = join(temp.root, 'fast');
    const lateFastWorktrees = [
      join(temp.root, 'late-fast-1'),
      join(temp.root, 'late-fast-2'),
      join(temp.root, 'late-fast-3'),
    ];
    for (const worktree of [
      blockingWorktree,
      e2eWorktree,
      ordinaryWorktree,
      fastWorktree,
      ...lateFastWorktrees,
    ])
      mkdirSync(worktree);
    let releaseBlocking!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseBlocking = resolve;
    });
    let e2eCalls = 0;
    let ordinaryCalls = 0;
    let fastCalls = 0;
    let clock = 10_000;
    const samplerAtClock = healthySampler(40, () => clock);
    // Admission retries are part of the state machine under test, but elapsed
    // wall time is not. Yield to the other coordinators without spending real
    // milliseconds per retry so host contention cannot consume Vitest's test
    // deadline before the asserted queue transitions settle.
    const yieldForAdmission = () =>
      new Promise<void>((resolve) => setImmediate(resolve));
    try {
      const blocking = coordinateVerification({
        laneId: 'test-full',
        root: temp.root,
        cwd: blockingWorktree,
        heartbeatMs: 1,
        now: () => clock,
        wait: yieldForAdmission,
        collectProvenance: () =>
          worktreeProvenance(blockingWorktree, 'full-weight-blocker'),
        hostCpuSampler: samplerAtClock,
        runner: async () => {
          await blocked;
          return { status: 0 };
        },
      });
      await waitFor(() =>
        verificationStatus({ root: temp.root }).jobs.some(
          (job) => job.state === 'running' && job.weight === 80,
        ),
      );

      const e2e = coordinateVerification({
        laneId: 'verify-e2e-full',
        root: temp.root,
        cwd: e2eWorktree,
        heartbeatMs: 1,
        now: () => clock,
        wait: yieldForAdmission,
        collectProvenance: () =>
          worktreeProvenance(e2eWorktree, 'full-weight-waiter'),
        hostCpuSampler: samplerAtClock,
        runner: async () => {
          e2eCalls += 1;
          return { status: 1 };
        },
      });
      await waitFor(() =>
        verificationStatus({ root: temp.root }).jobs.some(
          (job) => job.state === 'queued' && job.weight === 100,
        ),
      );

      const ordinary = coordinateVerification({
        laneId: 'test-changed',
        root: temp.root,
        cwd: ordinaryWorktree,
        heartbeatMs: 1,
        now: () => clock,
        wait: yieldForAdmission,
        collectProvenance: () =>
          worktreeProvenance(ordinaryWorktree, 'ordinary-behind-e2e'),
        runner: async () => {
          ordinaryCalls += 1;
          return { status: 0 };
        },
      });
      await waitFor(() =>
        verificationStatus({ root: temp.root }).jobs.some(
          (job) =>
            job.state === 'queued' &&
            job.queueReason === 'full_weight_fairness',
        ),
      );
      expect(ordinaryCalls).toBe(0);

      const fast = await coordinateVerification({
        laneId: 'ci-fast',
        root: temp.root,
        cwd: fastWorktree,
        heartbeatMs: 1,
        now: () => clock,
        wait: yieldForAdmission,
        collectProvenance: () =>
          worktreeProvenance(fastWorktree, 'fast-feedback-overlap'),
        runner: async () => {
          fastCalls += 1;
          return { status: 0 };
        },
      });
      // `passed` is not earnable here — see the note on the first ci:fast
      // admission assertion in this file (#1727 / station#1738).
      expect(fast.disposition).toBe('executed');
      expect(fastCalls).toBe(1);
      expect(ordinaryCalls).toBe(0);

      // Age the queued 100-unit request without waiting in real time. New
      // ci:fast arrivals now yield, so a sustained fast-feedback stream has a
      // finite effect on the completion/E2E wait.
      clock += FULL_WEIGHT_CI_FAST_BYPASS_MS + 1_000;
      const lateFast = lateFastWorktrees.map((cwd, index) =>
        coordinateVerification({
          laneId: 'ci-fast',
          root: temp.root,
          cwd,
          heartbeatMs: 1,
          now: () => clock,
          wait: yieldForAdmission,
          collectProvenance: () =>
            worktreeProvenance(cwd, `late-fast-${index}`),
          runner: async () => {
            fastCalls += 1;
            return { status: 0 };
          },
        }),
      );
      await waitFor(
        () =>
          verificationStatus({ root: temp.root }).jobs.filter(
            (job) =>
              lateFastWorktrees.includes(job.worktree) &&
              job.state === 'queued' &&
              job.queueReason === 'full_weight_fairness',
          ).length === lateFastWorktrees.length,
      );
      expect(fastCalls).toBe(1);

      releaseBlocking();
      const [blockingResult, e2eResult, ordinaryResult, ...lateFastResults] =
        await Promise.all([blocking, e2e, ordinary, ...lateFast]);
      expect(blockingResult.receipt.terminal.passed).toBe(true);
      expect(e2eResult.receipt.terminal.passed).toBe(false);
      expect(ordinaryResult.receipt.terminal.passed).toBe(true);
      expect(e2eCalls).toBe(1);
      expect(ordinaryCalls).toBe(1);
      // `passed` is not earnable here — see the note on the first ci:fast
      // admission assertion in this file (#1727 / station#1738).
      expect(
        lateFastResults.every((result) => result.disposition === 'executed'),
      ).toBe(true);
      expect(fastCalls).toBe(4);
    } finally {
      temp.remove();
    }
  });

  test('breaks the 80-before-100 healthy-host fairness cycle and makes forward progress', async () => {
    const temp = fixture();
    const completionWorktree = join(temp.root, 'completion-80');
    const e2eWorktree = join(temp.root, 'e2e-100');
    mkdirSync(completionWorktree);
    mkdirSync(e2eWorktree);
    let healthy = false;
    let e2eCalls = 0;
    const sampler = async () =>
      healthy
        ? buildHostPressureSample({
            busyPercent: 40,
            cpuCount: 4,
            sampleMs: 1,
            sampledAt: Date.now(),
            threshold: 85,
            source: 'override',
            load1: 1,
            loadPerCpu: 0.25,
          })
        : ({ status: 'unavailable' } as const);
    try {
      const completion = coordinateVerification({
        laneId: 'full-regression',
        root: temp.root,
        cwd: completionWorktree,
        heartbeatMs: 1,
        timeoutMs: 5_000,
        hostPressureWaitMs: 4_000,
        hostCpuSampler: sampler,
        collectProvenance: () =>
          worktreeProvenance(completionWorktree, 'fairness-cycle-80'),
        phaseRunner: async () => ({ status: 0 }),
      });
      await waitFor(() =>
        verificationStatus({ root: temp.root }).jobs.some(
          (job) =>
            job.phase?.id === ORDINARY_FULL_PHASE_IDS[0] &&
            job.state === 'queued',
        ),
      );
      const e2e = coordinateVerification({
        laneId: 'verify-e2e-full',
        root: temp.root,
        cwd: e2eWorktree,
        heartbeatMs: 1,
        timeoutMs: 5_000,
        hostPressureWaitMs: 4_000,
        hostCpuSampler: sampler,
        collectProvenance: () =>
          worktreeProvenance(e2eWorktree, 'fairness-cycle-100'),
        runner: async () => {
          e2eCalls += 1;
          // The fixture does not materialize verify-e2e-full's reusable
          // output binding. A deliberate test failure still proves admission
          // and avoids fabricating a passing reusable receipt.
          return { status: 1 };
        },
      });
      await waitFor(
        () => verificationStatus({ root: temp.root }).waiting === 2,
      );
      healthy = true;
      const [completionResult, e2eResult] = await Promise.all([
        completion,
        e2e,
      ]);
      expect(e2eCalls).toBe(1);
      expect(e2eResult.disposition).toBe('executed');
      expect(e2eResult.receipt.terminal.passed).toBe(false);
      expect(completionResult.receipt.terminal.passed).toBe(true);
    } finally {
      temp.remove();
    }
  });

  wslQuarantinedTest(
    'reports a bounded healthy-idle queue diagnostic with exact blockers',
    () => {
      const temp = fixture();
      const requests = join(temp.root, 'requests');
      const keys = [
        canonicalRequestKey('healthy-idle-80'),
        canonicalRequestKey('healthy-idle-100'),
      ];
      try {
        for (const [index, key] of keys.entries()) {
          const directory = join(requests, key);
          mkdirSync(directory, { recursive: true });
          writeFileSync(
            join(directory, 'lease.json'),
            JSON.stringify({
              request: { key },
              owner: {
                pid: process.pid,
                processStart: nativeProcessStart(process.pid),
                nonce: `healthy-idle-${index}`,
              },
              state: 'queued',
              weight: index === 0 ? 80 : 100,
              capacity: 100,
              createdAt: 5_000 + index,
              heartbeatAt: Date.now(),
              generation: `healthy-idle-${index}`,
              hostPressure: { status: 'healthy' },
              queueReason:
                index === 0 ? 'full_weight_fairness' : 'host_pressure_fifo',
              blockingRequestKey: keys[index === 0 ? 1 : 0],
            }),
          );
        }
        expect(verificationStatus({ root: temp.root }).noProgress).toEqual({
          reason: 'healthy_idle_queue',
          blockers: keys.map((key, index) => ({
            requestKey: key,
            queueReason:
              index === 0 ? 'full_weight_fairness' : 'host_pressure_fifo',
            blockingRequestKey: keys[index === 0 ? 1 : 0],
          })),
          truncated: false,
        });
        const secondLeasePath = join(requests, keys[1], 'lease.json');
        const secondLease = JSON.parse(readFileSync(secondLeasePath, 'utf8'));
        delete secondLease.hostPressure;
        writeFileSync(secondLeasePath, JSON.stringify(secondLease));
        expect(
          verificationStatus({ root: temp.root }).noProgress,
        ).toBeUndefined();
      } finally {
        temp.remove();
      }
    },
  );

  test('uses ci:fast lane’s twelve-minute deadline when no override is supplied', async () => {
    const temp = fixture();
    const worktree = join(temp.root, 'fast');
    mkdirSync(worktree);
    const originalSetTimeout = globalThis.setTimeout;
    const deadlines: number[] = [];
    const timer = vi
      .spyOn(globalThis, 'setTimeout')
      .mockImplementation((callback, delay, ...args) => {
        deadlines.push(Number(delay));
        return originalSetTimeout(callback, delay, ...args);
      });
    try {
      const result = await coordinateVerification({
        laneId: 'ci-fast',
        root: temp.root,
        cwd: worktree,
        now: () => 10_000,
        collectProvenance: () => worktreeProvenance(worktree, 'fast-deadline'),
        hostCpuSampler: healthySampler(),
        runner: async () => ({ status: 0 }),
      });
      // `passed` is not earnable here — see the note on the first ci:fast
      // admission assertion in this file (#1727 / station#1738).
      expect(result.disposition).toBe('executed');
      expect(deadlines).toContain(12 * 60_000);
    } finally {
      timer.mockRestore();
      temp.remove();
    }
  });

  test('joins the owner failure rather than launching a second child', async () => {
    const temp = fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolvePending) => {
      release = resolvePending;
    });
    let calls = 0;
    const options = {
      laneId: 'prepush',
      root: temp.root,
      heartbeatMs: 1,
      collectProvenance: () => provenance(`failed-${temp.root}`),
      runner: async () => {
        calls += 1;
        await pending;
        return { status: 1 };
      },
    };
    try {
      const owner = coordinateVerification(options);
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      const joiner = coordinateVerification(options);
      release();
      const [first, second] = await Promise.all([owner, joiner]);
      expect(calls).toBe(1);
      expect([first.disposition, second.disposition]).toContain('joined');
      expect(second.receipt.terminal.passed).toBe(false);
    } finally {
      temp.remove();
    }
  });

  test('times out distinctly from cancellation and treats unexpected child signals as infrastructure errors', async () => {
    const temp = fixture();
    try {
      const timeout = await coordinateVerification({
        laneId: 'prepush',
        root: temp.root,
        timeoutMs: 5,
        collectProvenance: () => provenance(`timeout-${temp.root}`),
        runner: async ({ signal }: { signal: AbortSignal }) =>
          new Promise((_, reject) =>
            signal.addEventListener('abort', () =>
              reject(new Error('stopped')),
            ),
          ),
      });
      const crash = await coordinateVerification({
        laneId: 'prepush',
        root: temp.root,
        collectProvenance: () => provenance(`crash-${temp.root}`),
        runner: async () => ({ status: null, signal: 'SIGSEGV' }),
      });
      expect(timeout.receipt.terminal.status).toBe('timed_out');
      expect(crash.receipt.terminal.status).toBe('infrastructure_error');
    } finally {
      temp.remove();
    }
  });

  test('never rounds a cleanup failure into a reusable pass', async () => {
    const temp = fixture();
    try {
      const result = await coordinateVerification({
        laneId: 'prepush',
        root: temp.root,
        collectProvenance: () => provenance(`cleanup-${temp.root}`),
        runner: async () => ({
          status: 0,
          cleanup: { status: 'failed', survivingOwnedChildren: 1 },
        }),
      });
      expect(result.receipt.terminal).toMatchObject({
        status: 'completed',
        passed: false,
      });
    } finally {
      temp.remove();
    }
  });

  test('publishes initialized leases atomically and quarantines stale owners', () => {
    const temp = fixture();
    const directory = join(temp.root, 'requests', 'atomic');
    const owner = { pid: 123, processStart: 'old', nonce: 'first' };
    const lease = { owner, state: 'running', heartbeatAt: 1, weight: 1 };
    try {
      expect(
        __verificationCoordinatorInternals.acquireLeaseDirectory(
          directory,
          lease,
        ),
      ).toBe(true);
      expect(
        JSON.parse(readFileSync(join(directory, 'lease.json'), 'utf8')),
      ).toMatchObject(lease);
      expect(
        __verificationCoordinatorInternals.acquireLeaseDirectory(directory, {
          ...lease,
          owner: { ...owner, nonce: 'second' },
        }),
      ).toBe(false);
      expect(
        __verificationCoordinatorInternals.cleanStaleDirectory(directory, {
          now: 100,
          staleMs: 1,
          processIdentityFn: () => null,
        }),
      ).toBe(true);
      expect(existsSync(directory)).toBe(false);
      expect(
        __verificationCoordinatorInternals.acquireLeaseDirectory(directory, {
          ...lease,
          owner: { ...owner, nonce: 'second' },
        }),
      ).toBe(true);
    } finally {
      temp.remove();
    }
  });

  test('an old heartbeat cannot recreate or overwrite a recovered successor', () => {
    const temp = fixture();
    const directory = join(temp.root, 'requests', 'successor');
    const oldOwner = { pid: 42, processStart: 'old', nonce: 'old' };
    const oldLease = { owner: oldOwner, state: 'running', heartbeatAt: 1 };
    const successor = {
      owner: { pid: process.pid, processStart: null, nonce: 'successor' },
      state: 'running',
      heartbeatAt: 2,
    };
    try {
      expect(
        __verificationCoordinatorInternals.acquireLeaseDirectory(
          directory,
          oldLease,
        ),
      ).toBe(true);
      expect(
        __verificationCoordinatorInternals.cleanStaleDirectory(directory, {
          now: 100,
          staleMs: 1,
          processIdentityFn: () => null,
        }),
      ).toBe(true);
      expect(
        __verificationCoordinatorInternals.acquireLeaseDirectory(
          directory,
          successor,
        ),
      ).toBe(true);
      expect(
        __verificationCoordinatorInternals.writeOwnedLease(
          directory,
          oldOwner,
          {
            ...oldLease,
            heartbeatAt: 101,
          },
        ),
      ).toBe(false);
      expect(
        JSON.parse(readFileSync(join(directory, 'lease.json'), 'utf8')),
      ).toMatchObject(successor);
    } finally {
      temp.remove();
    }
  });

  test('releases an owned directory through one never-reused quarantine and preserves a successor after cleanup residue', () => {
    const temp = fixture();
    const directory = join(temp.root, 'scheduler.lock');
    const owner = {
      pid: process.pid,
      processStart: nativeProcessStart(process.pid),
      nonce: randomUUID(),
    };
    const successor = {
      owner: { ...owner, nonce: randomUUID() },
      state: 'scheduler',
      heartbeatAt: Date.now(),
    };
    try {
      expect(
        __verificationCoordinatorInternals.acquireLeaseDirectory(directory, {
          owner,
          state: 'scheduler',
          heartbeatAt: Date.now(),
        }),
      ).toBe(true);
      const outcome =
        __verificationCoordinatorInternals.createOwnedDirectoryRemover({
          removeDirectory: (target: string) => {
            expect(target).toMatch(/scheduler\.lock\.remove-[0-9a-f-]+$/);
            expect(
              __verificationCoordinatorInternals.acquireLeaseDirectory(
                directory,
                successor,
              ),
            ).toBe(true);
            throw Object.assign(new Error('busy cleanup'), { code: 'EBUSY' });
          },
        })(directory, owner);
      expect(outcome).toMatchObject({ kind: 'released-with-residue' });
      expect(
        JSON.parse(readFileSync(join(directory, 'lease.json'), 'utf8')),
      ).toMatchObject(successor);
      expect(
        __verificationCoordinatorInternals.removeOwnedDirectory(
          directory,
          owner,
        ),
      ).toBe(false);
    } finally {
      temp.remove();
    }
  });

  wslQuarantinedTest(
    'request cleanup residue is undiscovered and releases capacity to its successor',
    () => {
      const temp = fixture();
      const key = 'a'.repeat(64);
      const directory = join(temp.root, 'requests', key);
      const owner = {
        pid: process.pid,
        processStart: nativeProcessStart(process.pid),
        nonce: randomUUID(),
      };
      const successor = {
        owner: { ...owner, nonce: randomUUID() },
        state: 'running',
        heartbeatAt: Date.now(),
        weight: 20,
        capacity: 100,
      };
      try {
        expect(
          __verificationCoordinatorInternals.acquireLeaseDirectory(directory, {
            ...successor,
            owner,
          }),
        ).toBe(true);
        expect(
          __verificationCoordinatorInternals.createOwnedDirectoryRemover({
            removeDirectory: () => {
              expect(
                __verificationCoordinatorInternals.acquireLeaseDirectory(
                  directory,
                  successor,
                ),
              ).toBe(true);
              throw Object.assign(new Error('busy'), { code: 'ENOTEMPTY' });
            },
          })(directory, owner),
        ).toMatchObject({ kind: 'released-with-residue' });
        const status = verificationStatus({ root: temp.root });
        expect(status.jobs).toHaveLength(1);
        expect(status.jobs[0]).toMatchObject({ key, owner: successor.owner });
        expect(status.usedWeight).toBe(20);
      } finally {
        temp.remove();
      }
    },
  );

  test('same-parent quarantine never consults a symlinked former cleanup path', () => {
    const temp = fixture();
    const directory = join(temp.root, 'scheduler.lock');
    const outside = join(temp.root, 'outside');
    const owner = {
      pid: process.pid,
      processStart: nativeProcessStart(process.pid),
      nonce: randomUUID(),
    };
    try {
      mkdirSync(outside);
      symlinkSync(outside, join(temp.root, '.owned-cleanup'));
      expect(
        __verificationCoordinatorInternals.acquireLeaseDirectory(directory, {
          owner,
          state: 'scheduler',
          heartbeatAt: Date.now(),
        }),
      ).toBe(true);
      expect(
        __verificationCoordinatorInternals.createOwnedDirectoryRemover({
          removeDirectory: (target: string, options: object) => {
            expect(target).toMatch(/scheduler\.lock\.remove-[0-9a-f-]+$/);
            expect(target.startsWith(`${temp.root}/`)).toBe(true);
            expect(target.startsWith(`${outside}/`)).toBe(false);
            rmSync(target, { recursive: true, force: true, ...options });
          },
        })(directory, owner),
      ).toMatchObject({ kind: 'released' });
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      temp.remove();
    }
  });

  test('excludes malformed force keys and residues from status and finished-lease GC', () => {
    const temp = fixture();
    const canonical = canonicalRequestKey('canonical-key');
    const malformed = [
      `${canonical}.force-${'-'.repeat(36)}`,
      `${canonical}.force-${'a'.repeat(36)}`,
      `${canonical}.force-${'a'.repeat(8)}${'b'.repeat(4)}-${'c'.repeat(4)}-${'d'.repeat(4)}-${'e'.repeat(12)}`,
      `${canonical.toUpperCase()}.force-12345678-1234-1234-1234-123456789abc`,
      `${canonical}.remove-12345678-1234-1234-1234-123456789abc`,
    ];
    try {
      for (const name of malformed) {
        const directory = join(temp.root, 'requests', name);
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, 'lease.json'),
          JSON.stringify({
            owner: { pid: 999999, processStart: 'gone', nonce: randomUUID() },
            state: 'finished',
            heartbeatAt: 0,
            finishedAt: 0,
          }),
        );
      }
      __verificationCoordinatorInternals.gcFinishedLeases(temp.root, {
        now: Date.now() + 10 * 60_000,
      });
      // Production creates only a SHA-256 execution key, optionally followed
      // by randomUUID() for a forced run. Discovery deliberately recognizes
      // that grammar and treats every other sibling as residue or unknown.
      expect(verificationStatus({ root: temp.root }).jobs).toEqual([]);
      for (const name of malformed)
        expect(existsSync(join(temp.root, 'requests', name))).toBe(true);
    } finally {
      temp.remove();
    }
  });

  test('totalizes a mutation Adapter throw without touching the canonical directory', () => {
    const temp = fixture();
    const directory = join(temp.root, 'scheduler.lock');
    const owner = {
      pid: process.pid,
      processStart: nativeProcessStart(process.pid),
      nonce: randomUUID(),
    };
    try {
      expect(
        __verificationCoordinatorInternals.acquireLeaseDirectory(directory, {
          owner,
          state: 'scheduler',
          heartbeatAt: Date.now(),
        }),
      ).toBe(true);
      expect(
        __verificationCoordinatorInternals.createOwnedDirectoryRemover({
          acquireMutation: () => {
            throw new Error('mutation filesystem fault');
          },
        })(directory, owner),
      ).toMatchObject({ kind: 'indeterminate' });
      expect(existsSync(directory)).toBe(true);
      expect(existsSync(join(directory, '.mutation'))).toBe(false);
    } finally {
      temp.remove();
    }
  });

  test('a contending remover sees non-owner after the first atomic release', () => {
    const temp = fixture();
    const directory = join(temp.root, 'scheduler.lock');
    const owner = {
      pid: process.pid,
      processStart: nativeProcessStart(process.pid),
      nonce: randomUUID(),
    };
    try {
      expect(
        __verificationCoordinatorInternals.acquireLeaseDirectory(directory, {
          owner,
          state: 'scheduler',
          heartbeatAt: Date.now(),
        }),
      ).toBe(true);
      let second: { kind: string } | undefined;
      const first =
        __verificationCoordinatorInternals.createOwnedDirectoryRemover({
          removeDirectory: (target: string, options: object) => {
            second =
              __verificationCoordinatorInternals.removeOwnedDirectoryOutcome(
                directory,
                owner,
              );
            rmSync(target, { recursive: true, force: true, ...options });
          },
        })(directory, owner);
      expect(first).toMatchObject({ kind: 'released' });
      expect(second).toMatchObject({ kind: 'not-owner' });
      expect(existsSync(directory)).toBe(false);
    } finally {
      temp.remove();
    }
  });

  test.each(['EBUSY', 'ENOTEMPTY', 'EPERM'])(
    'maps isolated %s cleanup failure to released-with-residue',
    (code) => {
      const temp = fixture();
      const directory = join(temp.root, 'scheduler.lock');
      const owner = {
        pid: process.pid,
        processStart: nativeProcessStart(process.pid),
        nonce: randomUUID(),
      };
      try {
        expect(
          __verificationCoordinatorInternals.acquireLeaseDirectory(directory, {
            owner,
            state: 'scheduler',
            heartbeatAt: Date.now(),
          }),
        ).toBe(true);
        expect(
          __verificationCoordinatorInternals.createOwnedDirectoryRemover({
            removeDirectory: () => {
              throw Object.assign(new Error(code), { code });
            },
          })(directory, owner),
        ).toMatchObject({ kind: 'released-with-residue' });
        expect(existsSync(directory)).toBe(false);
      } finally {
        temp.remove();
      }
    },
  );

  wslQuarantinedTest(
    'bounds a held foreign mutation claim without touching the canonical directory',
    () => {
      const temp = fixture();
      const directory = join(temp.root, 'scheduler.lock');
      const owner = {
        pid: process.pid,
        processStart: nativeProcessStart(process.pid),
        nonce: randomUUID(),
      };
      const writer = { ...owner, nonce: randomUUID() };
      try {
        expect(
          __verificationCoordinatorInternals.acquireLeaseDirectory(directory, {
            owner,
            state: 'scheduler',
            heartbeatAt: Date.now(),
          }),
        ).toBe(true);
        expect(
          __verificationCoordinatorInternals.acquireMutationClaim(
            directory,
            writer,
          ),
        ).toBeTruthy();
        expect(
          __verificationCoordinatorInternals.removeOwnedDirectoryOutcome(
            directory,
            owner,
          ),
        ).toMatchObject({ kind: 'blocked' });
        expect(existsSync(directory)).toBe(true);
        expect(
          JSON.parse(readFileSync(join(directory, 'lease.json'), 'utf8')),
        ).toMatchObject({ owner });
      } finally {
        temp.remove();
      }
    },
  );

  test.each(['EACCES', 'EPERM', 'ENOENT'])(
    'releases the canonical mutation claim after a %s outer-rename failure',
    (code) => {
      const temp = fixture();
      const directory = join(temp.root, 'scheduler.lock');
      const owner = {
        pid: process.pid,
        processStart: nativeProcessStart(process.pid),
        nonce: randomUUID(),
      };
      try {
        expect(
          __verificationCoordinatorInternals.acquireLeaseDirectory(directory, {
            owner,
            state: 'scheduler',
            heartbeatAt: Date.now(),
          }),
        ).toBe(true);
        expect(
          __verificationCoordinatorInternals.createOwnedDirectoryRemover({
            renameDirectory: () => {
              throw Object.assign(new Error(code), { code });
            },
          })(directory, owner).kind,
        ).toMatch(/not-released|indeterminate/);
        const contender = { ...owner, nonce: randomUUID() };
        const claim = __verificationCoordinatorInternals.acquireMutationClaim(
          directory,
          contender,
        );
        expect(claim).toBeTruthy();
        expect(
          __verificationCoordinatorInternals.releaseMutationClaim(
            claim,
            contender,
          ),
        ).toBe(true);
      } finally {
        temp.remove();
      }
    },
  );

  test('restores a post-move identity mismatch only while the canonical path is vacant', () => {
    const temp = fixture();
    const directory = join(temp.root, 'scheduler.lock');
    const owner = {
      pid: process.pid,
      processStart: nativeProcessStart(process.pid),
      nonce: randomUUID(),
    };
    try {
      expect(
        __verificationCoordinatorInternals.acquireLeaseDirectory(directory, {
          owner,
          state: 'scheduler',
          heartbeatAt: Date.now(),
        }),
      ).toBe(true);
      expect(
        __verificationCoordinatorInternals.createOwnedDirectoryRemover({
          renameDirectory: (source: string, destination: string) => {
            renameSync(source, destination);
            writeFileSync(
              join(destination, 'lease.json'),
              JSON.stringify({
                owner: { ...owner, nonce: randomUUID() },
                state: 'scheduler',
                heartbeatAt: Date.now(),
              }),
            );
          },
        })(directory, owner),
      ).toMatchObject({ kind: 'not-released' });
      expect(existsSync(directory)).toBe(true);
      expect(existsSync(join(directory, '.mutation'))).toBe(false);
    } finally {
      temp.remove();
    }
  });

  test('totalizes post-move validation faults as indeterminate residue', () => {
    const temp = fixture();
    const directory = join(temp.root, 'scheduler.lock');
    const owner = {
      pid: process.pid,
      processStart: nativeProcessStart(process.pid),
      nonce: randomUUID(),
    };
    try {
      expect(
        __verificationCoordinatorInternals.acquireLeaseDirectory(directory, {
          owner,
          state: 'scheduler',
          heartbeatAt: Date.now(),
        }),
      ).toBe(true);
      expect(
        __verificationCoordinatorInternals.createOwnedDirectoryRemover({
          readJsonFile: (path: string) => {
            if (path.includes('.remove-'))
              throw new Error('post-move read fault');
            return JSON.parse(readFileSync(path, 'utf8'));
          },
        })(directory, owner),
      ).toMatchObject({ kind: 'indeterminate' });
      expect(existsSync(directory)).toBe(false);
      expect(existsSync(directory)).toBe(false);
    } finally {
      temp.remove();
    }
  });

  test('restores when the moved inode fails the pre-move identity comparison', () => {
    const temp = fixture();
    const directory = join(temp.root, 'scheduler.lock');
    const owner = {
      pid: process.pid,
      processStart: nativeProcessStart(process.pid),
      nonce: randomUUID(),
    };
    let stats = 0;
    try {
      expect(
        __verificationCoordinatorInternals.acquireLeaseDirectory(directory, {
          owner,
          state: 'scheduler',
          heartbeatAt: Date.now(),
        }),
      ).toBe(true);
      expect(
        __verificationCoordinatorInternals.createOwnedDirectoryRemover({
          statDirectory: (path: string) => {
            stats += 1;
            const stat = lstatSync(path);
            if (stats !== 2) return stat;
            return {
              isDirectory: () => true,
              dev: stat.dev + 1,
              ino: stat.ino + 1,
            };
          },
        })(directory, owner),
      ).toMatchObject({ kind: 'not-released' });
      expect(existsSync(directory)).toBe(true);
      expect(existsSync(join(directory, '.mutation'))).toBe(false);
    } finally {
      temp.remove();
    }
  });

  test('does not restore over a successor when post-move identity validation fails', () => {
    const temp = fixture();
    const directory = join(temp.root, 'scheduler.lock');
    const owner = {
      pid: process.pid,
      processStart: nativeProcessStart(process.pid),
      nonce: randomUUID(),
    };
    const successor = {
      owner: { ...owner, nonce: randomUUID() },
      state: 'scheduler',
      heartbeatAt: Date.now(),
    };
    try {
      expect(
        __verificationCoordinatorInternals.acquireLeaseDirectory(directory, {
          owner,
          state: 'scheduler',
          heartbeatAt: Date.now(),
        }),
      ).toBe(true);
      expect(
        __verificationCoordinatorInternals.createOwnedDirectoryRemover({
          renameDirectory: (source: string, destination: string) => {
            renameSync(source, destination);
            writeFileSync(
              join(destination, 'lease.json'),
              JSON.stringify({
                ...successor,
                owner: { ...owner, nonce: randomUUID() },
              }),
            );
            expect(
              __verificationCoordinatorInternals.acquireLeaseDirectory(
                directory,
                successor,
              ),
            ).toBe(true);
          },
        })(directory, owner),
      ).toMatchObject({ kind: 'indeterminate' });
      expect(
        JSON.parse(readFileSync(join(directory, 'lease.json'), 'utf8')),
      ).toMatchObject(successor);
    } finally {
      temp.remove();
    }
  });

  test('recovers only dead mutation claims and cannot let an old claimant remove a successor', () => {
    const temp = fixture();
    const directory = join(temp.root, 'requests', 'mutation');
    const dead = { pid: 999999, processStart: 'gone', nonce: 'dead' };
    const live = { pid: process.pid, processStart: null, nonce: 'live' };
    const successor = {
      pid: process.pid,
      processStart: null,
      nonce: 'successor',
    };
    try {
      mkdirSync(directory, { recursive: true });
      const deadLock = __verificationCoordinatorInternals.acquireMutationClaim(
        directory,
        dead,
      );
      expect(deadLock).toBeTruthy();
      expect(
        JSON.parse(readFileSync(join(deadLock!, 'owner.json'), 'utf8')),
      ).toMatchObject({
        ...dead,
        heartbeatAt: expect.any(Number),
      });
      expect(
        __verificationCoordinatorInternals.recoverMutationClaim(directory),
      ).toBe(true);
      expect(
        __verificationCoordinatorInternals.recoverMutationClaim(directory),
      ).toBe(false);
      const liveLock = __verificationCoordinatorInternals.acquireMutationClaim(
        directory,
        live,
      );
      expect(liveLock).toBeTruthy();
      expect(
        __verificationCoordinatorInternals.recoverMutationClaim(directory),
      ).toBe(false);
      expect(
        __verificationCoordinatorInternals.releaseMutationClaim(liveLock, live),
      ).toBe(true);
      const successorLock =
        __verificationCoordinatorInternals.acquireMutationClaim(
          directory,
          successor,
        );
      expect(
        __verificationCoordinatorInternals.releaseMutationClaim(
          successorLock,
          live,
        ),
      ).toBe(false);
      expect(existsSync(successorLock!)).toBe(true);
    } finally {
      temp.remove();
    }
  });

  test('stale recovery publishes the live reaper identity and cannot be stolen mid-recovery', () => {
    const temp = fixture();
    const directory = join(temp.root, 'stale');
    const staleOwner = {
      pid: 999_999,
      processStart: 'dead',
      nonce: 'stale-owner',
    };
    const reaper = {
      pid: process.pid,
      processStart: nativeProcessStart(process.pid),
      nonce: 'live-reaper',
    };
    const contender = { ...reaper, nonce: 'second-reaper' };
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'lease.json'),
      JSON.stringify({
        owner: staleOwner,
        state: 'running',
        heartbeatAt: 1,
      }),
    );
    let stolen = false;
    try {
      expect(
        __verificationCoordinatorInternals.cleanStaleDirectory(directory, {
          now: Date.now(),
          staleMs: 1,
          reaper,
          processIdentityFn: (pid: number) =>
            pid === process.pid
              ? { pid, start: nativeProcessStart(pid) }
              : null,
          recoverExactChildFn: () => {
            stolen = Boolean(
              __verificationCoordinatorInternals.acquireMutationClaim(
                directory,
                contender,
                {
                  processIdentityFn: (pid: number) =>
                    pid === process.pid
                      ? { pid, start: nativeProcessStart(pid) }
                      : null,
                },
              ),
            );
            return true;
          },
        }),
      ).toBe(true);
      expect(stolen).toBe(false);
    } finally {
      temp.remove();
    }
  });

  test('failed child recovery restores a fenced original target and blocks a fresh acquire', () => {
    const temp = fixture();
    const directory = join(temp.root, 'requests', 'fenced-recovery');
    const owner = { pid: 999999, processStart: 'gone', nonce: 'dead-owner' };
    const lease = {
      owner,
      child: { pid: 123, pgid: 123, processStart: 'child' },
      state: 'running',
      heartbeatAt: 1,
    };
    try {
      expect(
        __verificationCoordinatorInternals.acquireLeaseDirectory(
          directory,
          lease,
        ),
      ).toBe(true);
      expect(
        __verificationCoordinatorInternals.cleanStaleDirectory(directory, {
          now: 100,
          staleMs: 1,
          processIdentityFn: () => null,
          recoverExactChildFn: () => false,
        }),
      ).toBe(false);
      expect(existsSync(directory)).toBe(true);
      expect(
        JSON.parse(readFileSync(join(directory, 'lease.json'), 'utf8')),
      ).toMatchObject({
        state: 'fenced',
        recoveryPending: true,
      });
      expect(
        __verificationCoordinatorInternals.acquireLeaseDirectory(directory, {
          ...lease,
          owner: { ...owner, nonce: 'fresh' },
        }),
      ).toBe(false);
      expect(
        __verificationCoordinatorInternals.cleanStaleDirectory(directory, {
          now: 100,
          staleMs: 1,
          processIdentityFn: () => null,
          recoverExactChildFn: () => true,
        }),
      ).toBe(true);
    } finally {
      temp.remove();
    }
  });

  test('canonical target stays occupied while injected child recovery is in flight', () => {
    const temp = fixture();
    const directory = join(temp.root, 'requests', 'recovery-in-flight');
    const owner = { pid: 999999, processStart: 'gone', nonce: 'owner' };
    const lease = { owner, state: 'running', heartbeatAt: 1 };
    try {
      expect(
        __verificationCoordinatorInternals.acquireLeaseDirectory(
          directory,
          lease,
        ),
      ).toBe(true);
      expect(
        __verificationCoordinatorInternals.cleanStaleDirectory(directory, {
          now: 100,
          staleMs: 1,
          processIdentityFn: () => null,
          recoverExactChildFn: () => {
            expect(
              __verificationCoordinatorInternals.acquireLeaseDirectory(
                directory,
                { ...lease, owner: { ...owner, nonce: 'second' } },
              ),
            ).toBe(false);
            return false;
          },
        }),
      ).toBe(false);
      expect(existsSync(directory)).toBe(true);
      expect(existsSync(join(directory, '.mutation'))).toBe(false);
    } finally {
      temp.remove();
    }
  });

  test('revalidation that turns live releases mutation so the original heartbeat can continue', () => {
    const temp = fixture();
    const directory = join(temp.root, 'requests', 'turns-live');
    const owner = { pid: process.pid, processStart: 'same', nonce: 'owner' };
    const lease = { owner, state: 'running', heartbeatAt: 1 };
    let probes = 0;
    try {
      expect(
        __verificationCoordinatorInternals.acquireLeaseDirectory(
          directory,
          lease,
        ),
      ).toBe(true);
      expect(
        __verificationCoordinatorInternals.cleanStaleDirectory(directory, {
          now: 100,
          staleMs: 1,
          processIdentityFn: () => {
            probes += 1;
            return probes === 1 ? null : { pid: process.pid, start: 'same' };
          },
        }),
      ).toBe(false);
      expect(existsSync(join(directory, '.mutation'))).toBe(false);
      expect(
        __verificationCoordinatorInternals.writeOwnedLease(directory, owner, {
          ...lease,
          heartbeatAt: 101,
        }),
      ).toBe(true);
    } finally {
      temp.remove();
    }
  });

  wslQuarantinedTest(
    'reclaims a stale owner by terminating its exact detached child group',
    async () => {
      if (process.platform === 'win32') return;
      const temp = fixture();
      const directory = join(temp.root, 'requests', 'crashed-owner');
      const parent = spawn(
        process.execPath,
        [
          '-e',
          "const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); child.unref(); console.log(child.pid); setInterval(() => {}, 1000);",
        ],
        {
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      const childPid = await new Promise<number>((resolvePid, rejectPid) => {
        parent.stdout.once('data', (chunk) =>
          resolvePid(Number(chunk.toString())),
        );
        parent.once('error', rejectPid);
      });
      parent.kill('SIGKILL');
      await new Promise((resolveClose) => parent.once('close', resolveClose));
      // The production authority, not a copy of it — see nativeProcessStart.
      const start = nativeProcessStart(childPid) ?? '';
      try {
        expect(start).not.toBe('');
        expect(
          __verificationCoordinatorInternals.acquireLeaseDirectory(directory, {
            owner: { pid: 123, processStart: 'dead', nonce: 'crashed' },
            child: { pid: childPid, pgid: childPid, processStart: start },
            state: 'running',
            heartbeatAt: 1,
            weight: 1,
          }),
        ).toBe(true);
        expect(
          __verificationCoordinatorInternals.cleanStaleDirectory(directory, {
            now: 100,
            staleMs: 1,
            processIdentityFn: () => null,
          }),
        ).toBe(true);
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
        expect(() => process.kill(childPid, 0)).toThrow();
      } finally {
        try {
          process.kill(-childPid, 'SIGKILL');
        } catch {
          // Recovery has already reaped it.
        }
        temp.remove();
      }
    },
  );

  test('admits real child-process contenders within capacity and recovers a killed scheduler owner', async () => {
    const temp = fixture();
    const firstWorktree = join(temp.root, 'one');
    const secondWorktree = join(temp.root, 'two');
    mkdirSync(firstWorktree, { recursive: true });
    mkdirSync(secondWorktree, { recursive: true });
    const collect = (child: ReturnType<typeof spawn>) =>
      new Promise<string>((resolveResult, rejectResult) => {
        let output = '';
        let errors = '';
        child.stdout.on('data', (chunk) => {
          output += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
          errors += chunk.toString();
        });
        child.once('error', rejectResult);
        child.once('close', (code) => {
          if (code === 0) resolveResult(output);
          else rejectResult(new Error(`child ${code}: ${errors}`));
        });
      });
    try {
      const holder = spawn(process.execPath, [
        '-e',
        'setInterval(() => {}, 1000)',
      ]);
      const start = nativeProcessStart(holder.pid);
      const scheduler = join(temp.root, 'scheduler.lock');
      mkdirSync(scheduler, { recursive: true });
      writeFileSync(
        join(scheduler, 'lease.json'),
        JSON.stringify({
          owner: {
            pid: holder.pid,
            processStart: start,
            nonce: 'dead-scheduler',
          },
          state: 'scheduler',
          heartbeatAt: 1,
        }),
      );
      holder.kill('SIGKILL');
      await new Promise((resolveClose) => holder.once('close', resolveClose));

      const first = coordinatorChild(temp.root, firstWorktree, 'one');
      const second = coordinatorChild(temp.root, secondWorktree, 'two');
      await waitFor(() =>
        verificationStatus({ root: temp.root, capacity: 40 }).jobs.some(
          (job) => job.state === 'queued',
        ),
      );
      const snapshot = verificationStatus({ root: temp.root, capacity: 40 });
      expect(snapshot.waiting).toBeGreaterThan(0);
      expect(snapshot.usedWeight).toBeLessThanOrEqual(40);
      const [one, two] = await Promise.all([collect(first), collect(second)]);
      expect(JSON.parse(one)).toMatchObject({ passed: true });
      expect(JSON.parse(two)).toMatchObject({ passed: true });
      expect(existsSync(scheduler)).toBe(false);
    } finally {
      temp.remove();
    }
  }, 15_000);

  test('finished status is bounded metadata and never probes process identity', () => {
    const temp = fixture();
    const directory = join(
      temp.root,
      'requests',
      canonicalRequestKey('finished-status'),
    );
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'lease.json'),
        JSON.stringify({
          owner: { pid: 99999, processStart: 'old', nonce: 'finished' },
          state: 'finished',
          heartbeatAt: 1,
          finishedAt: 1,
          weight: 100,
        }),
      );
      expect(
        verificationStatus({
          root: temp.root,
          processIdentityFn: () => {
            throw new Error('finished records must not probe processes');
          },
        }).jobs,
      ).toMatchObject([{ state: 'finished', live: false }]);
    } finally {
      temp.remove();
    }
  });

  test('GC bounds dead finished leases without touching live, fenced, output, or receipt artifacts', async () => {
    const temp = fixture();
    const requests = join(temp.root, 'requests');
    const outputs = join(temp.root, 'outputs', 'protected');
    const worktree = join(temp.root, 'worktree');
    mkdirSync(worktree, { recursive: true });
    const selfStart = nativeProcessStart(process.pid);
    const liveOwner = {
      pid: process.pid,
      processStart: selfStart,
      nonce: 'live',
    };
    const receiptArtifact = join(
      worktree,
      '.kontourai',
      'verification-receipts',
      'protected.json',
    );
    const finishedKeys: string[] = [];
    try {
      for (let index = 0; index < 40; index += 1) {
        const requestKey = canonicalRequestKey(`finished-${index}`);
        finishedKeys.push(requestKey);
        const directory = join(requests, requestKey);
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, 'lease.json'),
          JSON.stringify({
            owner: {
              pid: 999999,
              processStart: 'gone',
              nonce: `dead-${index}`,
            },
            state: 'finished',
            heartbeatAt: 0,
            finishedAt: 0,
            weight: 1,
          }),
        );
      }
      for (const [name, state] of [
        ['active', 'admitted'],
        ['fenced', 'fenced'],
      ]) {
        const directory = join(requests, canonicalRequestKey(name));
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, 'lease.json'),
          JSON.stringify({
            owner: { ...liveOwner, nonce: name },
            state,
            heartbeatAt: Date.now(),
            weight: 0,
          }),
        );
      }
      mkdirSync(outputs, { recursive: true });
      writeFileSync(
        join(outputs, 'lease.json'),
        JSON.stringify({
          owner: liveOwner,
          state: 'output',
          heartbeatAt: Date.now(),
        }),
      );
      mkdirSync(join(worktree, '.kontourai', 'verification-receipts'), {
        recursive: true,
      });
      writeFileSync(receiptArtifact, 'protected');
      await coordinateVerification({
        laneId: 'prepush',
        cwd: worktree,
        root: temp.root,
        collectProvenance: () => ({
          ...provenance(`gc-${temp.root}`),
          worktree,
        }),
        runner: async () => ({ status: 0 }),
      });
      for (const requestKey of finishedKeys)
        expect(existsSync(join(requests, requestKey))).toBe(false);
      expect(existsSync(join(requests, canonicalRequestKey('active')))).toBe(
        true,
      );
      expect(existsSync(join(requests, canonicalRequestKey('fenced')))).toBe(
        true,
      );
      expect(existsSync(outputs)).toBe(true);
      expect(existsSync(receiptArtifact)).toBe(true);
      expect(verificationStatus({ root: temp.root }).jobs).toHaveLength(3);
    } finally {
      temp.remove();
    }
  });

  test('requires the strict receipt schema as well as semantics before reuse', async () => {
    const temp = fixture();
    let calls = 0;
    const stable = {
      ...provenance(`schema-${temp.root}`),
      worktree: temp.root,
    };
    const options = {
      laneId: 'prepush',
      cwd: temp.root,
      root: temp.root,
      collectProvenance: () => stable,
      runner: async () => {
        calls += 1;
        return { status: 0 };
      },
    };
    try {
      const first = await coordinateVerification(options);
      const receipt = join(
        temp.root,
        '.kontourai',
        'verification-receipts',
        `${first.request.key}.canonical.json`,
      );
      const tampered = JSON.parse(readFileSync(receipt, 'utf8'));
      tampered.unknown = true;
      writeFileSync(receipt, JSON.stringify(tampered));
      expect((await coordinateVerification(options)).disposition).toBe(
        'executed',
      );
      expect(calls).toBe(2);
    } finally {
      temp.remove();
    }
  });

  for (const scenario of [
    {
      name: 'deleted artifact',
      corrupt: (path: string) => rmSync(path),
    },
    {
      name: 'tampered artifact',
      corrupt: (path: string) => writeFileSync(path, 'tampered evidence'),
    },
  ]) {
    test(`replaces a committed passing receipt with a ${scenario.name}`, async () => {
      const temp = fixture();
      const worktree = join(temp.root, 'worktree');
      mkdirSync(worktree);
      let calls = 0;
      const options = {
        laneId: 'prepush',
        root: temp.root,
        cwd: worktree,
        collectProvenance: () =>
          worktreeProvenance(worktree, `same-worktree-${scenario.name}`),
        runner: async () => {
          calls += 1;
          return {
            status: 0,
            output: {
              stdout: { text: `Tests ${calls} passed` },
              stderr: { text: '' },
            },
          };
        },
      };
      try {
        const first = await coordinateVerification(options);
        scenario.corrupt(join(worktree, first.receipt.artifacts[0].path));

        const repaired = await coordinateVerification(options);
        expect(repaired.disposition).toBe('executed');
        expect(repaired.receipt.terminal.passed).toBe(true);
        expect(calls).toBe(2);
        for (const artifact of repaired.receipt.artifacts)
          expect(existsSync(join(worktree, artifact.path))).toBe(true);

        const reused = await coordinateVerification(options);
        expect(reused.disposition).toBe('reused');
        expect(reused.receipt.terminal.passed).toBe(true);
        expect(calls).toBe(2);
      } finally {
        temp.remove();
      }
    });
  }

  test('does not let a prior finished failure satisfy a new lease generation', async () => {
    const temp = fixture();
    let calls = 0;
    const options = {
      laneId: 'prepush',
      root: temp.root,
      collectProvenance: () => provenance(`generation-${temp.root}`),
      runner: async () => ({ status: ++calls === 1 ? 1 : 0 }),
    };
    try {
      expect(
        (await coordinateVerification(options)).receipt.terminal.passed,
      ).toBe(false);
      expect(
        (await coordinateVerification(options)).receipt.terminal.passed,
      ).toBe(true);
      expect(calls).toBe(2);
    } finally {
      temp.remove();
    }
  });

  test('a joiner ignores an old failed canonical receipt until the active retry generation finishes', async () => {
    const temp = fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolvePending) => {
      release = resolvePending;
    });
    let calls = 0;
    const options = {
      laneId: 'prepush',
      root: temp.root,
      heartbeatMs: 1,
      collectProvenance: () => provenance(`retry-join-${temp.root}`),
      runner: async () => {
        calls += 1;
        if (calls === 1) return { status: 1 };
        await pending;
        return { status: 0 };
      },
    };
    try {
      await coordinateVerification(options);
      const retry = coordinateVerification(options);
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
      const joiner = coordinateVerification(options);
      release();
      expect((await joiner).receipt.terminal.passed).toBe(true);
      expect((await retry).receipt.terminal.passed).toBe(true);
      expect(calls).toBe(2);
    } finally {
      temp.remove();
    }
  });

  test('persists only redacted artifacts and rounds reporting faults into nonpass receipts', async () => {
    const temp = fixture();
    const options = {
      laneId: 'prepush',
      root: temp.root,
      collectProvenance: () => provenance(`reporting-${temp.root}`),
    };
    try {
      const persisted = await coordinateVerification({
        ...options,
        runner: async () => ({
          status: 0,
          output: {
            stdout: { text: 'token=top-secret\nTests 1 passed' },
            stderr: { text: '' },
            truncated: false,
          },
        }),
      });
      expect(persisted.receipt.terminal.passed).toBe(true);
      expect(persisted.summary).toMatchObject({
        terminal: 'completed',
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          }),
        ]),
      });
      for (const artifact of persisted.receipt.artifacts)
        expect(
          readFileSync(join(process.cwd(), artifact.path), 'utf8'),
        ).not.toContain('top-secret');

      const invalid = await coordinateVerification({
        ...options,
        force: true,
        runner: async () => ({
          status: 0,
          output: { invalidUtf8: true },
        }),
      });
      expect(invalid.receipt.terminal).toMatchObject({
        status: 'infrastructure_error',
        passed: false,
      });
      expect(invalid.receipt.artifacts).toEqual([]);

      const unsafeAttachment = await coordinateVerification({
        ...options,
        force: true,
        runner: async () => ({
          status: 0,
          output: { stdout: { text: '' }, stderr: { text: '' } },
          attachmentRoot: process.cwd(),
          attachments: [
            {
              name: 'attachment: /tmp/token=report-secret.zip',
              path: '/tmp/token=report-secret.zip',
              contentType: 'text/plain',
            },
          ],
        }),
      });
      expect(unsafeAttachment.receipt.terminal.passed).toBe(false);
      expect(JSON.stringify(unsafeAttachment.summary)).not.toContain(
        'report-secret',
      );
    } finally {
      temp.remove();
    }
  });

  test('loses a replaced request lease, stops its heartbeat, aborts the runner, and publishes no receipt', async () => {
    const temp = fixture();
    const worktree = join(temp.root, 'worktree');
    mkdirSync(worktree);
    let aborted = false;
    let startRunner!: () => void;
    const started = new Promise<void>((resolveStarted) => {
      startRunner = resolveStarted;
    });
    const options = {
      laneId: 'prepush',
      root: temp.root,
      cwd: worktree,
      heartbeatMs: 1,
      collectProvenance: () => worktreeProvenance(worktree, 'request-loss'),
      runner: async ({ signal }: { signal: AbortSignal }) => {
        startRunner();
        await new Promise<void>((_, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              reject(
                Object.assign(new Error('ownership lost'), {
                  name: 'AbortError',
                }),
              );
            },
            { once: true },
          ),
        );
        return { status: 0 };
      },
    };
    try {
      const pending = coordinateVerification(options);
      await started;
      const requestDirectory = join(
        temp.root,
        'requests',
        readdirSync(join(temp.root, 'requests'))[0],
      );
      const outputDirectory = join(
        temp.root,
        'outputs',
        readdirSync(join(temp.root, 'outputs'))[0],
      );
      const replacement = {
        ...JSON.parse(
          readFileSync(join(requestDirectory, 'lease.json'), 'utf8'),
        ),
        owner: {
          pid: process.pid,
          processStart: null,
          nonce: 'request-successor',
        },
        state: 'running',
      };
      writeFileSync(
        join(requestDirectory, 'lease.json'),
        JSON.stringify(replacement),
      );

      await expect(pending).rejects.toThrow(/ownership lost/);
      expect(aborted).toBe(true);
      expect(
        JSON.parse(readFileSync(join(requestDirectory, 'lease.json'), 'utf8')),
      ).toMatchObject({ owner: replacement.owner, state: 'running' });
      expect(
        JSON.parse(readFileSync(join(outputDirectory, 'lease.json'), 'utf8')),
      ).toMatchObject({ state: 'ownership_lost' });
      expect(readdirSync(join(temp.root, 'ownership-loss'))).toHaveLength(1);
      expect(
        existsSync(join(worktree, '.kontourai', 'verification-receipts')),
      ).toBe(false);
    } finally {
      temp.remove();
    }
  });

  test('fails closed when the output lease is replaced before terminal publication', async () => {
    const temp = fixture();
    const worktree = join(temp.root, 'worktree');
    mkdirSync(worktree);
    let replacement: { owner: { nonce: string } } | undefined;
    try {
      await expect(
        coordinateVerification({
          laneId: 'prepush',
          root: temp.root,
          cwd: worktree,
          heartbeatMs: 100,
          collectProvenance: () => worktreeProvenance(worktree, 'output-loss'),
          runner: () =>
            new Promise((resolveRunner) => {
              queueMicrotask(() => {
                // Resolve first, then replace before the coordinator's promise
                // reaction runs: the runner has settled, but publication has not.
                queueMicrotask(() => {
                  const outputDirectory = join(
                    temp.root,
                    'outputs',
                    readdirSync(join(temp.root, 'outputs'))[0],
                  );
                  replacement = {
                    ...JSON.parse(
                      readFileSync(join(outputDirectory, 'lease.json'), 'utf8'),
                    ),
                    owner: {
                      pid: process.pid,
                      processStart: null,
                      nonce: 'output-successor',
                    },
                    state: 'output',
                  };
                  writeFileSync(
                    join(outputDirectory, 'lease.json'),
                    JSON.stringify(replacement),
                  );
                });
                resolveRunner({ status: 0 });
              });
            }),
        }),
      ).rejects.toThrow(/ownership lost/);
      const outputDirectory = join(
        temp.root,
        'outputs',
        readdirSync(join(temp.root, 'outputs'))[0],
      );
      expect(
        JSON.parse(readFileSync(join(outputDirectory, 'lease.json'), 'utf8')),
      ).toMatchObject({ owner: replacement?.owner, state: 'output' });
      expect(
        existsSync(join(worktree, '.kontourai', 'verification-receipts')),
      ).toBe(false);
    } finally {
      temp.remove();
    }
  });

  for (const scenario of [
    {
      name: 'request finalization',
      terminalHooks: {
        beforeLeaseWrite: ({ phase }: { phase: string }) => {
          if (phase === 'finish-request') throw new Error('ENOSPC request');
        },
      },
    },
    {
      name: 'output finalization',
      terminalHooks: {
        beforeLeaseWrite: ({ phase }: { phase: string }) => {
          if (phase === 'finish-output') throw new Error('ENOSPC output');
        },
      },
    },
    {
      name: 'pending receipt write',
      terminalHooks: {
        beforeCanonicalWrite: () => {
          throw new Error('ENOSPC receipt');
        },
      },
    },
    {
      name: 'canonical rename',
      terminalHooks: {
        beforeCanonicalRename: () => {
          throw new Error('ENOSPC rename');
        },
      },
    },
    {
      name: 'failed receipt quarantine',
      terminalHooks: {
        beforeCanonicalRename: () => {
          throw new Error('ENOSPC rename');
        },
        beforeReceiptQuarantine: () => {
          throw new Error('cleanup unavailable');
        },
      },
    },
  ]) {
    test(`never reuses a receipt after ${scenario.name} fails`, async () => {
      const temp = fixture();
      const worktree = join(temp.root, 'worktree');
      mkdirSync(worktree);
      let calls = 0;
      const options = {
        laneId: 'prepush',
        root: temp.root,
        cwd: worktree,
        collectProvenance: () =>
          worktreeProvenance(worktree, `transaction-${scenario.name}`),
        runner: async () => {
          calls += 1;
          return { status: 0 };
        },
      };
      const receipts = join(worktree, '.kontourai', 'verification-receipts');
      try {
        await expect(
          coordinateVerification({
            ...options,
            terminalHooks: scenario.terminalHooks,
          }),
        ).rejects.toThrow(/ownership lost/);
        if (existsSync(receipts)) {
          const canonical = readdirSync(receipts).filter((name) =>
            name.endsWith('.canonical.json'),
          );
          expect(canonical).toHaveLength(0);
        }
        const retry = await coordinateVerification(options);
        expect(retry.disposition).toBe('executed');
        expect(retry.receipt.terminal.passed).toBe(true);
        expect(calls).toBe(2);
      } finally {
        temp.remove();
      }
    });
  }

  test('joins instead of locally reusing a canonical receipt before its commit marker', async () => {
    const temp = fixture();
    const worktree = join(temp.root, 'worktree');
    mkdirSync(worktree);
    let calls = 0;
    let reader!: Promise<Awaited<ReturnType<typeof coordinateVerification>>>;
    const options = {
      laneId: 'prepush',
      root: temp.root,
      cwd: worktree,
      heartbeatMs: 1,
      collectProvenance: () => worktreeProvenance(worktree, 'commit-window'),
      runner: async () => {
        calls += 1;
        return { status: 0 };
      },
    };
    try {
      const owner = await coordinateVerification({
        ...options,
        terminalHooks: {
          beforeReceiptCommit: () => {
            reader = coordinateVerification(options);
          },
        },
      });
      const joined = await reader;
      expect(owner.receipt.terminal.passed).toBe(true);
      expect(joined.disposition).toBe('joined');
      expect(calls).toBe(1);
    } finally {
      temp.remove();
    }
  });

  // station#3584: publishJoinedReceipt re-checks the joiner's own provenance
  // after its wait and retries as a fresh (real) execution when it drifted,
  // instead of publishing a stale-`before` projection labeled indeterminate.
  // These two tests prove both directions of that admission-behavior change.
  test('station#3584: joins normally (no re-execution) when the joiner provenance has NOT drifted during the wait', async () => {
    const temp = fixture();
    const worktree = join(temp.root, 'worktree');
    mkdirSync(worktree);
    let ownerRunnerCalls = 0;
    let joinerRunnerCalls = 0;
    let reader!: Promise<Awaited<ReturnType<typeof coordinateVerification>>>;
    const ownerOptions = {
      laneId: 'prepush',
      root: temp.root,
      cwd: worktree,
      heartbeatMs: 1,
      collectProvenance: () => worktreeProvenance(worktree, 'no-drift'),
      runner: async () => {
        ownerRunnerCalls += 1;
        return { status: 0 };
      },
    };
    const joinerOptions = {
      ...ownerOptions,
      // Constant across every call: the joiner's own tree never moves.
      collectProvenance: () => worktreeProvenance(worktree, 'no-drift'),
      runner: async () => {
        joinerRunnerCalls += 1;
        return { status: 0 };
      },
    };
    try {
      const owner = await coordinateVerification({
        ...ownerOptions,
        terminalHooks: {
          beforeReceiptCommit: () => {
            reader = coordinateVerification(joinerOptions);
          },
        },
      });
      const result = await reader;
      expect(owner.receipt.terminal.passed).toBe(true);
      expect(result.disposition).toBe('joined');
      expect(result.receipt.terminal.passed).toBe(true);
      expect(result.receipt.terminal.indeterminate).toBeUndefined();
      expect(ownerRunnerCalls).toBe(1);
      // The joiner's own runner was never invoked -- it adopted the owner's
      // receipt rather than re-executing.
      expect(joinerRunnerCalls).toBe(0);
    } finally {
      temp.remove();
    }
  });

  test('station#3584: retries and executes for real when the joiner provenance DOES drift during the wait', async () => {
    const temp = fixture();
    const worktree = join(temp.root, 'worktree');
    mkdirSync(worktree);
    let ownerRunnerCalls = 0;
    let joinerRunnerCalls = 0;
    let joinerProvenanceCalls = 0;
    let reader!: Promise<Awaited<ReturnType<typeof coordinateVerification>>>;
    const ownerOptions = {
      laneId: 'prepush',
      root: temp.root,
      cwd: worktree,
      heartbeatMs: 1,
      collectProvenance: () =>
        worktreeProvenance(worktree, 'drift-owner-stable'),
      runner: async () => {
        ownerRunnerCalls += 1;
        return { status: 0 };
      },
    };
    const joinerOptions = {
      ...ownerOptions,
      // First call (captured as this joiner's own `before`, before it even
      // discovers an owner is in flight) matches the owner's identity so it
      // recognizes the in-flight request and joins. Every call after that
      // simulates a tracked-file edit landing during the join wait.
      collectProvenance: () => {
        joinerProvenanceCalls += 1;
        return worktreeProvenance(
          worktree,
          joinerProvenanceCalls === 1
            ? 'drift-owner-stable'
            : 'drift-during-wait',
        );
      },
      runner: async () => {
        joinerRunnerCalls += 1;
        return { status: 0 };
      },
    };
    try {
      const owner = await coordinateVerification({
        ...ownerOptions,
        terminalHooks: {
          beforeReceiptCommit: () => {
            reader = coordinateVerification(joinerOptions);
          },
        },
      });
      const result = await reader;
      expect(owner.receipt.terminal.passed).toBe(true);
      expect(owner.disposition).toBe('executed');
      // Not 'joined': the drift is detected before adopting the owner's
      // receipt, so this becomes a fresh, real execution instead.
      expect(result.disposition).toBe('executed');
      expect(result.receipt.terminal.passed).toBe(true);
      expect(result.receipt.terminal.indeterminate).toBeUndefined();
      expect(ownerRunnerCalls).toBe(1);
      expect(joinerRunnerCalls).toBe(1);
    } finally {
      temp.remove();
    }
  });

  test('a runner that ignores its deadline fences output and cannot publish a terminal receipt', async () => {
    const temp = fixture();
    let release!: () => void;
    const ignored = new Promise<{ status: number }>((resolvePending) => {
      release = () => resolvePending({ status: 0 });
    });
    const options = {
      laneId: 'prepush',
      root: temp.root,
      timeoutMs: 1,
      heartbeatMs: 1,
      collectProvenance: () => provenance(`fence-${temp.root}`),
      runner: async () => ignored,
    };
    try {
      await expect(coordinateVerification(options)).rejects.toThrow(/fenced/);
      await expect(
        coordinateVerification({ ...options, timeoutMs: 1 }),
      ).rejects.toThrow(/timed out|output ownership/);
      expect(
        verificationStatus({ root: temp.root }).jobs.some(
          (job) => job.state === 'fenced',
        ),
      ).toBe(true);
    } finally {
      release();
      temp.remove();
    }
  }, 30_000);
});

describe('verification coordinator host-pressure admission', () => {
  function pressureClock(start = 10_000) {
    let value = start;
    return {
      now: () => value,
      advance: (ms: number) => {
        value += ms;
      },
    };
  }

  // The wait must advance the controlled clock AND yield a real macrotask, so
  // the admission loop advances the clock slowly enough that a pressure-wait
  // bound is not exhausted in microseconds of real time, while letting
  // real-time waitFor polls interleave.
  function tickingWait(clock: { advance: (ms: number) => void }) {
    return async (ms: number) => {
      clock.advance(ms);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
  }

  function sampleAt(
    clock: { now: () => number },
    busy: number | null,
    threshold = 85,
  ) {
    return buildHostPressureSample({
      busyPercent: busy,
      cpuCount: 4,
      sampleMs: 500,
      sampledAt: clock.now(),
      threshold,
      source: 'override',
    });
  }

  test('a heavy lane under sustained pressure never starts its runner and holds no output lock', async () => {
    const temp = fixture();
    const clock = pressureClock();
    const controller = new AbortController();
    let calls = 0;
    try {
      const pending = coordinateVerification({
        laneId: 'verify-static',
        root: temp.root,
        heartbeatMs: 5,
        hostPressureWaitMs: 60_000,
        now: clock.now,
        wait: tickingWait(clock),
        hostCpuSampler: async () => sampleAt(clock, 99),
        collectProvenance: () => provenance(`pressure-${temp.root}`),
        signal: controller.signal,
        runner: async () => {
          calls += 1;
          return { status: 0 };
        },
      });
      await waitFor(() =>
        verificationStatus({ root: temp.root }).jobs.some(
          (job) => job.queueReason === 'host_pressure',
        ),
      );
      expect(calls).toBe(0);
      // No output ownership while queued behind pressure.
      expect(readdirSync(join(temp.root, 'outputs'))).toHaveLength(0);
      const queued = verificationStatus({ root: temp.root }).jobs.find(
        (job) => job.state === 'queued',
      );
      expect(queued?.hostPressure).toMatchObject({
        status: 'pressured',
        busyPercent: 99,
        cpuCount: 4,
        thresholdPercent: 85,
        source: 'override',
      });
      controller.abort();
      const result = await pending;
      expect(result.receipt.terminal.status).toBe('canceled');
      expect(result.receipt.terminal.passed).toBe(false);
      expect(calls).toBe(0);
    } finally {
      temp.remove();
    }
  });

  test('requires two consecutive healthy samples before starting the runner exactly once', async () => {
    const temp = fixture();
    const clock = pressureClock();
    const sequence = [99, 99, 40, 40];
    let calls = 0;
    let samples = 0;
    try {
      const result = await coordinateVerification({
        laneId: 'verify-static',
        root: temp.root,
        heartbeatMs: 5,
        hostPressureWaitMs: 60_000,
        now: clock.now,
        wait: tickingWait(clock),
        hostCpuSampler: async () => {
          const busy = sequence[Math.min(samples, sequence.length - 1)];
          samples += 1;
          return sampleAt(clock, busy);
        },
        collectProvenance: () => provenance(`twohealthy-${temp.root}`),
        runner: async () => {
          calls += 1;
          return { status: 0 };
        },
      });
      expect(result.disposition).toBe('executed');
      expect(result.receipt.terminal.passed).toBe(true);
      expect(calls).toBe(1);
      // pressured, pressured, healthy, healthy — no sample after admission.
      expect(samples).toBe(4);
    } finally {
      temp.remove();
    }
  });

  test('ownership replacement during admission cannot acquire or leak output ownership', async () => {
    const temp = fixture();
    const clock = pressureClock();
    let samples = 0;
    let calls = 0;
    try {
      const pending = coordinateVerification({
        laneId: 'verify-static',
        root: temp.root,
        heartbeatMs: 5,
        now: clock.now,
        wait: tickingWait(clock),
        hostCpuSampler: async () => {
          samples += 1;
          if (samples === 2) {
            const requestDirectory = join(
              temp.root,
              'requests',
              readdirSync(join(temp.root, 'requests'))[0],
            );
            const lease = JSON.parse(
              readFileSync(join(requestDirectory, 'lease.json'), 'utf8'),
            );
            writeFileSync(
              join(requestDirectory, 'lease.json'),
              JSON.stringify({
                ...lease,
                owner: {
                  pid: process.pid,
                  processStart: nativeProcessStart(process.pid),
                  nonce: 'admission-successor',
                },
              }),
            );
          }
          return sampleAt(clock, 40);
        },
        collectProvenance: () => provenance(`admission-loss-${temp.root}`),
        runner: async () => {
          calls += 1;
          return { status: 0 };
        },
      });
      await expect(pending).rejects.toThrow('ownership lost during admission');
      expect(calls).toBe(0);
      expect(readdirSync(join(temp.root, 'outputs'))).toHaveLength(0);
    } finally {
      temp.remove();
    }
  });

  test('a low (ungated) lane starts immediately under sustained pressure', async () => {
    const temp = fixture();
    let calls = 0;
    let samples = 0;
    try {
      const result = await coordinateVerification({
        laneId: 'prepush',
        root: temp.root,
        heartbeatMs: 5,
        hostPressureWaitMs: 60_000,
        now: () => 10_000,
        wait: async () => {},
        hostCpuSampler: async () => {
          samples += 1;
          return sampleAt({ now: () => 10_000 }, 99);
        },
        collectProvenance: () => provenance(`low-${temp.root}`),
        runner: async () => {
          calls += 1;
          return { status: 0 };
        },
      });
      expect(result.receipt.terminal.passed).toBe(true);
      expect(calls).toBe(1);
      expect(samples).toBe(0);
    } finally {
      temp.remove();
    }
  });

  test('rising pressure after admission does not stop or requeue a running lane', async () => {
    const temp = fixture();
    const clock = pressureClock();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let samples = 0;
    let calls = 0;
    try {
      const pending = coordinateVerification({
        laneId: 'verify-static',
        root: temp.root,
        heartbeatMs: 5,
        hostPressureWaitMs: 60_000,
        now: clock.now,
        wait: tickingWait(clock),
        hostCpuSampler: async () => {
          samples += 1;
          // Healthy for the two admission samples, then rising pressure that
          // must be ignored once the lane is admitted.
          return sampleAt(clock, samples <= 2 ? 40 : 99);
        },
        collectProvenance: () => provenance(`rising-${temp.root}`),
        runner: async () => {
          calls += 1;
          await blocked;
          return { status: 0 };
        },
      });
      await waitFor(() =>
        verificationStatus({ root: temp.root }).jobs.some(
          (job) => job.state === 'running',
        ),
      );
      release();
      const result = await pending;
      expect(result.receipt.terminal.passed).toBe(true);
      expect(calls).toBe(1);
    } finally {
      temp.remove();
    }
  });

  test('a host-pressure wait timeout publishes a nonpassing infrastructure error without running', async () => {
    const temp = fixture();
    const clock = pressureClock();
    let calls = 0;
    try {
      const result = await coordinateVerification({
        laneId: 'verify-static',
        root: temp.root,
        heartbeatMs: 2,
        hostPressureWaitMs: 5,
        now: clock.now,
        wait: tickingWait(clock),
        hostCpuSampler: async () => sampleAt(clock, 99),
        collectProvenance: () => provenance(`pwtimeout-${temp.root}`),
        runner: async () => {
          calls += 1;
          return { status: 0 };
        },
      });
      expect(result.receipt.terminal.status).toBe('infrastructure_error');
      expect(result.receipt.terminal.passed).toBe(false);
      expect(calls).toBe(0);
    } finally {
      temp.remove();
    }
  });

  test('a pressure terminal publication failure releases its output fence for an immediate retry', async () => {
    const temp = fixture();
    const clock = pressureClock();
    let calls = 0;
    const options = {
      laneId: 'verify-static',
      root: temp.root,
      heartbeatMs: 2,
      hostPressureWaitMs: 5,
      now: clock.now,
      wait: tickingWait(clock),
      collectProvenance: () => provenance(`pressure-publication-${temp.root}`),
      runner: async () => {
        calls += 1;
        return { status: 0 };
      },
    };
    try {
      await expect(
        coordinateVerification({
          ...options,
          hostCpuSampler: async () => sampleAt(clock, 99),
          terminalHooks: {
            beforeLeaseWrite: ({ phase }: { phase: string }) => {
              if (phase === 'finish-request')
                throw new Error('pressure terminal write failed');
            },
          },
        }),
      ).rejects.toThrow(/ownership lost/);

      const retry = await coordinateVerification({
        ...options,
        hostCpuSampler: async () => sampleAt(clock, 40),
      });
      expect(retry.disposition).toBe('executed');
      expect(retry.receipt.terminal.passed).toBe(true);
      expect(calls).toBe(1);
      expect(readdirSync(join(temp.root, 'outputs'))).toHaveLength(0);
    } finally {
      temp.remove();
    }
  });

  test('cancellation during a pressure wait publishes a canceled receipt without running', async () => {
    const temp = fixture();
    const clock = pressureClock();
    const controller = new AbortController();
    let calls = 0;
    try {
      const pending = coordinateVerification({
        laneId: 'verify-static',
        root: temp.root,
        heartbeatMs: 5,
        hostPressureWaitMs: 60_000,
        now: clock.now,
        wait: tickingWait(clock),
        hostCpuSampler: async () => sampleAt(clock, 99),
        collectProvenance: () => provenance(`pwcancel-${temp.root}`),
        signal: controller.signal,
        runner: async () => {
          calls += 1;
          return { status: 0 };
        },
      });
      await waitFor(() =>
        verificationStatus({ root: temp.root }).jobs.some(
          (job) => job.queueReason === 'host_pressure',
        ),
      );
      controller.abort();
      const result = await pending;
      expect(result.receipt.terminal.status).toBe('canceled');
      expect(result.receipt.terminal.passed).toBe(false);
      expect(calls).toBe(0);
    } finally {
      temp.remove();
    }
  });

  test('cancellation wins when it arrives inside the sample that reaches the pressure deadline', async () => {
    const temp = fixture();
    const clock = pressureClock();
    const controller = new AbortController();
    let calls = 0;
    try {
      const result = await coordinateVerification({
        laneId: 'verify-static',
        root: temp.root,
        heartbeatMs: 5,
        hostPressureWaitMs: 5,
        now: clock.now,
        wait: tickingWait(clock),
        hostCpuSampler: async () => {
          clock.advance(5);
          controller.abort();
          return sampleAt(clock, 99);
        },
        collectProvenance: () => provenance(`pwcancel-race-${temp.root}`),
        signal: controller.signal,
        runner: async () => {
          calls += 1;
          return { status: 0 };
        },
      });
      expect(result.receipt.terminal.status).toBe('canceled');
      expect(result.receipt.terminal.passed).toBe(false);
      expect(calls).toBe(0);
    } finally {
      temp.remove();
    }
  });

  test('an unavailable sampler fails closed to a nonpassing infrastructure error', async () => {
    const temp = fixture();
    const clock = pressureClock();
    let calls = 0;
    try {
      const result = await coordinateVerification({
        laneId: 'verify-static',
        root: temp.root,
        heartbeatMs: 5,
        hostPressureWaitMs: 5,
        now: clock.now,
        wait: tickingWait(clock),
        hostCpuSampler: async () => sampleAt(clock, null),
        collectProvenance: () => provenance(`pwunavail-${temp.root}`),
        runner: async () => {
          calls += 1;
          return { status: 0 };
        },
      });
      expect(result.receipt.terminal.status).toBe('infrastructure_error');
      expect(result.receipt.terminal.passed).toBe(false);
      expect(calls).toBe(0);
    } finally {
      temp.remove();
    }
  });

  test('transient sampler unavailability recovers to healthy and admits after two consecutive healthy samples', async () => {
    const temp = fixture();
    const clock = pressureClock();
    const sequence = [null, 40, 40];
    let samples = 0;
    let calls = 0;
    try {
      const result = await coordinateVerification({
        laneId: 'verify-static',
        root: temp.root,
        heartbeatMs: 5,
        hostPressureWaitMs: 60_000,
        now: clock.now,
        wait: tickingWait(clock),
        hostCpuSampler: async () => {
          const busy = sequence[Math.min(samples, sequence.length - 1)];
          samples += 1;
          return sampleAt(clock, busy);
        },
        collectProvenance: () => provenance(`pwrecov-${temp.root}`),
        runner: async () => {
          calls += 1;
          return { status: 0 };
        },
      });
      expect(result.disposition).toBe('executed');
      expect(result.receipt.terminal.passed).toBe(true);
      expect(calls).toBe(1);
      // unavailable, healthy, healthy — no sample after admission.
      expect(samples).toBe(3);
    } finally {
      temp.remove();
    }
  });

  test('pressureWaitStartedAt is fixed before the first gated sample and does not slide on status alternation', async () => {
    const temp = fixture();
    const clock = pressureClock(10_000);
    const controller = new AbortController();
    const sequence = [40, null, null];
    let samples = 0;
    try {
      const pending = coordinateVerification({
        laneId: 'verify-static',
        root: temp.root,
        heartbeatMs: 5,
        hostPressureWaitMs: 60_000,
        now: clock.now,
        wait: tickingWait(clock),
        hostCpuSampler: async () => {
          const busy = sequence[Math.min(samples, sequence.length - 1)];
          samples += 1;
          return sampleAt(clock, busy);
        },
        collectProvenance: () => provenance(`pwstart-${temp.root}`),
        signal: controller.signal,
        runner: async () => ({ status: 0 }),
      });
      await waitFor(() =>
        verificationStatus({ root: temp.root }).jobs.some(
          (job) => job.queueReason === 'host_pressure',
        ),
      );
      const queued = verificationStatus({ root: temp.root }).jobs.find(
        (job) => job.state === 'queued',
      );
      // The bound was set at the start (10_000), before the first sample — not
      // slid to a later sample time by the initial healthy-then-unavailable
      // alternation.
      expect(queued?.pressureWaitStartedAt).toBe(10_000);
      controller.abort();
      await pending;
    } finally {
      temp.remove();
    }
  });

  wslQuarantinedTest(
    'a held output lock fences canceled pressure publication until release',
    async () => {
      const temp = fixture();
      const worktree = join(temp.root, 'worktree');
      mkdirSync(worktree, { recursive: true });
      const outputHash = createHash('sha256')
        .update(`${'a'.repeat(64)}:${worktree}`)
        .digest('hex');
      const outputLock = join(temp.root, 'outputs', outputHash);
      mkdirSync(outputLock, { recursive: true });
      writeFileSync(
        join(outputLock, 'lease.json'),
        JSON.stringify({
          owner: {
            pid: process.pid,
            processStart: nativeProcessStart(process.pid),
            nonce: 'output-holder',
          },
          state: 'output',
          heartbeatAt: Date.now(),
        }),
      );
      const controller = new AbortController();
      let calls = 0;
      try {
        const pending = coordinateVerification({
          laneId: 'verify-static',
          root: temp.root,
          cwd: worktree,
          heartbeatMs: 5,
          hostPressureWaitMs: 60_000,
          hostCpuSampler: async () => sampleAt({ now: Date.now }, 99),
          collectProvenance: () =>
            worktreeProvenance(worktree, `held-output-${temp.root}`),
          signal: controller.signal,
          runner: async () => {
            calls += 1;
            return { status: 0 };
          },
        });
        await waitFor(() =>
          verificationStatus({ root: temp.root }).jobs.some(
            (job) => job.queueReason === 'host_pressure',
          ),
        );
        controller.abort();
        const raced = await Promise.race([
          pending.then((result) => ({ settled: true as const, result })),
          new Promise<{ settled: false }>((resolve) =>
            setTimeout(() => resolve({ settled: false }), 80),
          ),
        ]);
        // No terminal receipt may be published while the output lock is held by
        // another live owner.
        expect(raced.settled).toBe(false);
        expect(calls).toBe(0);
        rmSync(outputLock, { recursive: true, force: true });
        const result = await pending;
        expect(result.receipt.terminal.status).toBe('canceled');
        expect(result.receipt.terminal.passed).toBe(false);
        expect(calls).toBe(0);
      } finally {
        try {
          rmSync(outputLock, { recursive: true, force: true });
        } catch {
          // Already removed or acquired.
        }
        temp.remove();
      }
    },
  );

  wslQuarantinedTest(
    'stale fairness for another blocker does not let a later lane jump FIFO',
    async () => {
      const temp = fixture();
      const clock = pressureClock();
      const earlierKey = canonicalRequestKey('earlier-healthy-waiter');
      const earlier = join(temp.root, 'requests', earlierKey);
      mkdirSync(earlier, { recursive: true });
      writeFileSync(
        join(earlier, 'lease.json'),
        JSON.stringify({
          request: { key: earlierKey },
          owner: {
            pid: process.pid,
            processStart: nativeProcessStart(process.pid),
            nonce: 'earlier-healthy',
          },
          state: 'queued',
          queueReason: 'full_weight_fairness',
          blockingRequestKey: canonicalRequestKey(
            'removed-full-weight-blocker',
          ),
          weight: 80,
          capacity: 100,
          createdAt: 5_000,
          heartbeatAt: clock.now(),
          generation: 'earlier-healthy',
        }),
      );
      let samples = 0;
      let calls = 0;
      try {
        const pending = coordinateVerification({
          laneId: 'verify-static',
          root: temp.root,
          heartbeatMs: 1_001,
          hostPressureWaitMs: 2_500,
          timeoutMs: 20_000,
          now: clock.now,
          wait: tickingWait(clock),
          hostCpuSampler: async () => {
            samples += 1;
            return sampleAt(clock, 40);
          },
          collectProvenance: () => provenance(`pwstale-${temp.root}`),
          runner: async () => {
            calls += 1;
            return { status: 0 };
          },
        });
        await waitFor(() => samples >= 3);
        const queued = verificationStatus({ root: temp.root }).jobs.find(
          (job) => job.state === 'queued' && job.key !== earlierKey,
        );
        expect(queued?.queueReason).toBe('host_pressure_fifo');
        expect(queued?.blockingRequestKey).toBe(earlierKey);
        rmSync(earlier, { recursive: true, force: true });
        const result = await pending;
        expect(result.receipt.terminal.passed).toBe(true);
        expect(samples).toBeGreaterThanOrEqual(4);
        expect(calls).toBe(1);
      } finally {
        rmSync(earlier, { recursive: true, force: true });
        temp.remove();
      }
    },
  );

  wslQuarantinedTest(
    'a healthy FIFO waiter reports its request deadline as timed out',
    async () => {
      const temp = fixture();
      const clock = pressureClock();
      const earlierKey = canonicalRequestKey('deadline-contender');
      const earlier = join(temp.root, 'requests', earlierKey);
      mkdirSync(earlier, { recursive: true });
      writeFileSync(
        join(earlier, 'lease.json'),
        JSON.stringify({
          request: { key: earlierKey },
          owner: {
            pid: process.pid,
            processStart: nativeProcessStart(process.pid),
            nonce: 'deadline-contender',
          },
          state: 'queued',
          weight: 80,
          capacity: 100,
          createdAt: 5_000,
          heartbeatAt: clock.now(),
          generation: 'deadline-contender',
        }),
      );
      let calls = 0;
      try {
        const result = await coordinateVerification({
          laneId: 'verify-static',
          root: temp.root,
          heartbeatMs: 100,
          hostPressureWaitMs: 1_000,
          timeoutMs: 500,
          now: clock.now,
          wait: tickingWait(clock),
          hostCpuSampler: async () => sampleAt(clock, 40),
          collectProvenance: () => provenance(`pwdeadline-${temp.root}`),
          runner: async () => {
            calls += 1;
            return { status: 0 };
          },
        });
        expect(result.receipt.terminal.status).toBe('timed_out');
        expect(result.receipt.terminal.passed).toBe(false);
        expect(calls).toBe(0);
      } finally {
        rmSync(earlier, { recursive: true, force: true });
        temp.remove();
      }
    },
  );

  wslQuarantinedTest(
    'FIFO blocks a later healthy heavy lane while an earlier queued heavy lane waits',
    async () => {
      const temp = fixture();
      const clock = pressureClock();
      const requests = join(temp.root, 'requests');
      let calls = 0;
      try {
        // An earlier-arriving heavy lane, queued behind pressure, with a live
        // owner so it is a real FIFO contender.
        const earlierKey = canonicalRequestKey('earlier-contender');
        const earlier = join(requests, earlierKey);
        mkdirSync(earlier, { recursive: true });
        writeFileSync(
          join(earlier, 'lease.json'),
          JSON.stringify({
            request: { key: earlierKey },
            owner: {
              pid: process.pid,
              processStart: nativeProcessStart(process.pid),
              nonce: 'earlier',
            },
            state: 'queued',
            queueReason: 'host_pressure',
            weight: 80,
            capacity: 100,
            createdAt: 5_000,
            heartbeatAt: clock.now(),
            generation: 'earlier',
          }),
        );
        // A later heavy lane that is immediately healthy. Because the earlier
        // contender is only queued (it consumes no capacity), this lane's capacity
        // check passes; only FIFO ordering keeps it waiting.
        const later = coordinateVerification({
          laneId: 'verify-static',
          root: temp.root,
          capacity: 100,
          heartbeatMs: 5,
          hostPressureWaitMs: 60_000,
          now: clock.now,
          wait: tickingWait(clock),
          hostCpuSampler: async () => sampleAt(clock, 40),
          collectProvenance: () => provenance(`fifo-later-${temp.root}`),
          runner: async () => {
            calls += 1;
            return { status: 0 };
          },
        });
        // The later lane reaches healthy but must remain queued behind the
        // earlier contender despite free capacity.
        await waitFor(() =>
          verificationStatus({ root: temp.root, capacity: 100 }).jobs.some(
            (job) =>
              job.state === 'queued' && job.hostPressure?.status === 'healthy',
          ),
        );
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(calls).toBe(0);
        // Removing the earlier contender lets the later lane admit in FIFO order.
        rmSync(earlier, { recursive: true, force: true });
        const result = await later;
        expect(result.receipt.terminal.passed).toBe(true);
        expect(calls).toBe(1);
      } finally {
        temp.remove();
      }
    },
  );

  wslQuarantinedTest(
    'status usedWeight counts every capacity-consuming admission state and projects hostPressure',
    () => {
      const temp = fixture();
      const requests = join(temp.root, 'requests');
      const start = nativeProcessStart(process.pid);
      try {
        for (const [name, state] of [
          ['admitted', 'admitted'],
          ['output', 'output'],
          ['running', 'running'],
          ['canceling', 'canceling'],
        ] as const) {
          const directory = join(requests, canonicalRequestKey(name));
          mkdirSync(directory, { recursive: true });
          writeFileSync(
            join(directory, 'lease.json'),
            JSON.stringify({
              owner: { pid: process.pid, processStart: start, nonce: name },
              state,
              heartbeatAt: Date.now(),
              weight: 25,
              createdAt: 1,
            }),
          );
        }
        const queued = join(requests, canonicalRequestKey('queued'));
        mkdirSync(queued, { recursive: true });
        writeFileSync(
          join(queued, 'lease.json'),
          JSON.stringify({
            owner: { pid: process.pid, processStart: start, nonce: 'queued' },
            state: 'queued',
            queueReason: 'host_pressure',
            weight: 100,
            createdAt: 2,
            heartbeatAt: Date.now(),
            hostPressure: {
              status: 'pressured',
              busyPercent: 99,
              cpuCount: 4,
              sampledAt: 1,
              sampleMs: 500,
              thresholdPercent: 85,
              source: 'override',
            },
          }),
        );
        const status = verificationStatus({ root: temp.root });
        // admitted/output/running/canceling each consume capacity (25*4); the
        // queued job does not.
        expect(status.usedWeight).toBe(100);
        expect(status.waiting).toBe(1);
        const queuedJob = status.jobs.find((job) => job.state === 'queued');
        expect(queuedJob?.queueReason).toBe('host_pressure');
        expect(queuedJob?.hostPressure).toMatchObject({
          status: 'pressured',
          busyPercent: 99,
          thresholdPercent: 85,
        });
      } finally {
        temp.remove();
      }
    },
  );

  test('status separates current completion phase queue and execution timing', () => {
    const temp = fixture();
    const directory = join(
      temp.root,
      'requests',
      canonicalRequestKey('completion-phase'),
    );
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'lease.json'),
        JSON.stringify({
          owner: {
            pid: process.pid,
            processStart: nativeProcessStart(process.pid),
            nonce: 'completion-phase',
          },
          state: 'running',
          weight: 80,
          createdAt: 100,
          startedAt: 100,
          deadlineAt: 10_000,
          heartbeatAt: 500,
          phase: {
            id: ORDINARY_FULL_PHASE_IDS[0],
            index: 3,
            total: 9,
            queueStartedAt: 200,
            queueDeadlineAt: 10_000,
            executionStartedAt: 400,
            executionDeadlineAt: 5_000,
          },
        }),
      );
      const job = verificationStatus({ root: temp.root, now: 1_200 }).jobs[0];
      expect(job).toMatchObject({
        elapsedMs: 1_100,
        deadlineAt: 10_000,
        phase: {
          id: ORDINARY_FULL_PHASE_IDS[0],
          queueElapsedMs: 1_000,
          queueDeadlineAt: 10_000,
          executionElapsedMs: 800,
          executionDeadlineAt: 5_000,
        },
      });
    } finally {
      temp.remove();
    }
  });
});
