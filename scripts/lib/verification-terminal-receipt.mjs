import { randomUUID } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { createVerificationReceipt } from './verification-receipt.mjs';
import { redactVerificationOutput } from './verification-redaction.mjs';
import {
  persistPlaywrightAttachments,
  persistVerificationOutput,
  summarizeVerificationOutput,
} from './verification-reporter.mjs';

// A changed-verification diagnostic retains at most twenty named failures.
// Keep their short heads in the terminal handoff alongside the causal note.
const SUMMARY_ENVELOPE_CAP = 24 * 1024;

function boundedText(value, maxBytes = 256) {
  const redacted = redactVerificationOutput(String(value ?? ''));
  let result = '';
  for (const point of Array.from(redacted)) {
    if (Buffer.byteLength(result + point) > maxBytes) break;
    result += point;
  }
  return result;
}

function boundedSummaryEnvelope(summary) {
  const envelope = {
    terminal: summary?.terminal ?? 'infrastructure_error',
    counts: summary?.counts ?? null,
    cleanup: summary?.cleanup ?? null,
    ...(summary?.failingStep
      ? { failingStep: boundedText(summary.failingStep, 128) }
      : {}),
    ...(summary?.firstCausalExcerpt
      ? { firstCausalExcerpt: boundedText(summary.firstCausalExcerpt, 512) }
      : {}),
    // station#4249 review: present ONLY when reportExecution's own reporting
    // pipeline failed (the reconcile-note catch branches below) -- this is
    // the field a reader checks to tell that case apart from an ordinary
    // observed failure, since both cases can otherwise share the same
    // `terminal` status. Bounded and only-when-present like every other
    // diagnostic field here.
    ...(summary?.reconcileNote
      ? { reconcileNote: boundedText(summary.reconcileNote, 1024) }
      : {}),
    // station#4249: mirrors firstCausalExcerpt's own only-when-present,
    // bounded-per-item treatment. Capped at 32 entries (matching
    // recoveredFailures below) so a run with an unusually large number of
    // distinct failing checks cannot blow the envelope's own byte cap.
    ...(Array.isArray(summary?.causalExcerpts) && summary.causalExcerpts.length
      ? {
          causalExcerpts: summary.causalExcerpts
            .slice(0, 32)
            .map((excerpt) => boundedText(excerpt, 512)),
        }
      : {}),
    ...(summary?.finalTally
      ? { finalTally: boundedText(summary.finalTally, 512) }
      : {}),
    ...(summary?.slowItems
      ? {
          slowItems: summary.slowItems
            .slice(0, 8)
            .map((item) => boundedText(item, 256)),
        }
      : {}),
    ...(Array.isArray(summary?.failedTests)
      ? {
          failedTests: summary.failedTests.slice(0, 64).map((failure) => ({
            file: boundedText(failure?.file, 256),
            name: boundedText(failure?.name, 256),
            excerpt: boundedText(failure?.excerpt, 512),
          })),
        }
      : {}),
    truncated: summary?.truncated === true,
    artifacts: Array.isArray(summary?.artifacts)
      ? summary.artifacts.slice(0, 64)
      : [],
    attachmentOmissions: Array.isArray(summary?.attachmentOmissions)
      ? summary.attachmentOmissions.slice(0, 64).map((entry) => ({
          name: boundedText(entry?.name, 128),
          reason: boundedText(entry?.reason, 128),
        }))
      : [],
  };
  return Buffer.byteLength(JSON.stringify(envelope)) > SUMMARY_ENVELOPE_CAP
    ? {
        terminal: envelope.terminal,
        counts: envelope.counts,
        cleanup: envelope.cleanup,
        truncated: true,
        artifacts: [],
        attachmentOmissions: [],
      }
    : envelope;
}

function primaryInterruptedCause(raw, result) {
  if (result?.status === 'timed_out')
    return 'verification execution timed out before terminal reporting';
  if (result?.status === 'canceled')
    return 'verification execution was canceled before terminal reporting';
  if (result?.status !== 'infrastructure_error') return null;
  const classified = raw?.infrastructureCause;
  if (typeof classified === 'string' && classified.length > 0)
    return `verification execution infrastructure error: ${boundedText(classified, 512)}`;
  const message = raw?.error?.message;
  return typeof message === 'string' && message.length > 0
    ? `verification execution infrastructure error: ${boundedText(message, 512)}`
    : 'verification execution ended with an infrastructure error before terminal reporting';
}

