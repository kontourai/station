import type {
  InputRequestDecisionBody,
  InputRequestDecisionOption,
} from '@kontourai/station-contracts/input-request';
import { ActionRow } from '../ActionRow';
import { Button } from '../Button';
import './InputRequestDecision.css';

/**
 * #3390: the renderer for a `decision` body — an approval's choices. It reads
 * the options' effect and scope, never a source. Answering one is a grant,
 * so it hands the choice to the approval's own authority path
 * (`onApprove`'s `once` / `trust` / `trust-server` / `deny`).
 */
export type ApprovalAction = 'once' | 'trust' | 'trust-server' | 'deny';

function approvalActionForOption(
  option: InputRequestDecisionOption,
): ApprovalAction {
  if (option.effect === 'deny') return 'deny';
  return option.scope === 'session'
    ? option.sessionGrantScope === 'server'
      ? 'trust-server'
      : 'trust'
    : 'once';
}

/** Desktop: keep the one-call decision visible and standing grants in the overflow. */
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
    <DecisionActionRow
      body={body}
      busy={busy}
      inFlight={false}
      onChoose={onChoose}
      overflowLabel="More ways to allow this request"
    />
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
  overflowLabel = 'More approval options',
}: {
  body: InputRequestDecisionBody;
  busy: boolean;
  inFlight: boolean;
  chosen?: ApprovalAction;
  overflowLabel?: string;
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
      className="approval-decision-row"
      overflowLabel={overflowLabel}
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
