/**
 * Explicit, fact-derived presentation for the connected-server source check
 * (update-ux PR4). Every user-visible claim here is derived from typed wire
 * facts — never from `status.message` prose, which older and newer servers
 * may author freely and which the UI must not parse for meaning.
 *
 * Copy rows (S1–S15, P2–P5, A5–A7) come verbatim from the approved plan
 * inventory; see docs/guides/nightly.md for the semantics they render.
 */

import type {
  ServiceUpdateProgress,
  SystemIdentityResponse,
} from '@kontourai/station-contracts/system-status';
import type { CoreUpdateStatus } from '@kontourai/station-sdk';
import type { ReactNode } from 'react';
import { CheckGlyph } from '../../components/icons/Glyph';

export type ComparisonTone = 'success' | 'warning' | 'error' | 'muted';

export interface ComparisonView {
  kind:
    | 'failed-check'
    | 'refusal'
    | 'no-upstream'
    | 'checkout'
    | 'stamp'
    | 'release'
    | 'unknown';
  tone: ComparisonTone;
  /** Derived sentence (S3–S10); null renders no state line at all. */
  text: string | null;
  /** Success glyph accompanies only a computed "matches" fact. */
  glyph: boolean;
  /**
   * Divergence blocks every apply offer (S7) even when the method is
   * supported and the scope is current.
   */
  diverged: boolean;
}

/** A prebuilt release archive, run by the service launcher or not (#2675). */
export function isArchiveInstall(status: CoreUpdateStatus): boolean {
  return (
    status.installKind === 'archive' || status.installKind === 'archive-service'
  );
}

/**
 * A release archive's check (#2675 D3), from its typed facts: the verified
 * manifest's version against the running one. Nothing here is read out of
 * `message`.
 */
function releaseComparisonView(status: CoreUpdateStatus): ComparisonView {
  const unknown: ComparisonView = {
    kind: 'release',
    tone: 'muted',
    text: null,
    glyph: false,
    diverged: false,
  };
  const channel = status.channel ?? 'configured';
  if (status.releaseCheck === 'unverified') {
    return {
      ...unknown,
      tone: 'error',
      text: `The ${channel} release manifest did not verify against Station’s signing keys. Update availability is unknown.`,
    };
  }
  if (status.releaseCheck === 'not-recorded') {
    return {
      ...unknown,
      text: 'This install records no public release manifest, so this server cannot check for a newer release.',
    };
  }
  if (
    status.releaseCheck !== 'verified' ||
    !status.currentVersion ||
    !status.latestVersion
  ) {
    return unknown;
  }
  if (status.updateAvailable) {
    return {
      ...unknown,
      tone: 'warning',
      text: `Station ${status.latestVersion} is available. This server runs ${status.currentVersion}.`,
    };
  }
  return {
    ...unknown,
    tone: 'success',
    text: `This server runs the newest ${channel} release (${status.currentVersion}).`,
    glyph: true,
  };
}

function commitCount(n: number): string {
  return `${n} commit${n === 1 ? '' : 's'}`;
}

/**
 * The comparison-priority matrix from the plan, applied to one parsed status:
 *
 * 1. (Handled by the caller) a stale scope or disconnected server renders the
 *    result as historical — this function never sees that case.
 * 2. HTTP/SDK failure or `remoteUnreachable` → failed check (S3), never a
 *    current "no update" result.
 * 3. Unknown provenance → missing/invalid/generic refusal (P2/P4/P5).
 * 4. `noUpstream` → S8.
 * 5. Valid checkout counts → diverged/behind/ahead/matches (S4–S7).
 * 6. Valid stamped comparison → matches/differs (S9/S10). SHA inequality is a
 *    build-stamp fact and NEVER an "update available" claim.
 * 7. Missing comparison facts → unknown; no state line, no success icon.
 */
