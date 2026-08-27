/**
 * Run the full Playwright coverage contract and report every bucket.
 *
 * `verify:e2e:full` used to chain its buckets with `&&`, so the first failure
 * ended the run and the remaining buckets never executed. That turned one flaky
 * spec into a blind spot: with the `product` bucket failing intermittently, the
 * five buckets behind it went unrun for long enough that a genuine, persistent
 * failure in `extended` (the MCP-UI host bridge and its containment suite) sat
 * red without anyone seeing it. Hosted CI could not catch it either.
 *
 * Every bucket runs here regardless of what came before, and the summary lists
 * all of them. The exit code is still non-zero if any bucket failed — this
 * widens visibility, it does not weaken the gate.
 */

import { execFileSync, spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectLatestE2EEvidence } from './lib/e2e-latest-evidence.mjs';
import {
  executeOwnedProcess,
  registerProcessSignal,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from './lib/owned-process.mjs';

/**
 * The coverage contract, in run order. `pr-smoke` is deliberately absent: it is
 * the bounded pre-PR lane, not part of full coverage.
 *
 * `android` runs through `test:android` rather than `test:e2e:android` — the
 * one bucket whose script does not follow the pattern.
 *
 * Weights are resource tiers, not test counts. The scheduler admits a bucket
 * only when `weight + usedCapacity <= capacity`, so a pair whose weights sum
 * past `DEFAULT_E2E_CAPACITY` can NEVER overlap — structurally, regardless of
 * completion order. That is the guarantee that keeps startup-heavy buckets
 * apart: every bucket here boots a full Station instance, but the ones whose
 * startup/build phase is heavy enough that two together blow the host budget
 * (product, first-run, starter-clean-install, extended, android) are weighted
 * so any pair of them sums past the default (5 + 2 > 6, 5 + 5 > 6).
 *
 * `android` is weight 5, not 3: at weight 3 it paired with `first-run` (2) at
 * 5 <= 6 and the two simultaneous full Station startups exceeded the budget —
 * first-run's boot starved android's TCP readiness wait until it timed out.
 * Android boots a full Station build plus an Android target, so it is at least
 * as heavy as product/extended; weight 5 keeps it off every other
 * startup-heavy bucket while still admitting a single light partner (5 + 1 = 6).
 */
export const BUCKETS = [
  { name: 'product', script: 'test:e2e:product', weight: 5 },
  { name: 'first-run', script: 'test:e2e:first-run', weight: 2 },
  {
    name: 'starter-clean-install',
    script: 'test:e2e:starter-clean-install',
    weight: 5,
  },
  { name: 'smoke-live', script: 'test:e2e:smoke-live', weight: 1 },
  { name: 'extended', script: 'test:e2e:extended', weight: 5 },
  { name: 'screenshot', script: 'test:e2e:screenshot', weight: 1 },
  { name: 'android', script: 'test:android', weight: 5 },
];

// This is deliberately a small host-wide budget. It permits a heavy browser
// bucket plus a light, independently isolated bucket, but never two
// startup-heavy buckets together (see BUCKETS). CI or a deliberately
// provisioned developer host can raise it, but the upper bound prevents an
// accidental environment export from turning one request into six concurrent
// Station builds.
export const DEFAULT_E2E_CAPACITY = 6;
const MAX_E2E_CAPACITY = 12;

/**
 * Strip terminal escape sequences so the tally can be matched as text.
 *
 * Playwright's summary is not plain text. Its epilogue wraps each token in
 * colour (`generateSummaryMessage` uses `screen.colors.green` etc.) and the
 * `line` reporter prefixes the line it is rewriting with a cursor-control
 * sequence, so a real tally arrives on the wire as:
 *
 *     \x1b[1A\x1b[2K\x1b[32m  1 passed\x1b[39m\x1b[2m (46.2s)\x1b[22m
 *
 * Playwright only strips those itself when it decides colour is off — and it
 * decides colour is *on* whenever `FORCE_COLOR` is set, which npm sets for
 * every script it runs. So the escape prefix is the normal case here, not the
 * exotic one, and a `^`-anchored match against the raw output never fired.
 *
 * Stripping (rather than dropping the `^` anchor) keeps the anchor doing its
 * job: it is what stops a count quoted inside a spec title or an error message
 * from being counted as a tally.
 */
const ANSI_ESCAPE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC is the point
  /\u001B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)|[@-Z\\-_])/g;

