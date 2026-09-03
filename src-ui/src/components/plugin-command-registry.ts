import type {
  PluginCommandContribution,
  PluginCommandRequirement,
} from '@kontourai/station-contracts/plugin';

export interface InstalledPluginCommandSource {
  name: string;
  version: string;
  commandContributions?: readonly PluginCommandContribution[];
  commandGeneration?: string;
  commandCapabilities?: {
    invokeDeclaredOperation: {
      available: boolean;
      reason?: string;
    };
  };
}

export interface PluginCommandHostContext {
  activeChatId: string | null;
  hasProject: boolean;
  hasSession: boolean;
  hasTask: boolean;
  surfaceIds: ReadonlySet<string>;
  occupiedCommandIds: ReadonlySet<string>;
  /** False until the audited host invocation adapter is composed. */
  canInvokePluginOperation?: boolean;
}

export interface PluginPaletteCommand {
  paletteId: string;
  pluginName: string;
  pluginVersion: string;
  commandGeneration: string | null;
  contribution: PluginCommandContribution;
  unavailableReason: string | null;
}

const REQUIREMENT_COPY: Record<
  Exclude<PluginCommandRequirement, 'plugin-server'>,
  string
> = {
  'active-chat': 'Open a chat before using this plugin command.',
  project: 'Select a Project before using this plugin command.',
  session: 'Open a Session before using this plugin command.',
  task: 'Open a Task before using this plugin command.',
};

function requirementUnavailableReason(
  requirement: PluginCommandRequirement,
  plugin: InstalledPluginCommandSource,
  context: PluginCommandHostContext,
): string | null {
  if (requirement === 'plugin-server') {
    const capability = plugin.commandCapabilities?.invokeDeclaredOperation;
    return capability?.available
      ? null
      : (capability?.reason ??
          'Plugin operation availability could not be confirmed.');
  }
  const available =
    requirement === 'active-chat'
      ? context.activeChatId !== null
      : requirement === 'project'
        ? context.hasProject
        : requirement === 'session'
          ? context.hasSession
          : context.hasTask;
  return available ? null : REQUIREMENT_COPY[requirement];
}

function commandUnavailableReason(
  plugin: InstalledPluginCommandSource,
  command: PluginCommandContribution,
  context: PluginCommandHostContext,
): string | null {
  if (!plugin.commandGeneration) {
    return 'The current plugin command installation could not be confirmed.';
  }
  for (const requirement of command.requires ?? []) {
    const reason = requirementUnavailableReason(requirement, plugin, context);
    if (reason) return reason;
  }

  if (command.argument) {
    return `This command needs ${command.argument.label}; argument entry is not available in the command palette yet.`;
  }

  switch (command.intent.kind) {
    case 'navigate':
      return context.surfaceIds.has(command.intent.surfaceId)
        ? null
        : `Station does not expose the '${command.intent.surfaceId}' destination.`;
    case 'seed-composer':
      return context.activeChatId
        ? null
        : 'Open a chat before staging this command in the composer.';
    case 'invoke-declared-plugin-operation': {
      const capability = plugin.commandCapabilities?.invokeDeclaredOperation;
      if (!capability?.available) {
        return (
          capability?.reason ??
          'Plugin operation availability could not be confirmed.'
        );
      }
      return context.canInvokePluginOperation
        ? null
        : 'Audited plugin operation invocation is not available in the command palette yet.';
    }
  }
}

/**
 * Deterministic host-owned projection into the canonical palette namespace.
 * Existing host rows and plugin rows all reserve their final ID here; a later
 * duplicate remains visible but unavailable with an exact reason.
 */
export function projectPluginPaletteCommands(
  plugins: readonly InstalledPluginCommandSource[],
  context: PluginCommandHostContext,
): readonly PluginPaletteCommand[] {
  const occupied = new Set(context.occupiedCommandIds);
  const result: PluginPaletteCommand[] = [];
  const ordered = [...plugins].sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const plugin of ordered) {
    for (const contribution of plugin.commandContributions ?? []) {
      const paletteId = `plugin:${contribution.id}`;
      const collision = occupied.has(paletteId);
      result.push({
        paletteId,
        pluginName: plugin.name,
        pluginVersion: plugin.version,
        commandGeneration: plugin.commandGeneration ?? null,
        contribution,
        unavailableReason: collision
          ? `Command id '${paletteId}' is already registered.`
          : commandUnavailableReason(plugin, contribution, context),
      });
      occupied.add(paletteId);
    }
  }
  return Object.freeze(result);
}
