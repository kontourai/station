import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import { environmentId } from '@kontourai/station-contracts/execution-target';
import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import { describe, expect, test, vi } from 'vitest';
import type { ProviderAdapterShape } from '../../../providers/adapter-shape.js';
import { BedrockAdapter } from '../../../providers/adapters/bedrock-adapter.js';
import { MuseAdapter } from '../../../providers/adapters/muse-adapter.js';
import { OllamaAdapter } from '../../../providers/adapters/ollama-adapter.js';
import {
  type EnvironmentAccess,
  type ExecutionTargetResolverDependencies,
  resolveExecutionTarget,
} from '../execution-target-resolver.js';

const access: EnvironmentAccess = {
  apiBase: 'http://127.0.0.1:43141',
  environmentId: 'environment-kontour',
  environmentName: 'Kontour',
  kind: 'current',
  requestOptions: { headers: { Authorization: 'Bearer secret' } },
};

const defaultModelLaunchAdapter = {
  provider: 'default',
  metadata: {
    modelLaunch: {
      defaultAtStart: 'engine-selected',
      omissionAtResume: 'engine-selected',
      omissionPerTurn: 'engine-selected',
      overrideAtStart: true,
      overrideAtResume: true,
      overridePerTurn: true,
    },
  },
} as ProviderAdapterShape;

function connection(id: string, provider = 'codex'): ConnectionConfig {
  return {
    id,
    name: id,
    kind: 'agent',
    type: provider,
    enabled: true,
    status: 'ready',
    capabilities: ['agent-runtime'],
    config: { provider },
    prerequisites: [],
  };
}

function dependencies(
  overrides: Partial<ExecutionTargetResolverDependencies> = {},
): ExecutionTargetResolverDependencies {
  return {
    resolveEnvironmentAccess: vi.fn(async () => access),
    getAgent: vi.fn(async () => ({ slug: 'station', available: true })),
    getConnection: vi.fn(async (_access, id) => connection(id)),
    getProject: vi.fn(async () => ({ workingDirectory: '/work/station' })),
    getProviderAdapter: vi.fn((provider) => {
      if (provider === 'muse') return new MuseAdapter();
      if (provider === 'acp') return undefined;
      return defaultModelLaunchAdapter;
    }),
    now: () => new Date('2026-08-01T12:00:00.000Z'),
    ...overrides,
  };
}

