#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import receiptSchema from '../schemas/verification-receipt.schema.json' with {
  type: 'json',
};
import {
  CHANGED_DIAGNOSTIC_ERROR_LIMIT_BYTES,
  incompleteDiagnosticReasons,
} from './lib/changed-verification-diagnostics.mjs';
import {
  captureOwnedProcessOutput,
  executeOwnedCommand,
  registerProcessSignal,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './lib/owned-process.mjs';
import {
  loadProductLawManifest,
  productLawDispositions,
} from './lib/product-laws.mjs';
import {
  collectVerificationProvenance,
  writeReceiptSecurely,
} from './lib/test-reliability.mjs';
import {
  assertReceiptSemantics,
  createVerificationReceipt,
  createVerificationRequest,
} from './lib/verification-receipt.mjs';
import { redactVerificationOutput } from './lib/verification-redaction.mjs';
import { groupFiles, VITEST_CORPUS_GROUPS } from './run-vitest-corpus.mjs';
import {
  buildTestImpactManifest,
  isEscalationPath,
  matches,
  TEST_IMPACT_MANIFEST,
  validateTestImpactManifest,
} from './test-impact-manifest.mjs';
import { resolveLane } from './verification-lanes.mjs';
import { partitionVitestResourceSubset } from './vitest-resource-manifest.mjs';
import {
  assertWorkspacePackageProvenance,
  listWorkspacePackageManifests,
} from './workspace-dependency-provenance.mjs';

const receiptValidator = new Ajv2020({ strict: true }).compile(receiptSchema);
const FAILURE_IDENTITY_LIMIT = 20;
const FAILURE_NAME_LIMIT = 512;
const FAILURE_EXCERPT_LIMIT = CHANGED_DIAGNOSTIC_ERROR_LIMIT_BYTES;
const NARROW_DIFF_FIXTURE =
  'scripts/__tests__/fixtures/changed-verification/narrow-diff.json';
const RELATED_DISCOVERY_LIMIT_BYTES = 1024 * 1024;
const RELATED_DISCOVERY_TIMEOUT_MS = 60_000;
const RELATED_DISCOVERY_SETTLEMENT_MS = 5_000;
const CHANGED_CHILD_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;
const VITEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const RELATED_DISCOVERY_SOURCE = `
import { relative, sep } from 'node:path';
import { createVitest } from 'vitest/node';
const root = process.cwd();
const vitest = await createVitest('test', {
  root,
  watch: false,
  run: true,
  passWithNoTests: true,
  related: process.argv.slice(1),
});
try {
  const specifications = await vitest.getRelevantTestSpecifications();
  const files = [...new Set(specifications.map((item) =>
    relative(root, item.moduleId).split(sep).join('/'),
  ))].sort();
  process.stdout.write(JSON.stringify(files));
} finally {
  await vitest.close();
}`;

export function parseRelatedTestDiscovery(result) {
  if (result.error || result.status !== 0 || result.signal)
    throw new Error(
      `Related Vitest discovery failed: ${result.error?.message ?? (String(result.stderr ?? '').trim() || `status ${result.status ?? 'unknown'}`)}`,
    );
  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout ?? '').trim());
  } catch {
    throw new Error('Related Vitest discovery returned malformed JSON');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((path) => typeof path !== 'string' || path.length === 0)
  )
    throw new Error('Related Vitest discovery returned no valid test files');
  // An empty array is discovery's answer, not its failure: no test in the
  // corpus imports the changed paths. Only output discovery could not have
  // produced -- a non-array, or an entry that is not a usable path -- means it
  // could not run. Conflating the two made a data-only diff read as a broken
  // runner (#1757).
  return parsed;
}

