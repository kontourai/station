import type { PluginCommandContribution } from '@kontourai/station-contracts/agent-plugin';
import { describe, expect, test } from 'vitest';
import {
  type InstalledPluginCommandSource,
  projectPluginPaletteCommands,
} from '../plugin-command-registry';

const navigate: PluginCommandContribution = {
  version: '1.0',
  id: 'demo.open-plugins',
  title: 'Open plugins',
  intent: { kind: 'navigate', surfaceId: 'plugins' },
};

function plugin(
  command: PluginCommandContribution = navigate,
): InstalledPluginCommandSource {
  return {
    name: 'demo',
    version: '2.0.0',
    commandGeneration: 'a'.repeat(64),
    commandContributions: [command],
    commandCapabilities: {
      invokeDeclaredOperation: { available: true },
    },
  };
}

function context(
  overrides: Partial<Parameters<typeof projectPluginPaletteCommands>[1]> = {},
) {
  return {
    activeChatId: 'session-1',
    hasProject: true,
    hasSession: true,
    hasTask: true,
    occupiedCommandIds: new Set<string>(),
    surfaceIds: new Set(['plugins']),
    ...overrides,
  };
}

describe('plugin command registry', () => {
  test('projects a manifest-only command into the canonical palette identity', () => {
    expect(projectPluginPaletteCommands([plugin()], context())).toEqual([
      expect.objectContaining({
        paletteId: 'plugin:demo.open-plugins',
        pluginName: 'demo',
        pluginVersion: '2.0.0',
        commandGeneration: 'a'.repeat(64),
        unavailableReason: null,
      }),
    ]);
  });

  test('keeps a command unavailable when its installed generation is absent', () => {
    const [row] = projectPluginPaletteCommands(
      [{ ...plugin(), commandGeneration: undefined }],
      context(),
    );
    expect(row.unavailableReason).toBe(
      'The current plugin command installation could not be confirmed.',
    );
  });

  test('keeps a collision visible but unavailable instead of replacing its owner', () => {
    const [row] = projectPluginPaletteCommands(
      [plugin()],
      context({
        occupiedCommandIds: new Set(['plugin:demo.open-plugins']),
      }),
    );
    expect(row.unavailableReason).toBe(
      "Command id 'plugin:demo.open-plugins' is already registered.",
    );
  });

  test.each([
    ['active-chat', { activeChatId: null }],
    ['project', { hasProject: false }],
    ['session', { hasSession: false }],
    ['task', { hasTask: false }],
  ] as const)(
    'derives the unavailable state for a missing %s capability',
    (requirement, unavailable) => {
      const command = {
        ...navigate,
        requires: [requirement],
      } satisfies PluginCommandContribution;
      const [row] = projectPluginPaletteCommands(
        [plugin(command)],
        context(unavailable),
      );
      expect(row.unavailableReason).toBeTruthy();
    },
  );

  test('refuses an unknown host destination without interpreting it as a route', () => {
    const [row] = projectPluginPaletteCommands(
      [plugin()],
      context({ surfaceIds: new Set() }),
    );
    expect(row.unavailableReason).toBe(
      "Station does not expose the 'plugins' destination.",
    );
  });

  test('keeps argument and plugin-operation commands unavailable until their host adapters exist', () => {
    const argumentCommand: PluginCommandContribution = {
      version: '1.0',
      id: 'demo.search',
      title: 'Search',
      argument: { kind: 'text', label: 'a search term' },
      intent: {
        kind: 'seed-composer',
        text: 'Search for',
        argumentMode: 'append',
      },
    };
    const operationCommand: PluginCommandContribution = {
      version: '1.0',
      id: 'demo.refresh',
      title: 'Refresh',
      intent: {
        kind: 'invoke-declared-plugin-operation',
        operationId: 'refresh',
      },
    };
    const rows = projectPluginPaletteCommands(
      [
        {
          ...plugin(argumentCommand),
          commandContributions: [argumentCommand, operationCommand],
        },
      ],
      context(),
    );
    expect(rows.map((row) => row.unavailableReason)).toEqual([
      'This command needs a search term; argument entry is not available in the command palette yet.',
      'Audited plugin operation invocation is not available in the command palette yet.',
    ]);
  });
});
