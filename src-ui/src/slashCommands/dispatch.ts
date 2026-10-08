import type { Skill } from '@kontourai/station-contracts/catalog';
import type { AgentMcpPromptListing } from '@kontourai/station-contracts/mcp-prompts';
import type { useRunSkill, useSkillDetailReader } from '@kontourai/station-sdk';
import { agentMcpPromptsQueryKey } from '@kontourai/station-sdk';
import type { QueryClient } from '@tanstack/react-query';
import type { useActiveChatActions } from '../contexts/ActiveChatsContext';
import type { useAgents } from '../contexts/AgentsContext';
import type { ChatUIState } from '../contexts/active-chats-state';
import type { BindingStatus } from '../utils/execution';
import { findMatchingSkillCommand } from '../utils/skill-command-catalog';
import {
  assignSkillVariableArgs,
  parseShellWords,
  substituteSkillVariables,
} from '../utils/skill-commands';
import { loadSlashCommands } from './load';
import { getAllCommands, getCommand } from './registry';

export type SlashCommandContext = {
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
};

interface DispatchDependencies {
  apiBase: string;
  chatState: ChatUIState;
  agents: ReturnType<typeof useAgents>;
  updateChat: ReturnType<typeof useActiveChatActions>['updateChat'];
  addEphemeralMessage: ReturnType<
    typeof useActiveChatActions
  >['addEphemeralMessage'];
  queryClient: QueryClient;
  runSkillMutation: ReturnType<typeof useRunSkill>;
  readSkillDetail: ReturnType<typeof useSkillDetailReader>;
}

export async function dispatchSlashCommand(
  sessionId: string,
  command: string,
  context: SlashCommandContext,
  dependencies: DispatchDependencies,
) {
  const {
    apiBase,
    chatState,
    agents,
    updateChat,
    addEphemeralMessage,
    queryClient,
    runSkillMutation,
    readSkillDetail,
  } = dependencies;
  const cleanup = () => {
    updateChat(sessionId, { input: '' });
    context.autocomplete.closeAll();
  };
  const agent = agents.find((a) => a.slug === chatState.agentSlug);
  if (agent?.engineConnectionType === 'acp') {
    cleanup();
    return command;
  }

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
    const argAssignment = assignSkillVariableArgs(skill.variables ?? [], args);
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

  // 2b. #3284: an MCP server prompt (`/<server>:<prompt>`). Arguments
  // use the same `name=value` / positional parser as skill variables,
  // the server reads the prompt, and its text is sent as this turn. A
  // missing required argument or a refused read sends nothing.
  const promptListing = chatState.agentSlug
    ? queryClient.getQueryData<AgentMcpPromptListing>(
        agentMcpPromptsQueryKey(chatState.agentSlug),
      )
    : undefined;
  const prompt = promptListing?.prompts.find(
    (candidate) => candidate.command.toLowerCase() === cmd,
  );
  if (prompt && chatState.agentSlug) {
    const { runMcpPromptCommand } = await import('../slashCommands/mcpPrompt');
    const outcome = await runMcpPromptCommand(
      chatState.agentSlug,
      prompt,
      args,
    );
    if ('refusal' in outcome)
      addEphemeralMessage(sessionId, {
        role: 'system',
        content: outcome.refusal,
      });
    cleanup();
    return 'text' in outcome ? outcome.text : true;
  }

  // 3. Check registered commands
  try {
    await loadSlashCommands();
  } catch (error) {
    addEphemeralMessage(sessionId, {
      role: 'system',
      content: `Could not load Station's built-in commands, so ${command} was not sent. Try again. (${error instanceof Error ? error.message : 'unknown error'})`,
    });
    cleanup();
    return true;
  }
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
}
