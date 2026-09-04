#!/usr/bin/env node

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  coordinateVerification,
  defaultCoordinatorRoot,
  explainVerification,
  verificationStatus,
} from './lib/verification-coordinator.mjs';
import { projectHostPressureForStatus } from './lib/verification-host-pressure.mjs';
import { redactVerificationOutput } from './lib/verification-redaction.mjs';
import {
  failedTestFilesFromCapture,
  readVerifiedVerificationArtifact,
  sweepVerificationArtifactOrphans,
  VERIFICATION_ARTIFACT_RETENTION_POLICY,
} from './lib/verification-reporter.mjs';
import {
  redactVerificationSubmissionError,
  submitVerification,
  sweepTerminalSubmissionHandoffs,
  verificationSubmissionStatus,
} from './lib/verification-submission.mjs';
import { assertSupportedNode } from './node-runtime-contract.mjs';
import { assertWorkspacePackageProvenance } from './workspace-dependency-provenance.mjs';

const CONTROL_OUTPUT_CAP = 8 * 1024;
const STATUS_VISIBLE_JOB_LIMIT = 12;
const FAILED_STDOUT_TAIL_LINE_CAP = 40;
const FAILED_STDOUT_TAIL_BYTE_CAP = 4 * 1024;

function statusPriority(job) {
  if (!job?.live) return 3;
  if (['admitted', 'output', 'running', 'canceling'].includes(job.state))
    return 0;
  if (job.state === 'queued') return 1;
  return 2;
}

function projectStatusJob(job) {
  return {
    key: redactVerificationOutput(String(job?.key ?? '')).slice(0, 128),
    state: redactVerificationOutput(String(job?.state ?? '')).slice(0, 64),
    live: job?.live === true,
    weight: job?.weight,
    ...(Number.isFinite(job?.elapsedMs) ? { elapsedMs: job.elapsedMs } : {}),
    ...(Number.isFinite(job?.deadlineAt) ? { deadlineAt: job.deadlineAt } : {}),
    ...(job?.phase
      ? {
          phase: {
            id: redactVerificationOutput(String(job.phase.id ?? '')).slice(
              0,
              64,
            ),
            index: job.phase.index,
            total: job.phase.total,
            ...(Number.isFinite(job.phase.queueElapsedMs)
              ? { queueElapsedMs: job.phase.queueElapsedMs }
              : {}),
            ...(Number.isFinite(job.phase.queueDeadlineAt)
              ? { queueDeadlineAt: job.phase.queueDeadlineAt }
              : {}),
            ...(Number.isFinite(job.phase.executionElapsedMs)
              ? { executionElapsedMs: job.phase.executionElapsedMs }
              : {}),
            ...(Number.isFinite(job.phase.executionDeadlineAt)
              ? { executionDeadlineAt: job.phase.executionDeadlineAt }
              : {}),
          },
        }
      : {}),
    ...(job?.queueReason
      ? {
          queueReason: redactVerificationOutput(String(job.queueReason)).slice(
            0,
            64,
          ),
        }
      : {}),
    ...(projectHostPressureForStatus(job?.hostPressure)
      ? { hostPressure: projectHostPressureForStatus(job?.hostPressure) }
      : {}),
  };
}

