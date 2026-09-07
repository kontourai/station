import type { AgentId } from '@kontourai/station-contracts/agent-identity';
import {
  WORKSPACE_PANE_HOST_CONTRIBUTION_VERSION,
  type WorkspacePaneHostAgentResolution,
  type WorkspacePaneHostContributionV1,
} from '@kontourai/station-contracts/workspace-pane-host-contribution';
import { describe, expect, test, vi } from 'vitest';
import {
  createWorkspacePaneHostContribution,
  migrateLegacyLayoutHostContribution,
  parseWorkspacePaneHostContribution,
} from '../workspace-pane-host-contributions.js';

const owner = {
  pluginId: 'demo-layout',
  installationGeneration: `sha256:${'a'.repeat(64)}`,
};
const ownAgent = {
  kind: 'own-plugin-agent' as const,
  agentId: 'assistant' as AgentId,
};

function declaration(): WorkspacePaneHostContributionV1 {
  return {
    version: WORKSPACE_PANE_HOST_CONTRIBUTION_VERSION,
    actions: [
      {
        id: 'say-hello',
        label: 'Say Hello',
        presentation: 'skill-prompt',
        intent: { kind: 'prompt', prompt: 'Hello from the exact plugin.' },
      },
    ],
    agentSelection: {
      availableAgents: [ownAgent],
      defaultAgent: ownAgent,
    },
  };
}

function availableOwn(): Extract<
  WorkspacePaneHostAgentResolution,
  { state: 'available' }
> {
  return {
    state: 'available',
    agent: {
      kind: 'plugin-agent',
      pluginId: owner.pluginId,
      installationGeneration: owner.installationGeneration,
      agentId: ownAgent.agentId,
    },
  };
}