export async function runOwnedChangedCommand(
  command,
  args,
  {
    cwd,
    execute = executeOwnedCommand,
    emitOutput = false,
    maxBytes = CHANGED_CHILD_OUTPUT_LIMIT_BYTES,
    processLabel,
    signal,
    timeoutMs,
    waitForSettlement = waitForSuiteSettlement,
  },
) {
  if (signal?.aborted)
    return {
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: new Error(`${processLabel} ${signal.reason ?? 'aborted'}`),
      launch: { attempted: false, started: false },
      cleanup: { status: 'not_required', survivingOwnedChildren: 0 },
    };
  let execution;
  try {
    execution = execute(command, args, spawn, processLabel, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    return {
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: error instanceof Error ? error : new Error(String(error)),
      launch: { attempted: true, started: false },
      cleanup: { status: 'not_required', survivingOwnedChildren: 0 },
    };
  }
  const launch = {
    attempted: true,
    started: Number.isInteger(execution.child?.pid),
  };
  let cleanupPromise;
  let cancellation;
  let resolveCancellation;
  const cancellationRequested = new Promise((resolveCancellationPromise) => {
    resolveCancellation = resolveCancellationPromise;
  });
  const settle = () => {
    if (!cleanupPromise)
      cleanupPromise = terminateSuiteExecution(execution, {
        processLabel,
        terminationGraceMs: RELATED_DISCOVERY_SETTLEMENT_MS,
        terminationForceMs: RELATED_DISCOVERY_SETTLEMENT_MS,
        waitForSuiteSettlement: waitForSettlement,
      });
    return cleanupPromise;
  };
  const cancel = (reason) => {
    cancellation ??= reason;
    resolveCancellation(cancellation);
    return settle();
  };
  const output = captureOwnedProcessOutput(execution, {
    maxBytes,
    onOverflow: () => void cancel(`output exceeded ${maxBytes} bytes`),
  });
  const abort = () => void cancel(signal?.reason ?? 'aborted');
  signal?.addEventListener?.('abort', abort, { once: true });
  let timer;
  if (timeoutMs !== undefined)
    timer = setTimeout(
      () => void cancel(`timed out after ${timeoutMs}ms`),
      timeoutMs,
    );
  try {
    if (signal?.aborted) abort();
    const completed = await Promise.race([
      execution.completion.then((result) => ({ kind: 'completed', result })),
      cancellationRequested.then((reason) => ({ kind: 'cancelled', reason })),
    ]);
    if (completed.kind === 'cancelled') await cleanupPromise;
    else if (execution.completionRequiresCleanup === true) await settle();
    else if (
      execution.isAlive() &&
      !(await waitForSettlement(execution, RELATED_DISCOVERY_SETTLEMENT_MS))
    )
      await settle();
    const cleanupResult = cleanupPromise ? await cleanupPromise : undefined;
    const captured = output.finish();
    if (emitOutput) {
      if (captured.stdout.text) process.stdout.write(captured.stdout.text);
      if (captured.stderr.text) process.stderr.write(captured.stderr.text);
    }
    const unsafeOutput = captured.truncated || captured.invalidUtf8;
    const treeAlive = execution.isAlive() || cleanupResult?.settled === false;
    const cleanupFailed = (cleanupResult?.errors?.length ?? 0) > 0;
    const error =
      completed.kind === 'completed' ? completed.result.error : undefined;
    return {
      status: completed.kind === 'completed' ? completed.result.status : null,
      signal: completed.kind === 'completed' ? completed.result.signal : null,
      stdout: captured.stdout.text,
      stderr: captured.stderr.text,
      launch,
      cleanup: treeAlive
        ? // The canonical receipt has no unknown cardinality. One is a
          // conservative nonzero sentinel when settlement cannot establish
          // zero survivors; it is not an exact process count.
          { status: 'failed', survivingOwnedChildren: 1 }
        : cleanupFailed
          ? { status: 'failed', survivingOwnedChildren: 0 }
          : cleanupResult
            ? { status: 'passed', survivingOwnedChildren: 0 }
            : { status: 'not_required', survivingOwnedChildren: 0 },
      error:
        error ??
        (treeAlive
          ? new Error(`${processLabel} left an owned process tree alive`)
          : cleanupFailed
            ? new Error(`${processLabel} cleanup reported an error`)
            : unsafeOutput
              ? new Error(`${processLabel} output was not safely retained`)
              : cancellation
                ? new Error(`${processLabel} ${cancellation}`)
                : undefined),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abort);
  }
}

export async function discoverRelatedTestFiles(
  root,
  relatedPaths,
  {
    run = runOwnedChangedCommand,
    signal,
    timeoutMs = RELATED_DISCOVERY_TIMEOUT_MS,
  } = {},
) {
  if (!Array.isArray(relatedPaths) || relatedPaths.length === 0)
    throw new Error('Related Vitest discovery requires at least one path');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new Error('Related Vitest discovery timeout is invalid');
  let result;
  try {
    result = await run(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        RELATED_DISCOVERY_SOURCE,
        ...relatedPaths.map((path) => resolve(root, path)),
      ],
      {
        cwd: root,
        maxBytes: RELATED_DISCOVERY_LIMIT_BYTES,
        processLabel: 'Related Vitest discovery',
        signal,
        timeoutMs,
      },
    );
    return parseRelatedTestDiscovery(result);
  } catch (error) {
    const discoveryError = new Error(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
    discoveryError.phase = 'related-discovery';
    discoveryError.childStarted = result?.launch?.started === true;
    discoveryError.cleanup = result?.cleanup;
    throw discoveryError;
  }
}

export function validateSelectedTestFiles(root, files) {
  const realRoot = realpathSync(root);
  if (!Array.isArray(files) || files.length === 0)
    throw new Error('Changed verification selected no test files');
  return files.map((path) => {
    if (
      typeof path !== 'string' ||
      path.length === 0 ||
      isAbsolute(path) ||
      path.split(/[\\/]/).includes('..') ||
      /[\r\n\0]/.test(path) ||
      !VITEST_FILE_PATTERN.test(path)
    )
      throw new Error(
        `Changed verification selected an unsafe test path: ${path}`,
      );
    const candidate = resolve(realRoot, path);
    const relativeCandidate = relative(realRoot, candidate);
    if (
      relativeCandidate === '' ||
      relativeCandidate === '..' ||
      relativeCandidate.startsWith(`..${sep}`)
    )
      throw new Error(
        `Changed verification test leaves the workspace: ${path}`,
      );
    let realCandidate;
    try {
      realCandidate = realpathSync(candidate);
    } catch {
      throw new Error(`Changed verification test is missing: ${path}`);
    }
    if (realCandidate !== candidate || !statSync(realCandidate).isFile())
      throw new Error(
        `Changed verification test is not a direct workspace file: ${path}`,
      );
    return relativeCandidate.split(sep).join('/');
  });
}

function git(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(
      `git ${args.join(' ')} failed: ${error.stderr?.toString().trim() || error.message}`,
    );
  }
}

function nameStatusPaths(output) {
  const values = output.split('\0');
  const paths = [];
  for (let index = 0; index < values.length; ) {
    const status = values[index++];
    if (!status) continue;
    // With -z, a rename/copy status is followed by both source and target.
    // Keeping both is conservative: an old dependency edge can be just as
    // relevant as the new location while a worktree is mid-rename.
    const source = values[index++];
    if (source) paths.push(source);
    if (status.startsWith('R') || status.startsWith('C')) {
      const target = values[index++];
      if (target) paths.push(target);
    }
  }
  return paths;
}
function untrackedPaths(output) {
  return output.split('\0').filter(Boolean);
}