export function boundedControlResult(result) {
  if (result?.receipt)
    return {
      disposition: result.disposition,
      request: { key: result.request?.key, laneId: result.request?.laneId },
      summary: {
        ...(result.summary ?? {
          terminal: result.receipt.terminal,
          counts: result.receipt.counts,
          cleanup: result.receipt.cleanup,
          artifacts: result.receipt.artifacts?.slice(0, 64) ?? [],
        }),
        // station#3584 review item 1: summarizeVerificationOutput
        // (verification-reporter.mjs) never emits `passed` in any version,
        // so an executed-run summary showed only `terminal: "completed"`
        // next to a stamped `indeterminate: true` -- two fields that both
        // look non-negative, plus a non-zero exit code, with no rendered
        // field anywhere stating the verdict was false. Stamp the
        // authoritative boolean verdict here too, from the same receipt
        // `indeterminate` is stamped from, so every rendering states it
        // explicitly rather than requiring the reader to already know which
        // summary shape omits it.
        passed: result.receipt.terminal?.passed === true,
        // station#3584: an executed-run summary (`result.summary`, built by
        // reportExecution before classifyTerminal ever runs) carries only a
        // bare `terminal.status` string, with no way to know indeterminate
        // at that point in the pipeline. Stamp it here from the receipt --
        // the one place every disposition (executed/joined/reused) has
        // already computed the authoritative terminal -- so the flag is
        // never dropped just because a particular code path built its own
        // narrower summary.
        ...(result.receipt.terminal?.indeterminate === true
          ? { indeterminate: true }
          : {}),
      },
    };
  if (Array.isArray(result?.jobs)) {
    const live = result.jobs
      .filter((job) => job?.live === true)
      .sort((left, right) => statusPriority(left) - statusPriority(right));
    const staleCount = result.jobs.filter(
      (job) => job?.live !== true && job?.state !== 'finished',
    ).length;
    const finishedCount = result.jobs.length - live.length - staleCount;
    const omittedLiveCount = Math.max(
      0,
      live.length - STATUS_VISIBLE_JOB_LIMIT,
    );
    return {
      capacity: result.capacity,
      usedWeight: result.usedWeight,
      waiting: result.waiting,
      staleCount,
      ...(finishedCount > 0 ? { finishedCount } : {}),
      ...(omittedLiveCount > 0 ? { omittedLiveCount } : {}),
      jobs: live.slice(0, STATUS_VISIBLE_JOB_LIMIT).map(projectStatusJob),
      truncated: omittedLiveCount > 0,
      retention: result.retention,
    };
  }
  return result;
}

function boundedTail(value, maxBytes = FAILED_STDOUT_TAIL_BYTE_CAP) {
  const lines = String(value ?? '')
    .split(/\r?\n/)
    .slice(-FAILED_STDOUT_TAIL_LINE_CAP);
  let tail = '';
  for (const point of Array.from(lines.join('\n')).reverse()) {
    if (Buffer.byteLength(point + tail) > maxBytes) break;
    tail = point + tail;
  }
  return tail;
}

function isNonPassingResult(result) {
  return ['failed', 'infrastructure_error'].includes(
    result?.receipt?.terminal?.status,
  );
}

/**
 * Per-render memo for `capturedStream`. Reading a stream artifact opens it,
 * stats it twice and re-hashes up to 3 MiB to prove the digest; the tail and
 * the failing-file scan both want the same bytes, so without this a single
 * `renderBounded` paid that three times.
 */
const capturedStreams = new WeakMap();

/**
 * The verified, already-redacted capture of one of the run's own streams, or
 * undefined when the receipt does not carry it.
 */
function capturedStream(result, kind) {
  const memo = capturedStreams.get(result) ?? new Map();
  capturedStreams.set(result, memo);
  if (memo.has(kind)) return memo.get(kind);
  const value = readCapturedStream(result, kind);
  memo.set(kind, value);
  return value;
}

function readCapturedStream(result, kind) {
  const requestKey = result?.receipt?.request?.key;
  const reference = new RegExp(
    `^\\.kontourai/verification-output/([0-9a-f]{64})/${kind}-[0-9a-f]{64}\\.txt$`,
  );
  const artifact = result?.receipt?.artifacts?.find((entry) => {
    const match = reference.exec(entry?.path ?? '');
    return match?.[1] === requestKey;
  });
  if (!artifact || typeof result.receipt.request?.worktree !== 'string')
    return undefined;
  try {
    // The artifact has already passed the redaction boundary:
    // `persistVerificationOutput` (verification-reporter.mjs) redacts the
    // complete bounded source before choosing the persisted prefix, so raw
    // child output lives only in digest-addressed redacted artifacts, never
    // here. Reading this verified artifact is therefore safe to surface.
    return String(
      readVerifiedVerificationArtifact({
        root: result.receipt.request.worktree,
        artifact,
      }),
    );
  } catch {
    return undefined;
  }
}

function diagnosticStdoutTail(result) {
  if (!isNonPassingResult(result)) return undefined;
  const captured = capturedStream(result, 'stdout');
  return captured === undefined ? undefined : boundedTail(captured);
}

/** Enough to identify the failing surface; not a substitute for the artifact. */
const FAILED_TEST_FILE_CAP = 8;

/**
 * The test FILES a failed run actually failed in (#1139).
 *
 * The redacted stdout tail carries `[test:changed] focused: …`, which reads as
 * an account of what ran — and can omit the very file every failure is in,
 * because a file is reached through another's import graph. `gh run view
 * --log-failed` shows only that tail, so the first thing a reader learns about
 * their red PR points at innocent files. The failure locations already exist,
 * in the digest-addressed diagnostics attachment, but only if you know to
 * download the run's artifacts and which one to open.
 *
 * `file` is repo-relative and already past the redaction boundary, the same as
 * the stdout artifact this sits beside. Names are not surfaced: the file plus a
 * count is what ends the investigation, and it stays small enough to survive
 * the output cap.
 */
