import { randomUUID } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { createVerificationReceipt } from './verification-receipt.mjs';
import { redactVerificationOutput } from './verification-redaction.mjs';
import {
  DECLARED_CAUSE_BYTE_CAP,
  normalizeDeclaredCause,
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
  // The declared cause, taken VERBATIM and used for both fields that carry it
  // below. Nothing here re-derives it, and that is the whole point.
  //
  // Every previous shape of these three lines re-derived, and every one of
  // them made a rendering disagree with the record it renders. `boundedText`
  // redacts once without the marker strip or the trim, so it appended nine
  // bytes ending in a truncated `[REDACTED` the receipt did not have.
  // Re-running `normalizeDeclaredCause` looked safe on the argument that the
  // function is identity on its own output -- and stopped being so the moment
  // the loop grew an arm that exits when the value is NOT a fixed point, which
  // is precisely when the next value differs. At the production cap 2,453 of
  // 8,415 accepted values leave by that arm, and all 2,453 come back a byte
  // longer inside the marker: `{"apiKey":[REDACTED]}` on the receipt,
  // `{"apiKey":[REDACTED]]}` on the page (round-7 review, H1).
  //
  // There is one derivation, in `normalizeDeclaredCause`, and `reportExecution`
  // hands its result to the summary and to the receipt. A consumer that
  // transforms it again is a second derivation whatever the transform is, and
  // a second derivation is what this branch exists to remove. A producer that
  // puts an unnormalized value in this field is a defect at the producer; the
  // receipt copy has no backstop either, and giving one to only the rendering
  // is exactly how the two came to disagree.
  //
  // Two conditions, both cheap and neither a transform. The equality gate is
  // DEFENSIVE -- the summarizer is the only producer and sets both fields from
  // one value, so across 7,175 combinations it never fired -- and the bound
  // check is what a verbatim copy owes this allow-list, where every other
  // field is bounded. Failing either renders no marker rather than a repaired
  // one, and `firstCausalExcerpt` falls back to its ordinary treatment.
  const declaredCause =
    summary?.infrastructureCause &&
    summary.infrastructureCause === summary.firstCausalExcerpt &&
    Buffer.byteLength(summary.infrastructureCause) <= DECLARED_CAUSE_BYTE_CAP
      ? summary.infrastructureCause
      : null;
  const envelope = {
    terminal: summary?.terminal ?? 'infrastructure_error',
    counts: summary?.counts ?? null,
    cleanup: summary?.cleanup ?? null,
    ...(summary?.failingStep
      ? { failingStep: boundedText(summary.failingStep, 128) }
      : {}),
    ...(summary?.firstCausalExcerpt
      ? {
          firstCausalExcerpt:
            declaredCause ?? boundedText(summary.firstCausalExcerpt, 512),
        }
      : {}),
    // station#1471 review: this allow-list silently dropped `causeStream`, so
    // the caveat the reporter computes -- "that excerpt was chosen by severity
    // and position on an unattributed stream, not scoped to the failing step"
    // -- reached no receipt and no rendering, while the reporter's own comment
    // and docs/strategy/multi-agent-delivery-protocol.md both said the receipt
    // carries it. An absent caveat reads as the STRONGER claim, so omitting it
    // did not lose information: it manufactured confidence. One short enum,
    // bounded like everything else here.
    ...(summary?.causeStream
      ? { causeStream: boundedText(summary.causeStream, 16) }
      : {}),
    // station#1827 review item 7: the positive counterpart of `causeStream`.
    // A runner-declared cause deliberately carries no `causeStream` (the
    // caveat that field renders would be false for it), and this allow-list
    // is where withholding a marker turns into showing nothing at all: the
    // envelope is what the CI annotation and the printed verdict read, so
    // without this a declared cause rendered byte-identically to a scanned
    // one.
    //
    // Gated on the EXCERPT as well as on itself (round-4 review, L4). The
    // marker is a claim about the head excerpt, so it may not appear beside
    // an absent one. The summarizer applies that rule at its end; today it is
    // the only producer, so this gate is unreachable -- but this allow-list
    // is what a second producer would reach, and an allow-list that carries a
    // field without its own rule is where the rule gets lost.
    //
    ...(declaredCause ? { infrastructureCause: declaredCause } : {}),
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

/**
 * The normalized form of the runner's own final word about why it stopped, or
 * null.
 *
 * station#1827: `ciFastInfrastructureCause` (verification-execution-lifecycle)
 * already recovers the owner-final line ci:fast prints before it returns its
 * infrastructure exit code, but only `primaryInterruptedCause` below read it
 * -- and that is reached ONLY when reporting itself throws. On the ordinary
 * path the value was computed and dropped, so the receipt for a budget kill
 * carried no cause and the summary reported a scanned excerpt instead.
 *
 * TWO channels, in `primaryInterruptedCause`'s exact precedence (review item
 * 1). `raw.error.message` is the message of whatever REJECTED the execution,
 * on every lane and not only ci-fast, and threading one channel while dropping
 * the sibling would leave the ordinary path and the reconcile path disagreeing
 * about what the runner's own final word was -- the defect this exists to
 * close.
 *
 * That second channel is a catch-all and its provenance is weaker than the
 * first (round-4 review, L6). Most often it is the owned runner diagnosing
 * itself -- a surviving owned process, an unreadable capture, a spawn failure
 * -- but it also carries a harness assertion raised in `onSpawn` while the
 * child was being adopted, or an error from an injected phase runner, where
 * the stopping command never spoke at all. Nothing downstream may therefore
 * say the CHILD named this; the rendered sentence attributes it to the runner
 * layer, which is true of both channels.
 *
 * `primaryInterruptedCause`'s third arm, the fixed 'ended with an
 * infrastructure error' sentence, is deliberately NOT adopted: it is prose
 * this module synthesizes when neither channel spoke, so promoting it would
 * displace a real scanned excerpt with boilerplate and make the receipt claim
 * a declaration that never happened.
 *
 * Bound to the status it explains. A cause for stopping is meaningful for an
 * `infrastructure_error` terminal and for no other: attaching it to a `failed`
 * result would put an infrastructure explanation on an ordinary red, which is
 * the misattribution this exists to remove, in the other direction.
 */
function ownerInfrastructureCause(raw, result) {
  if (result?.status !== 'infrastructure_error') return null;
  return (
    normalizeDeclaredCause(raw?.infrastructureCause) ??
    normalizeDeclaredCause(raw?.error?.message)
  );
}

function primaryInterruptedCause(raw, result) {
  if (result?.status === 'timed_out')
    return 'verification execution timed out before terminal reporting';
  if (result?.status === 'canceled')
    return 'verification execution was canceled before terminal reporting';
  if (result?.status !== 'infrastructure_error') return null;
  // station#1827 review item 4: the declared cause embedded in this prose is
  // resolved and normalized by the SAME function the receipt records, so the
  // two differ only in rendering -- this branch wraps it in a sentence, and
  // the summary's byte budget may cut it -- never in which declaration they
  // read or in the bytes of that declaration. The precedence itself used to
  // live here in duplicate; that duplication is what let the ordinary path
  // drop `raw.error.message` while this path reported it.
  const declared = ownerInfrastructureCause(raw, result);
  return declared
    ? `verification execution infrastructure error: ${declared}`
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
    // station#1827: the cause rides the RESULT, not only the transient
    // summary -- `publishTerminalReceipt` spreads this object into
    // `createVerificationReceipt`, so this is what makes the runner's own
    // final word survive into the canonical receipt a later reader opens.
    const infrastructureCause = ownerInfrastructureCause(raw, reportedResult);
    return {
      result: infrastructureCause
        ? { ...reportedResult, infrastructureCause }
        : reportedResult,
      artifacts,
      outputTruncated,
      attachmentOmissions,
      summary: summarizeVerificationOutput({
        stdout: raw?.output?.stdout?.text ?? '',
        stderr: raw?.output?.stderr?.text ?? '',
        // The SAME STRING the receipt carries -- this is the whole of the
        // "one cause" guarantee, and it is an identity rather than a claim
        // about two transforms agreeing (station#1827 fix round 2).
        //
        // The first round threaded a normalized value here and let the
        // summarizer normalize it again, which read as belt-and-braces and
        // was not: at the time `normalizeDeclaredCause` was not idempotent, so
        // a cause whose bound landed on a token prefix came back different and
        // the two artifacts named different causes for one run. It IS
        // still is not, and the design does not rest on it being so: the
        // summarizer uses what it is given, and this is the only derivation.
        //
        // What that guarantees, stated no wider than it is true. Whenever the
        // MARKER is present the excerpt was not budget-truncated, and
        // `boundedSummaryEnvelope` copies this one value into both of its
        // fields without transforming it -- so receipt field, summary marker
        // and envelope marker are the same bytes because nothing recomputed
        // them, not because a recomputation happened to agree.
        //
        // When the marker is ABSENT the excerpt may be a budget-truncated
        // prefix that the envelope re-redacts through `boundedText`, and no
        // such claim is made about it. The reconcile branch below separately
        // wraps the cause in a sentence, which is a rendering of the same
        // declaration rather than a second one.
        ...(infrastructureCause ? { infrastructureCause } : {}),
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
      // station#1827: `primaryCause` already put the runner's own final word
      // in the summary on this branch; without this the canonical receipt
      // still lost it, and a receipt that omits the cause on one path while
      // carrying it on the other invites the reading that there was none.
      const preservedCause = ownerInfrastructureCause(raw, result);
      const preserved = {
        ...result,
        reconcileNote,
        ...(preservedCause ? { infrastructureCause: preservedCause } : {}),
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
