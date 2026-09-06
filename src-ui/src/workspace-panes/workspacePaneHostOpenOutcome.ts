/**
 * The outcome of asking a workspace pane host to open an occurrence (#1596).
 *
 * WHY THIS IS NOT A BOOLEAN. `open` used to answer `true`/`false`, and every
 * caller that surfaced anything at all had to invent a single sentence
 * covering four unrelated situations — so most surfaced nothing. The pane
 * picker's "Open" button was the worst case: a `false` closed no modal, showed
 * no message and wrote no log, which is the click path #1596 was filed for.
 *
 * Each reason below is DERIVED from the branch that produced it, never
 * assumed: `no-lease` is `persistenceStatus !== 'owned'` at the moment of the
 * call, `refused` is a host admission (or host document model) that declined
 * the occurrence, `already-open` is the occurrence's own id already in the
 * document, and `not-persisted` is a durable write or a caller state
 * preparation that failed and was rolled back. There is deliberately NO
 * `host-unmounted` reason: a caller with no host has nothing to open into and
 * nothing to report on, so the absence of a host is a rendering
 * precondition — the surface withholds or withdraws its control — not an
 * outcome. See `ProjectLayoutRenderer`, whose pane picker belongs to its host
 * and closes with it.
 */

/** Why a host did not open an occurrence it was asked to open. */
export type WorkspacePaneHostOpenRefusal =
  /** This tab does not hold the layout's persistence lease. */
  | 'no-lease'
  /** The host declined to place this occurrence. */
  | 'refused'
  /** The occurrence's own id is already in this host's document. */
  | 'already-open'
  /** A durable write or caller state preparation failed, and was rolled back. */
  | 'not-persisted';

export type WorkspacePaneHostOpenOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: WorkspacePaneHostOpenRefusal };

/** The one success value; identity is meaningless here, so it is shared. */
export const WORKSPACE_PANE_OPENED: WorkspacePaneHostOpenOutcome = {
  ok: true,
};

export function workspacePaneOpenRefused(
  reason: WorkspacePaneHostOpenRefusal,
): WorkspacePaneHostOpenOutcome {
  return { ok: false, reason };
}

/**
 * One sentence per reason, as a total record rather than a `switch` with a
 * fallback: a new reason is a type error here, so a refusal can never reach a
 * user as generic copy that happens to be wrong.
 */
const REFUSAL_SENTENCES: Record<WorkspacePaneHostOpenRefusal, string> = {
  'no-lease':
    'This tab cannot save workspace changes right now, so the pane was not opened.',
  refused: 'This workspace cannot hold that pane, so it was not opened.',
  'already-open': 'That pane is already open in this workspace.',
  'not-persisted':
    'Station could not save the workspace layout, so the pane was not opened.',
};

/** The sentence a surface shows for a refusal it just received. */
export function describeWorkspacePaneOpenRefusal(
  reason: WorkspacePaneHostOpenRefusal,
): string {
  return REFUSAL_SENTENCES[reason];
}