export function changedPaths({ root = process.cwd(), base, gitCommand = git }) {
  if (!base || base.startsWith('-'))
    throw new Error('--base must be a git ref, not an option');
  const mergeBase = gitCommand(root, ['merge-base', base, 'HEAD']).trim();
  const paths = new Set([
    ...nameStatusPaths(
      gitCommand(root, ['diff', '--name-status', '-z', `${mergeBase}..HEAD`]),
    ),
    // A checkpoint must include the index as well as committed and unstaged
    // edits; omitting --cached makes staged work invisible to local feedback.
    ...nameStatusPaths(
      gitCommand(root, ['diff', '--cached', '--name-status', '-z']),
    ),
    ...nameStatusPaths(gitCommand(root, ['diff', '--name-status', '-z'])),
    ...untrackedPaths(
      gitCommand(root, ['ls-files', '--others', '--exclude-standard', '-z']),
    ),
  ]);
  return { mergeBase, paths: [...paths].sort() };
}
export function selectChangedVerification(
  paths,
  manifest = TEST_IMPACT_MANIFEST,
) {
  const errors = validateTestImpactManifest(manifest);
  if (errors.length)
    throw new Error(`impact manifest invalid: ${errors.join('; ')}`);
  const tests = new Map();
  const lanes = new Map();
  const relatedPaths = new Set();
  let escalated = false;
  const changed = new Set(paths);
  for (const path of paths) {
    const isChangedTest =
      !path.startsWith('tests/') &&
      /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);
    if (isChangedTest) {
      addReason(tests, path, `changed test file: ${path}`);
    }
    const edges = manifest.filter(
      (edge) =>
        matches(edge.pattern, path) &&
        (edge.whenAll?.every((required) => changed.has(required)) ?? true),
    );
    // A SUPPLEMENTAL edge only ever adds tests. It is deliberately invisible
    // to the boundary, escalation, and related decisions below, so a derived
    // edge (`pathReadPinEdges`, #1807) cannot trade a broader selection for a
    // narrower one: naming `tests` would otherwise set `hasExplicitBoundary`
    // and suppress the generic `related` edge for the same path, which is how
    // an explicit list silently DROPS the related suites (#1563, #1613).
    const boundaryEdges = edges.filter((edge) => !edge.supplemental);
    // Added before every branch below: a supplemental test is additive even
    // where the path escalates, and naming it in the receipt is the point.
    for (const edge of edges)
      if (edge.supplemental)
        for (const test of edge.tests ?? [])
          addReason(tests, test, `${edge.reason}: ${path}`);
    const hasExplicitBoundary =
      isChangedTest ||
      boundaryEdges.some((edge) => edge.tests?.length || edge.lanes?.length);
    if (isEscalationPath(path) && !hasExplicitBoundary) {
      addReason(lanes, 'ci-fast', `escalation: ${path}`);
      escalated = true;
      continue;
    }
    if (!boundaryEdges.length) {
      if (isChangedTest) continue;
      addReason(lanes, 'ci-fast', `unknown changed path: ${path}`);
      escalated = true;
      continue;
    }
    for (const edge of boundaryEdges) {
      // A direct mapping replaces the generic graph fallback. An edge that
      // explicitly requests both tests and related selection supplements the
      // import graph (for example, a source-reading portability check).
      if (
        edge.related &&
        (!hasExplicitBoundary || edge.tests?.length) &&
        !isChangedTest
      )
        relatedPaths.add(path);
      for (const test of edge.tests ?? [])
        addReason(tests, test, `${edge.reason}: ${path}`);
      for (const lane of edge.lanes ?? [])
        addReason(lanes, lane, `${edge.reason}: ${path}`);
    }
  }
  if (!paths.length || (!tests.size && !lanes.size && !relatedPaths.size))
    addReason(lanes, 'test-full', 'empty executable selection escalated');
  if (!paths.length) escalated = true;
  return {
    tests: [...tests.keys()]
      .sort()
      .map((path) => ({ path, reasons: [...tests.get(path)].sort() })),
    lanes: [...lanes.keys()]
      .sort()
      .map((id) => ({ id, reasons: [...lanes.get(id)].sort() })),
    relatedPaths: [...relatedPaths].sort(),
    escalated,
  };
}

function addReason(collection, key, reason) {
  const reasons = collection.get(key) ?? new Set();
  reasons.add(reason);
  collection.set(key, reasons);
}

export function escalateUnavailableRelatedPaths(
  selection,
  { root = process.cwd(), pathExists = existsSync } = {},
) {
  const unavailable = selection.relatedPaths.filter(
    (path) => !pathExists(resolve(root, path)),
  );
  if (!unavailable.length) return selection;
  const laneReasons = new Map(
    selection.lanes.map(({ id, reasons }) => [id, new Set(reasons)]),
  );
  for (const path of unavailable)
    addReason(laneReasons, 'test-full', `unavailable related path: ${path}`);
  return {
    ...selection,
    lanes: [...laneReasons.keys()]
      .sort()
      .map((id) => ({ id, reasons: [...laneReasons.get(id)].sort() })),
    escalated: true,
  };
}

export function escalateUnavailableExplicitTests(
  selection,
  { root = process.cwd(), pathExists = existsSync } = {},
) {
  const unavailable = selection.tests
    .map(({ path }) => path)
    .filter((path) => !pathExists(resolve(root, path)));
  if (!unavailable.length) return selection;
  const laneReasons = new Map(
    selection.lanes.map(({ id, reasons }) => [id, new Set(reasons)]),
  );
  for (const path of unavailable)
    addReason(laneReasons, 'test-full', `unavailable explicit test: ${path}`);
  return {
    ...selection,
    lanes: [...laneReasons.keys()]
      .sort()
      .map((id) => ({ id, reasons: [...laneReasons.get(id)].sort() })),
    escalated: true,
  };
}

export function validateChangedVerificationReceipt(receipt) {
  const errors = [];
  if (receipt?.request?.laneId !== 'test-changed')
    errors.push('changed verification receipt must use the test-changed lane');
  if (!receiptValidator(receipt))
    errors.push(
      `schema validation failed: ${receiptValidator.errors?.[0]?.message}`,
    );
  try {
    assertReceiptSemantics(receipt);
  } catch (error) {
    errors.push(error.message);
  }
  return errors;
}

function boundedRedactedText(value, maxBytes) {
  const redacted = redactVerificationOutput(String(value ?? ''));
  let bounded = '';
  for (const point of Array.from(redacted)) {
    if (Buffer.byteLength(bounded + point) > maxBytes) break;
    bounded += point;
  }
  return bounded;
}

function preparationFailure(phase, childStarted, error, cleanup) {
  const redacted = redactVerificationOutput(String(error ?? ''));
  const bounded = boundedRedactedText(redacted, FAILURE_EXCERPT_LIMIT);
  return {
    phase,
    childStarted,
    infrastructureError: true,
    error: bounded,
    errorTruncated: Buffer.byteLength(redacted) > Buffer.byteLength(bounded),
    cleanup:
      cleanup?.status === 'failed'
        ? {
            status: 'failed',
            survivingOwnedChildren: cleanup.survivingOwnedChildren > 0 ? 1 : 0,
          }
        : cleanup?.status === 'passed'
          ? { status: 'passed', survivingOwnedChildren: 0 }
          : { status: 'not_required', survivingOwnedChildren: 0 },
  };
}

