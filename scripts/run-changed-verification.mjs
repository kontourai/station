#!/usr/bin/env node
import { spawn } from 'node:child_process';
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
import Ajv2020 from 'ajv/dist/2020.js';
import receiptSchema from '../schemas/verification-receipt.schema.json' with {
  type: 'json',
};
import { execFileSyncBounded } from './lib/bounded-capture.mjs';
import {
  CHANGED_DIAGNOSTIC_ERROR_LIMIT_BYTES,
  incompleteDiagnosticReasons,
} from './lib/changed-verification-diagnostics.mjs';
import {
  FAST_CHECKS_PLAN_KIND,
  FAST_CHECKS_SHARD_COUNT,
} from './lib/fast-checks-shards.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';
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
import { refineSdkBarrelRelatedPaths } from './lib/sdk-barrel-selection.mjs';
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
import { prepareVerificationExecution } from './lib/verification-request-context.mjs';
import { groupFiles, VITEST_CORPUS_GROUPS } from './run-vitest-corpus.mjs';
import {
  buildTestImpactManifest,
  isEscalationPath,
  matches,
  TEST_IMPACT_MANIFEST,
  validateTestImpactManifest,
} from './test-impact-manifest.mjs';
import { CI_FAST_TIMEOUT_MS, resolveLane } from './verification-lanes.mjs';
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
/**
 * #2855: related discovery is one fixed-cost Vitest graph build (27-38s on
 * hosted runners whatever the diff; 48-66s on a dev host at load 47-93), so
 * a constant below every enclosing budget failed closed on a busy host with
 * no test run. The timeout is now derived from the caller's remaining budget:
 * deadline - now - reserve.
 *
 * The floor is the old constant. A caller with no budget keeps exactly that;
 * a caller whose remaining budget is below it is refused before discovery
 * starts, since a timeout the budget cannot cover would only let the
 * enclosing kill win with nothing written. The reserve is what the caller
 * still needs after a discovery that
 * used everything else: the child's settlement (grace then force, 5s each),
 * provenance collection and the selection receipt or plan write -- so a slow
 * discovery ends as this lane's own attributable infrastructure_error rather
 * than being killed by the enclosing deadline with nothing written.
 */
export const RELATED_DISCOVERY_FLOOR_MS = 60_000;
export const RELATED_DISCOVERY_RESERVE_MS = 30_000;
/**
 * No caller's budget exceeds the fifteen-minute ci:fast lane, so a derived or
 * explicit timeout above it is a misconfiguration and is refused, not clamped.
 */
const RELATED_DISCOVERY_MAX_TIMEOUT_MS = CI_FAST_TIMEOUT_MS;
/** Absolute epoch-ms deadline run-ci-fast hands its selector child. */
export const CHANGED_DEADLINE_ENV = 'STATION_TEST_CHANGED_DEADLINE_AT';
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

function withoutChangedDeadline(env) {
  const { [CHANGED_DEADLINE_ENV]: _deadline, ...rest } = env;
  return rest;
}

export async function runOwnedChangedCommand(
  command,
  args,
  {
    cwd,
    env,
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
      // A shard passes the request-bound environment (#2709); otherwise the
      // child inherits this process's. Either way the selector's discovery
      // deadline (#2855) is its own, and no child inherits it.
      env: withoutChangedDeadline(env ?? process.env),
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

function assertDiscoveryTimeout(timeoutMs) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > RELATED_DISCOVERY_MAX_TIMEOUT_MS
  )
    throw new Error('Related Vitest discovery timeout is invalid');
  return timeoutMs;
}

/**
 * deadline - now - reserve, or the floor alone with no deadline. A budget
 * below the floor is refused before discovery starts, naming what is left;
 * a deadline that is not an integer, or that would allow more than the
 * ci:fast lane itself, is refused rather than clamped.
 */
