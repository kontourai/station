#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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
} from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import receiptSchema from '../schemas/verification-receipt.schema.json' with {
  type: 'json',
};
import { incompleteDiagnosticReasons } from './lib/changed-verification-diagnostics.mjs';
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
import {
  isEscalationPath,
  matches,
  TEST_IMPACT_MANIFEST,
  validateTestImpactManifest,
} from './test-impact-manifest.mjs';
import { resolveLane } from './verification-lanes.mjs';
import {
  assertWorkspacePackageProvenance,
  listWorkspacePackageManifests,
} from './workspace-dependency-provenance.mjs';

const receiptValidator = new Ajv2020({ strict: true }).compile(receiptSchema);
const FAILURE_IDENTITY_LIMIT = 20;
const FAILURE_NAME_LIMIT = 512;
const FAILURE_EXCERPT_LIMIT = 2 * 1024;
const NARROW_DIFF_FIXTURE =
  'scripts/__tests__/fixtures/changed-verification/narrow-diff.json';

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
    const hasExplicitBoundary =
      isChangedTest ||
      edges.some((edge) => edge.tests?.length || edge.lanes?.length);
    if (isEscalationPath(path) && !hasExplicitBoundary) {
      addReason(lanes, 'ci-fast', `escalation: ${path}`);
      escalated = true;
      continue;
    }
    if (!edges.length) {
      if (isChangedTest) continue;
      addReason(lanes, 'ci-fast', `unknown changed path: ${path}`);
      escalated = true;
      continue;
    }
    for (const edge of edges) {
      // A direct dynamic mapping replaces graph selection for that path. This
      // keeps the one exact target from running again through `related`.
      if (edge.related && !hasExplicitBoundary && !isChangedTest)
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

function runVitest(
  root,
  run,
  selection,
  { beforeCleanup = () => {}, readReport = readFileSync, vitestPath } = {},
) {
  const vitest = vitestPath ?? resolve(root, 'node_modules/vitest/vitest.mjs');
  const plannedExecutions = [];
  if (selection.relatedPaths.length) {
    plannedExecutions.push({
      kind: 'related',
      command: [vitest, 'related', '--run', ...selection.relatedPaths],
    });
  }
  if (selection.tests.length) {
    // These manifest targets are a separate dynamic-boundary floor which
    // import analysis cannot discover. Passing each unique target once keeps
    // it deterministic and avoids duplicate explicit execution.
    const related = new Set(selection.relatedPaths);
    const exactTests = selection.tests
      .map((entry) => entry.path)
      .filter((path) => !related.has(path));
    if (exactTests.length)
      plannedExecutions.push({
        kind: 'explicit',
        command: [vitest, 'run', ...exactTests],
      });
  }
  // An execution record is evidence that a child was actually started. Keep
  // the plan separate: a non-zero related run is fail-fast, so later planned
  // commands never acquire an exit status or a JSON report. Recording those
  // plans as executions made an otherwise truthful failing diagnostic look
  // corrupt to its consumer (#701).
  const executions = [];
  const reportDirectory = mkdtempSync(join(tmpdir(), 'station-test-changed-'));
  let durable = false;
  try {
    for (const [index, execution] of plannedExecutions.entries()) {
      const reportPath = join(reportDirectory, `${index}.json`);
      executions.push(execution);
      const child = run(
        process.execPath,
        [
          ...execution.command,
          '--reporter=json',
          `--outputFile=${reportPath}`,
          '--passWithNoTests',
        ],
        { cwd: root, stdio: 'inherit', shell: false },
      );
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
    beforeCleanup(executions);
    durable = true;
  } finally {
    // Preserve the raw reporter directory if durable diagnostic persistence
    // fails. Successful runs remove it only after the stable artifact exists.
    if (durable) rmSync(reportDirectory, { recursive: true, force: true });
  }
  return executions;
}

function countsFor(executions) {
  const infrastructureErrors = executions.filter(
    (entry) => entry.infrastructureError,
  ).length;
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
    executions: result.executed.map((execution) => ({
      kind: execution.kind,
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
  return [
    `[test:changed] ${result.paths?.length ?? 0} changed path(s); ${focusedCount(result.selection)} focused target(s), ${result.selection.lanes.length} deferred lane(s) (${mode}).`,
    `[test:changed] focused: ${focused.rendered}`,
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
export function runRepresentativeNarrowDiffFixture({
  root = process.cwd(),
  fixturePath = NARROW_DIFF_FIXTURE,
  runChanged = runChangedVerification,
  now = Date.now,
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
    const result = runChanged(['--base=HEAD'], {
      root: fixtureRoot,
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

export function runChangedVerification(
  args,
  {
    root = process.cwd(),
    run = spawnSync,
    changedPathsFn = changedPaths,
    collectProvenance = collectVerificationProvenance,
    writeReceipt = writeReceiptSecurely,
    vitestPath,
    assertDependencyProvenance = assertWorkspacePackageProvenance,
    pathExists = existsSync,
  } = {},
) {
  // Resolve dependency provenance before selecting or starting Vitest. A
  // worktree may otherwise compile against a sibling checkout through a shared
  // node_modules link and create a receipt for the wrong source tree.
  assertDependencyProvenance({ cwd: root });
  const { base, explain } = parseChangedArgs(args);
  const changed = changedPathsFn({ root, base });
  let selection = escalateUnavailableExplicitTests(
    escalateUnavailableRelatedPaths(selectChangedVerification(changed.paths), {
      root,
      pathExists,
    }),
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
  // A deferred or escalated lane is the whole checkpoint. Never run a small
  // subset beside it and imply that it was adequate for the changed surface.
  if (!explain && selection.lanes.length === 0) {
    result.executed = runVitest(root, run, selection, {
      vitestPath,
      beforeCleanup(executions) {
        result.executed = executions;
        selection = escalateEmptyReports(selection, executions);
        result.selection = selection;
        result.nextCommands = nextCommands(selection);
        const earlyDiagnostics = diagnosticsArtifact(
          result,
          countsFor(executions),
          before,
        );
        writeReceipt(
          earlyDiagnostics.artifact.path,
          earlyDiagnostics.contents,
          root,
        );
      },
    });
    selection = escalateEmptyReports(selection, result.executed);
    result.selection = selection;
    result.nextCommands = nextCommands(selection);
  }
  const after = collectProvenance({ cwd: root });
  const counts = countsFor(result.executed);
  const deferred = explain || selection.lanes.length > 0;
  const failed = counts.failed > 0;
  const childFailed = result.executed.some(
    (execution) => execution.exitCode !== 0 && !execution.infrastructureError,
  );
  const infrastructureError = counts.infrastructureErrors > 0;
  const parserError = counts.parserErrors > 0 || counts.executed === 0;
  const status = deferred
    ? 'provisional'
    : infrastructureError
      ? 'infrastructure_error'
      : parserError
        ? 'parser_error'
        : failed || childFailed
          ? 'failed'
          : 'completed';
  const receiptExitCode = deferred
    ? null
    : status === 'completed'
      ? 0
      : result.executed.at(-1).exitCode || 1;
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
    cleanup: { status: 'not_required', survivingOwnedChildren: 0 },
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
    exitCode: explain ? 0 : deferred ? 3 : receipt.terminal.passed ? 0 : 1,
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    const result =
      args.length === 1 && args[0] === '--representative-narrow-diff'
        ? runRepresentativeNarrowDiffFixture()
        : runChangedVerification(args);
    console.log(renderChangedVerificationSummary(result));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
