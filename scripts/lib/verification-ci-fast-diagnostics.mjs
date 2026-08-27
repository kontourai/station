import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { incompleteDiagnosticReasons } from './changed-verification-diagnostics.mjs';

function diagnosticCountsAreValid(counts) {
  return [
    'executed',
    'passed',
    'failed',
    'skipped',
    'todo',
    'infrastructureErrors',
    'parserErrors',
    'emptyReports',
  ].every((key) => Number.isInteger(counts?.[key]) && counts[key] >= 0);
}

function changedExecutionHasWellFormedFailures(execution) {
  if (
    !Number.isInteger(execution?.exitCode) ||
    typeof execution.infrastructureError !== 'boolean' ||
    !execution.counts ||
    !['executed', 'passed', 'failed', 'skipped', 'todo'].every(
      (key) =>
        Number.isInteger(execution.counts[key]) && execution.counts[key] >= 0,
    ) ||
    execution.counts.executed !==
      execution.counts.passed + execution.counts.failed ||
    execution.counts.failed === 0 ||
    !Array.isArray(execution.failedTests) ||
    !Number.isInteger(execution.failureIdentityCount) ||
    !Number.isInteger(execution.omittedFailureIdentities) ||
    execution.failureIdentityCount < execution.failedTests.length ||
    execution.omittedFailureIdentities !==
      execution.failureIdentityCount - execution.failedTests.length ||
    typeof execution.failureIdentitiesComplete !== 'boolean' ||
    execution.failureIdentitiesComplete !==
      (execution.counts.failed === 0 ||
        (execution.failureIdentityCount >= execution.counts.failed &&
          execution.omittedFailureIdentities === 0))
  )
    return false;
  return execution.failedTests.every(
    (failure) =>
      typeof failure?.file === 'string' &&
      typeof failure?.name === 'string' &&
      typeof failure?.excerpt === 'string',
  );
}

function recoverableChangedFailures(diagnostic) {
  if (!Array.isArray(diagnostic?.executions)) return [];
  return diagnostic.executions.flatMap((execution) =>
    changedExecutionHasWellFormedFailures(execution)
      ? execution.failedTests
          .slice(0, execution.counts.failed)
          .map(({ file, name, excerpt }) => ({ file, name, excerpt }))
      : [],
  );
}

function completeChangedDiagnosticIsConsistent(diagnostic) {
  if (!diagnosticCountsAreValid(diagnostic?.counts)) return false;
  const executions = diagnostic.executions;
  if (!Array.isArray(executions)) return false;
  for (const execution of executions) {
    if (
      typeof execution?.kind !== 'string' ||
      !Number.isInteger(execution.exitCode) ||
      typeof execution.infrastructureError !== 'boolean'
    )
      return false;
    if (execution.counts) {
      if (
        !['executed', 'passed', 'failed', 'skipped', 'todo'].every(
          (key) =>
            Number.isInteger(execution.counts[key]) &&
            execution.counts[key] >= 0,
        ) ||
        execution.counts.executed !==
          execution.counts.passed + execution.counts.failed
      )
        return false;
      if (
        !Array.isArray(execution.failedTests) ||
        !Number.isInteger(execution.failureIdentityCount) ||
        !Number.isInteger(execution.omittedFailureIdentities) ||
        execution.failureIdentityCount < execution.failedTests.length ||
        execution.omittedFailureIdentities !==
          execution.failureIdentityCount - execution.failedTests.length ||
        typeof execution.failureIdentitiesComplete !== 'boolean' ||
        execution.failureIdentitiesComplete !==
          (execution.counts.failed === 0 ||
            (execution.failureIdentityCount >= execution.counts.failed &&
              execution.omittedFailureIdentities === 0))
      )
        return false;
      if (
        execution.failedTests.some(
          (failure) =>
            typeof failure?.file !== 'string' ||
            typeof failure?.name !== 'string' ||
            typeof failure?.excerpt !== 'string',
        )
      )
        return false;
    }
  }
  const total = (key) =>
    executions.reduce(
      (sum, execution) => sum + (execution.counts?.[key] ?? 0),
      0,
    );
  const expectedReasons = incompleteDiagnosticReasons(diagnostic);
  return (
    Array.isArray(diagnostic.incompleteReasons) &&
    diagnostic.incompleteReasons.length === expectedReasons.length &&
    diagnostic.incompleteReasons.every(
      (reason, index) => reason === expectedReasons[index],
    ) &&
    diagnostic.complete === (expectedReasons.length === 0) &&
    diagnostic.counts.executed === total('executed') &&
    diagnostic.counts.passed === total('passed') &&
    diagnostic.counts.failed === total('failed') &&
    diagnostic.counts.skipped === total('skipped') &&
    diagnostic.counts.todo === total('todo') &&
    diagnostic.counts.infrastructureErrors ===
      executions.filter((execution) => execution.infrastructureError).length &&
    diagnostic.counts.parserErrors ===
      executions.filter((execution) => execution.error).length &&
    diagnostic.counts.emptyReports ===
      executions.filter((execution) => execution.empty).length
  );
}

