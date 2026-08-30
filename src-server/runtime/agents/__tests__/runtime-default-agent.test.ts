import type { ToolDef } from '@kontourai/station-contracts/tool';
import { describe, expect, test, vi } from 'vitest';
import { createMCPToolProvenanceGeneration } from '../../../services/orchestration/mcp-tool-provenance.js';
import {
  isBuiltinStationControl,
  isBuiltinStationDocs,
  stationControlRuntimeIdentity,
  stationDocsRuntimeIdentity,
} from '../../bootstrap/station-control-runtime-env.js';
import {
  bootstrapRuntimeDefaultAgent,
  createRuntimeDocsIntegration,
  createRuntimeSelfIntegration,
  materializeBuiltinIntegrations,
} from '../runtime-default-agent.js';

describe('createRuntimeSelfIntegration', () => {
  test('builds the PERSISTED station-control payload — instance-independent (station#3063)', () => {
    const { selfIntegrationId, selfIntegration } =
      createRuntimeSelfIntegration();

    expect(selfIntegrationId).toBe('station-control');
    expect(selfIntegration).toEqual(
      expect.objectContaining({
        id: 'station-control',
        kind: 'mcp',
        transport: 'stdio',
      }),
    );
    // The archive#3063 invariant: no field of the persisted shape may derive from
    // the writing instance (dist path, bound port). Two co-homed servers
    // must produce byte-identical files or the cross-process reload
    // ping-pong returns.
    expect(selfIntegration).not.toHaveProperty('command');
    expect(selfIntegration).not.toHaveProperty('args');
    expect(selfIntegration).not.toHaveProperty('env');
  });

  test('station#3063: the runtime identity overlay carries the spawn fields the file no longer does', () => {
    const identity = stationControlRuntimeIdentity(4111);

    expect(identity.command).toBe('node');
    expect(identity.args?.[0]).toContain('station-control.js');
    expect(identity.env).toEqual({
      STATION_API_BASE: 'http://127.0.0.1:4111',
      STATION_PORT: '4111',
    });
    // The composed (loaded) shape must satisfy the spoof-resistant built-in
    // identity check every spawn/delivery gate keys on.
    const loaded = {
      ...createRuntimeSelfIntegration().selfIntegration,
      ...identity,
    } as ToolDef;
    expect(isBuiltinStationControl('station-control', loaded)).toBe(true);
  });
});

/**
 * archive#1547 AC3. This block is the guard, not a description of the feature.
 */
