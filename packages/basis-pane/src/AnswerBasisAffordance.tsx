import {
  type AnswerBasisQueryConfig,
  useAnswerBasisQuery,
} from '@kontourai/station-sdk/answer-basis';
import {
  type BasisPanelStanding,
  buildBasisPanelViewModel,
} from '@kontourai/surface/basis/view';
import type { MouseEvent, ReactElement, Ref } from 'react';

/**
 * The Surface standing codes an answer's Basis chip names on its face (owner
 * decision on station#926, 2026-10-19; epic station#418). Execution-only
 * ("Unassessed", nearly every ordinary answer) is the quiet default and
 * stays plain "Basis"; an assessed result and every unresolved class are
 * notable. A closed list on Surface's own code, so a standing Surface adds
 * later stays plain until it is reviewed here. Surface does not yet export a
 * "notable" cue of its own; kontourai/surface#348 asks for one
 * (`basisStandingCue`), which should replace this list.
 */
const NOTABLE_STANDING_CODES: ReadonlySet<BasisPanelStanding['code']> = new Set(
  ['policy-met', 'assessed-with-gaps', 'unresolved'],
);

/** Surface's label for a notable standing; `null` when the chip stays plain. */
export function answerBasisChipCue(
  standing: BasisPanelStanding | null,
): string | null {
  return standing && NOTABLE_STANDING_CODES.has(standing.code)
    ? standing.label
    : null;
}

export interface AnswerBasisAffordanceProps {
  sessionId: string;
  turnId: string;
  /**
   * Whether to read this answer's Basis. A caller enables it only while the
   * chip is on screen, so history scrolled out of view makes no request.
   */
  enabled: boolean;
  requestScope?: AnswerBasisQueryConfig['requestScope'];
  /** Which answer, for the accessible name: e.g. `the answer “…”`. */
  answerName?: string;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
  'aria-busy'?: boolean;
  onOpen(trigger: HTMLButtonElement): void;
}

/**
 * An answer's Basis entry. It reads plain "Basis" unless Surface's standing
 * for this exact answer is notable, when it adds Surface's own label. While
 * the read is pending, failed or not yet made, it stays plain "Basis" and
 * still opens: the opened view states what could not be read.
 */
export function AnswerBasisAffordance({
  sessionId,
  turnId,
  enabled,
  requestScope,
  answerName,
  className,
  ref,
  'aria-busy': ariaBusy,
  onOpen,
}: AnswerBasisAffordanceProps): ReactElement {
  // A mounted chip does not re-read its standing as it scrolls back into
  // view; assessment and narrative updates tombstone and invalidate this key.
  // A remounted chip (the transcript virtualizer unmounts far-off rows) reads
  // again: the SDK re-checks access on mount and hides the cached standing.
  const query = useAnswerBasisQuery(sessionId, turnId, {
    enabled,
    requestScope,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const standing = query.data
    ? buildBasisPanelViewModel(query.data).standing
    : null;
  const cue = answerBasisChipCue(standing);
  const text = cue ? `Basis · ${cue}` : 'Basis';
  const target = answerName ?? 'this answer';
  return (
    <button
      ref={ref}
      type="button"
      className={className ?? 'station-basis-affordance'}
      title={standing?.description ?? 'Open the basis for this answer'}
      aria-label={
        cue
          ? `${text} for ${target}`
          : standing
            ? `Basis for ${target}: ${standing.label}`
            : `Basis for ${target}`
      }
      aria-busy={ariaBusy}
      onClick={(event: MouseEvent<HTMLButtonElement>) =>
        onOpen(event.currentTarget)
      }
    >
      {text}
    </button>
  );
}