function changedDiagnosticBinding(context, attachmentRoot) {
  const diagnosticPath = join(attachmentRoot, 'changed-diagnostics.json');
  const expected = context.before;
  let diagnosticContents;
  let diagnostic;
  let changedReceipt;
  try {
    diagnosticContents = readFileSync(diagnosticPath, 'utf8');
    diagnostic = JSON.parse(diagnosticContents);
    changedReceipt = JSON.parse(
      readFileSync(join(attachmentRoot, 'changed-verification.json'), 'utf8'),
    );
  } catch {
    return {
      reason:
        'this run wrote no readable changed-verification diagnostic and receipt',
    };
  }
  if (
    diagnostic?.schemaVersion !== 1 ||
    diagnostic?.kind !== 'station-test-changed-diagnostics' ||
    typeof diagnostic.base !== 'string' ||
    typeof diagnostic.mergeBase !== 'string' ||
    !Number.isInteger(diagnostic.changedPathCount) ||
    diagnostic.changedPathCount < 0 ||
    !Number.isInteger(diagnostic?.selection?.relatedPathCount) ||
    !Number.isInteger(diagnostic?.selection?.exactTestCount) ||
    !Array.isArray(diagnostic?.selection?.deferredLanes) ||
    !diagnostic.selection.deferredLanes.every(
      (lane) => typeof lane === 'string',
    ) ||
    typeof diagnostic?.selection?.escalated !== 'boolean'
  )
    return {
      reason: 'the changed-verification diagnostic did not match its schema',
    };
  const diagnosticBindings = changedReceipt?.artifacts?.filter(
    (artifact) =>
      artifact?.path === '.kontourai/test-impact/changed-diagnostics.json',
  );
  if (
    changedReceipt?.request?.laneId !== 'test-changed' ||
    diagnosticBindings?.length !== 1 ||
    diagnosticBindings[0]?.sha256 !==
      createHash('sha256').update(diagnosticContents).digest('hex')
  )
    return {
      reason:
        'the changed-verification diagnostic was not digest-bound by its own receipt',
    };
  if (
    ![
      'repositoryId',
      'headSha',
      'workspaceDigest',
      'environmentDigest',
      'dependencyDigest',
    ].every(
      (key) =>
        diagnostic?.provenance?.[key] === expected[key] &&
        changedReceipt?.provenance?.before?.[key] === expected[key],
    )
  )
    return {
      reason:
        'the changed-verification diagnostic came from different provenance than this run',
    };
  if (!completeChangedDiagnosticIsConsistent(diagnostic))
    return {
      reason:
        'the changed-verification diagnostic did not reconcile with its own executions',
      recoverableFailures: recoverableChangedFailures(diagnostic),
    };
  return { path: diagnosticPath };
}

export function attachCiFastDiagnostics(context, raw) {
  if (context.lane.id !== 'ci-fast') return raw;
  const attachmentRoot = join(
    context.before.worktree,
    '.kontourai/test-impact',
  );
  const binding = changedDiagnosticBinding(context, attachmentRoot);
  return {
    ...(raw ?? {}),
    attachmentRoot,
    attachments: [
      ...(Array.isArray(raw?.attachments) ? raw.attachments : []),
      ...(binding.path
        ? [
            {
              name: 'changed-test-diagnostics',
              path: binding.path,
              contentType: 'application/json',
            },
          ]
        : []),
    ],
    ...(binding.reason
      ? {
          unavailableAttachments: [
            { name: 'changed-test-diagnostics', reason: binding.reason },
          ],
          recoverableFailures: binding.recoverableFailures,
        }
      : {}),
  };
}
