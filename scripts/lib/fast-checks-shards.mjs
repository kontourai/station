/**
 * The sharded `fast-checks` contract (#2709), dependency-free so the shard's
 * slice step and the aggregator run before (or without) `npm run
 * dependencies:ci`.
 *
 * One plan job computes the affected-test selection once and uploads it. Each
 * shard runs a deterministic slice of that plan and writes a receipt. The
 * required `fast-checks` job then passes only when every part job succeeded
 * AND the plan plus one receipt per shard prove the whole plan ran: each
 * receipt names exactly the slice this module derives for its shard, carries
 * the plan's digest, and reports a passing status.
 */
import { createHash } from 'node:crypto';

/**
 * Maximum adaptive shards; older candidates retain the four-way fallback.
 */
export const FAST_CHECKS_SHARD_COUNT = 4;
// #3101, 2026-10-01: sampled shards spent 1.4 min setting up for 0.2 min
// of tests (86% setup) in a 20-job pool. Without duration estimates, use
// 40 files per runner as an initial proxy; tune from hosted plan/run data.
const FAST_CHECKS_FILES_PER_SHARD = 40;
export function fastChecksShardCount(fileCount) {
  if (!Number.isInteger(fileCount) || fileCount < 0)
    throw new Error('fast-checks file count must be a non-negative integer');
  return Math.min(
    FAST_CHECKS_SHARD_COUNT,
    Math.max(1, Math.ceil(fileCount / FAST_CHECKS_FILES_PER_SHARD)),
  );
}
const FAST_CHECKS_MAX_SHARD_COUNT = 16;
export const FAST_CHECKS_PLAN_KIND = 'station-fast-checks-plan';
/**
 * #2855: the plan step's own fence in ci.yml ("Plan the affected-test
 * selection", timeout-minutes: 5). Related discovery derives its timeout
 * from what is left of it; ci-workflow-contract.test.ts pins the two equal.
 */
export const FAST_CHECKS_PLAN_BUDGET_MS = 5 * 60_000;
export const FAST_CHECKS_RECEIPT_KIND = 'station-fast-checks-shard-receipt';
export const FAST_CHECKS_PLAN_FILE = 'fast-checks-plan.json';
export const FAST_CHECKS_RECEIPT_FILE = 'fast-checks-shard-receipt.json';
/** The part jobs the aggregator requires, beside the skippable classifier. */
export const FAST_CHECKS_PART_JOBS = Object.freeze([
  'fast-checks-plan',
  'fast-checks-shard',
  'fast-checks-statics',
]);
/**
 * `provisional` is the selector's exit-3 deferral: the unsharded lane reports
 * it and carries on (run-ci-fast.mjs), so a shard does too. `empty` is a shard
 * whose slice of the plan holds no file; the aggregator accepts it only when
 * its own derivation of that slice is also empty.
 */
const FAST_CHECKS_PASSING_STATUSES = Object.freeze([
  'completed',
  'provisional',
  'empty',
]);
const FAST_CHECKS_STATUSES = Object.freeze([
  ...FAST_CHECKS_PASSING_STATUSES,
  'failed',
  'infrastructure_error',
  'parser_error',
]);

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

export function digestText(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** Parses `<k>/<n>` exactly: 1 <= k <= n <= FAST_CHECKS_MAX_SHARD_COUNT. */
export function parseFastChecksShard(value) {
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/.exec(String(value ?? ''));
  const index = match ? Number(match[1]) : Number.NaN;
  const count = match ? Number(match[2]) : Number.NaN;
  if (!match || count > FAST_CHECKS_MAX_SHARD_COUNT || index > count)
    throw new Error(
      `fast-checks shard must be <k>/<n> with 1 <= k <= n <= ${FAST_CHECKS_MAX_SHARD_COUNT}, not '${String(value).slice(0, 32)}'`,
    );
  return { index, count };
}

function isSafeTestPath(path) {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    !path.startsWith('/') &&
    !path.split(/[\\/]/).includes('..') &&
    !/[\r\n\0]/.test(path) &&
    TEST_FILE_PATTERN.test(path)
  );
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

/** Every structural rule a plan must satisfy before any shard trusts it. */
export function validateFastChecksPlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== 'object' || Array.isArray(plan))
    return ['plan must be a JSON object'];
  if (plan.schemaVersion !== 1) errors.push('plan schemaVersion must be 1');
  if (plan.kind !== FAST_CHECKS_PLAN_KIND)
    errors.push(`plan kind must be ${FAST_CHECKS_PLAN_KIND}`);
  if (!SHA_PATTERN.test(String(plan.headSha)))
    errors.push('plan headSha must be a full commit sha');
  if (typeof plan.base !== 'string' || plan.base.length === 0)
    errors.push('plan base must name the diff base');
  if (
    !Number.isInteger(plan.shardCount) ||
    plan.shardCount < 1 ||
    plan.shardCount > FAST_CHECKS_MAX_SHARD_COUNT
  )
    errors.push('plan shardCount must be a bounded positive integer');
  if (
    !Array.isArray(plan.deferredLanes) ||
    plan.deferredLanes.some(
      (lane) => typeof lane?.id !== 'string' || lane.id.length === 0,
    )
  )
    errors.push('plan deferredLanes must be a list of named lanes');
  if (!Array.isArray(plan.groups)) {
    errors.push('plan groups must be a list');
    return errors;
  }
  const names = new Set();
  const files = new Set();
  let total = 0;
  for (const group of plan.groups) {
    const name = group?.resourceGroup;
    if (typeof name !== 'string' || name.length === 0 || names.has(name))
      errors.push('plan resource groups must be named and unique');
    names.add(name);
    if (!Array.isArray(group?.files) || group.files.length === 0) {
      errors.push(`plan group ${String(name)} must list at least one file`);
      continue;
    }
    for (const file of group.files) {
      if (!isSafeTestPath(file))
        errors.push(`plan names an unsafe test path: ${String(file)}`);
      else if (files.has(file)) errors.push(`plan names a test twice: ${file}`);
      files.add(file);
      total += 1;
    }
  }
  if (plan.fileCount !== total)
    errors.push(`plan fileCount ${plan.fileCount} does not match ${total}`);
  // The unsharded lane escalates every empty selection to a named lane
  // (test-full), so an undeferred plan with nothing to run is inconsistent.
  if (
    Array.isArray(plan.deferredLanes) &&
    plan.deferredLanes.length === 0 &&
    total === 0
  )
    errors.push('an undeferred plan must select at least one test');
  return errors;
}

