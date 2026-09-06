import {
  AnswerBasisRequestError,
  useAnswerBasisQuery,
} from '@kontourai/station-sdk/answer-basis';
import { buildBasisPanelViewModel } from '@kontourai/surface/basis/view';
import type { MouseEvent, ReactElement } from 'react';

/**
 * #1536 B3: the route's 404 is an ANSWER, not a fault, and it keeps 503 for a
 * read it could not perform. The label collapsed both into "Unavailable", so a
 * healthy instance accused itself of a failure over a turn that simply has no
 * basis to show.
 *
 * Review H3: the wording must not claim WHY, either. The route answers 404 for
 * a missing basis AND for a denied or stale-principal read — deliberately, so
 * the two are indistinguishable to the caller (`orchestration.routes.test.ts`:
 * "makes missing and denied answers the same response"). "Not recorded" would
 * be a claim this client cannot make about the denied case, and would leak the
 * distinction the route refuses to leak. So it says only what is true of both:
 * there is no basis Station can show for this turn.
 */
const BASIS_NOT_AVAILABLE_LABEL = 'Basis · Not available for this turn';
const BASIS_NOT_AVAILABLE_TITLE =
  'Station has no basis it can show you for this turn.';

/**
 * Delta review DL5: the label and its explanation come back together. Deriving
 * the title by comparing the rendered label against a constant meant one
 * refusal state was described in two places, so a reworded label would silently
 * drop its own tooltip.
 */
function basisErrorLabel(error: unknown): { label: string; title?: string } {
  return error instanceof AnswerBasisRequestError && error.status === 404
    ? { label: BASIS_NOT_AVAILABLE_LABEL, title: BASIS_NOT_AVAILABLE_TITLE }
    : { label: 'Basis · Unavailable' };
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
  const { label, title } = query.error
    ? basisErrorLabel(query.error)
    : {
        label: model
          ? `Basis · ${model.standing.label} · ${model.gaps.length} ${model.gaps.length === 1 ? 'gap' : 'gaps'}`
          : 'Basis · Checking…',
        title: undefined,
      };
  return (
    <button
      type="button"
      className="station-basis-affordance"
      title={title}
      onClick={(event: MouseEvent<HTMLButtonElement>) =>
        onOpen(event.currentTarget)
      }
    >
      {label}
    </button>
  );
}
