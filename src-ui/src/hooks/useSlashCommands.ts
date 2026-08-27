import type { Skill } from '@kontourai/station-contracts/catalog';
import { resolveSkillCommandName } from '@kontourai/station-contracts/skill-command';
import {
  useProviderCommandsQuery,
  useSkillsQuery,
} from '@kontourai/station-sdk';
import { useCallback, useMemo } from 'react';
import { useAgents } from '../contexts/AgentsContext';
import type { ChatUIState } from '../contexts/active-chats-state';
import type { BindingStatus } from '../utils/execution';
import {
  agentCommandSkills,
  declaredSkillCommandWord,
} from '../utils/skill-commands';

export interface SlashCommand {
  cmd: string;
  description: string;
  aliases?: string[];
  isCustom?: boolean;
  /** A `skill` row is a skill that declared itself runnable as a command. */
  source?: 'builtin' | 'custom' | 'acp' | 'skill';
  handler?: (args: string[]) => void | Promise<void>;
  currentModel?: string;
}

export type SlashCommandAvailability =
  | { available: true }
  | { available: false; reason: string };

export interface CatalogSlashCommand extends SlashCommand {
  availability: SlashCommandAvailability;
}

type CommandSourceGroup = {
  source: NonNullable<SlashCommand['source']>;
  commands: SlashCommand[];
  gate?: { available: boolean; reason: string };
};

const CAPABILITY_LABELS = {
  mcp: 'MCP capability',
  tool_execution: 'tool execution capability',
  model_selection: 'model selection capability',
} as const;

export function mergeSlashCommandSources(
  groups: CommandSourceGroup[],
  includeUnavailable = false,
): CatalogSlashCommand[] {
  return groups.flatMap((group) => {
    const availability: SlashCommandAvailability =
      group.gate?.available === false
        ? { available: false, reason: group.gate.reason }
        : { available: true };
    if (!availability.available && !includeUnavailable) return [];
    return group.commands.map((command) => ({
      ...command,
      source: group.source,
      availability,
    }));
  });
}

function getModelDisplayName(modelId: string): string {
  if (modelId.includes('claude-3-7-sonnet')) return 'Claude 3.7 Sonnet';
  if (modelId.includes('claude-3-5-sonnet-20241022'))
    return 'Claude 3.5 Sonnet v2';
  if (modelId.includes('claude-3-5-sonnet')) return 'Claude 3.5 Sonnet';
  if (modelId.includes('claude-3-opus')) return 'Claude 3 Opus';
  if (modelId.includes('claude-3-haiku')) return 'Claude 3 Haiku';
  return modelId;
}