function reportFile(name, root) {
  if (typeof name !== 'string' || name.length === 0) return 'unknown';
  if (!isAbsolute(name)) return boundedRedactedText(name, FAILURE_NAME_LIMIT);
  const local = relative(root, name);
  return boundedRedactedText(
    local && !local.startsWith('..') ? local : basename(name),
    FAILURE_NAME_LIMIT,
  );
}

function failedTestIdentities(report, root) {
  const found = [];
  for (const suite of Array.isArray(report.testResults)
    ? report.testResults
    : []) {
    const assertions = Array.isArray(suite?.assertionResults)
      ? suite.assertionResults
      : [];
    for (const assertion of assertions) {
      if (assertion?.status !== 'failed') continue;
      const fullName =
        assertion.fullName ||
        [...(assertion.ancestorTitles ?? []), assertion.title]
          .filter(Boolean)
          .join(' > ') ||
        'unnamed failed test';
      const failureMessage =
        assertion.failureMessages?.find((message) => message) ??
        suite?.message ??
        'No assertion excerpt was reported';
      found.push({
        file: reportFile(suite?.name, root),
        name: boundedRedactedText(fullName, FAILURE_NAME_LIMIT),
        excerpt: boundedRedactedText(failureMessage, FAILURE_EXCERPT_LIMIT),
      });
    }
  }
  return {
    failedTests: found.slice(0, FAILURE_IDENTITY_LIMIT),
    failureIdentityCount: found.length,
    omittedFailureIdentities: Math.max(
      0,
      found.length - FAILURE_IDENTITY_LIMIT,
    ),
  };
}

function countAssertionsWithStatus(report, status) {
  let found = 0;
  for (const suite of Array.isArray(report.testResults)
    ? report.testResults
    : []) {
    const assertions = Array.isArray(suite?.assertionResults)
      ? suite.assertionResults
      : [];
    for (const assertion of assertions)
      if (assertion?.status === status) found += 1;
  }
  return found;
}

/**
 * Vitest reports four mutually exclusive per-test outcomes and its JSON
 * reporter emits each one (`numPassedTests`, `numFailedTests`,
 * `numPendingTests`, `numTodoTests`). Deriving `failed` as `total - passed`
 * therefore did not need to guess, and the guess collapsed a deliberate
 * `describe.skipIf` into a failure that no assertion could name (#1737).
 *
 * The conservatism the derivation was reaching for is kept, not dropped, and
 * moved onto the distinction that actually matters: **a deliberate skip is not
 * a silent non-execution.** A skip is itemised, so it is accounted for and
 * simply not executed. Anything the report does not itemise, and any test
 * Vitest itself reports as still running or queued (`status: 'pending'`, which
 * Vitest documents as an internal bug), is a parse error rather than a quietly
 * clean count.
 *
 * `executed = passed + failed` also keeps the receipt honest without a
 * `skipped` field: `isPassingCounts` requires `passed === executed` and
 * `executed > 0`, so a skipped-only or partial run still cannot pass.
 */
function parseVitestReport(contents, { root = process.cwd() } = {}) {
  let report;
  try {
    report = JSON.parse(contents);
  } catch {
    return { error: 'Vitest JSON report was missing or malformed' };
  }
  const total = report.numTotalTests;
  const passed = report.numPassedTests;
  const failed = report.numFailedTests;
  const suites = report.numTotalTestSuites;
  // A reporter that omits these emits no skips either; the accounting check
  // below turns any silent gap into an explicit parse error.
  const pending = report.numPendingTests ?? 0;
  const todo = report.numTodoTests ?? 0;
  if (
    ![total, passed, failed, suites, pending, todo].every(
      (value) => Number.isInteger(value) && value >= 0,
    )
  ) {
    return { error: 'Vitest JSON report had invalid test counts' };
  }
  const unaccounted = total - passed - failed - pending - todo;
  if (unaccounted > 0)
    return {
      error: `Vitest JSON report left ${unaccounted} test outcome(s) unaccounted for`,
    };
  if (unaccounted < 0)
    return { error: 'Vitest JSON report counted overlapping test outcomes' };
  const unfinished = countAssertionsWithStatus(report, 'pending');
  if (unfinished > 0)
    return {
      error: `Vitest JSON report contains ${unfinished} test(s) that never finished`,
    };
  if (total === 0 || suites === 0) return { empty: true };
  const skipped = pending - unfinished;
  const counts = { executed: passed + failed, passed, failed, skipped, todo };
  const failures = failedTestIdentities(report, root);
  const parsed = {
    counts,
    ...failures,
    failureIdentitiesComplete:
      counts.failed === 0 ||
      (failures.failureIdentityCount >= counts.failed &&
        failures.omittedFailureIdentities === 0),
  };
  // Every selected test declined to run. That is no executable evidence at
  // all, so it escalates like a zero-test report rather than reading clean.
  if (counts.executed === 0)
    return {
      ...parsed,
      empty: true,
      emptyReason: `executed zero of ${total} selected test(s) (${skipped} skipped, ${todo} todo)`,
    };
  return parsed;
}

export async function planChangedVitestExecutions(
  root,
  selection,
  {
    discoverRelated = discoverRelatedTestFiles,
    partition = partitionVitestResourceSubset,
    vitestPath,
  } = {},
) {
  const vitest = vitestPath ?? resolve(root, 'node_modules/vitest/vitest.mjs');
  const relatedTests = selection.relatedPaths.length
    ? await discoverRelated(root, selection.relatedPaths)
    : [];
  const candidates = [
    ...new Set([
      ...relatedTests,
      ...selection.tests.map((entry) => entry.path),
    ]),
  ].sort();
  // Discovery ran and matched nothing. That is an empty plan, not a planning
  // failure, so it must not reach validateSelectedTestFiles -- whose empty
  // throw is the fail-closed guard for a selection that was supposed to hold
  // files. Only a related-path selection can land here: an explicit test
  // target always contributes its own path.
  if (candidates.length === 0 && selection.relatedPaths.length > 0) return [];
  const selected = validateSelectedTestFiles(root, candidates);
  const groups = partition(selected, { root });
  const kind = selection.relatedPaths.length
    ? selection.tests.length
      ? 'combined'
      : 'related'
    : 'explicit';
  return VITEST_CORPUS_GROUPS.flatMap((group) => {
    const files = groupFiles(groups, group.name);
    if (!files.length) return [];
    return [
      {
        kind,
        resourceGroup: group.name,
        command: [
          vitest,
          'run',
          `--maxWorkers=${group.maxWorkers}`,
          ...(group.noFileParallelism ? ['--no-file-parallelism'] : []),
          ...files.map((file) => `./${file}`),
        ],
      },
    ];
  });
}

