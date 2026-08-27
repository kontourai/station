/**
 * The ONE map of pairing-state copy (station#3849).
 *
 * Three components render the same two pairing states — a request the Station
 * declined, and a request still waiting for approval — and before this they
 * rendered them three ways: `packages/connect`'s `DevicePairingPanel` inside
 * the request dialog, `src-ui`'s `PendingPairingReconciler` as a chrome
 * banner, and `src-ui`'s `OnboardingGate` as the connection banner. Two of the
 * wordings said "host", which `docs/glossary.md` forbids introducing: it is a
 * user-facing synonym for Station, and one concept gets one word.
 *
 * It lives HERE, in contracts, because the two consumers are in different
 * packages and contracts is the only module both may import. `settings-registry.ts`
 * already establishes that rendered copy has a home here.
 *
 * WHAT IT DELIBERATELY DOES NOT COLLAPSE. `declined-access-request` and
 * `declined-device` are the SAME server outcome with different subjects, and
 * station#3387 is why that distinction is load-bearing: the panel is open for
 * one request the reader just made, so "this access request" is its subject;
 * the reconciler and the gate render chrome that may be about a Station the
 * reader is not looking at, so its subject is the device relative to that
 * Station and the banner names it. Collapsing them would put the wrong subject
 * on one of the two surfaces. Two ids keep both true from one map.
 *
 * NAMING THE MACHINE. `stationLabel` is the BROWSER-LOCAL connection label —
 * `SavedConnection.name`, which every one of these render sites already has in
 * scope, and which two of them already use. `devicePresentation.hostName` is
 * deliberately not consulted: `GET /api/system/status` requires a credential,
 * and a device reading this copy is exactly a device that does not have one,
 * so the server's own name for itself is unknowable here by construction.
 * Absent a label the copy still has to name a subject; it says "the Station",
 * which is the vocabulary's own word for the thing.
 *
 * NOT IN THIS MAP: the transport-wait strings ("Waiting to reach X…"). They
 * say nothing this contract forbids, and the panel renders that state as two
 * elements while the gate renders it as one sentence — a difference in shape,
 * not in wording, which a copy map is the wrong tool to reconcile.
 */

/**
 * A pairing state, named by its outcome AND its subject. Two ids may describe
 * one server outcome; see the note above on why that is the point.
 */
export type PairingStateCopyId =
  /** A decline, read inside the dialog that made the request. */
  | 'declined-access-request'
  /** A decline, read as chrome about a device on a possibly-other Station. */
  | 'declined-device'
  | 'waiting-for-approval'
  | 'waiting-for-code-approval'
  | 'expired-access-request'
  | 'expired-pairing-code';

export interface PairingStateCopy {
  /**
   * A short heading, for the surfaces that render a titled banner. Never
   * names the machine — the surfaces that show a title show the message
   * beneath it, and naming the Station twice in one banner reads as two
   * different Stations.
   */
  readonly title: string;
  /** The sentence(s) a reader acts on. */
  readonly message: string;
}

/**
 * The subject at the start of a sentence. "The Station" rather than "this
 * Station" so an unnamed machine reads as a noun phrase and a named one drops
 * straight in.
 */
function sentenceSubject(stationLabel: string | undefined): string {
  return stationLabel?.trim() || 'The Station';
}

/** The subject mid-sentence — "…for approval on Kontour" / "…on this Station". */
function objectSubject(stationLabel: string | undefined): string {
  return stationLabel?.trim() || 'this Station';
}

const PAIRING_STATE_COPY: Record<
  PairingStateCopyId,
  (stationLabel: string | undefined) => PairingStateCopy
> = {
  'declined-access-request': (label) => ({
    title: 'Access request declined',
    message: `${sentenceSubject(label)} declined this access request.`,
  }),
  'declined-device': (label) => ({
    title: 'Access request declined',
    message: `${sentenceSubject(label)} declined this device. Request access again if that was unexpected.`,
  }),
  'waiting-for-approval': (label) => ({
    title: 'Waiting for approval',
    message: `Waiting for approval on ${objectSubject(label)}…`,
  }),
  'waiting-for-code-approval': (label) => ({
    title: 'Waiting for approval',
    message: `Waiting for the code to be approved on ${objectSubject(label)}…`,
  }),
  'expired-access-request': (label) => ({
    title: 'Access request expired',
    message: `This access request expired before ${objectSubject(label)} approved it. Request access again.`,
  }),
  'expired-pairing-code': (label) => ({
    title: 'Pairing code expired',
    message: `This pairing code expired before ${objectSubject(label)} approved it. Create a new code on ${objectSubject(label)}.`,
  }),
};

/**
 * The one read of pairing-state copy. `stationLabel` is the browser-local
 * connection label when this device has one, and omitted when it does not.
 */
export function pairingStateCopy(
  id: PairingStateCopyId,
  stationLabel?: string,
): PairingStateCopy {
  return PAIRING_STATE_COPY[id](stationLabel);
}

/** Every id, for a test that must iterate the whole map rather than a sample. */
export const PAIRING_STATE_COPY_IDS = Object.keys(
  PAIRING_STATE_COPY,
) as readonly PairingStateCopyId[];
