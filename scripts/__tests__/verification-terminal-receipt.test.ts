import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { __verificationCoordinatorInternals } from '../lib/verification-coordinator.mjs';
import { reportExecution } from '../lib/verification-terminal-receipt.mjs';

const roots: string[] = [];

function changedDiagnostic(provenance: Record<string, string>) {
  return {
    schemaVersion: 1,
    kind: 'station-test-changed-diagnostics',
    complete: true,
    incompleteReasons: [] as string[],
    base: 'origin/main',
    mergeBase: 'base-sha',
    changedPathCount: 1,
    provenance,
    selection: {
      relatedPathCount: 1,
      exactTestCount: 0,
      deferredLanes: [],
      escalated: false,
    },
    counts: {
      executed: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      todo: 0,
      infrastructureErrors: 0,
      parserErrors: 0,
      emptyReports: 0,
    },
    executions: [
      {
        kind: 'related',
        exitCode: 0,
        infrastructureError: false,
        counts: { executed: 1, passed: 1, failed: 0, skipped: 0, todo: 0 },
        failedTests: [],
        failureIdentityCount: 0,
        omittedFailureIdentities: 0,
        failureIdentitiesComplete: true,
      },
    ],
  };
}

function writeChangedDiagnosticBundle(
  diagnosticRoot: string,
  diagnostic: ReturnType<typeof changedDiagnostic> & Record<string, unknown>,
) {
  const contents = `${JSON.stringify(diagnostic)}\n`;
  writeFileSync(join(diagnosticRoot, 'changed-diagnostics.json'), contents);
  writeFileSync(
    join(diagnosticRoot, 'changed-verification.json'),
    `${JSON.stringify({
      request: { laneId: 'test-changed' },
      provenance: { before: diagnostic.provenance },
      artifacts: [
        {
          path: '.kontourai/test-impact/changed-diagnostics.json',
          sha256: createHash('sha256').update(contents).digest('hex'),
        },
      ],
    })}\n`,
  );
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test('rounds a successful command with incomplete output retention to nonpass', () => {
  const worktree = mkdtempSync(join(tmpdir(), 'station-terminal-receipt-'));
  roots.push(worktree);
  const reported = reportExecution({
    raw: {
      output: {
        truncated: true,
        stdout: { text: 'retained prefix' },
        stderr: { text: '' },
      },
    },
    result: {
      status: 'completed',
      exitCode: 0,
      counts: {
        executed: 1,
        passed: 1,
        failed: 0,
        infrastructureErrors: 0,
      },
    },
    cleanup: { status: 'not_required', survivingOwnedChildren: 0 },
    worktree,
    request: { key: 'a'.repeat(64) },
  });

  expect(reported.outputTruncated).toBe(true);
  expect(reported.result).toMatchObject({
    status: 'infrastructure_error',
    exitCode: null,
    counts: {
      executed: 1,
      passed: 0,
      failed: 0,
      infrastructureErrors: 1,
    },
  });
  expect(reported.summary).toMatchObject({
    terminal: 'infrastructure_error',
    counts: { passed: 0, infrastructureErrors: 1 },
  });
  expect(reported.artifacts).toHaveLength(2);
});

// station#3189: reportExecution is the seam between the raw captured output
// and every terminal-receipt consumer (boundedSummaryEnvelope, the CLI
// summary, docs/strategy/multi-agent-delivery-protocol.md's guidance). This
// proves the scoped excerpt and the new failingStep field survive that seam
// for a realistic chained-gate capture, not just the unit-level fixture in
// verification-reporter.test.ts.
test('reports the excerpt and step from the phase that actually failed (station#3189)', () => {
  const worktree = mkdtempSync(join(tmpdir(), 'station-terminal-receipt-'));
  roots.push(worktree);
  const chainedOutput = [
    '> @kontourai/station-core@0.0.0 lint:check',
    '> biome check src-server/',
    '',
    'src-ui/src/__tests__/homeVariantRegistry.test.tsx:41:9 suppressions/unused ━━━━━━━━━━',
    'Checked 1913 files. Found 374 warnings.',
    '',
    '> @kontourai/station-core@0.0.0 typecheck:scripts',
    '> node scripts/scripts-typecheck-coverage.mjs',
    '',
    "scripts/__tests__/backlog-priority-policy.test.ts(92,9): error TS2322: Type '{ maxActionableP1: number; }' is not assignable to type 'Readonly<{ maxActionableP1: null; }>'.",
  ].join('\n');
  const reported = reportExecution({
    raw: {
      output: {
        truncated: false,
        stdout: { text: chainedOutput },
        stderr: { text: '' },
      },
    },
    result: {
      status: 'failed',
      exitCode: 1,
      counts: { executed: 1, passed: 0, failed: 1, infrastructureErrors: 0 },
    },
    cleanup: { status: 'passed', survivingOwnedChildren: 0 },
    worktree,
    request: { key: 'a'.repeat(64) },
  });

  expect(reported.summary.failingStep).toBe('typecheck:scripts');
  expect(reported.summary.firstCausalExcerpt).toContain('TS2322');
  expect(reported.summary.firstCausalExcerpt).not.toContain(
    'suppressions/unused',
  );
});

// station#4249: causalExcerpts must survive the same reportExecution seam
// firstCausalExcerpt does, and report every distinct failing check the
// captured output actually shows rather than only the first.
test('reports every distinct causal excerpt through the reportExecution seam (station#4249)', () => {
  const worktree = mkdtempSync(join(tmpdir(), 'station-terminal-receipt-'));
  roots.push(worktree);
  const multiFailureOutput = [
    '> station@0.1.0 test:full:raw',
    ' FAIL  src-ui/src/__tests__/One.test.tsx > renders',
    'AssertionError: one',
    ' FAIL  src-ui/src/__tests__/Two.test.tsx > loads',
    'AssertionError: two',
  ].join('\n');
  const reported = reportExecution({
    raw: {
      output: {
        truncated: false,
        stdout: { text: multiFailureOutput },
        stderr: { text: '' },
      },
    },
    result: {
      status: 'failed',
      exitCode: 1,
      counts: { executed: 2, passed: 0, failed: 2, infrastructureErrors: 0 },
    },
    cleanup: { status: 'passed', survivingOwnedChildren: 0 },
    worktree,
    request: { key: 'a'.repeat(64) },
  });

  expect(reported.summary.causalExcerpts).toEqual([
    ' FAIL  src-ui/src/__tests__/One.test.tsx > renders',
    ' FAIL  src-ui/src/__tests__/Two.test.tsx > loads',
  ]);
  expect(reported.summary.causalExcerpts?.[0]).toBe(
    reported.summary.firstCausalExcerpt,
  );
  // station#4249 review: the disambiguator is ABSENT here -- this is an
  // ordinary observed failure (real captured output), not the
  // reporting-pipeline-failure case, and `reconcileNote`'s absence is what a
  // reader relies on to tell the two apart.
  expect(reported.summary.reconcileNote).toBeUndefined();
});

test('attaches the required changed-test diagnostic to a ci-fast owner result', () => {
  const worktree = mkdtempSync(join(tmpdir(), 'station-ci-fast-diagnostic-'));
  roots.push(worktree);
  const diagnosticRoot = join(worktree, '.kontourai/test-impact');
  mkdirSync(diagnosticRoot, { recursive: true });
  const provenance = {
    repositoryId: 'a'.repeat(64),
    headSha: 'b'.repeat(40),
    workspaceDigest: 'c'.repeat(64),
    environmentDigest: 'd'.repeat(64),
    dependencyDigest: 'e'.repeat(64),
  };
  writeChangedDiagnosticBundle(diagnosticRoot, {
    ...changedDiagnostic(provenance),
    counts: {
      executed: 1,
      passed: 0,
      failed: 1,
      skipped: 0,
      todo: 0,
      infrastructureErrors: 0,
      parserErrors: 0,
      emptyReports: 0,
    },
    executions: [
      {
        kind: 'related',
        exitCode: 1,
        infrastructureError: false,
        counts: { executed: 1, passed: 0, failed: 1, skipped: 0, todo: 0 },
        failedTests: [
          {
            file: 'example.test.ts',
            name: 'preserves failure identity',
            excerpt: 'Authorization: Bearer fixture-ci-fast-secret',
          },
        ],
        failureIdentityCount: 1,
        omittedFailureIdentities: 0,
        failureIdentitiesComplete: true,
      },
    ],
  });
  const raw = __verificationCoordinatorInternals.attachCiFastDiagnostics(
    {
      lane: { id: 'ci-fast' },
      before: { worktree, ...provenance },
    },
    { output: { stdout: { text: '' }, stderr: { text: '' } } },
  );
  const reported = reportExecution({
    raw,
    result: {
      status: 'failed',
      exitCode: 1,
      counts: { executed: 1, passed: 0, failed: 1, infrastructureErrors: 0 },
    },
    cleanup: { status: 'not_required', survivingOwnedChildren: 0 },
    worktree,
    request: { key: 'b'.repeat(64) },
  });

  expect(reported.result.status).toBe('failed');
  expect(reported.artifacts).toHaveLength(3);
  const attachment = reported.artifacts[2];
  const contents = readFileSync(join(worktree, attachment.path), 'utf8');
  expect(contents).toContain('preserves failure identity');
  expect(contents).toContain('[REDACTED]');
  expect(contents).not.toContain('fixture-ci-fast-secret');
});

test('fails a ci-fast owner result closed when changed-test diagnostics are missing', () => {
  const worktree = mkdtempSync(join(tmpdir(), 'station-ci-fast-diagnostic-'));
  roots.push(worktree);
  const raw = __verificationCoordinatorInternals.attachCiFastDiagnostics(
    {
      lane: { id: 'ci-fast' },
      before: { worktree },
    },
    { output: { stdout: { text: '' }, stderr: { text: '' } } },
  );
  const reported = reportExecution({
    raw,
    result: {
      status: 'completed',
      exitCode: 0,
      counts: { executed: 1, passed: 1, failed: 0, infrastructureErrors: 0 },
    },
    cleanup: { status: 'not_required', survivingOwnedChildren: 0 },
    worktree,
    request: { key: 'c'.repeat(64) },
  });

  expect(reported.result.status).toBe('infrastructure_error');
  expect(reported.artifacts).toEqual([]);
});

test('fails a ci-fast owner result closed when diagnostics came from stale provenance', () => {
  const worktree = mkdtempSync(join(tmpdir(), 'station-ci-fast-diagnostic-'));
  roots.push(worktree);
  const diagnosticRoot = join(worktree, '.kontourai/test-impact');
  mkdirSync(diagnosticRoot, { recursive: true });
  writeChangedDiagnosticBundle(
    diagnosticRoot,
    changedDiagnostic({
      repositoryId: 'a'.repeat(64),
      headSha: 'stale',
      workspaceDigest: 'c'.repeat(64),
      environmentDigest: 'd'.repeat(64),
      dependencyDigest: 'e'.repeat(64),
    }),
  );
  const raw = __verificationCoordinatorInternals.attachCiFastDiagnostics(
    {
      lane: { id: 'ci-fast' },
      before: {
        worktree,
        repositoryId: 'a'.repeat(64),
        headSha: 'b'.repeat(40),
        workspaceDigest: 'c'.repeat(64),
        environmentDigest: 'd'.repeat(64),
        dependencyDigest: 'e'.repeat(64),
      },
    },
    { output: { stdout: { text: '' }, stderr: { text: '' } } },
  );
  const reported = reportExecution({
    raw,
    result: {
      status: 'completed',
      exitCode: 0,
      counts: { executed: 1, passed: 1, failed: 0, infrastructureErrors: 0 },
    },
    cleanup: { status: 'not_required', survivingOwnedChildren: 0 },
    worktree,
    request: { key: 'd'.repeat(64) },
  });

  expect(reported.result.status).toBe('infrastructure_error');
  expect(reported.artifacts).toEqual([]);
});

test('binds a bound but incomplete diagnostic instead of calling the lane broken', () => {
  const worktree = mkdtempSync(join(tmpdir(), 'station-ci-fast-diagnostic-'));
  roots.push(worktree);
  const diagnosticRoot = join(worktree, '.kontourai/test-impact');
  mkdirSync(diagnosticRoot, { recursive: true });
  const provenance = {
    repositoryId: 'a'.repeat(64),
    headSha: 'b'.repeat(40),
    workspaceDigest: 'c'.repeat(64),
    environmentDigest: 'd'.repeat(64),
    dependencyDigest: 'e'.repeat(64),
  };
  // A real red run whose failures outran the retained-identity bound. The
  // diagnostic is this run's and self-consistent; it is simply not a complete
  // account, which is a test result to read, not a harness fault (#1737).
  writeChangedDiagnosticBundle(diagnosticRoot, {
    ...changedDiagnostic(provenance),
    complete: false,
    incompleteReasons: [
      'related: 25 failing test(s), 25 identified, 5 omitted',
    ],
    counts: {
      executed: 25,
      passed: 0,
      failed: 25,
      skipped: 0,
      todo: 0,
      infrastructureErrors: 0,
      parserErrors: 0,
      emptyReports: 0,
    },
    executions: [
      {
        kind: 'related',
        exitCode: 1,
        infrastructureError: false,
        counts: { executed: 25, passed: 0, failed: 25, skipped: 0, todo: 0 },
        failedTests: Array.from({ length: 20 }, (_, index) => ({
          file: 'example.test.ts',
          name: `failure ${index}`,
          excerpt: 'boom',
        })),
        failureIdentityCount: 25,
        omittedFailureIdentities: 5,
        failureIdentitiesComplete: false,
      },
    ],
  });
  const raw = __verificationCoordinatorInternals.attachCiFastDiagnostics(
    {
      lane: { id: 'ci-fast' },
      before: { worktree, ...provenance },
    },
    { output: { stdout: { text: '' }, stderr: { text: '' } } },
  );
  expect(raw.unavailableAttachments).toBeUndefined();
  const reported = reportExecution({
    raw,
    result: {
      status: 'failed',
      exitCode: 1,
      counts: { executed: 1, passed: 0, failed: 1, infrastructureErrors: 0 },
    },
    cleanup: { status: 'not_required', survivingOwnedChildren: 0 },
    worktree,
    request: { key: '1'.repeat(64) },
  });

  expect(reported.result.status).toBe('failed');
  expect(reported.artifacts).toHaveLength(3);
  expect(
    readFileSync(join(worktree, reported.artifacts[2].path), 'utf8'),
  ).toContain('25 failing test(s), 25 identified, 5 omitted');
});

test('names why a ci-fast diagnostic was unavailable instead of a file extension', () => {
  const worktree = mkdtempSync(join(tmpdir(), 'station-ci-fast-diagnostic-'));
  roots.push(worktree);
  const raw = __verificationCoordinatorInternals.attachCiFastDiagnostics(
    {
      lane: { id: 'ci-fast' },
      before: { worktree },
    },
    { output: { stdout: { text: '' }, stderr: { text: '' } } },
  );
  // The rejected-extension trick is gone: no attachment is claimed at all.
  expect(raw.attachments).toEqual([]);
  expect(raw.unavailableAttachments).toEqual([
    {
      name: 'changed-test-diagnostics',
      reason:
        'this run wrote no readable changed-verification diagnostic and receipt',
    },
  ]);
  const reported = reportExecution({
    raw,
    result: {
      status: 'completed',
      exitCode: 0,
      counts: { executed: 1, passed: 1, failed: 0, infrastructureErrors: 0 },
    },
    cleanup: { status: 'not_required', survivingOwnedChildren: 0 },
    worktree,
    request: { key: '2'.repeat(64) },
  });

  expect(reported.result.status).toBe('infrastructure_error');
  expect(reported.summary.firstCausalExcerpt).toBe(
    'verification reporting failed: required attachment unavailable: changed-test-diagnostics (this run wrote no readable changed-verification diagnostic and receipt)',
  );
});

test('fails a ci-fast owner result closed for wrong-kind diagnostics', () => {
  const worktree = mkdtempSync(join(tmpdir(), 'station-ci-fast-diagnostic-'));
  roots.push(worktree);
  const diagnosticRoot = join(worktree, '.kontourai/test-impact');
  mkdirSync(diagnosticRoot, { recursive: true });
  const provenance = {
    repositoryId: 'a'.repeat(64),
    headSha: 'b'.repeat(40),
    workspaceDigest: 'c'.repeat(64),
    environmentDigest: 'd'.repeat(64),
    dependencyDigest: 'e'.repeat(64),
  };
  writeChangedDiagnosticBundle(diagnosticRoot, {
    ...changedDiagnostic(provenance),
    kind: 'wrong-kind',
  });
  const raw = __verificationCoordinatorInternals.attachCiFastDiagnostics(
    {
      lane: { id: 'ci-fast' },
      before: { worktree, ...provenance },
    },
    { output: { stdout: { text: '' }, stderr: { text: '' } } },
  );
  const reported = reportExecution({
    raw,
    result: {
      status: 'completed',
      exitCode: 0,
      counts: { executed: 1, passed: 1, failed: 0, infrastructureErrors: 0 },
    },
    cleanup: { status: 'not_required', survivingOwnedChildren: 0 },
    worktree,
    request: { key: 'e'.repeat(64) },
  });

  expect(reported.result.status).toBe('infrastructure_error');
  expect(reported.artifacts).toEqual([]);
});

test('fails a ci-fast owner result closed for inconsistent digest-bound counts', () => {
  const worktree = mkdtempSync(join(tmpdir(), 'station-ci-fast-diagnostic-'));
  roots.push(worktree);
  const diagnosticRoot = join(worktree, '.kontourai/test-impact');
  mkdirSync(diagnosticRoot, { recursive: true });
  const provenance = {
    repositoryId: 'a'.repeat(64),
    headSha: 'b'.repeat(40),
    workspaceDigest: 'c'.repeat(64),
    environmentDigest: 'd'.repeat(64),
    dependencyDigest: 'e'.repeat(64),
  };
  const impossible = changedDiagnostic(provenance);
  impossible.counts.failed = 1;
  writeChangedDiagnosticBundle(diagnosticRoot, impossible);
  const raw = __verificationCoordinatorInternals.attachCiFastDiagnostics(
    {
      lane: { id: 'ci-fast' },
      before: { worktree, ...provenance },
    },
    { output: { stdout: { text: '' }, stderr: { text: '' } } },
  );
  const reported = reportExecution({
    raw,
    result: {
      status: 'completed',
      exitCode: 0,
      counts: { executed: 1, passed: 1, failed: 0, infrastructureErrors: 0 },
    },
    cleanup: { status: 'not_required', survivingOwnedChildren: 0 },
    worktree,
    request: { key: 'f'.repeat(64) },
  });

  expect(reported.result.status).toBe('infrastructure_error');
  expect(reported.artifacts).toEqual([]);
});

test('preserves failures from coherent executions when a sibling diagnostic record is malformed', () => {
  const worktree = mkdtempSync(join(tmpdir(), 'station-ci-fast-diagnostic-'));
  roots.push(worktree);
  const diagnosticRoot = join(worktree, '.kontourai/test-impact');
  mkdirSync(diagnosticRoot, { recursive: true });
  const provenance = {
    repositoryId: 'a'.repeat(64),
    headSha: 'b'.repeat(40),
    workspaceDigest: 'c'.repeat(64),
    environmentDigest: 'd'.repeat(64),
    dependencyDigest: 'e'.repeat(64),
  };
  writeChangedDiagnosticBundle(diagnosticRoot, {
    ...changedDiagnostic(provenance),
    counts: {
      executed: 2,
      passed: 0,
      failed: 1,
      skipped: 0,
      todo: 0,
      infrastructureErrors: 1,
      parserErrors: 0,
      emptyReports: 0,
    },
    executions: [
      {
        kind: 'related',
        exitCode: 1,
        infrastructureError: false,
        counts: { executed: 1, passed: 0, failed: 1, skipped: 0, todo: 0 },
        failedTests: [
          {
            file: 'real-failure.test.ts',
            name: 'does not get masked',
            excerpt: 'expected true to be false',
          },
        ],
        failureIdentityCount: 1,
        omittedFailureIdentities: 0,
        failureIdentitiesComplete: true,
      },
      { kind: 'explicit', exitCode: null, infrastructureError: true },
    ],
  });
  const raw = __verificationCoordinatorInternals.attachCiFastDiagnostics(
    { lane: { id: 'ci-fast' }, before: { worktree, ...provenance } },
    { output: { stdout: { text: '' }, stderr: { text: '' } } },
  );
  const reported = reportExecution({
    raw,
    result: {
      status: 'failed',
      exitCode: 1,
      counts: { executed: 1, passed: 0, failed: 1, infrastructureErrors: 0 },
    },
    cleanup: { status: 'not_required', survivingOwnedChildren: 0 },
    worktree,
    request: { key: 'a'.repeat(64) },
  });

  expect(raw.unavailableAttachments?.[0]?.reason).toContain(
    'did not reconcile',
  );
  expect(reported.result.status).toBe('failed');
  expect(reported.summary).toMatchObject({
    terminal: 'failed',
    firstCausalExcerpt: expect.stringContaining('did not reconcile'),
    causalExcerpts: [expect.stringContaining('did not reconcile')],
    // station#4249 review: the disambiguator -- present because this is the
    // reporting-failure case, not an ordinary observed failure.
    reconcileNote: expect.stringContaining('did not reconcile'),
    failedTests: [
      {
        file: 'real-failure.test.ts',
        name: 'does not get masked',
        excerpt: 'expected true to be false',
      },
    ],
  });
});

test('keeps an unrecoverably malformed ci-fast diagnostic as infrastructure_error', () => {
  const worktree = mkdtempSync(join(tmpdir(), 'station-ci-fast-diagnostic-'));
  roots.push(worktree);
  const diagnosticRoot = join(worktree, '.kontourai/test-impact');
  mkdirSync(diagnosticRoot, { recursive: true });
  const provenance = {
    repositoryId: 'a'.repeat(64),
    headSha: 'b'.repeat(40),
    workspaceDigest: 'c'.repeat(64),
    environmentDigest: 'd'.repeat(64),
    dependencyDigest: 'e'.repeat(64),
  };
  writeChangedDiagnosticBundle(diagnosticRoot, {
    ...changedDiagnostic(provenance),
    executions: [
      { kind: 'explicit', exitCode: null, infrastructureError: true },
    ],
  });
  const raw = __verificationCoordinatorInternals.attachCiFastDiagnostics(
    { lane: { id: 'ci-fast' }, before: { worktree, ...provenance } },
    { output: { stdout: { text: '' }, stderr: { text: '' } } },
  );
  const reported = reportExecution({
    raw,
    result: {
      status: 'completed',
      exitCode: 0,
      counts: { executed: 1, passed: 1, failed: 0, infrastructureErrors: 0 },
    },
    cleanup: { status: 'not_required', survivingOwnedChildren: 0 },
    worktree,
    request: { key: 'b'.repeat(64) },
  });

  expect(reported.result.status).toBe('infrastructure_error');
  expect(reported.summary.failedTests).toBeUndefined();
  // station#4249 review: the second reportExecution catch branch (an
  // unrecoverable reporting failure with no preserved failed-exit result)
  // must carry causalExcerpts in parity with firstCausalExcerpt -- a reader
  // who only checks the plural field must see the same reporting-failure
  // cause the singular field already names.
  expect(reported.summary.causalExcerpts).toEqual([
    reported.summary.firstCausalExcerpt,
  ]);
  // The disambiguating field itself: present because this is the
  // reporting-failure case, and equal to what causalExcerpts repeats.
  expect(reported.summary.reconcileNote).toBe(
    reported.summary.firstCausalExcerpt,
  );
});

test('recovered evidence rides the reported result for canonical persistence (sol #2654 finding 1)', () => {
  const worktree = mkdtempSync(join(tmpdir(), 'station-ci-fast-diagnostic-'));
  roots.push(worktree);
  const diagnosticRoot = join(worktree, '.kontourai/test-impact');
  mkdirSync(diagnosticRoot, { recursive: true });
  const provenance = {
    repositoryId: 'a'.repeat(64),
    headSha: 'b'.repeat(40),
    workspaceDigest: 'c'.repeat(64),
    environmentDigest: 'd'.repeat(64),
    dependencyDigest: 'e'.repeat(64),
  };
  writeChangedDiagnosticBundle(diagnosticRoot, {
    ...changedDiagnostic(provenance),
    counts: {
      executed: 2,
      passed: 0,
      failed: 1,
      skipped: 0,
      todo: 0,
      infrastructureErrors: 1,
      parserErrors: 0,
      emptyReports: 0,
    },
    executions: [
      {
        kind: 'related',
        exitCode: 1,
        infrastructureError: false,
        counts: { executed: 1, passed: 0, failed: 1, skipped: 0, todo: 0 },
        failedTests: [
          { file: 'real.test.ts', name: 'persists', excerpt: 'boom' },
        ],
        failureIdentityCount: 1,
        omittedFailureIdentities: 0,
        failureIdentitiesComplete: true,
      },
      { kind: 'explicit', exitCode: null, infrastructureError: true },
    ],
  });
  const raw = __verificationCoordinatorInternals.attachCiFastDiagnostics(
    { lane: { id: 'ci-fast' }, before: { worktree, ...provenance } },
    { output: { stdout: { text: '' }, stderr: { text: '' } } },
  );
  const reported = reportExecution({
    raw,
    result: {
      status: 'failed',
      exitCode: 1,
      counts: { executed: 1, passed: 0, failed: 1, infrastructureErrors: 0 },
    },
    cleanup: { status: 'not_required', survivingOwnedChildren: 0 },
    worktree,
    request: { key: 'a'.repeat(64) },
  });

  // The persistable evidence is on the RESULT (which flows into
  // createVerificationReceipt), not only the transient summary.
  expect(reported.result.recoveredFailures).toEqual([
    { file: 'real.test.ts', name: 'persists' },
  ]);
  expect(reported.result.reconcileNote).toContain('did not reconcile');
});

test('excess failure identities are capped at the execution counts (sol #2654 finding 2)', () => {
  const worktree = mkdtempSync(join(tmpdir(), 'station-ci-fast-diagnostic-'));
  roots.push(worktree);
  const diagnosticRoot = join(worktree, '.kontourai/test-impact');
  mkdirSync(diagnosticRoot, { recursive: true });
  const provenance = {
    repositoryId: 'a'.repeat(64),
    headSha: 'b'.repeat(40),
    workspaceDigest: 'c'.repeat(64),
    environmentDigest: 'd'.repeat(64),
    dependencyDigest: 'e'.repeat(64),
  };
  writeChangedDiagnosticBundle(diagnosticRoot, {
    ...changedDiagnostic(provenance),
    counts: {
      executed: 3,
      passed: 2,
      failed: 1,
      skipped: 0,
      todo: 0,
      infrastructureErrors: 1,
      parserErrors: 0,
      emptyReports: 0,
    },
    executions: [
      {
        kind: 'related',
        exitCode: 1,
        infrastructureError: false,
        counts: { executed: 3, passed: 2, failed: 1, skipped: 0, todo: 0 },
        failedTests: [
          { file: 'a.test.ts', name: 'one', excerpt: 'x' },
          { file: 'b.test.ts', name: 'two', excerpt: 'y' },
        ],
        failureIdentityCount: 2,
        omittedFailureIdentities: 0,
        failureIdentitiesComplete: true,
      },
      { kind: 'explicit', exitCode: null, infrastructureError: true },
    ],
  });
  const raw = __verificationCoordinatorInternals.attachCiFastDiagnostics(
    { lane: { id: 'ci-fast' }, before: { worktree, ...provenance } },
    { output: { stdout: { text: '' }, stderr: { text: '' } } },
  );
  const reported = reportExecution({
    raw,
    result: {
      status: 'failed',
      exitCode: 1,
      counts: { executed: 3, passed: 2, failed: 1, infrastructureErrors: 0 },
    },
    cleanup: { status: 'not_required', survivingOwnedChildren: 0 },
    worktree,
    request: { key: 'a'.repeat(64) },
  });

  // counts.failed = 1 governs — the second identity must not inflate.
  expect(reported.result.counts.failed).toBe(1);
  expect(reported.result.recoveredFailures.length).toBe(1);
  expect(reported.summary.failedTests.length).toBe(1);
});

describe('reportExecution preserves genuine failures (station#4173)', () => {
  test('a failed result with an unavailable required attachment stays failed', () => {
    const reported = reportExecution({
      raw: {
        unavailableAttachments: [
          {
            name: 'changed-test-diagnostics',
            reason:
              'this run wrote no readable changed-verification diagnostic and receipt',
          },
        ],
      },
      result: {
        status: 'failed',
        exitCode: 1,
        counts: { executed: 1, passed: 0, failed: 1, infrastructureErrors: 0 },
      },
      cleanup: { status: 'not_required', survivingOwnedChildren: 0 },
      worktree: process.cwd(),
      request: { key: 'a'.repeat(64) },
    });
    expect(reported.result.status).toBe('failed');
    expect(reported.result.exitCode).toBe(1);
    expect(reported.result.counts).toMatchObject({
      failed: 1,
      infrastructureErrors: 0,
    });
    expect(reported.result.reconcileNote).toContain(
      'required attachment unavailable',
    );
    expect(reported.summary.terminal).toBe('failed');
  });

  test('a result that claimed success still loses standing without its evidence', () => {
    const reported = reportExecution({
      raw: {
        unavailableAttachments: [
          { name: 'changed-test-diagnostics', reason: 'missing' },
        ],
      },
      result: {
        status: 'completed',
        exitCode: 0,
        counts: { executed: 1, passed: 1, failed: 0, infrastructureErrors: 0 },
      },
      cleanup: { status: 'not_required', survivingOwnedChildren: 0 },
      worktree: process.cwd(),
      request: { key: 'b'.repeat(64) },
    });
    expect(reported.result.status).toBe('infrastructure_error');
    expect(reported.result.counts).toMatchObject({
      failed: 0,
      infrastructureErrors: 1,
    });
  });
});