export function stripAnsi(text) {
  return text.replace(ANSI_ESCAPE, '');
}

/** Every outcome Playwright can print in its epilogue. */
const TALLY_KINDS = [
  'failed',
  'interrupted',
  'flaky',
  'passed',
  'skipped',
  'did not run',
];

/** Outcomes that mean a test body actually executed. */
const EXECUTED_KINDS = ['failed', 'interrupted', 'flaky', 'passed'];

/** Pull Playwright's own tally out of a bucket's output. */
export function summarize(output) {
  const counts = {};
  for (const [, n, kind] of stripAnsi(output).matchAll(
    /^\s*(\d+)\s+(passed|failed|interrupted|flaky|skipped|did not run)\s*(?:\(|$)/gm,
  )) {
    counts[kind] = (counts[kind] ?? 0) + Number(n);
  }
  return counts;
}

/** How many tests actually ran. Skipped and did-not-run are not coverage. */
export function executedCount(counts) {
  return EXECUTED_KINDS.reduce((total, k) => total + (counts[k] ?? 0), 0);
}

/** `5 failed, 102 passed` — or a plain marker when Playwright printed no tally. */
export function formatCounts(counts) {
  const parts = TALLY_KINDS.filter((k) => counts[k]).map(
    (k) => `${counts[k]} ${k}`,
  );
  return parts.length > 0 ? parts.join(', ') : 'no test tally reported';
}

/**
 * PASS / FAIL / EMPTY.
 *
 * `EMPTY` exists because a bucket that executed nothing is indistinguishable
 * from a bucket that passed if you only look at an exit code — and this repo
 * has actually hit that: a bucket exited clean in 13s having run zero specs.
 * Zero tests is zero coverage, so it fails the coverage contract rather than
 * quietly reading as green.
 */
export function bucketVerdict({ ok, counts }) {
  if (!ok) return 'FAIL';
  return executedCount(counts) === 0 ? 'EMPTY' : 'PASS';
}

/**
 * Spec files that reported a failure, for a summary that names names.
 *
 * Playwright colours the failure list too (`colors.red(formatTestHeader(...))`),
 * so this has to strip escapes for the same reason `summarize` does.
 */
export function failingSpecs(output) {
  const specs = new Set();
  for (const [, spec] of stripAnsi(output).matchAll(
    /^\s*\d+\)\s+\[[^\]]+\]\s+›\s+(\S+?\.spec\.ts)/gm,
  )) {
    specs.add(spec);
  }
  return [...specs];
}

/**
 * A bucket's whole output has to fit in one buffer for the tally to survive.
 *
 * `spawnSync`'s default `maxBuffer` is 1 MiB. Crossing it does not just drop
 * the tail that holds the tally — Node kills the child and reports
 * `status: null`, so a bucket would be reported FAIL, with no counts, for a
 * reason that has nothing to do with the tests. A failing bucket's output
 * (per-test errors plus the 16 KB server-log tail this repo prints on failure)
 * is exactly the case that gets closest to the limit, which is the worst
 * possible time to lose the report.
 */
// A full bucket's unredacted terminal stream belongs in the runner's retained
// artifacts, not in this coordinating process. Keep only a small bounded
// transcript for Playwright's final tally; overflow is a failed infrastructure
// outcome and terminates the exact owned tree.
const BUCKET_OUTPUT_LIMIT = 512 * 1024;
const BUCKET_SETTLEMENT_MS = 5_000;

export function assertSupportedE2EPlatform(platform = process.platform) {
  if (platform === 'win32') {
    throw new Error(
      'Full Station E2E requires a POSIX host with process-group settlement; Windows needs a separately owned host lane.',
    );
  }
}

function runnerFailure(
  bucket,
  started,
  error,
  { failureKind = 'runner-error', interrupted = false } = {},
) {
  return {
    ...bucket,
    ok: false,
    verdict: 'FAIL',
    runnerError: String(error?.message ?? error),
    seconds: Math.round((Date.now() - started) / 1000),
    counts: {},
    specs: [],
    output: '',
    interrupted,
    failureKind,
  };
}

function interruptedBucket(bucket, reason) {
  return runnerFailure(
    bucket,
    Date.now(),
    new Error(`coverage run cancelled (${reason})`),
    { interrupted: true, failureKind: 'interrupted' },
  );
}

