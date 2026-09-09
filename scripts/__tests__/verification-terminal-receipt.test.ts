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

/** The terminal escape byte, spelled rather than embedded in source. */
const ESC = String.fromCharCode(27);

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

test('retained ci-fast diagnostics accept resource groups and discovery preparation failures', () => {
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
      {
        ...changedDiagnostic(provenance).executions[0],
        kind: 'combined',
        resourceGroup: 'ordinary',
      },
    ],
  });
  const combined = __verificationCoordinatorInternals.attachCiFastDiagnostics(
    {
      lane: { id: 'ci-fast' },
      before: { worktree, ...provenance },
    },
    { output: { stdout: { text: '' }, stderr: { text: '' } } },
  );
  expect(combined.unavailableAttachments).toBeUndefined();

  writeChangedDiagnosticBundle(diagnosticRoot, {
    ...changedDiagnostic(provenance),
    complete: false,
    incompleteReasons: ['related-discovery: discovery failed'],
    counts: {
      executed: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      todo: 0,
      infrastructureErrors: 1,
      parserErrors: 0,
      emptyReports: 0,
    },
    preparation: {
      phase: 'related-discovery',
      childStarted: true,
      infrastructureError: true,
      error: 'discovery failed',
      errorTruncated: false,
    },
    executions: [],
  });
  const discovery = __verificationCoordinatorInternals.attachCiFastDiagnostics(
    {
      lane: { id: 'ci-fast' },
      before: { worktree, ...provenance },
    },
    { output: { stdout: { text: '' }, stderr: { text: '' } } },
  );
  expect(discovery.unavailableAttachments).toBeUndefined();

  writeChangedDiagnosticBundle(diagnosticRoot, {
    ...changedDiagnostic(provenance),
    complete: false,
    incompleteReasons: ['related-discovery: discovery failed'],
    counts: {
      executed: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      todo: 0,
      infrastructureErrors: 1,
      parserErrors: 0,
      emptyReports: 0,
    },
    preparation: {
      phase: 'related-discovery',
      childStarted: 'yes',
      infrastructureError: true,
      error: 'discovery failed',
      errorTruncated: false,
    },
    executions: [],
  });
  const malformed = __verificationCoordinatorInternals.attachCiFastDiagnostics(
    {
      lane: { id: 'ci-fast' },
      before: { worktree, ...provenance },
    },
    { output: { stdout: { text: '' }, stderr: { text: '' } } },
  );
  expect(malformed.unavailableAttachments?.[0]?.reason).toContain(
    'did not reconcile with its own executions',
  );

  writeChangedDiagnosticBundle(diagnosticRoot, {
    ...changedDiagnostic(provenance),
    complete: false,
    incompleteReasons: [`resource-plan: ${'x'.repeat(2_049)}`],
    counts: {
      executed: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      todo: 0,
      infrastructureErrors: 1,
      parserErrors: 0,
      emptyReports: 0,
    },
    preparation: {
      phase: 'resource-plan',
      childStarted: false,
      infrastructureError: true,
      error: 'x'.repeat(2_049),
      errorTruncated: false,
    },
    executions: [],
  });
  const oversized = __verificationCoordinatorInternals.attachCiFastDiagnostics(
    {
      lane: { id: 'ci-fast' },
      before: { worktree, ...provenance },
    },
    { output: { stdout: { text: '' }, stderr: { text: '' } } },
  );
  expect(oversized.unavailableAttachments?.[0]?.reason).toContain(
    'did not reconcile with its own executions',
  );
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

