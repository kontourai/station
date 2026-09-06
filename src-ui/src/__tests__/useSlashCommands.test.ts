/**
 * @vitest-environment jsdom
 */

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useProviderCommandsQueryMock = vi.fn();
let skills: any[] = [];
let agents: any[] = [];

vi.mock('@kontourai/station-sdk', () => ({
  useSkillsQuery: () => ({ data: skills }),
  useProviderCommandsQuery: (...args: unknown[]) =>
    useProviderCommandsQueryMock(...args),
}));

vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => agents,
}));

import { useSlashCommands } from '../hooks/useSlashCommands';

describe('useSlashCommands — ACP command source (#149 orchestration cutover)', () => {
  beforeEach(() => {
    useProviderCommandsQueryMock.mockReset();
    skills = [];
    agents = [
      {
        slug: 'kiro',
        source: 'acp',
        engineConnectionType: 'acp',
        name: 'Kiro',
        model: 'default',
      },
    ];
  });

  it("reads the ACP command list from the orchestration provider-commands query ('acp'), not a per-agent ACP query", () => {
    useProviderCommandsQueryMock.mockReturnValue({
      data: [
        { name: 'plan', description: 'Show the plan', passthrough: false },
      ],
    });

    const { result } = renderHook(() => useSlashCommands('kiro'));

    expect(useProviderCommandsQueryMock).toHaveBeenCalledWith(
      'acp',
      expect.objectContaining({ enabled: true }),
    );
    expect(result.current.commands).toEqual([
      {
        cmd: '/plan',
        description: 'Show the plan',
        isCustom: true,
        source: 'acp',
        availability: { available: true },
      },
    ]);
  });

  it('keeps gated builtins in catalog with the named capability while excluding them from composer commands', () => {
    useProviderCommandsQueryMock.mockReturnValue({ data: [] });
    agents = [];

    const { result } = renderHook(() =>
      useSlashCommands(null, null, {
        bindingReadiness: 'ready',
        catalogSource: 'none',
        catalogReason: null,
        visibleModels: [],
        capabilityState: {
          system_prompt: true,
          mcp: false,
          tool_execution: false,
          model_catalog: false,
          model_selection: false,
        },
      }),
    );

    expect(result.current.commands.map((command) => command.cmd)).not.toContain(
      '/mcp',
    );
    expect(
      result.current.catalog.find((command) => command.cmd === '/mcp'),
    ).toMatchObject({
      source: 'builtin',
      availability: {
        available: false,
        reason: 'Requires MCP capability',
      },
    });
  });

  it('does not enable the provider-commands query for non-ACP agents', () => {
    useProviderCommandsQueryMock.mockReturnValue({ data: [] });

    renderHook(() => useSlashCommands('some-other-agent'));

    expect(useProviderCommandsQueryMock).toHaveBeenCalledWith(
      'acp',
      expect.objectContaining({ enabled: false }),
    );
  });

  it('resolves per-keystroke ACP argument autocomplete to an empty list (accepted gap post-#149 — no getCommandOptions on ProviderAdapterShape)', async () => {
    useProviderCommandsQueryMock.mockReturnValue({ data: [] });

    const { result } = renderHook(() => useSlashCommands('kiro'));

    await expect(result.current.fetchCommandOptions('/pl')).resolves.toEqual(
      [],
    );
  });

  // CAT-: the derivation this replaces read the authored record's own
  // `agent` field and never the agent's own binding list, so attaching a
  // record to an agent saved a setting that changed nothing. The binding the
  // editor writes (`agent.skills`) is now the binding the catalog reads.
  describe('command skills', () => {
    beforeEach(() => {
      useProviderCommandsQueryMock.mockReturnValue({ data: [] });
    });

    it('offers a global command skill to an agent that has not attached it', () => {
      agents = [{ slug: 'station', name: 'Station', skills: [] }];
      skills = [
        {
          name: 'release-check',
          description: 'Ship it',
          command: { enabled: true, global: true },
        },
      ];

      const { result } = renderHook(() => useSlashCommands('station'));

      expect(
        result.current.catalog.find(
          (command) => command.cmd === '/release-check',
        ),
      ).toMatchObject({
        description: 'Ship it',
        source: 'skill',
        availability: { available: true },
      });
    });

    it('offers a non-global command skill only to the agents that attached it', () => {
      agents = [
        { slug: 'station', name: 'Station', skills: ['release-check'] },
        { slug: 'other', name: 'Other', skills: [] },
      ];
      skills = [
        { name: 'release-check', command: { enabled: true, global: false } },
      ];

      const attached = renderHook(() => useSlashCommands('station'));
      expect(
        attached.result.current.catalog.map((command) => command.cmd),
      ).toContain('/release-check');

      const unattached = renderHook(() => useSlashCommands('other'));
      expect(
        unattached.result.current.catalog.map((command) => command.cmd),
      ).not.toContain('/release-check');
    });

    it('does not offer a skill that is not command-enabled', () => {
      agents = [{ slug: 'station', name: 'Station', skills: ['plain-skill'] }];
      skills = [{ name: 'plain-skill', description: 'Just a skill' }];

      const { result } = renderHook(() => useSlashCommands('station'));

      expect(
        result.current.catalog.map((command) => command.cmd),
      ).not.toContain('/plain-skill');
    });

    it('uses the declared command word, not the skill name slug', () => {
      agents = [{ slug: 'station', name: 'Station', skills: [] }];
      skills = [
        {
          name: 'release-check',
          command: { enabled: true, global: true, name: 'ship' },
        },
      ];

      const { result } = renderHook(() => useSlashCommands('station'));
      const words = result.current.catalog.map((command) => command.cmd);

      expect(words).toContain('/ship');
      expect(words).not.toContain('/release-check');
    });

    // A clash loser the SERVER disabled does not vanish from Commands: it
    // stays in the catalog with the server's own diagnostic as its reason,
    // and never reaches the composer's runnable command list
    it('lists a server-disabled clash loser in the catalog with its diagnostic, never in commands', () => {
      agents = [{ slug: 'station', name: 'Station', skills: ['ship-local'] }];
      skills = [
        {
          name: 'ship-global',
          command: { enabled: true, global: true, name: 'ship' },
        },
        {
          name: 'ship-local',
          command: { enabled: false, name: 'ship' },
          commandDiagnostic:
            "'/ship' is already used by the skill 'ship-global'",
        },
      ];

      const { result } = renderHook(() => useSlashCommands('station'));
      const loser = result.current.catalog.find(
        (command) => command.cmd === '/ship' && !command.availability.available,
      );

      expect(loser).toMatchObject({
        source: 'skill',
        availability: {
          available: false,
          reason: "'/ship' is already used by the skill 'ship-global'",
        },
      });
      // Exactly one runnable /ship — the server's winner.
      expect(
        result.current.commands.filter((command) => command.cmd === '/ship'),
      ).toHaveLength(1);
      expect(result.current.commands[0].availability.available).toBe(true);
    });
  });
});