function captureBucketOutput(child, maxBytes, onOverflow) {
  const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });
  let output = '';
  let bytes = 0;
  let overflow = false;
  const capture = (chunk) => {
    if (overflow) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      overflow = true;
      output = '';
      onOverflow();
      return;
    }
    output += decoder.decode(buffer, { stream: true });
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  return {
    finish() {
      child.stdout?.off('data', capture);
      child.stderr?.off('data', capture);
      if (!overflow) output += decoder.decode();
      return {
        bytes,
        overflow,
        output: overflow
          ? `[output omitted: bucket output exceeded ${maxBytes} byte limit]\n`
          : output,
      };
    },
  };
}

function deferred() {
  let resolveDeferred = () => undefined;
  const promise = new Promise((resolvePromise) => {
    resolveDeferred = resolvePromise;
  });
  return { promise, resolve: resolveDeferred };
}

async function terminateWindowsBucket(execution, treeSettlement) {
  const errors = [];
  try {
    await execution.terminate();
    // `taskkill /t` returning 0 is the only available exact tree-settlement
    // proof on this host: it targets the known launcher PID and waits for the
    // requested tree operation. Do not infer settlement from launcher close.
    treeSettlement.proven = true;
    return { settled: true, errors };
  } catch (error) {
    errors.push(error);
  }
  try {
    await execution.forceTerminate();
    treeSettlement.proven = true;
    return { settled: true, errors };
  } catch (error) {
    errors.push(error);
    return { settled: false, errors };
  }
}

/**
 * Start and own one complete bucket process tree.
 *
 * `npm` is only the launcher. It must be a detached process-group leader so
 * cancellation and output overflow target the actual `run-e2e-suite` tree,
 * not just the npm wrapper. Completion waits for the exact owned group to be
 * gone before it resolves and returns its temp/output paths to the scheduler.
 */
export function startBucket(
  bucket,
  {
    execute = executeOwnedProcess,
    terminate = terminateSuiteExecution,
    waitForSettlement = waitForSuiteSettlement,
    maxOutputBytes = BUCKET_OUTPUT_LIMIT,
    platform = process.platform,
    env = process.env,
  } = {},
) {
  const started = Date.now();
  const processLabel = `e2e bucket ${bucket.name}`;
  const treeSettlement = { proven: false };
  let execution;
  try {
    execution = execute(
      platform === 'win32' ? 'npm.cmd' : 'npm',
      ['run', bucket.script],
      spawn,
      processLabel,
      {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env,
        treeSettled: () => treeSettlement.proven,
      },
    );
  } catch (error) {
    return {
      promise: Promise.resolve(
        runnerFailure(bucket, started, error, { failureKind: 'spawn' }),
      ),
      cancel: async () => ({ settled: true, errors: [] }),
    };
  }

  let cleanupCause = null;
  let cleanupReason = null;
  let cleanupPromise = null;
  const cleanupDone = deferred();
  const requestCleanup = (reason, cause) => {
    cleanupReason ??= reason;
    cleanupCause ??= cause;
    if (!cleanupPromise) {
      cleanupPromise = (
        platform === 'win32'
          ? terminateWindowsBucket(execution, treeSettlement)
          : Promise.resolve(
              terminate(execution, {
                processLabel,
                waitForSuiteSettlement: waitForSettlement,
                terminationGraceMs: BUCKET_SETTLEMENT_MS,
                terminationForceMs: BUCKET_SETTLEMENT_MS,
              }),
            )
      )
        .catch((error) => ({ settled: false, errors: [error] }))
        .then((result) => {
          cleanupDone.resolve(result);
          return result;
        });
    }
    return cleanupPromise;
  };
  const capture = captureBucketOutput(execution.child, maxOutputBytes, () => {
    void requestCleanup(`output exceeded ${maxOutputBytes} bytes`, 'overflow');
  });
  const promise = (async () => {
    const settled = await Promise.race([
      execution.completion.then((completion) => ({ completion })),
      cleanupDone.promise.then((cleanup) => ({ cleanup })),
    ]);
    const completion = settled.completion ?? { status: null, signal: null };
    if (completion.error) {
      await requestCleanup(
        `runner error: ${String(completion.error.message ?? completion.error)}`,
        'runner-error',
      );
    }
    if (settled.completion && execution.isAlive())
      await requestCleanup('runner tree remained alive', 'process-tree');
    const cleanup = cleanupPromise ? await cleanupPromise : null;
    const captured = capture.finish();
    const cleanupError = cleanup?.errors?.[0];
    const cleanupDidNotSettle = cleanup?.settled === false;
    const cleanupDispatchFailed = !cleanupDidNotSettle && Boolean(cleanupError);
    const failureKind = cleanupDidNotSettle
      ? 'process-tree'
      : cleanupDispatchFailed
        ? 'cleanup-dispatch'
        : captured.overflow
          ? 'overflow'
          : (cleanupCause ?? (completion.error ? 'runner-error' : null));
    const runnerError =
      failureKind === 'overflow'
        ? `bucket output exceeded ${maxOutputBytes} byte limit`
        : failureKind === 'interrupted'
          ? `coverage run cancelled (${cleanupReason})`
          : failureKind === 'process-tree'
            ? `${processLabel} cleanup did not settle${cleanupReason ? ` after ${cleanupReason}` : ''}`
            : failureKind === 'cleanup-dispatch'
              ? `${processLabel} cleanup required escalation: ${String(cleanupError?.message ?? cleanupError)}`
              : cleanupError
                ? String(cleanupError.message ?? cleanupError)
                : completion.error
                  ? String(completion.error.message ?? completion.error)
                  : cleanup?.settled === false
                    ? `${processLabel} cleanup did not settle`
                    : null;
    const ok = completion.status === 0 && !runnerError;
    const counts = summarize(captured.output);
    const result = {
      ...bucket,
      ok,
      verdict: bucketVerdict({ ok, counts }),
      runnerError,
      seconds: Math.round((Date.now() - started) / 1000),
      counts,
      specs: failingSpecs(captured.output),
      output: captured.output,
      interrupted: cleanupCause === 'interrupted',
      failureKind,
      overflow: captured.overflow,
      outputBytes: captured.bytes,
    };
    return result;
  })();
  return {
    promise,
    cancel: (reason) => requestCleanup(reason, 'interrupted'),
  };
}