test('binds a reporter-only nonzero exit instead of treating passed assertions as green', () => {
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
  const diagnostic = changedDiagnostic(provenance);
  diagnostic.complete = false;
  diagnostic.incompleteReasons = [
    'related: Vitest exited 1 without reporting a failed test',
  ];
  diagnostic.executions[0].exitCode = 1;
  writeChangedDiagnosticBundle(diagnosticRoot, diagnostic);

  const raw = __verificationCoordinatorInternals.attachCiFastDiagnostics(
    { lane: { id: 'ci-fast' }, before: { worktree, ...provenance } },
    { output: { stdout: { text: '' }, stderr: { text: '' } } },
  );

  expect(raw.unavailableAttachments).toBeUndefined();
  expect(raw.attachments).toEqual([
    expect.objectContaining({ name: 'changed-test-diagnostics' }),
  ]);
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

  test.each([
    [
      'timeout',
      { status: 'timed_out', exitCode: null },
      undefined,
      'verification execution timed out before terminal reporting',
    ],
    [
      'cancellation',
      { status: 'canceled', exitCode: null },
      undefined,
      'verification execution was canceled before terminal reporting',
    ],
    [
      'spawn failure',
      { status: 'infrastructure_error', exitCode: null },
      new Error('spawn EACCES'),
      'verification execution infrastructure error: spawn EACCES',
    ],
  ] as const)(
    'keeps a primary %s terminal cause ahead of an unavailable changed diagnostic',
    (_label, terminal, error, primaryCause) => {
      const reported = reportExecution({
        raw: {
          ...(error ? { error } : {}),
          unavailableAttachments: [
            { name: 'changed-test-diagnostics', reason: 'missing' },
          ],
        },
        result: {
          ...terminal,
          counts: {
            executed: 1,
            passed: 0,
            failed: 0,
            infrastructureErrors: 1,
          },
        },
        cleanup: { status: 'not_required', survivingOwnedChildren: 0 },
        worktree: process.cwd(),
        request: { key: 'c'.repeat(64) },
      });

      expect(reported.result.status).toBe(terminal.status);
      expect(reported.summary.firstCausalExcerpt).toBe(primaryCause);
      expect(reported.summary.causalExcerpts).toEqual([
        primaryCause,
        'verification reporting failed: required attachment unavailable: changed-test-diagnostics (missing)',
      ]);
      expect(reported.summary.reconcileNote).toContain(
        'required attachment unavailable',
      );
    },
  );
});

/**
 * station#1827.
 *
 * The literal string a PASSING knowledge-store test prints on purpose. On
 * PR #1787 (run 34301492334) the receipt named it as the cause of a lane the
 * ci:fast runner had killed for exceeding its feedback budget: the scan
 * matched `/^\s*Error:\s/`, nothing matched the runner's own owner-final
 * line, and the recovered cause was discarded on the ordinary path.
 *
 * It is in both fixtures below for one reason: without a line the scan WOULD
 * have chosen, a test asserting the budget message proves only that the noise
 * happened not to be there.
 */
const SCANNED_DECOY_DIAGNOSTIC = '          Error: observer failed';
const BUDGET_CAUSE = 'ci:fast exceeded its 12-minute feedback budget';
const OWNER_FINAL_STDERR = `[station-ci-fast-owner-final] ${BUDGET_CAUSE}\n`;

/**
 * A ci-fast owner capture shaped like the live one: a digest-bound, coherent
 * changed-verification diagnostic (so `reportExecution` takes its ORDINARY,
 * non-throwing path — the path that had never executed with an owner-final
 * line present), stdout carrying the decoy, stderr ending in the owner-final
 * line, and the cause the lifecycle recovers from it.
 */
function ciFastBudgetKillRaw(worktree: string) {
  const diagnosticRoot = join(worktree, '.kontourai/test-impact');
  mkdirSync(diagnosticRoot, { recursive: true });
  const provenance = {
    repositoryId: 'a'.repeat(64),
    headSha: 'b'.repeat(40),
    workspaceDigest: 'c'.repeat(64),
    environmentDigest: 'd'.repeat(64),
    dependencyDigest: 'e'.repeat(64),
  };
  writeChangedDiagnosticBundle(diagnosticRoot, changedDiagnostic(provenance));
  return {
    ...__verificationCoordinatorInternals.attachCiFastDiagnostics(
      { lane: { id: 'ci-fast' }, before: { worktree, ...provenance } },
      {
        output: {
          stdout: { text: `${SCANNED_DECOY_DIAGNOSTIC}\n` },
          stderr: { text: OWNER_FINAL_STDERR },
        },
      },
    ),
    infrastructureCause: BUDGET_CAUSE,
  };
}

test("the ci-fast runner's own budget cause outranks a scanned excerpt on the ordinary path (station#1827)", () => {
  const worktree = mkdtempSync(join(tmpdir(), 'station-1827-ordinary-'));
  roots.push(worktree);
  const raw = ciFastBudgetKillRaw(worktree);
  const reported = reportExecution({
    raw,
    result: {
      status: 'infrastructure_error',
      exitCode: null,
      counts: { executed: 1, passed: 0, failed: 0, infrastructureErrors: 1 },
    },
    cleanup: { status: 'not_required', survivingOwnedChildren: 0 },
    worktree,
    request: { key: 'a'.repeat(64) },
  });

  // The ordinary path, not a reporting-pipeline failure: `reconcileNote`'s
  // absence is what says so (docs/reference/verification-receipts.md).
  expect(reported.summary.reconcileNote).toBeUndefined();
  expect(reported.summary.firstCausalExcerpt).toBe(BUDGET_CAUSE);
  // The invariant this file states twice: the two fields never disagree.
  expect(reported.summary.causalExcerpts[0]).toBe(
    reported.summary.firstCausalExcerpt,
  );
  // The scanned evidence is RANKED BELOW the cause, not discarded: the scan
  // is a second line, and demoting it must not delete it.
  expect(reported.summary.causalExcerpts).toContain(SCANNED_DECOY_DIAGNOSTIC);
  // The caveat `verification-gate-summary.mjs` renders for `causeStream`
  // says the excerpt "was picked by severity and position". Nothing picked
  // this one, so printing that sentence would be a false claim.
  expect(reported.summary.causeStream).toBeUndefined();
  // Persistable: `publishTerminalReceipt` spreads the RESULT into
  // `createVerificationReceipt`, so the summary alone would leave the
  // canonical receipt carrying no cause at all.
  expect(reported.result.infrastructureCause).toBe(BUDGET_CAUSE);
});