function attachmentFailedTestFiles(result) {
  const requestKey = result.receipt.request?.key;
  const artifact = result.receipt.artifacts?.find((entry) => {
    const match =
      /^\.kontourai\/verification-output\/([0-9a-f]{64})\/attachment-[0-9a-f]{64}\.txt$/.exec(
        entry?.path ?? '',
      );
    return match?.[1] === requestKey;
  });
  if (!artifact || typeof result.receipt.request?.worktree !== 'string')
    return undefined;
  let diagnostic;
  try {
    diagnostic = JSON.parse(
      readVerifiedVerificationArtifact({
        root: result.receipt.request.worktree,
        artifact,
      }),
    );
  } catch {
    return undefined;
  }
  const counts = new Map();
  for (const execution of Array.isArray(diagnostic?.executions)
    ? diagnostic.executions
    : [])
    for (const failure of Array.isArray(execution?.failedTests)
      ? execution.failedTests
      : []) {
      // A malformed entry must not invent a location.
      if (typeof failure?.file !== 'string' || failure.file.length === 0)
        continue;
      counts.set(failure.file, (counts.get(failure.file) ?? 0) + 1);
    }
  if (counts.size === 0) return undefined;
  const ordered = [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
  const listed = ordered
    .slice(0, FAILED_TEST_FILE_CAP)
    .map(([file, count]) => `${file} (${count})`);
  const omitted = ordered.length - listed.length;
  // The omission is stated rather than left to be inferred from a short list.
  return omitted > 0
    ? [...listed, `… ${omitted} more file(s) in the diagnostics attachment`]
    : listed;
}

/**
 * The same question answered from the run's OWN captured streams, for the runs
 * that have no per-execution diagnostics attachment at all (station#1471).
 *
 * A completion-phase parent — the hosted full-regression gate — attaches phase
 * receipts, not the `executions[].failedTests` document `#1139` reads, so on
 * the one run shape that most needs a location the field was simply absent.
 * The `FAIL <file> > <test>` lines the runner itself printed are already in the
 * folded capture; vitest writes that banner to STDERR, which is why stdout
 * alone was never enough.
 *
 * No `(count)` suffix here, unlike the attachment path: a persisted stream is a
 * bounded prefix and the failing shard's block reaches the parent as a tail, so
 * a count derived from it would be a number nothing guarantees.
 */
function capturedFailedTestFiles(result) {
  const files = [
    ...new Set([
      ...failedTestFilesFromCapture(capturedStream(result, 'stdout') ?? ''),
      ...failedTestFilesFromCapture(capturedStream(result, 'stderr') ?? ''),
    ]),
  ];
  if (files.length === 0) return undefined;
  const listed = files.slice(0, FAILED_TEST_FILE_CAP);
  const omitted = files.length - listed.length;
  return omitted > 0
    ? [...listed, `… ${omitted} more file(s) in the redacted capture`]
    : listed;
}

/**
 * The failing test files, from the diagnostics attachment when the run has one
 * and from its own capture when it does not. A passing run names none.
 */
function diagnosticFailedTestFiles(result) {
  if (!isNonPassingResult(result)) return undefined;
  return attachmentFailedTestFiles(result) ?? capturedFailedTestFiles(result);
}

function tailFallback(bounded, stdoutTail) {
  const buildEnvelope = (tail, { withExcerpt }) => ({
    disposition: bounded.disposition,
    request: bounded.request,
    summary: {
      terminal: bounded.summary?.terminal,
      counts: bounded.summary?.counts,
      cleanup: bounded.summary?.cleanup,
      passed: bounded.summary?.passed,
      // Carried through truncation for the same reason as the file list below
      // it, and ahead of it: this is the sentence that says WHAT broke, and
      // dropping it is what made a red hosted nightly annotate itself "no
      // causal excerpt; read the artifact" while the FAIL line sat in its own
      // capture (station#1471). It is a single bounded line — the summary's
      // own byte budget already capped it — so it costs the tail very little.
      ...(withExcerpt && typeof bounded.summary?.firstCausalExcerpt === 'string'
        ? {
            firstCausalExcerpt: bounded.summary.firstCausalExcerpt,
            // The caveat travels with the excerpt or not at all: carrying the
            // excerpt while dropping the note that says it was picked off an
            // unattributed stream would state a stronger claim than the run
            // supports, exactly the trade the reporter refuses at its own cap.
            ...(bounded.summary?.causeStream
              ? { causeStream: bounded.summary.causeStream }
              : {}),
          }
        : {}),
      // Carried through truncation: a capped list of file names is small, and
      // it is the field that says where to look. Dropping it here would
      // reproduce #1139 for exactly the largest, least readable failures.
      ...(bounded.summary?.failedCheckTestFiles
        ? { failedCheckTestFiles: bounded.summary.failedCheckTestFiles }
        : {}),
      ...(bounded.summary?.productLawObservationTimeoutMs !== undefined
        ? {
            productLawObservationTimeoutMs:
              bounded.summary.productLawObservationTimeoutMs,
          }
        : {}),
      failedCheckRedactedStdoutTail: tail,
    },
    truncated: true,
  });
  // The excerpt is only carried while the envelope can still hold the
  // mandatory fields with an empty tail. A cap too small for both keeps the
  // measured terminal truth rather than the prose about it.
  const withExcerpt =
    Buffer.byteLength(
      JSON.stringify(buildEnvelope('', { withExcerpt: true }), null, 2),
    ) <= CONTROL_OUTPUT_CAP;
  const envelope = (tail) => buildEnvelope(tail, { withExcerpt });
  const tail = stdoutTail;
  let rendered = JSON.stringify(envelope(tail), null, 2);
  if (Buffer.byteLength(rendered) <= CONTROL_OUTPUT_CAP) return rendered;
  const points = Array.from(tail);
  let lower = 0;
  let upper = points.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = points.slice(middle).join('');
    if (
      Buffer.byteLength(JSON.stringify(envelope(candidate), null, 2)) <=
      CONTROL_OUTPUT_CAP
    )
      upper = middle;
    else lower = middle + 1;
  }
  rendered = JSON.stringify(envelope(points.slice(lower).join('')), null, 2);
  return rendered;
}