/**
 * Read a deliberately constrained host capacity from the environment.
 *
 * A capacity unit is a bucket weight, not a Playwright worker. The default
 * keeps regular developer machines responsive; a malformed or implausibly
 * large value is an invalid request, not a reason to silently fall back to a
 * less safe concurrency setting.
 */
export function readCapacity(raw = process.env.STATION_E2E_CAPACITY) {
  if (raw === undefined || raw === '') return DEFAULT_E2E_CAPACITY;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(
      `STATION_E2E_CAPACITY must be an integer from 1 to ${MAX_E2E_CAPACITY}`,
    );
  }
  const capacity = Number(raw);
  if (!Number.isSafeInteger(capacity) || capacity > MAX_E2E_CAPACITY) {
    throw new Error(
      `STATION_E2E_CAPACITY must be an integer from 1 to ${MAX_E2E_CAPACITY}`,
    );
  }
  return capacity;
}

function validateSelectedBuckets(selected, capacity) {
  for (const bucket of selected) {
    if (!Number.isSafeInteger(bucket.weight) || bucket.weight < 1) {
      throw new Error(`Bucket ${bucket.name} has an invalid resource weight`);
    }
    if (bucket.weight > capacity) {
      throw new Error(
        `STATION_E2E_CAPACITY=${capacity} cannot run ${bucket.name} (weight ${bucket.weight})`,
      );
    }
  }
}

/**
 * Run the selected, already-isolated buckets under one host resource budget.
 *
 * Results deliberately stay in manifest order even when a later lightweight
 * bucket finishes first. More importantly, child output is held until all
 * children have ended and then emitted as whole canonical-order blocks, so
 * Playwright reporters never write over one another on the parent stdout.
 */