describe('resolveExecutionTarget', () => {
  test.each([
    ['worktree', 'worktree'],
    ['shared', 'shared'],
  ] as const)(
    'uses the project default workspace isolation (%s) for a new project thread',
    async (defaultWorkspaceIsolation, expectedMode) => {
      const result = await resolveExecutionTarget(
        {
          environment: { kind: 'current' },
          agent: agentId('station'),
          workspace: { kind: 'project', projectSlug: 'station' },
        },
        dependencies({
          getProject: async () => ({
            workingDirectory: '/work/station',
            defaultWorkspaceIsolation,
          }),
        }),
      );

      expect(result.workspace).toMatchObject({
        kind: 'project',
        cwd: '/work/station',
        workspaceIsolation: { mode: expectedMode },
      });
    },
  );

  test('defaults an unset project workspace isolation to the current checkout', async () => {
    const result = await resolveExecutionTarget(
      {
        environment: { kind: 'current' },
        agent: agentId('station'),
        workspace: { kind: 'project', projectSlug: 'station' },
      },
      dependencies({
        getProject: async () => ({ workingDirectory: '/work/station' }),
      }),
    );

    expect(result.workspace).toMatchObject({
      workspaceIsolation: { mode: 'shared' },
    });
  });

  test('keeps an explicit thread workspace isolation over the project default', async () => {
    const result = await resolveExecutionTarget(
      {
        environment: { kind: 'current' },
        agent: agentId('station'),
        workspace: {
          kind: 'project',
          projectSlug: 'station',
          workspaceIsolation: { mode: 'shared' },
        },
      },
      dependencies({
        getProject: async () => ({
          workingDirectory: '/work/station',
          defaultWorkspaceIsolation: 'worktree',
        }),
      }),
    );

    expect(result.workspace).toMatchObject({
      workspaceIsolation: { mode: 'shared' },
    });
  });

  test('resolves a Station Agent without exposing private Environment access in its receipt', async () => {
    const result = await resolveExecutionTarget(
      {
        environment: { kind: 'current' },
        agent: agentId('station'),
      },
      dependencies(),
    );

    expect(result).toMatchObject({
      agentId: 'station',
      engine: { kind: 'station' },
      provider: 'station-agent',
      modelLaunchPlan: {
        kind: 'engine-selected',
        evidence: 'adapter-declared',
      },
      receipt: {
        schemaVersion: 'station.execution-resolution/v1',
        resolvedAt: '2026-08-01T12:00:00.000Z',
        environmentId: 'environment-kontour',
        agentId: 'station',
        engine: { kind: 'station' },
        provider: 'station-agent',
      },
    });
    expect(result.receipt).not.toHaveProperty('apiBase');
    expect(result.receipt).not.toHaveProperty('requestOptions');
    expect(JSON.stringify(result.receipt)).not.toContain('secret');
  });

  test('resolves an external Agent through its target-local engine binding', async () => {
    const getConnection = vi.fn(async () => connection('codex', 'codex'));
    const result = await resolveExecutionTarget(
      {
        environment: {
          kind: 'saved',
          id: environmentId('environment-media'),
        },
        agent: agentId('reviewer'),
        model: { override: 'gpt-5.6', options: { effort: 'high' } },
        workspace: { kind: 'project', projectSlug: 'station' },
      },
      dependencies({
        resolveEnvironmentAccess: async () => ({
          ...access,
          environmentId: 'environment-media',
          kind: 'ssh',
          verifiedProjectPath: '/work/station',
        }),
        getAgent: async () => ({
          slug: 'reviewer',
          available: true,
          execution: { agentConnectionId: engineConnectionId('codex') },
        }),
        getConnection,
      }),
    );

    expect(getConnection).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'environment-media' }),
      'codex',
    );
    expect(result).toMatchObject({
      agentId: 'reviewer',
      engine: { kind: 'connection', connectionId: 'codex' },
      provider: 'codex',
      workspace: {
        kind: 'project',
        projectSlug: 'station',
        cwd: '/work/station',
      },
      receipt: {
        environmentId: 'environment-media',
        agentId: 'reviewer',
        engine: { kind: 'connection', connectionId: 'codex' },
        provider: 'codex',
      },
    });
  });

  test('rejects unavailable Agents before reading an engine connection', async () => {
    const getConnection = vi.fn();
    await expect(
      resolveExecutionTarget(
        {
          environment: { kind: 'current' },
          agent: agentId('codex'),
        },
        dependencies({
          getAgent: async () => ({
            slug: 'codex',
            available: false,
            unavailableReason: 'Codex is not authenticated.',
          }),
          getConnection,
        }),
      ),
    ).rejects.toThrow('Codex is not authenticated.');
    expect(getConnection).not.toHaveBeenCalled();
  });

  test('rejects a non-ready target-local engine connection', async () => {
    await expect(
      resolveExecutionTarget(
        {
          environment: { kind: 'current' },
          agent: agentId('codex'),
        },
        dependencies({
          getAgent: async () => ({
            slug: 'codex',
            execution: { agentConnectionId: engineConnectionId('codex') },
          }),
          getConnection: async () => ({
            ...connection('codex'),
            status: 'missing_prerequisites',
          }),
        }),
      ),
    ).rejects.toThrow("Engine connection 'codex' is not ready for execution");
  });

  test('rejects a project that disagrees with a verified SSH binding', async () => {
    await expect(
      resolveExecutionTarget(
        {
          environment: {
            kind: 'saved',
            id: environmentId('environment-media'),
          },
          agent: agentId('station'),
          workspace: { kind: 'project', projectSlug: 'other' },
        },
        dependencies({
          resolveEnvironmentAccess: async () => ({
            ...access,
            kind: 'ssh',
            verifiedProjectPath: '/verified/station',
          }),
          getProject: async () => ({ workingDirectory: '/wrong/project' }),
        }),
      ),
    ).rejects.toThrow('does not match the verified Environment workspace');
  });

  describe('remote verified workspace confinement', () => {
    const target = {
      environment: {
        kind: 'saved' as const,
        id: environmentId('environment-media'),
      },
      agent: agentId('station'),
      workspace: { kind: 'project' as const, projectSlug: 'workspace' },
    };

    test.each([
      ['~/work', '/srv/anything/work'],
      ['~/src', '/opt/vendor/src'],
      ['~/data', '/mnt/backup/data'],
      ['/home/user/work2', '/home/user/work'],
      ['/home/user/work', '/home/user/work2'],
      ['~/../work', '/home/brian/work'],
      ['~/./work', '/home/brian/work'],
      ['~//work', '/home/brian/work'],
      ['~/Work', '/home/brian/work'],
    ])(
      'rejects %s against %s',
      async (workingDirectory, verifiedProjectPath) => {
        await expect(
          resolveExecutionTarget(
            target,
            dependencies({
              resolveEnvironmentAccess: async () => ({
                ...access,
                kind: 'ssh',
                remoteHome: '/home/brian',
                verifiedProjectPath,
              }),
              getProject: async () => ({ workingDirectory }),
            }),
          ),
        ).rejects.toThrow('does not match the verified Environment workspace');
      },
    );

    test('fails closed for a tilde path when a legacy profile lacks remote home', async () => {
      await expect(
        resolveExecutionTarget(
          target,
          dependencies({
            resolveEnvironmentAccess: async () => ({
              ...access,
              kind: 'ssh',
              verifiedProjectPath: '/home/anyone/dev/station',
            }),
            getProject: async () => ({ workingDirectory: '~/dev/station' }),
          }),
        ),
      ).rejects.toThrow('remote home unverified — re-verify the environment');
    });

    test.each([
      ['~/work', '/home/brian/work'],
      ['/home/brian/work', '/home/brian/work/'],
      ['/home/brian//work', '/home/brian/work'],
    ])(
      'accepts exact remote identity %s and %s',
      async (workingDirectory, verifiedProjectPath) => {
        await expect(
          resolveExecutionTarget(
            target,
            dependencies({
              resolveEnvironmentAccess: async () => ({
                ...access,
                kind: 'ssh',
                remoteHome: '/home/brian',
                verifiedProjectPath,
              }),
              getProject: async () => ({ workingDirectory }),
            }),
          ),
        ).resolves.toMatchObject({ workspace: { cwd: verifiedProjectPath } });
      },
    );

    test('rejects a relative verified path', async () => {
      await expect(
        resolveExecutionTarget(
          target,
          dependencies({
            resolveEnvironmentAccess: async () => ({
              ...access,
              kind: 'ssh',
              remoteHome: '/home/brian',
              verifiedProjectPath: 'srv/work',
            }),
            getProject: async () => ({ workingDirectory: '/srv/work' }),
          }),
        ),
      ).rejects.toThrow('verified project path is invalid');
    });

    test('rejects a directory workspace outside the verified binding', async () => {
      await expect(
        resolveExecutionTarget(
          {
            ...target,
            workspace: { kind: 'directory', cwd: '/srv/secret' },
          },
          dependencies({
            resolveEnvironmentAccess: async () => ({
              ...access,
              kind: 'ssh',
              verifiedProjectPath: '/srv/station',
            }),
          }),
        ),
      ).rejects.toThrow('does not match the verified Environment workspace');
    });

    test('rejects a caller cwd override outside the verified binding', async () => {
      await expect(
        resolveExecutionTarget(
          {
            ...target,
            workspace: {
              kind: 'project',
              projectSlug: 'workspace',
              cwd: '/srv/secret',
            },
          },
          dependencies({
            resolveEnvironmentAccess: async () => ({
              ...access,
              kind: 'ssh',
              verifiedProjectPath: '/srv/station',
            }),
            getProject: async () => ({ workingDirectory: '/srv/station' }),
          }),
        ),
      ).rejects.toThrow('does not match the verified Environment workspace');
    });
  });

  test('admits a muse model override through its registered declaration', async () => {
    const result = await resolveExecutionTarget(
      {
        environment: { kind: 'current' },
        agent: agentId('muse'),
        model: { override: 'muse-spark-1.2-contributor' },
      },
      dependencies({
        getAgent: async () => ({
          slug: 'muse',
          execution: { agentConnectionId: engineConnectionId('muse') },
        }),
        getConnection: async () => connection('muse', 'muse'),
      }),
    );
    expect(result.provider).toBe('muse');
    expect(result.modelLaunchPlan).toEqual({
      kind: 'engine-selected',
      evidence: 'adapter-declared',
    });
  });

  test.each([
    ['bedrock', new BedrockAdapter()],
    ['ollama', new OllamaAdapter('http://127.0.0.1:11434')],
  ] as const)(
    'refuses a %s model override without a model connection',
    async (provider, adapter) => {
      await expect(
        resolveExecutionTarget(
          {
            environment: { kind: 'current' },
            agent: agentId(provider),
            model: { override: 'declared-model' },
          },
          dependencies({
            getAgent: async () => ({
              slug: provider,
              execution: { agentConnectionId: engineConnectionId(provider) },
            }),
            getConnection: async () => connection(provider, provider),
            getProviderAdapter: (registeredProvider) =>
              registeredProvider === provider ? adapter : undefined,
          }),
        ),
      ).rejects.toThrow('model-required');
    },
  );

  test('does not mislabel a resume-only declaration as start-only unsupported', async () => {
    const resumeOnly = {
      provider: 'resume-only',
      metadata: {
        modelLaunch: {
          defaultAtStart: 'engine-selected',
          omissionAtResume: 'engine-selected',
          omissionPerTurn: 'engine-selected',
          overrideAtStart: false,
          overrideAtResume: true,
          overridePerTurn: false,
        },
      },
    } as ProviderAdapterShape;
    const result = await resolveExecutionTarget(
      {
        environment: { kind: 'current' },
        agent: agentId('resume-only'),
        model: { override: 'declared-model' },
      },
      dependencies({
        getAgent: async () => ({
          slug: 'resume-only',
          execution: { agentConnectionId: engineConnectionId('resume-only') },
        }),
        getConnection: async () => connection('resume-only', 'resume-only'),
        getProviderAdapter: (provider) =>
          provider === 'resume-only' ? resumeOnly : undefined,
      }),
    );

    expect(result.modelLaunchPlan).toEqual({
      kind: 'engine-selected',
      evidence: 'adapter-declared',
    });
  });

  test('refuses an override when the registered adapter declares no model launch capability', async () => {
    const declarationless = {
      provider: 'declarationless',
      metadata: {},
    } as ProviderAdapterShape;
    await expect(
      resolveExecutionTarget(
        {
          environment: { kind: 'current' },
          agent: agentId('declarationless'),
          model: { override: 'other' },
        },
        dependencies({
          getAgent: async () => ({
            slug: 'declarationless',
            execution: {
              agentConnectionId: engineConnectionId('declarationless'),
            },
          }),
          getConnection: async () =>
            connection('declarationless', 'declarationless'),
          getProviderAdapter: (provider) =>
            provider === 'declarationless' ? declarationless : undefined,
        }),
      ),
    ).rejects.toThrow('override-unsupported');
  });

  // Absent from `PROVIDER_MODEL_OPTION_SUPPORT`, muse's `modelOptions` were
  // accepted here and then read by nothing.
  test('rejects modelOptions muse cannot apply', async () => {
    await expect(
      resolveExecutionTarget(
        {
          environment: { kind: 'current' },
          agent: agentId('muse'),
          model: {
            override: 'muse-spark-1.2-contributor',
            options: {
              effort: 'high',
            },
          },
        },
        dependencies({
          getAgent: async () => ({
            slug: 'muse',
            execution: { agentConnectionId: engineConnectionId('muse') },
          }),
          getConnection: async () => connection('muse', 'muse'),
        }),
      ),
    ).rejects.toThrow('effort');
  });

  test('rejects direct ACP model overrides from the shared resolver', async () => {
    await expect(
      resolveExecutionTarget(
        {
          environment: { kind: 'current' },
          agent: agentId('kiro'),
          model: { override: 'other' },
        },
        dependencies({
          getAgent: async () => ({
            slug: 'kiro',
            execution: { agentConnectionId: engineConnectionId('kiro') },
          }),
          getConnection: async () => connection('kiro', 'acp'),
        }),
      ),
    ).rejects.toThrow('override-unsupported');
  });
});