export function deriveComparisonView(
  status: CoreUpdateStatus,
  checkError: unknown,
): ComparisonView {
  if (checkError || status.remoteUnreachable) {
    return {
      kind: 'failed-check',
      tone: checkError ? 'error' : 'warning',
      text: "Could not check the server's update source. Update availability is unknown.",
      glyph: false,
      diverged: false,
    };
  }
  if (isArchiveInstall(status)) return releaseComparisonView(status);
  if (
    status.provenanceIssue === 'missing' ||
    status.provenanceIssue === 'invalid-stamp' ||
    status.installKind === 'unknown'
  ) {
    return {
      kind: 'refusal',
      tone: 'warning',
      text:
        status.provenanceIssue === 'invalid-stamp'
          ? 'This server’s update provenance is invalid. Station cannot determine whether a server update is available. Use the installation method that manages this server.'
          : 'This server install has no usable update provenance. Station cannot determine whether a server update is available. Use the installation method that manages this server.',
      glyph: false,
      diverged: false,
    };
  }
  if (status.noUpstream) {
    return {
      kind: 'no-upstream',
      tone: 'muted',
      text: 'No upstream is configured for this server checkout.',
      glyph: false,
      diverged: false,
    };
  }
  const behind = status.behind;
  const ahead = status.ahead;
  if (typeof behind === 'number' || typeof ahead === 'number') {
    const behindCount = behind ?? 0;
    const aheadCount = ahead ?? 0;
    if (behindCount > 0 && aheadCount > 0) {
      return {
        kind: 'checkout',
        tone: 'error',
        text: 'Server checkout has diverged from its upstream. Manual resolution is required.',
        glyph: false,
        diverged: true,
      };
    }
    if (behindCount > 0) {
      return {
        kind: 'checkout',
        tone: 'warning',
        text: `Server checkout is ${commitCount(behindCount)} behind its configured upstream.`,
        glyph: false,
        diverged: false,
      };
    }
    if (aheadCount > 0) {
      return {
        kind: 'checkout',
        tone: 'warning',
        text: `Server checkout is ${commitCount(aheadCount)} ahead of its configured upstream.`,
        glyph: false,
        diverged: false,
      };
    }
    return {
      kind: 'checkout',
      tone: 'success',
      text: 'Server checkout matches its configured upstream.',
      glyph: true,
      diverged: false,
    };
  }
  if (status.currentHash && status.remoteHash) {
    const matches = status.currentHash === status.remoteHash;
    return {
      kind: 'stamp',
      tone: matches ? 'success' : 'warning',
      text: matches
        ? 'This build matches the configured source ref.'
        : 'This build differs from the configured source ref. This check does not establish whether an installable release is available.',
      glyph: matches,
      diverged: false,
    };
  }
  // Missing comparison facts: unknown. No claim, no success icon.
  return {
    kind: 'unknown',
    tone: 'muted',
    text: null,
    glyph: false,
    diverged: false,
  };
}

/**
 * The install's update channel, with where it came from, and an explicit
 * answer when there is none (epic #2144 slice 6 item C).
 *
 * Station has no writer for this. `CoreUpdateStatus.channel` reaches the
 * client only from `readNightlySourceStamp`
 * (`src-server/routes/system/install-provenance.ts`), the installer-written
 * stamp whose reader rejects anything malformed rather than fabricating a
 * channel — so "set at install" is what the value IS, not a guess about it.
 * An install with no stamp (a source checkout, or a hand-copied bundle) has
 * no channel at all, and the previous compact fact row said nothing in that
 * case, which reads the same as not having looked.
 *
 * Deliberately no selector: switching channels means reinstalling from the
 * other channel's installer, and a control that looked like it could change
 * this would be a control with nothing behind it.
 *
 * Renders only once a check has ANSWERED — the caller passes `status`, so a
 * card that has never checked cannot claim "not recorded".
 */
export function UpdateChannelRow({ status }: { status: CoreUpdateStatus }) {
  return (
    <div className="settings__update-meta">
      <span>
        Update channel:{' '}
        {status.channel
          ? `${status.channel} (set at install)`
          : 'Not recorded for this install'}
      </span>
    </div>
  );
}

/**
 * A5 source-metadata labels for the compact fact row.
 *
 * `channel` is deliberately absent: it has its own row
 * ({@link UpdateChannelRow}) in both cards that render this list, because it
 * needs a provenance statement and an absent case that a bare `label: value`
 * run cannot carry. Adding it back here would print it twice.
 */
export function comparisonMetadata(
  status: CoreUpdateStatus,
): Array<{ label: string; value: string }> {
  const labels: Array<{ label: string; value: string }> = [];
  if (status.currentVersion) {
    labels.push({ label: 'Version', value: status.currentVersion });
  }
  if (status.latestVersion) {
    labels.push({ label: 'Latest release', value: status.latestVersion });
  }
  if (status.branch) labels.push({ label: 'Branch', value: status.branch });
  if (status.currentHash) {
    const label =
      status.installKind === 'source-checkout'
        ? 'Checkout'
        : status.installKind === 'desktop-bundle'
          ? 'Build'
          : 'Current';
    labels.push({ label, value: status.currentHash });
  }
  if (status.remoteHash) {
    labels.push({ label: 'Source ref', value: status.remoteHash });
  }
  return labels;
}

/**
 * True only when the check response carries the answering server's identity
 * AND it is the same identity this view correlated (plan apply-gating rule).
 * Older servers that cannot state an identity keep their comparison facts but
 * never earn a new apply offer from uncorrelated metadata.
 */
export function serverIdentityMatchesView(
  status: CoreUpdateStatus,
  viewIdentity: SystemIdentityResponse | null | undefined,
): boolean {
  const answered = status.serverIdentity;
  if (!answered) return false;
  if (!viewIdentity) return false;
  return (
    answered.instanceId === viewIdentity.instanceId &&
    answered.bootId === viewIdentity.bootId &&
    answered.sha === viewIdentity.sha
  );
}