describe('createRuntimeDocsIntegration', () => {
  const ENV_GUARD_FAILURE = [
    'station-docs declared an `env`. This is the station#1547 guard, and it is',
    'failing on purpose.',
    '',
    'A tool server that declares a non-empty `env` is rejected as',
    '`secret-boundary-env` by session-agent-resolution.ts on EVERY delivery',
    'channel unless it holds a reviewed, per-engine exemption. station-docs has',
    'none and must never need one: declaring no environment at all is the ONLY',
    'reason it reaches ACP/wire engines, which is the entire point of the',
    'feature. Adding an env silently un-delivers it from exactly the engines it',
    'exists to serve.',
    '',
    'So: the moment this server needs a credential it stops being a',
    'credential-free docs server and BECOMES A DIFFERENT FEATURE WITH A',
    'DIFFERENT SECURITY REVIEW. Do not relax, delete, or narrow this assertion',
    'to make it pass. Take the change through that review instead.',
  ].join('\n');

  test('builds the PERSISTED station-docs payload — instance-independent (station#3063)', () => {
    const { docsIntegrationId, docsIntegration } =
      createRuntimeDocsIntegration();

    expect(docsIntegrationId).toBe('station-docs');
    expect(docsIntegration).toEqual(
      expect.objectContaining({
        id: 'station-docs',
        displayName: 'Station Docs',
        kind: 'mcp',
        transport: 'stdio',
      }),
    );
    // archive#3063: like station-control, the persisted shape carries no
    // instance identity — the dist path lives in the load-time overlay.
    expect(docsIntegration).not.toHaveProperty('command');
    expect(docsIntegration).not.toHaveProperty('args');
    // The description has to make the capability boundary legible to a user
    // reading the integration list, not only to a reviewer reading this file.
    expect(docsIntegration.description).toContain('Cannot read or change');
  });

  test('station#3063: the docs runtime identity overlay carries command/args and passes the built-in identity check', () => {
    const identity = stationDocsRuntimeIdentity();

    expect(identity.command).toBe('node');
    expect(identity.args?.[0]).toContain('station-docs.js');
    const loaded = {
      ...createRuntimeDocsIntegration().docsIntegration,
      ...identity,
    } as ToolDef;
    expect(isBuiltinStationDocs('station-docs', loaded)).toBe(true);
  });

  test('AC3 GUARD: station-docs declares no env — fails if anything ever adds one', () => {
    // Asserted against the real factory output AND the real load-time
    // overlay (archive#3063 moved command/args there), never a hand-copied
    // literal: a duplicated expectation can be updated in lockstep with the
    // defect it is supposed to catch, which would make this guard
    // decorative. The LOADED shape is what session-agent-resolution.ts
    // filters on, so the guard must hold over the composition.
    const def: ToolDef = createRuntimeDocsIntegration().docsIntegration;
    const loaded: ToolDef = { ...def, ...stationDocsRuntimeIdentity() };

    expect(Object.keys(loaded.env ?? {}), ENV_GUARD_FAILURE).toEqual([]);
    // Absence is the strongest shape (`{}` would also pass the check above,
    // and passing it is fine — but nothing should be introducing an empty
    // placeholder here either).
    expect(def.env, ENV_GUARD_FAILURE).toBeUndefined();
    expect(loaded.env, ENV_GUARD_FAILURE).toBeUndefined();
  });

  test('station-control is the deliberate contrast: its LOADED shape DOES carry env, so the guard above is about this server specifically', () => {
    const control: ToolDef = {
      ...createRuntimeSelfIntegration().selfIntegration,
      ...stationControlRuntimeIdentity(4111),
    };
    const docs: ToolDef = {
      ...createRuntimeDocsIntegration().docsIntegration,
      ...stationDocsRuntimeIdentity(),
    };

    expect(Object.keys(control.env ?? {}).length).toBeGreaterThan(0);
    expect(Object.keys(docs.env ?? {}).length).toBe(0);
  });
});

describe('materializeBuiltinIntegrations (station#3063)', () => {
  test('boot mode writes both built-ins unconditionally (the byte-identical save skip owns idempotence)', async () => {
    const saveIntegration = vi.fn(async () => {});
    const hasIntegration = vi.fn(async () => true);

    await materializeBuiltinIntegrations({ saveIntegration, hasIntegration });

    expect(hasIntegration).not.toHaveBeenCalled();
    expect(saveIntegration).toHaveBeenCalledTimes(2);
    for (const [id, def] of saveIntegration.mock.calls as unknown as Array<
      [string, ToolDef]
    >) {
      expect(['station-control', 'station-docs']).toContain(id);
      // The written payloads are the instance-independent persisted shape.
      expect(def).not.toHaveProperty('command');
      expect(def).not.toHaveProperty('args');
      expect(def).not.toHaveProperty('env');
    }
  });

  test('onlyIfMissing (the reload path) NEVER writes over an existing file — existence-gated, not content-gated', async () => {
    const saveIntegration = vi.fn(async () => {});
    const hasIntegration = vi.fn(async () => true);

    await materializeBuiltinIntegrations(
      { saveIntegration, hasIntegration },
      { onlyIfMissing: true },
    );

    expect(saveIntegration).not.toHaveBeenCalled();
  });

  test('onlyIfMissing self-heals an ABSENT file', async () => {
    const saveIntegration = vi.fn(async () => {});
    const hasIntegration = vi.fn(async (id: string) => id !== 'station-docs');

    await materializeBuiltinIntegrations(
      { saveIntegration, hasIntegration },
      { onlyIfMissing: true },
    );

    expect(saveIntegration).toHaveBeenCalledTimes(1);
    expect(saveIntegration).toHaveBeenCalledWith(
      'station-docs',
      expect.objectContaining({ id: 'station-docs' }),
    );
  });
});