/**
 * Deterministic, disjoint, exhaustive: the plan's files are dealt round-robin
 * in plan order (resource groups in canonical order, files sorted within
 * each), continuing the rotation across group boundaries so a small serial
 * group does not always land on shard 1. Each shard's files are then
 * regrouped under their own resource group, so a shard runs every file with
 * the profile the unsharded lane would.
 */
export function sliceFastChecksPlan(plan, { index, count }) {
  if (!Number.isInteger(count) || count < 1)
    throw new Error('fast-checks slice needs a positive shard count');
  if (!Number.isInteger(index) || index < 1 || index > count)
    throw new Error('fast-checks slice index must be within 1..count');
  const groups = [];
  let position = 0;
  for (const group of plan.groups) {
    const files = [];
    for (const file of group.files) {
      if (position % count === index - 1) files.push(file);
      position += 1;
    }
    if (files.length)
      groups.push({ resourceGroup: group.resourceGroup, files });
  }
  return { groups, files: groups.flatMap((group) => group.files) };
}

export function isPassingFastChecksStatus(status) {
  return FAST_CHECKS_PASSING_STATUSES.includes(status);
}

export function validateFastChecksReceipt(receipt) {
  const errors = [];
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt))
    return ['receipt must be a JSON object'];
  if (receipt.schemaVersion !== 1)
    errors.push('receipt schemaVersion must be 1');
  if (receipt.kind !== FAST_CHECKS_RECEIPT_KIND)
    errors.push(`receipt kind must be ${FAST_CHECKS_RECEIPT_KIND}`);
  try {
    parseFastChecksShard(receipt.shard);
  } catch (error) {
    errors.push(error.message);
  }
  if (typeof receipt.runId !== 'string' || !/^[0-9]+$/.test(receipt.runId))
    errors.push('receipt runId must be a numeric string');
  if (!Number.isInteger(receipt.runAttempt) || receipt.runAttempt < 1)
    errors.push('receipt runAttempt must be a positive integer');
  if (!SHA_PATTERN.test(String(receipt.headSha)))
    errors.push('receipt headSha must be a full commit sha');
  if (!DIGEST_PATTERN.test(String(receipt.planSha256)))
    errors.push('receipt planSha256 must be a sha256 digest');
  if (!FAST_CHECKS_STATUSES.includes(receipt.status))
    errors.push(`receipt status ${String(receipt.status)} is unknown`);
  if (receipt.passed !== isPassingFastChecksStatus(receipt.status))
    errors.push('receipt passed must agree with its status');
  if (
    !Array.isArray(receipt.files) ||
    receipt.files.some((file) => !isSafeTestPath(file))
  )
    errors.push('receipt files must be a list of test paths');
  const counts = receipt.counts;
  if (
    !counts ||
    !['executed', 'passed', 'failed', 'infrastructureErrors'].every((key) =>
      isNonNegativeInteger(counts[key]),
    )
  )
    errors.push('receipt counts must be non-negative integers');
  return errors;
}