/**
 * P3 technical-details disclosure. Escaped text nodes only — never HTML.
 * Renders nothing when there is no diagnostic, because a disclosure with no
 * content manufactures the impression of a detail nobody supplied.
 */
export function TechnicalDetails({
  message,
  detail,
}: {
  message?: string | null;
  detail?: string | null;
}) {
  const lines: string[] = [];
  if (typeof message === 'string' && message.length > 0) lines.push(message);
  if (typeof detail === 'string' && detail.length > 0) lines.push(detail);
  if (lines.length === 0) return null;
  return (
    <details className="settings__update-technical">
      <summary>Technical details</summary>
      {lines.map((line) => (
        <pre key={line}>{line}</pre>
      ))}
    </details>
  );
}

/** One derived state line (S-row) in its computed tone. */
export function ComparisonMessage({
  view,
}: {
  view: ComparisonView;
}): ReactNode {
  if (!view.text) return null;
  const modifier =
    view.tone === 'muted' ? '' : ` settings__update-msg--${view.tone}`;
  return (
    <div className={`settings__update-msg${modifier}`}>
      {view.text}
      {view.glyph && (
        <>
          {' '}
          <CheckGlyph />
        </>
      )}
    </div>
  );
}

/** The launcher's reason codes (station-launcher.mjs), in words. */
function serviceUpdateReason(reason: string): string {
  const exited = /^candidate-exited:(.+)$/.exec(reason);
  if (exited) return `the new version exited (${exited[1]})`;
  switch (reason) {
    case 'prepared-timeout':
      return 'the new version did not become ready in time';
    case 'trial-attempts-exhausted':
      return 'the new version did not start in its allowed attempts';
    case 'backup-failed':
      return 'the Station home could not be backed up';
    case 'target-runtime-missing':
      return 'the new version is missing or incomplete';
    case 'candidate-start-failed':
      return 'the new version could not be started';
    case 'invalid-prepared':
      return 'the new version reported readiness for a different update';
    case 'rollback-interrupted':
      return 'an interrupted rollback was completed';
    default:
      return reason;
  }
}

function finishedTime(at: string): string {
  const time = Date.parse(at);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : at;
}

export const SERVICE_UPDATE_IN_FLIGHT: ReadonlySet<
  ServiceUpdateProgress['state']
> = new Set(['queued', 'staging', 'updating']);

/**
 * One line for the service launcher's update progress (#2675 D3): what the
 * runtime files say, in the tone of the outcome. Finished outcomes carry
 * their time, since the same record answers until the next update.
 */
export function serviceUpdateProgressLine(
  progress: ServiceUpdateProgress,
): { tone: ComparisonTone; text: string } | null {
  switch (progress.state) {
    case 'idle':
      return null;
    case 'unavailable':
      return {
        tone: 'warning',
        text: 'The Station service’s update progress cannot be read.',
      };
    case 'queued':
      return {
        tone: 'muted',
        text: 'Update requested. Waiting for the Station service to start it…',
      };
    case 'staging':
      return {
        tone: 'muted',
        text: 'Downloading and verifying the release…',
      };
    case 'updating':
      switch (progress.phase) {
        case 'stopping':
          return {
            tone: 'muted',
            text: `Stopping Station ${progress.fromVersion} to switch to ${progress.targetVersion}…`,
          };
        case 'backing-up':
          return {
            tone: 'muted',
            text: `Backing up the Station home before trying ${progress.targetVersion}…`,
          };
        case 'trial':
          return {
            tone: 'muted',
            text: `Trying Station ${progress.targetVersion} (attempt ${progress.attempts}). The server restarts during the trial.`,
          };
        case 'restoring':
          return {
            tone: 'warning',
            text: `Station ${progress.targetVersion} did not start. Restoring the Station home and returning to ${progress.fromVersion}…`,
          };
      }
      return null;
    case 'committed':
      return {
        tone: 'success',
        text: `Server updated from ${progress.fromVersion} to ${progress.targetVersion} (${finishedTime(progress.finishedAt)}).`,
      };
    case 'rolled-back':
      return {
        tone: 'warning',
        text: `The update to ${progress.targetVersion} was rolled back: ${serviceUpdateReason(progress.reason)}. The server runs ${progress.fromVersion} (${finishedTime(progress.finishedAt)}).`,
      };
    case 'failed':
      return {
        tone: 'error',
        text: `The update to ${progress.targetVersion} failed: ${serviceUpdateReason(progress.reason)}. The server runs ${progress.fromVersion} (${finishedTime(progress.finishedAt)}).`,
      };
    case 'up-to-date':
      return {
        tone: 'success',
        text: `The server already runs the newest release (${progress.version}).`,
      };
    case 'staging-failed':
      return {
        tone: 'error',
        text: `The release could not be downloaded or verified: ${progress.reason}`,
      };
    case 'rejected':
      return {
        tone: 'error',
        text: `The Station service refused the update: ${progress.reason}`,
      };
  }
}
