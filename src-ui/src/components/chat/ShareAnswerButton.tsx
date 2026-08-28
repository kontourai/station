import { answerSharePermalink } from '@kontourai/station-contracts/answer-share';
import {
  isSupportedTurnProvenanceEnvelope,
  type TurnProvenanceEnvelope,
} from '@kontourai/station-contracts/turn-provenance';
import {
  AnswerShareAuthRequiredError,
  useMintAnswerShareMutation,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { errorText } from '../../utils/errorText';
import { deriveShareUiOrigin } from '../../utils/shareUiOrigin';
import { LazyBoundary } from '../LazyBoundary';
import './ShareAnswerButton.css';

/**
 * The pairing path, loaded only once a 401 has actually happened. It pulls in
 * the connect package's pairing core, which has no business in the entry
 * chunk for a case most operators never hit.
 */
const loadShareAnswerPairingPrompt = () =>
  import('./ShareAnswerPairingPrompt').then((module) => ({
    default: module.ShareAnswerPairingPrompt,
  }));

/**
 * "Share answer" (archive#1423) — the operator's mint affordance, sitting
 * beside the turn's provenance card because a share IS the answer plus its
 * receipts.
 *
 * Deliberately not a dialog. A modal would need `ResponsiveDialogSurface`
 * and an inventory entry, and it would put a form between the operator and a
 * one-click act; the whole interaction is "make a link, put it on my
 * clipboard, tell me when it dies." Options (a label, a custom lifetime) live
 * on the API for a caller that wants them and are not invented as UI here.
 *
 * Two honest-state rules this button holds:
 *
 *  - It reads the session and turn ids from the ENVELOPE, never from the
 *    surrounding row's props. The envelope's ids are the exact correlation
 * archive#1410 establishes; a positional or prop-derived id could mint a
 *    permalink to a different answer than the one the operator clicked.
 *  - **The permalink is composed HERE, from `window.location.origin`**, and
 *    the server never sends one. It cannot: the browser talks to the UI port,
 *    whose proxy rewrites `Host` to the backend before forwarding, and the
 *    backend serves neither the SPA nor the `/share` route — so a
 *    server-composed link is dead on arrival. `window.location.origin` is the
 *    address the operator is demonstrably reaching Station on, which is the
 *    only origin that can be true.
 *  - The result is reported inline and STAYS on screen, not in a toast. The
 *    token exists exactly once — the server keeps only its digest — so a
 *    notification that dismisses itself could take the only copy of a
 *    capability with it. For the same reason a failed clipboard write is
 *    never reported as a copy: the link is shown either way, and the
 *    sentence says which happened.
 */

export interface ShareAnswerButtonProps {
  /** The same value the sibling provenance card receives. */
  provenance: unknown;
  /** Defaults to the live UI origin; injectable for deterministic host tests. */
  uiOrigin?: string;
}

function idsFrom(
  provenance: unknown,
): Pick<TurnProvenanceEnvelope, 'sessionId' | 'turnId'> | null {
  return isSupportedTurnProvenanceEnvelope(provenance)
    ? { sessionId: provenance.sessionId, turnId: provenance.turnId }
    : null;
}

export function ShareAnswerButton({
  provenance,
  uiOrigin = window.location.origin,
}: ShareAnswerButtonProps) {
  const mint = useMintAnswerShareMutation();
  const [minted, setMinted] = useState<{
    permalink: string;
    copied: boolean;
  } | null>(null);
  // archive#2652 redesign: the unshareable-origin explanation is USEFUL, but
  // printing it under every answer forever made the share affordance the
  // loudest thing in the turn. It now appears when the user actually reaches
  // for the control — the moment the sentence answers a question they have.
  const [showUnavailable, setShowUnavailable] = useState(false);
  const ids = idsFrom(provenance);
  const origin = deriveShareUiOrigin(uiOrigin);

  // An envelope this build cannot read cannot be correlated to a turn, and a
  // share of an uncorrelated turn is a link to nothing. No button.
  if (!ids) return null;

  const share = () => {
    if (!origin.verified) {
      setShowUnavailable(true);
      return;
    }
    setMinted(null);
    mint.mutate(ids, {
      onSuccess: async (result) => {
        const permalink = answerSharePermalink(origin.origin, result.token);
        let copied = false;
        try {
          await navigator.clipboard.writeText(permalink);
          copied = true;
        } catch {
          // Reported below as "not copied", never swallowed into a claim
          // that it was: a browser can refuse the clipboard outright.
          copied = false;
        }
        setMinted({ permalink, copied });
      },
    });
  };

  return (
    <span className="share-answer">
      {/* An unverified origin keeps the control focusable (`aria-disabled`,
          not `disabled`) so activating it can EXPLAIN itself — a disabled
          button can neither be reached by keyboard nor say why it does
          nothing. The explanation is NOT an always-visible alert beside every
          answer: in the native shell it is true of every one of them, so a
          persistent per-turn `role="alert"` read as technical noise firing
          before any share intent existed (chat-surface honesty pass, #3689).
          It appears on activation instead — discoverable on the control, not
          shouted beside it. */}
      <button
        type="button"
        className="share-answer__button"
        disabled={mint.isPending}
        aria-disabled={!origin.verified || undefined}
        onClick={share}
        title={origin.verified ? undefined : origin.explanation}
        aria-label={
          origin.verified
            ? `Share this answer (turn ${ids.turnId})`
            : `Share this answer (turn ${ids.turnId}) — ${origin.explanation}`
        }
      >
        {mint.isPending ? 'Creating share…' : 'Share answer'}
      </button>
      {!origin.verified && showUnavailable && (
        <span className="share-answer__status" role="alert">
          {origin.explanation}
        </span>
      )}
      {mint.isError && (
        <span className="share-answer__status" role="alert">
          {errorText(mint.error)}
        </span>
      )}
      {/* archive#1423 put minting behind a presented credential, so an
          operator whose browser was never paired hits the auth boundary
          rather than the route. Only the 401 gets the pairing path: a 403
          means a credential WAS presented and refused, and telling that
          caller to pair would send them to re-do something already done
          (N-3). */}
      {mint.error instanceof AnswerShareAuthRequiredError && (
        <LazyBoundary
          load={loadShareAnswerPairingPrompt}
          componentProps={{}}
          pending={null}
        />
      )}
      {minted && (
        <>
          <span className="share-answer__status" role="status">
            {minted.copied
              ? 'Share link copied. It expires in 7 days, and you can revoke it in Settings.'
              : 'Share link created. This browser would not let Station copy it, so copy it from here — Station keeps no second copy.'}
          </span>
          {/* Shown once and never re-fetchable: the server stores only a
              digest of the token, so this element is the only place the link
              exists after the response is gone. */}
          <output className="share-answer__permalink">
            {minted.permalink}
          </output>
        </>
      )}
    </span>
  );
}