async function runVitest(
  root,
  run,
  selection,
  {
    beforeCleanup = () => {},
    discoverRelated,
    partition,
    readReport = readFileSync,
    vitestPath,
  } = {},
) {
  let plannedExecutions;
  try {
    plannedExecutions = await planChangedVitestExecutions(root, selection, {
      ...(discoverRelated ? { discoverRelated } : {}),
      ...(partition ? { partition } : {}),
      vitestPath,
    });
  } catch (error) {
    return {
      executions: [],
      preparation: preparationFailure(
        error instanceof Error && error.phase === 'related-discovery'
          ? 'related-discovery'
          : 'resource-plan',
        error instanceof Error && error.childStarted === true,
        error instanceof Error ? error.message : String(error),
        error instanceof Error ? error.cleanup : undefined,
      ),
    };
  }
  // An execution record is evidence that a child was actually started. Keep
  // the plan separate: a non-zero related run is fail-fast, so later planned
  // commands never acquire an exit status or a JSON report. Recording those
  // plans as executions made an otherwise truthful failing diagnostic look
  // corrupt to its consumer (#701).
  const executions = [];
  let preparation;
  const reportDirectory = mkdtempSync(join(tmpdir(), 'station-test-changed-'));
  let durable = false;
  try {
    for (const [index, execution] of plannedExecutions.entries()) {
      if (selection.signal?.aborted) {
        preparation = preparationFailure(
          'resource-execution',
          false,
          `Changed Vitest execution ${selection.signal.reason ?? 'aborted'}`,
        );
        break;
      }
      const reportPath = join(reportDirectory, `${index}.json`);
      let child;
      try {
        child = await run(
          process.execPath,
          [
            ...execution.command,
            '--reporter=json',
            `--outputFile=${reportPath}`,
            '--passWithNoTests',
          ],
          {
            cwd: root,
            emitOutput: true,
            processLabel: `Changed Vitest ${execution.resourceGroup}`,
            signal: selection.signal,
          },
        );
      } catch (error) {
        preparation = preparationFailure(
          'resource-execution',
          false,
          error instanceof Error ? error.message : String(error),
        );
        break;
      }
      if (child.launch?.started === false) {
        preparation = preparationFailure(
          'resource-execution',
          false,
          child.error instanceof Error
            ? child.error.message
            : 'Changed Vitest child did not start',
          child.cleanup,
        );
        break;
      }
      executions.push(execution);
      execution.cleanup = child.cleanup;
      execution.exitCode = Number.isInteger(child.status) ? child.status : 1;
      execution.infrastructureError = Boolean(
        child.error || child.status === null || child.signal,
      );
      if (!execution.infrastructureError) {
        try {
          Object.assign(
            execution,
            parseVitestReport(readReport(reportPath, 'utf8'), { root }),
          );
        } catch {
          execution.error = 'Vitest JSON report was missing or unreadable';
        }
      }
      if (
        execution.exitCode !== 0 ||
        execution.infrastructureError ||
        execution.error
      )
        break;
    }
    beforeCleanup(executions, preparation);
    durable = true;
  } finally {
    // Preserve the raw reporter directory if durable diagnostic persistence
    // fails. Successful runs remove it only after the stable artifact exists.
    if (durable) rmSync(reportDirectory, { recursive: true, force: true });
  }
  return {
    executions,
    emptySelection: plannedExecutions.length === 0,
    ...(preparation ? { preparation } : {}),
  };
}

function countsFor(executions, preparation) {
  const infrastructureErrors =
    executions.filter((entry) => entry.infrastructureError).length +
    (preparation?.infrastructureError === true ? 1 : 0);
  const parserErrors = executions.filter((entry) => entry.error).length;
  const testCounts = executions.flatMap((entry) =>
    entry.counts ? [entry.counts] : [],
  );
  const sum = (key) =>
    testCounts.reduce((total, counts) => total + (counts[key] ?? 0), 0);
  return {
    executed: sum('executed'),
    passed: sum('passed'),
    failed: sum('failed'),
    skipped: sum('skipped'),
    todo: sum('todo'),
    infrastructureErrors,
    parserErrors,
    emptyReports: executions.filter((entry) => entry.empty).length,
  };
}

function cleanupFor(result) {
  const observations = [
    result.preparation?.cleanup,
    ...result.executed.map((execution) => execution.cleanup),
  ].filter(Boolean);
  const failed = observations.filter((cleanup) => cleanup.status === 'failed');
  if (failed.length)
    return {
      status: 'failed',
      survivingOwnedChildren: failed.some(
        (cleanup) => cleanup.survivingOwnedChildren > 0,
      )
        ? 1
        : 0,
    };
  if (observations.some((cleanup) => cleanup.status === 'passed'))
    return { status: 'passed', survivingOwnedChildren: 0 };
  return { status: 'not_required', survivingOwnedChildren: 0 };
}

/**
 * Name the obligation an empty related selection leaves behind. Exit 3 must
 * name the next lane (docs/guides/testing.md) and the test-changed lane
 * declares that "empty selections escalate to named deferred lanes"
 * (scripts/verification-lanes.mjs), so an empty plan that named nothing left
 * a provisional exit 3 with no lane, no next command and escalated: false --
 * an unnamed obligation, which run-ci-fast then passes over.
 */
function escalateEmptyRelatedSelection(selection, relatedPaths) {
  const laneReasons = new Map(
    selection.lanes.map(({ id, reasons }) => [id, new Set(reasons)]),
  );
  for (const path of relatedPaths)
    addReason(
      laneReasons,
      'test-full',
      `no related suites for ${path}; ${EMPTY_RELATED_SELECTION_REMEDY}`,
    );
  return {
    ...selection,
    lanes: [...laneReasons.keys()]
      .sort()
      .map((id) => ({ id, reasons: [...laneReasons.get(id)].sort() })),
    escalated: true,
  };
}

