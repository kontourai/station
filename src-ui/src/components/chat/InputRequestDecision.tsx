import type {
  InputRequestDecisionBody,
  InputRequestDecisionOption,
} from '@kontourai/station-contracts/input-request';
import { ActionRow } from '../ActionRow';
import { Button } from '../Button';

/**
 * #3390: the renderer for a `decision` body — an approval's choices. It reads
 * the options' effect and scope, never a source. Answering one is a grant,
 * so it hands the choice to the approval's own authority path
 * (`onApprove`'s `once` / `trust` / `deny`), which is unchanged.
 */
export type ApprovalAction = 'once' | 'trust' | 'deny';

function approvalActionForOption(
  option: InputRequestDecisionOption,
): ApprovalAction {
  if (option.effect === 'deny') return 'deny';
  return option.scope === 'session' ? 'trust' : 'once';
}

const BUTTON_CLASS: Record<ApprovalAction, string> = {
  once: 'tool-call__approve-btn tool-call__approve-btn--primary',
  trust: 'tool-call__approve-btn tool-call__approve-btn--secondary',
  deny: 'tool-call__approve-btn tool-call__approve-btn--danger',
};

/** Desktop: one button per option, in the body's order. */
export function DecisionButtons({
  body,
  busy,
  onChoose,
}: {
  body: InputRequestDecisionBody;
  busy: boolean;
  onChoose: (action: ApprovalAction) => void;
}) {
  return (
    <>
      {body.options.map((option) => {
        const action = approvalActionForOption(option);
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChoose(action)}
            disabled={busy}
            className={BUTTON_CLASS[action]}
          >
            {option.label}
          </button>
        );
      })}
    </>
  );
}

/**
 * The request sheet's pinned actions (#3331): deny is the secondary action,
 * the one-call allow the primary, and a session allow sits in the overflow.
 */
export function DecisionActionRow({
  body,
  busy,
  inFlight,
  chosen,
  onChoose,
}: {
  body: InputRequestDecisionBody;
  busy: boolean;
  inFlight: boolean;
  chosen?: ApprovalAction;
  onChoose: (action: ApprovalAction) => void;
}) {
  const deny = body.options.find((option) => option.effect === 'deny');
  const once = body.options.find(
    (option) => option.effect === 'allow' && option.scope === 'once',
  );
  const rest = body.options.filter(
    (option) => option !== deny && option !== once,
  );
  return (
    <ActionRow
      overflowLabel="More approval options"
      secondary={
        deny ? (
          <Button
            variant="danger-outline"
            disabled={busy}
            pending={inFlight && chosen === 'deny'}
            pendingLabel="Denying…"
            onClick={() => onChoose('deny')}
          >
            {deny.label}
          </Button>
        ) : undefined
      }
      primary={
        once ? (
          <Button
            variant="primary"
            disabled={busy}
            // A session grant is an allow too; its overflow item cannot show
            // progress, so the primary allow carries it.
            pending={inFlight && chosen !== 'deny'}
            pendingLabel="Allowing…"
            onClick={() => onChoose('once')}
          >
            {once.label}
          </Button>
        ) : undefined
      }
      overflow={rest.map((option) => ({
        key: option.id,
        label: option.label,
        disabled: busy,
        onSelect: () => onChoose(approvalActionForOption(option)),
      }))}
    />
  );
}