function sameList(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/**
 * The aggregator's whole verdict. `needs` is the workflow's `toJSON(needs)`;
 * `planText` the downloaded plan (undefined when absent); `receipts` every
 * downloaded receipt file as `{ path, text }`. Returns findings; empty means
 * the required check may pass.
 * @param {{
 *   needs?: Record<string, { result?: string }>;
 *   planText?: string;
 *   receipts: Array<{ path: string; text: string }>;
 *   shardCount?: number;
 *   runId?: string;
 *   headSha: string;
 * }} options
 */
export function verifyFastChecks({
  needs,
  planText,
  receipts,
  shardCount = undefined,
  runId,
  headSha,
}) {
  const findings = [];
  const notes = [];
  for (const job of FAST_CHECKS_PART_JOBS) {
    const result = needs?.[job]?.result;
    if (result !== 'success')
      findings.push(
        `${job} finished '${result ?? 'missing'}'; fast-checks requires success (a skipped or cancelled part is a failure)`,
      );
  }
  if (typeof planText !== 'string') {
    findings.push('the fast-checks plan artifact is missing');
    return { findings, notes };
  }
  let plan;
  try {
    plan = JSON.parse(planText);
  } catch {
    findings.push('the fast-checks plan is not valid JSON');
    return { findings, notes };
  }
  const planErrors = validateFastChecksPlan(plan);
  if (planErrors.length) {
    findings.push(...planErrors.map((error) => `invalid plan: ${error}`));
    return { findings, notes };
  }
  const planSha256 = digestText(planText);
  if (plan.headSha !== headSha)
    findings.push(
      `plan was computed for ${plan.headSha}, not the checked-out ${headSha}`,
    );
  shardCount ??= plan.shardCount;
  if (shardCount > FAST_CHECKS_SHARD_COUNT)
    findings.push(`plan exceeds the maximum ${FAST_CHECKS_SHARD_COUNT} shards`);
  if (plan.shardCount !== shardCount)
    findings.push(
      `plan is split ${plan.shardCount} ways, not the required ${shardCount}`,
    );

  const byShard = new Map();
  for (const { path, text } of receipts) {
    let receipt;
    try {
      receipt = JSON.parse(text);
    } catch {
      findings.push(`receipt ${path} is not valid JSON`);
      continue;
    }
    const errors = validateFastChecksReceipt(receipt);
    if (errors.length) {
      findings.push(`receipt ${path} is invalid: ${errors.join('; ')}`);
      continue;
    }
    if (receipt.runId !== runId) {
      findings.push(`receipt ${path} belongs to run ${receipt.runId}`);
      continue;
    }
    const { index, count } = parseFastChecksShard(receipt.shard);
    if (count !== shardCount) {
      findings.push(`receipt ${path} is for shard ${receipt.shard}`);
      continue;
    }
    const attempts = byShard.get(index) ?? new Map();
    if (attempts.has(receipt.runAttempt))
      findings.push(
        `shard ${receipt.shard} has two receipts for attempt ${receipt.runAttempt}`,
      );
    attempts.set(receipt.runAttempt, receipt);
    byShard.set(index, attempts);
  }

  const covered = [];
  for (let index = 1; index <= shardCount; index += 1) {
    const shard = `${index}/${shardCount}`;
    const attempts = byShard.get(index);
    if (!attempts) {
      findings.push(`shard ${shard} left no receipt`);
      continue;
    }
    // A re-run of failed jobs leaves the earlier attempt's receipt beside the
    // new one; the latest attempt is the shard's answer.
    const receipt = attempts.get(Math.max(...attempts.keys()));
    const expected = sliceFastChecksPlan(plan, { index, count: shardCount });
    if (receipt.planSha256 !== planSha256)
      findings.push(`shard ${shard} ran a different plan`);
    if (receipt.headSha !== plan.headSha)
      findings.push(`shard ${shard} ran ${receipt.headSha}`);
    if (!sameList(receipt.files, expected.files))
      findings.push(
        `shard ${shard} ran ${receipt.files.length} file(s), not its ${expected.files.length}-file slice of the plan`,
      );
    if ((receipt.status === 'empty') !== (expected.files.length === 0))
      findings.push(
        `shard ${shard} reported '${receipt.status}' for a ${expected.files.length}-file slice`,
      );
    if (!receipt.passed)
      findings.push(`shard ${shard} reported '${receipt.status}'`);
    covered.push(...receipt.files);
    notes.push(
      `shard ${shard}: ${receipt.status}, ${receipt.files.length} file(s), ${receipt.counts.executed} test(s) executed (attempt ${receipt.runAttempt})`,
    );
  }
  const planned = plan.groups.flatMap((group) => group.files);
  if (
    findings.length === 0 &&
    !sameList([...covered].sort(), [...planned].sort())
  )
    findings.push('the shards together did not run exactly the plan');
  if (plan.deferredLanes.length)
    notes.push(
      `selection deferred to ${plan.deferredLanes.map((lane) => lane.id).join(', ')}; full-regression remains the required completion gate`,
    );
  return { findings, notes };
}
