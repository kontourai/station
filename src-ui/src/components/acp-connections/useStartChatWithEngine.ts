import {
  useMaterializeEngineAgentMutation,
  useModelPickerCatalogQuery,
} from '@kontourai/station-sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useAgents } from '../../contexts/AgentsContext';
import { dispatchNewChatIntent } from '../../lib/newChatIntent';
import { userFacingErrorMessage } from '../../utils/errorText';
import { useDockProject } from '../../workspace-panes/useDockProject';
import { GLOBAL_CONTEXT } from '../modals/new-chat-modal-utils';

/** How long to wait for a just-made Agent to reach the Agent list. */
export const START_CHAT_AGENT_WAIT_MS = 15_000;

interface PendingStart {
  slug: string;
  connectionId: string;
  context: string;
  engineName: string;
}

/**
 * "Start a chat with <engine>" after a setup lands on Ready. The engine's
 * Agent comes from the one find-or-create path (`/agents/materialize-engine`,
 * the same one New chat's Enable posts), so an engine whose connect already
 * made its Agent gets that Agent back, never a second one. The chat opens in
 * Agent's Project when it owns one, otherwise the dock's current Project
 * or no Project; the person still sends the first message.
 *
 * New chat only selects an Agent its list holds, and a new Agent activates
 * after the write answers, so the request waits (bounded) until the list has
 * it rather than opening New chat on "no longer available".
 */
export function useStartChatWithEngine() {
  const materialize = useMaterializeEngineAgentMutation();
  const queryClient = useQueryClient();
  const agents = useAgents();
  // New chat lists an Agent only once both its own row and its engine's
  // connection are in these two reads; it does not wait for either.
  const { data: pickerCatalog } = useModelPickerCatalogQuery() as {
    data?: { agentConnections?: Array<{ id: string }> };
  };
  const pickerConnections = pickerCatalog?.agentConnections;
  const { projectSlug } = useDockProject();
  const [pending, setPending] = useState(false);
  const [waiting, setWaiting] = useState<PendingStart | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!waiting) return;
    if (!agents.some((agent) => agent.slug === waiting.slug)) return;
    if (
      !pickerConnections?.some(
        (connection) => connection.id === waiting.connectionId,
      )
    )
      return;
    setWaiting(null);
    setPending(false);
    // After this commit, not inside it: the dock re-registers its listener
    // in the same effect pass when the Agent list changes, so a dispatch
    // from here could land while no dock is listening.
    // Not cleared on re-render: clearing `waiting` below re-runs this effect.
    setTimeout(() => {
      const claimed = dispatchNewChatIntent({
        selection: { context: waiting.context, agentSlug: waiting.slug },
      });
      if (!claimed)
        setNotice(`Open Chat to start a chat with ${waiting.engineName}.`);
    }, 0);
  }, [agents, pickerConnections, waiting]);

  useEffect(() => {
    if (!waiting) return;
    // Re-read both while waiting: a read right after the write can still
    // predate the Agent's activation.
    const refresh = setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      void queryClient.invalidateQueries({
        queryKey: ['model-picker-catalog'],
      });
    }, 1_500);
    const timer = setTimeout(() => {
      setWaiting(null);
      setPending(false);
      setNotice(
        `${waiting.engineName}'s Agent is still starting. Try again in a moment.`,
      );
    }, START_CHAT_AGENT_WAIT_MS);
    return () => {
      clearInterval(refresh);
      clearTimeout(timer);
    };
  }, [waiting, queryClient]);

  const start = async (connectionId: string, engineName: string) => {
    if (pending) return;
    setPending(true);
    setNotice(null);
    try {
      const { data } = await materialize.mutateAsync(connectionId);
      const agent = data as { slug?: string; project?: string };
      if (!agent.slug) throw new Error('Station did not name its Agent.');
      setWaiting({
        slug: agent.slug,
        connectionId,
        // An Agent owned by a Project only runs in it.
        context: agent.project ?? projectSlug ?? GLOBAL_CONTEXT,
        engineName,
      });
    } catch (error) {
      setPending(false);
      setNotice(
        `Could not start a chat with ${engineName}: ${
          error instanceof Error ? userFacingErrorMessage(error) : String(error)
        }`,
      );
    }
  };

  return { start, pending, notice };
}