function escalateEmptyReports(selection, executions) {
  const empty = executions.filter((entry) => entry.empty);
  if (!empty.length) return selection;
  const laneReasons = new Map(
    selection.lanes.map(({ id, reasons }) => [id, new Set(reasons)]),
  );
  for (const execution of empty)
    addReason(
      laneReasons,
      'test-full',
      `Vitest ${execution.emptyReason ?? 'selected zero tests'} for ${execution.kind} verification`,
    );
  return {
    ...selection,
    lanes: [...laneReasons.keys()]
      .sort()
      .map((id) => ({ id, reasons: [...laneReasons.get(id)].sort() })),
    escalated: true,
  };
}

function selectionArtifact(result) {
  const contents = `${JSON.stringify(result, null, 2)}\n`;
  return {
    contents,
    artifact: {
      path: '.kontourai/test-impact/changed-selection.json',
      sha256: createHash('sha256').update(contents).digest('hex'),
    },
  };
}

function diagnosticsArtifact(result, counts, provenance) {
  const diagnostics = {
    schemaVersion: 1,
    kind: 'station-test-changed-diagnostics',
    base: result.base,
    mergeBase: result.mergeBase,
    provenance: {
      repositoryId: provenance.repositoryId,
      headSha: provenance.headSha,
      workspaceDigest: provenance.workspaceDigest,
      environmentDigest: provenance.environmentDigest,
      dependencyDigest: provenance.dependencyDigest,
    },
    changedPathCount: result.paths.length,
    selection: {
      relatedPathCount: result.selection.relatedPaths.length,
      exactTestCount: result.selection.tests.length,
      deferredLanes: result.selection.lanes.map(({ id }) => id),
      escalated: result.selection.escalated,
    },
    counts,
    ...(result.preparation
      ? {
          preparation: {
            phase: result.preparation.phase,
            childStarted: result.preparation.childStarted,
            infrastructureError: result.preparation.infrastructureError,
            error: result.preparation.error,
            errorTruncated: result.preparation.errorTruncated,
          },
        }
      : {}),
    executions: result.executed.map((execution) => ({
      kind: execution.kind,
      ...(execution.resourceGroup
        ? { resourceGroup: execution.resourceGroup }
        : {}),
      exitCode: execution.exitCode,
      infrastructureError: execution.infrastructureError === true,
      ...(execution.error ? { error: execution.error } : {}),
      ...(execution.empty ? { empty: true } : {}),
      ...(execution.emptyReason ? { emptyReason: execution.emptyReason } : {}),
      ...(execution.counts ? { counts: execution.counts } : {}),
      ...(execution.failedTests
        ? {
            failedTests: execution.failedTests,
            failureIdentityCount: execution.failureIdentityCount,
            omittedFailureIdentities: execution.omittedFailureIdentities,
            failureIdentitiesComplete:
              execution.failureIdentitiesComplete === true,
          }
        : {}),
    })),
  };
  diagnostics.incompleteReasons = incompleteDiagnosticReasons(diagnostics);
  diagnostics.complete = diagnostics.incompleteReasons.length === 0;
  const contents = `${JSON.stringify(diagnostics, null, 2)}\n`;
  return {
    contents,
    artifact: {
      path: '.kontourai/test-impact/changed-diagnostics.json',
      sha256: createHash('sha256').update(contents).digest('hex'),
    },
  };
}

function nextCommands(selection) {
  return selection.lanes.map(({ id, reasons }) => ({
    id,
    command: resolveLane(id).command,
    reasons,
  }));
}

const CHANGED_OUTPUT_NAME_LIMIT = 6;
const CHANGED_OUTPUT_LINE_LIMIT = 1_024;
const CHANGED_SELECTION_ARTIFACT =
  '.kontourai/test-impact/changed-selection.json';
const EMPTY_RELATED_SELECTION_REMEDY =
  'declare a boundary in scripts/test-impact-manifest.mjs if a test reads this file';

function boundedNames(names) {
  const unique = [...new Set(names)].sort();
  const visible = unique.slice(0, CHANGED_OUTPUT_NAME_LIMIT);
  const suffix =
    unique.length > visible.length
      ? ` … +${unique.length - visible.length} more`
      : '';
  let rendered = `${visible.join(', ')}${suffix}`;
  let truncated = unique.length > visible.length;
  if (Buffer.byteLength(rendered) > CHANGED_OUTPUT_LINE_LIMIT) {
    rendered = `${Array.from(rendered)
      .slice(0, CHANGED_OUTPUT_LINE_LIMIT - 20)
      .join('')} …`;
    truncated = true;
  }
  return { rendered: rendered || 'none', truncated };
}

/**
 * The terminal selector surface is deliberately a compact handoff. Complete
 * changed paths, reasons, commands, execution details, and receipt metadata
 * remain in the digest-addressed selection artifact instead of being emitted
 * twice into every agent transcript.
 */
export function renderChangedVerificationSummary(result) {
  const focused = boundedNames([
    ...result.selection.relatedPaths,
    ...result.selection.tests.map((entry) => entry.path),
  ]);
  const lanes = boundedNames(result.selection.lanes.map((entry) => entry.id));
  const truncated = focused.truncated || lanes.truncated;
  const mode = result.receipt?.terminal?.status ?? 'unknown';
  const laws = boundedNames(result.productLaws ?? []);
  const emptyRelated = result.emptyRelatedSelection
    ? boundedNames(result.emptyRelatedSelection.relatedPaths ?? [])
    : undefined;
  return [
    `[test:changed] ${result.paths?.length ?? 0} changed path(s); ${focusedCount(result.selection)} focused target(s), ${result.selection.lanes.length} deferred lane(s) (${mode}).`,
    `[test:changed] focused: ${focused.rendered}`,
    ...(emptyRelated
      ? [
          `[test:changed] no related suites for: ${emptyRelated.rendered}`,
          `[test:changed] remedy: ${result.emptyRelatedSelection.remedy ?? EMPTY_RELATED_SELECTION_REMEDY}`,
        ]
      : []),
    `[test:changed] lanes: ${lanes.rendered}`,
    `[test:changed] product laws: ${laws.rendered}`,
    `[test:changed] detail: ${CHANGED_SELECTION_ARTIFACT}${truncated ? ' (terminal names truncated; full selection is in the artifact)' : ''}`,
  ].join('\n');
}