// archive#3406: an Agent that declares `execution.modelId` had that model
// dropped -- only a per-turn override ever reached the adapter, so the turn ran
// on the engine's default and nothing said so. Worse for ACP: the adapter's
// apply-and-verify block is reached ONLY when a model is requested, so the
// engine's own verification was skipped too.
describe('the model a turn launches with', () => {
  const agentWithModel = {
    slug: agentId('glm-delegate'),
    available: true,
    execution: {
      agentConnectionId: engineConnectionId('opencode-glm'),
      modelId: 'zai-coding-plan/glm-5.3',
    },
  };

  test("uses the Agent's declared model when the caller sends no override", async () => {
    const resolved = await resolveExecutionTarget(
      { agent: agentId('glm-delegate'), environment: { kind: 'current' } },
      dependencies({ getAgent: vi.fn(async () => agentWithModel) }),
    );

    expect(resolved.modelId).toBe('zai-coding-plan/glm-5.3');
  });

  test('a per-turn override wins over the Agent’s declared model', async () => {
    const resolved = await resolveExecutionTarget(
      {
        agent: agentId('glm-delegate'),
        environment: { kind: 'current' },
        model: { override: 'zai-coding-plan/glm-5.2' },
      },
      dependencies({ getAgent: vi.fn(async () => agentWithModel) }),
    );

    expect(resolved.modelId).toBe('zai-coding-plan/glm-5.2');
  });

  test('an Agent with no declared model leaves the engine to choose', async () => {
    const resolved = await resolveExecutionTarget(
      { agent: agentId('station'), environment: { kind: 'current' } },
      dependencies({
        getAgent: vi.fn(async () => ({
          slug: agentId('station'),
          available: true,
          execution: { agentConnectionId: engineConnectionId('opencode-glm') },
        })),
      }),
    );

    // Absent, not an empty string: an adapter must be able to tell "no model
    // stated" from "a model whose id is ''".
    expect(resolved.modelId).toBeUndefined();
  });

  // An engine that can apply a model only at session start is the shape ACP
  // actually declares (overrideAtStart true, resume and per-turn false, with
  // omission at both described as engine-selected). The permissive fixture the
  // other tests use would never notice a regression here.
  const startOnlyOverrideAdapter = {
    provider: 'acp',
    metadata: {
      modelLaunch: {
        defaultAtStart: 'engine-selected',
        omissionAtResume: 'engine-selected',
        omissionPerTurn: 'engine-selected',
        overrideAtStart: true,
        overrideAtResume: false,
        overridePerTurn: false,
      },
    },
  } as ProviderAdapterShape;

  test("resolves an Agent's model for an engine that can only apply one at start", async () => {
    const resolved = await resolveExecutionTarget(
      { agent: agentId('glm-delegate'), environment: { kind: 'current' } },
      dependencies({
        getAgent: vi.fn(async () => agentWithModel),
        getConnection: vi.fn(async (_access, id) => connection(id, 'acp')),
        getProviderAdapter: vi.fn(() => startOnlyOverrideAdapter),
      }),
    );

    // It must resolve rather than throwing `cannot use the requested model`:
    // the model is applied at start, which this engine supports. The dispatch
    // layer is what keeps it off resume/per-turn.
    expect(resolved.modelId).toBe('zai-coding-plan/glm-5.3');
    expect(resolved.modelLaunchPlan.kind).not.toBe('unavailable');
  });

  test('a blank declared model is treated as unstated, never sent as an empty id', async () => {
    const resolved = await resolveExecutionTarget(
      { agent: agentId('glm-delegate'), environment: { kind: 'current' } },
      dependencies({
        getAgent: vi.fn(async () => ({
          slug: agentId('glm-delegate'),
          available: true,
          execution: {
            agentConnectionId: engineConnectionId('opencode-glm'),
            modelId: '   ',
          },
        })),
      }),
    );

    expect(resolved.modelId).toBeUndefined();
  });
});