export function relatedDiscoveryTimeoutMs({ deadlineAt, now = Date.now } = {}) {
  if (deadlineAt === undefined) return RELATED_DISCOVERY_FLOOR_MS;
  if (!Number.isSafeInteger(deadlineAt))
    throw new Error('Related Vitest discovery deadline is invalid');
  const remaining = deadlineAt - now() - RELATED_DISCOVERY_RESERVE_MS;
  if (remaining < RELATED_DISCOVERY_FLOOR_MS)
    throw new Error(
      `Related Vitest discovery refused: ${Math.max(0, remaining)}ms of its budget remain after the ${RELATED_DISCOVERY_RESERVE_MS}ms reserve, below the ${RELATED_DISCOVERY_FLOOR_MS}ms minimum`,
    );
  return assertDiscoveryTimeout(remaining);
}

/** The selector's deadline from its environment, strictly parsed. */
export function changedDeadlineFromEnv(env = process.env) {
  const value = env[CHANGED_DEADLINE_ENV];
  if (value === undefined || value === '') return undefined;
  if (!/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(
      `${CHANGED_DEADLINE_ENV} must be an epoch-millisecond integer`,
    );
  return Number(value);
}

/**
 * `base` enables SDK barrel-aware seeds (#2707): a changed SDK module is
 * replaced by the files whose imports actually reach it, rather than by
 * every importer of the SDK barrels that re-export it. Without a base the
 * paths go to Vitest unchanged.
 *
 * @param {string} root
 * @param {string[]} relatedPaths
 * @param {object} [options]
 * @param {string} [options.base] merge base the changed paths were diffed from
 * @param {typeof refineSdkBarrelRelatedPaths} [options.refine]
 * @param {(decision: any) => void} [options.reportRefinement]
 * @param {(...args: any[]) => Promise<any>} [options.run]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs] an explicit timeout; overrides deadlineAt
 * @param {number} [options.deadlineAt] the caller's budget end (epoch ms)
 * @param {() => number} [options.now]
 * @param {(timeoutMs: number) => void} [options.onTimeout] told the timeout the child runs under
 */
export async function discoverRelatedTestFiles(
  root,
  relatedPaths,
  {
    base,
    refine = refineSdkBarrelRelatedPaths,
    reportRefinement = (decision) => {
      process.stderr.write(
        `[test:changed] SDK barrel selection: ${decision.path} ${
          decision.disposition === 'refined'
            ? `-> ${decision.seeds} import seed(s)`
            : `kept whole (${decision.reason})`
        }\n`,
      );
    },
    run = runOwnedChangedCommand,
    signal,
    timeoutMs,
    deadlineAt,
    now = Date.now,
    onTimeout = () => {},
  } = {},
) {
  if (!Array.isArray(relatedPaths) || relatedPaths.length === 0)
    throw new Error('Related Vitest discovery requires at least one path');
  if (timeoutMs !== undefined) assertDiscoveryTimeout(timeoutMs);
  let result;
  try {
    const refined = refine(root, relatedPaths, { base });
    for (const decision of refined.decisions) reportRefinement(decision);
    // Every refined path reached no file outside SDK source: nothing imports
    // it, which is discovery's empty answer, not a failure.
    if (refined.paths.length === 0) return [];
    // Derived here, after refinement, so the child gets what is actually left.
    const childTimeoutMs =
      timeoutMs ?? relatedDiscoveryTimeoutMs({ deadlineAt, now });
    onTimeout(childTimeoutMs);
    result = await run(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        RELATED_DISCOVERY_SOURCE,
        ...refined.paths.map((path) => resolve(root, path)),
      ],
      {
        cwd: root,
        maxBytes: RELATED_DISCOVERY_LIMIT_BYTES,
        processLabel: 'Related Vitest discovery',
        signal,
        timeoutMs: childTimeoutMs,
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
    return execFileSyncBounded('git', args, {
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
  // Related paths some test-naming edge names by EXACT path — ordinary or
  // supplemental: a spawned-script edge, a derived path-read pin (#1807), a
  // generator-input edge. Each of those tests asserts about precisely this
  // file, so an empty related discovery leaves it covered. A glob edge never
  // owns a path: a blanket scan (the `src-ui/src/**` copy ratchet, the
  // `packages/sdk/src/client/**` portability scan) says nothing about one
  // file's behaviour, so it must not turn "no suite covers this file" into a
  // completed green (#2176).
  const ownedRelatedPaths = new Set();
  // Lanes a supplemental edge deferred, by the path that deferred them. Kept
  // structured so execution can tell them from escalations (see
  // prepareChangedSelection) without reading reason text.
  const supplementalDeferrals = [];
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
        !edge.except?.includes(path) &&
        (edge.whenAll?.every((required) => changed.has(required)) ?? true),
    );
    // A SUPPLEMENTAL edge only ever adds to `tests`: it is invisible to the
    // boundary, escalation, and related decisions below, so a derived edge
    // (`pathReadPinEdges`, #1807) cannot trade a broader selection for a
    // narrower one. Naming `tests` on an ordinary edge would set
    // `hasExplicitBoundary`, suppressing the generic `related` edge for the
    // same path, which is how an explicit list silently DROPS the related
    // suites (#1563, #1613). This says nothing about whether the added test
    // can run — `pathReadPinEdges` owns that.
    const boundaryEdges = edges.filter((edge) => !edge.supplemental);
    // Added before every branch below: a supplemental test is additive even
    // where the path escalates, and naming it in the receipt is the point.
    for (const edge of edges)
      if (edge.supplemental) {
        for (const test of edge.tests ?? [])
          addReason(tests, test, `${edge.reason}: ${path}`);
        for (const lane of edge.deferredLanes ?? []) {
          const reason = `${edge.reason}: ${path}`;
          addReason(lanes, lane, reason);
          supplementalDeferrals.push({ lane, path, reason });
        }
      }
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
    if (
      relatedPaths.has(path) &&
      edges.some((edge) => edge.pattern === path && edge.tests?.length)
    )
      ownedRelatedPaths.add(path);
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
    ownedRelatedPaths: [...ownedRelatedPaths].sort(),
    supplementalDeferrals,
    escalated,
  };
}

/**
 * The paths whose supplemental edges deferred every selected lane, or null
 * when any lane has another reason (an escalation, an ordinary lane edge, an
 * unavailable path or product law). A supplemental edge only adds work, so
 * its deferral must not cost the rest of the diff its related discovery.
 */
function supplementalOnlyDeferredPaths(selection) {
  const deferrals = selection.supplementalDeferrals ?? [];
  if (!selection.lanes.length || !deferrals.length) return null;
  for (const { id, reasons } of selection.lanes)
    for (const reason of reasons)
      if (
        !deferrals.some(
          (deferral) => deferral.lane === id && deferral.reason === reason,
        )
      )
        return null;
  return new Set(deferrals.map(({ path }) => path));
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

/**
 * @param {string} root
 * @param {{ tests: Array<{ path: string }>; relatedPaths: string[] }} selection
 * @param {{
 *   discoverRelated?: (root: string, relatedPaths: string[]) => Promise<string[]>;
 *   partition?: typeof partitionVitestResourceSubset;
 *   vitestPath?: string;
 * }} [options]
 */
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
  const planned = await planChangedVitestGroups(root, selection, {
    discoverRelated,
    partition,
  });
  return planned
    ? vitestExecutionsForGroups(planned.groups, { kind: planned.kind, vitest })
    : [];
}

/**
 * The selected suites, by resource group in canonical order (empty groups
 * omitted), or null when related discovery matched nothing.
 */
export async function planChangedVitestGroups(
  root,
  selection,
  {
    discoverRelated = discoverRelatedTestFiles,
    partition = partitionVitestResourceSubset,
  } = {},
) {
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
  if (candidates.length === 0 && selection.relatedPaths.length > 0) return null;
  const selected = validateSelectedTestFiles(root, candidates);
  const groups = partition(selected, { root });
  const kind = selection.relatedPaths.length
    ? selection.tests.length
      ? 'combined'
      : 'related'
    : 'explicit';
  return {
    kind,
    groups: VITEST_CORPUS_GROUPS.flatMap((group) => {
      const files = groupFiles(groups, group.name);
      return files.length
        ? [{ resourceGroup: group.name, files: [...files] }]
        : [];
    }),
  };
}

/**
 * One Vitest invocation per non-empty resource group, in canonical group
 * order, each with that group's own worker bound. The unsharded plan and a
 * fast-checks shard (#2709) both build their commands here, so a shard runs a
 * file under exactly the resource profile the unsharded lane would.
 */
export function vitestExecutionsForGroups(groups, { kind, vitest }) {
  const byName = new Map(groups.map((group) => [group.resourceGroup, group]));
  for (const name of byName.keys())
    if (!VITEST_CORPUS_GROUPS.some((group) => group.name === name))
      throw new Error(`unknown Vitest resource group '${name}'`);
  return VITEST_CORPUS_GROUPS.flatMap((group) => {
    const files = byName.get(group.name)?.files ?? [];
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
    planned,
    readReport = readFileSync,
    vitestPath,
    env,
  } = {},
) {
  let plannedExecutions;
  // How many suites related discovery named, observed rather than inferred
  // from the plan: explicit tests in the same plan must not hide an empty
  // discovery (#2176).
  let relatedDiscoveryCount;
  const discover = discoverRelated ?? discoverRelatedTestFiles;
  try {
    // A fast-checks shard (#2709) arrives with its commands already planned
    // from the shared plan artifact; discovery ran once, in the plan job.
    plannedExecutions =
      planned ??
      (await planChangedVitestExecutions(root, selection, {
        discoverRelated: async (discoveryRoot, relatedPaths) => {
          const files = await discover(discoveryRoot, relatedPaths);
          relatedDiscoveryCount = files.length;
          return files;
        },
        ...(partition ? { partition } : {}),
        vitestPath,
      }));
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
            ...(env ? { env } : {}),
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
    relatedDiscoveryEmpty: relatedDiscoveryCount === 0,
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
  // station#1911: how many suites were SELECTED is not how many RAN. When a
  // lane escalates, `executionSelection` drops every test above the 32-entry
  // cap, so the largest changes execute the fewest suites — and the summary
  // used to report only the selected figure, which reads like coverage that
  // did not happen. #1836 selected 153 and ran none while this line said
  // "153 focused target(s)". State the executed count beside it so a silent
  // truncation is legible in the log rather than only in the artifact.
  const executedCount = Array.isArray(result.executed)
    ? result.executed.length
    : undefined;
  const executedNote =
    executedCount === undefined
      ? ''
      : executedCount === 0 && focusedCount(result.selection) > 0
        ? `, 0 executed (selection deferred to a lane; none of the ${focusedCount(result.selection)} selected suites ran)`
        : `, ${executedCount} executed`;
  return [
    `[test:changed] ${result.paths?.length ?? 0} changed path(s); ${focusedCount(result.selection)} focused target(s)${executedNote}, ${result.selection.lanes.length} deferred lane(s) (${mode}).`,
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

/**
 * #2887: a product-law path ADDS its law's evidence; it does not defer the
 * diff. Laws used to be routed to a `ci-fast` lane, and any lane defers the
 * whole affected selection, so a diff touching `queueDrain.ts` ran none of
 * its ~600 related suites in fast-checks. But ci:fast already runs every
 * law's observation and fault injection on every change: product-law-gate
 * (inside the verification:policy:gate static, bounded by
 * MAX_PRODUCT_LAW_RUNTIME_MS). So the law is named, its observation suites
 * are selected beside the diff's own, and only genuinely unknown paths and
 * escalations still defer.
 */
/**
 * The suites that hold each named law's evidence: its behaviour observation
 * and its fault injection. Only a `vitest-file` evidence with a test file can
 * be selected; any other shape is refused naming the law and the kind (the
 * product-law gate rejects such a manifest too), rather than surfacing later
 * as an anonymous unsafe path.
 */
export function productLawEvidenceTests(manifest, productLaws) {
  const selected = [];
  for (const law of (manifest.laws ?? []).filter((entry) =>
    productLaws.includes(entry.id),
  ))
    for (const [role, evidence] of [
      ['observation', law.observation],
      ['fault-injection', law.faultInjection],
    ]) {
      if (
        evidence?.kind !== 'vitest-file' ||
        typeof evidence.testFile !== 'string' ||
        evidence.testFile.length === 0
      )
        throw new Error(
          `product law ${law.id} has ${role} evidence of kind '${String(evidence?.kind)}' without a Vitest test file; only vitest-file evidence can be selected`,
        );
      selected.push({
        path: evidence.testFile,
        reason: `product law ${law.id}: its ${role} suite (product-law-gate also runs it in the ci:fast statics)`,
      });
    }
  return selected;
}

function withProductLawDispositions(selection, root, changed) {
  const manifest = loadProductLawManifest({ rootDir: root });
  const productLaws = productLawDispositions(manifest, changed);
  if (productLaws.length === 0) return { selection, productLaws };
  const tests = new Map(
    selection.tests.map(({ path, reasons }) => [path, new Set(reasons)]),
  );
  for (const { path, reason } of productLawEvidenceTests(manifest, productLaws))
    addReason(tests, path, reason);
  return {
    selection: {
      ...selection,
      tests: [...tests.keys()]
        .sort()
        .map((path) => ({ path, reasons: [...tests.get(path)].sort() })),
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
      paths: result.paths,
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

/**
 * The selection half of the lane, before any child process: the diff, the
 * manifest routing and its escalations, product-law routing, and the subset
 * that is actually executed. Shared by the unsharded lane and the fast-checks
 * plan (#2709), so both select exactly the same suites.
 */
export function prepareChangedSelection(
  base,
  {
    root = process.cwd(),
    changedPathsFn = changedPaths,
    pathExists = existsSync,
  } = {},
) {
  const changed = changedPathsFn({ root, base });
  // The derived manifest adds the path-read pin edges (#1807): a test that
  // reads a source file's text has no import edge to it, so neither the graph
  // fallback nor `vitest related` would schedule it here.
  const escalated = escalateUnavailableExplicitTests(
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
    escalated,
    root,
    changed.paths,
  );
  const selection = productLawRouting.selection;
  // Broad import expansion remains deferred. Explicit, existing test targets
  // still provide bounded diagnostic failures; passing them cannot complete
  // the deferred obligations. Never truncate a selection into a green claim.
  // A lane deferred only by supplemental edges (#2922) keeps the other
  // paths' related discovery; the deferring paths themselves go to the lane.
  const deferredOnly = supplementalOnlyDeferredPaths(selection);
  const executionSelection =
    selection.lanes.length === 0
      ? selection
      : {
          ...selection,
          relatedPaths: deferredOnly
            ? selection.relatedPaths.filter((path) => !deferredOnly.has(path))
            : [],
          ownedRelatedPaths: deferredOnly
            ? (selection.ownedRelatedPaths ?? []).filter(
                (path) => !deferredOnly.has(path),
              )
            : selection.ownedRelatedPaths,
          tests:
            selection.tests.length <= 32
              ? selection.tests.filter((entry) =>
                  pathExists(resolve(root, entry.path)),
                )
              : [],
        };
  return { changed, selection, productLawRouting, executionSelection };
}

/**
 * Related paths a plan left without any suite. An empty discovery escalates
 * even when explicit tests keep the plan non-empty (#2176), except for a path
 * an edge names exactly (`ownedRelatedPaths`).
 */
function uncoveredRelatedPaths(executionSelection, outcome) {
  const owned = new Set(executionSelection.ownedRelatedPaths ?? []);
  return outcome.emptySelection === true
    ? executionSelection.relatedPaths
    : outcome.relatedDiscoveryEmpty === true
      ? executionSelection.relatedPaths.filter((path) => !owned.has(path))
      : [];
}

/**
 * One verdict rule for the unsharded lane and every fast-checks shard. An
 * infrastructure or parser fault outranks a test failure, which outranks a
 * deferral; an undeferred run that executed nothing is a parser error.
 */
export function changedVerificationStatus({ counts, executed, deferred }) {
  const childFailed = executed.some(
    (execution) => execution.exitCode !== 0 && !execution.infrastructureError,
  );
  if (counts.infrastructureErrors > 0) return 'infrastructure_error';
  if (counts.parserErrors > 0 || (!deferred && counts.executed === 0))
    return 'parser_error';
  if (counts.failed > 0 || childFailed) return 'failed';
  return deferred ? 'provisional' : 'completed';
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
    discoveryDeadlineAt,
  } = {},
) {
  // Resolve dependency provenance before selecting or starting Vitest. A
  // worktree may otherwise compile against a sibling checkout through a shared
  // node_modules link and create a receipt for the wrong source tree.
  assertDependencyProvenance({ cwd: root });
  const { base, explain } = parseChangedArgs(args);
  const prepared = prepareChangedSelection(base, {
    root,
    changedPathsFn,
    pathExists,
  });
  const { changed, productLawRouting, executionSelection } = prepared;
  let { selection } = prepared;
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
        // The merge base, not the ref: SDK barrel refinement compares
        // purity and exported names against the tree this diff was taken
        // from (#2707).
        discoverRelated: (discoveryRoot, relatedPaths) =>
          (
            discoverRelatedFiles ??
            ((rootPath, paths, options) =>
              discoverRelatedTestFiles(rootPath, paths, {
                ...options,
                run,
                signal,
                deadlineAt: discoveryDeadlineAt,
              }))
          )(discoveryRoot, relatedPaths, { base: changed.mergeBase }),
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
    //
    // #2176: an empty discovery escalates even when the plan still holds
    // explicit tests. A test selected only through a glob edge (a copy
    // ratchet over a whole tree) says nothing about the changed file, so
    // letting it make the plan non-empty turned "no suite covers this file"
    // into a completed green. Only a path an edge names exactly
    // (`ownedRelatedPaths`) is covered without its graph.
    //
    // Granularity: discovery is ONE call over every related path, and it
    // returns the union of suites, not a per-input answer. So this fires only
    // when discovery returns nothing for the whole set; a diff where one path
    // has importers and another has none is not detected. A per-path answer
    // would cost one Vitest graph build per changed file.
    const uncovered = uncoveredRelatedPaths(executionSelection, vitestOutcome);
    if (uncovered.length > 0 && !vitestOutcome.preparation) {
      result.emptyRelatedSelection = {
        relatedPaths: [...uncovered].sort(),
        remedy: EMPTY_RELATED_SELECTION_REMEDY,
      };
      selection = escalateEmptyRelatedSelection(selection, uncovered);
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
  const status = changedVerificationStatus({
    counts,
    executed: result.executed,
    deferred: explain || selection.lanes.length > 0,
  });
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
  // Always rewrite the diagnostic the receipt binds. The early write in
  // `beforeCleanup` is only a breadcrumb for a run that dies before this
  // point: an empty related discovery can still escalate the selection after
  // Vitest returns, and a breadcrumb left in place would no longer match the
  // digest bound below, so ci:fast would refuse the attachment.
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
/** The ci-fast lane's execution preparation, as its coordinator applies it. */
function prepareCiFastExecution({ cwd, env }) {
  return prepareVerificationExecution({
    lane: resolveLane('ci-fast'),
    cwd,
    env,
  });
}

/**
 * #2709: the fast-checks plan. Selection, related discovery, resource
 * partitioning and the empty-discovery escalation run exactly as the
 * unsharded lane runs them, once, and stop before any test executes. A
 * discovery or planning fault throws: no plan is written, and the required
 * aggregator fails on the missing plan.
 */
/**
 * @param {string} base
 * @param {{
 *   root?: string;
 *   run?: typeof runOwnedChangedCommand;
 *   changedPathsFn?: typeof changedPaths;
 *   discoverRelatedFiles?: (root: string, relatedPaths: string[], options?: { base?: string; onTimeout?: (timeoutMs: number) => void }) => Promise<string[]>;
 *   resourcePartition?: typeof partitionVitestResourceSubset;
 *   assertDependencyProvenance?: (options: { cwd: string }) => unknown;
 *   pathExists?: typeof existsSync;
 *   signal?: AbortSignal;
 *   discoveryDeadlineAt?: number;
 *   headSha?: string;
 *   shardCount?: number;
 *   now?: () => number;
 * }} [options]
 */
export async function planChangedVerificationShards(
  base,
  {
    root = process.cwd(),
    run = runOwnedChangedCommand,
    changedPathsFn = changedPaths,
    discoverRelatedFiles,
    resourcePartition = partitionVitestResourceSubset,
    assertDependencyProvenance = assertWorkspacePackageProvenance,
    pathExists = existsSync,
    signal,
    discoveryDeadlineAt,
    headSha = git(root, ['rev-parse', 'HEAD']).trim(),
    shardCount = FAST_CHECKS_SHARD_COUNT,
    now = Date.now,
  } = {},
) {
  assertDependencyProvenance({ cwd: root });
  const prepared = prepareChangedSelection(base, {
    root,
    changedPathsFn,
    pathExists,
  });
  const { changed, productLawRouting, executionSelection } = prepared;
  let { selection } = prepared;
  let groups = [];
  let emptyRelatedSelection;
  let relatedDiscovery;
  if (
    executionSelection.tests.length ||
    executionSelection.relatedPaths.length
  ) {
    let relatedDiscoveryCount;
    const discover =
      discoverRelatedFiles ??
      ((rootPath, paths, options) =>
        discoverRelatedTestFiles(rootPath, paths, {
          ...options,
          run,
          signal,
          deadlineAt: discoveryDeadlineAt,
        }));
    const planned = await planChangedVitestGroups(root, executionSelection, {
      discoverRelated: async (discoveryRoot, relatedPaths) => {
        const startedAt = now();
        let timeoutMilliseconds;
        const files = await discover(discoveryRoot, relatedPaths, {
          base: changed.mergeBase,
          onTimeout: (value) => {
            timeoutMilliseconds = value;
          },
        });
        // #2803: discovery now runs on far more pull requests. Record its
        // cost in every plan, so the hosted margin is measured per run rather
        // than argued; #2855 derives the timeout from the budget, so record
        // the timeout the child actually ran under (absent when no child
        // started, e.g. refinement found nothing to discover).
        relatedDiscovery = {
          milliseconds: now() - startedAt,
          ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }),
        };
        relatedDiscoveryCount = files.length;
        return files;
      },
      partition: resourcePartition,
    });
    groups = planned?.groups ?? [];
    const uncovered = uncoveredRelatedPaths(executionSelection, {
      emptySelection: groups.length === 0,
      relatedDiscoveryEmpty: relatedDiscoveryCount === 0,
    });
    if (uncovered.length > 0) {
      emptyRelatedSelection = {
        relatedPaths: [...uncovered].sort(),
        remedy: EMPTY_RELATED_SELECTION_REMEDY,
      };
      selection = escalateEmptyRelatedSelection(selection, uncovered);
    }
  }
  return {
    schemaVersion: 1,
    kind: FAST_CHECKS_PLAN_KIND,
    base,
    mergeBase: changed.mergeBase,
    headSha,
    shardCount,
    changedPathCount: changed.paths.length,
    deferredLanes: selection.lanes,
    escalated: selection.escalated,
    productLaws: productLawRouting.productLaws,
    ...(emptyRelatedSelection ? { emptyRelatedSelection } : {}),
    ...(relatedDiscovery ? { relatedDiscovery } : {}),
    groups,
    fileCount: groups.reduce((total, group) => total + group.files.length, 0),
  };
}

/**
 * Runs one shard's slice of a validated plan through the same execution loop
 * and verdict rule as the unsharded lane. The plan's deferral carries over:
 * a deferred plan makes a passing shard `provisional`, as the selector's exit
 * 3 does for ci:fast.
 */
/**
 * @param {{ deferredLanes: unknown[] }} plan
 * @param {{ groups: Array<{ resourceGroup: string; files: string[] }>; files: string[] }} slice
 * @param {{
 *   root?: string;
 *   run?: (command: string, args: string[], options: any) => Promise<any>;
 *   vitestPath?: string;
 *   readReport?: typeof readFileSync;
 *   signal?: AbortSignal;
 *   assertDependencyProvenance?: (options: { cwd: string }) => unknown;
 *   env?: Record<string, string | undefined>;
 *   prepareExecution?: (options: { cwd: string; env: Record<string, string | undefined> }) => { env: Record<string, string | undefined> };
 * }} [options]
 */
export async function runChangedVerificationShard(
  plan,
  slice,
  {
    root = process.cwd(),
    run = runOwnedChangedCommand,
    vitestPath,
    readReport,
    signal,
    assertDependencyProvenance = assertWorkspacePackageProvenance,
    env = process.env,
    prepareExecution = prepareCiFastExecution,
  } = {},
) {
  // The same preflight the unsharded lane runs before any Vitest child: a
  // shared node_modules link must not run the tests of another tree.
  assertDependencyProvenance({ cwd: root });
  // Review F1/H1: `npm run ci:fast` runs its children under the verification
  // coordinator, which checks the install against the lockfile and binds
  // the request environment (STATION_VERIFICATION_HISTORY_REF = this head,
  // not origin/main). A shard takes the same preparation, from the same
  // function, so the tests it runs see what the lane's did.
  const childEnv = prepareExecution({ cwd: root, env }).env;
  const vitest = vitestPath ?? resolve(root, 'node_modules/vitest/vitest.mjs');
  validateSelectedTestFiles(root, slice.files);
  const planned = vitestExecutionsForGroups(slice.groups, {
    kind: 'shard',
    vitest,
  });
  const outcome = await runVitest(
    root,
    run,
    { signal },
    { planned, env: childEnv, ...(readReport ? { readReport } : {}) },
  );
  const counts = countsFor(outcome.executions, outcome.preparation);
  const status = changedVerificationStatus({
    counts,
    executed: outcome.executions,
    deferred:
      plan.deferredLanes.length > 0 ||
      outcome.executions.some((execution) => execution.empty),
  });
  return {
    status,
    counts,
    ...(outcome.preparation
      ? {
          preparation: {
            phase: outcome.preparation.phase,
            error: outcome.preparation.error,
          },
        }
      : {}),
    executions: outcome.executions.map((execution) => ({
      resourceGroup: execution.resourceGroup,
      exitCode: execution.exitCode,
      infrastructureError: execution.infrastructureError === true,
      ...(execution.error ? { error: execution.error } : {}),
      ...(execution.empty ? { empty: true } : {}),
      ...(execution.failedTests ? { failedTests: execution.failedTests } : {}),
    })),
  };
}

if (invokedDirectly(import.meta.url)) {
  const controller = new AbortController();
  const unregister = ['SIGINT', 'SIGTERM'].map((name) =>
    registerProcessSignal(name, () => controller.abort(name)),
  );
  try {
    const args = process.argv.slice(2);
    const result = await (args.length === 1 &&
    args[0] === '--representative-narrow-diff'
      ? runRepresentativeNarrowDiffFixture({ signal: controller.signal })
      : runChangedVerification(args, {
          signal: controller.signal,
          // #2855: run-ci-fast hands its selector the end of its allowance.
          discoveryDeadlineAt: changedDeadlineFromEnv(),
        }));
    console.log(renderChangedVerificationSummary(result));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  } finally {
    for (const remove of unregister) remove();
  }
}
