import { flowRunDisplayIdentity } from '@kontourai/station-contracts';
import type { FlowRunBinding } from '../../contexts/active-chats-state';
import {
  describeFlowRunFreshness,
  isFlowRunUngated,
} from '../../utils/flowRunFreshness';
import './flow-events.css';

interface FlowGatedChipProps {
  binding: FlowRunBinding;
}

/**
 * Three states, never two (station#189). "Flow-gated" is a claim that gates
 * are being enforced, so it is reserved for a run that actually has one: a run
 * on a step declaring no gate is attached and stuck, and a binding with no
 * reported freshness is unknown — not quietly assumed to be gated.
 */
function chipState(binding: FlowRunBinding): {
  label: string;
  modifier: string;
  detail: string;
} {
  if (!binding.freshness) {
    return {
      label: 'Flow-attached, evaluation unknown',
      modifier: ' flow-gated-chip--unknown',
      detail: 'evaluation state not reported',
    };
  }
  const freshness = describeFlowRunFreshness(binding) ?? '';
  return isFlowRunUngated(binding)
    ? {
        label: 'Flow-attached, ungated',
        modifier: ' flow-gated-chip--ungated',
        detail: freshness,
      }
    : { label: 'Flow-gated', modifier: '', detail: freshness };
}

export function FlowGatedChip({ binding }: FlowGatedChipProps) {
  const { label, modifier, detail } = chipState(binding);
  const title = [
    `${flowRunDisplayIdentity(binding.definitionId, binding.runId)}${binding.resumed ? ', resumed' : ''}`,
    detail,
  ]
    .filter(Boolean)
    .join(' — ');
  return (
    <span className={`flow-gated-chip${modifier}`} title={title}>
      {label}
    </span>
  );
}