export async function runBuckets(
  selected,
  {
    capacity = DEFAULT_E2E_CAPACITY,
    runBucket = startBucket,
    onEvent,
    signal,
    env,
  } = {},
) {
  validateSelectedBuckets(selected, capacity);
  const results = new Array(selected.length);
  const pending = new Set(selected.map((_, index) => index));
  const activeExecutions = new Map();
  let usedCapacity = 0;
  let active = 0;
  let cancelled = false;
  let cancellationReason = null;

  return new Promise((resolve) => {
    let resolved = false;
    let cancellationSettled = Promise.resolve();
    const finish = () => {
      if (resolved) return;
      resolved = true;
      signal?.removeEventListener?.('abort', onAbort);
      resolve(results);
    };
    const maybeFinish = () => {
      if (cancelled) {
        if (active !== 0) return;
        void cancellationSettled.finally(finish);
        return;
      }
      if (active === 0 && pending.size === 0) finish();
    };
    const cancel = (reason = 'aborted') => {
      if (cancelled) return;
      cancelled = true;
      cancellationReason = String(reason);
      for (const index of pending) {
        results[index] = interruptedBucket(selected[index], cancellationReason);
      }
      pending.clear();
      cancellationSettled = Promise.all(
        [...activeExecutions.values()].map((execution) =>
          Promise.resolve(execution.cancel(cancellationReason)).catch(
            () => undefined,
          ),
        ),
      );
      maybeFinish();
    };
    const onAbort = () => cancel(signal?.reason ?? 'aborted');
    const schedule = () => {
      if (cancelled) return;
      let launched = true;
      while (launched) {
        launched = false;
        for (const index of pending) {
          const bucket = selected[index];
          if (bucket.weight + usedCapacity > capacity) continue;
          pending.delete(index);
          usedCapacity += bucket.weight;
          active += 1;
          let execution;
          try {
            const started = runBucket(bucket, { env });
            execution =
              started && typeof started === 'object' && 'promise' in started
                ? {
                    promise: started.promise,
                    cancel:
                      typeof started.cancel === 'function'
                        ? started.cancel
                        : async () => {},
                  }
                : { promise: Promise.resolve(started), cancel: async () => {} };
          } catch (error) {
            execution = {
              promise: Promise.resolve(
                runnerFailure(bucket, Date.now(), error),
              ),
              cancel: async () => {},
            };
          }
          activeExecutions.set(index, execution);
          // Publish the owned execution before reporting the start event: an
          // event observer may synchronously abort, and that abort must see
          // this exact tree rather than admitting it after cancellation.
          onEvent?.({ type: 'start', bucket, usedCapacity });
          Promise.resolve(execution.promise)
            .catch((error) => runnerFailure(bucket, Date.now(), error))
            .then((result) => {
              activeExecutions.delete(index);
              results[index] =
                cancelled && !result?.interrupted
                  ? interruptedBucket(bucket, cancellationReason)
                  : result;
              usedCapacity -= bucket.weight;
              active -= 1;
              onEvent?.({
                type: 'finish',
                bucket,
                usedCapacity,
                result: results[index],
              });
              if (!cancelled) schedule();
              maybeFinish();
            });
          launched = true;
          break;
        }
      }
    };
    if (signal?.aborted) cancel(signal.reason ?? 'aborted');
    else signal?.addEventListener?.('abort', onAbort, { once: true });
    schedule();
  });
}

export function writeBucketOutputs(results) {
  for (const result of results) {
    process.stdout.write(`\n──── e2e bucket: ${result.name} ────\n`);
    process.stdout.write(result.output ?? '');
  }
}

export function parseCoverageArgs(args, buckets = BUCKETS) {
  let only = null;
  for (const argument of args) {
    if (!argument.startsWith('--only='))
      throw new Error(
        `Unknown argument '${argument}'. Only --only=<bucket,...> is supported.`,
      );
    if (only !== null) throw new Error('--only may be provided only once.');
    const value = argument.slice('--only='.length);
    if (!value) throw new Error('--only requires at least one bucket name.');
    only = value.split(',');
    if (only.some((name) => !name))
      throw new Error('--only cannot contain an empty bucket name.');
  }
  if (only === null) return buckets;
  const known = new Set(buckets.map((bucket) => bucket.name));
  const unknown = only.filter((name) => !known.has(name));
  if (unknown.length > 0)
    throw new Error(
      `Unknown E2E bucket(s): ${unknown.join(', ')}. Known buckets: ${buckets.map((bucket) => bucket.name).join(', ')}`,
    );
  if (new Set(only).size !== only.length)
    throw new Error('--only cannot name a bucket more than once.');
  return buckets.filter((bucket) => only.includes(bucket.name));
}

export function createE2ERunIdentity(now = Date.now(), pid = process.pid) {
  return `e2e-${now.toString(36)}-${pid}`;
}

function currentRevision() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

