#!/usr/bin/env node
/**
 * The sharded `fast-checks` lane (#2709). ci.yml runs these subcommands:
 *
 *   plan       fast-checks-plan: select once, write the plan artifact
 *   slice      fast-checks-shard: report whether this shard's slice is empty
 *              (before dependencies are installed, so an empty shard is cheap)
 *   run        fast-checks-shard: run the slice, write this shard's receipt
 *   aggregate  fast-checks: verify part-job results, the plan and every receipt
 *
 * Only `plan` and a non-empty `run` load the selector and its dependencies;
 * `slice`, an empty `run`, and `aggregate` need Node alone. Exit 0 passes,
 * 1 is a verdict failure, 2 a usage or input fault.
 */
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  digestText,
  FAST_CHECKS_PLAN_BUDGET_MS,
  FAST_CHECKS_PLAN_FILE,
  FAST_CHECKS_RECEIPT_FILE,
  FAST_CHECKS_RECEIPT_KIND,
  FAST_CHECKS_SHARD_COUNT,
  fastChecksShardCount,
  isPassingFastChecksStatus,
  parseFastChecksShard,
  sliceFastChecksPlan,
  validateFastChecksPlan,
  validateFastChecksReceipt,
  verifyFastChecks,
} from './lib/fast-checks-shards.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const USAGE = `usage:
  npm run fast-checks:shard -- plan --out=<file>
  node scripts/fast-checks-shard.mjs slice --plan=<file> --shard=<k>/<n>
  npm run fast-checks:shard -- run --plan=<file> --shard=<k>/<n> --receipt=<file>
  node scripts/fast-checks-shard.mjs aggregate --plan-dir=<dir> --receipts-dir=<dir>`;

export class FastChecksUsageError extends Error {}

const OPTIONS = Object.freeze({
  plan: ['out'],
  slice: ['plan', 'shard'],
  run: ['plan', 'shard', 'receipt'],
  aggregate: ['plan-dir', 'receipts-dir'],
});

export function parseFastChecksArgs(args) {
  const [command, ...rest] = args;
  const names = OPTIONS[command];
  if (!names) throw new FastChecksUsageError(USAGE);
  const options = {};
  for (const argument of rest) {
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (!match || !names.includes(match[1]) || match[1] in options)
      throw new FastChecksUsageError(USAGE);
    options[match[1]] = match[2];
  }
  if (names.some((name) => !(name in options)))
    throw new FastChecksUsageError(USAGE);
  return { command, options };
}

/** Beside the receipt; ci.yml uploads it when a shard fails (#3101 C). */
const FAILED_REPORT_DIR = 'vitest-reports';
// GitHub keeps at most ten error annotations per step.
const ANNOTATION_LIMIT = 10;

function escapeCommandData(value) {
  return String(value)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}
function escapeCommandProperty(value) {
  return escapeCommandData(value).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

/**
 * One `::error` workflow command per failed test, so the check run's
 * annotations name the failing tests: the merge-queue dequeue report reads
 * them from the Checks API instead of parsing logs.
 */
function failedTestAnnotations(receipt) {
  const failed = (receipt.executions ?? []).flatMap(
    (execution) => execution.failedTests ?? [],
  );
  return failed.slice(0, ANNOTATION_LIMIT).map((test) => {
    const message = String(test.excerpt ?? '')
      .split('\n')
      .slice(0, 6)
      .join('\n');
    return `::error file=${escapeCommandProperty(test.file)},title=${escapeCommandProperty(test.name)}::${escapeCommandData(message)}`;
  });
}

function headSha(cwd) {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Reads and validates a plan; the digest is over the exact bytes read. */
function readPlan(path, shardValue) {
  let planText;
  try {
    planText = readFileSync(path, 'utf8');
  } catch {
    throw new FastChecksUsageError(`fast-checks plan is unreadable: ${path}`);
  }
  let plan;
  try {
    plan = JSON.parse(planText);
  } catch {
    throw new FastChecksUsageError('fast-checks plan is not valid JSON');
  }
  const errors = validateFastChecksPlan(plan);
  if (errors.length)
    throw new FastChecksUsageError(
      `fast-checks plan is invalid: ${errors.join('; ')}`,
    );
  const shard = parseFastChecksShard(shardValue);
  if (shard.count !== plan.shardCount)
    throw new FastChecksUsageError(
      `shard ${shardValue} does not match the plan's ${plan.shardCount}-way split`,
    );
  return { plan, planSha256: digestText(planText), shard };
}

function runIdentity(env) {
  const runId = env.GITHUB_RUN_ID;
  const runAttempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (!/^[0-9]+$/.test(String(runId)) || !Number.isInteger(runAttempt))
    throw new FastChecksUsageError(
      'a fast-checks shard receipt needs GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT',
    );
  return { runId, runAttempt };
}

