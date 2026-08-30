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

function diagnosticStdoutTail(result) {
  if (
    !['failed', 'infrastructure_error'].includes(
      result?.receipt?.terminal?.status,
    )
  )
    return undefined;
  const requestKey = result.receipt.request?.key;
  const artifact = result.receipt.artifacts?.find((entry) => {
    const match =
      /^\.kontourai\/verification-output\/([0-9a-f]{64})\/stdout-[0-9a-f]{64}\.txt$/.exec(
        entry?.path ?? '',
      );
    return match?.[1] === requestKey;
  });
  if (!artifact || typeof result.receipt.request?.worktree !== 'string')
    return undefined;
  try {
    // The artifact has already passed the redaction boundary at :281: raw
    // child output lives only in digest-addressed redacted artifacts, never
    // stdout. Reading this verified artifact is therefore safe to surface.
    return boundedTail(
      readVerifiedVerificationArtifact({
        root: result.receipt.request.worktree,
        artifact,
      }),
    );
  } catch {
    return undefined;
  }
}

function tailFallback(bounded, stdoutTail) {
  const envelope = (tail) => ({
    disposition: bounded.disposition,
    request: bounded.request,
    summary: {
      terminal: bounded.summary?.terminal,
      counts: bounded.summary?.counts,
      cleanup: bounded.summary?.cleanup,
      passed: bounded.summary?.passed,
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
