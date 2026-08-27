import {
  CONVERSATION_HANDOFF_DISCLOSURE_LABELS,
  type ConversationHandoffProjection,
} from '@kontourai/station-contracts/orchestration';
import type { AgentData } from '../../contexts/AgentsContext';
import { agentEngineDescriptor } from '../../utils/engine';
import { engineChipLabel } from '../badges/EngineChip';
import { normalizedDisplayLabel } from './message-bubble/MessageAttribution';
import './ConversationHandoff.css';

export function ConversationHandoffBoundary({
  handoff,
  agents,
}: {
  handoff: ConversationHandoffProjection;
  agents: AgentData[];
}) {
  const agent = agents.find(
    (candidate) => candidate.slug === handoff.targetAgentId,
  );
  const agentName = agent?.name ?? `deleted Agent “${handoff.targetAgentId}”`;
  const currentConnectionId = agent?.execution?.agentConnectionId;
  const currentDescriptor = agent ? agentEngineDescriptor(agent) : null;
  const engineName = !handoff.targetConnectionId
    ? 'Station'
    : currentConnectionId === handoff.targetConnectionId && currentDescriptor
      ? engineChipLabel(currentDescriptor)
      : 'engine unavailable';
  const repeatsAgent =
    normalizedDisplayLabel(agentName) === normalizedDisplayLabel(engineName);
  const handoffLabel = `Continued with ${agentName}${
    repeatsAgent ? '' : ` using ${engineName}`
  }`;

  return (
    <section
      className="conversation-handoff-boundary"
      aria-label={handoffLabel}
    >
      <strong>{`Continued with ${agentName}${repeatsAgent ? '' : ` (${engineName})`}`}</strong>
      {handoff.targetConnectionId && engineName === 'engine unavailable' && (
        <small>{`Recorded engine connection: ${handoff.targetConnectionId}`}</small>
      )}
      {handoff.targetModelId && (
        <span>{`Model: ${handoff.targetModelId}`}</span>
      )}
      <details>
        <summary>What carried and reset</summary>
        <div className="conversation-handoff-boundary__disclosure">
          <div>
            <span>Carried</span>
            <ul>
              {handoff.carried.map((field) => (
                <li key={field}>
                  {CONVERSATION_HANDOFF_DISCLOSURE_LABELS[field]}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <span>Reset</span>
            <ul>
              {handoff.reset.map((field) => (
                <li key={field}>
                  {CONVERSATION_HANDOFF_DISCLOSURE_LABELS[field]}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </details>
    </section>
  );
}