test('an ordinary failing lane still reports its scanned excerpt (station#1827)', () => {
  const worktree = mkdtempSync(join(tmpdir(), 'station-1827-failed-'));
  roots.push(worktree);
  // Byte-identical capture, including the owner-final line and the recovered
  // cause. Only the terminal differs -- the cause outranks the scan for the
  // status it explains and for no other, so a `failed` lane is unchanged.
  const raw = ciFastBudgetKillRaw(worktree);
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

  expect(reported.summary.firstCausalExcerpt).toBe(SCANNED_DECOY_DIAGNOSTIC);
  expect(reported.summary.causalExcerpts[0]).toBe(SCANNED_DECOY_DIAGNOSTIC);
  expect(reported.summary.causalExcerpts).not.toContain(BUDGET_CAUSE);
  expect(reported.result.infrastructureCause).toBeUndefined();
});

/**
 * station#1827 review item 1: the OTHER channel a runner declares its own stop
 * on. `createOwnedRunner` returns `{ status: null, error: Error(...) }` for a
 * surviving owned process, an unreadable capture and a spawn failure, on every
 * lane -- `primaryInterruptedCause` has always reported it, and threading only
 * `raw.infrastructureCause` left it computed-and-dropped on the ordinary path
 * for the same status.
 */
test("the owned runner's own error message is the cause when no owner-final line was printed (station#1827)", () => {
  const worktree = mkdtempSync(join(tmpdir(), 'station-1827-sibling-'));
  roots.push(worktree);
  const reported = reportExecution({
    raw: {
      // No ci-fast attachment contract here: this shape reaches the ordinary
      // path on ANY lane, which is the reachability the review established.
      error: { message: 'owned verification process survived cleanup' },
      output: {
        stdout: { text: `${SCANNED_DECOY_DIAGNOSTIC}\n` },
        stderr: { text: '' },
      },
    },
    result: {
      status: 'infrastructure_error',
      exitCode: null,
      counts: { executed: 1, passed: 0, failed: 0, infrastructureErrors: 1 },
    },
    cleanup: { status: 'failed', survivingOwnedChildren: 0 },
    worktree,
    request: { key: 'a'.repeat(64) },
  });

  expect(reported.summary.reconcileNote).toBeUndefined();
  expect(reported.summary.firstCausalExcerpt).toBe(
    'owned verification process survived cleanup',
  );
  expect(reported.summary.causalExcerpts).toContain(SCANNED_DECOY_DIAGNOSTIC);
  expect(reported.result.infrastructureCause).toBe(
    'owned verification process survived cleanup',
  );
});

test('the owner-final line outranks the runner error message when both spoke (station#1827)', () => {
  const worktree = mkdtempSync(join(tmpdir(), 'station-1827-precedence-'));
  roots.push(worktree);
  // Both channels, different text. `primaryInterruptedCause` has always read
  // them in this order; the ordinary path must not invert it, or the two
  // paths would name different causes for one run again.
  const reported = reportExecution({
    raw: {
      infrastructureCause: BUDGET_CAUSE,
      error: { message: 'owned verification process survived cleanup' },
      output: {
        stdout: { text: `${SCANNED_DECOY_DIAGNOSTIC}\n` },
        stderr: { text: OWNER_FINAL_STDERR },
      },
    },
    result: {
      status: 'infrastructure_error',
      exitCode: null,
      counts: { executed: 1, passed: 0, failed: 0, infrastructureErrors: 1 },
    },
    cleanup: { status: 'not_required', survivingOwnedChildren: 0 },
    worktree,
    request: { key: 'a'.repeat(64) },
  });

  expect(reported.result.infrastructureCause).toBe(BUDGET_CAUSE);
  expect(reported.summary.firstCausalExcerpt).toBe(BUDGET_CAUSE);
});

/**
 * station#1827 review item 2. The comment on the summary/receipt fork promises
 * they never name different causes; these are the two inputs that used to
 * break it, because the reporter normalized and `boundedText` did not.
 */
