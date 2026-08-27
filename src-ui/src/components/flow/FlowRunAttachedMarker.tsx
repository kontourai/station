import { flowRunDisplayIdentity } from '@kontourai/station-contracts';
import type { FlowRunBinding } from '../../contexts/active-chats-state';
import {
  describeFlowRunFreshness,
  isFlowRunUngated,
} from '../../utils/flowRunFreshness';
import './flow-events.css';

interface FlowRunAttachedMarkerProps {
  binding: FlowRunBinding;
}

export function FlowRunAttachedMarker({ binding }: FlowRunAttachedMarkerProps) {
  const freshness = describeFlowRunFreshness(binding);
  const ungated = isFlowRunUngated(binding);
  return (
    <section className="flow-run-attached" aria-label="Flow run attached">
      <span className="flow-run-attached__rule" aria-hidden="true" />
      <span className="flow-run-attached__label">
        {ungated ? 'Flow-attached session' : 'Flow-gated session'}
        {binding.resumed ? ' (resumed)' : ''}:{' '}
        <span className="flow-run-attached__ids">
          {flowRunDisplayIdentity(binding.definitionId, binding.runId)}
        </span>
        {/* The binding on its own reads as progress; the run's actual
            evaluation state is the part an operator needs (station#189). */}
        {freshness ? (
          <span className="flow-run-attached__freshness"> — {freshness}</span>
        ) : null}
      </span>
      <span className="flow-run-attached__rule" aria-hidden="true" />
    </section>
  );
}