describe('Workspace Pane host contributions', () => {
  test('validates a closed declaration and rejects undeclared or implicit Agents', () => {
    expect(parseWorkspacePaneHostContribution(declaration())).toEqual(
      declaration(),
    );
    expect(
      parseWorkspacePaneHostContribution({
        ...declaration(),
        requiredAgents: ['assistant'],
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneHostContribution({
        ...declaration(),
        actions: [
          {
            ...declaration().actions[0],
            intent: {
              kind: 'prompt',
              prompt: 'Use an undeclared Agent.',
              agent: { kind: 'station-agent', agentId: 'station' },
            },
          },
        ],
      }),
    ).toBeNull();
  });

  test('rejects accessor-backed and sparse declaration arrays without reading them', () => {
    const getter = vi.fn(() => declaration().actions[0]);
    const accessorActions: unknown[] = [];
    Object.defineProperty(accessorActions, '0', {
      enumerable: true,
      get: getter,
    });
    accessorActions.length = 1;
    expect(
      parseWorkspacePaneHostContribution({
        ...declaration(),
        actions: accessorActions,
      }),
    ).toBeNull();
    expect(
      parseWorkspacePaneHostContribution({
        ...declaration(),
        actions: Array(1),
      }),
    ).toBeNull();
    expect(getter).not.toHaveBeenCalled();
  });

  test('migrates namespaced legacy Agent identity without weakening clean Agent ids', () => {
    const first = migrateLegacyLayoutHostContribution({
      pluginId: 'demo-layout',
      layout: {
        availableAgents: ['demo-layout:assistant' as AgentId],
        defaultAgent: 'demo-layout:assistant' as AgentId,
        globalSkills: [
          {
            prompt: 'Hello! What can you help me with today?',
            label: 'Say Hello',
            id: 'hello',
          },
        ],
      },
    });
    const second = migrateLegacyLayoutHostContribution({
      pluginId: 'demo-layout',
      layout: {
        availableAgents: ['demo-layout:assistant' as AgentId],
        defaultAgent: 'demo-layout:assistant' as AgentId,
        globalSkills: [
          {
            id: 'hello',
            label: 'Say Hello',
            prompt: 'Hello! What can you help me with today?',
          },
        ],
      },
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      state: 'migrated',
      contribution: {
        actions: [
          {
            presentation: 'skill-prompt',
            intent: {
              kind: 'prompt',
              prompt: 'Hello! What can you help me with today?',
            },
          },
        ],
        agentSelection: {
          availableAgents: [{ kind: 'own-plugin-agent', agentId: 'assistant' }],
          defaultAgent: { kind: 'own-plugin-agent', agentId: 'assistant' },
        },
      },
    });
  });

  test('requires manual review instead of inventing an ambient Agent or navigation authority', () => {
    expect(
      migrateLegacyLayoutHostContribution({
        pluginId: 'coding-starter',
        layout: {
          actions: [
            {
              type: 'prompt',
              label: 'Review current diff',
              data: 'Review the current diff.',
            },
          ],
        },
      }),
    ).toEqual({
      state: 'manual-review',
      reasons: ['action-0-prompt-semantics-ambiguous'],
    });
    expect(
      migrateLegacyLayoutHostContribution({
        pluginId: 'coding-starter',
        layout: {
          actions: [
            {
              type: 'inline-prompt',
              label: 'Review current diff',
              data: 'Review the current diff.',
            },
          ],
        },
      }),
    ).toEqual({
      state: 'manual-review',
      reasons: ['action-0-has-no-agent'],
    });
    expect(
      migrateLegacyLayoutHostContribution({
        pluginId: 'demo-layout',
        layout: {
          availableAgents: ['other-plugin:assistant' as AgentId],
          defaultAgent: 'other-plugin:assistant' as AgentId,
        },
      }),
    ).toMatchObject({ state: 'manual-review' });
    expect(
      migrateLegacyLayoutHostContribution({
        pluginId: 'demo-layout',
        layout: {
          actions: [
            {
              type: 'external',
              label: 'Open docs',
              data: 'https://example.com',
            },
          ],
        },
      }),
    ).toEqual({
      state: 'manual-review',
      reasons: ['action-0-requires-host-intent'],
    });
  });

  test('projects and dispatches through exact owner, Project, and Agent rechecks', async () => {
    let ownerState: 'current' | 'retired' | 'unavailable' = 'current';
    let resolution: WorkspacePaneHostAgentResolution = availableOwn();
    const resolveOwnPluginAgent = vi.fn(async () => resolution);
    const launch = vi.fn(async () => ({
      state: 'launched' as const,
      sessionId: 'session-1',
    }));
    const contribution = createWorkspacePaneHostContribution({
      declaration: declaration(),
      owner,
      projectId: 'project-a',
      authority: { current: () => ({ state: ownerState }) },
      agents: {
        resolveOwnPluginAgent,
        resolveStationAgent: vi.fn(async () => ({
          state: 'unavailable' as const,
        })),
      },
      launcher: { launch },
    });

    const projection = await contribution.project();
    expect(projection).toMatchObject({
      state: 'available',
      projection: {
        owner,
        projectId: 'project-a',
        actions: [{ availability: 'available' }],
        agentSelection: {
          defaultAgent: {
            declaration: ownAgent,
            resolution: {
              state: 'available',
              agent: {
                kind: 'plugin-agent',
                pluginId: 'demo-layout',
                installationGeneration: owner.installationGeneration,
                agentId: 'assistant',
              },
            },
          },
        },
      },
    });
    if (projection.state !== 'available')
      throw new Error('expected projection');
    const key = projection.projection.actions[0]!.key;
    await expect(contribution.dispatch(key)).resolves.toEqual({
      state: 'launched',
      sessionId: 'session-1',
    });
    expect(resolveOwnPluginAgent).toHaveBeenLastCalledWith({
      owner,
      projectId: 'project-a',
      agentId: 'assistant',
    });
    expect(launch).toHaveBeenCalledWith({
      owner,
      projectId: 'project-a',
      actionKey: key,
      label: 'Say Hello',
      prompt: 'Hello from the exact plugin.',
      agent: availableOwn().agent,
    });

    resolution = { state: 'restricted' };
    await expect(contribution.dispatch(key)).resolves.toEqual({
      state: 'refused',
      reason: 'agent-restricted',
    });
    ownerState = 'retired';
    await expect(contribution.dispatch(key)).resolves.toEqual({
      state: 'refused',
      reason: 'owner-retired',
    });
    ownerState = 'unavailable';
    await expect(contribution.dispatch(key)).resolves.toEqual({
      state: 'unavailable',
    });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  test('binds action identity to its exact Project', async () => {
    const create = (projectId: string) =>
      createWorkspacePaneHostContribution({
        declaration: declaration(),
        owner,
        projectId,
        authority: { current: () => ({ state: 'current' }) },
        agents: {
          resolveOwnPluginAgent: async () => availableOwn(),
          resolveStationAgent: async () => ({ state: 'unavailable' }),
        },
        launcher: { launch: async () => ({ state: 'unavailable' }) },
      });
    const first = await create('project-a').project();
    const second = await create('project-b').project();
    if (first.state !== 'available' || second.state !== 'available') {
      throw new Error('expected projections');
    }
    expect(first.projection.actions[0]!.key).not.toBe(
      second.projection.actions[0]!.key,
    );
  });

  test('captures dependency methods and never returns mutable declaration authority', async () => {
    const agents = {
      resolveOwnPluginAgent:
        async (): Promise<WorkspacePaneHostAgentResolution> => availableOwn(),
      resolveStationAgent:
        async (): Promise<WorkspacePaneHostAgentResolution> => ({
          state: 'unavailable',
        }),
    };
    const contribution = createWorkspacePaneHostContribution({
      declaration: declaration(),
      owner,
      projectId: 'project-a',
      agents,
      authority: { current: () => ({ state: 'current' }) },
      launcher: { launch: async () => ({ state: 'unavailable' }) },
    });
    agents.resolveOwnPluginAgent = async () => ({ state: 'restricted' });
    const first = await contribution.project();
    if (first.state !== 'available') throw new Error('expected projection');
    (
      first.projection.agentSelection.availableAgents[0]!.declaration as {
        agentId: AgentId;
      }
    ).agentId = 'another-agent' as AgentId;
    const second = await contribution.project();
    expect(second).toMatchObject({
      state: 'available',
      projection: {
        agentSelection: {
          availableAgents: [
            { declaration: ownAgent, resolution: { state: 'available' } },
          ],
        },
      },
    });
  });

  test('rejects resolver identity equivocation and retirement during an Agent await', async () => {
    let ownerState: 'current' | 'retired' = 'current';
    let releaseResolution!: () => void;
    const wait = new Promise<void>((resolve) => {
      releaseResolution = resolve;
    });
    let resolutionCalls = 0;
    const launch = vi.fn();
    const contribution = createWorkspacePaneHostContribution({
      declaration: declaration(),
      owner,
      projectId: 'project-a',
      authority: { current: () => ({ state: ownerState }) },
      agents: {
        resolveOwnPluginAgent: async () => {
          resolutionCalls += 1;
          if (resolutionCalls > 1) await wait;
          return availableOwn();
        },
        resolveStationAgent: async () => ({ state: 'unavailable' }),
      },
      launcher: { launch },
    });
    const projected = await contribution.project();
    if (projected.state !== 'available') throw new Error('expected projection');
    const key = projected.projection.actions[0]!.key;
    const pending = contribution.dispatch(key);
    ownerState = 'retired';
    releaseResolution();
    await expect(pending).resolves.toEqual({
      state: 'refused',
      reason: 'owner-retired',
    });
    expect(launch).not.toHaveBeenCalled();

    const equivocation = createWorkspacePaneHostContribution({
      declaration: declaration(),
      owner,
      projectId: 'project-a',
      authority: { current: () => ({ state: 'current' }) },
      agents: {
        resolveOwnPluginAgent: async () => ({
          state: 'available',
          agent: {
            kind: 'plugin-agent',
            pluginId: 'other-plugin',
            installationGeneration: owner.installationGeneration,
            agentId: ownAgent.agentId,
          },
        }),
        resolveStationAgent: async () => ({ state: 'unavailable' }),
      },
      launcher: { launch },
    });
    await expect(equivocation.dispatch(key)).resolves.toEqual({
      state: 'refused',
      reason: 'agent-unavailable',
    });
  });
});