function withProductLawDispositions(selection, root, changed) {
  const manifest = loadProductLawManifest({ rootDir: root });
  const productLaws = productLawDispositions(manifest, changed);
  if (productLaws.length === 0) return { selection, productLaws };
  const laneReasons = new Map(
    selection.lanes.map(({ id, reasons }) => [id, new Set(reasons)]),
  );
  laneReasons.set(
    'ci-fast',
    new Set([
      ...(laneReasons.get('ci-fast') ?? []),
      ...productLaws.map((id) => `product-law disposition: ${id}`),
    ]),
  );
  return {
    selection: {
      ...selection,
      lanes: [...laneReasons.keys()]
        .sort()
        .map((id) => ({ id, reasons: [...laneReasons.get(id)].sort() })),
      escalated: true,
    },
    productLaws,
  };
}

function focusedCount(selection) {
  return new Set([
    ...selection.relatedPaths,
    ...selection.tests.map((entry) => entry.path),
  ]).size;
}

export function parseChangedArgs(args) {
  const base = args.find((arg) => arg.startsWith('--base='))?.slice(7);
  if (
    args.filter((arg) => arg.startsWith('--base=')).length !== 1 ||
    args.some((arg) => arg !== '--explain' && !arg.startsWith('--base='))
  )
    throw new Error('usage: npm run test:changed -- --base=<ref> [--explain]');
  if (!base)
    throw new Error('usage: npm run test:changed -- --base=<ref> [--explain]');
  return { base, explain: args.includes('--explain') };
}

function fixtureTarget(root, path) {
  if (typeof path !== 'string' || path.length === 0)
    throw new Error('narrow-diff fixture must provide a target path');
  const target = resolve(root, path);
  if (relative(root, target).startsWith('..'))
    throw new Error(
      'narrow-diff fixture target must stay inside the repository',
    );
  if (!existsSync(target))
    throw new Error(`narrow-diff fixture target is unavailable: ${path}`);
  return target;
}

function linkFixtureWorkspaceDependencies(fixtureRoot) {
  const fixtureDependencies = join(fixtureRoot, 'node_modules');
  mkdirSync(fixtureDependencies);
  // macOS commonly presents /tmp through /private/tmp. Resolve the link base
  // before calculating relative targets so both ends use the same spelling.
  const realDependencies = realpathSync(fixtureDependencies);
  for (const { name, directory } of listWorkspacePackageManifests(
    fixtureRoot,
  )) {
    const link = join(realDependencies, name);
    mkdirSync(dirname(link), { recursive: true });
    // npm workspace links are relative to node_modules. Keep that topology in
    // the disposable worktree so both Node and the provenance preflight prove
    // the fixture's own source, never the caller's checkout.
    symlinkSync(relative(dirname(link), directory), link, 'dir');
  }
}

/**
 * Exercise the non-explain changed selector against one real, narrow diff
 * without touching the caller's checkout. The disposable worktree points at
 * HEAD, gives its ignored dependency directory a read-only Vitest link, and
 * is removed even when the selected test fails. This is intentionally a
 * timing/demo seam, not verification evidence for the caller's worktree.
 */