async function planCommand({ out }, { cwd, env, report, planShards, now }) {
  // The plan step's fence starts before this process; the discovery reserve
  // (RELATED_DISCOVERY_RESERVE_MS) covers npm's start-up and the plan write.
  const discoveryDeadlineAt = now() + FAST_CHECKS_PLAN_BUDGET_MS;
  const { fastBase } = await import('./run-ci-fast.mjs');
  const selected = await (
    planShards ??
    (await import('./run-changed-verification.mjs'))
      .planChangedVerificationShards
  )(fastBase(env), {
    root: cwd,
    shardCount: FAST_CHECKS_SHARD_COUNT,
    discoveryDeadlineAt,
  });
  const plan = {
    ...selected,
    // pull_request_target executes the base workflow with the candidate CLI.
    // An old fixed matrix must still receive its four-way plan (#3101).
    shardCount:
      env.STATION_FAST_CHECKS_ADAPTIVE_SHARDS === 'true'
        ? fastChecksShardCount(selected.fileCount)
        : FAST_CHECKS_SHARD_COUNT,
  };
  const errors = validateFastChecksPlan(plan);
  if (errors.length)
    throw new Error(
      `computed fast-checks plan is invalid: ${errors.join('; ')}`,
    );
  writeJson(resolve(cwd, out), plan);
  if (env.GITHUB_OUTPUT)
    appendFileSync(
      env.GITHUB_OUTPUT,
      `shards=${JSON.stringify(Array.from({ length: plan.shardCount }, (_, index) => index + 1))}\nshard-count=${plan.shardCount}\n`,
    );
  report(
    `[fast-checks] plan: ${plan.fileCount} test file(s) over ${plan.groups.length} resource group(s), ${plan.shardCount} shard(s)` +
      (plan.deferredLanes.length
        ? `; deferred to ${plan.deferredLanes.map((lane) => lane.id).join(', ')}\n`
        : '\n'),
  );
  if (plan.relatedDiscovery)
    report(
      `[fast-checks] related discovery: ${(plan.relatedDiscovery.milliseconds / 1000).toFixed(1)}s` +
        (plan.relatedDiscovery.timeoutMilliseconds === undefined
          ? '\n'
          : ` of its ${(plan.relatedDiscovery.timeoutMilliseconds / 1000).toFixed(1)}s timeout\n`),
    );
  return 0;
}

function sliceCommand(
  { plan: planPath, shard: shardValue },
  { cwd, env, report },
) {
  const { plan, shard } = readPlan(resolve(cwd, planPath), shardValue);
  const slice = sliceFastChecksPlan(plan, shard);
  report(
    `[fast-checks] shard ${shardValue}: ${slice.files.length} of ${plan.fileCount} planned test file(s)\n`,
  );
  if (env.GITHUB_OUTPUT)
    appendFileSync(
      env.GITHUB_OUTPUT,
      `empty=${slice.files.length === 0 ? 'true' : 'false'}\n`,
    );
  return 0;
}