export function renderBounded(result) {
  const bounded = boundedControlResult(result);
  const stdoutTail = diagnosticStdoutTail(result);
  const productLawObservationTimeoutMs =
    result?.receipt?.provenance?.before?.productLawObservationTimeoutMs;
  if (Number.isFinite(productLawObservationTimeoutMs))
    bounded.summary = {
      ...bounded.summary,
      productLawObservationTimeoutMs,
    };
  // Before the tail, and separately from it: the tail is what gets trimmed
  // when the envelope is over cap, and this is the part a reader needs first.
  const failedTestFiles = diagnosticFailedTestFiles(result);
  if (failedTestFiles)
    bounded.summary = {
      ...bounded.summary,
      failedCheckTestFiles: failedTestFiles,
    };
  if (stdoutTail)
    bounded.summary = {
      ...bounded.summary,
      failedCheckRedactedStdoutTail: stdoutTail,
    };
  const rendered = JSON.stringify(bounded, null, 2);
  if (Buffer.byteLength(rendered) <= CONTROL_OUTPUT_CAP) return rendered;
  if (stdoutTail) return tailFallback(bounded, stdoutTail);
  if (Array.isArray(bounded?.jobs))
    return JSON.stringify(
      {
        ...bounded,
        jobs: bounded.jobs.slice(0, 4),
        omittedLiveCount:
          (bounded.omittedLiveCount ?? 0) +
          Math.max(0, bounded.jobs.length - 4),
        truncated: true,
      },
      null,
      2,
    );
  return JSON.stringify({ truncated: true }, null, 2);
}

function usage() {
  return 'usage: node scripts/run-verification.mjs <request|submit|status|submit-status|handoff-gc|artifact-gc|explain> [lane-id] [--force|--dry-run|--explain]';
}