describe('bootstrapRuntimeDefaultAgent', () => {
  test('creates the integration, default agent, and runtime state', async () => {
    const configLoader = {
      saveIntegration: vi.fn(async () => {}),
      // archive#3063: a home with NO built-in files yet — bootstrap
      // self-heals them (the only case in which a reload may write).
      hasIntegration: vi.fn(async () => false),
      getProjectHomeDir: vi.fn(() => '/tmp/project'),
    } as any;
    const framework = {
      createTempAgent: vi.fn(async () => ({ id: 'default-agent' })),
    } as any;
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    } as any;
    const loadAgentTools = vi.fn(async () => [{ name: 'tool-1' }]);
    const createModel = vi.fn(async () => ({ id: 'model-1' }));
    const activeAgents = new Map();
    const agentTools = new Map();
    const memoryAdapters = new Map();
    const agentMetadataMap = new Map();
    const agentHooksMap = new Map();
    const provenanceGeneration = createMCPToolProvenanceGeneration();

    const agents = await bootstrapRuntimeDefaultAgent({
      appConfig: {
        region: 'us-west-2',
        defaultModel: 'claude-sonnet',
        invokeModel: 'claude-sonnet',
        structureModel: 'claude-sonnet',
      },
      configLoader,
      framework,
      logger,
      defaultSystemPrompt: 'default prompt',
      autoApproveTools: ['station-control_read'],
      replaceTemplateVariables: (text) => text,
      resolveDefaultModelHint: () => 'claude-sonnet',
      createModel,
      loadAgentTools,
      mcpToolProvenanceGeneration: provenanceGeneration,
      activeAgents,
      agentTools,
      memoryAdapters,
      agentMetadataMap,
      agentHooksMap,
    });

    expect(configLoader.saveIntegration).toHaveBeenCalledWith(
      'station-control',
      expect.objectContaining({
        id: 'station-control',
      }),
    );
    // archive#1547: the docs server is persisted alongside station-control, so
    // `resolveToolServer('station-docs')` can find a ToolDef for it.
    expect(configLoader.saveIntegration).toHaveBeenCalledWith(
      'station-docs',
      expect.objectContaining({
        id: 'station-docs',
      }),
    );
    expect(createModel).toHaveBeenCalled();
    expect(loadAgentTools).toHaveBeenCalledWith(
      'default',
      expect.objectContaining({
        tools: expect.objectContaining({
          // archive#1547: authored on the built-in agent's spec — an id that is
          // not authored here is never delivered to any engine.
          mcpServers: ['station-control', 'station-docs'],
        }),
      }),
      provenanceGeneration,
    );
    // archive#914: the agent must be built with the very adapter registered under its
    // slug. A separate instance meant the agent wrote to the framework's own
    // in-process store while every read path went to the registered one — and
    // `default` is not in `agentSpecs`, so nothing else persists its turns.
    expect(memoryAdapters.get('default')).toBeDefined();
    expect(framework.createTempAgent.mock.calls[0]?.[0]?.memoryAdapter).toBe(
      memoryAdapters.get('default'),
    );
    expect(framework.createTempAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'default',
      }),
    );
    // archive#1834: the temp default agent must carry the REAL tool gate,
    // registered under its slug so chat streams can attach approval
    // requesters. Prove the wired hooks enforce the spec's autoApprove:
    // the read-only grant allows, anything else fails closed (unattended).
    const wiredHooks = framework.createTempAgent.mock.calls[0]?.[0]?.hooks;
    expect(wiredHooks).toBeDefined();
    expect(agentHooksMap.get('default')).toBe(wiredHooks);
    await expect(
      wiredHooks.beforeToolCall(
        { toolName: 'station-control_read', toolCallId: 't1', toolArgs: {} },
        { agentSlug: 'default' },
      ),
    ).resolves.toBe(true);
    await expect(
      wiredHooks.beforeToolCall(
        {
          toolName: 'station-control_update_config',
          toolCallId: 't2',
          toolArgs: {},
        },
        { agentSlug: 'default' },
      ),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('no approval channel'),
    });
    expect(agents).toEqual({ default: { id: 'default-agent' } });
    expect(activeAgents.has('default')).toBe(true);
    expect(agentTools.get('default')).toEqual([{ name: 'tool-1' }]);
    expect(memoryAdapters.has('default')).toBe(true);
    expect(agentMetadataMap.get('default')).toEqual(
      expect.objectContaining({
        slug: 'default',
        name: 'Station',
      }),
    );
  });

  test('wires the approval guardian into the default agent gate (station#1834 round 2)', async () => {
    const reviewToolCall = vi.fn().mockResolvedValue({
      decision: 'deny',
      reason: 'Mutates app config without a change record.',
    });
    const approvalGuardian = {
      isEnabled: () => true,
      getMode: () => 'enforce',
      reviewToolCall,
    } as any;
    const framework = {
      createTempAgent: vi.fn(async () => ({ id: 'default-agent' })),
    } as any;
    const agentHooksMap = new Map();

    await bootstrapRuntimeDefaultAgent({
      appConfig: { defaultModel: 'claude-sonnet' } as any,
      configLoader: {
        saveIntegration: vi.fn(async () => {}),
        hasIntegration: vi.fn(async () => false),
        getProjectHomeDir: vi.fn(() => '/tmp/project'),
      } as any,
      framework,
      logger: { info: vi.fn(), warn: vi.fn() } as any,
      defaultSystemPrompt: 'default prompt',
      autoApproveTools: ['station-control_read'],
      replaceTemplateVariables: (text: string) => text,
      resolveDefaultModelHint: () => 'claude-sonnet',
      createModel: vi.fn(async () => ({ id: 'model-1' })),
      loadAgentTools: vi.fn(async () => []),
      activeAgents: new Map(),
      agentTools: new Map(),
      memoryAdapters: new Map() as any,
      agentMetadataMap: new Map(),
      agentHooksMap,
      approvalGuardian,
    } as any);

    const wiredHooks = framework.createTempAgent.mock.calls[0]?.[0]?.hooks;
    // A guardian-denied mutating call must be denied WITH the guardian's
    // reason — not fall through to the no-approval-channel denial (and,
    // pre-fix, not proceed toward user approval at all).
    await expect(
      wiredHooks.beforeToolCall(
        {
          toolName: 'station-control_update_config',
          toolCallId: 't1',
          toolArgs: {},
        },
        { agentSlug: 'default' },
      ),
    ).resolves.toMatchObject({
      allowed: false,
      reason: expect.stringContaining('Mutates app config'),
    });
    expect(reviewToolCall).toHaveBeenCalledOnce();
  });

  test('removes stale default-agent state when no launchable model remains', async () => {
    const activeAgents = new Map([['default', { id: 'stale-default' }]]);
    const agentTools = new Map([['default', [{ name: 'stale-tool' }]]]);
    const memoryAdapters = new Map([['default', { stale: true }]]);
    const agentMetadataMap = new Map([['default', { slug: 'default' }]]);

    const agents = await bootstrapRuntimeDefaultAgent({
      appConfig: {} as any,
      configLoader: {
        saveIntegration: vi.fn(async () => {}),
        hasIntegration: vi.fn(async () => false),
        getProjectHomeDir: vi.fn(() => '/tmp/project'),
      } as any,
      framework: { createTempAgent: vi.fn() } as any,
      logger: { info: vi.fn(), warn: vi.fn() } as any,
      defaultSystemPrompt: 'default prompt',
      autoApproveTools: [],
      replaceTemplateVariables: (text) => text,
      resolveDefaultModelHint: () => null,
      createModel: vi.fn(),
      loadAgentTools: vi.fn(),
      activeAgents,
      agentTools,
      memoryAdapters: memoryAdapters as any,
      agentMetadataMap,
    });

    expect(agents).toEqual({});
    expect(activeAgents.has('default')).toBe(false);
    expect(agentTools.has('default')).toBe(false);
    expect(memoryAdapters.has('default')).toBe(false);
    expect(agentMetadataMap.has('default')).toBe(false);
  });
});

