import { useMaterializeEngineAgentMutation } from '@kontourai/station-sdk';
import { useRef, useState } from 'react';
import type { AgentData } from '../../contexts/AgentsContext';
import { userFacingErrorMessage } from '../../utils/errorText';
import {
  findAuthoredAgentForEngineConnection,
  resolveNewChatAgentEnable,
} from '../modals/new-chat-modal-utils';

/**
 * archive#3027: one-click Enable for an engine-default alias row, shared by
 * the dock's New Chat and Home's start composer (Enable needs no page change,
 * so Home runs it in place). Every path either reports the Agent ready
 * (`onReady`) or speaks through `onFeedback` (the archive#3013 invariant);
 * nothing here may fail silently or reject unhandled.
 *
 * The find-or-create itself is the SERVER's: the create half posts the engine
 * id to `/agents/materialize-engine`, the one path boot adoption, ACP connect
 * and first run's batch also take. The local FIND stays: it short-circuits
 * WITHOUT a write and, unlike the server, knows this context's scope.
 */
export function useAgentEnable({
  scopedAgents,
  selectedProjectSlug,
  isCurrent,
  onFeedback,
  onReady,
  refreshSetup,
}: {
  /** The scope-filtered set the view model derives from, never raw agents. */
  scopedAgents: AgentData[];
  selectedProjectSlug: string | undefined;
  /** False once the request that asked has gone (closed, other authority). */
  isCurrent: () => boolean;
  onFeedback: (text: string | null) => void;
  /** `created` is true when this call wrote a new Agent. */
  onReady: (agent: AgentData, created: boolean) => void;
  refreshSetup?: () => Promise<unknown>;
}) {
  const materializeEngineAgent = useMaterializeEngineAgentMutation();
  // One create at a time. The ref is the guard (two activations in one frame
  // both read pre-render state); the state disables the visible button.
  const inFlightRef = useRef(false);
  const [inFlight, setInFlight] = useState(false);

  const enable = async (agent: AgentData) => {
    const target = resolveNewChatAgentEnable(agent);
    if (!target) return;
    if (inFlightRef.current) return;
    // FIND over the scope-filtered set: an out-of-scope authored Agent must
    // not be silently selected into this context (archive#3027).
    const existing = findAuthoredAgentForEngineConnection(
      scopedAgents,
      target.engineConnectionId,
    );
    if (existing) {
      onReady(existing, false);
      return;
    }
    const engineLabel = agent.engineDisplayName ?? agent.name;
    inFlightRef.current = true;
    setInFlight(true);
    onFeedback(`Setting up ${engineLabel}…`);
    try {
      // Selection keys off the RESPONSE (the full spec), not the agents
      // list: the enriched catalog activates deferred and may lag.
      const { data, warnings } = await materializeEngineAgent.mutateAsync(
        target.engineConnectionId,
      );
      if (!isCurrent()) return;
      if (warnings?.length) {
        onFeedback(warnings.join(' '));
        if (refreshSetup) await refreshSetup();
        return;
      }
      const materialized = data as AgentData;
      // The server's find-or-create is scope-blind by design. An Agent owned
      // by a DIFFERENT project would be smuggled into this context; say so.
      if (
        materialized.project !== undefined &&
        materialized.project !== selectedProjectSlug
      ) {
        onFeedback(
          `${materialized.name} is owned by project “${materialized.project}”. Open that project to chat with it.`,
        );
        return;
      }
      onFeedback(null);
      onReady(materialized, true);
    } catch (error) {
      onFeedback(
        `Could not enable ${engineLabel}: ${
          error instanceof Error ? userFacingErrorMessage(error) : String(error)
        }`,
      );
    } finally {
      inFlightRef.current = false;
      setInFlight(false);
    }
  };

  return { enable, inFlight };
}
