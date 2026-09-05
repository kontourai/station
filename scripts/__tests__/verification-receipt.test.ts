import { execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ErrorObject } from 'ajv';
import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import {
  PRODUCT_LAW_OBSERVATION_TIMEOUT_ENV,
  PRODUCT_LAW_OBSERVATION_TIMEOUT_MS,
} from '../lib/product-laws.mjs';
import {
  assertVerificationToolchain,
  collectRepositoryIdentity,
  collectVerificationProvenance,
  detectToolchainIdentity,
  digestRepositoryFile,
  digestVerificationDependencies,
  digestVerificationEnvironment,
  normalizeGitOrigin,
  resolveVerificationToolchain,
} from '../lib/test-reliability.mjs';
import {
  assertReceiptSemantics,
  classifyTerminal,
  createVerificationReceipt,
  createVerificationRequest,
  VERIFICATION_RECEIPT_SCHEMA_VERSION,
  verificationRequestKey,
} from '../lib/verification-receipt.mjs';
import { executionEquivalenceKey } from '../lib/verification-request-identity.mjs';
import { FIXTURE_TOOLCHAIN_IDENTITY } from './fixtures/verification-toolchain.mjs';

const schema = JSON.parse(
  readFileSync('schemas/verification-receipt.schema.json', 'utf8'),
) as object;

const hex = (repeat: number) => 'a'.repeat(repeat);

const provenance = {
  repositoryId: hex(64),
  worktree: '/repo/worktree',
  headSha: hex(40),
  workspaceDigest: hex(64),
  environmentDigest: hex(64),
  dependencyDigest: hex(64),
  nodeVersion: 'v24.18.0',
  toolchain: 'npm@fixture',
  toolchainIdentity: FIXTURE_TOOLCHAIN_IDENTITY,
  platform: 'darwin',
  arch: 'arm64',
  // Volatile machine telemetry travels with the provenance but must NOT
  // participate in the request key or the stability comparison.
  machine: {
    cpuCount: 8,
    totalMemoryBytes: 17179869184,
    loadAverage: { 1: 1.2, 5: 1.1, 15: 1.0 },
    loadPerCpu: 0.15,
  },
};

type Provenance = typeof provenance;

function buildRequest(overrides: Partial<Provenance> = {}) {
  return createVerificationRequest('ci-fast', { ...provenance, ...overrides });
}

const passingCounts = {
  executed: 1,
  passed: 1,
  failed: 0,
  infrastructureErrors: 0,
};

function buildPassingReceipt() {
  const request = buildRequest();
  return createVerificationReceipt({
    request,
    disposition: 'executed',
    status: 'completed',
    exitCode: 0,
    counts: passingCounts,
    cleanup: { status: 'passed', survivingOwnedChildren: 0 },
    before: provenance,
    after: provenance,
  });
}

describe('verification receipt schema version', () => {
  it('is pinned to version 3 (bumped for station#3584: terminal.indeterminate is not additively compatible)', () => {
    expect(VERIFICATION_RECEIPT_SCHEMA_VERSION).toBe(3);
    expect(buildPassingReceipt().schemaVersion).toBe(3);
  });
});

