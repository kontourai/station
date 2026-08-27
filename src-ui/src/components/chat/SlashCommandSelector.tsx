import { useMemo } from 'react';
import type { SlashCommand } from '../../hooks/useSlashCommands';
import { AutocompleteSelector } from '../AutocompleteSelector';

interface SlashCommandSelectorProps {
  query: string;
  commands: SlashCommand[];
  onSelect: (command: SlashCommand) => void;
  onClose: () => void;
  maxHeight?: string;
}

export function SlashCommandSelector({
  query,
  commands,
  onSelect,
  onClose,
  maxHeight,
}: SlashCommandSelectorProps) {
  // Filter and map commands to AutocompleteItem format
  const items = useMemo(() => {
    const searchTerm = query.toLowerCase();

    const filtered = commands.filter((c) => {
      const matchesCmd = c.cmd.slice(1).toLowerCase().includes(searchTerm);
      const matchesAlias = c.aliases?.some((a) =>
        a.slice(1).toLowerCase().includes(searchTerm),
      );
      const matchesCustom = c.isCustom && searchTerm === 'custom';
      return matchesCmd || matchesAlias || matchesCustom;
    });

    return filtered.map((cmd) => ({
      id: cmd.cmd,
      title: `${cmd.cmd}${cmd.aliases && cmd.aliases.length > 0 ? ` (${cmd.aliases.join(', ')})` : ''}`,
      description: cmd.description,
      badge:
        cmd.source === 'acp'
          ? 'Engine'
          : cmd.source === 'custom'
            ? 'Custom'
            : cmd.source === 'skill'
              ? 'Skill'
              : cmd.source === 'builtin'
                ? 'Platform'
                : undefined,
      metadata: cmd,
    }));
  }, [query, commands]);

  return (
    <AutocompleteSelector
      items={items}
      onSelect={(item) => onSelect(item.metadata)}
      onClose={onClose}
      emptyMessage="No commands found"
      maxHeight={maxHeight}
    />
  );
}
