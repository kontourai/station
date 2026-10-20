import type { ApprovalMode } from '@kontourai/station-contracts/provider';
import { InfoTip } from '../../components/InfoTip';
import { useACPConnections } from '../../hooks/useACPConnections';
import {
  APPROVAL_MODE_OPTIONS,
  acpApprovalFor,
  approvalModeKnobSupported,
} from '../../utils/approvalMode';
import type { AgentEditorFormProps } from './types';

/**
 * #2436 (owner request): the approval posture this Agent's sessions start
 * in, and what a Default pick in a chat returns to. The server applies it
 * after a chat's own pick and before this Station's default
 * (`approval-posture.ts`), so it only means something on an engine with an
 * approval knob; on any other engine the control renders nothing, as the
 * composer chip does.
 *
 * Full access here is the same authority as full access on a chat: saving it
 * needs the operator in person or a device granted "Skip approval prompts". The
 * server refuses otherwise, and the save error says so.
 */
export function AgentEditorApprovalDefault({
  form,
  setForm,
  locked,
}: Pick<AgentEditorFormProps, 'form' | 'setForm' | 'locked'>) {
  const { data: acpConnections = [] } = useACPConnections();
  const connectionId = form.execution.agentConnectionId;
  // #3290: an ACP connection has the knob only when Station sets its
  // engine's approval rules, read from its command, never its id.
  const acpApproval = acpApprovalFor(
    acpConnections.find((connection) => connection.id === connectionId),
  );
  if (
    !approvalModeKnobSupported(
      acpApproval ? acpApproval.engineId : connectionId,
    )
  ) {
    return null;
  }
  const value = form.execution.approvalMode ?? '';
  return (
    <div className="editor-field">
      <div className="editor-label-row">
        <label className="editor-label" htmlFor="ae-approval-default">
          Default approval mode
        </label>
        <InfoTip label="Default approval mode">
          The approval mode a chat with this agent starts in, and what picking
          Default in a chat returns to. A chat can still pick its own.
        </InfoTip>
      </div>
      <select
        id="ae-approval-default"
        className="editor-input"
        value={value}
        disabled={locked}
        aria-describedby={
          value === 'never' ? 'ae-approval-default-hint' : undefined
        }
        onChange={(event) =>
          setForm((current) => ({
            ...current,
            execution: {
              ...current.execution,
              approvalMode: (event.target.value || undefined) as
                | ApprovalMode
                | undefined,
            },
          }))
        }
      >
        <option value="">Use this Station&apos;s default</option>
        {APPROVAL_MODE_OPTIONS.filter(
          (option) => option.value !== 'connection-default',
        ).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {value === 'never' && (
        <span className="editor-hint" id="ae-approval-default-hint">
          Every chat with this agent starts at full access: approval prompts are
          off where the engine allows it. A start without a full-access grant,
          such as a webhook, gets a narrower setting: workspace confinement
          where the engine supports it, otherwise automatic approval. Anyone
          using it can still tighten a chat.
        </span>
      )}
    </div>
  );
}