async function runCommand(
  { plan: planPath, shard: shardValue, receipt: receiptPath },
  { cwd, env, report, runShard, deadlineMs },
) {
  const { plan, planSha256, shard } = readPlan(
    resolve(cwd, planPath),
    shardValue,
  );
  const { runId, runAttempt } = runIdentity(env);
  const head = headSha(cwd);
  const slice = sliceFastChecksPlan(plan, shard);
  const base = {
    schemaVersion: 1,
    kind: FAST_CHECKS_RECEIPT_KIND,
    shard: shardValue,
    runId,
    runAttempt,
    headSha: head,
    planSha256,
    files: slice.files,
    deferredLanes: plan.deferredLanes.map((lane) => lane.id),
  };
  let outcome;
  if (head !== plan.headSha) {
    outcome = {
      status: 'infrastructure_error',
      counts: { executed: 0, passed: 0, failed: 0, infrastructureErrors: 1 },
      preparation: {
        phase: 'plan-identity',
        error: `plan was computed for ${plan.headSha}, this checkout is ${head}`,
      },
    };
  } else if (slice.files.length === 0) {
    // An empty slice is an explicit, receipted pass. The aggregator accepts
    // it only when its own derivation of this slice is also empty.
    outcome = {
      status: 'empty',
      counts: { executed: 0, passed: 0, failed: 0, infrastructureErrors: 0 },
    };
  } else if (!env.npm_execpath) {
    // Review F1: the lane's tests ran under `npm run ci:fast`, and some read
    // the npm environment (npm_execpath). A shard started any other way would
    // report failures the lane never had, so it refuses instead.
    throw new FastChecksUsageError(
      'a non-empty fast-checks shard must run through `npm run fast-checks:shard -- run ...`',
    );
  } else {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort('exceeded its fast-checks shard budget'),
      deadlineMs ??
        (await import('./verification-lanes.mjs')).CI_FAST_TIMEOUT_MS,
    );
    timer.unref?.();
    // A cancelled job signals the runner; abort so the owned Vitest trees are
    // torn down rather than orphaned. No receipt is needed then: the
    // aggregator fails on the cancelled job itself.
    const abort = (name) => controller.abort(name);
    const signals = ['SIGINT', 'SIGTERM'];
    for (const name of signals) process.on(name, abort);
    try {
      outcome = await (
        runShard ??
        (await import('./run-changed-verification.mjs'))
          .runChangedVerificationShard
      )(plan, slice, {
        root: cwd,
        signal: controller.signal,
        failedReportDir: resolve(cwd, dirname(receiptPath), FAILED_REPORT_DIR),
      });
    } catch (error) {
      outcome = {
        status: 'infrastructure_error',
        counts: { executed: 0, passed: 0, failed: 0, infrastructureErrors: 1 },
        preparation: {
          phase: 'shard-execution',
          error: error instanceof Error ? error.message : String(error),
        },
      };
    } finally {
      clearTimeout(timer);
      for (const name of signals) process.off(name, abort);
    }
    if (controller.signal.aborted && isPassingFastChecksStatus(outcome.status))
      outcome = { ...outcome, status: 'infrastructure_error' };
  }
  const receipt = {
    ...base,
    status: outcome.status,
    passed: isPassingFastChecksStatus(outcome.status),
    counts: {
      executed: outcome.counts.executed,
      passed: outcome.counts.passed,
      failed: outcome.counts.failed,
      infrastructureErrors: outcome.counts.infrastructureErrors,
    },
    ...(outcome.preparation ? { preparation: outcome.preparation } : {}),
    ...(outcome.executions ? { executions: outcome.executions } : {}),
  };
  const errors = validateFastChecksReceipt(receipt);
  if (errors.length)
    throw new Error(`fast-checks receipt is invalid: ${errors.join('; ')}`);
  writeJson(resolve(cwd, receiptPath), receipt);
  if (env.GITHUB_ACTIONS === 'true')
    for (const line of failedTestAnnotations(receipt)) report(`${line}\n`);
  report(
    `[fast-checks] shard ${shardValue}: ${receipt.status}; ${slice.files.length} file(s), ${receipt.counts.executed} test(s) executed, ${receipt.counts.failed} failed\n`,
  );
  if (receipt.status === 'provisional')
    report(
      `[fast-checks] selection deferred to ${base.deferredLanes.join(', ') || 'test-full'}; full-regression remains the required completion gate\n`,
    );
  return receipt.passed ? 0 : 1;
}

function receiptFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name === FAST_CHECKS_RECEIPT_FILE,
    )
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
    .sort();
}

function aggregateCommand(
  { 'plan-dir': planDir, 'receipts-dir': receiptsDir },
  { cwd, env, report, error },
) {
  let needs;
  try {
    needs = JSON.parse(env.NEEDS ?? '');
  } catch {
    needs = undefined;
  }
  const planPath = resolve(cwd, planDir, FAST_CHECKS_PLAN_FILE);
  const { findings, notes } = verifyFastChecks({
    needs,
    planText: existsSync(planPath) ? readFileSync(planPath, 'utf8') : undefined,
    receipts: receiptFiles(resolve(cwd, receiptsDir)).map((path) => ({
      path,
      text: readFileSync(path, 'utf8'),
    })),
    runId: env.GITHUB_RUN_ID,
    headSha: headSha(cwd),
  });
  for (const note of notes) report(`[fast-checks] ${note}\n`);
  if (findings.length) {
    for (const finding of findings) error(`[fast-checks] FAIL: ${finding}\n`);
    return 1;
  }
  report(
    '[fast-checks] PASS: every part job succeeded and every shard ran its slice of the plan\n',
  );
  return 0;
}

/**
 * @param {string[]} args
 * @param {{
 *   cwd?: string;
 *   env?: Record<string, string | undefined>;
 *   report?: (message: string) => unknown;
 *   error?: (message: string) => unknown;
 *   planShards?: (base: string, options: { root: string; shardCount: number; discoveryDeadlineAt: number }) => Promise<any>;
 *   runShard?: (plan: any, slice: any, options: { root: string; signal: AbortSignal }) => Promise<any>;
 *   deadlineMs?: number;
 *   now?: () => number;
 * }} [options]
 */
export async function runFastChecksShardCli(
  args,
  {
    cwd = process.cwd(),
    env = process.env,
    report = (message) => process.stdout.write(message),
    error = (message) => process.stderr.write(message),
    planShards,
    runShard,
    deadlineMs,
    now = Date.now,
  } = {},
) {
  try {
    const { command, options } = parseFastChecksArgs(args);
    const context = {
      cwd,
      env,
      report,
      error,
      planShards,
      runShard,
      deadlineMs,
      now,
    };
    if (command === 'plan') return await planCommand(options, context);
    if (command === 'slice') return sliceCommand(options, context);
    if (command === 'run') return await runCommand(options, context);
    return aggregateCommand(options, context);
  } catch (caught) {
    error(`${caught instanceof Error ? caught.message : String(caught)}\n`);
    return 2;
  }
}

if (invokedDirectly(import.meta.url))
  process.exitCode = await runFastChecksShardCli(process.argv.slice(2));
