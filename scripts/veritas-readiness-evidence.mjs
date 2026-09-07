/**
 * Preserve Veritas's three evidence outcomes at Station's CI boundary.
 *
 * The generic Veritas runner has a boolean evidence-check transport. Station
 * proof-family lanes additionally use exit 2 for NOT_VERIFIED, so this
 * boundary reads the structured engine result before selecting the CI exit.
 * Since Veritas 1.6.0 the engine only promotes a failing *required* check to
 * `evidenceCheckFailure`; an explicit `--evidence-check-command` that exits
 * nonzero is recorded in `evidenceCheckResults` as a warning and readiness
 * passes. Station's contract is that any nonzero nested command is a
 * readiness failure, so the failure is derived from the public per-check
 * results when the engine reports none. It uses the public Veritas engine
 * API; it does not reinterpret shell output or suppress a failed evidence
 * command.
 */

import { resolve } from 'node:path';
import {
  feedbackHasFailures,
  parseReadinessArgs,
  runMergeReadiness,
} from '@kontourai/veritas/engine';

export function classifyReadinessEvidence({ evidenceCheckFailure, record }) {
  // A required Veritas policy is a real readiness failure even when a nested
  // evidence command could not complete. Do not let the latter downgrade red
  // evidence into NOT_VERIFIED.
  if (feedbackHasFailures(record, null)) {
    return { status: 'FAIL', exitCode: 1, reason: 'readiness-failed' };
  }
  if (evidenceCheckFailure) {
    if (evidenceCheckFailure.exitCode === 2) {
      return {
        status: 'NOT_VERIFIED',
        exitCode: 2,
        reason: 'evidence-check-not-verified',
      };
    }
    return {
      status: 'FAIL',
      exitCode: 1,
      reason: 'evidence-check-failed',
    };
  }
  return { status: 'PASS', exitCode: 0, reason: 'readiness-passed' };
}

/**
 * The engine's own failure (a required check) wins. Otherwise the first
 * evidence check that did not pass — Veritas 1.6.0 runs required checks
 * first, so an explicit command's failure is what remains — becomes the
 * failure this boundary classifies.
 */
export function resolveEvidenceCheckFailure({
  evidenceCheckFailure,
  evidenceCheckResults,
}) {
  if (evidenceCheckFailure) return evidenceCheckFailure;
  const failed = (
    Array.isArray(evidenceCheckResults) ? evidenceCheckResults : []
  ).find((result) => result && result.passed !== true);
  if (!failed) return null;
  const status = Number.isInteger(failed.exitCode)
    ? failed.exitCode
    : (failed.signal ?? 'unknown status');
  return {
    phase: 'evidence-check',
    reason: 'failed',
    id: failed.id,
    runner: failed.runner,
    label: failed.label,
    message: `Evidence Check command exited with ${status}`,
    ...(Number.isInteger(failed.exitCode) ? { exitCode: failed.exitCode } : {}),
  };
}

function parseWrapperArgs(argv) {
  const veritasArgs = [];
  let evidenceCheckCommand;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--check') {
      if (argv[index + 1] !== 'evidence') {
        throw new Error(
          'Station readiness evidence requires --check evidence.',
        );
      }
      index += 1;
      continue;
    }
    if (token === '--evidence-check-command') {
      evidenceCheckCommand = argv[index + 1];
      if (!evidenceCheckCommand) {
        throw new Error('--evidence-check-command requires a command.');
      }
      index += 1;
      continue;
    }
    veritasArgs.push(token);
  }
  const options = parseReadinessArgs(veritasArgs);
  return { options, evidenceCheckCommand };
}

function evidenceCheckFailureSummary(failure) {
  if (!failure) return null;
  return {
    id: failure.id,
    runner: failure.runner,
    label: failure.label,
    message: failure.message,
    ...(Number.isInteger(failure.exitCode)
      ? { exitCode: failure.exitCode }
      : {}),
  };
}

export async function runStationReadinessEvidence(
  argv = process.argv.slice(2),
) {
  const { options, evidenceCheckCommand } = parseWrapperArgs(argv);
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const readinessRun = await runMergeReadiness(
    {
      ...options,
      rootDir,
      ...(evidenceCheckCommand ? { evidenceCheckCommand } : {}),
    },
    { rootDir },
  );
  const evidenceCheckFailure = resolveEvidenceCheckFailure({
    evidenceCheckFailure: readinessRun.evidenceCheckFailure,
    evidenceCheckResults: readinessRun.evidenceCheckResults,
  });
  const outcome = classifyReadinessEvidence({
    evidenceCheckFailure,
    record: readinessRun.reportResult.record,
  });
  return {
    schemaVersion: 1,
    status: outcome.status,
    exitCode: outcome.exitCode,
    reason: outcome.reason,
    evidenceCheckFailure: evidenceCheckFailureSummary(evidenceCheckFailure),
    reportArtifactPath: readinessRun.reportResult.artifactPath,
    reportRunId: readinessRun.reportResult.record.run_id,
  };
}

async function main() {
  try {
    const result = await runStationReadinessEvidence();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        status: 'FAIL',
        exitCode: 1,
        reason: 'readiness-invocation-failed',
        error: message,
      })}\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  await main();
}
