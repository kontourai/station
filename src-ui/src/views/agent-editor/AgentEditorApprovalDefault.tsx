import type { ApprovalMode } from '@kontourai/station-contracts/provider';
import {
  APPROVAL_MODE_OPTIONS,
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
 * needs the operator in person or a device granted "Allow full access". The
 * server refuses otherwise, and the save error says so.
 */
export function AgentEditorApprovalDefault({
  form,
  setForm,
  locked,
}: Pick<AgentEditorFormProps, 'form' | 'setForm' | 'locked'>) {
  if (!approvalModeKnobSupported(form.execution.agentConnectionId)) {
    return null;
  }
  const value = form.execution.approvalMode ?? '';
  return (
    <div className="editor-field">
      <label className="editor-label" htmlFor="ae-approval-default">
        Default approval mode
      </label>
      <select
        id="ae-approval-default"
        className="editor-input"
        value={value}
        disabled={locked}
        aria-describedby="ae-approval-default-hint"
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
      <span className="editor-hint" id="ae-approval-default-hint">
        {value === 'never'
          ? 'Every chat with this agent starts at full access: no sandbox and no approval prompts, as you. Anyone using it can still tighten a chat.'
          : 'The approval mode a chat with this agent starts in, and what picking Default in a chat returns to. A chat can still pick its own.'}
      </span>
    </div>
  );
}