describe('createVerificationRequest identity', () => {
  it('assembles every request field and a sha256 key', () => {
    const request = buildRequest();
    expect(request).toMatchObject({
      repositoryId: hex(64),
      worktree: '/repo/worktree',
      headSha: hex(40),
      workspaceDigest: hex(64),
      environmentDigest: hex(64),
      laneId: 'ci-fast',
      command: 'npm run ci:fast',
      dependencyDigest: hex(64),
      nodeVersion: 'v24.18.0',
      toolchain: 'npm@fixture',
      toolchainIdentity: FIXTURE_TOOLCHAIN_IDENTITY.digest,
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(request.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(request.key).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(request).sort()).toEqual([
      'arch',
      'command',
      'dependencyDigest',
      'environmentDigest',
      'headSha',
      'key',
      'laneId',
      'manifestDigest',
      'nodeVersion',
      'platform',
      'repositoryId',
      'toolchain',
      'toolchainIdentity',
      'workspaceDigest',
      'worktree',
    ]);
  });

  it('excludes volatile machine telemetry from the request key', () => {
    const stable = buildRequest().key;
    const volatileMachine = {
      ...provenance,
      machine: {
        cpuCount: 999,
        totalMemoryBytes: 1,
        loadAverage: { 1: 99.9, 5: 99.9, 15: 99.9 },
        loadPerCpu: 12.5,
      },
    };
    expect(createVerificationRequest('ci-fast', volatileMachine).key).toBe(
      stable,
    );
  });

  it('invalidates identity on an allowlisted behavior environment digest without retaining raw values', () => {
    const disabled = digestVerificationEnvironment({
      STATION_E2E_SEED_REGRESSION: '0',
      STATION_FEATURES: '',
      STATION_SERVICE_ITEST: '0',
      STATION_INTERNAL_API_TOKEN: 'must-not-be-read',
    });
    const enabled = digestVerificationEnvironment({
      STATION_E2E_SEED_REGRESSION: '1',
      STATION_FEATURES: '',
      STATION_SERVICE_ITEST: '0',
      STATION_INTERNAL_API_TOKEN: 'different-secret',
    });
    expect(enabled).toMatch(/^[0-9a-f]{64}$/);
    expect(enabled).not.toBe(disabled);
    expect(JSON.stringify({ enabled })).not.toContain('different-secret');
    expect(buildRequest({ environmentDigest: enabled }).key).not.toBe(
      buildRequest({ environmentDigest: disabled }).key,
    );
  });

  it('invalidates the request when ci:fast changes its affected-test base', () => {
    const firstBase = digestVerificationEnvironment({
      STATION_CI_FAST_BASE: 'base-before',
    });
    const secondBase = digestVerificationEnvironment({
      STATION_CI_FAST_BASE: 'base-after',
    });
    expect(secondBase).not.toBe(firstBase);
    expect(buildRequest({ environmentDigest: secondBase }).key).not.toBe(
      buildRequest({ environmentDigest: firstBase }).key,
    );
  });

  it('binds the effective product-law timeout while treating unset and explicit default alike', () => {
    const unset = digestVerificationEnvironment({});
    const explicitDefault = digestVerificationEnvironment({
      [PRODUCT_LAW_OBSERVATION_TIMEOUT_ENV]: String(
        PRODUCT_LAW_OBSERVATION_TIMEOUT_MS,
      ),
    });
    const short = digestVerificationEnvironment({
      [PRODUCT_LAW_OBSERVATION_TIMEOUT_ENV]: '1',
    });
    const long = digestVerificationEnvironment({
      [PRODUCT_LAW_OBSERVATION_TIMEOUT_ENV]: '60000',
    });
    expect(explicitDefault).toBe(unset);
    expect(short).not.toBe(long);
    const shortRequest = buildRequest({ environmentDigest: short });
    const longRequest = buildRequest({ environmentDigest: long });
    expect(shortRequest.key).not.toBe(longRequest.key);
    expect(executionEquivalenceKey(shortRequest)).not.toBe(
      executionEquivalenceKey(longRequest),
    );
  });

  it('is deterministic for identical inputs', () => {
    expect(buildRequest().key).toBe(buildRequest().key);
  });

  it.each([
    ['missing', undefined],
    ['empty object', {}],
    ['non-hex digest', { digest: 'not-a-sha256-digest' }],
    ['uppercase digest', { digest: 'A'.repeat(64) }],
  ])('rejects a %s toolchain identity digest', (_label, toolchainIdentity) => {
    expect(() => buildRequest({ toolchainIdentity })).toThrow(
      /toolchainIdentity\.digest must be/,
    );
  });

  it.each([
    ['headSha', { headSha: 'b'.repeat(40) }],
    ['workspaceDigest', { workspaceDigest: 'b'.repeat(64) }],
    ['environmentDigest', { environmentDigest: 'b'.repeat(64) }],
    ['dependencyDigest', { dependencyDigest: 'b'.repeat(64) }],
    ['nodeVersion', { nodeVersion: 'v25.0.0' }],
    ['toolchain', { toolchain: 'npm@11.0.0' }],
    ['toolchainIdentity', { toolchainIdentity: { digest: 'b'.repeat(64) } }],
    ['platform', { platform: 'linux' }],
    ['arch', { arch: 'x64' }],
    ['repositoryId', { repositoryId: 'b'.repeat(64) }],
    ['worktree', { worktree: '/repo/other-worktree' }],
  ] as const)('invalidates the key when %s changes', (_field, override) => {
    const baseline = buildRequest().key;
    const changed = buildRequest(override).key;
    expect(changed).not.toBe(baseline);
  });

  it('invalidates the key when the lane (command and manifest) changes', () => {
    const ciFast = createVerificationRequest('ci-fast', provenance).key;
    const prepush = createVerificationRequest('prepush', provenance).key;
    expect(prepush).not.toBe(ciFast);
  });

  it('incorporates the lane manifest digest into the request identity', () => {
    const request = createVerificationRequest('prepush', provenance);
    expect(request.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(request.manifestDigest).not.toBe(
      createVerificationRequest('ci-fast', provenance).manifestDigest,
    );
  });

  it.each([
    ['repositoryId', {}],
    ['worktree', { repositoryId: hex(64) }],
    ['headSha', { repositoryId: hex(64), worktree: '/x' }],
    [
      'workspaceDigest',
      { repositoryId: hex(64), worktree: '/x', headSha: hex(40) },
    ],
  ] as const)('rejects a missing %s provenance field', (_field, partial) => {
    expect(() =>
      createVerificationRequest('ci-fast', partial as Provenance),
    ).toThrow(/must be a non-empty string/);
  });

  it('verificationRequestKey recomputes only the digest', () => {
    expect(verificationRequestKey('ci-fast', provenance)).toBe(
      buildRequest().key,
    );
  });
});

describe('classifyTerminal truth table', () => {
  const base = {
    exitCode: 0,
    provenanceStable: true,
    cleanupStatus: 'passed',
    survivingOwnedChildren: 0,
    counts: passingCounts,
  } as const;

  it('passes only for the one completed, stable, clean, zero-exit, fully-passing result', () => {
    expect(classifyTerminal({ status: 'completed', ...base }).passed).toBe(
      true,
    );
    expect(
      classifyTerminal({
        status: 'completed',
        ...base,
        cleanupStatus: 'not_required',
      }).passed,
    ).toBe(true);
  });

  it.each([
    ['failed', 'a non-completed terminal status'],
    ['infrastructure_error', 'a non-completed terminal status'],
    ['canceled', 'a non-completed terminal status'],
    ['timed_out', 'a non-completed terminal status'],
    ['rejected', 'a non-executed terminal status'],
    ['parser_error', 'an unparsed terminal status'],
    ['provisional', 'an interim terminal status'],
  ] as const)('never passes for status %s', (status) => {
    expect(classifyTerminal({ status, ...base }).passed).toBe(false);
  });

  it.each([
    ['non-zero exit', { exitCode: 1 }],
    ['null exit', { exitCode: null }],
    ['unstable provenance', { provenanceStable: false }],
    ['failed cleanup', { cleanupStatus: 'failed' }],
    ['missing cleanup status', { cleanupStatus: undefined }],
    ['surviving owned children', { survivingOwnedChildren: 1 }],
    [
      'skipped-only counts',
      {
        counts: { executed: 0, passed: 0, failed: 0, infrastructureErrors: 0 },
      },
    ],
    [
      'no passes counts',
      {
        counts: { executed: 3, passed: 0, failed: 0, infrastructureErrors: 0 },
      },
    ],
    [
      'failed counts',
      {
        counts: { executed: 2, passed: 1, failed: 1, infrastructureErrors: 0 },
      },
    ],
    [
      'infrastructure error counts',
      {
        counts: { executed: 2, passed: 2, failed: 0, infrastructureErrors: 1 },
      },
    ],
    [
      'partial counts (passed < executed, no skipped field)',
      {
        counts: { executed: 2, passed: 1, failed: 0, infrastructureErrors: 0 },
      },
    ],
    ['missing counts', { counts: undefined }],
  ] as const)('never passes for %s', (_label, override) => {
    expect(
      classifyTerminal({
        status: 'completed',
        ...base,
        ...override,
      }).passed,
    ).toBe(false);
  });

  it('rejects an unknown terminal status', () => {
    expect(() => classifyTerminal({ status: 'unknown', ...base })).toThrow(
      'unknown verification terminal status',
    );
  });

  it('normalizes a non-integer exit code to null while preserving status', () => {
    const terminal = classifyTerminal({
      status: 'failed',
      exitCode: Number.NaN,
      provenanceStable: true,
      cleanupStatus: 'passed',
      survivingOwnedChildren: 0,
      counts: passingCounts,
    });
    expect(terminal.exitCode).toBeNull();
    expect(terminal.passed).toBe(false);
    expect(terminal.status).toBe('failed');
  });
});

// station#3584: a run can be a clean, zero-exit, fully-passing phase whose
// own tracked-file tree moved during the window between its `before` and
// `after` provenance snapshots — a real ambiguity the phase's own output
// cannot speak to, not a defect. Reported as indeterminate ("re-run") rather
// than failed ("diagnose"), while `passed` itself stays exactly as
// fail-closed as before. Narrowed to provenance instability only — a failed
// cleanup or a surviving owned child stays a genuine, diagnosable failure
// (see the it.each below).
describe('classifyTerminal indeterminate (station#3584)', () => {
  const base = {
    status: 'completed',
    exitCode: 0,
    counts: passingCounts,
  } as const;

  // station#3584 review correction: the issue's original diagnosis ("a
  // joiner adopting an owner that never reached a valid terminal state") was
  // wrong — publishJoinedReceipt validates the owner's receipt with
  // receiptValidator + assertReceiptSemantics before ever adopting it, which
  // makes that scenario structurally impossible. The real mechanism is the
  // JOINER's own provenance drifting during its wait (workspaceDigest hashes
  // the tracked-file diff, and a wait can run minutes), and — after this fix
  // — the coordinator now retries-and-executes on that drift rather than
  // publishing a stale projection (see verification-coordinator.mjs's
  // publishJoinedReceipt). `indeterminate` is the residual: a directly-
  // executed run whose OWN tree drifted during its own runtime, which no
  // retry can resolve since the same race can recur. Only provenance
  // instability is eligible — never a cleanup problem or a surviving owned
  // child, even though either can co-occur with an otherwise-clean run: both
  // are real defects (this repo has a documented history of orphaned
  // processes wedging a host), and "re-run rather than diagnose" is exactly
  // wrong advice for one.
  it('marks provenance-only instability as indeterminate, not failed — passed stays false', () => {
    const terminal = classifyTerminal({
      ...base,
      provenanceStable: false,
      cleanupStatus: 'passed',
      survivingOwnedChildren: 0,
    });
    expect(terminal.passed).toBe(false);
    expect(terminal.indeterminate).toBe(true);
  });

  it('reproduces the exact station#3584 receipt shape as indeterminate', () => {
    // The issue's observed receipt: completed, exit 0, one executed phase,
    // one passed phase, zero failed, zero infrastructure errors — yet
    // passed: false. That combination has no support anywhere in the
    // counts or exit code; only provenance instability (the joiner's own
    // tracked-file tree moving during a wait, or a direct execution's tree
    // moving during its own run) can explain the false.
    const terminal = classifyTerminal({
      status: 'completed',
      exitCode: 0,
      provenanceStable: false,
      cleanupStatus: 'passed',
      survivingOwnedChildren: 0,
      counts: { executed: 1, passed: 1, failed: 0, infrastructureErrors: 0 },
    });
    expect(terminal).toEqual({
      status: 'completed',
      exitCode: 0,
      passed: false,
      indeterminate: true,
    });
  });

  it.each([
    [
      'a non-zero exit code',
      {
        exitCode: 1,
        provenanceStable: true,
        cleanupStatus: 'passed',
        survivingOwnedChildren: 0,
      },
    ],
    [
      'a failed phase in the counts',
      {
        provenanceStable: true,
        cleanupStatus: 'passed',
        survivingOwnedChildren: 0,
        counts: { executed: 2, passed: 1, failed: 1, infrastructureErrors: 0 },
      },
    ],
    [
      'an infrastructure error in the counts',
      {
        provenanceStable: true,
        cleanupStatus: 'passed',
        survivingOwnedChildren: 0,
        counts: { executed: 2, passed: 2, failed: 0, infrastructureErrors: 1 },
      },
    ],
    [
      // Reachable: verification-execution-lifecycle.mjs's
      // `if (cleanup?.errors.length) return {...result, cleanup: {status:
      // 'failed', survivingOwnedChildren: 0}}` preserves a zero-exit `result`
      // while reporting a cleanup error — a real "exited 0 but left something
      // un-reapable" run, not a bookkeeping artifact.
      'a failed cleanup with an otherwise clean run',
      {
        provenanceStable: true,
        cleanupStatus: 'failed',
        survivingOwnedChildren: 0,
      },
    ],
    [
      'a missing cleanup status with an otherwise clean run',
      {
        provenanceStable: true,
        cleanupStatus: undefined,
        survivingOwnedChildren: 0,
      },
    ],
    [
      // Reachability of this exact combination (status: 'completed', clean
      // counts, AND survivingOwnedChildren > 0) through the current
      // coordinator is not established either way by this fix's review —
      // every located production path that sets survivingOwnedChildren > 0
      // also sets a non-completed/non-zero-exit status. classifyTerminal is
      // a general-purpose pure function, and the policy is asserted
      // defensively regardless of today's reachability: a surviving owned
      // child must never be advertised as "re-run rather than diagnose".
      'a surviving owned child with an otherwise clean run',
      {
        provenanceStable: true,
        cleanupStatus: 'passed',
        survivingOwnedChildren: 1,
      },
    ],
    [
      // Discriminates isCleanExceptForProvenance's own cleanup/children
      // exclusion from the redundant `provenanceStable !== true` conjunct at
      // the classifyTerminal call site: with provenanceStable ALSO false,
      // that outer conjunct alone can no longer explain a correct `false`
      // here -- only the narrowing inside isCleanExceptForProvenance can.
      // (Caught a real gap: widening isCleanExceptForProvenance back to
      // ignore cleanup/children passed every other fixture in this file,
      // because they all pinned provenanceStable: true.)
      'a failed cleanup even when provenance ALSO drifted',
      {
        provenanceStable: false,
        cleanupStatus: 'failed',
        survivingOwnedChildren: 0,
      },
    ],
    [
      'a surviving owned child even when provenance ALSO drifted',
      {
        provenanceStable: false,
        cleanupStatus: 'passed',
        survivingOwnedChildren: 1,
      },
    ],
  ] as const)(
    'never marks a genuine failure backed by %s as indeterminate',
    (_label, override) => {
      const terminal = classifyTerminal({ ...base, ...override });
      expect(terminal.passed).toBe(false);
      expect(terminal.indeterminate).toBeUndefined();
    },
  );

  it('does not mark a non-completed status as indeterminate even with clean counts', () => {
    // status alone is real, corroborated information — canceled/timed_out/
    // rejected/etc. are not "no signal", so they stay a genuine non-pass.
    for (const status of [
      'failed',
      'infrastructure_error',
      'canceled',
      'timed_out',
      'rejected',
      'parser_error',
      'provisional',
    ] as const) {
      const terminal = classifyTerminal({
        status,
        exitCode: 0,
        provenanceStable: true,
        cleanupStatus: 'passed',
        survivingOwnedChildren: 0,
        counts: passingCounts,
      });
      expect(terminal.indeterminate).toBeUndefined();
    }
  });

  it('does not mark partial/unaccounted counts as indeterminate — the original fail-closed guard is unchanged', () => {
    // { executed: 2, passed: 1, failed: 0, infrastructureErrors: 0 } leaves
    // one test unaccounted for. That is deliberately still a hard, diagnosable
    // failure (isPassingCounts is false), not indeterminate.
    const terminal = classifyTerminal({
      status: 'completed',
      exitCode: 0,
      provenanceStable: true,
      cleanupStatus: 'passed',
      survivingOwnedChildren: 0,
      counts: { executed: 2, passed: 1, failed: 0, infrastructureErrors: 0 },
    });
    expect(terminal.passed).toBe(false);
    expect(terminal.indeterminate).toBeUndefined();
  });

  it('never marks a genuine pass as indeterminate', () => {
    const terminal = classifyTerminal({
      status: 'completed',
      exitCode: 0,
      provenanceStable: true,
      cleanupStatus: 'passed',
      survivingOwnedChildren: 0,
      counts: passingCounts,
    });
    expect(terminal.passed).toBe(true);
    expect(terminal.indeterminate).toBeUndefined();
  });
});

describe('createVerificationReceipt request binding', () => {
  it('rejects malformed reusable output bindings before constructing a passing receipt', () => {
    const request = createVerificationRequest('verify-e2e-full', provenance);
    expect(() =>
      createVerificationReceipt({
        request,
        status: 'completed',
        exitCode: 0,
        counts: passingCounts,
        cleanup: { status: 'passed', survivingOwnedChildren: 0 },
        before: provenance,
        after: provenance,
        reusableOutputs: [
          {
            path: '.kontourai/e2e-latest/',
            runId: '../unsafe',
            manifestDigest: hex(64),
            payloadDigest: hex(64),
          },
        ],
      }),
    ).toThrow('invalid identity');
    expect(() =>
      createVerificationReceipt({
        request,
        status: 'completed',
        exitCode: 0,
        counts: passingCounts,
        cleanup: { status: 'passed', survivingOwnedChildren: 0 },
        before: provenance,
        after: provenance,
        reusableOutputs: [
          {
            path: '.kontourai/e2e-latest/',
            runId: 'valid-run',
            manifestDigest: hex(64),
            payloadDigest: hex(64),
            extra: true,
          },
        ],
      }),
    ).toThrow('invalid identity');
  });

  it('produces an immutable-shape receipt tied to classifyTerminal', () => {
    const request = buildRequest();
    const receipt = createVerificationReceipt({
      request,
      disposition: 'executed',
      status: 'completed',
      exitCode: 0,
      counts: {
        executed: 2,
        passed: 2,
        failed: 0,
        infrastructureErrors: 0,
      },
      artifacts: [{ path: '.kontourai/x.json', sha256: hex(64) }],
      cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      before: provenance,
      after: provenance,
    });
    expect(receipt.schemaVersion).toBe(3);
    expect(receipt.disposition).toBe('executed');
    expect(receipt.terminal).toEqual({
      status: 'completed',
      exitCode: 0,
      passed: true,
    });
    expect(receipt.provenance).toEqual({
      stable: true,
      before: provenance,
      after: provenance,
    });
    expect(receipt.counts.failed).toBe(0);
    expect(receipt.artifacts).toHaveLength(1);
  });

  it('rejects a request that does not bind the before provenance', () => {
    const request = buildRequest();
    const otherProvenance = { ...provenance, headSha: '0'.repeat(40) };
    expect(() =>
      createVerificationReceipt({
        request,
        status: 'completed',
        exitCode: 0,
        counts: passingCounts,
        cleanup: { status: 'passed', survivingOwnedChildren: 0 },
        before: otherProvenance,
        after: otherProvenance,
      }),
    ).toThrow(/bind the before provenance/);
  });

  it('marks the receipt unstable and non-passing when the after identity drifts', () => {
    const request = buildRequest();
    const receipt = createVerificationReceipt({
      request,
      status: 'completed',
      exitCode: 0,
      counts: passingCounts,
      cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      before: provenance,
      after: { ...provenance, workspaceDigest: 'c'.repeat(64) },
    });
    expect(receipt.provenance.stable).toBe(false);
    expect(receipt.terminal.passed).toBe(false);
  });

  it('does not treat volatile machine telemetry as drift', () => {
    const request = buildRequest();
    const receipt = createVerificationReceipt({
      request,
      status: 'completed',
      exitCode: 0,
      counts: passingCounts,
      cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      before: provenance,
      after: {
        ...provenance,
        machine: {
          cpuCount: 64,
          totalMemoryBytes: 1,
          loadAverage: { 1: 50, 5: 50, 15: 50 },
          loadPerCpu: 5,
        },
      },
    });
    expect(receipt.provenance.stable).toBe(true);
    expect(receipt.terminal.passed).toBe(true);
  });

  it('rejects an unknown disposition', () => {
    expect(() =>
      createVerificationReceipt({
        request: buildRequest(),
        disposition: 'skipped',
        status: 'completed',
        exitCode: 0,
        counts: passingCounts,
        cleanup: { status: 'not_required', survivingOwnedChildren: 0 },
        before: provenance,
        after: provenance,
      }),
    ).toThrow('unknown receipt disposition');
  });

  it('rejects missing or non-integer counts', () => {
    expect(() =>
      createVerificationReceipt({
        request: buildRequest(),
        status: 'completed',
        exitCode: 0,
        counts: undefined,
        cleanup: { status: 'passed', survivingOwnedChildren: 0 },
        before: provenance,
        after: provenance,
      }),
    ).toThrow(/requires integer result counts/);
  });
});

// station#3584: build a full receipt (not just the bare classifyTerminal
// inputs) shaped like a directly-executed run whose own tree drifted during
// its own runtime — the residual case indeterminate exists for after this
// fix (a live JOIN no longer reaches this label at all: publishJoinedReceipt
// re-checks the joiner's own provenance after the wait and retries as a
// fresh execution on drift, see verification-coordinator.mjs) — so the
// indeterminate signal is proven end to end through the producer, not just
// the classifier.
describe('createVerificationReceipt indeterminate (station#3584)', () => {
  function buildProvenanceDriftedReceipt() {
    const request = buildRequest();
    // Status/exit/cleanup/counts are all clean; only the after provenance
    // disagrees with the before identity — a tracked-file edit landing
    // during this run's own execution window.
    return createVerificationReceipt({
      request,
      disposition: 'executed',
      status: 'completed',
      exitCode: 0,
      counts: passingCounts,
      cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      before: provenance,
      after: { ...provenance, workspaceDigest: 'c'.repeat(64) },
    });
  }

  it('reports a provenance-drifted receipt as indeterminate, not failed', () => {
    const receipt = buildProvenanceDriftedReceipt();
    expect(receipt.terminal.passed).toBe(false);
    expect(receipt.terminal.indeterminate).toBe(true);
    expect(receipt.terminal.status).toBe('completed');
    expect(receipt.terminal.exitCode).toBe(0);
  });

  it('accepts a genuinely indeterminate receipt through the semantic guard unchanged', () => {
    const receipt = buildProvenanceDriftedReceipt();
    expect(assertReceiptSemantics(receipt)).toBe(receipt);
  });

  // Delta-review item 2: classifyTerminal destructures
  // `survivingOwnedChildren = 0` (a parameter default), but
  // assertReceiptSemantics originally passed `cleanup?.survivingOwnedChildren`
  // with no default -- a cleanup object missing that key made
  // createVerificationReceipt emit `indeterminate: true` (via
  // classifyTerminal's default) while assertReceiptSemantics re-derived
  // `indeterminate: false` (undefined !== 0) and THREW on its own producer's
  // output. Unreachable via the schema (the field is required, every real
  // producer supplies it) but demonstrated directly here against the
  // producer, which does not itself enforce the schema.
  it('does not disagree with classifyTerminal when cleanup omits survivingOwnedChildren', () => {
    const request = buildRequest();
    const receipt = createVerificationReceipt({
      request,
      disposition: 'executed',
      status: 'completed',
      exitCode: 0,
      counts: passingCounts,
      cleanup: { status: 'passed' }, // no survivingOwnedChildren key
      before: provenance,
      after: { ...provenance, workspaceDigest: 'e'.repeat(64) },
    });
    expect(receipt.terminal.indeterminate).toBe(true);
    expect(() => assertReceiptSemantics(receipt)).not.toThrow();
  });

  it.each([
    [
      'a non-zero exit code',
      {
        status: 'completed' as const,
        exitCode: 1,
        counts: passingCounts,
        cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      },
    ],
    [
      'a failed phase',
      {
        status: 'completed' as const,
        exitCode: 0,
        counts: { executed: 2, passed: 1, failed: 1, infrastructureErrors: 0 },
        cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      },
    ],
    [
      'an infrastructure error',
      {
        status: 'completed' as const,
        exitCode: 0,
        counts: { executed: 2, passed: 2, failed: 0, infrastructureErrors: 1 },
        cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      },
    ],
    [
      // station#3584 review correction: excluded from indeterminate even
      // though it can co-occur with clean counts and exitCode 0 — a real
      // "exited zero but left something un-reapable" defect, not missing
      // information.
      'a failed cleanup',
      {
        status: 'completed' as const,
        exitCode: 0,
        counts: passingCounts,
        cleanup: { status: 'failed', survivingOwnedChildren: 0 },
      },
    ],
    [
      'a surviving owned child',
      {
        status: 'completed' as const,
        exitCode: 0,
        counts: passingCounts,
        cleanup: { status: 'passed', survivingOwnedChildren: 1 },
      },
    ],
  ])(
    'still reports a genuine failure backed by %s as failed, not indeterminate',
    (_label, fields) => {
      const request = buildRequest();
      const receipt = createVerificationReceipt({
        request,
        disposition: 'executed',
        ...fields,
        before: provenance,
        after: provenance,
      });
      expect(receipt.terminal.passed).toBe(false);
      expect(receipt.terminal.indeterminate).toBeUndefined();
      expect(assertReceiptSemantics(receipt)).toBe(receipt);
    },
  );

  it.each([
    [
      'a failed cleanup',
      {
        status: 'completed' as const,
        exitCode: 0,
        cleanup: { status: 'failed', survivingOwnedChildren: 0 },
      },
    ],
    [
      'a surviving owned child',
      {
        status: 'completed' as const,
        exitCode: 0,
        cleanup: { status: 'passed', survivingOwnedChildren: 1 },
      },
    ],
  ])(
    // Discriminates the shared isCleanExceptForProvenance predicate from the
    // redundant provenance-stability conjunct at each call site, at the full
    // receipt/producer layer (not just classifyTerminal): with the tree ALSO
    // drifted, only the predicate's own cleanup/children exclusion can keep
    // this correctly non-indeterminate.
    'still reports a genuine failure backed by %s as failed, not indeterminate, even when provenance ALSO drifted',
    (_label, fields) => {
      const request = buildRequest();
      const receipt = createVerificationReceipt({
        request,
        disposition: 'executed',
        ...fields,
        counts: passingCounts,
        before: provenance,
        after: { ...provenance, workspaceDigest: 'd'.repeat(64) },
      });
      expect(receipt.provenance.stable).toBe(false);
      expect(receipt.terminal.passed).toBe(false);
      expect(receipt.terminal.indeterminate).toBeUndefined();
      expect(assertReceiptSemantics(receipt)).toBe(receipt);
    },
  );

  it('rejects a forged receipt that launders a genuine failure into indeterminate', () => {
    const request = buildRequest();
    const genuineFailure = createVerificationReceipt({
      request,
      disposition: 'executed',
      status: 'completed',
      exitCode: 1,
      counts: passingCounts,
      cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      before: provenance,
      after: provenance,
    });
    const forged = {
      ...genuineFailure,
      terminal: { ...genuineFailure.terminal, indeterminate: true },
    };
    expect(() => assertReceiptSemantics(forged)).toThrow(
      /terminal\.indeterminate does not match/,
    );
  });

  it('rejects a forged receipt that launders a failed cleanup into indeterminate', () => {
    // The narrower policy's own regression surface: a forgery attempt that
    // specifically exploits the excluded (cleanup/children) branch, not just
    // the already-covered counts/exit branch above.
    const request = buildRequest();
    const failedCleanup = createVerificationReceipt({
      request,
      disposition: 'executed',
      status: 'completed',
      exitCode: 0,
      counts: passingCounts,
      cleanup: { status: 'failed', survivingOwnedChildren: 0 },
      before: provenance,
      after: provenance,
    });
    const forged = {
      ...failedCleanup,
      terminal: { ...failedCleanup.terminal, indeterminate: true },
    };
    expect(() => assertReceiptSemantics(forged)).toThrow(
      /terminal\.indeterminate does not match/,
    );
  });

  it('rejects a forged receipt that hides a genuine indeterminate as a diagnosable failure', () => {
    const receipt = buildProvenanceDriftedReceipt();
    const forged = {
      ...receipt,
      terminal: { ...receipt.terminal, indeterminate: undefined },
    };
    expect(() => assertReceiptSemantics(forged)).toThrow(
      /terminal\.indeterminate does not match/,
    );
  });

  it('rejects a forged receipt that pairs indeterminate: true with a forged pass', () => {
    const receipt = buildPassingReceipt();
    const forged = {
      ...receipt,
      terminal: { ...receipt.terminal, passed: true, indeterminate: true },
    };
    expect(() => assertReceiptSemantics(forged)).toThrow();
  });
});

describe('assertReceiptSemantics guards', () => {
  it('accepts a well-formed passing receipt and returns it', () => {
    const receipt = buildPassingReceipt();
    expect(assertReceiptSemantics(receipt)).toBe(receipt);
  });

  it('rejects an unsupported schema version', () => {
    const receipt = { ...buildPassingReceipt(), schemaVersion: 1 };
    expect(() => assertReceiptSemantics(receipt)).toThrow(
      'unsupported verification receipt schema version',
    );
  });

  it('rejects a request paired with a before provenance it does not describe', () => {
    const receipt = buildPassingReceipt();
    receipt.provenance.before = { ...provenance, repositoryId: 'b'.repeat(64) };
    expect(() => assertReceiptSemantics(receipt)).toThrow(
      /bind the before provenance/,
    );
  });

  it('rejects a recorded stability that does not match the before/after identity', () => {
    const receipt = buildPassingReceipt();
    // after still binds, so re-derived stability is true; lying stable=false
    // must be rejected rather than trusted.
    receipt.provenance.stable = false;
    expect(() => assertReceiptSemantics(receipt)).toThrow(
      /does not match the recorded before\/after identity/,
    );
  });

  it('rejects a passing claim on a drifted receipt', () => {
    const request = buildRequest();
    // Build an honestly-drifted (non-passing) receipt, then forge passed=true.
    const drifted = createVerificationReceipt({
      request,
      status: 'completed',
      exitCode: 0,
      counts: passingCounts,
      cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      before: provenance,
      after: { ...provenance, workspaceDigest: 'c'.repeat(64) },
    });
    const forged = {
      ...drifted,
      terminal: { ...drifted.terminal, passed: true },
    };
    expect(() => assertReceiptSemantics(forged)).toThrow(
      /drifted verification receipt cannot pass/,
    );
  });

  it('rejects a passing claim without complete passing counts', () => {
    const receipt = buildPassingReceipt();
    receipt.counts = {
      executed: 0,
      passed: 0,
      failed: 0,
      infrastructureErrors: 0,
    };
    expect(() => assertReceiptSemantics(receipt)).toThrow(
      /cannot pass without complete passing counts/,
    );
  });

  it('rejects a passing claim whose passed count is less than executed', () => {
    // Records carry no skipped field, so a pass requires passed === executed.
    // A forged receipt claiming passed=true with {executed:2, passed:1, ...}
    // leaves one test unaccounted for; the guard must not round it up to pass.
    const receipt = buildPassingReceipt();
    receipt.counts = {
      executed: 2,
      passed: 1,
      failed: 0,
      infrastructureErrors: 0,
    };
    expect(() => assertReceiptSemantics(receipt)).toThrow(
      /cannot pass without complete passing counts/,
    );
  });

  it('rejects a passing claim with failed cleanup', () => {
    const receipt = buildPassingReceipt();
    receipt.cleanup = { status: 'failed', survivingOwnedChildren: 0 };
    expect(() => assertReceiptSemantics(receipt)).toThrow(
      /cannot pass without successful cleanup/,
    );
  });

  it('rejects a passing claim with surviving owned children', () => {
    const receipt = buildPassingReceipt();
    receipt.cleanup = { status: 'passed', survivingOwnedChildren: 1 };
    expect(() => assertReceiptSemantics(receipt)).toThrow(
      /surviving owned children cannot pass/,
    );
  });
});

describe('request projection binding (tampered request field, key retained)', () => {
  // A key-only check is defeated by retaining the original request.key while
  // rewriting a request field: the key is re-derived from unchanged provenance,
  // so it still matches, yet a consumer reading request.command (or
  // manifestDigest, dependencyDigest, toolchain, …) trusts the forged value.
  // The guard must recompute the full canonical projection and compare every
  // field, not just the key.
  it.each([
    ['command', { command: 'npm run evil' }],
    ['manifestDigest', { manifestDigest: '0'.repeat(64) }],
    ['dependencyDigest', { dependencyDigest: '0'.repeat(64) }],
    ['nodeVersion', { nodeVersion: 'v99.0.0' }],
    ['toolchain', { toolchain: 'npm@99.0.0' }],
    ['toolchainIdentity', { toolchainIdentity: { digest: '0'.repeat(64) } }],
    ['platform', { platform: 'plan9' }],
    ['arch', { arch: 'z80' }],
    ['repositoryId', { repositoryId: 'b'.repeat(64) }],
    ['worktree', { worktree: '/repo/impostor' }],
    ['headSha', { headSha: 'f'.repeat(40) }],
    ['workspaceDigest', { workspaceDigest: 'd'.repeat(64) }],
    ['environmentDigest', { environmentDigest: 'd'.repeat(64) }],
  ])(
    'rejects a tampered request.%s that retained the original key',
    (_field, override) => {
      const receipt = buildPassingReceipt();
      // Tamper the request field but keep request.key at its original value.
      receipt.request = { ...receipt.request, ...override };
      expect(() => assertReceiptSemantics(receipt)).toThrow(
        /is not the canonical projection/,
      );
    },
  );

  it('rejects a tampered command that retained the key at production time', () => {
    // The producer itself must refuse to build a receipt whose request.command
    // does not match the lane catalog, even before the semantic guard runs.
    const request = buildRequest();
    const forged = { ...request, command: 'npm run evil' };
    expect(() =>
      createVerificationReceipt({
        request: forged,
        status: 'completed',
        exitCode: 0,
        counts: passingCounts,
        cleanup: { status: 'passed', survivingOwnedChildren: 0 },
        before: provenance,
        after: provenance,
      }),
    ).toThrow(/is not the canonical projection/);
  });

  it('accepts a receipt whose request is the exact canonical projection', () => {
    // Sanity: the honest projection (command derived from the lane, digest from
    // the manifest, identity from the provenance) is accepted — the binding is
    // exact, not over-strict.
    expect(() => assertReceiptSemantics(buildPassingReceipt())).not.toThrow();
  });
});

describe('artifact validation at runtime (equivalent to schema)', () => {
  // The semantic guard must validate every artifact's path and digest before
  // any pass/acceptance, mirroring the schema, so a receipt loaded from disk
  // or forged by hand cannot carry a path or digest the schema would reject.
  it.each([
    ['absolute path', { path: '/etc/passwd', sha256: hex(64) }],
    ['Windows drive path', { path: 'C:/secrets.txt', sha256: hex(64) }],
    [
      'path outside the .kontourai root',
      { path: 'result.json', sha256: hex(64) },
    ],
    ['leading traversal', { path: '../secret', sha256: hex(64) }],
    ['mid-path traversal', { path: '.kontourai/a/../../etc', sha256: hex(64) }],
    ['backslash in path', { path: '.kontourai/a\\b', sha256: hex(64) }],
    ['empty path', { path: '', sha256: hex(64) }],
    [
      'uppercase hex digest',
      { path: '.kontourai/x.json', sha256: 'A'.repeat(64) },
    ],
    ['too-short digest', { path: '.kontourai/x.json', sha256: hex(10) }],
    ['non-hex digest', { path: '.kontourai/x.json', sha256: 'z'.repeat(64) }],
    [
      'unknown artifact property',
      { path: '.kontourai/x.json', sha256: hex(64), evil: true },
    ],
    ['non-object artifact', '/etc/passwd'],
  ])(
    'assertReceiptSemantics rejects an artifact with %s',
    (_label, artifact) => {
      const receipt = buildPassingReceipt();
      receipt.artifacts = [artifact as object];
      expect(() => assertReceiptSemantics(receipt)).toThrow();
    },
  );

  it.each([
    ['absolute path', { path: '/etc/passwd', sha256: hex(64) }],
    ['backslash path', { path: '.kontourai/a\\b', sha256: hex(64) }],
    ['uppercase digest', { path: '.kontourai/x.json', sha256: 'A'.repeat(64) }],
  ])(
    'createVerificationReceipt rejects an artifact with %s at production',
    (_label, artifact) => {
      expect(() =>
        createVerificationReceipt({
          request: buildRequest(),
          status: 'completed',
          exitCode: 0,
          counts: passingCounts,
          artifacts: [artifact],
          cleanup: { status: 'passed', survivingOwnedChildren: 0 },
          before: provenance,
          after: provenance,
        }),
      ).toThrow();
    },
  );

  it('rejects a non-array artifacts field', () => {
    const receipt = buildPassingReceipt();
    receipt.artifacts = {
      path: '.kontourai/x.json',
      sha256: hex(64),
    } as object;
    expect(() => assertReceiptSemantics(receipt)).toThrow(
      /artifacts must be an array/,
    );
  });

  it('accepts a deep safe repo-local artifact path', () => {
    const receipt = buildPassingReceipt();
    receipt.artifacts = [
      {
        path: '.kontourai/veritas/evidence/proof-families/r.json',
        sha256: hex(64),
      },
    ];
    expect(() => assertReceiptSemantics(receipt)).not.toThrow();
  });
});

describe('collectRepositoryIdentity and toolchain', () => {
  const originUrl = execSync('git config --get remote.origin.url', {
    encoding: 'utf8',
  }).trim();

  // DELIBERATE DUPLICATION: `packages/contracts/src/__tests__/
  // git-remote-identity.test.ts` owns a second, overlapping canonicalization
  // table (station#1498 promoted `normalizeGitOrigin` into that package).
  // That one asserts the function as a contract in its own right; this one
  // asserts it as the receipt-identity path's dependency. Keep the two in
  // agreement; if they ever disagree, the disagreement IS the bug.
  it.each([
    ['scp ssh', 'git@github.com:kontourai/station.git'],
    ['https', 'https://github.com/kontourai/station.git'],
    ['ssh url', 'ssh://git@github.com/kontourai/station.git'],
    [
      'https with trailing .git and slash',
      'https://github.com/kontourai/station.git/',
    ],
  ])(
    'normalizes %s origin to one clone-path-independent form',
    (_label, url) => {
      expect(normalizeGitOrigin(url)).toBe('github.com/kontourai/station');
    },
  );

  it('returns the empty string for a missing origin', () => {
    expect(normalizeGitOrigin('')).toBe('');
    expect(normalizeGitOrigin(undefined as unknown as string)).toBe('');
  });

  it('derives repositoryId from the normalized origin independent of clone path', () => {
    const identity = collectRepositoryIdentity();
    const expected = createHash('sha256')
      .update(normalizeGitOrigin(originUrl))
      .digest('hex');
    expect(identity.repositoryId).toBe(expected);
    expect(identity.origin).toBe(normalizeGitOrigin(originUrl));
  });

  it('resolves the repository root and common git dir even from a subdirectory', () => {
    const root = collectRepositoryIdentity();
    const fromSubdir = collectRepositoryIdentity({
      cwd: resolve('scripts'),
    });
    expect(fromSubdir.repositoryRoot).toBe(root.repositoryRoot);
    expect(fromSubdir.commonGitDirectory).toBe(root.commonGitDirectory);
    expect(fromSubdir.worktree).toBe(root.worktree);
    expect(fromSubdir.worktree).toBe(realpathSync(resolve('.')));
    expect(fromSubdir.repositoryRoot).toBe(realpathSync(resolve('.')));
  });

  it('detects a package-manager toolchain distinct from the node version', () => {
    const toolchain = detectToolchainIdentity();
    expect(toolchain).toMatch(/^npm@\d+\.\d+\.\d+/);
    expect(toolchain).not.toBe(process.version);
  });

  it('collectVerificationProvenance carries the npm toolchain, not the node version', () => {
    const provenanceAll = collectVerificationProvenance();
    expect(provenanceAll.toolchain).toMatch(/^npm@/);
    expect(provenanceAll.toolchain).not.toBe(provenanceAll.nodeVersion);
    expect(provenanceAll.repositoryId).toMatch(/^[0-9a-f]{64}$/);
    expect(provenanceAll.environmentDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a changed or missing bound toolchain executable', () => {
    const toolchain = resolveVerificationToolchain();
    expect(assertVerificationToolchain(toolchain)).toEqual(toolchain.identity);
    expect(() =>
      assertVerificationToolchain({
        ...toolchain,
        identity: { ...toolchain.identity, digest: '0'.repeat(64) },
      }),
    ).toThrow('identity changed after request admission');
    expect(() =>
      assertVerificationToolchain({
        ...toolchain,
        npmExecutable: join(tmpdir(), 'station-missing-npm-cli.js'),
      }),
    ).toThrow('toolchain executable is not a regular file');
  });

  it('collectVerificationProvenance digests the Git-root lockfile from a subdirectory', () => {
    // The lockfile default must resolve to the repository root, not
    // process.cwd(). A coordinator that does not `cd` to the repo root still
    // has to digest the same package-lock.json — otherwise dependencyDigest
    // points at a file that does not exist (the prior bug) and invalidates
    // every receipt. Verified by spawning a real child in the scripts/ subdir.
    const root = collectRepositoryIdentity().repositoryRoot;
    const expected = digestVerificationDependencies(root);
    const moduleUrl = pathToFileURL(
      resolve(root, 'scripts/lib/test-reliability.mjs'),
    ).href;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import(${JSON.stringify(moduleUrl)}).then((m) => process.stdout.write(m.collectVerificationProvenance().dependencyDigest))`,
      ],
      { cwd: resolve(root, 'scripts'), encoding: 'utf8', windowsHide: true },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(expected);
  });

  it('collectVerificationProvenance honors an explicit lockfile override', () => {
    const root = collectRepositoryIdentity().repositoryRoot;
    const explicit = resolve(root, 'pnpm-lock.yaml');
    expect(
      collectVerificationProvenance({ lockfile: explicit }).dependencyDigest,
    ).toBe(digestVerificationDependencies(root, explicit));
  });

  it('honors an explicit cwd for repository, workspace, toolchain, and lockfile identity', () => {
    const root = mkdtempSync(join(tmpdir(), 'station-provenance-cwd-'));
    const nested = join(root, 'nested');
    const processCwd = process.cwd();
    try {
      mkdirSync(nested);
      writeFileSync(join(root, 'package-lock.json'), '{"name":"isolated"}\n');
      writeFileSync(join(root, 'tracked.txt'), 'tracked\n');
      execSync('git init --quiet', { cwd: root });
      execSync('git config user.email station@example.test', { cwd: root });
      execSync('git config user.name Station', { cwd: root });
      execSync('git remote add origin https://example.test/station.git', {
        cwd: root,
      });
      execSync('git add package-lock.json tracked.txt', { cwd: root });
      execSync('git commit --quiet -m initial', { cwd: root });

      const provenance = collectVerificationProvenance({ cwd: nested });
      expect(process.cwd()).toBe(processCwd);
      expect(provenance.repositoryRoot).toBe(realpathSync(root));
      expect(provenance.worktree).toBe(realpathSync(root));
      expect(provenance.dependencyDigest).toBe(
        digestRepositoryFile(join(root, 'package-lock.json')),
      );
      expect(provenance.toolchain).toMatch(/^npm@/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('collects identical stable provenance from the root and a subdirectory', () => {
    // workspaceDigest must not depend on the caller's working directory. The
    // workspace helper roots its git commands and untracked-file reads at the
    // Git top-level, so a coordinator invoking it from scripts/ hashes the
    // same full untracked set (and the same lockfile) as a root invocation.
    // Only volatile machine telemetry may differ.
    const sourceRoot = collectRepositoryIdentity().repositoryRoot;
    const moduleUrl = pathToFileURL(
      resolve(sourceRoot, 'scripts/lib/test-reliability.mjs'),
    ).href;
    const root = mkdtempSync(join(tmpdir(), 'station-provenance-stable-'));
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'package-lock.json'), '{"name":"isolated"}\n');
    writeFileSync(join(root, 'tracked.txt'), 'stable\n');
    execSync('git init --quiet', { cwd: root });
    execSync('git config user.email station@example.test', { cwd: root });
    execSync('git config user.name Station', { cwd: root });
    execSync('git remote add origin https://example.test/station.git', {
      cwd: root,
    });
    execSync('git add package-lock.json tracked.txt', { cwd: root });
    execSync('git commit --quiet -m initial', { cwd: root });
    const collectFrom = (cwd: string) => {
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import(${JSON.stringify(moduleUrl)}).then((m) => process.stdout.write(JSON.stringify(m.collectVerificationProvenance())))`,
        ],
        { cwd, encoding: 'utf8', windowsHide: true },
      );
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    try {
      const fromRoot = collectFrom(root);
      const fromScripts = collectFrom(resolve(root, 'scripts'));
      expect(fromScripts.workspaceDigest).toBe(fromRoot.workspaceDigest);
      expect(fromScripts.dependencyDigest).toBe(fromRoot.dependencyDigest);
      expect(fromScripts.headSha).toBe(fromRoot.headSha);
      expect(fromScripts.repositoryId).toBe(fromRoot.repositoryId);
      expect(fromScripts.worktree).toBe(fromRoot.worktree);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('verification receipt JSON schema (Ajv)', () => {
  // The published schema is portable standard JSON Schema Draft 2020-12 and
  // compiles under Ajv's default options — no $data or other nonstandard
  // extensions required. It structurally enforces passing counts (executed >=
  // 1, passed >= 1, failed === 0, infrastructureErrors === 0) but, because
  // standard JSON Schema cannot express cross-property integer equality, it
  // does NOT enforce passed === executed. That count-completeness equality is
  // an explicit runtime semantic guard (isPassingCounts / classifyTerminal /
  // assertReceiptSemantics), proven below and in the guard suites.
  const validate = new Ajv2020({ allErrors: true }).compile(schema);
  const passing = buildPassingReceipt();

  it('compiles cleanly under strict schema and type validation', () => {
    // The schema must be well-formed under Ajv's strictest compile settings —
    // no unknown keywords, no ignored types — so a lenient default is not
    // silently absorbing a malformed contract. strictSchema/strictTypes set to
    // 'error' turn strict warnings into compile failures. No nonstandard
    // options ($data, ajv-keywords, …) are required: the schema is portable
    // standard Draft 2020-12.
    const strictAjv = new Ajv2020({
      allErrors: true,
      strict: true,
      strictSchema: 'error',
      strictTypes: 'error',
    });
    expect(() => strictAjv.compile(schema)).not.toThrow();
  });

  it('accepts a receipt produced by the canonical producer', () => {
    const ok = validate(passing);
    expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it('accepts a not_required-cleanup passing receipt', () => {
    const receipt = buildPassingReceipt();
    receipt.cleanup.status = 'not_required';
    expect(validate(receipt), JSON.stringify(validate.errors)).toBe(true);
  });

  it('accepts an honestly non-passing drifted receipt', () => {
    const receipt = createVerificationReceipt({
      request: buildRequest(),
      status: 'completed',
      exitCode: 0,
      counts: passingCounts,
      cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      before: provenance,
      after: { ...provenance, workspaceDigest: 'c'.repeat(64) },
    });
    expect(validate(receipt), JSON.stringify(validate.errors, null, 2)).toBe(
      true,
    );
  });

  it('accepts a parser_error receipt that does not claim a pass', () => {
    const receipt = buildPassingReceipt();
    receipt.terminal = { status: 'parser_error', exitCode: 0, passed: false };
    receipt.provenance.stable = true;
    expect(validate(receipt), JSON.stringify(validate.errors)).toBe(true);
  });

  it('accepts a queue-rejected receipt that does not claim a pass', () => {
    const receipt = createVerificationReceipt({
      request: buildRequest(),
      status: 'rejected',
      exitCode: null,
      counts: { executed: 0, passed: 0, failed: 0, infrastructureErrors: 0 },
      cleanup: { status: 'not_required', survivingOwnedChildren: 0 },
      before: provenance,
      after: provenance,
    });
    expect(validate(receipt), JSON.stringify(validate.errors)).toBe(true);
    expect(receipt.terminal.passed).toBe(false);
  });

  const negativeFixtures: Array<[string, object]> = [
    ['wrong schema version', { ...passing, schemaVersion: 1 }],
    [
      'missing top-level cleanup',
      (({ cleanup: _cleanup, ...rest }) => rest)(passing),
    ],
    ['additional top-level property', { ...passing, surprise: true }],
    [
      'request repositoryId is not a 64-hex digest',
      {
        ...passing,
        request: { ...passing.request, repositoryId: 'not-a-digest' },
      },
    ],
    [
      'request headSha is not a 40-hex sha',
      {
        ...passing,
        request: { ...passing.request, headSha: 'deadbeef' },
      },
    ],
    [
      'terminal passed but status is failed',
      {
        ...passing,
        terminal: { ...passing.terminal, status: 'failed' },
      },
    ],
    [
      'terminal passed but exit code is non-zero',
      {
        ...passing,
        terminal: { ...passing.terminal, exitCode: 1 },
      },
    ],
    [
      'terminal passed but provenance is unstable',
      {
        ...passing,
        provenance: { ...passing.provenance, stable: false },
      },
    ],
    [
      'terminal passed but owned children survive',
      {
        ...passing,
        cleanup: { ...passing.cleanup, survivingOwnedChildren: 1 },
      },
    ],
    [
      'terminal passed but cleanup failed',
      {
        ...passing,
        cleanup: { ...passing.cleanup, status: 'failed' },
      },
    ],
    [
      'terminal passed but counts are empty',
      {
        ...passing,
        counts: { executed: 0, passed: 0, failed: 0, infrastructureErrors: 0 },
      },
    ],
    [
      'terminal passed but failed count is non-zero',
      {
        ...passing,
        counts: { executed: 2, passed: 1, failed: 1, infrastructureErrors: 0 },
      },
    ],
    [
      'non-completed status claims a pass (parser_error)',
      {
        ...passing,
        terminal: { status: 'parser_error', exitCode: 0, passed: true },
      },
    ],
    [
      'non-completed status claims a pass (provisional)',
      {
        ...passing,
        terminal: { status: 'provisional', exitCode: 0, passed: true },
      },
    ],
    ['unknown disposition', { ...passing, disposition: 'skipped' }],
    [
      'counts missing a required field',
      {
        ...passing,
        counts: { executed: 1, passed: 1, failed: 0 },
      },
    ],
    [
      'cleanup status outside the enum',
      {
        ...passing,
        cleanup: { ...passing.cleanup, status: 'maybe' },
      },
    ],
    [
      'artifact missing its sha256',
      {
        ...passing,
        artifacts: [{ path: '.kontourai/x.json' }],
      },
    ],
    [
      'artifact with an absolute path',
      {
        ...passing,
        artifacts: [{ path: '/etc/passwd', sha256: hex(64) }],
      },
    ],
    [
      'artifact outside the .kontourai root',
      {
        ...passing,
        artifacts: [{ path: 'result.json', sha256: hex(64) }],
      },
    ],
    [
      'artifact with a traversal path',
      {
        ...passing,
        artifacts: [{ path: '../secret', sha256: hex(64) }],
      },
    ],
    [
      'artifact with a mid-path traversal',
      {
        ...passing,
        artifacts: [{ path: 'a/../../etc', sha256: hex(64) }],
      },
    ],
    [
      'artifact with a Windows drive path',
      {
        ...passing,
        artifacts: [{ path: 'C:/secrets.txt', sha256: hex(64) }],
      },
    ],
    // station#3584: indeterminate is schema-restricted to exactly the
    // completed/exit-0/non-passing shape it describes.
    [
      'indeterminate: true paired with a claimed pass',
      {
        ...passing,
        terminal: { ...passing.terminal, indeterminate: true },
      },
    ],
    [
      'indeterminate: true on a non-completed status',
      {
        ...passing,
        terminal: {
          status: 'failed',
          exitCode: 1,
          passed: false,
          indeterminate: true,
        },
      },
    ],
    [
      'indeterminate: true with a non-zero exit code',
      {
        ...passing,
        terminal: {
          status: 'completed',
          exitCode: 1,
          passed: false,
          indeterminate: true,
        },
      },
    ],
    [
      'indeterminate: false (only true is a valid value)',
      { ...passing, terminal: { ...passing.terminal, indeterminate: false } },
    ],
  ];

  it.each(negativeFixtures)('rejects %s', (_label, fixture) => {
    const ok = validate(fixture);
    expect(ok, JSON.stringify(validate.errors, null, 2)).toBe(false);
  });

  it('accepts a station#3584 indeterminate receipt (completed, exit 0, clean counts, unsupported false)', () => {
    const receipt = createVerificationReceipt({
      request: buildRequest(),
      disposition: 'joined',
      status: 'completed',
      exitCode: 0,
      counts: passingCounts,
      cleanup: { status: 'passed', survivingOwnedChildren: 0 },
      before: provenance,
      after: { ...provenance, workspaceDigest: 'c'.repeat(64) },
    });
    expect(receipt.terminal.indeterminate).toBe(true);
    expect(validate(receipt), JSON.stringify(validate.errors, null, 2)).toBe(
      true,
    );
  });

  it('does NOT enforce passed === executed — that equality is a runtime guard only', () => {
    // Standard JSON Schema cannot express cross-property integer equality, so
    // the portable schema enforces only structural passing positivity
    // (executed >= 1, passed >= 1, failed === 0, infrastructureErrors === 0).
    // A forged receipt claiming passed=true with partial counts
    // { executed: 2, passed: 1, ... } is therefore SCHEMA-VALID. The exact
    // count-completeness equality is enforced only by the runtime semantic
    // guard (isPassingCounts / classifyTerminal / assertReceiptSemantics), so
    // a true pass requires acceptance by both the schema and the guard.
    const partialCounts = {
      ...passing,
      counts: { executed: 2, passed: 1, failed: 0, infrastructureErrors: 0 },
    };
    expect(validate(partialCounts), JSON.stringify(validate.errors)).toBe(true);
    const receipt = buildPassingReceipt();
    receipt.counts = partialCounts.counts;
    expect(() => assertReceiptSemantics(receipt)).toThrow(
      /cannot pass without complete passing counts/,
    );
  });

  it('accepts deep repo-local artifact paths', () => {
    const receipt = buildPassingReceipt();
    receipt.artifacts = [
      {
        path: '.kontourai/veritas/evidence/proof-families/r.json',
        sha256: hex(64),
      },
    ];
    expect(validate(receipt), JSON.stringify(validate.errors)).toBe(true);
  });

  it('reports the schema version violation by keyword', () => {
    validate({ ...passing, schemaVersion: 1 });
    const errors = validate.errors as ErrorObject[] | null;
    expect(errors).not.toBeNull();
    expect(errors!.some((e) => e.keyword === 'const')).toBe(true);
  });
});
