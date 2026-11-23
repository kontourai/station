import {
  CONVERSATION_HANDOFF_DISCLOSURE_LABELS,
  type ConversationHandoffProjection,
  type ConversationHandoffResetField,
} from '@kontourai/station-contracts/orchestration';
import type { TurnProvenanceEngine } from '@kontourai/station-contracts/turn-provenance';
import type { AgentData } from '../../contexts/AgentsContext';
import { agentEngineDescriptor } from '../../utils/engine';
import { modelIdentityLabel } from '../../utils/modelCapabilities';
import { engineChipLabel } from '../badges/EngineChip';
import { BrandIcon } from '../icons/BrandIcon';
import { normalizedDisplayLabel } from './message-bubble/MessageAttribution';
import { TranscriptChangeMarker } from './TranscriptChangeMarker';
import './ConversationHandoff.css';

/**
 * Size of the recent-messages slice a handoff seeds the new engine with: the
 * server's default transcript seed budget (`TRANSCRIPT_SEED_DEFAULT_TOKEN_BUDGET`,
 * 8,000 tokens) — an upper bound, since a short chat carries less.
 */
const HANDOFF_SEED_BUDGET_LABEL = '8K';

/** What starts fresh, in the order and words of chat-24. */
const RESET_WORDS: ReadonlyArray<[ConversationHandoffResetField, string]> = [
  ['sessionApprovals', 'Approvals'],
  ['mcpAndEngineConfiguration', 'tool servers'],
  ['queuedRequests', 'queued messages'],
];

function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

function startsFreshSentence(handoff: ConversationHandoffProjection): string {
  const words = RESET_WORDS.filter(([field]) =>
    handoff.reset.includes(field),
  ).map(([, word], index) => (index === 0 ? word : word.toLowerCase()));
  if (words.length === 0) return '';
  const subject = listWords(words);
  return `${subject.charAt(0).toUpperCase()}${subject.slice(1)} start fresh.`;
}

/**
 * chat-24 "engine switch": the chat moved to another Agent or engine and
 * handed over a bounded slice of recent messages. The pill names where it
 * went; the line says what the new engine read and what starts fresh. The
 * full carried and reset lists stay behind "What carried and reset".
 */
export function ConversationHandoffBoundary({
  handoff,
  agents,
  previousEngine,
}: {
  handoff: ConversationHandoffProjection;
  agents: AgentData[];
  previousEngine?: TurnProvenanceEngine;
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
  const target = repeatsAgent ? agentName : `${agentName} (${engineName})`;
  const model = handoff.targetModelId
    ? ` · ${modelIdentityLabel(handoff.targetModelId)}`
    : '';
  const switched = `Switched to ${target}${model}`;
  const readSentence = handoff.carried.includes('nativeSession')
    ? `${agentName} picked up its earlier conversation and read what it missed.`
    : handoff.carried.includes('authorizedTranscript')
      ? `${agentName} read up to about ${HANDOFF_SEED_BUDGET_LABEL} tokens of recent messages.`
      : '';
  const note = [
    readSentence,
    startsFreshSentence(handoff),
    'Usage is counted separately.',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <TranscriptChangeMarker
      kind="engine"
      label={switched}
      pill={
        <>
          {previousEngine || handoff.targetProvider ? (
            <span className="transcript-change__tiles" aria-hidden="true">
              {previousEngine ? (
                <BrandIcon
                  name={previousEngine.displayName ?? previousEngine.provider}
                  engineId={previousEngine.provider}
                  size={16}
                />
              ) : null}
              {previousEngine && handoff.targetProvider ? '→' : null}
              {handoff.targetProvider ? (
                <BrandIcon
                  name={engineName}
                  engineId={handoff.targetProvider}
                  size={16}
                />
              ) : null}
            </span>
          ) : null}
          {switched}
        </>
      }
      note={note}
    >
      {handoff.targetConnectionId && engineName === 'engine unavailable' && (
        <small>{`Recorded engine connection: ${handoff.targetConnectionId}`}</small>
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
    </TranscriptChangeMarker>
  );
}