test('the summary and the receipt hold the same normalized cause bytes (station#1827)', () => {
  const worktree = mkdtempSync(join(tmpdir(), 'station-1827-normalize-'));
  roots.push(worktree);
  const run = (raw: Record<string, unknown>) =>
    reportExecution({
      raw: {
        ...raw,
        output: {
          stdout: { text: `${SCANNED_DECOY_DIAGNOSTIC}\n` },
          stderr: { text: '' },
        },
      },
      result: {
        status: 'infrastructure_error',
        exitCode: null,
        counts: { executed: 1, passed: 0, failed: 0, infrastructureErrors: 1 },
      },
      cleanup: { status: 'not_required', survivingOwnedChildren: 0 },
      worktree,
      request: { key: 'a'.repeat(64) },
    });

  // Whitespace-only is not a declaration. It used to reach the receipt as
  // `"   "` while the summary named the decoy -- two artifacts, two answers.
  const blank = run({ infrastructureCause: '   ' });
  expect(blank.result.infrastructureCause).toBeUndefined();
  expect(blank.summary.firstCausalExcerpt).toBe(SCANNED_DECOY_DIAGNOSTIC);
  expect(blank.summary.infrastructureCause).toBeUndefined();

  // A coloured declaration: the summary stripped the escapes, the receipt kept
  // them. Worse, `boundedText` redacts WITHOUT stripping first, which is the
  // ordering the reporter's own comment calls unsafe for a secret split by an
  // escape sequence.
  const coloured = run({
    infrastructureCause: `${ESC}[31mci:fast exceeded its budget${ESC}[0m`,
  });
  expect(coloured.result.infrastructureCause).toBe(
    'ci:fast exceeded its budget',
  );
  expect(coloured.result.infrastructureCause).toBe(
    coloured.summary.firstCausalExcerpt,
  );
  expect(coloured.result.infrastructureCause).toBe(
    coloured.summary.infrastructureCause,
  );
  expect(coloured.result.infrastructureCause).not.toContain(ESC);

  // The escape-split secret the ordering exists for. The discriminating shape
  // is a token whose CHARACTER CLASS the escape breaks: `ghp_[A-Za-z0-9]{36,}`
  // sees 20 alphanumerics and stops, so redacting before stripping leaves the
  // token whole and the later strip reassembles it into the receipt. A
  // `Bearer <token>` fixture proves nothing here -- that pattern matches the
  // escape bytes too and redacts under either order.
  const secret = run({
    infrastructureCause: `stopped after ghp_${'A'.repeat(20)}${ESC}[0m${'B'.repeat(20)}`,
  });
  expect(secret.result.infrastructureCause).toContain('[REDACTED]');
  expect(secret.result.infrastructureCause).not.toContain('ghp_');
  expect(secret.result.infrastructureCause).not.toContain('B'.repeat(20));
});

/**
 * station#1827 review item 4: the reconcile branch. `primaryInterruptedCause`
 * has always put the cause in the SUMMARY here; the branch that puts it on the
 * preserved result -- and therefore into the canonical receipt -- had no
 * assertion of its own, so deleting it was caught by nothing.
 */
test("a reporting-pipeline failure still records the runner's cause on the preserved result (station#1827)", () => {
  const worktree = mkdtempSync(join(tmpdir(), 'station-1827-reconcile-'));
  roots.push(worktree);
  const reported = reportExecution({
    raw: {
      infrastructureCause: BUDGET_CAUSE,
      // Forces the catch branch: a required attachment the lane could not
      // bind. `preservesPrimaryTerminal` then keeps the primary terminal.
      unavailableAttachments: [
        { name: 'changed-test-diagnostics', reason: 'missing' },
      ],
      output: {
        stdout: { text: `${SCANNED_DECOY_DIAGNOSTIC}\n` },
        stderr: { text: OWNER_FINAL_STDERR },
      },
    },
    result: {
      status: 'infrastructure_error',
      exitCode: null,
      counts: { executed: 1, passed: 0, failed: 0, infrastructureErrors: 1 },
    },
    cleanup: { status: 'not_required', survivingOwnedChildren: 0 },
    worktree,
    request: { key: 'a'.repeat(64) },
  });

  // This IS the reconcile case, which is what makes the assertion below about
  // the branch the review found untested rather than the ordinary one.
  expect(reported.summary.reconcileNote).toContain(
    'required attachment unavailable',
  );
  expect(reported.result.infrastructureCause).toBe(BUDGET_CAUSE);
  // The two artifacts differ only in RENDERING: this branch wraps the cause in
  // a sentence. The declaration and its bytes are the same.
  expect(reported.summary.firstCausalExcerpt).toBe(
    `verification execution infrastructure error: ${BUDGET_CAUSE}`,
  );
});
