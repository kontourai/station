import { useRunSkill, useSkillDetailReader } from '@kontourai/station-sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect } from 'react';
import {
  activeChatsStore,
  useActiveChatActions,
} from '../contexts/ActiveChatsContext';
import { useAgents } from '../contexts/AgentsContext';
import { useApiBase } from '../contexts/ApiBaseContext';
import type { SlashCommandContext } from '../slashCommands/dispatch';
import { loadSlashCommands } from '../slashCommands/load';

export function useSlashCommandHandler() {
  const { apiBase } = useApiBase();
  const { updateChat, addEphemeralMessage } = useActiveChatActions();
  const agents = useAgents();
  const queryClient = useQueryClient();
  const runSkillMutation = useRunSkill();
  const readSkillDetail = useSkillDetailReader();

  // Warm the built-in commands once a chat input exists. Dispatch still
  // awaits their load; custom commands and skills do not depend on it.
  useEffect(() => {
    loadSlashCommands().catch(() => undefined);
  }, []);

  return useCallback(
    async (
      sessionId: string,
      command: string,
      context: SlashCommandContext,
    ) => {
      const chatState = activeChatsStore.getSnapshot()[sessionId];
      if (!chatState) return false;
      const agent = agents.find((item) => item.slug === chatState.agentSlug);
      if (agent?.engineConnectionType === 'acp') {
        updateChat(sessionId, { input: '' });
        context.autocomplete.closeAll();
        return command;
      }
      try {
        const { dispatchSlashCommand } = await import(
          '../slashCommands/dispatch'
        );
        return dispatchSlashCommand(sessionId, command, context, {
          apiBase,
          chatState,
          agents,
          updateChat,
          addEphemeralMessage,
          queryClient,
          runSkillMutation,
          readSkillDetail,
        });
      } catch (error) {
        addEphemeralMessage(sessionId, {
          role: 'system',
          content: `Could not load Station's commands, so ${command} was not sent. Try again. (${error instanceof Error ? error.message : 'unknown error'})`,
        });
        updateChat(sessionId, { input: '' });
        context.autocomplete.closeAll();
        return true;
      }
    },
    [
      apiBase,
      agents,
      updateChat,
      addEphemeralMessage,
      queryClient,
      runSkillMutation,
      readSkillDetail,
    ],
  );
}