export function parseVerificationCommand(args) {
  const [command, laneId, ...rest] = args;
  if (
    ![
      'request',
      'submit',
      'status',
      'submit-status',
      'handoff-gc',
      'artifact-gc',
      'explain',
    ].includes(command)
  )
    throw new Error(usage());
  const force = rest.includes('--force');
  const artifactGcExplain = laneId === '--explain';
  const artifactGcDryRun = laneId === '--dry-run' || artifactGcExplain;
  if (
    rest.some((argument) => argument !== '--force') ||
    (command !== 'artifact-gc' && (artifactGcDryRun || artifactGcExplain))
  )
    throw new Error(usage());
  if (
    !['status', 'submit-status', 'handoff-gc', 'artifact-gc'].includes(
      command,
    ) &&
    !laneId
  )
    throw new Error(`${command} requires a lane id\n${usage()}`);
  if (command === 'status' && (laneId || force))
    throw new Error(`status accepts no lane or force flag\n${usage()}`);
  if (command === 'submit-status' && force)
    throw new Error(`submit-status accepts no force flag\n${usage()}`);
  if (command === 'handoff-gc' && (laneId || force))
    throw new Error(`handoff-gc accepts no lane or force flag\n${usage()}`);
  if (
    command === 'artifact-gc' &&
    ((laneId && !artifactGcDryRun) || force || rest.length > 0)
  )
    throw new Error(
      `artifact-gc accepts only --dry-run or --explain\n${usage()}`,
    );
  if (command === 'submit' && (laneId !== 'full-regression' || force))
    throw new Error(
      `submit accepts only full-regression and no force flag\n${usage()}`,
    );
  return {
    command,
    laneId: artifactGcDryRun ? undefined : laneId,
    force,
    ...(command === 'artifact-gc'
      ? {
          artifactGcMode: artifactGcExplain
            ? 'explain'
            : artifactGcDryRun
              ? 'dry-run'
              : 'delete',
        }
      : {}),
  };
}

export async function runVerificationCli(
  args,
  { output = console.log, error = console.error } = {},
) {
  try {
    const parsed = parseVerificationCommand(args);
    let result;
    if (parsed.command === 'status') result = verificationStatus();
    else if (parsed.command === 'submit-status')
      result = verificationSubmissionStatus({ requestKey: parsed.laneId });
    else if (parsed.command === 'handoff-gc')
      result = sweepTerminalSubmissionHandoffs();
    else if (parsed.command === 'artifact-gc') {
      result = sweepVerificationArtifactOrphans({
        root: process.cwd(),
        coordinatorRoot: defaultCoordinatorRoot(),
        dryRun: parsed.artifactGcMode !== 'delete',
      });
      if (parsed.artifactGcMode === 'explain')
        result = {
          ...result,
          mode: 'explain',
          policy: VERIFICATION_ARTIFACT_RETENTION_POLICY,
        };
    } else if (parsed.command === 'explain')
      result = explainVerification({ laneId: parsed.laneId });
    else {
      // Public verification commands must fail before running a corpus under
      // a runtime that can change product behavior and create false failures.
      assertSupportedNode();
      assertWorkspacePackageProvenance();
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once('SIGINT', cancel);
      process.once('SIGTERM', cancel);
      try {
        result =
          parsed.command === 'submit'
            ? await submitVerification({ laneId: parsed.laneId })
            : await coordinateVerification({
                laneId: parsed.laneId,
                force: parsed.force,
                signal: controller.signal,
              });
      } finally {
        process.off('SIGINT', cancel);
        process.off('SIGTERM', cancel);
      }
    }
    // The CLI is intentionally a bounded handoff surface: raw child output
    // lives only in digest-addressed redacted artifacts, never stdout.
    output(renderBounded(result));
    if (parsed.command === 'submit' && result?.status !== 'accepted') return 2;
    return result?.receipt?.terminal?.passed === false ? 1 : 0;
  } catch (caught) {
    error(redactVerificationSubmissionError(caught));
    // `errorText` scrubs every absolute path to `[PATH]`, which is right for
    // handoff records but destroys the only actionable content this particular
    // failure carries: the tree to repair. Print it back for this disposition
    // rather than loosening a scrub that also guards persisted records.
    //
    // On THIS CLI the root is always the caller's own git toplevel — there is
    // no `--cwd`, and both coordinator and submission derive it from
    // `process.cwd()`. The value here is narrower than un-scrubbing a foreign
    // path: it says WHICH of several open `../station-worktrees/<lane>` trees
    // the check read, which is not otherwise recoverable from a scrubbed line.
    // The genuinely foreign root — the prepared transfer baseline — is
    // reported by `orchestration-transfer-gate.mjs`, which prints
    // `error.message` raw through its own handler and never reaches this catch.
    if (caught?.disposition === 'environment-stale' && caught.repositoryRoot)
      error(
        `environment-stale root: ${caught.repositoryRoot} -- run \`npm run dependencies:ci\` there`,
      );
    return 2;
  }
}

async function main() {
  process.exitCode = await runVerificationCli(process.argv.slice(2));
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  void main();
