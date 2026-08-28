import type { Skill } from '@kontourai/station-contracts/catalog';
import { useRunSkill, useSkillDetailReader } from '@kontourai/station-sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import {
  activeChatsStore,
  useActiveChatActions,
} from '../contexts/ActiveChatsContext';
import { useAgents } from '../contexts/AgentsContext';
import { useApiBase } from '../contexts/ApiBaseContext';
import { getAllCommands, getCommand } from '../slashCommands/registry';
import '../slashCommands/builtins';
import '../slashCommands/tools';
import type { BindingStatus } from '../utils/execution';
import {
  assignSkillVariableArgs,
  findMatchingSkillCommand,
  parseShellWords,
  substituteSkillVariables,
} from '../utils/skill-commands';

export function useSlashCommandHandler() {
  const { apiBase } = useApiBase();
  const { updateChat, addEphemeralMessage } = useActiveChatActions();
  const agents = useAgents();
  const queryClient = useQueryClient();
  const runSkillMutation = useRunSkill();
  const readSkillDetail = useSkillDetailReader();

  return useCallback(
    async (
      sessionId: string,
      command: string,
      context: {
        onInputCleared?: () => void;
        availableModels?: Array<{
          id: string;
          name: string;
          originalId?: string;
        }>;
        bindingStatus?: BindingStatus;
        autocomplete: {
          openModel: () => void;
          openNewChat: () => void;
          closeCommand: () => void;
          closeAll: () => void;
        };
      },
    ) => {
      const chatState = activeChatsStore.getSnapshot()[sessionId];
      if (!chatState) return false;

      // ONE shell-style parse of the whole line (a whitespace
      // split broke quoted values). The command word is readable even when a
      // later quote never closes, so the ACP passthrough and the parse-error
      // bail can both name the command the user typed.
      const parsed = parseShellWords(command.slice(1).trim());
      const words = parsed.ok ? parsed.words : [];
      const cmd = (
        words[0] ??
        command.slice(1).trim().split(/\s+/)[0] ??
        ''
      ).toLowerCase();
      const args = words.slice(1);

      const agent = agents.find((a) => a.slug === chatState.agentSlug);

      // Default cleanup: clear input and close autocomplete
      const cleanup = () => {
        updateChat(sessionId, { input: '' });
        context.autocomplete.closeAll();
      };

      // ACP agents: pass all slash commands through as prompt text to kiro-cli
      if (agent?.engineConnectionType === 'acp') {
        cleanup();
        return command; // Return the command text to be sent as a message
      }

      // A line the parser cannot read is never dispatched anywhere — not to
      // a skill, a builtin, or the model — the user reads why instead.
      if (!parsed.ok) {
        addEphemeralMessage(sessionId, {
          role: 'system',
          content: `Could not read ${command}: ${parsed.error}`,
        });
        cleanup();
        return true;
      }

      // 1. Check custom commands (send as message)
      if (agent?.commands?.[cmd]) {
        let expandedPrompt = agent.commands[cmd].prompt;
        const params = agent.commands[cmd].params || [];

        params.forEach((param: any, idx: number) => {
          const value = args[idx] || param.default || '';
          const escaped = param.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          expandedPrompt = expandedPrompt.replace(
            new RegExp(`{{${escaped}}}`, 'g'),
            value,
          );
        });

        cleanup();
        return expandedPrompt;
      }

      // 2. Check command skills
      const cached = queryClient.getQueryData<Skill[]>(['skills', 'local']);
      const match = findMatchingSkillCommand(cached, cmd, agent);
      if (match) {
        // The listing carries no bodies, so the text is read here — through
        // the same cache entry the editor fills, so a second `/command` in
        // the session costs nothing. A failed read must not send the raw
        // `/command` to the model as if it were a message.
        let skill: Skill;
        try {
          skill = await readSkillDetail(match.name);
        } catch (error) {
          addEphemeralMessage(sessionId, {
            role: 'system',
            content: `Could not read /${cmd}: ${error instanceof Error ? error.message : 'unknown error'}`,
          });
          cleanup();
          return true;
        }
        // Variable substitution is the SAME derivation the Test modal runs
        // (`substituteSkillVariables`), fed by the ONE arg parser
        // (`assignSkillVariableArgs`): `name=value` words assign
        // by name — so an earlier variable can keep its default while a later
        // required one is supplied — and the remaining words fill the
        // unnamed variables in declaration order. A variable left with
        // neither a value nor a usable default is REJECTED — named in an
        // error the user reads, never silently substituted with an empty
        // string.
        const argAssignment = assignSkillVariableArgs(
          skill.variables ?? [],
          args,
        );
        if (!argAssignment.ok) {
          addEphemeralMessage(sessionId, {
            role: 'system',
            content: `/${cmd}: ${argAssignment.error} — nothing was sent`,
          });
          cleanup();
          return true;
        }
        const substitution = substituteSkillVariables(
          skill.body ?? '',
          skill.variables ?? [],
          argAssignment.provided,
        );
        if (!substitution.ok) {
          addEphemeralMessage(sessionId, {
            role: 'system',
            content: `/${cmd} needs a value for ${substitution.missing.map((name) => `{{${name}}}`).join(', ')} — nothing was sent`,
          });
          cleanup();
          return true;
        }
        void runSkillMutation.mutateAsync(match.name).catch(() => undefined);
        cleanup();
        return substitution.content;
      }

      // 3. Check registered commands
      const handler = getCommand(cmd);
      if (handler) {
        cleanup();

        await handler({
          sessionId,
          chatState,
          agent,
          args,
          apiBase,
          availableModels: context.availableModels,
          bindingStatus: context.bindingStatus,
          updateChat,
          addEphemeralMessage,
          queryClient,
          sendMessage: async () => {},
          autocomplete: context.autocomplete,
        });

        return true;
      }

      // 4. CLI runtime passthrough — forward unrecognized commands to the SDK
      if (chatState.provider === 'claude' || chatState.provider === 'codex') {
        cleanup();
        return command; // Raw text forwarded to sendOrchestrationTurn
      }

      // 5. Unknown command
      const availableCommands = getAllCommands();
      addEphemeralMessage(sessionId, {
        role: 'system',
        content: `Unknown command: ${command}\n\nAvailable:\n${availableCommands.map((c) => `• /${c}`).join('\n')}`,
      });
      cleanup();
      return true;
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