describe('bootstrapRuntimeDefaultAgent — station#1194 external engine binding', () => {
  const ENGINE_CAPABILITY_MATRICES = {
    claude: {
      engineId: 'claude',
      systemPrompt: { state: 'session', channel: 'flag' },
      toolServers: { state: 'session', channel: 'subprocess' },
      skills: { state: 'session', channel: 'workspace-overlay' },
      commands: { state: 'unsupported' },
      modelSelection: { state: 'session', channel: 'flag' },
    },
    codex: {
      engineId: 'codex',
      systemPrompt: { state: 'unsupported' },
      toolServers: { state: 'unsupported' },
      skills: { state: 'unsupported' },
      commands: { state: 'unsupported' },
      modelSelection: { state: 'session', channel: 'flag' },
    },
  } as const;

  function bindingScenario(overrides: Record<string, unknown> = {}) {
    const activeAgents = new Map([['default', { id: 'stale-default' }]]);
    const agentTools = new Map([['default', [{ name: 'stale-tool' }]]]);
    const memoryAdapters = new Map([['default', { stale: true }]]);
    const agentMetadataMap = new Map();
    const agentHooksMap = new Map([['default', { stale: true } as any]]);
    const createModel = vi.fn(async () => ({ id: 'model-1' }));
    const framework = { createTempAgent: vi.fn(async () => ({})) } as any;
    const logger = { info: vi.fn(), warn: vi.fn() } as any;

    return {
      activeAgents,
      agentTools,
      memoryAdapters,
      agentMetadataMap,
      agentHooksMap,
      createModel,
      framework,
      logger,
      run: () =>
        bootstrapRuntimeDefaultAgent({
          appConfig: {} as any,
          configLoader: {
            saveIntegration: vi.fn(async () => {}),
            hasIntegration: vi.fn(async () => false),
            getProjectHomeDir: vi.fn(() => '/tmp/project'),
          } as any,
          framework,
          logger,
          defaultSystemPrompt: 'default prompt',
          autoApproveTools: [],
          replaceTemplateVariables: (text: string) => text,
          resolveDefaultModelHint: () => 'claude-sonnet',
          createModel,
          loadAgentTools: vi.fn(async () => []),
          activeAgents,
          agentTools,
          memoryAdapters: memoryAdapters as any,
          agentMetadataMap,
          agentHooksMap,
          ...overrides,
        }),
    };
  }

  test('rebinds engineId: bound to a "full" engine (Claude Code) — no Station-engine instance is built, but the binding is honestly recorded', async () => {
    const scenario = bindingScenario({
      builtinEngineBinding: {
        connectionId: 'claude',
        matrix: ENGINE_CAPABILITY_MATRICES.claude,
      },
    });

    const agents = await scenario.run();

    expect(agents).toEqual({});
    expect(scenario.createModel).not.toHaveBeenCalled();
    expect(scenario.framework.createTempAgent).not.toHaveBeenCalled();
    // Stale prior-Station-engine state is cleared, never left dangling —
    // including the tool-gate hooks (archive#1834): a stale entry would let
    // chat streams register requesters against an instance no agent reads.
    expect(scenario.activeAgents.has('default')).toBe(false);
    expect(scenario.agentTools.has('default')).toBe(false);
    expect(scenario.memoryAdapters.has('default')).toBe(false);
    expect(scenario.agentHooksMap.has('default')).toBe(false);
    expect(scenario.agentMetadataMap.get('default')).toEqual(
      expect.objectContaining({
        slug: 'default',
        execution: { agentConnectionId: 'claude' },
      }),
    );
  });

  test('rebinds engineId: bound to a "chat-only" engine (Codex) — same skip, binding still honestly recorded', async () => {
    const scenario = bindingScenario({
      builtinEngineBinding: {
        connectionId: 'codex',
        matrix: ENGINE_CAPABILITY_MATRICES.codex,
      },
    });

    const agents = await scenario.run();

    expect(agents).toEqual({});
    expect(scenario.agentMetadataMap.get('default')).toEqual(
      expect.objectContaining({
        execution: { agentConnectionId: 'codex' },
      }),
    );
  });

  test('idempotent: re-running bootstrap with the SAME binding produces the same result — never clobbers back to Station', async () => {
    const scenario = bindingScenario({
      builtinEngineBinding: {
        connectionId: 'claude',
        matrix: ENGINE_CAPABILITY_MATRICES.claude,
      },
    });

    await scenario.run();
    const firstMetadata = scenario.agentMetadataMap.get('default');
    await scenario.run();
    const secondMetadata = scenario.agentMetadataMap.get('default');

    expect(secondMetadata.execution).toEqual({
      agentConnectionId: 'claude',
    });
    expect(secondMetadata.execution).toEqual(firstMetadata.execution);
    expect(scenario.createModel).not.toHaveBeenCalled();
  });

  test('station#1547: the docs integration is self-healed on the external-engine path too — the early return happens AFTER the materialization', async () => {
    // This is the path that matters most for archive#1547: an externally-bound
    // built-in agent never reaches `defaultSpec`, so if the materialization
    // sat below the early return a missing docs ToolDef would stay
    // unresolvable for exactly the engines the feature exists to serve.
    // archive#3063: the write is existence-gated now, so this scenario is a
    // home MISSING the file (hasIntegration → false).
    const saveIntegration = vi.fn(async () => {});
    const scenario = bindingScenario({
      builtinEngineBinding: {
        connectionId: 'codex',
        matrix: ENGINE_CAPABILITY_MATRICES.codex,
      },
      configLoader: {
        saveIntegration,
        hasIntegration: vi.fn(async () => false),
        getProjectHomeDir: vi.fn(() => '/tmp/project'),
      },
    });

    await scenario.run();

    expect(saveIntegration).toHaveBeenCalledWith(
      'station-docs',
      expect.objectContaining({ id: 'station-docs' }),
    );
  });

  test('station#3063: a MATERIALIZED home sees zero integration writes from bootstrap — the reload path never rewrites its own watched inputs', async () => {
    const saveIntegration = vi.fn(async () => {});
    const scenario = bindingScenario({
      builtinEngineBinding: null,
      configLoader: {
        saveIntegration,
        hasIntegration: vi.fn(async () => true),
        getProjectHomeDir: vi.fn(() => '/tmp/project'),
      },
    });

    await scenario.run();

    expect(saveIntegration).not.toHaveBeenCalled();
  });

  test('no binding (Station, the byte-identical default): builds the Station-engine agent exactly as before #1194', async () => {
    const scenario = bindingScenario({ builtinEngineBinding: null });

    const agents = await scenario.run();

    expect(scenario.createModel).toHaveBeenCalled();
    expect(scenario.framework.createTempAgent).toHaveBeenCalled();
    expect(agents).not.toEqual({});
    expect(scenario.agentMetadataMap.get('default').execution).toBeUndefined();
  });
});
