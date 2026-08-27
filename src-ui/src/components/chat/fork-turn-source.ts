import type { ProviderKind } from '@kontourai/station-contracts/provider';
import { isSupportedTurnProvenanceEnvelope } from '@kontourai/station-contracts/turn-provenance';
import type { ChatMessage } from '../../types';

export interface ForkTurnSource {
  turnId: string;
  agentSlug: string;
  sessionId?: string;
  provider?: ProviderKind;
  model?: string;
}

/** Immutable execution identity recorded on the selected historical row. */
export function forkTurnSource(
  message: ChatMessage,
  exactSessionFallback?: Pick<ForkTurnSource, 'agentSlug'>,
): ForkTurnSource | null {
  if (!message.turnId || !message.answerEligible) return null;
  const agentSlug = message.agentSlug ?? exactSessionFallback?.agentSlug;
  if (!agentSlug) return null;
  const provenance = isSupportedTurnProvenanceEnvelope(message.provenance)
    ? message.provenance
    : null;
  const provider =
    provenance?.engine.state === 'observed'
      ? provenance.engine.value.provider
      : undefined;
  const model =
    provenance?.reportedModel.state === 'observed'
      ? provenance.reportedModel.value
      : provenance?.requestedModel.state === 'observed'
        ? provenance.requestedModel.value
        : message.model;
  return {
    turnId: message.turnId,
    agentSlug,
    sessionId: provenance?.sessionId ?? message.sessionId,
    provider,
    model,
  };
}