/** Promote the completed run even when its coverage result is red or empty. */
export function projectCoverageEvidence(
  results,
  { runId, evidenceRoot, revision = currentRevision() } = {},
) {
  const projection = {
    sourceDir: evidenceRoot,
    destinationDir: join(process.cwd(), '.kontourai', 'e2e-latest'),
    workspaceRoot: process.cwd(),
    runId,
    source: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local',
    revision,
    ciRunId: process.env.GITHUB_RUN_ID ?? null,
    buckets: results,
    allowMissingSource: true,
  };
  try {
    return projectLatestE2EEvidence(projection);
  } catch (error) {
    // Never retain a prior green pointer merely because hostile or oversized
    // failure output could not be copied. The bounded red manifest records
    // that omission while preserving the completed bucket truth.
    return projectLatestE2EEvidence({
      ...projection,
      evidenceOmission: { reason: error?.message ?? String(error) },
    });
  }
}

export function projectionRequiresFailure(manifest) {
  return manifest?.evidenceOmission != null;
}

export async function main() {
  try {
    assertSupportedE2EPlatform();
  } catch (error) {
    console.error(`Unsupported E2E host: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  let selected;
  try {
    selected = parseCoverageArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Invalid E2E arguments: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  let capacity;
  try {
    capacity = readCapacity();
    validateSelectedBuckets(selected, capacity);
  } catch (error) {
    console.error(`Invalid E2E capacity: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  console.log(
    `[e2e] scheduling ${selected.length} bucket(s) with capacity ${capacity}; output follows in manifest order.`,
  );
  const controller = new AbortController();
  const removeSignalHandlers = ['SIGINT', 'SIGTERM'].map((signal) =>
    registerProcessSignal(signal, () => controller.abort(signal)),
  );
  let results;
  const runId = createE2ERunIdentity();
  const evidenceRoot = join(
    process.cwd(),
    '.kontourai',
    'e2e-runs',
    runId,
    'evidence',
  );
  try {
    results = await runBuckets(selected, {
      capacity,
      signal: controller.signal,
      env: {
        ...process.env,
        STATION_E2E_RUN_ID: runId,
        STATION_E2E_EVIDENCE_ROOT: evidenceRoot,
        STATION_E2E_GALLERY_DIR: join(evidenceRoot, 'gallery'),
      },
    });
  } finally {
    for (const remove of removeSignalHandlers) remove();
  }
  try {
    const evidence = projectCoverageEvidence(results, { runId, evidenceRoot });
    console.log(
      `[e2e] latest evidence projected: .kontourai/e2e-latest/ (${evidence.verdict})`,
    );
    if (evidence.projectionBinding)
      console.log(
        `[e2e-binding] ${Buffer.from(JSON.stringify(evidence.projectionBinding)).toString('base64url')}`,
      );
    if (projectionRequiresFailure(evidence)) {
      console.error(
        '[e2e] latest evidence payload was omitted; the full E2E result is not reusable.',
      );
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(
      `FAIL: unable to project latest E2E evidence: ${error.message}`,
    );
    process.exitCode = 1;
  } finally {
    // The latest projection is the retained, bounded surface. The isolated
    // run gallery is only a staging source and must not grow across runs.
    rmSync(join(process.cwd(), '.kontourai', 'e2e-runs', runId), {
      recursive: true,
      force: true,
    });
  }
  writeBucketOutputs(results);

  console.log('\n════ Playwright coverage summary ════');
  for (const r of results) {
    console.log(
      `  ${r.verdict.padEnd(5)} ${r.name.padEnd(11)} ${String(r.seconds).padStart(4)}s  ${formatCounts(r.counts)}`,
    );
    if (r.verdict === 'EMPTY') {
      console.log('          executed 0 tests — this bucket covered nothing');
    }
    if (r.runnerError) {
      console.log(`          runner error: ${r.runnerError}`);
    }
    for (const spec of r.specs) console.log(`          ${spec}`);
  }

  const failed = results.filter((r) => r.verdict === 'FAIL');
  const empty = results.filter((r) => r.verdict === 'EMPTY');
  if (failed.length > 0 || empty.length > 0) {
    const problems = [
      failed.length > 0 &&
        `${failed.length} failed (${failed.map((r) => r.name).join(', ')})`,
      empty.length > 0 &&
        `${empty.length} executed no tests (${empty.map((r) => r.name).join(', ')})`,
    ].filter(Boolean);
    console.error(
      `\nFAIL: of ${results.length} bucket(s), ${problems.join('; ')}.`,
    );
    process.exitCode = 1;
    return;
  }
  const total = results.reduce((n, r) => n + executedCount(r.counts), 0);
  console.log(
    `\nOK: all ${results.length} bucket(s) passed — ${total} test(s) executed.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}
