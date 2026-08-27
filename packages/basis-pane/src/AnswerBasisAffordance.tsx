import { useAnswerBasisQuery } from '@kontourai/station-sdk/answer-basis';
import { buildBasisPanelViewModel } from '@kontourai/surface/basis/view';
import type { MouseEvent, ReactElement } from 'react';

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
    ? 'Basis · Unavailable'
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
