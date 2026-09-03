import type { ACPStatusValue } from '@kontourai/station-contracts/acp';
import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import { describe, expect, test, vi } from 'vitest';
import { setProviderAdapterRegistrationProvenance } from '../../../providers/adapter-shape.js';
import { AcpAdapter } from '../../../providers/adapters/acp-adapter.js';
import { createConnectionInspector } from '../connection-inspector.js';

describe('ConnectionInspector Interface', () => {
  function adapter(provider: string, overrides: Record<string, unknown> = {}) {
    const { metadata: metadataOverrides, ...methods } = overrides;
    return {
      provider,
      metadata: {
        displayName: `${provider} Runtime`,
        description: 'test',
        capabilities: [],
        engineId: provider,
        ...((metadataOverrides as object | undefined) ?? {}),
      },
      getPrerequisites: async () => [],
      ...methods,
    } as any;
  }

  function inspector(adapter: any) {
    setProviderAdapterRegistrationProvenance(adapter, 'builtin');
    return createConnectionInspector({
      adapters: () => [adapter],
      appConfig: () =>
        ({
          agentConnections: { codex: { enabled: true, config: {} } },
        }) as any,
      acpConnections: () => [],
      acpStatus: () => ({}),
      publicConnection: (runtimeId) => ({
        id: engineConnectionId('codex'),
        engineId: runtimeId,
      }),
      now: () => Date.parse('2026-08-13T00:00:00.000Z'),
    });
  }

  // #1208 review: the engine's catalog is decorated with reviewed identity
  // keyed on (engine family, id). `sonnet` from the Claude Code engine is a
  // reviewed route; the identical id from another engine carries nothing.
  test('decorates an engine catalog with identity qualified by the engine', async () => {
    const catalogOf = async (engineId: string) => {
      const subject = inspector({
        provider: engineId,
        metadata: {
          displayName: engineId,
          description: 'test',
          capabilities: [],
          engineId,
        },
        getPrerequisites: vi.fn(async () => []),
        listModels: vi.fn(async () => [
          { id: 'sonnet', name: 'Sonnet', originalId: 'sonnet' },
          { id: 'other', name: 'Other', originalId: 'other' },
        ]),
      });
      const result = (await subject.inspect({
        kind: 'runtime-capability-inventory',
      })) as {
        connections: Array<{
          runtimeCatalog?: {
            models: Array<{
              id: string;
              canonicalModelIdentity?: { canonicalId: string };
            }>;
          };
        }>;
      };
      return result.connections[0]?.runtimeCatalog?.models ?? [];
    };
    const claude = await catalogOf('claude');
    expect(
      claude.find((m) => m.id === 'sonnet')?.canonicalModelIdentity
        ?.canonicalId,
    ).toBe('anthropic:claude-sonnet-4-5');
    expect(
      claude.find((m) => m.id === 'other')?.canonicalModelIdentity,
    ).toBeUndefined();
    const codex = await catalogOf('codex');
    expect(
      codex.find((m) => m.id === 'sonnet')?.canonicalModelIdentity,
    ).toBeUndefined();
  });

  test('owns catalog fallback, prerequisite and command contributions behind a public identity', async () => {
    const listModels = vi.fn(async () => [
      { id: 'gpt', name: 'GPT', originalId: 'gpt' },
    ]);
    const subject = inspector({
      provider: 'codex',
      metadata: {
        displayName: 'Codex Runtime',
        description: 'test',
        capabilities: [],
        engineId: 'codex',
      },
      getPrerequisites: vi.fn(async () => []),
      listModels,
      getCommands: vi.fn(async () => [
        { name: 'resume', description: 'Resume', passthrough: true },
      ]),
    });
    await expect(
      subject.inspect({ kind: 'runtime-capability-inventory' }),
    ).resolves.toMatchObject({
      kind: 'inspected',
      freshness: 'live',
      provenance: 'adapter-observation',
      partial: false,
      connections: [
        expect.objectContaining({
          id: 'codex',
          runtimeCatalog: expect.objectContaining({ source: 'live' }),
        }),
      ],
    });
    expect(listModels).toHaveBeenCalledOnce();
  });

  test('reports partial stale provenance when live catalog fails and built-ins remain', async () => {
    const subject = inspector({
      provider: 'codex',
      metadata: {
        displayName: 'Codex Runtime',
        description: 'test',
        capabilities: [],
        engineId: 'codex',
        knownModels: [{ id: 'fallback', name: 'Fallback' }],
      },
      getPrerequisites: vi.fn(async () => []),
      listModelCatalog: vi.fn(async () => {
        throw new Error('offline');
      }),
    });
    await expect(
      subject.inspect({ kind: 'runtime-capability-inventory' }),
    ).resolves.toMatchObject({
      kind: 'inspected',
      freshness: 'stale',
      provenance: 'adapter-and-built-in',
      connections: [
        expect.objectContaining({
          runtimeCatalog: expect.objectContaining({ source: 'built-in' }),
        }),
      ],
    });
  });

  test('returns a total aborted outcome and preserves retry semantics', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));
    const subject = inspector({
      provider: 'codex',
      metadata: {
        displayName: 'Codex Runtime',
        description: 'test',
        capabilities: [],
        engineId: 'codex',
      },
      getPrerequisites: vi.fn(async () => []),
    });
    await expect(
      subject.inspect({
        kind: 'runtime-capability-inventory',
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({
      kind: 'aborted',
      retry: 'on-next-inspection',
      partial: true,
    });
  });

  test('classifies a typed timeout separately from a caller abort', async () => {
    const subject = inspector(
      adapter('codex', {
        getPrerequisites: () => new Promise(() => undefined),
      }),
    );
    await expect(
      subject.inspect({
        kind: 'runtime-capability-inventory',
        signal: AbortSignal.timeout(1),
      }),
    ).resolves.toMatchObject({ kind: 'timed-out', partial: true });
  });

  test('does not project ACP-only inventory after caller abort or timeout', async () => {
    const base = () =>
      createConnectionInspector({
        adapters: () => [],
        appConfig: () => ({}) as any,
        acpConnections: () => [{ id: 'kiro', enabled: true }] as any,
        acpStatus: () => ({}),
        publicConnection: (runtimeId) => ({
          id: engineConnectionId('kiro'),
          engineId: runtimeId,
        }),
        now: () => Date.now(),
      });
    const aborted = new AbortController();
    aborted.abort(new Error('cancel'));
    await expect(
      base().inspect({
        kind: 'runtime-capability-inventory',
        signal: aborted.signal,
      }),
    ).resolves.toMatchObject({ kind: 'aborted', connections: [] });
    const timeout = AbortSignal.timeout(1);
    await new Promise((resolve) => setTimeout(resolve, 2));
    await expect(
      base().inspect({ kind: 'runtime-capability-inventory', signal: timeout }),
    ).resolves.toMatchObject({ kind: 'timed-out', connections: [] });
  });

  // archive#3344 (review HIGH-1). The ACP view is the ONLY capability source
  // the composer sees for an ACP session, and this branch hand-builds it
  // rather than reading the adapter — so its capability list had quietly lost
  // `image-input` while `acp-adapter.ts` declared it, built real image
  // ContentBlocks, and the server's pre-dispatch gate accepted them. The
  // composer refused a turn the server would have run. This asserts the
  // built view against the adapter's OWN declaration, so re-hardcoding a
  // literal here fails rather than drifting.
  test('the ACP connection view carries every capability the ACP adapter declares', async () => {
    const subject = createConnectionInspector({
      adapters: () => [],
      appConfig: () => ({}) as any,
      acpConnections: () => [{ id: 'kiro', enabled: true }] as any,
      acpStatus: () => ({
        connections: [{ id: 'kiro', status: 'available' }],
      }),
      publicConnection: (runtimeId) => ({
        id: engineConnectionId('kiro'),
        engineId: runtimeId,
      }),
      now: () => Date.now(),
    });

    const outcome = await subject.inspect({
      kind: 'runtime-capability-inventory',
    });
    const view = outcome.connections.find(
      (connection) => connection.type === 'acp',
    );
    expect(view).toBeDefined();

    const declared = new AcpAdapter({ getConnections: async () => [] }).metadata
      .capabilities;
    for (const capability of declared) {
      expect(view?.capabilities, `ACP view is missing ${capability}`).toContain(
        capability,
      );
    }
    // Named explicitly: this is the one the drift dropped, and the whole
    // composer path keys on it.
    expect(view?.capabilities).toContain('image-input');
  });

  test('keeps public and runtime identities distinct and omits an unmapped Adapter', async () => {
    const adapter = {
      provider: 'codex',
      metadata: {
        displayName: 'Codex Runtime',
        description: 'test',
        capabilities: [],
        engineId: 'codex',
      },
      getPrerequisites: vi.fn(async () => []),
    };
    setProviderAdapterRegistrationProvenance(adapter as any, 'builtin');
    const subject = createConnectionInspector({
      adapters: () => [adapter as any],
      appConfig: () => ({}) as any,
      acpConnections: () => [],
      acpStatus: () => ({}),
      publicConnection: () => undefined,
      now: () => Date.now(),
    });
    await expect(
      subject.inspect({ kind: 'runtime-capability-inventory' }),
    ).resolves.toMatchObject({ kind: 'inspected', connections: [] });
  });

  test('does not probe optional Adapter contributions when host discovery is disabled', async () => {
    const getPrerequisites = vi.fn(async () => {
      throw new Error('must not probe');
    });
    const listModels = vi.fn(async () => {
      throw new Error('must not probe');
    });
    const getCommands = vi.fn(async () => {
      throw new Error('must not probe');
    });
    const subject = inspector({
      provider: 'codex',
      metadata: {
        displayName: 'Codex Runtime',
        description: 'test',
        capabilities: [],
        engineId: 'codex',
      },
      getPrerequisites,
      listModels,
      getCommands,
    });
    await expect(
      subject.inspect({
        kind: 'runtime-capability-inventory',
        disableHostDiscovery: true,
      }),
    ).resolves.toMatchObject({
      kind: 'inspected',
      connections: [
        expect.objectContaining({ status: 'missing_prerequisites' }),
      ],
    });
    expect(getPrerequisites).not.toHaveBeenCalled();
    expect(listModels).not.toHaveBeenCalled();
    expect(getCommands).not.toHaveBeenCalled();
  });

  test('projects ACP status and commands through the same public identity Interface', async () => {
    const subject = createConnectionInspector({
      adapters: () => [],
      appConfig: () =>
        ({ agentConnections: { acp: { enabled: true } } }) as any,
      acpConnections: () =>
        [{ id: 'kiro', name: 'Kiro', enabled: true }] as any,
      acpStatus: () => ({
        connections: [
          {
            id: 'kiro',
            status: 'available',
            slashCommands: [{ name: '/plan', description: 'Plan' }],
            handshakeObservedAt: '2026-08-13T00:00:00.000Z',
          },
        ],
      }),
      publicConnection: (runtimeId) => ({
        id: engineConnectionId('kiro'),
        engineId: runtimeId,
      }),
      now: () => Date.now(),
    });
    await expect(
      subject.inspect({ kind: 'runtime-capability-inventory' }),
    ).resolves.toMatchObject({
      kind: 'inspected',
      connections: [
        expect.objectContaining({
          id: 'kiro',
          status: 'ready',
          capabilityInventory: expect.objectContaining({
            slashCommands: [expect.objectContaining({ name: '/plan' })],
          }),
        }),
      ],
    });
  });

  test('keeps prerequisite and command failures partial without rejecting the Interface', async () => {
    const subject = inspector({
      provider: 'codex',
      metadata: {
        displayName: 'Codex Runtime',
        description: 'test',
        capabilities: [],
        engineId: 'codex',
      },
      getPrerequisites: vi.fn(async () => {
        throw new Error('probe unavailable');
      }),
      getCommands: vi.fn(async () => {
        throw new Error('command unavailable');
      }),
    });
    await expect(
      subject.inspect({ kind: 'runtime-capability-inventory' }),
    ).resolves.toMatchObject({
      kind: 'inspected',
      partial: true,
      retry: 'on-next-inspection',
      connections: [
        expect.objectContaining({ status: 'missing_prerequisites' }),
      ],
    });
  });

  test('reports first Adapter failure and does not wait on a hung sibling', async () => {
    const failing = adapter('codex');
    Object.defineProperty(failing, 'metadata', {
      get: () => {
        throw new Error('first adapter failed');
      },
    });
    const adapters = [
      failing,
      adapter('claude', {
        getPrerequisites: () => new Promise(() => undefined),
      }),
    ];
    const subject = createConnectionInspector({
      adapters: () => adapters,
      appConfig: () => ({}) as any,
      acpConnections: () => [],
      acpStatus: () => ({}),
      publicConnection: (runtimeId) => ({
        id: engineConnectionId(runtimeId.replace('-runtime', '')),
        engineId: runtimeId,
      }),
      now: () => Date.now(),
    });
    await expect(
      subject.inspect({
        kind: 'runtime-capability-inventory',
      }),
    ).resolves.toMatchObject({ kind: 'unavailable', partial: true });
  });

  test('bounds concurrent Adapter inspection', async () => {
    let active = 0;
    let maximum = 0;
    const adapters = ['codex', 'claude', 'muse'].map((provider) =>
      adapter(provider, {
        getPrerequisites: async () => {
          active += 1;
          maximum = Math.max(maximum, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return [];
        },
      }),
    );
    const subject = createConnectionInspector({
      adapters: () => adapters,
      appConfig: () => ({}) as any,
      acpConnections: () => [],
      acpStatus: () => ({}),
      publicConnection: (runtimeId) => ({
        id: engineConnectionId(runtimeId.replace('-runtime', '')),
        engineId: runtimeId,
      }),
      now: () => Date.now(),
    });
    await subject.inspect({
      kind: 'runtime-capability-inventory',
      concurrency: 2,
    });
    expect(maximum).toBe(2);
  });

  test('waits for every required Adapter cleanup after abort', async () => {
    const controllers: Array<(value: any) => void> = [];
    const adapters = ['codex', 'claude'].map((provider) =>
      adapter(provider, {
        metadata: { abortSettlement: 'await' },
        getPrerequisites: () =>
          new Promise<any>((resolve) => controllers.push(resolve)),
      }),
    );
    adapters.forEach((value) =>
      setProviderAdapterRegistrationProvenance(value, 'builtin'),
    );
    const subject = createConnectionInspector({
      adapters: () => adapters,
      appConfig: () => ({}) as any,
      acpConnections: () => [],
      acpStatus: () => ({}),
      publicConnection: (runtimeId) => ({
        id: engineConnectionId(runtimeId.replace('-runtime', '')),
        engineId: runtimeId,
      }),
      now: () => Date.now(),
    });
    const controller = new AbortController();
    const pending = subject.inspect({
      kind: 'runtime-capability-inventory',
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort(new Error('cancel'));
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    controllers.forEach((resolve) => resolve([]));
    await expect(pending).resolves.toMatchObject({ kind: 'aborted' });
  });

  test('projects readiness, recovery, and bounded catalog behavior', async () => {
    const subject = inspector(
      adapter('codex', {
        metadata: {
          recovery: { sameSession: true, application: 'restart_resume' },
        },
        getPrerequisites: async () => [
          { id: 'auth', category: 'required', status: 'missing' },
        ],
        listModelCatalog: async () => ({
          models: Array.from({ length: 1002 }, (_, index) => ({
            id: `m${index}`,
            name: `M${index}`,
            originalId: `m${index}`,
          })),
        }),
      }),
    );
    await expect(
      subject.inspect({ kind: 'runtime-capability-inventory' }),
    ).resolves.toMatchObject({
      kind: 'inspected',
      connections: [
        expect.objectContaining({
          status: 'missing_prerequisites',
          runtimeCatalog: expect.objectContaining({ truncated: true }),
          credentialRecovery: expect.any(Object),
          capabilityInventory: expect.objectContaining({ freshness: 'live' }),
        }),
      ],
    });
  });

  test('keeps an authoritative live-empty catalog distinct from built-in fallback', async () => {
    const liveEmpty = inspector(
      adapter('codex', {
        metadata: { knownModels: [{ id: 'fallback', name: 'Fallback' }] },
        listModelCatalog: async () => ({ models: [] }),
      }),
    );
    await expect(
      liveEmpty.inspect({ kind: 'runtime-capability-inventory' }),
    ).resolves.toMatchObject({
      connections: [
        expect.objectContaining({
          runtimeCatalog: expect.objectContaining({
            source: 'live',
            models: [],
            builtInModels: expect.arrayContaining([
              expect.objectContaining({ id: 'gpt-5.6-sol' }),
            ]),
          }),
        }),
      ],
    });
  });

  test('keeps ACP observations per connection and distinguishes absent from dated negative handshakes', async () => {
    const subject = createConnectionInspector({
      adapters: () => [],
      appConfig: () =>
        ({ agentConnections: { acp: { enabled: true } } }) as any,
      acpConnections: () =>
        [
          { id: 'first', enabled: true },
          { id: 'second', enabled: true },
          { id: 'third', enabled: true },
        ] as any,
      acpStatus: () => ({
        connections: [
          {
            id: 'first',
            status: 'available',
            handshakeObservedAt: '2026-08-13T00:00:00.000Z',
            capabilities: {
              mcpCapabilities: { http: true },
              providers: true,
            },
            providerRouting: [
              {
                providerId: 'main',
                supported: ['openai', '_ollama'],
                required: false,
                current: {
                  apiType: '_ollama',
                  baseUrl: 'https://openrouter.ai/api/v1',
                },
              },
            ],
          },
          { id: 'second', status: 'available' },
          {
            id: 'third',
            status: 'available',
            handshakeObservedAt: '2026-08-13T00:00:00.000Z',
          },
        ],
      }),
      publicConnection: (runtimeId) => ({
        id: engineConnectionId(runtimeId),
        engineId: runtimeId,
      }),
      now: () => Date.now(),
    });
    const outcome = await subject.inspect({
      kind: 'runtime-capability-inventory',
    });
    expect(outcome).toMatchObject({ kind: 'inspected' });
    const rows = (outcome as any).connections;
    expect(
      rows.find((row: any) => row.id === 'first').controlPlaneObservation,
    ).toEqual({ mcpHttp: true, observedAt: '2026-08-13T00:00:00.000Z' });
    expect(
      rows.find((row: any) => row.id === 'second').controlPlaneObservation,
    ).toBeUndefined();
    expect(
      rows.find((row: any) => row.id === 'third').controlPlaneObservation,
    ).toEqual({ mcpHttp: false, observedAt: '2026-08-13T00:00:00.000Z' });
    expect(rows.find((row: any) => row.id === 'first').providerRouting).toEqual(
      {
        source: 'live',
        fetchedAt: '2026-08-13T00:00:00.000Z',
        reason: null,
        providers: [
          expect.objectContaining({
            providerId: 'main',
            supported: ['openai', '_ollama'],
            current: {
              apiType: '_ollama',
              baseUrl: 'https://openrouter.ai/api/v1',
            },
          }),
        ],
      },
    );
    expect(
      rows.find((row: any) => row.id === 'second').providerRouting.reason,
    ).toContain('No successful initialize handshake');
    expect(
      rows.find((row: any) => row.id === 'third').providerRouting.reason,
    ).toContain('advertises no providers');
  });

  test('bounds a never-settling required Adapter cleanup and remains total', async () => {
    vi.useFakeTimers();
    try {
      const subject = inspector(
        adapter('codex', {
          metadata: { abortSettlement: 'await' },
          getPrerequisites: () => new Promise(() => undefined),
        }),
      );
      const controller = new AbortController();
      const pending = subject.inspect({
        kind: 'runtime-capability-inventory',
        signal: controller.signal,
      });
      await Promise.resolve();
      controller.abort(new Error('cancel'));
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(649);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toMatchObject({
        kind: 'aborted',
        partial: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test('uses the explicit public EngineConnectionId for an Adapter EngineId', async () => {
    const subject = createConnectionInspector({
      adapters: () => [
        adapter('muse', {
          metadata: { engineId: 'muse-engine' },
        }),
      ],
      appConfig: () => ({}) as any,
      acpConnections: () => [],
      acpStatus: () => ({}),
      publicConnection: (engineId) => {
        expect(engineId).toBe('muse-engine');
        return { id: engineConnectionId('muse-engine'), engineId };
      },
      now: () => Date.now(),
    });
    await expect(
      subject.inspect({ kind: 'runtime-capability-inventory' }),
    ).resolves.toMatchObject({
      connections: [
        expect.objectContaining({ id: 'muse-engine', type: 'muse-engine' }),
      ],
    });
  });

  test('projects available, configured, and ready setup states', async () => {
    const make = (settings: any, prerequisites: any[]) =>
      createConnectionInspector({
        adapters: () => [
          adapter('codex', {
            metadata: { capabilities: ['agent-runtime'] },
            getPrerequisites: async () => prerequisites,
          }),
        ],
        appConfig: () => ({ agentConnections: settings }) as any,
        acpConnections: () => [],
        acpStatus: () => ({}),
        publicConnection: (runtimeId) => ({
          id: engineConnectionId('codex'),
          engineId: runtimeId,
        }),
        now: () => Date.now(),
      });
    const available = createConnectionInspector({
      adapters: () => [adapter('muse')],
      appConfig: () => ({}) as any,
      acpConnections: () => [],
      acpStatus: () => ({}),
      publicConnection: (runtimeId) => ({
        id: engineConnectionId('muse'),
        engineId: runtimeId,
      }),
      now: () => Date.now(),
    });
    await expect(
      available.inspect({ kind: 'runtime-capability-inventory' }),
    ).resolves.toMatchObject({
      connections: [
        expect.objectContaining({
          setup: expect.objectContaining({
            state: 'available',
            detected: false,
            configured: false,
          }),
        }),
      ],
    });
    await expect(
      make({ codex: { enabled: true } }, [
        { id: 'auth', category: 'required', status: 'missing' },
      ]).inspect({ kind: 'runtime-capability-inventory' }),
    ).resolves.toMatchObject({
      connections: [
        expect.objectContaining({
          setup: expect.objectContaining({ state: 'configured' }),
        }),
      ],
    });
    await expect(
      make({ codex: { enabled: true } }, []).inspect({
        kind: 'runtime-capability-inventory',
      }),
    ).resolves.toMatchObject({
      connections: [
        expect.objectContaining({
          setup: expect.objectContaining({ state: 'ready' }),
        }),
      ],
    });
  });

  test('projects ACP session surfaces and sanitizes bounded model capability contributions', async () => {
    const subject = createConnectionInspector({
      adapters: () => [
        adapter('codex', {
          listModelCatalog: async () => ({
            models: [
              {
                id: 'm',
                name: 'M',
                originalId: 'm',
                capabilities: {
                  supportsEffort: true,
                  contextWindow: 16,
                  supportedEffortLevels: ['low', 'low', 1, 'high'],
                  effortLabels: { low: 'Low', bad: '', ignored: 1 },
                  ignored: 'x',
                },
              },
            ],
          }),
        }),
      ],
      appConfig: () =>
        ({ agentConnections: { acp: { enabled: true } } }) as any,
      acpConnections: () => [{ id: 'kiro', enabled: true }] as any,
      acpStatus: () => ({
        connections: [
          {
            id: 'kiro',
            status: 'available',
            handshakeObservedAt: '2026-08-13T00:00:00.000Z',
            capabilities: {
              loadSession: true,
              mcpCapabilities: { http: true, sse: true },
            },
          },
        ],
      }),
      publicConnection: (runtimeId) => ({
        id: engineConnectionId(runtimeId === 'kiro' ? 'kiro' : 'codex'),
        engineId: runtimeId,
      }),
      now: () => Date.now(),
    });
    const outcome = await subject.inspect({
      kind: 'runtime-capability-inventory',
    });
    const rows = (outcome as any).connections;
    expect(rows.find((row: any) => row.id === 'kiro')?.continuity).toEqual({
      resume: 'same-session',
      fork: 'none',
      rewind: 'none',
    });
    expect(
      rows.find((row: any) => row.id === 'kiro').capabilityInventory
        .sessionSurfaces.mcpTransports,
    ).toEqual(['stdio', 'http', 'sse']);
    expect(
      rows.find((row: any) => row.id === 'codex').runtimeCatalog.models[0]
        .capabilities,
    ).toEqual({
      supportsEffort: true,
      contextWindow: 16,
      supportedEffortLevels: ['low', 'high'],
      effortLabels: { low: 'Low' },
    });
  });

  // `as const` so the status column narrows to ACPStatusValue instead of
  // widening to string — test.each infers the table, and a widened column
  // cannot be handed to the typed acpStatus seam.
  test.each([
    ['false', 'available', false],
    ['absent', 'available', undefined],
    ['probing', 'probing', true],
    ['unavailable', 'unavailable', true],
  ] as const)(
    'does not retain ACP resume capability when loadSession is %s',
    async (_case, status: ACPStatusValue, loadSession) => {
      const subject = createConnectionInspector({
        adapters: () => [],
        appConfig: () => ({}) as any,
        acpConnections: () => [{ id: 'acp-test', enabled: true }] as any,
        acpStatus: () => ({
          connections: [
            {
              id: 'acp-test',
              status: status as ACPStatusValue,
              capabilities: { loadSession },
            },
          ],
        }),
        publicConnection: (runtimeId) => ({
          id: engineConnectionId(runtimeId),
          engineId: runtimeId,
        }),
        now: () => Date.now(),
      });
      const result = (await subject.inspect({
        kind: 'runtime-capability-inventory',
      })) as any;
      expect(
        result.connections.find((row: any) => row.id === 'acp-test').continuity
          .resume,
      ).toBe('none');
    },
  );
});