function preservesPrimaryTerminal(result) {
  return (
    (result?.status === 'failed' &&
      Number.isInteger(result?.exitCode) &&
      result.exitCode !== 0) ||
    ['timed_out', 'canceled', 'infrastructure_error'].includes(result?.status)
  );
}

/** Persists bounded command output and approved attachments into receipt artifacts. */
export function reportExecution({ raw, result, cleanup, worktree, request }) {
  let artifacts = [];
  let outputTruncated = raw?.output?.truncated === true;
  const attachmentOmissions = [];
  try {
    if (raw?.output?.invalidUtf8)
      throw new Error('verification output was not valid UTF-8');
    // A required attachment the lane could not bind still fails closed, but it
    // names which one and why rather than being smuggled in as an unreadable
    // path whose rejection reason describes the wrong problem.
    const unavailable = Array.isArray(raw?.unavailableAttachments)
      ? raw.unavailableAttachments
      : [];
    if (unavailable.length)
      throw new Error(
        `required attachment unavailable: ${unavailable
          .map(
            (entry) =>
              `${boundedText(entry?.name, 128)} (${boundedText(entry?.reason, 256)})`,
          )
          .join('; ')}`,
      );
    const persisted = persistVerificationOutput({
      root: worktree,
      requestKey: request.key,
      stdout: raw?.output?.stdout?.text ?? '',
      stderr: raw?.output?.stderr?.text ?? '',
    });
    artifacts = persisted.artifacts;
    outputTruncated ||= persisted.truncated;
    const reportedResult = outputTruncated
      ? {
          status: 'infrastructure_error',
          exitCode: null,
          counts: {
            executed: 1,
            passed: 0,
            failed: 0,
            infrastructureErrors: 1,
          },
        }
      : result;
    if (raw?.attachmentRoot && Array.isArray(raw.attachments)) {
      if (raw.attachments.length > 64)
        throw new Error('attachment metadata exceeds count bound');
      const approved = [];
      let metadataBytes = 0;
      for (const attachment of raw.attachments) {
        const name = boundedText(attachment?.name ?? 'attachment', 128);
        metadataBytes += Buffer.byteLength(name);
        if (metadataBytes > 4 * 1024)
          throw new Error('attachment metadata exceeds byte bound');
        if (
          typeof attachment?.path !== 'string' ||
          !/^(?:text\/|application\/(?:json|xml))/i.test(
            attachment.contentType ?? '',
          )
        ) {
          attachmentOmissions.push({
            name,
            reason: 'binary_or_unapproved_attachment',
          });
          continue;
        }
        approved.push({ path: attachment.path });
      }
      if (approved.length)
        artifacts.push(
          ...persistPlaywrightAttachments({
            root: worktree,
            requestKey: request.key,
            attachmentRoot: raw.attachmentRoot,
            attachments: approved,
          }),
        );
    }
    return {
      result: reportedResult,
      artifacts,
      outputTruncated,
      attachmentOmissions,
      summary: summarizeVerificationOutput({
        stdout: raw?.output?.stdout?.text ?? '',
        stderr: raw?.output?.stderr?.text ?? '',
        // exitCode and truncated are what let the reporter tell a real
        // non-pass from a `completed` status, and a prefix-capture from a
        // real exit (review of station#1871). Dropping them here is what
        // made the predicate on the other side unfixable.
        terminal: {
          status: reportedResult.status,
          exitCode: reportedResult.exitCode ?? null,
          truncated: outputTruncated,
        },
        counts: reportedResult.counts,
        cleanup,
      }),
    };
  } catch (error) {
    const recoverableFailures = Array.isArray(raw?.recoverableFailures)
      ? raw.recoverableFailures.filter(
          (failure) =>
            typeof failure?.file === 'string' &&
            typeof failure?.name === 'string' &&
            typeof failure?.excerpt === 'string',
        )
      : [];
    const reconcileNote = boundedText(
      `verification reporting failed: ${error?.message ?? String(error)}`,
      1_024,
    );
    // station#4173: a GENUINELY FAILED check must stay failed through a
    // reporting problem. Failure is fail-closed evidence in itself — erasing
    // failed:1 into a synthesized infrastructure count is the false-green
    // inversion the infrastructure classification exists to prevent (a later
    // reader sees 'infrastructure, rerun it' where a real red happened).
    // Only a result that CLAIMED success (or could not be classified) loses
    // its standing when its required evidence cannot be reported. The
    // reporting problem itself stays visible via reconcileNote below.
    if (preservesPrimaryTerminal(result)) {
      const primaryCause = primaryInterruptedCause(raw, result);
      const preserved = {
        ...result,
        reconcileNote,
        ...(recoverableFailures.length
          ? {
              recoveredFailures: recoverableFailures
                .slice(0, 32)
                .map(({ file, name }) => ({ file, name })),
            }
          : {}),
      };
      // Truncation divergence, deliberate: the try-path converts a
      // truncated capture to infrastructure_error even on a failed exit
      // (station#1871 — parsed output can't be trusted), but HERE the
      // verdict was synthesized from the exit code alone, so truncation
      // cannot have corrupted it; red stays red.
      return {
        result: preserved,
        // `artifacts` holds whatever persistVerificationOutput completed
        // BEFORE the throw (digest-bound stdout/stderr when the failure was
        // post-persist; empty when the throw preceded persistence) — already
        // the honest value, never fabricated.
        artifacts,
        outputTruncated,
        attachmentOmissions,
        summary: {
          terminal: preserved.status,
          counts: preserved.counts,
          cleanup,
          // The execution terminal is primary: a missing post-run attachment
          // is secondary evidence loss, not a replacement for a timeout,
          // cancellation, or spawn/infrastructure cause that already occurred.
          firstCausalExcerpt: primaryCause ?? reconcileNote,
          causalExcerpts: primaryCause
            ? [primaryCause, reconcileNote]
            : [reconcileNote],
          // station#4249 review: the disambiguator readers use to tell this
          // synthesized-diagnostic case apart from an ordinary observed
          // failure in the summary itself, not only in the persisted receipt.
          reconcileNote,
          ...(recoverableFailures.length
            ? { failedTests: recoverableFailures }
            : {}),
        },
      };
    }
    const failed = recoverableFailures.length
      ? {
          status: 'failed',
          exitCode:
            Number.isInteger(result?.exitCode) && result.exitCode !== 0
              ? result.exitCode
              : 1,
          // Persisted receipt evidence (sol review of #2654, finding 1):
          // the canonical receipt must carry WHAT failed and WHY the
          // ordinary reporting path broke, not just synthesized counts.
          recoveredFailures: recoverableFailures
            .slice(0, 32)
            .map(({ file, name }) => ({ file, name })),
          reconcileNote,
          counts: {
            executed: Math.max(result?.counts?.executed ?? 0, 1),
            passed: result?.counts?.passed ?? 0,
            failed: Math.max(
              result?.counts?.failed ?? 0,
              recoverableFailures.length,
            ),
            infrastructureErrors: Math.max(
              result?.counts?.infrastructureErrors ?? 0,
              1,
            ),
          },
        }
      : {
          status: 'infrastructure_error',
          exitCode: null,
          counts: {
            executed: 1,
            passed: 0,
            failed: 0,
            infrastructureErrors: 1,
          },
        };
    return {
      result: failed,
      artifacts: [],
      outputTruncated,
      attachmentOmissions,
      summary: {
        terminal: failed.status,
        counts: failed.counts,
        cleanup,
        firstCausalExcerpt: reconcileNote,
        // station#4249 review: parity with the sibling catch branch above --
        // this reporting-path failure also has exactly one known cause, so
        // causalExcerpts must never disagree with firstCausalExcerpt about
        // the same run.
        causalExcerpts: [reconcileNote],
        reconcileNote,
        ...(recoverableFailures.length
          ? { failedTests: recoverableFailures }
          : {}),
      },
    };
  }
}

