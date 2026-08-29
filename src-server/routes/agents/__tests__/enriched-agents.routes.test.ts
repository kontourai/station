import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  engineConnectionId,
  engineId,
} from '@kontourai/station-contracts/agent-identity';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import {
  loadOrCreateAgentRegistry,
  registerEngineConnection,
  unregisterEngineConnection,
} from '../../../domain/agent-registry.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { createChildDelegationContext } from '../../../runtime/agents/delegation.js';
import {
  AgentService,
  runtimeStationEngineExecution,
} from '../../../services/agents/agent-service.js';
import {
  CATALOG_REFRESHING_REASON,
  createEnrichedAgentRoutes,
  externalEngineUnavailable,
  isHonestlyAvailableConnectedAgent,
  runtimeConnectionSummary,
} from '../enriched-agents.js';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

function setup(overrides: Record<string, unknown> = {}) {
  const metadata = [
    {
      slug: 'station',
      name: 'Station',
    },
    {
      slug: 'codex',
      name: 'codex',
      execution: { agentConnectionId: engineConnectionId('codex') },
    },
    { slug: 'writer', name: 'Writer' },
  ];
  const deps = {
    agentMetadataMap: new Map(metadata.map((agent) => [agent.slug, agent])),
    activeAgents: new Map([['default', {}]]),
    loadAgent: vi.fn(async (slug: string) => {
      if (slug === 'writer') return { name: 'Writer', prompt: 'Write.' };
      throw new Error('registry defaults are not stored as authored Agents');
    }),
    listAgents: vi.fn().mockResolvedValue(metadata),
    getDefaultAgentIds: vi
      .fn()
      .mockResolvedValue(new Set(['station', 'codex'])),
    defaultModel: 'managed-default',
    defaultTools: { mcpServers: ['station-control'], autoApprove: [] },
    getRuntimeConnections: vi.fn().mockResolvedValue([
      {
        id: 'codex',
        type: 'codex-runtime',
        name: 'Codex',
        status: 'disconnected',
        enabled: true,
        engineId: 'codex',
      },
    ]),
    reloadAgents: vi.fn().mockResolvedValue(undefined),
    logger: { warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
  return { app: createEnrichedAgentRoutes(deps as any), deps };
}

describe('registry-backed enriched Agent routes', () => {
  test('keeps Station fallback prompt distinct from description and supports legacy metadata', async () => {
    const metadata = [
      {
        slug: 'station',
        name: 'Station',
        description: 'Visible description',
        prompt: 'Persisted system prompt',
      },
    ];
    const { app } = setup({
      agentMetadataMap: new Map(metadata.map((agent) => [agent.slug, agent])),
      listAgents: async () => metadata,
    });
    const current = await json(await app.request('/station'));
    expect(current.data).toMatchObject({
      description: 'Visible description',
      prompt: 'Persisted system prompt',
    });

    const legacy = [
      { slug: 'station', name: 'Station', description: 'Legacy prompt' },
    ];
    const legacyRoute = setup({
      agentMetadataMap: new Map(legacy.map((agent) => [agent.slug, agent])),
      listAgents: async () => legacy,
    });
    expect(
      (await json(await legacyRoute.app.request('/station'))).data.prompt,
    ).toBe('Legacy prompt');
  });

  test('projects the enforced built-in denial catalog separately from Agent-configured denials', async () => {
    const writerSpec = {
      name: 'Writer',
      prompt: 'Write.',
      delegation: { blockedTools: ['filesystem_delete_*'] },
    };
    const { app } = setup({
      loadAgent: vi.fn(async (slug: string) => {
        if (slug === 'writer') return writerSpec;
        throw new Error('registry defaults are not stored as authored Agents');
      }),
    });

    const body = await json(await app.request('/writer'));

    expect(body).toMatchObject({
      success: true,
      data: {
        delegation: writerSpec.delegation,
        deniedCommandCatalog: {
          operatorConfigured: [
            {
              pattern: 'filesystem_delete_*',
              refusal:
                "Refuses a delegated child from using tools matching 'filesystem_delete_*' because this Agent is configured to deny them.",
            },
          ],
        },
      },
    });
    expect(body.data.deniedCommandCatalog.builtIn).toEqual([
      {
        pattern: 'station-control_send_message',
        refusal:
          'Refuses a delegated child from sending messages through Station control.',
      },
      {
        pattern: 'station-control_delegate_task',
        refusal: 'Refuses a delegated child from delegating additional tasks.',
      },
      {
        pattern: 'station-control_add_*',
        refusal:
          'Refuses a delegated child from adding Station-managed resources.',
      },
      {
        pattern: 'station-control_create_*',
        refusal:
          'Refuses a delegated child from creating Station-managed resources.',
      },
      {
        pattern: 'station-control_delete_*',
        refusal:
          'Refuses a delegated child from deleting Station-managed resources.',
      },
      {
        pattern: 'station-control_run_job',
        refusal: 'Refuses a delegated child from starting scheduled jobs.',
      },
      {
        pattern: 'station-control_update_*',
        refusal:
          'Refuses a delegated child from changing Station-managed resources.',
      },
      {
        pattern: 'station-control_remove_*',
        refusal:
          'Refuses a delegated child from removing Station-managed resources.',
      },
      {
        pattern: 'station-control_connect_*',
        refusal:
          'Refuses a delegated child from connecting managed environments.',
      },
      {
        pattern: 'station-control_disconnect_*',
        refusal:
          'Refuses a delegated child from disconnecting managed environments.',
      },
    ]);

    const enforcedContext = createChildDelegationContext({
      agentSlug: 'writer',
      spec: writerSpec,
    });
    expect(enforcedContext.blockedTools).toEqual([
      ...body.data.deniedCommandCatalog.builtIn.map(
        (denial: { pattern: string }) => denial.pattern,
      ),
      'filesystem_delete_*',
    ]);
  });

  test('retries past a transient runtime-generation change and serves a stable catalog', async () => {
    // Attempt 1 straddles a revision bump (7 → 8); attempt 2 reads under a
    // stable 8. The route must resolve this itself instead of telling the
    // caller to retry (archive#1574).
    const getAgentConfigurationRevision = vi
      .fn()
      .mockReturnValueOnce(7)
      .mockReturnValue(8);
    const { app } = setup({ getAgentConfigurationRevision });

    const body = await json(await app.request('/'));
    expect(body.success).toBe(true);
    expect(body.catalogState).toBeUndefined();
    expect(body.data).not.toHaveLength(0);
    for (const agent of body.data) {
      expect(agent.unavailableReason ?? '').not.toMatch(/catalog/i);
    }
  });

  test('degrades honestly when the runtime never stabilizes and no stable catalog exists', async () => {
    let revision = 0;
    const getAgentConfigurationRevision = vi.fn(() => {
      revision += 1;
      return revision;
    });
    const { app } = setup({ getAgentConfigurationRevision });

    const body = await json(await app.request('/'));
    expect(body.success).toBe(true);
    expect(body.catalogState).toBe('reconciling');
    expect(body.data).not.toHaveLength(0);
    expect(body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          available: false,
          unavailableReason: CATALOG_REFRESHING_REASON,
        }),
      ]),
    );
  });

  test('serves the last stable catalog while the runtime is reconciling', async () => {
    let unstable = false;
    let revision = 0;
    const getAgentConfigurationRevision = vi.fn(() => {
      if (unstable) {
        revision += 1;
        return revision;
      }
      return 5;
    });
    const { app } = setup({ getAgentConfigurationRevision });

    const stableBody = await json(await app.request('/'));
    expect(stableBody.success).toBe(true);
    expect(stableBody.catalogState).toBeUndefined();

    unstable = true;
    const reconcilingBody = await json(await app.request('/'));
    expect(reconcilingBody.success).toBe(true);
    expect(reconcilingBody.catalogState).toBe('reconciling');
    expect(typeof reconcilingBody.catalogAsOf).toBe('string');
    // The cached catalog keeps its real availability — agents must not
    // collapse to unavailable just because the runtime is mid-refresh.
    expect(reconcilingBody.data).toEqual(stableBody.data);
  });

  describe('two Agents bound to one engine are told apart', () => {
    // Station never deletes a user's file to resolve a duplicate binding, so
    // the catalog can legitimately contain two. Rendering them as two
    // identical rows made one engine read as two Agents and hid which one the
    // seeding path actually adopted.
    function duplicateBindingSetup() {
      const metadata = [
        {
          slug: 'codex',
          name: 'Codex',
          execution: { agentConnectionId: engineConnectionId('codex') },
        },
        {
          slug: 'codex-agent',
          name: 'Codex Agent',
          execution: { agentConnectionId: engineConnectionId('codex') },
        },
        {
          slug: 'writer',
          name: 'Writer',
        },
      ];
      return setup({
        agentMetadataMap: new Map(metadata.map((agent) => [agent.slug, agent])),
        listAgents: vi.fn().mockResolvedValue(metadata),
        getDefaultAgentIds: vi.fn().mockResolvedValue(new Set()),
        loadAgent: vi.fn(async (slug: string) => {
          const agent = metadata.find((entry) => entry.slug === slug);
          if (!agent) throw new Error('not found');
          return { name: agent.name, execution: agent.execution };
        }),
      });
    }

    test('the canonical row is unmarked and the other says what it is also bound to', async () => {
      const { app } = duplicateBindingSetup();
      const body = await json(await app.request('/'));
      const bySlug = Object.fromEntries(
        body.data.map((agent: any) => [agent.slug, agent]),
      );
      // `codex` occupies the engine's canonical slug, so it is the engine's
      // Agent — the same rule `materializeEngineAgent` adopts by.
      expect(bySlug.codex.secondaryEngineBinding).toBeUndefined();
      expect(bySlug['codex-agent'].secondaryEngineBinding).toEqual({
        engineDisplayName: 'Codex',
      });
      // An Agent bound to nothing is never marked.
      expect(bySlug.writer.secondaryEngineBinding).toBeUndefined();
    });

    test('a single bound Agent is never marked', async () => {
      const { app } = setup();
      const body = await json(await app.request('/'));
      expect(
        body.data.every(
          (agent: any) => agent.secondaryEngineBinding === undefined,
        ),
      ).toBe(true);
    });

    test('a slug-filtered read makes no claim about a set it cannot see', async () => {
      // The marker is a statement ABOUT a set. A detail read has one row, so
      // asserting anything there would be a guess.
      const { app } = duplicateBindingSetup();
      const body = await json(await app.request('/codex-agent'));
      expect(body.data.slug).toBe('codex-agent');
      expect(body.data.secondaryEngineBinding).toBeUndefined();
    });
  });

  test('an abandoned activation is carried on the projection, with its reason', async () => {
    // The catalog is where the editor reads this from, so the record has to
    // travel with the row rather than being inferred from a failed request.
    const { app } = setup({
      getActivationFailure: (slug: string) =>
        slug === 'writer'
          ? {
              reason: 'prompt template references a missing variable',
              at: '2026-08-20T00:00:00.000Z',
            }
          : undefined,
    });
    const body = await json(await app.request('/'));
    const bySlug = Object.fromEntries(
      body.data.map((agent: any) => [agent.slug, agent]),
    );
    expect(bySlug.writer.activationFailure).toEqual({
      reason: 'prompt template references a missing variable',
      at: '2026-08-20T00:00:00.000Z',
    });
    expect(bySlug.codex.activationFailure).toBeUndefined();
  });

  test('detail reads resolve only the requested agent, never the whole catalog', async () => {
    const { app, deps } = setup();

    const body = await json(await app.request('/codex'));
    expect(body.success).toBe(true);
    expect(body.data.slug).toBe('codex');
    // archive#1574 review HIGH: the detail route briefly paid O(catalog) spec loads
    // per request. The bound is what matters — AT MOST the requested slug,
    // never an unrelated authored agent like 'writer'.
    //
    // It is exactly one load rather than zero because a registry identity may
    // now be MATERIALIZED: the file, when there is one, is the real Agent and
    // outranks the projection, and asking the loader is the only way to find
    // out. Registry-default rows are the fallback for a MISSING file, not a
    // reason to skip the read.
    expect(deps.loadAgent.mock.calls).toEqual([['codex']]);
  });

  test('a slug missing from metadata 404s without burning catalog retries', async () => {
    let revision = 0;
    const getAgentConfigurationRevision = vi.fn(() => {
      revision += 1;
      return revision;
    });
    const { app, deps } = setup({ getAgentConfigurationRevision });

    const response = await app.request('/no-such-agent');
    expect(response.status).toBe(404);
    expect(deps.loadAgent).not.toHaveBeenCalled();
  });

  test('a listed slug whose spec load fails transiently keeps its retries', async () => {
    // Attempt 1: unstable AND the authored agent's file is mid-write
    // (loadAgent throws). Attempt 2: stable and readable. The early-exit
    // for unknown slugs must not swallow this retry (archive#1574 delta review).
    const getAgentConfigurationRevision = vi
      .fn()
      .mockReturnValueOnce(7)
      .mockReturnValue(8);
    const loadAgent = vi
      .fn()
      .mockRejectedValueOnce(new Error('mid-write'))
      .mockResolvedValue({ name: 'Writer', prompt: 'Write.' });
    const { app } = setup({ getAgentConfigurationRevision, loadAgent });

    const body = await json(await app.request('/writer'));
    expect(body.success).toBe(true);
    expect(body.data.slug).toBe('writer');
    expect(body.catalogState).toBeUndefined();
    expect(loadAgent).toHaveBeenCalledTimes(2);
  });

  test('a delayed older stable read cannot clobber a fresher cached catalog', async () => {
    const metadataFull = [
      { slug: 'station', name: 'Station' },
      { slug: 'writer', name: 'Writer' },
    ];
    const metadataShrunk = [{ slug: 'station', name: 'Station' }];
    let revisionValue = 10;
    let metadataValue = metadataFull;
    const listAgents = vi.fn(async () => metadataValue);
    const getAgentConfigurationRevision = vi.fn(() => revisionValue);
    const { app } = setup({
      listAgents,
      getAgentConfigurationRevision,
      getDefaultAgentIds: vi.fn().mockResolvedValue(new Set(['station'])),
    });

    // Fresh snapshot at revision 10 with both agents.
    const fresh = await json(await app.request('/'));
    expect(fresh.data).toHaveLength(2);

    // A straggler that captured revision 9 (pre-change) finishes later with
    // different content: its stable read must NOT replace the rev-10 cache.
    revisionValue = 9;
    metadataValue = metadataShrunk;
    await json(await app.request('/'));

    // Runtime goes unstable: the served cache must still be the rev-10 one.
    let drift = 100;
    getAgentConfigurationRevision.mockImplementation(() => {
      drift += 1;
      return drift;
    });
    const reconciling = await json(await app.request('/'));
    expect(reconciling.catalogState).toBe('reconciling');
    expect(reconciling.data).toHaveLength(2);
  });

  test('an expired cache degrades honestly instead of serving ancient data', async () => {
    let unstable = false;
    let revision = 0;
    const getAgentConfigurationRevision = vi.fn(() => {
      if (unstable) {
        revision += 1;
        return revision;
      }
      return 5;
    });
    const { app } = setup({ getAgentConfigurationRevision });

    await json(await app.request('/'));
    unstable = true;

    const realNow = Date.now();
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => realNow + 6 * 60_000);
    try {
      const body = await json(await app.request('/'));
      expect(body.catalogState).toBe('reconciling');
      expect(body.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            available: false,
            unavailableReason: CATALOG_REFRESHING_REASON,
          }),
        ]),
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('lists exact registry defaults even when their engine is unavailable', async () => {
    const { app } = setup();
    const body = await json(await app.request('/'));

    expect(body.success).toBe(true);
    expect(body.data.map((agent: any) => agent.slug)).toEqual([
      'station',
      'codex',
      'writer',
    ]);
    expect(
      body.data.find((agent: any) => agent.slug === 'station'),
    ).toMatchObject({
      engineDefault: true,
      engineId: 'station',
      engineDisplayName: 'Station',
    });
    expect(
      body.data.find((agent: any) => agent.slug === 'codex'),
    ).toMatchObject({
      engineDefault: true,
      engineId: 'codex',
      engineDisplayName: 'Codex',
      execution: { agentConnectionId: 'codex' },
      available: false,
      // archive#3027: the authored-spec gate outranks connection status —
      // an engine default without an authored Agent is unavailable whether
      // or not its engine connection is up.
      unavailableReason: expect.stringMatching(
        /no authored Agent definition.*creating an Agent/i,
      ),
      unavailableFix: { kind: 'connection-broken', target: 'codex' },
    });
    // The enable remedy requires a USABLE connection: this fixture's codex
    // connection is 'disconnected', so offering one-click Enable would
    // overclaim — the created Agent would be equally unstartable.
    expect(
      body.data.find((agent: any) => agent.slug === 'codex').enable,
    ).toBeUndefined();
    expect(
      body.data.find((agent: any) => agent.slug === 'station').enable,
    ).toBeUndefined();
  });

  test('keeps the Station default Agent unavailable for its existing concrete readiness reason', async () => {
    const reason = 'No enabled LLM provider connection is configured.';
    const { app } = setup({
      activeAgents: new Map(),
      getDefaultAgentIds: vi.fn().mockResolvedValue(new Set(['station'])),
      listAgents: vi
        .fn()
        .mockResolvedValue([{ slug: 'station', name: 'Station' }]),
      getRuntimeConnections: vi.fn().mockResolvedValue([]),
      resolveAvailability: vi.fn(() => reason),
    });

    const body = await json(await app.request('/'));
    expect(body.data).toEqual([
      expect.objectContaining({
        slug: 'station',
        available: false,
        unavailableReason: reason,
        unavailableFix: { kind: 'model-connection' },
      }),
    ]);
    // Station's own default is never an engine-default alias awaiting an
    // authored spec — even unavailable, it must not carry the enable signal.
    expect(body.data[0].enable).toBeUndefined();
  });

  test('does not manufacture an Agent from an unregistered runtime connection', async () => {
    const { app } = setup({
      getRuntimeConnections: vi.fn().mockResolvedValue([
        {
          id: 'orphan-runtime',
          type: 'acp',
          name: 'Orphan',
          status: 'ready',
          enabled: true,
          engineId: 'orphan',
        },
      ]),
    });
    const body = await json(await app.request('/'));
    expect(
      body.data.some((agent: any) => agent.slug === 'orphan-runtime'),
    ).toBe(false);
  });

  test('marks a registry default unavailable with the enable remedy even when its engine is ready (#3027)', async () => {
    // A ready engine connection is not an authored Agent: the symmetric
    // authored-spec gate refuses every non-station engine default until the
    // user enables the engine by creating an Agent for it.
    const { app } = setup({
      getRuntimeConnections: vi.fn().mockResolvedValue([
        {
          id: 'codex',
          type: 'codex-runtime',
          name: 'Codex',
          status: 'ready',
          enabled: true,
          engineId: 'codex',
        },
      ]),
    });
    const body = await json(await app.request('/'));
    const codex = body.data.find((agent: any) => agent.slug === 'codex');
    expect(codex.available).toBe(false);
    expect(codex.unavailableReason).toMatch(
      /no authored Agent definition.*creating an Agent/i,
    );
    expect(codex.engineDefault).toBe(true);
    expect(codex.enable).toEqual({ engineConnectionId: 'codex' });
    // The promoted engine agent stays a plain engine identity. The selected
    // built-in Station agent (not this record) owns station-control.
    expect(codex.toolsConfig).toBeUndefined();
  });

  test('withholds the enable signal when the alias has no bound engine connection (#3027)', async () => {
    // `enable` promises a concrete connection to bind the created Agent to;
    // with the connection gone from the runtime inventory there is nothing
    // honest to offer, so the row keeps only its reason.
    const { app } = setup({
      getRuntimeConnections: vi.fn().mockResolvedValue([]),
    });
    const body = await json(await app.request('/'));
    const codex = body.data.find((agent: any) => agent.slug === 'codex');
    expect(codex.available).toBe(false);
    expect(codex.enable).toBeUndefined();
  });

  test('gets defaults only by their exact public id', async () => {
    const { app } = setup();
    const exact = await app.request('/codex');
    const internal = await app.request('/codex-runtime');
    expect(exact.status).toBe(200);
    expect((await json(exact)).data.slug).toBe('codex');
    expect(internal.status).toBe(404);
  });

  test('returns authored Agent data when optional detail attribution stalls', async () => {
    vi.useFakeTimers();
    try {
      let reportAttributionStarted: () => void = () => {};
      const attributionStarted = new Promise<void>((resolve) => {
        reportAttributionStarted = resolve;
      });
      const { app, deps } = setup({
        getRuntimeConnections: vi.fn(() => {
          reportAttributionStarted();
          return new Promise<never>(() => {});
        }),
      });

      const responsePromise = app.request('/writer');
      await attributionStarted;
      await vi.advanceTimersByTimeAsync(1_000);
      const response = await responsePromise;
      const body = await json(response);

      expect(response.status).toBe(200);
      expect(body.data).toMatchObject({
        slug: 'writer',
        name: 'Writer',
        prompt: 'Write.',
      });
      expect(deps.logger.warn).toHaveBeenCalledWith(
        'Runtime connection attribution timed out; continuing without it',
        { timeoutMs: 1_000 },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not mark a bound external Agent unavailable when detail attribution stalls', async () => {
    vi.useFakeTimers();
    try {
      let reportAttributionStarted: () => void = () => {};
      const attributionStarted = new Promise<void>((resolve) => {
        reportAttributionStarted = resolve;
      });
      const { app } = setup({
        getRuntimeConnections: vi.fn(() => {
          reportAttributionStarted();
          return new Promise<never>(() => {});
        }),
      });

      const responsePromise = app.request('/codex');
      await attributionStarted;
      await vi.advanceTimersByTimeAsync(1_000);
      const body = await json(await responsePromise);

      expect(body.success).toBe(true);
      expect(body.data).toMatchObject({
        slug: 'codex',
        execution: { agentConnectionId: 'codex' },
      });
      expect(body.data.available).toBeUndefined();
      expect(body.data.unavailableReason).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test('projects an exact default binding without loading an authored spec', async () => {
    const { app, deps } = setup();
    const response = await app.request('/codex/binding');
    expect(response.status).toBe(200);
    expect((await json(response)).data).toEqual({
      agentConnectionId: 'codex',
      engineId: 'codex',
    });
    expect(deps.loadAgent).not.toHaveBeenCalledWith('codex');
  });

  test('external readiness requires an enabled ready external engine', () => {
    expect(
      isHonestlyAvailableConnectedAgent(
        {
          name: 'Codex',
          prompt: '',
          execution: { agentConnectionId: engineConnectionId('codex') },
        },
        new Map([
          [
            'codex',
            {
              id: engineConnectionId('codex'),
              name: 'Codex',
              enabled: true,
              status: 'ready',
              engineId: engineId('codex'),
            },
          ],
        ]),
      ),
    ).toBe(true);
  });

  test('surfaces adapter readiness evidence for an authored bound Agent; the authored-spec gate outranks it for an engine default (#3027)', async () => {
    const { app } = setup({
      loadAgent: vi.fn(async (slug: string) => {
        if (slug === 'writer')
          return {
            name: 'Writer',
            prompt: 'Write.',
            execution: { agentConnectionId: engineConnectionId('codex') },
          };
        throw new Error('registry defaults are not stored as authored Agents');
      }),
      getRuntimeConnections: vi.fn().mockResolvedValue([
        {
          id: 'codex',
          type: 'codex-runtime',
          name: 'Codex',
          status: 'missing_prerequisites',
          enabled: true,
          engineId: 'codex',
          readinessReason: 'Codex CLI was not found on PATH.',
        },
      ]),
    });

    const body = await json(await app.request('/'));
    // An authored Agent bound to the broken engine keeps the concrete
    // adapter readiness evidence, never a generic default-Agent reason.
    const writer = body.data.find((agent: any) => agent.slug === 'writer');
    expect(writer).toMatchObject({
      available: false,
      unavailableReason: 'Codex CLI was not found on PATH.',
    });
    // An authored Agent unavailable for a connection reason is not
    // enableable — enabling creates an Agent, which this row already is.
    expect(writer.enable).toBeUndefined();
    // The spec-less engine default is unavailable for the authored-spec
    // reason regardless of adapter state (archive#3027).
    const codexAlias = body.data.find((agent: any) => agent.slug === 'codex');
    expect(codexAlias).toMatchObject({
      available: false,
      unavailableReason: expect.stringMatching(
        /no authored Agent definition.*creating an Agent/i,
      ),
    });
    // A connection with missing prerequisites is not usable, so the alias
    // must not offer one-click Enable over it (fix the connection first).
    expect(codexAlias.enable).toBeUndefined();
  });

  test('keeps a custom dependent visible and invalid after its engine default is deleted', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-agent-dependent-'));
    homes.push(home);
    const configLoader = new ConfigLoader({ projectHomeDir: home });
    await registerEngineConnection(configLoader, 'codex');
    await configLoader.createAgent({
      name: 'Writer',
      prompt: 'Write.',
      execution: { agentConnectionId: engineConnectionId('codex') },
    });

    await unregisterEngineConnection(configLoader, 'codex');

    const registry = await loadOrCreateAgentRegistry(configLoader);
    const authoredAgents = await configLoader.listAgents();
    const metadata = [
      ...registry.defaultAgents.map((entry) => ({
        slug: entry.id,
        name: entry.id === 'station' ? 'Station' : entry.id,
        ...(entry.kind === 'engine-connection'
          ? {
              execution: {
                agentConnectionId: entry.engineConnectionId,
              },
            }
          : {}),
      })),
      ...authoredAgents,
    ];
    const app = createEnrichedAgentRoutes({
      agentMetadataMap: new Map(metadata.map((agent) => [agent.slug, agent])),
      activeAgents: new Map(),
      loadAgent: (slug: string) => configLoader.loadAgent(slug),
      listAgents: async () => metadata,
      getDefaultAgentIds: async () =>
        new Set(registry.defaultAgents.map((entry) => entry.id)),
      defaultModel: 'managed-default',
      defaultTools: { mcpServers: ['station-control'], autoApprove: [] },
      getRuntimeConnections: async () => [],
      reloadAgents: async () => undefined,
      logger: { warn: vi.fn(), error: vi.fn() },
    } as any);

    const body = await json(await app.request('/'));

    expect(body.data.map((agent: any) => agent.slug)).toEqual([
      'station',
      'writer',
    ]);
    expect(
      body.data.find((agent: any) => agent.slug === 'writer'),
    ).toMatchObject({
      execution: { agentConnectionId: 'codex' },
      available: false,
      // archive#3742: a connection id is not a user noun. This branch fires
      // BECAUSE there is no connection record, so there is no name to use
      // either — the sentence says what is true without naming the thing that
      // is not there.
      unavailableReason:
        'The engine this agent runs on is no longer connected.',
    });
  });

  /**
   * archive#3742: every other branch DOES hold the connection record, and the
   * record carries the name its owner gave it. None of them may print the id.
   */
  test('an unavailable engine is named, never identified by its id', () => {
    const cases = [
      { enabled: false, status: 'ready', expected: 'Codex CLI is turned off.' },
      {
        enabled: true,
        status: 'missing_prerequisites',
        expected: 'Codex CLI is missing something it needs before it can run.',
      },
      {
        enabled: true,
        status: 'degraded',
        expected: 'Codex CLI is only partly working.',
      },
      {
        enabled: true,
        status: 'error',
        expected: 'Codex CLI failed its readiness check.',
      },
      {
        enabled: true,
        status: 'disconnected',
        expected: 'Codex CLI is disconnected.',
      },
      {
        enabled: true,
        status: 'unavailable',
        expected: 'Codex CLI is unavailable.',
      },
      {
        enabled: true,
        status: 'unprobed',
        expected: 'Codex CLI has not been checked yet.',
      },
      {
        enabled: true,
        status: 'something-new',
        expected: 'Codex CLI is not ready.',
      },
    ];
    for (const testCase of cases) {
      const reason = externalEngineUnavailable(
        'codex',
        new Map([
          [
            'codex',
            {
              id: 'codex',
              name: 'Codex CLI',
              type: 'codex-runtime',
              enabled: testCase.enabled,
              status: testCase.status,
              capabilities: ['agent-runtime'],
            },
          ],
        ]) as never,
      ).reason;
      expect(reason).toBe(testCase.expected);
      expect(reason).not.toContain("'codex'");
    }
  });
  // archive#2845 review round: the readiness derivation asks for the adapter
  // `provider`, and the agreement test supplies it by hand. That leaves the
  // one thing production actually depends on untested — the projection from a
  // live runtime connection to the summary this route consumes. The first fix
  // added `provider` to a DIFFERENT projection of the same shape, so
  // production still read `undefined` and advertised the alias startable
  // while every hand-supplied test stayed green. This drives the real
  // projection instead.
  test('the runtime-connection projection carries the adapter provider, not just the runtime type', () => {
    const summary = runtimeConnectionSummary({
      id: 'claude' as never,
      type: 'claude-runtime',
      name: 'Claude Code',
      enabled: true,
      status: 'ready',
      config: { provider: 'claude', engineId: 'claude' },
      parseEngineId: (value) => value as never,
    });

    // `type` is a runtime selector and is NOT the provider — reading it as
    // one is the mistake this pins.
    expect(summary.type).toBe('claude-runtime');
    expect(summary.provider).toBe('claude');
  });

  test('the runtime-connection projection leaves provider undefined when the config carries none', () => {
    const summary = runtimeConnectionSummary({
      id: 'opencode' as never,
      type: 'acp-runtime',
      name: 'OpenCode',
      enabled: true,
      status: 'ready',
      config: {},
      parseEngineId: (value) => value as never,
    });

    expect(summary.provider).toBeUndefined();
  });
});

describe('the built-in engine selection is the RUNTIME projection (#3662 review HIGH-3)', () => {
  /**
   * The route's `loadAgent`/`listAgents` deps are `AgentService.getAgent` /
   * `AgentService.listAgents`, exactly as `runtime-routes.ts` wires them.
   *
   * That composition IS the fix for the delta's H3: round 1 applied the
   * Station-identity overlay inside this route, so these tests passed while
   * two other readers of the same records (`/:slug/binding` and the
   * save-response validation) saw the raw file. Injecting a hand-projected
   * `loadAgent` here would test the fixture, not the seam.
   */
  function serviceBackedDeps(options: {
    agentMetadataMap: Map<string, unknown>;
    storedMetadata: Array<Record<string, unknown>>;
    loadAgent: (slug: string) => Promise<Record<string, unknown>>;
  }) {
    const configLoader = {
      listAgents: async () => options.storedMetadata,
      loadAgent: options.loadAgent,
      loadACPConfig: async () => ({ connections: [] }),
    };
    const service = new AgentService(
      configLoader as never,
      { findLayoutsUsingAgent: () => [] } as never,
      new Map(),
      options.agentMetadataMap as never,
      new Map(),
      { warn: vi.fn(), error: vi.fn() },
    );
    return {
      agentMetadataMap: options.agentMetadataMap,
      loadAgent: (slug: string) => service.getAgent(slug),
      listAgents: () => service.listAgents(),
    };
  }

  /**
   * A home whose `builtinAgentEngineConnectionId` names Codex. The runtime
   * resolves that per boot, builds NO Station instance, and records the
   * binding under its internal `default` key — the persisted
   * `agents/station/agent.json` is (correctly) unbound, because the binding
   * is derived from live readiness and must not be frozen into the record.
   */
  function codexBuiltinHome() {
    const runtimeDefault = {
      slug: 'default',
      name: 'Station',
      execution: { agentConnectionId: engineConnectionId('codex') },
    };
    const metadata = [
      { slug: 'station', name: 'Station' },
      { slug: 'codex', name: 'Codex' },
    ];
    return setup({
      // The Station instance was deliberately NOT built.
      activeAgents: new Map(),
      ...serviceBackedDeps({
        agentMetadataMap: new Map<string, unknown>([
          ...metadata.map((agent) => [agent.slug, agent] as const),
          ['default', runtimeDefault],
        ]),
        storedMetadata: metadata,
        // The persisted record: healed, unbound, exactly as archive#3662 leaves it.
        loadAgent: async (slug: string) => {
          if (slug === 'station') return { name: 'Station', prompt: '' };
          throw new Error(`no authored Agent for ${slug}`);
        },
      }),
      getDefaultAgentIds: vi.fn().mockResolvedValue(new Set(['station'])),
      getRuntimeConnections: vi.fn().mockResolvedValue([
        {
          id: 'codex',
          type: 'codex-runtime',
          provider: 'codex',
          name: 'Codex',
          status: 'ready',
          enabled: true,
          engineId: engineId('codex'),
        },
      ]),
    });
  }

  test('the catalog reports Codex, not Station, for the Station Agent', async () => {
    // Before this fix the catalog preferred the unbound persisted record, so
    // it advertised Station-engine execution on a home deliberately
    // configured for Codex — and `resolveExecutionTarget`, which resolves
    // through this very projection, would have dispatched into a Station
    // runtime that was never built.
    const { app } = codexBuiltinHome();
    const body = await json(await app.request('/station'));

    expect(body.data.execution).toEqual({
      agentConnectionId: 'codex',
    });
    expect(body.data.engineId).toBe('codex');
    expect(body.data.engineDisplayName).toBe('Codex');
    // And it is launchable through that engine rather than unavailable.
    expect(body.data.available).not.toBe(false);
  });

  test('never chips itself "Station" when the runtime bound it elsewhere', async () => {
    // Found live: the detail read bounds connection attribution, and when it
    // is unavailable the payload used to assert Station from the SLUG alone —
    // so a home configured for Codex showed `execution.agentConnectionId:
    // 'codex'` beside an engine chip reading "Station".
    const { app } = codexBuiltinHome();
    const body = await json(await app.request('/station'));
    expect(body.data.execution).toEqual({ agentConnectionId: 'codex' });
    expect(body.data.engineId).not.toBe('station');
    expect(body.data.engineDisplayName).not.toBe('Station');
  });

  test('the list projection agrees with the detail read', async () => {
    const { app } = codexBuiltinHome();
    const body = await json(await app.request('/'));
    const station = (body.data as Array<Record<string, any>>).find(
      (agent) => agent.slug === 'station',
    );
    expect(station?.execution).toEqual({ agentConnectionId: 'codex' });
  });

  test('an UNHEALED record is never honoured by the catalog (review MEDIUM-2)', async () => {
    // The heal is a startup write that a read-only home does not get to make.
    // Correctness must not depend on it: the catalog refuses a binding the
    // registry could never have created, so `resolveExecutionTarget` — which
    // resolves through this projection — still dispatches to Station's own
    // engine instead of failing on a connection that cannot exist.
    const metadata = [{ slug: 'station', name: 'Station' }];
    const { app } = setup({
      activeAgents: new Map([['default', {}]]),
      ...serviceBackedDeps({
        agentMetadataMap: new Map<string, unknown>([['station', metadata[0]]]),
        storedMetadata: metadata,
        // Exactly what an unhealed home still has on disk.
        loadAgent: async (slug: string) => {
          if (slug === 'station') {
            return {
              name: 'Station',
              prompt: '',
              execution: {
                agentConnectionId: 'station',
                modelId: 'pinned-model',
              },
            };
          }
          throw new Error(`no authored Agent for ${slug}`);
        },
      }),
      getDefaultAgentIds: vi.fn().mockResolvedValue(new Set(['station'])),
      getRuntimeConnections: vi.fn().mockResolvedValue([]),
    });

    const body = await json(await app.request('/station'));
    expect(body.data.execution).toEqual({ modelId: 'pinned-model' });
    expect(body.data.engineId).toBe('station');
    expect(body.data.available).not.toBe(false);
  });

  test('GET /:slug/binding answers from the same projection (delta M2)', async () => {
    // The endpoint `station chat` reads to choose its managed-vs-external
    // session read model. Round 1 left it rebuilding from the raw record, so
    // it answered "unbound" — Station's own engine — on the very home the
    // catalog was correctly reporting as Codex, and the CLI picked the wrong
    // read model for every session on that home.
    const { app } = codexBuiltinHome();
    const response = await app.request('/station/binding');

    expect(response.status).toBe(200);
    expect((await json(response)).data).toEqual({
      agentConnectionId: 'codex',
      engineId: 'codex',
    });
  });

  test('GET /:slug/binding never returns the impossible station binding', async () => {
    // The unwritable-home case: the record still says `station`, an engine
    // connection that structurally cannot exist, and the CLI would have been
    // handed it verbatim.
    const metadata = [{ slug: 'station', name: 'Station' }];
    const { app } = setup({
      activeAgents: new Map([['default', {}]]),
      ...serviceBackedDeps({
        agentMetadataMap: new Map<string, unknown>([['station', metadata[0]]]),
        storedMetadata: [
          {
            slug: 'station',
            name: 'Station',
            execution: { agentConnectionId: 'station' },
          },
        ],
        loadAgent: async () => ({
          name: 'Station',
          prompt: '',
          execution: { agentConnectionId: 'station' },
        }),
      }),
      getDefaultAgentIds: vi.fn().mockResolvedValue(new Set(['station'])),
      getRuntimeConnections: vi.fn().mockResolvedValue([]),
    });

    const response = await app.request('/station/binding');
    expect(response.status).toBe(200);
    expect((await json(response)).data).toEqual({});
  });

  test('with NO runtime binding the persisted record still governs', () => {
    // The overlay is not a blanket override: a home running on Station's own
    // engine records no binding, and the file is then the only statement.
    expect(
      runtimeStationEngineExecution(
        new Map([['default', { slug: 'default', name: 'Station' } as never]]),
      ),
    ).toBeUndefined();
    expect(
      runtimeStationEngineExecution(
        new Map([
          [
            'default',
            {
              slug: 'default',
              name: 'Station',
              execution: { agentConnectionId: engineConnectionId('claude') },
            },
          ],
        ]),
      ),
    ).toEqual({ agentConnectionId: 'claude' });
  });
});
