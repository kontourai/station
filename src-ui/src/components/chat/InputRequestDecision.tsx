import type {
  InputRequestDecisionBody,
  InputRequestDecisionOption,
} from '@kontourai/station-contracts/input-request';
import {
  APPROVAL_SESSION_GRANTS_MENU_LABEL,
  approvalDecisionLayout,
} from '@kontourai/station-shared/input-request';
import { ActionRow } from '../ActionRow';
import { Button } from '../Button';
import './InputRequestDecision.css';
import { useDecisionSurface } from '../../lib/custom-appearance/decision-surfaces';

/**
 * #3390: the renderer for a `decision` body — an approval's choices. It reads
 * the options' effect and scope, never a source. Answering one is a grant,
 * so it hands the choice to the approval's own authority path
 * (`onApprove`'s `once` / `trust` / `trust-server` / `trust-rule` /
 * `trust-all` / `deny`).
 */
export type ApprovalAction =
  | 'once'
  | 'trust'
  | 'trust-server'
  | 'trust-rule'
  | 'trust-all'
  | 'deny';

function approvalActionForOption(
  option: InputRequestDecisionOption,
): ApprovalAction {
  if (option.effect === 'deny') return 'deny';
  return option.scope === 'session'
    ? option.sessionGrantScope === 'server'
      ? 'trust-server'
      : option.sessionGrantScope === 'rule'
        ? 'trust-rule'
        : option.sessionGrantScope === 'all'
          ? 'trust-all'
          : 'trust'
    : 'once';
}

/** Desktop: keep the one-call decision visible and the session grants in the menu. */
export function DecisionButtons({
  body,
  busy,
  inFlight = false,
  chosen,
  onChoose,
}: {
  body: InputRequestDecisionBody;
  busy: boolean;
  inFlight?: boolean;
  chosen?: ApprovalAction;
  onChoose: (action: ApprovalAction) => void;
}) {
  useDecisionSurface('tool-approval-decision');
  return (
    <DecisionActionRow
      body={body}
      busy={busy}
      inFlight={inFlight}
      chosen={chosen}
      onChoose={onChoose}
    />
  );
}

/**
 * The approval's actions (chat-14), on the inline card and pinned in the
 * request sheet (#3331): Deny is the secondary action, Allow once the primary,
 * and every session grant the request offered sits in one menu named
 * "Allow for this session" (`approvalDecisionLayout`).
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
  useDecisionSurface('tool-approval-decision');
  const { once, deny, sessionGrants } = approvalDecisionLayout(body);
  return (
    <ActionRow
      className="approval-decision-row"
      overflowLabel={APPROVAL_SESSION_GRANTS_MENU_LABEL}
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
      overflow={sessionGrants.map((option) => ({
        key: option.id,
        label: option.label,
        disabled: busy,
        onSelect: () => onChoose(approvalActionForOption(option)),
      }))}
    />
  );
}