export function useSlashCommands(
  agentSlug: string | null,
  // Only `.model` is read below — accept any object shaped like a slice of
  // ChatUIState (the selector-narrowed composer state from useChatInput
  // satisfies this structurally without widening back to the full session).
  chatState?: Pick<ChatUIState, 'model'> | null,
  bindingStatus?: BindingStatus,
) {
  const agents = useAgents();
  const { data: skills } = useSkillsQuery();

  const currentAgent = agentSlug
    ? agents.find((a) => a.slug === agentSlug)
    : null;
  const isAcp = currentAgent?.engineConnectionType === 'acp';
  const { data: acpCommandData = [] } = useProviderCommandsQuery('acp', {
    enabled: isAcp,
  });

  const acpCommands = useMemo(
    () =>
      acpCommandData.map((command) => ({
        cmd: command.name.startsWith('/') ? command.name : `/${command.name}`,
        description:
          command.description || command.argumentHint || 'Engine command',
        isCustom: true,
        source: 'acp' as const,
      })),
    [acpCommandData],
  );

  const catalog = useMemo(() => {
    const currentModelId = chatState?.model || currentAgent?.model || '';
    const modelDisplayName = getModelDisplayName(currentModelId);
    const modelSource = chatState?.model
      ? chatState.model !== currentAgent?.model
        ? 'session override'
        : 'agent default'
      : currentAgent?.model
        ? 'agent default'
        : 'runtime not reported';
    const support = bindingStatus?.capabilityState ?? {
      system_prompt: true,
      mcp: false,
      tool_execution: false,
      model_catalog: false,
      model_selection: false,
    };

    const builtinCore: SlashCommand[] = [
      {
        cmd: '/commands',
        aliases: ['/prompts'],
        description: 'List the commands available in this chat',
      },
      {
        cmd: '/clear',
        aliases: ['/new'],
        description: 'Clear conversation and start fresh',
      },
      { cmd: '/stats', description: 'Show conversation statistics' },
      {
        cmd: '/help',
        description: 'List available commands in the transcript',
      },
      {
        cmd: '/resume',
        aliases: ['/chat'],
        description: 'Open a new or existing conversation',
      },
    ];

    const builtinMcp: SlashCommand[] = [
      {
        cmd: '/mcp',
        description: 'List MCP servers for this agent',
      },
    ];
    const builtinTools: SlashCommand[] = [
      {
        cmd: '/tools',
        description: 'Show available tools and auto-approved list',
      },
    ];
    const builtinModel: SlashCommand[] = [
      {
        cmd: '/model',
        description: `Select session model (${modelDisplayName || 'Model not reported'} · ${modelSource})`,
        currentModel: modelDisplayName || 'Model not reported',
      },
    ];

    // A command is a SKILL that declared itself runnable, and an agent is
    // offered it either because the skill is global or because the agent
    // attached it (`agent.skills`) — the binding the editor writes. The
    // derivation this replaces read the authored record's own fields and never
    // the agent's, so attaching one to an agent changed nothing (CAT-R08).
    const skillCommands: SlashCommand[] = agentCommandSkills(
      skills,
      currentAgent,
    ).map((skill) => ({
      cmd: `/${resolveSkillCommandName(skill)}`,
      description: skill.description || skill.name,
      source: 'skill' as const,
    }));

    // A declaration that is not in EFFECT — a clash loser the server
    // disabled, a word nobody can type — stays visible in the catalog with
    // the server's own diagnostic as its reason, so Commands can say why
    // `/ship` is not this workspace's to type instead of the row silently
    // disappearing. Each is its own group: the diagnostic is per skill, and
    // a group's gate is the one availability story its rows share.
    const allSkills: Skill[] = skills ?? [];
    const disabledSkillGroups: CommandSourceGroup[] = allSkills
      .filter(
        (skill) =>
          skill.command &&
          !skill.command.enabled &&
          skill.commandDiagnostic &&
          declaredSkillCommandWord(skill),
      )
      .map((skill) => ({
        source: 'skill' as const,
        commands: [
          {
            cmd: `/${declaredSkillCommandWord(skill)}`,
            description: skill.description || skill.name,
            source: 'skill' as const,
          },
        ],
        gate: {
          available: false,
          reason: skill.commandDiagnostic as string,
        },
      }));

    const customCommands = currentAgent?.commands
      ? Object.values(currentAgent.commands).map((cmd: any) => ({
          cmd: `/${cmd.name}`,
          description: cmd.description || 'Custom command',
          isCustom: true,
          source: 'custom' as const,
        }))
      : [];

    if (isAcp) {
      return mergeSlashCommandSources(
        [{ source: 'acp', commands: acpCommands }],
        true,
      );
    }

    const groups: CommandSourceGroup[] = [
      {
        source: 'builtin',
        commands: builtinMcp,
        gate: {
          available: support.mcp,
          reason: `Requires ${CAPABILITY_LABELS.mcp}`,
        },
      },
      {
        source: 'builtin',
        commands: builtinTools,
        gate: {
          available: support.tool_execution,
          reason: `Requires ${CAPABILITY_LABELS.tool_execution}`,
        },
      },
      {
        source: 'builtin',
        commands: builtinModel,
        gate: {
          available: support.model_selection,
          reason: `Requires ${CAPABILITY_LABELS.model_selection}`,
        },
      },
      { source: 'builtin', commands: builtinCore },
      {
        source: 'custom',
        commands: agentSlug && currentAgent ? customCommands : [],
      },
      { source: 'skill', commands: skillCommands },
      ...disabledSkillGroups,
    ];
    return mergeSlashCommandSources(groups, true);
  }, [
    agentSlug,
    acpCommands,
    currentAgent,
    isAcp,
    skills,
    bindingStatus,
    chatState?.model,
  ]);

  const commands = useMemo(
    () => catalog.filter((command) => command.availability.available),
    [catalog],
  );

  // Per-keystroke ACP argument autocomplete has no equivalent on
  // ProviderAdapterShape (no getCommandOptions()-style method) after the
  // #149 orchestration-path cutover — accepted gap, filed as a follow-up
  // (see docs/guides/acp.md "Slash Commands"). Returning an empty list
  // here keeps the static command list (acpCommands, above) as the only
  // ACP command surface.
  const fetchCommandOptions = useCallback(
    async (_partial: string): Promise<SlashCommand[]> => {
      return [];
    },
    [],
  );

  return { commands, catalog, fetchCommandOptions };
}