export async function runRepresentativeNarrowDiffFixture({
  root = process.cwd(),
  fixturePath = NARROW_DIFF_FIXTURE,
  runChanged = runChangedVerification,
  now = Date.now,
  signal,
  worktreeCommand = (args, cwd) => git(cwd, args),
} = {}) {
  const fixture = JSON.parse(readFileSync(resolve(root, fixturePath), 'utf8'));
  const targetPath = fixture?.target;
  fixtureTarget(root, targetPath);
  const dependencies = resolve(root, 'node_modules');
  if (!existsSync(dependencies))
    throw new Error(
      'narrow-diff fixture requires the installed node_modules tree',
    );

  const temporaryRoot = mkdtempSync(
    join(tmpdir(), 'station-test-changed-fixture-'),
  );
  const fixtureRoot = join(temporaryRoot, 'worktree');
  let worktreeCreated = false;
  try {
    worktreeCommand(['worktree', 'add', '--detach', fixtureRoot, 'HEAD'], root);
    worktreeCreated = true;
    // A directory (unlike a top-level symlink) matches node_modules/ in the
    // checkout's ignore rules, so it cannot become a changed path or alter the
    // provenance hash. Vitest resolves its own dependencies at its installed
    // real path; each local workspace resolves through a fixture-local,
    // production-shaped relative symlink.
    const fixtureDependencies = join(fixtureRoot, 'node_modules');
    linkFixtureWorkspaceDependencies(fixtureRoot);
    symlinkSync(
      join(dependencies, 'vitest'),
      join(fixtureDependencies, 'vitest'),
      'dir',
    );
    appendFileSync(fixtureTarget(fixtureRoot, targetPath), '\n');
    const startedAt = now();
    const result = await runChanged(['--base=HEAD'], {
      root: fixtureRoot,
      ...(signal ? { signal } : {}),
      vitestPath: join(dependencies, 'vitest/vitest.mjs'),
    });
    return {
      fixture: targetPath,
      elapsedMs: now() - startedAt,
      counts: result.receipt.counts,
      selection: result.selection,
      exitCode: result.exitCode,
    };
  } finally {
    if (worktreeCreated)
      worktreeCommand(['worktree', 'remove', '--force', fixtureRoot], root);
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export async function runChangedVerification(
  args,
  {
    root = process.cwd(),
    run = runOwnedChangedCommand,
    changedPathsFn = changedPaths,
    collectProvenance = collectVerificationProvenance,
    writeReceipt = writeReceiptSecurely,
    vitestPath,
    discoverRelatedFiles,
    resourcePartition = partitionVitestResourceSubset,
    assertDependencyProvenance = assertWorkspacePackageProvenance,
    pathExists = existsSync,
    signal,
  } = {},
) {
  // Resolve dependency provenance before selecting or starting Vitest. A
  // worktree may otherwise compile against a sibling checkout through a shared
  // node_modules link and create a receipt for the wrong source tree.
  assertDependencyProvenance({ cwd: root });
  const { base, explain } = parseChangedArgs(args);
  const changed = changedPathsFn({ root, base });
  // The derived manifest adds the path-read pin edges (#1807): a test that
  // reads a source file's text has no import edge to it, so neither the graph
  // fallback nor `vitest related` would schedule it here.
  let selection = escalateUnavailableExplicitTests(
    escalateUnavailableRelatedPaths(
      selectChangedVerification(
        changed.paths,
        buildTestImpactManifest({ root }),
      ),
      {
        root,
        pathExists,
      },
    ),
    { root, pathExists },
  );
  const productLawRouting = withProductLawDispositions(
    selection,
    root,
    changed.paths,
  );
  selection = productLawRouting.selection;
  // Capture the request identity before any child process can modify outputs.
  const before = collectProvenance({ cwd: root });
  const request = createVerificationRequest('test-changed', before);
  const result = {
    diagnostic: true,
    completion: false,
    message:
      'Diagnostic only: this result cannot replace or overwrite the canonical full-regression receipt.',
    base,
    ...changed,
    productLaws: productLawRouting.productLaws,
    selection,
    nextCommands: nextCommands(selection),
    executed: [],
  };
  // Broad import expansion remains deferred. Explicit, existing test targets
  // still provide bounded diagnostic failures; passing them cannot complete
  // the deferred obligations. Never truncate a selection into a green claim.
  const executionSelection =
    selection.lanes.length === 0
      ? selection
      : {
          ...selection,
          relatedPaths: [],
          tests:
            selection.tests.length <= 32
              ? selection.tests.filter((entry) =>
                  pathExists(resolve(root, entry.path)),
                )
              : [],
        };
  if (
    !explain &&
    (executionSelection.tests.length || executionSelection.relatedPaths.length)
  ) {
    const vitestOutcome = await runVitest(
      root,
      run,
      { ...executionSelection, signal },
      {
        vitestPath,
        discoverRelated:
          discoverRelatedFiles ??
          ((discoveryRoot, relatedPaths) =>
            discoverRelatedTestFiles(discoveryRoot, relatedPaths, {
              run,
              signal,
            })),
        partition: resourcePartition,
        beforeCleanup(executions, preparation) {
          result.executed = executions;
          if (preparation) result.preparation = preparation;
          selection = escalateEmptyReports(selection, executions);
          result.selection = selection;
          result.nextCommands = nextCommands(selection);
          const earlyDiagnostics = diagnosticsArtifact(
            result,
            countsFor(executions, preparation),
            before,
          );
          writeReceipt(
            earlyDiagnostics.artifact.path,
            earlyDiagnostics.contents,
            root,
          );
        },
      },
    );
    result.executed = vitestOutcome.executions;
    if (vitestOutcome.preparation)
      result.preparation = vitestOutcome.preparation;
    // Related discovery ran and named no suite. Record the fact durably in
    // the selection artifact so a reader sees a selection decision rather
    // than a silent zero-execution run.
    if (vitestOutcome.emptySelection === true && !vitestOutcome.preparation) {
      result.emptyRelatedSelection = {
        relatedPaths: [...executionSelection.relatedPaths].sort(),
        remedy: EMPTY_RELATED_SELECTION_REMEDY,
      };
      selection = escalateEmptyRelatedSelection(
        selection,
        executionSelection.relatedPaths,
      );
    }
    selection = escalateEmptyReports(selection, result.executed);
    result.selection = selection;
    result.nextCommands = nextCommands(selection);
  }
  const after = collectProvenance({ cwd: root });
  const counts = countsFor(result.executed, result.preparation);
  // An empty related selection is deferred, not complete and not broken: no
  // suite was executed, so the receipt layer cannot call it a pass
  // (isPassingCounts requires executed > 0), and nothing here justifies
  // loosening that. The escalation above names test-full, which makes this
  // `provisional` -- and run-ci-fast reads its exit 3 as a deferred selection
  // and carries on, so a data-only diff does not red fast-checks while its
  // receipt still names the obligation (#1757).
  const deferred = explain || selection.lanes.length > 0;
  const failed = counts.failed > 0;
  const childFailed = result.executed.some(
    (execution) => execution.exitCode !== 0 && !execution.infrastructureError,
  );
  const infrastructureError = counts.infrastructureErrors > 0;
  const parserError =
    counts.parserErrors > 0 || (!deferred && counts.executed === 0);
  const status = infrastructureError
    ? 'infrastructure_error'
    : parserError
      ? 'parser_error'
      : failed || childFailed
        ? 'failed'
        : deferred
          ? 'provisional'
          : 'completed';
  const receiptExitCode =
    status === 'provisional'
      ? null
      : status === 'completed'
        ? 0
        : result.executed.at(-1)?.exitCode || 1;
  const { contents, artifact } = selectionArtifact({
    ...result,
    receipt: { status, exitCode: receiptExitCode, counts },
  });
  const diagnostics = diagnosticsArtifact(result, counts, before);
  const receiptCounts = {
    executed: counts.executed,
    passed: counts.passed,
    failed: counts.failed,
    infrastructureErrors: counts.infrastructureErrors,
  };
  const receipt = createVerificationReceipt({
    request,
    status,
    exitCode: receiptExitCode,
    counts: receiptCounts,
    artifacts: [artifact, diagnostics.artifact],
    cleanup: cleanupFor(result),
    before,
    after,
  });
  const errors = validateChangedVerificationReceipt(receipt);
  if (errors.length)
    throw new Error(
      `invalid changed verification receipt: ${errors.join('; ')}`,
    );
  writeReceipt(artifact.path, contents, root);
  if (result.executed.length === 0)
    writeReceipt(diagnostics.artifact.path, diagnostics.contents, root);
  writeReceipt(
    '.kontourai/test-impact/changed-verification.json',
    `${JSON.stringify(receipt, null, 2)}\n`,
    root,
  );
  return {
    ...result,
    receipt,
    exitCode: explain
      ? 0
      : status === 'provisional'
        ? 3
        : receipt.terminal.passed
          ? 0
          : 1,
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const controller = new AbortController();
  const unregister = ['SIGINT', 'SIGTERM'].map((name) =>
    registerProcessSignal(name, () => controller.abort(name)),
  );
  try {
    const args = process.argv.slice(2);
    const result = await (args.length === 1 &&
    args[0] === '--representative-narrow-diff'
      ? runRepresentativeNarrowDiffFixture({ signal: controller.signal })
      : runChangedVerification(args, { signal: controller.signal }));
    console.log(renderChangedVerificationSummary(result));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  } finally {
    for (const remove of unregister) remove();
  }
}
