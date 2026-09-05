import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import {
  isSupportedTurnProvenanceEnvelope,
  type TurnProvenanceEnvelope,
} from '@kontourai/station-contracts/turn-provenance';
import type { EngineDescriptor } from '../../../utils/engine';
import { modelIdentityLabel } from '../../../utils/modelCapabilities';
import { displayModelIdentifier } from '../../../utils/modelDisplay';

/** The subset of a chat row these resolvers read. */
interface TurnIdentitySource {
  /**
   * The model Station asked for, as the chat store recorded it. Deliberately
   * accepted here and deliberately never read for identity: archive#1424's
   * defect was resolving a turn's engine from data like this, and archive#1434
   * keeps that closed by making the envelope the only authority. It stays in
   * the signature so `message-bubble-utils.test.ts` can state that plainly.
   */
  model?: string;
  /** `metadata.provenance` exactly as the server sent it (archive#1410). */
  provenance?: unknown;
}

/**
 * The row's turn provenance envelope, or `null` when there is none this
 * build can read.
 *
 * "Cannot read" and "absent" collapse into the same answer on purpose
 * (archive#1410, archive#1434): an envelope written by a newer Station, truncated, or
 * hand-edited must degrade every identity surface to honest absence rather
 * than to a partial claim assembled from the fields that happen to look
 * familiar.
 */
function readEnvelope(msg: TurnIdentitySource): TurnProvenanceEnvelope | null {
  return isSupportedTurnProvenanceEnvelope(msg.provenance)
    ? msg.provenance
    : null;
}

/**
 * The engine that executed THIS turn, read from the turn's own provenance
 * envelope (archive#1434, closing archive#1424's residual 1).
 *
 * Two things this deliberately does not do:
 *
 * - It never reads the agent's CURRENT engine binding. That was archive#1424:
 * an agent's engine connection can be rebound after a turn
 *   ran, and deriving from live state silently relabels history. The
 *   envelope is a per-turn record, so it cannot drift.
 * - It never infers an engine from a model id. Station has no
 *   evidence-grounded model-id⇄engine mapping (see `codex-models.ts`'s
 *   discovery-only design), and inventing one here would be a guess wearing
 *   a chip.
 *
 * The label comes from `engineDisplayLabel` — the same function
 * `TurnProvenanceCard` uses — so the chip and the card speak ONE vocabulary
 * for one fact. When the provider has no product name yet, the raw slug is
 * the honest answer (identical to the card's own unknown state); it is an
 * identifier the envelope actually observed, not the guessed-from-a-
 * connection-id case `EngineChip`'s rule exists to prevent.
 */
export function resolveTurnEngine(
  msg: TurnIdentitySource,
): EngineDescriptor | null {
  const envelope = readEnvelope(msg);
  if (envelope?.engine.state !== 'observed') return null;
  const { provider } = envelope.engine.value;
  return { name: engineDisplayLabel(provider) ?? provider };
}

/** Which model slot a rendered claim came from. */
export type TurnModelSlot = 'requested' | 'reported' | 'agreed';

export interface TurnModelClaim {
  slot: TurnModelSlot;
  /** Short badge label naming WHICH model identity this is. */
  label: string;
  /** The identity verbatim, exactly as the envelope recorded it. */
  value: string;
  /** The card's own full wording for the same slot, kept as the tooltip. */
  description: string;
}

/**
 * The model identity a row may state.
 *
 * `source: 'metadata-absent'` means the row has no readable envelope (an earlier message,
 * a flag-off session, a malformed payload) — the caller keeps the
 * pre-archive#1434 `message__model-badge` exactly as it was.
 * `source: 'envelope'` means the envelope is the authority, and `claims` is
 * the complete set of model statements the row is allowed to make: possibly
 * empty, when the envelope observed no model at all.
 */
export type TurnModelIdentity =
  | { source: 'metadata-absent' }
  | { source: 'envelope'; claims: TurnModelClaim[] };

const METADATA_ABSENT_MODEL_IDENTITY: TurnModelIdentity = {
  source: 'metadata-absent',
};

/**
 * Resolves what a row may say about its model (archive#1434, closing
 * archive#1410 finding).
 *
 * The envelope models "what Station asked for" and "what the engine said it
 * ran" as two separate slots, so a row that has an envelope renders them as
 * separate LABELLED claims and never collapses them — a disagreement
 * (archive#1182) is a fact about the turn, not noise to be resolved by
 * picking a favourite. When they agree there is one fact, so one claim.
 *
 * When the envelope observed no model, the row states none. It specifically
 * does NOT fall back to the chat store's own `model`: the card on that same
 * row is simultaneously reporting the model as a named gap, and a bare
 * badge next to that gap is the contradiction this issue closes.
 */
export function resolveTurnModelIdentity(
  msg: TurnIdentitySource,
): TurnModelIdentity {
  const envelope = readEnvelope(msg);
  if (!envelope) return METADATA_ABSENT_MODEL_IDENTITY;

  const requested =
    envelope.requestedModel.state === 'observed'
      ? displayModelIdentifier(envelope.requestedModel.value)
      : null;
  const reported =
    envelope.reportedModel.state === 'observed'
      ? displayModelIdentifier(envelope.reportedModel.value)
      : null;

  const claims: TurnModelClaim[] = [];
  // #1536 B5: identity comparison stays on the OBSERVED ids — two ids are the
  // same fact or they are not, and a display rule must never decide that.
  // Only what the row PRINTS goes through the shared identity label, so a turn
  // no longer reads "Requested default · Reported claude-opus-5" beside a dock
  // header saying "Opus 5". The observed id keeps its place in the title.
  if (requested !== null && requested === reported) {
    claims.push({
      slot: 'agreed',
      label: 'Model',
      value: modelIdentityLabel(requested),
      description: `Station requested this model and the engine reported it (${requested})`,
    });
  } else {
    if (requested !== null) {
      claims.push({
        slot: 'requested',
        label: 'Requested',
        value: modelIdentityLabel(requested),
        description: `Model requested (${requested})`,
      });
    }
    if (reported !== null) {
      claims.push({
        slot: 'reported',
        label: 'Reported',
        value: modelIdentityLabel(reported),
        description: `Model reported by engine (${reported})`,
      });
    }
  }
  return { source: 'envelope', claims };
}