/**
 * #1536 review M5. `/model` named the current model through the shared
 * identity rule but without the catalog, so an unresolved engine default read
 * "Default" here while the composer pill and the dock header — same rule, same
 * id, WITH the catalog — named the concrete model it resolves to. One rule and
 * two answers, because one caller withheld an input.
 */
describe('useSlashCommands — the /model row names what the composer names', () => {
  const catalog = [
    {
      id: 'default',
      name: 'Default (recommended)',
      resolvedModel: 'claude-opus-5',
    },
    { id: 'claude-opus-5', name: 'Opus 5', originalId: 'claude-opus-5' },
  ] as never[];

  beforeEach(() => {
    useProviderCommandsQueryMock.mockReset().mockReturnValue({ data: [] });
    skills = [];
    agents = [
      {
        slug: 'station',
        name: 'Station',
        model: 'default',
      },
    ];
  });

  function modelRow(models?: never[]) {
    const { result } = renderHook(() =>
      useSlashCommands('station', null, undefined, models),
    );
    const row = result.current.catalog.find(
      (command) => command.cmd === '/model',
    );
    expect(row, 'no /model row in the catalog').toBeDefined();
    return row as unknown as { description: string; currentModel: string };
  }

  it('names the concrete model the engine default resolves to, given the catalog', () => {
    const row = modelRow(catalog);
    expect(row.currentModel).toBe('Opus 5');
    expect(row.description).toContain('Opus 5');
    expect(row.description).not.toContain('recommended');
  });

  it('falls back to "Default" only when no catalog is available', () => {
    expect(modelRow().currentModel).toBe('Default');
  });

  it('says the model was not reported rather than rendering an empty gap', () => {
    agents = [{ slug: 'station', name: 'Station' }];
    const row = modelRow(catalog);
    // `modelIdentityLabel` answers this itself, which is why the old
    // `|| 'Model not reported'` fallbacks were unreachable.
    expect(row.currentModel).toBe('Model not reported');
  });
});
