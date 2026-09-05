import {
  AnswerBasisRequestError,
  useAnswerBasisQuery,
} from '@kontourai/station-sdk/answer-basis';
import { buildBasisPanelViewModel } from '@kontourai/surface/basis/view';
import type { MouseEvent, ReactElement } from 'react';

/**
 * #1536 B3: the route's 404 is an ANSWER, not a fault. `GET …/basis` answers
 * 404 when Station recorded no basis for the turn and keeps 503 for a read it
 * could not perform, and this label collapsed both into "Unavailable" — so a
 * healthy instance with nothing recorded for a turn accused itself of a
 * failure. An absence and a failure are different things to tell someone.
 */
function basisErrorLabel(error: unknown): string {
  return error instanceof AnswerBasisRequestError && error.status === 404
    ? 'Basis · Not recorded'
    : 'Basis · Unavailable';
}

export interface AnswerBasisAffordanceProps {
  sessionId: string;
  turnId: string;
  enabled: boolean;
  onOpen(trigger: HTMLButtonElement): void;
}

export function AnswerBasisAffordance({
  sessionId,
  turnId,
  enabled,
  onOpen,
}: AnswerBasisAffordanceProps): ReactElement {
  const query = useAnswerBasisQuery(sessionId, turnId, { enabled });
  const model = query.data ? buildBasisPanelViewModel(query.data) : null;
  const label = query.error
    ? basisErrorLabel(query.error)
    : model
      ? `Basis · ${model.standing.label} · ${model.gaps.length} ${model.gaps.length === 1 ? 'gap' : 'gaps'}`
      : 'Basis · Checking…';
  return (
    <button
      type="button"
      className="station-basis-affordance"
      onClick={(event: MouseEvent<HTMLButtonElement>) =>
        onOpen(event.currentTarget)
      }
    >
      {label}
    </button>
  );
}