function quarantineReplaceableCanonical({
  path,
  requestKey,
  worktree,
  terminalHooks,
  receiptCommitPath,
  readReceipt,
  completedReceipt,
}) {
  if (!existsSync(path)) return true;
  const commitPath = receiptCommitPath(path);
  const receipt = readReceipt(path);
  if (
    receipt?.request?.key !== requestKey ||
    completedReceipt(path, requestKey, worktree)?.terminal?.passed === true
  )
    return false;
  try {
    terminalHooks?.beforeReceiptQuarantine?.({ path });
    if (existsSync(commitPath))
      renameSync(commitPath, `${commitPath}.uncommitted-${randomUUID()}`);
    renameSync(path, `${path}.uncommitted-${randomUUID()}`);
    return true;
  } catch {
    return false;
  }
}

/** Publishes a receipt through the request/output lease transaction supplied by the coordinator. */
export function publishTerminalReceipt(options, operations) {
  const {
    request,
    force,
    result,
    artifacts,
    cleanup,
    before,
    after,
    directory,
    outputLock,
    owner,
    lease,
    root,
    staleMs,
    now,
    summary,
    outputTruncated,
    attachmentOmissions,
    reusableOutputs,
    onOwnershipLost,
    terminalHooks,
  } = options;
  const receipt = createVerificationReceipt({
    request,
    disposition: force ? 'forced' : 'executed',
    ...result,
    artifacts,
    cleanup,
    before,
    after,
    reusableOutputs,
  });
  const destination = operations.receiptPath(
    before.worktree,
    request.key,
    force,
  );
  const contents = operations.receiptContents(receipt);
  const pending = operations.pendingReceiptPath(
    before.worktree,
    request.key,
    owner,
    lease.generation,
  );
  let publicationFailure = null;
  const published = operations.withOwnedLeaseMutation({
    directory,
    outputLock,
    owner,
    mutate: ({ outputLease }) => {
      try {
        const publishingAt = now();
        const requestPublishing = {
          ...lease,
          state: 'publishing',
          heartbeatAt: publishingAt,
          receiptPath: destination,
        };
        const outputPublishing = {
          ...outputLease,
          state: 'publishing',
          heartbeatAt: publishingAt,
          receiptPath: destination,
        };
        operations.writeTransactionLease({
          directory,
          lease: requestPublishing,
          phase: 'publish-request',
          terminalHooks,
        });
        operations.writeTransactionLease({
          directory: outputLock,
          lease: outputPublishing,
          phase: 'publish-output',
          terminalHooks,
        });
        if (
          !operations.assertLeaseOwner(directory, owner) ||
          !operations.assertLeaseOwner(outputLock, owner)
        )
          return false;
        terminalHooks?.beforeCanonicalWrite?.({ path: pending });
        operations.writeReceiptAt({
          worktree: before.worktree,
          path: pending,
          contents,
        });
        const finishedAt = now();
        operations.writeTransactionLease({
          directory,
          lease: {
            ...requestPublishing,
            state: 'commit_pending',
            heartbeatAt: finishedAt,
            finishedAt,
          },
          phase: 'finish-request',
          terminalHooks,
        });
        operations.writeTransactionLease({
          directory: outputLock,
          lease: {
            ...outputPublishing,
            state: 'commit_pending',
            heartbeatAt: finishedAt,
            finishedAt,
          },
          phase: 'finish-output',
          terminalHooks,
        });
        if (
          !operations.assertLeaseOwner(directory, owner) ||
          !operations.assertLeaseOwner(outputLock, owner)
        )
          return false;
        if (
          !quarantineReplaceableCanonical({
            path: destination,
            requestKey: request.key,
            worktree: before.worktree,
            terminalHooks,
            receiptCommitPath: operations.receiptCommitPath,
            readReceipt: operations.readReceipt,
            completedReceipt: operations.completedReceipt,
          })
        )
          return false;
        terminalHooks?.beforeCanonicalRename?.({
          from: pending,
          to: destination,
        });
        renameSync(pending, destination);
        terminalHooks?.beforeReceiptCommit?.({ path: destination });
        operations.commitCanonicalReceipt({
          worktree: before.worktree,
          path: destination,
          receipt,
          contents,
        });
        return true;
      } catch (error) {
        publicationFailure = error;
        operations.quarantineExactReceipt({
          path: pending,
          contents,
          suffix: 'failed',
          beforeQuarantine: () =>
            terminalHooks?.beforeReceiptQuarantine?.({ path: pending }),
        });
        operations.quarantineExactReceipt({
          path: destination,
          contents,
          suffix: 'failed',
          beforeQuarantine: () =>
            terminalHooks?.beforeReceiptQuarantine?.({ path: destination }),
        });
        return false;
      }
    },
  });
  if (!published) {
    onOwnershipLost({ reclaimable: true });
    throw new Error(
      `verification ownership lost before terminal publication${publicationFailure?.message ? `: ${boundedText(publicationFailure.message, 512)}` : ''}`,
    );
  }
  return {
    receipt,
    disposition: receipt.disposition,
    request,
    queue: operations.listJobs(root, { now: now(), staleMs }),
    summary: boundedSummaryEnvelope({
      ...summary,
      truncated: outputTruncated,
      artifacts,
      attachmentOmissions,
    }),
  };
}
