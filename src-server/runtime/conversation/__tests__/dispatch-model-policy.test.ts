import { dispatch } from '@kontourai/dispatch';
import { FakeModelRuntime } from '@kontourai/relay';
import type { ConnectionReadinessEvidence } from '@kontourai/station-contracts/tool';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveConnectionReadinessEvidence } from '../../../services/connections/connection-readiness-evidence.js';
import type { DispatchEvidenceSource } from '../../types.js';

// Hoisted mocks: `createConfiguredDispatchModel` reaches into provider/model
// construction that we don't want to exercise for real in a unit test. The
// factories are captured so each test can assert on what was built.
const createAiSdkManagedModel = vi.fn(() => ({ id: 'fake-language-model' }));
vi.mock('../../frameworks/framework-model-factory.js', () => ({
  createAiSdkManagedModel: (...args: unknown[]) =>
    createAiSdkManagedModel(...(args as [])),
}));

const resolveManagedModelBinding = vi.fn();
vi.mock('../../plugins/runtime-provider-resolution.js', () => ({
  resolveManagedModelBinding: (...args: unknown[]) =>
    resolveManagedModelBinding(...(args as [])),
}));

let capturedPlan: any;
vi.mock('@kontourai/dispatch/ai-sdk', () => ({
  createAiSdkDispatchModel: (options: any) => {
    capturedPlan = options.plan;
    return { id: options.id, __plan: options.plan };
  },
}));

// M-1b: the module-level fallback logger (`moduleLogger`) is created once at
// import time via `createLogger`. Stub it so the "no config.logger wired"
// warning tests can observe it fired, instead of writing to real pino output.
const moduleLoggerWarn = vi.fn();
vi.mock('../../../utils/logger.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../utils/logger.js')
  >('../../../utils/logger.js');
  return {
    ...actual,
    createLogger: () => ({
      warn: moduleLoggerWarn,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  };
});

const {
  createConfiguredDispatchModel,
  candidateEvidenceFromReadiness,
  deriveDispatchCapabilities,
  deriveStructuredToolsFidelity,
  fetchReadinessEvidenceMap,
  mapConnectionEvidenceToDispatchLevel,
  DISPATCH_EVIDENCE_TTL_MS,
} = await import('../dispatch-model-policy.js');

const EVIDENCE_SOURCE_ID = 'station:connection-readiness/v1';

const DUMMY_REQUEST = { messages: [{ role: 'user' as const, content: 'hi' }] };

/**
 * archive#1431: `createConfiguredDispatchModel` now passes `plan` as the
 * lazy function form (`@kontourai/dispatch/ai-sdk` awaits `options.plan(request)`
 * per invocation) rather than a static object, so every test that used to
 * read `capturedPlan.candidates` directly must resolve it first. Handles
 * both shapes defensively so a future accidental regression to the static
 * form doesn't silently break every caller of this helper.
 */
async function resolveCapturedPlan(
  request: unknown = DUMMY_REQUEST,
): Promise<any> {
  return typeof capturedPlan === 'function'
    ? await capturedPlan(request)
    : capturedPlan;
}

function readinessEvidence(
  level: ConnectionReadinessEvidence['level'],
  freshness: ConnectionReadinessEvidence['freshness'] = 'fresh',
): ConnectionReadinessEvidence {
  return {
    evidenceVersion: 1,
    level,
    observedAt: new Date().toISOString(),
    freshness,
    summary: `test evidence at ${level}`,
    smoke: {
      status: level === 'smoke-passed' ? 'passed' : 'not-tested',
      freshness: level === 'smoke-passed' ? freshness : 'unknown',
      turnLimit: 1,
    },
  };
}

/**
 * `toolSurfaceEntries` is keyed by `${connectionId} ${modelId}` —
 * archive#1430's `getModelToolSurface` is deliberately array-shaped in
 * production (a connection can expose many models, so `connectionId` alone
 * isn't unique), but tests only ever bind one model per connection, so a
 * flat composite-keyed record is a simpler fixture than an array-of-arrays.
 */
function evidenceSourceFromMap(
  entries: Record<string, ConnectionReadinessEvidence>,
  toolSurfaceEntries: Record<string, readonly string[] | null> = {},
): DispatchEvidenceSource & {
  calls: readonly (readonly string[])[];
  toolSurfaceCalls: ReadonlyArray<
    ReadonlyArray<{ connectionId: string; modelId: string }>
  >;
} {
  const calls: string[][] = [];
  const toolSurfaceCalls: Array<
    Array<{ connectionId: string; modelId: string }>
  > = [];
  return {
    calls,
    toolSurfaceCalls,
    getConnectionReadinessEvidence: async (connectionIds) => {
      calls.push([...connectionIds]);
      const result = new Map<string, ConnectionReadinessEvidence>();
      for (const id of connectionIds) {
        const evidence = entries[id];
        if (evidence) result.set(id, evidence);
      }
      return result;
    },
    getModelToolSurface: async (bindings) => {
      toolSurfaceCalls.push([...bindings]);
      return bindings.map(
        ({ connectionId, modelId }) =>
          toolSurfaceEntries[`${connectionId} ${modelId}`] ?? null,
      );
    },
  };
}

describe('mapConnectionEvidenceToDispatchLevel', () => {
  it('maps discovered to unavailable', () => {
    expect(
      mapConnectionEvidenceToDispatchLevel({
        level: 'discovered',
        freshness: 'fresh',
      }),
    ).toBe('unavailable');
  });

  it('maps prerequisite-ready and catalog-ready to declared', () => {
    expect(
      mapConnectionEvidenceToDispatchLevel({
        level: 'prerequisite-ready',
        freshness: 'fresh',
      }),
    ).toBe('declared');
    expect(
      mapConnectionEvidenceToDispatchLevel({
        level: 'catalog-ready',
        freshness: 'fresh',
      }),
    ).toBe('declared');
  });

  it('maps smoke-passed to confirmed', () => {
    expect(
      mapConnectionEvidenceToDispatchLevel({
        level: 'smoke-passed',
        freshness: 'fresh',
      }),
    ).toBe('confirmed');
  });

  it('honestly downgrades a stale smoke-passed level rather than reporting confirmed', () => {
    expect(
      mapConnectionEvidenceToDispatchLevel({
        level: 'smoke-passed',
        freshness: 'stale',
      }),
    ).toBe('declared');
  });

  it('honestly downgrades a stale declared-rank level to unavailable', () => {
    expect(
      mapConnectionEvidenceToDispatchLevel({
        level: 'catalog-ready',
        freshness: 'stale',
      }),
    ).toBe('unavailable');
    expect(
      mapConnectionEvidenceToDispatchLevel({
        level: 'prerequisite-ready',
        freshness: 'unknown',
      }),
    ).toBe('unavailable');
  });

  it('stale discovered evidence stays at the unavailable floor', () => {
    expect(
      mapConnectionEvidenceToDispatchLevel({
        level: 'discovered',
        freshness: 'stale',
      }),
    ).toBe('unavailable');
  });

  it('fails closed to unavailable for a level outside the known union (nit)', () => {
    expect(
      mapConnectionEvidenceToDispatchLevel({
        level: 'not-a-real-level' as any,
        freshness: 'fresh',
      }),
    ).toBe('unavailable');
  });
});

describe('SF-1: the freshness downgrade is a defensive floor, empirically checked against the real producer', () => {
  it('a stale smoke never survives as level smoke-passed — the producer reverts the level itself, not just freshness', () => {
    const connection = {
      id: 'conn-a',
      kind: 'model',
      type: 'ollama',
      name: 'test',
      enabled: true,
      capabilities: ['llm'],
      config: { modelOptions: [{ id: 'm1', name: 'm1', originalId: 'm1' }] },
      status: 'ready',
      prerequisites: [],
    } as any;
    const now = new Date('2026-08-01T12:00:00.000Z');
    const staleSmoke = {
      evidenceVersion: 2,
      connectionId: 'conn-a',
      configurationFingerprint: 'fp',
      status: 'passed',
      testedAt: '2026-08-01T11:00:00.000Z',
      freshUntil: '2026-08-01T11:05:00.000Z', // already passed relative to `now`
      provider: 'ollama',
      durationMs: 10,
      turnLimit: 1,
    } as any;

    const evidence = deriveConnectionReadinessEvidence(
      connection,
      staleSmoke,
      now,
    );

    // The producer already downgraded the *level*, not just a freshness
    // flag — mapConnectionEvidenceToDispatchLevel never actually observes
    // `{ level: 'smoke-passed', freshness: 'stale' }` from this producer.
    expect(evidence.level).not.toBe('smoke-passed');
  });

  it('a model-kind connection at catalog-ready is always reported fresh — the stale-catalog-ready branch is agent-kind only', () => {
    const connection = {
      id: 'conn-b',
      kind: 'model',
      type: 'ollama',
      name: 'test',
      enabled: true,
      capabilities: ['llm'],
      config: { modelOptions: [{ id: 'm1', name: 'm1', originalId: 'm1' }] },
      status: 'ready',
      prerequisites: [],
    } as any;

    const evidence = deriveConnectionReadinessEvidence(connection, null);

    expect(evidence.level).toBe('catalog-ready');
    expect(evidence.freshness).toBe('fresh');
  });
});

describe('deriveDispatchCapabilities', () => {
  it('asserts no capabilities when the candidate has no live evidence', () => {
    expect(deriveDispatchCapabilities('unavailable')).toEqual([]);
    // archive#1430: even a genuinely tool-capable model asserts nothing
    // once evidence itself is unavailable — an unearned capability claim on
    // top of an unearned evidence level would be the same defect twice over.
    expect(deriveDispatchCapabilities('unavailable', ['tool-calls'])).toEqual(
      [],
    );
  });

  it('grants abort/usage once any live evidence exists', () => {
    expect(deriveDispatchCapabilities('declared')).toEqual(['abort', 'usage']);
    expect(deriveDispatchCapabilities('confirmed')).toEqual(['abort', 'usage']);
  });

  it("without a wired tool-surface source, never derives 'structured-tools' (unchanged pre-#1430 behavior)", () => {
    // The `toolSurface` argument is optional precisely so a call site that
    // hasn't been updated to pass one keeps behaving exactly as it did
    // before archive#1430 closed the producer gap.
    for (const level of ['unavailable', 'declared', 'confirmed'] as const) {
      expect(deriveDispatchCapabilities(level)).not.toContain(
        'structured-tools',
      );
    }
  });

  // archive#1430 (evolved from the archive#1426 pin this replaces): the producer
  // gap is closed, so this now proves the FULL round trip — a provider that
  // genuinely reports tool support derives the capability; one that
  // doesn't (or reports an explicit negative, or is simply unknown) never
  // does. This is the fault-injection-shaped pin: if the derivation ever
  // started asserting 'structured-tools' without a truthful `'tool-calls'`
  // entry in `toolSurface`, every case below except the first would fail.
  it("MB-1 evolved: derives 'structured-tools' only from an affirmative toolSurface, at any live evidence level", () => {
    expect(deriveDispatchCapabilities('declared', ['tool-calls'])).toEqual([
      'abort',
      'usage',
      'structured-tools',
    ]);
    expect(deriveDispatchCapabilities('confirmed', ['tool-calls'])).toEqual([
      'abort',
      'usage',
      'structured-tools',
    ]);
    // A known negative (the inventory affirmatively knows this model does
    // NOT support tools) must not derive the capability.
    expect(deriveDispatchCapabilities('confirmed', [])).toEqual([
      'abort',
      'usage',
    ]);
    // An explicit unknown (`null`, the inventory's `unanimous()` fold for
    // "no producer said either way") must not derive the capability.
    expect(deriveDispatchCapabilities('confirmed', null)).toEqual([
      'abort',
      'usage',
    ]);
  });
});

describe('station#1430: structured-tools derivation from a real provider-honesty round trip (production-shape pin)', () => {
  it('a provider that genuinely populates supportsTools (Ollama /api/show reporting "tools") flows through to a derived structured-tools capability', async () => {
    const { buildLaunchableModelInventory } = await import(
      '../../../services/connections/launchable-model-inventory.js'
    );

    // This mirrors exactly what OllamaLLMProvider.listModelCatalog emits
    // once its /api/show enrichment observes "tools" in a model's live
    // capabilities array (see ollama-provider.test.ts) — a real,
    // provider-reported `supportsTools: true`, not a synthetic fixture
    // shape that no adapter would ever produce.
    const inventory = buildLaunchableModelInventory({
      observedAt: '2026-08-01T00:00:00.000Z',
      modelConnections: [
        {
          connection: {
            id: 'ollama-local',
            kind: 'model',
            type: 'ollama',
            name: 'Local Ollama',
            enabled: true,
            capabilities: ['llm'],
            config: {},
            status: 'ready',
            prerequisites: [],
          } as any,
          execution: null,
          catalog: {
            source: 'live',
            observedAt: '2026-08-01T00:00:00.000Z',
            models: [
              { id: 'qwen3:30b', name: 'Qwen 3 30B', supportsTools: true },
            ],
          },
        },
      ],
      agentConnections: [],
    });

    expect(inventory.models).toHaveLength(1);
    expect(inventory.models[0]!.toolSurface).toEqual(['tool-calls']);

    // The full round trip: this record's toolSurface, handed to the
    // capability derivation, produces 'structured-tools'.
    expect(
      deriveDispatchCapabilities('confirmed', inventory.models[0]!.toolSurface),
    ).toEqual(['abort', 'usage', 'structured-tools']);
  });

  it('a provider that leaves supportsTools undefined (e.g. Anthropic, which reports no such field) yields exactly abort/usage — never a guess', async () => {
    const { buildLaunchableModelInventory } = await import(
      '../../../services/connections/launchable-model-inventory.js'
    );

    const inventory = buildLaunchableModelInventory({
      observedAt: '2026-08-01T00:00:00.000Z',
      modelConnections: [
        {
          connection: {
            id: 'anthropic-primary',
            kind: 'model',
            type: 'anthropic',
            name: 'Anthropic',
            enabled: true,
            capabilities: ['llm'],
            config: {},
            status: 'ready',
            prerequisites: [],
          } as any,
          execution: null,
          catalog: {
            source: 'live',
            observedAt: '2026-08-01T00:00:00.000Z',
            models: [
              {
                id: 'claude-opus-5',
                name: 'Claude Opus 5',
                // no supportsTools — this is the real shape
                // AnthropicLLMProvider.listModelCatalog emits today.
              },
            ],
          },
        },
      ],
      agentConnections: [],
    });

    expect(inventory.models[0]!.toolSurface).toBeNull();
    expect(
      deriveDispatchCapabilities('confirmed', inventory.models[0]!.toolSurface),
    ).toEqual(['abort', 'usage']);
  });
});

describe('deriveStructuredToolsFidelity (station#1398 slice 5.5)', () => {
  it("names 'native' for a capability list that claims structured tools", () => {
    expect(
      deriveStructuredToolsFidelity(['abort', 'usage', 'structured-tools']),
    ).toBe('native');
  });

  it("names 'unavailable' when the list makes no structured-tools claim", () => {
    expect(deriveStructuredToolsFidelity(['abort', 'usage'])).toBe(
      'unavailable',
    );
    expect(deriveStructuredToolsFidelity([])).toBe('unavailable');
  });

  it('is a pure function OF the capability list, so the two can never disagree', () => {
    // The property that matters, stated as a property rather than as three
    // more examples: dispatch 0.5.0 refuses evidence whose fidelity and
    // capability list disagree, so the only durable guarantee is that one is
    // derived from the other. Re-deriving from `(level, toolSurface)` would
    // have re-opened exactly the drift this replaces.
    for (const level of ['unavailable', 'declared', 'confirmed'] as const) {
      for (const toolSurface of [null, [], ['tool-calls'], ['other']]) {
        const capabilities = deriveDispatchCapabilities(level, toolSurface);
        const fidelity = deriveStructuredToolsFidelity(capabilities);
        expect(capabilities.includes('structured-tools')).toBe(
          fidelity !== 'unavailable',
        );
      }
    }
  });
});

describe('candidateEvidenceFromReadiness', () => {
  it('returns the honest unavailable floor, tagged with the evidence source id (SF-4), when there is no readiness evidence', () => {
    expect(candidateEvidenceFromReadiness(undefined)).toEqual({
      level: 'unavailable',
      capabilities: [],
      // archive#1398: dispatch 0.5.0's `eligible()` refuses
      // evidence whose fidelity disagrees with its capability list, and an
      // ABSENT fidelity reads as 'unavailable'. Stating it is what keeps
      // "no capabilities" and "no structured-tool support" one consistent
      // record rather than two independently-drifting ones.
      structuredToolsFidelity: 'unavailable',
      source: EVIDENCE_SOURCE_ID,
    });
  });

  it('a smoke-passed connection and a merely discovered connection produce different candidate evidence (AC a)', () => {
    const smokeEvidence = candidateEvidenceFromReadiness(
      readinessEvidence('smoke-passed'),
    );
    const discoveredEvidence = candidateEvidenceFromReadiness(
      readinessEvidence('discovered'),
    );

    expect(smokeEvidence.level).toBe('confirmed');
    expect(discoveredEvidence.level).toBe('unavailable');
    expect(smokeEvidence).not.toEqual(discoveredEvidence);
    expect(smokeEvidence.capabilities).toEqual(['abort', 'usage']);
    expect(discoveredEvidence.capabilities).toEqual([]);
  });

  it('sets CapabilityEvidence.source on every derived evidence (SF-4)', () => {
    expect(
      candidateEvidenceFromReadiness(readinessEvidence('catalog-ready')),
    ).toMatchObject({ source: EVIDENCE_SOURCE_ID });
  });

  it('station#1430: threads a real toolSurface through to structured-tools, keeping the same evidence source id', () => {
    const withTools = candidateEvidenceFromReadiness(
      readinessEvidence('smoke-passed'),
      ['tool-calls'],
    );
    expect(withTools).toEqual({
      level: 'confirmed',
      capabilities: ['abort', 'usage', 'structured-tools'],
      // archive#1398: the capability string alone is ineligible at
      // dispatch 0.5.0 — the paired fidelity is what makes the claim
      // routable, and 'native' is the only honest value for a claim whose
      // sole source is a provider catalog reporting native tool calling.
      structuredToolsFidelity: 'native',
      source: EVIDENCE_SOURCE_ID,
    });
  });
});

describe('fetchReadinessEvidenceMap', () => {
  it('returns an empty map with no source and never calls it', async () => {
    const map = await fetchReadinessEvidenceMap(
      undefined,
      ['conn-1'],
      undefined,
      'agent-a',
    );
    expect(map?.size).toBe(0);
  });

  it('returns an empty map without calling the source when there are no connection ids', async () => {
    const source = evidenceSourceFromMap({});
    const map = await fetchReadinessEvidenceMap(
      source,
      [],
      undefined,
      'agent-a',
    );
    expect(map?.size).toBe(0);
    expect(source.calls).toHaveLength(0);
  });

  it('MB-1 (station#1431): signals a failed lookup as undefined (not an empty map) and warns, rather than throwing, when the source rejects', async () => {
    const logger = {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn().mockReturnThis(),
      setLevel: vi.fn(),
      getLevel: vi.fn(() => 'info' as const),
    };
    const throwingSource: DispatchEvidenceSource = {
      getConnectionReadinessEvidence: async () => {
        throw new Error('Model inventory generation is obsolete.');
      },
    };

    const map = await fetchReadinessEvidenceMap(
      throwingSource,
      ['conn-1'],
      logger,
      'agent-a',
    );

    // MB-1: `undefined`, not `new Map()` — a failed lookup must be
    // distinguishable from a legitimately empty one so the caller
    // (createTtlCachedCandidateResolver) knows not to cache it.
    expect(map).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toContain('agent-a');
  });

  it('MB-1 (station#1431): degrades silently to undefined (no logger) when the source rejects and no logger is wired', async () => {
    const throwingSource: DispatchEvidenceSource = {
      getConnectionReadinessEvidence: async () => {
        throw new Error('boom');
      },
    };
    await expect(
      fetchReadinessEvidenceMap(throwingSource, ['conn-1'], undefined, 'a'),
    ).resolves.toBeUndefined();
  });

  it('SF-5: de-duplicates repeated connection ids into a single call', async () => {
    const source = evidenceSourceFromMap({
      'conn-1': readinessEvidence('catalog-ready'),
    });
    const map = await fetchReadinessEvidenceMap(
      source,
      ['conn-1', 'conn-1', 'conn-1'],
      undefined,
      'agent-a',
    );
    expect(source.calls).toEqual([['conn-1']]);
    expect(map?.get('conn-1')?.level).toBe('catalog-ready');
  });
});

describe('minimumEvidence filtering actually discriminates (AC b, real @kontourai/dispatch engine)', () => {
  it('admits a confirmed candidate and excludes an unavailable one under minimumEvidence: confirmed', async () => {
    const confirmedEvidence = candidateEvidenceFromReadiness(
      readinessEvidence('smoke-passed'),
    );
    const unavailableEvidence = candidateEvidenceFromReadiness(
      readinessEvidence('discovered'),
    );

    const runtime = new FakeModelRuntime([
      {
        provider: 'fixture',
        model: 'model-a',
        outputText: 'ok',
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        latencyMs: 1,
      },
    ]);

    const plan = {
      schemaVersion: 1 as const,
      role: 'test-role',
      request: { messages: [{ role: 'user' as const, content: 'hi' }] },
      candidates: [
        {
          id: 'confirmed-candidate',
          runtimeId: runtime.id,
          evidence: confirmedEvidence,
        },
        {
          id: 'unavailable-candidate',
          runtimeId: 'unregistered-runtime',
          evidence: unavailableEvidence,
        },
      ],
      budget: { maxAttempts: 2 },
      policy: { minimumEvidence: 'confirmed' as const },
    };

    const outcome = await dispatch(plan, {
      get: (id) => (id === runtime.id ? runtime : undefined),
    });

    // Only the confirmed candidate is eligible; if the unavailable one had
    // been let through it would fail immediately (its runtime is
    // unregistered) before the confirmed one ever ran.
    expect(outcome.receipt.outcome).toBe('succeeded');
    expect(outcome.receipt.attempts).toHaveLength(1);
    expect(outcome.receipt.attempts[0]?.candidateId).toBe(
      'confirmed-candidate',
    );
  });

  it('excludes every candidate when none reach minimumEvidence: confirmed', async () => {
    const discoveredEvidence = candidateEvidenceFromReadiness(
      readinessEvidence('discovered'),
    );
    const catalogEvidence = candidateEvidenceFromReadiness(
      readinessEvidence('catalog-ready'),
    );

    const plan = {
      schemaVersion: 1 as const,
      role: 'test-role',
      request: { messages: [{ role: 'user' as const, content: 'hi' }] },
      candidates: [
        { id: 'a', runtimeId: 'runtime-a', evidence: discoveredEvidence },
        { id: 'b', runtimeId: 'runtime-b', evidence: catalogEvidence },
      ],
      budget: { maxAttempts: 2 },
      policy: { minimumEvidence: 'confirmed' as const },
    };

    const outcome = await dispatch(plan, { get: () => undefined });
    expect(outcome.receipt.outcome).toBe('no-eligible-candidates');
  });
});

describe('createConfiguredDispatchModel wiring', () => {
  const baseSpec = {
    name: 'writer',
    execution: {
      modelOptions: {
        dispatch: { enabled: true },
      },
    },
  } as any;

  const baseConfig = {
    appConfig: {},
    projectHomeDir: '/tmp/station-test-home',
  } as any;

  const primaryBinding = {
    providerConnection: { id: 'primary-connection', type: 'anthropic' },
    providerType: 'anthropic',
    modelId: 'primary-model',
  } as any;

  function makeLogger() {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  }

  beforeEach(() => {
    capturedPlan = undefined;
    createAiSdkManagedModel.mockClear();
    resolveManagedModelBinding.mockReset();
  });

  it('grades the primary candidate from the wired evidence source instead of a hardcoded declared level', async () => {
    const source = evidenceSourceFromMap({
      'primary-connection': readinessEvidence('smoke-passed'),
    });

    await createConfiguredDispatchModel(
      baseSpec,
      { ...baseConfig, dispatchEvidenceSource: source },
      primaryBinding,
    );
    const plan = await resolveCapturedPlan();

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0].evidence.level).toBe('confirmed');
    expect(plan.candidates[0].evidence.source).toBe(EVIDENCE_SOURCE_ID);
  });

  it('falls back to unavailable, never to declared, when no evidence source is wired for this call path', async () => {
    await createConfiguredDispatchModel(baseSpec, baseConfig, primaryBinding);
    const plan = await resolveCapturedPlan();

    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0].evidence).toEqual({
      level: 'unavailable',
      capabilities: [],
      structuredToolsFidelity: 'unavailable',
      source: EVIDENCE_SOURCE_ID,
    });
  });

  it('two candidates on connections at different evidence levels are graded differently end to end, from ONE evidence-source call (SF-5)', async () => {
    const source = evidenceSourceFromMap({
      'primary-connection': readinessEvidence('smoke-passed'),
      'secondary-connection': readinessEvidence('discovered'),
    });
    resolveManagedModelBinding.mockResolvedValueOnce({
      providerConnection: { id: 'secondary-connection', type: 'ollama' },
      providerType: 'ollama',
      modelId: 'secondary-model',
    });

    await createConfiguredDispatchModel(
      {
        ...baseSpec,
        execution: {
          modelOptions: {
            dispatch: {
              enabled: true,
              candidates: [{ modelConnectionId: 'secondary-connection' }],
            },
          },
        },
      } as any,
      { ...baseConfig, dispatchEvidenceSource: source },
      primaryBinding,
    );
    const plan = await resolveCapturedPlan();

    expect(plan.candidates).toHaveLength(2);
    expect(plan.candidates[0].evidence.level).toBe('confirmed');
    expect(plan.candidates[1].evidence.level).toBe('unavailable');
    expect(plan.candidates[0].evidence).not.toEqual(
      plan.candidates[1].evidence,
    );
    // SF-5: exactly one batched call, covering both candidates' connection
    // ids, not one call per candidate.
    expect(source.calls).toHaveLength(1);
    expect(source.calls[0]).toEqual(
      expect.arrayContaining(['primary-connection', 'secondary-connection']),
    );
  });

  it('SF-2/MB-1: an evidence source that rejects degrades every candidate to unavailable instead of failing model construction, and the failure is NOT cached — a healthy retry in the same window re-grades', async () => {
    const logger = makeLogger();
    let callCount = 0;
    // Throws on the first lookup, then heals — this is the exact archive#1431
    // review-round probe (MB-1): before the fix, `fetchReadinessEvidenceMap`
    // swallowed the rejection into `new Map()`, the resolver's try-block
    // completed normally, graded everything 'unavailable', and CACHED that
    // grade for the full TTL — so a still-within-window second call would
    // have kept reading 'unavailable' even though the source is healthy
    // again by then. Resolving twice (throw, then healthy, with NO timer
    // advance in between) is the only way to observe that caching bug at
    // all — a single resolution can't distinguish "never cached" from
    // "cached correctly" or "cached the failure".
    const source: DispatchEvidenceSource = {
      getConnectionReadinessEvidence: async (connectionIds) => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error('Model inventory generation is obsolete.');
        }
        const result = new Map<string, ConnectionReadinessEvidence>();
        for (const id of connectionIds) {
          result.set(id, readinessEvidence('smoke-passed'));
        }
        return result;
      },
    };

    const model = await createConfiguredDispatchModel(
      baseSpec,
      { ...baseConfig, dispatchEvidenceSource: source, logger },
      primaryBinding,
    );
    expect(model).not.toBeNull();

    // Resolution 1: the source throws. Degrades to unavailable, doesn't
    // fail model construction or reject the plan, and warns.
    const firstPlan = await resolveCapturedPlan();
    expect(firstPlan.candidates[0].evidence.level).toBe('unavailable');
    expect(logger.warn).toHaveBeenCalled();

    // Resolution 2: same TTL window (no vi timer involved — real elapsed
    // time here is microseconds), source is now healthy. MB-1: this MUST
    // re-attempt the source rather than replaying a cached 'unavailable'
    // grade for the rest of the 60s window.
    const secondPlan = await resolveCapturedPlan();
    expect(secondPlan.candidates[0].evidence.level).toBe('confirmed');
    expect(callCount).toBe(2);
  });

  it('SF-3: logs why each excluded candidate was excluded, naming the connection id and the derived vs. required level', async () => {
    const logger = makeLogger();
    const source = evidenceSourceFromMap({
      'primary-connection': readinessEvidence('discovered'),
      'secondary-connection': readinessEvidence('catalog-ready'),
    });
    resolveManagedModelBinding.mockResolvedValueOnce({
      providerConnection: { id: 'secondary-connection', type: 'ollama' },
      providerType: 'ollama',
      modelId: 'secondary-model',
    });

    await createConfiguredDispatchModel(
      {
        ...baseSpec,
        execution: {
          modelOptions: {
            dispatch: {
              enabled: true,
              candidates: [{ modelConnectionId: 'secondary-connection' }],
              policy: { minimumEvidence: 'confirmed' },
            },
          },
        },
      } as any,
      { ...baseConfig, dispatchEvidenceSource: source, logger },
      primaryBinding,
    );
    // archive#1431: exclusion logging now happens inside the lazy
    // per-invocation candidate resolver, not at construction — resolve the
    // plan once to trigger it.
    await resolveCapturedPlan();

    // Both candidates are below 'confirmed' (unavailable, declared) so both
    // get an exclusion line naming their connection id and levels.
    expect(logger.info).toHaveBeenCalledTimes(2);
    const messages = logger.info.mock.calls.map((call) => call[0] as string);
    expect(messages.some((m) => m.includes('primary-connection'))).toBe(true);
    expect(messages.some((m) => m.includes('secondary-connection'))).toBe(true);
    expect(
      messages.every((m) => m.includes("requires at least 'confirmed'")),
    ).toBe(true);
  });

  it('SF-3: logs a missing-capabilities exclusion when the evidence level is sufficient but a required capability is absent', async () => {
    const logger = makeLogger();
    const source = evidenceSourceFromMap({
      'primary-connection': readinessEvidence('smoke-passed'),
    });

    await createConfiguredDispatchModel(
      {
        ...baseSpec,
        execution: {
          modelOptions: {
            dispatch: {
              enabled: true,
              policy: { requiredCapabilities: ['structured-tools'] },
            },
          },
        },
      } as any,
      { ...baseConfig, dispatchEvidenceSource: source, logger },
      primaryBinding,
    );
    await resolveCapturedPlan();

    expect(logger.info).toHaveBeenCalledTimes(1);
    const message = logger.info.mock.calls[0]?.[0] as string;
    expect(message).toContain('primary-connection');
    expect(message).toContain('structured-tools');
  });

  // archive#1430 end-to-end wiring pin: the SAME `requiredCapabilities:
  // ['structured-tools']` policy as the test above, but with a
  // `getModelToolSurface` source that genuinely reports tool support for
  // this candidate's connection+model — proves the full path
  // (`createConfiguredDispatchModel` -> the lazy resolver ->
  // `fetchModelToolSurfaceList` -> `gradeDispatchCandidates` ->
  // `deriveDispatchCapabilities`) actually admits the candidate instead of
  // excluding it, not just that the unit function can be called directly.
  it("station#1430: admits a candidate against a required 'structured-tools' policy when the wired tool-surface source reports it", async () => {
    const logger = makeLogger();
    const source = evidenceSourceFromMap(
      { 'primary-connection': readinessEvidence('smoke-passed') },
      { 'primary-connection primary-model': ['tool-calls'] },
    );

    await createConfiguredDispatchModel(
      {
        ...baseSpec,
        execution: {
          modelOptions: {
            dispatch: {
              enabled: true,
              policy: { requiredCapabilities: ['structured-tools'] },
            },
          },
        },
      } as any,
      { ...baseConfig, dispatchEvidenceSource: source, logger },
      primaryBinding,
    );
    const plan = await resolveCapturedPlan();

    expect(logger.info).not.toHaveBeenCalled();
    expect(plan.candidates[0].evidence.capabilities).toEqual([
      'abort',
      'usage',
      'structured-tools',
    ]);
    expect(source.toolSurfaceCalls[0]).toEqual([
      { connectionId: 'primary-connection', modelId: 'primary-model' },
    ]);
  });

  // archive#1430 review, L-1: the exclusion message must attribute exclusion
  // to the REAL reason. This candidate genuinely HAS 'structured-tools' (its
  // toolSurface reports tool-calls) but its evidence LEVEL ('declared') is
  // below the policy's 'confirmed' minimum — the message must say so, not
  // claim a missing capability the candidate actually has. Before the fix,
  // `capabilityListOf` recomputed capabilities from the evidence level alone
  // (no toolSurface), so it saw `['abort', 'usage']` regardless of the real,
  // richer `['abort', 'usage', 'structured-tools']` — and printed "missing
  // required capabilities [structured-tools]" for a candidate that had it.
  it('L-1: attributes exclusion to the evidence level, not a phantom missing capability, when the candidate genuinely has it', async () => {
    const logger = makeLogger();
    const source = evidenceSourceFromMap(
      { 'primary-connection': readinessEvidence('catalog-ready') }, // maps to 'declared'
      { 'primary-connection primary-model': ['tool-calls'] },
    );

    await createConfiguredDispatchModel(
      {
        ...baseSpec,
        execution: {
          modelOptions: {
            dispatch: {
              enabled: true,
              policy: {
                minimumEvidence: 'confirmed',
                requiredCapabilities: ['structured-tools'],
              },
            },
          },
        },
      } as any,
      { ...baseConfig, dispatchEvidenceSource: source, logger },
      primaryBinding,
    );
    const plan = await resolveCapturedPlan();

    // The candidate's REAL evidence already carries structured-tools.
    expect(plan.candidates[0].evidence.capabilities).toEqual([
      'abort',
      'usage',
      'structured-tools',
    ]);

    expect(logger.info).toHaveBeenCalledTimes(1);
    const message = logger.info.mock.calls[0]?.[0] as string;
    expect(message).toContain("requires at least 'confirmed'");
    expect(message).not.toContain('missing required capabilities');
  });

  // archive#1430 review, second pass LOW: a bare `requiredCapabilities`
  // policy (no explicit `minimumEvidence`, so it defaults to 'unavailable')
  // against a merely-discovered candidate. The candidate's level
  // ('unavailable') technically clears the default minimum by RANK
  // (`0 >= 0`), so a naive rank-only check would call this a capability
  // problem — but `deriveDispatchCapabilities('unavailable', ...)` is
  // UNCONDITIONALLY `[]`, so there was never any live evidence to derive a
  // capability from. The message must name the evidence level, not the
  // capability, as the reason.
  it("L-1 (second pass): a merely-discovered candidate under a default-minimum requiredCapabilities policy names 'unavailable' evidence, not a missing capability", async () => {
    const logger = makeLogger();
    const source = evidenceSourceFromMap(
      { 'primary-connection': readinessEvidence('discovered') },
      { 'primary-connection primary-model': ['tool-calls'] }, // even with a real toolSurface claim
    );

    await createConfiguredDispatchModel(
      {
        ...baseSpec,
        execution: {
          modelOptions: {
            dispatch: {
              enabled: true,
              policy: { requiredCapabilities: ['structured-tools'] },
            },
          },
        },
      } as any,
      { ...baseConfig, dispatchEvidenceSource: source, logger },
      primaryBinding,
    );
    const plan = await resolveCapturedPlan();

    expect(plan.candidates[0].evidence.level).toBe('unavailable');
    expect(plan.candidates[0].evidence.capabilities).toEqual([]);

    expect(logger.info).toHaveBeenCalledTimes(1);
    const message = logger.info.mock.calls[0]?.[0] as string;
    expect(message).toContain("evidence is 'unavailable'");
    expect(message).not.toContain('missing required capabilities');
  });

  it('does not log exclusions when every candidate clears the policy', async () => {
    const logger = makeLogger();
    const source = evidenceSourceFromMap({
      'primary-connection': readinessEvidence('smoke-passed'),
    });

    await createConfiguredDispatchModel(
      baseSpec,
      { ...baseConfig, dispatchEvidenceSource: source, logger },
      primaryBinding,
    );
    await resolveCapturedPlan();

    expect(logger.info).not.toHaveBeenCalled();
  });

  it('MB-2: warns loudly, naming the agent and the consequence, when a policy needs evidence but no source is wired', async () => {
    const logger = makeLogger();

    await createConfiguredDispatchModel(
      {
        ...baseSpec,
        execution: {
          modelOptions: {
            dispatch: {
              enabled: true,
              policy: { minimumEvidence: 'confirmed' },
            },
          },
        },
      } as any,
      { ...baseConfig, logger },
      primaryBinding,
    );

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const message = logger.warn.mock.calls[0]?.[0] as string;
    expect(message).toContain('writer');
    expect(message).toContain('confirmed');
  });

  it('MB-2: does not warn when a policy is configured but does not require evidence above the default', async () => {
    const logger = makeLogger();

    await createConfiguredDispatchModel(
      {
        ...baseSpec,
        execution: {
          modelOptions: {
            dispatch: {
              enabled: true,
              policy: { retryRuntimeFailures: true },
            },
          },
        },
      } as any,
      { ...baseConfig, logger },
      primaryBinding,
    );

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('MB-2: does not warn when an evidence source IS wired, even with a demanding policy', async () => {
    const logger = makeLogger();
    const source = evidenceSourceFromMap({
      'primary-connection': readinessEvidence('smoke-passed'),
    });

    await createConfiguredDispatchModel(
      {
        ...baseSpec,
        execution: {
          modelOptions: {
            dispatch: {
              enabled: true,
              policy: { minimumEvidence: 'confirmed' },
            },
          },
        },
      } as any,
      { ...baseConfig, dispatchEvidenceSource: source, logger },
      primaryBinding,
    );

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('M-1b: a policy-carrying config with no source AND no logger still warns, via the module-level fallback logger', async () => {
    moduleLoggerWarn.mockClear();

    await createConfiguredDispatchModel(
      {
        ...baseSpec,
        execution: {
          modelOptions: {
            dispatch: {
              enabled: true,
              policy: { minimumEvidence: 'confirmed' },
            },
          },
        },
      } as any,
      // No dispatchEvidenceSource, no logger — the previously-silent case.
      baseConfig,
      primaryBinding,
    );

    expect(moduleLoggerWarn).toHaveBeenCalledTimes(1);
    const message = moduleLoggerWarn.mock.calls[0]?.[0] as string;
    expect(message).toContain('writer');
    expect(message).toContain('confirmed');
  });

  it('MB-2 engine-level test: the override-path-shaped config and the registered-agent-path-shaped config grade an identical candidate identically', async () => {
    const source = evidenceSourceFromMap({
      'primary-connection': readinessEvidence('smoke-passed'),
    });

    // Shape produced by runtime-agent-builder.ts's AgentCreationConfig
    // (the registered-agent path).
    const registeredAgentPathConfig = {
      appConfig: {},
      projectHomeDir: '/tmp/station-test-home',
      usageAggregator: undefined,
      modelCatalog: undefined,
      listProviderConnections: () => [],
      dispatchEvidenceSource: source,
      logger: makeLogger(),
      approvalRegistry: {},
      hooks: {},
    } as any;

    // Shape produced by chat-model-override.ts's config object (the
    // one-shot override path) — a narrower object, no approvalRegistry/hooks.
    const overridePathConfig = {
      appConfig: {},
      projectHomeDir: '/tmp/station-test-home',
      modelCatalog: undefined,
      listProviderConnections: () => [],
      dispatchEvidenceSource: source,
      logger: makeLogger(),
    } as any;

    await createConfiguredDispatchModel(
      baseSpec,
      registeredAgentPathConfig,
      primaryBinding,
    );
    const registeredAgentPlan = await resolveCapturedPlan();
    const registeredAgentEvidence = registeredAgentPlan.candidates[0].evidence;

    await createConfiguredDispatchModel(
      baseSpec,
      overridePathConfig,
      primaryBinding,
    );
    const overridePathPlan = await resolveCapturedPlan();
    const overridePathEvidence = overridePathPlan.candidates[0].evidence;

    expect(overridePathEvidence).toEqual(registeredAgentEvidence);
    expect(overridePathEvidence.level).toBe('confirmed');
  });

  describe('#1431: candidate evidence re-grades lazily behind a TTL', () => {
    it('reuses the last grade within the TTL window — two invocations, one source call', async () => {
      const source = evidenceSourceFromMap({
        'primary-connection': readinessEvidence('catalog-ready'),
      });

      await createConfiguredDispatchModel(
        baseSpec,
        { ...baseConfig, dispatchEvidenceSource: source },
        primaryBinding,
      );

      const firstPlan = await resolveCapturedPlan();
      const secondPlan = await resolveCapturedPlan();

      expect(firstPlan.candidates[0].evidence.level).toBe('declared');
      expect(secondPlan.candidates[0].evidence.level).toBe('declared');
      expect(source.calls).toHaveLength(1);
    });

    it('re-grades past the TTL — a smoke that lands mid-window is picked up on the next invocation without a rebuild (the #1431 under-claim scenario)', async () => {
      vi.useFakeTimers();
      try {
        const evidenceByConnection: Record<
          string,
          ConnectionReadinessEvidence
        > = {
          'primary-connection': readinessEvidence('discovered'),
        };
        const source: DispatchEvidenceSource & {
          calls: readonly (readonly string[])[];
        } = {
          calls: [] as string[][],
          getConnectionReadinessEvidence: async (connectionIds) => {
            (source.calls as string[][]).push([...connectionIds]);
            const result = new Map<string, ConnectionReadinessEvidence>();
            for (const id of connectionIds) {
              const evidence = evidenceByConnection[id];
              if (evidence) result.set(id, evidence);
            }
            return result;
          },
        };

        await createConfiguredDispatchModel(
          baseSpec,
          { ...baseConfig, dispatchEvidenceSource: source },
          primaryBinding,
        );

        const beforeSmoke = await resolveCapturedPlan();
        expect(beforeSmoke.candidates[0].evidence.level).toBe('unavailable');

        // The operator runs a smoke mid-TTL-window. The connection's live
        // evidence is now smoke-passed, but nothing rebuilt the agent.
        evidenceByConnection['primary-connection'] =
          readinessEvidence('smoke-passed');

        // Still inside the TTL window: the cached (stale) grade is reused,
        // no new source call, evidence still not upgraded yet.
        vi.advanceTimersByTime(DISPATCH_EVIDENCE_TTL_MS - 1);
        const stillCached = await resolveCapturedPlan();
        expect(stillCached.candidates[0].evidence.level).toBe('unavailable');
        expect(source.calls).toHaveLength(1);

        // Past the TTL window: the next invocation re-resolves live
        // evidence and picks up the smoke — this is the exact archive#1431
        // under-claim scenario the TTL exists to fix.
        vi.advanceTimersByTime(2);
        const afterTtl = await resolveCapturedPlan();
        expect(afterTtl.candidates[0].evidence.level).toBe('confirmed');
        expect(source.calls).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('an evidence source that starts throwing mid-TTL degrades to unavailable without breaking the turn', async () => {
      vi.useFakeTimers();
      try {
        const logger = makeLogger();
        let shouldThrow = false;
        const source: DispatchEvidenceSource = {
          getConnectionReadinessEvidence: async (connectionIds) => {
            if (shouldThrow) {
              throw new Error('Model inventory generation is obsolete.');
            }
            const result = new Map<string, ConnectionReadinessEvidence>();
            for (const id of connectionIds) {
              result.set(id, readinessEvidence('smoke-passed'));
            }
            return result;
          },
        };

        await createConfiguredDispatchModel(
          baseSpec,
          { ...baseConfig, dispatchEvidenceSource: source, logger },
          primaryBinding,
        );

        const firstPlan = await resolveCapturedPlan();
        expect(firstPlan.candidates[0].evidence.level).toBe('confirmed');

        shouldThrow = true;
        vi.advanceTimersByTime(DISPATCH_EVIDENCE_TTL_MS + 1);

        // The re-grade past TTL hits a throwing source. The plan promise
        // must still resolve (never reject and break the turn) and every
        // candidate must degrade to the honest 'unavailable' floor.
        await expect(resolveCapturedPlan()).resolves.toMatchObject({
          candidates: [
            { evidence: { level: 'unavailable', capabilities: [] } },
          ],
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('SF-1: concurrent invocations past TTL share ONE in-flight source call instead of stampeding', async () => {
      vi.useFakeTimers();
      try {
        let callCount = 0;
        let releaseSourceCall: (() => void) | undefined;
        const source: DispatchEvidenceSource = {
          getConnectionReadinessEvidence: async (connectionIds) => {
            callCount += 1;
            // Blocks until manually released — proves concurrent callers
            // share the same in-flight promise (only ONE call reaches this
            // block per resolution attempt) rather than each racing in and
            // starting their own listConnections() pass.
            await new Promise<void>((resolve) => {
              releaseSourceCall = resolve;
            });
            const result = new Map<string, ConnectionReadinessEvidence>();
            for (const id of connectionIds) {
              result.set(id, readinessEvidence('smoke-passed'));
            }
            return result;
          },
        };

        await createConfiguredDispatchModel(
          baseSpec,
          { ...baseConfig, dispatchEvidenceSource: source },
          primaryBinding,
        );

        // Prime the cache with one resolution.
        const primePromise = resolveCapturedPlan();
        expect(callCount).toBe(1);
        releaseSourceCall?.();
        const primed = await primePromise;
        expect(primed.candidates[0].evidence.level).toBe('confirmed');

        // Past the TTL: fire 3 concurrent invocations before any of them
        // can complete.
        vi.advanceTimersByTime(DISPATCH_EVIDENCE_TTL_MS + 1);
        // Restated rather than left narrowed: the reassignment happens
        // inside the evidence-source closure below, which TypeScript cannot
        // see, so a bare `undefined` here narrows the handle to `undefined`
        // and makes the release call at the end of the block uncallable.
        releaseSourceCall = undefined as (() => void) | undefined;
        const p1 = resolveCapturedPlan();
        const p2 = resolveCapturedPlan();
        const p3 = resolveCapturedPlan();

        // The stampede probe: exactly ONE new source call for all three
        // concurrent callers, not three.
        expect(callCount).toBe(2);

        releaseSourceCall?.();
        const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

        expect(callCount).toBe(2);
        expect(r1.candidates[0].evidence.level).toBe('confirmed');
        expect(r2).toEqual(r1);
        expect(r3).toEqual(r1);
      } finally {
        vi.useRealTimers();
      }
    });

    describe('SF-2: exclusion logging is a change feed, not a per-window repeat', () => {
      it('an unchanged grade across two TTL windows produces exactly ONE log line', async () => {
        vi.useFakeTimers();
        try {
          const logger = makeLogger();
          const source = evidenceSourceFromMap({
            'primary-connection': readinessEvidence('discovered'),
          });

          await createConfiguredDispatchModel(
            {
              ...baseSpec,
              execution: {
                modelOptions: {
                  dispatch: {
                    enabled: true,
                    policy: { minimumEvidence: 'confirmed' },
                  },
                },
              },
            } as any,
            { ...baseConfig, dispatchEvidenceSource: source, logger },
            primaryBinding,
          );

          const firstPlan = await resolveCapturedPlan();
          expect(firstPlan.candidates[0].evidence.level).toBe('unavailable');
          expect(logger.info).toHaveBeenCalledTimes(1);

          // Second window, same (unchanged) grade — no new log line.
          vi.advanceTimersByTime(DISPATCH_EVIDENCE_TTL_MS + 1);
          const secondPlan = await resolveCapturedPlan();
          expect(secondPlan.candidates[0].evidence.level).toBe('unavailable');
          expect(logger.info).toHaveBeenCalledTimes(1);
          expect(source.calls).toHaveLength(2);
        } finally {
          vi.useRealTimers();
        }
      });

      it('a changed grade across TTL windows produces a NEW log line naming the change', async () => {
        vi.useFakeTimers();
        try {
          const logger = makeLogger();
          const evidenceByConnection: Record<
            string,
            ConnectionReadinessEvidence
          > = {
            'primary-connection': readinessEvidence('discovered'),
          };
          const source: DispatchEvidenceSource = {
            getConnectionReadinessEvidence: async (connectionIds) => {
              const result = new Map<string, ConnectionReadinessEvidence>();
              for (const id of connectionIds) {
                const evidence = evidenceByConnection[id];
                if (evidence) result.set(id, evidence);
              }
              return result;
            },
          };

          await createConfiguredDispatchModel(
            {
              ...baseSpec,
              execution: {
                modelOptions: {
                  dispatch: {
                    enabled: true,
                    policy: { minimumEvidence: 'confirmed' },
                  },
                },
              },
            } as any,
            { ...baseConfig, dispatchEvidenceSource: source, logger },
            primaryBinding,
          );

          const firstPlan = await resolveCapturedPlan();
          expect(firstPlan.candidates[0].evidence.level).toBe('unavailable');
          expect(logger.info).toHaveBeenCalledTimes(1);

          // The grade changes (still excluded, different reason) mid-window
          // one TTL window later.
          evidenceByConnection['primary-connection'] =
            readinessEvidence('catalog-ready');
          vi.advanceTimersByTime(DISPATCH_EVIDENCE_TTL_MS + 1);
          const secondPlan = await resolveCapturedPlan();
          expect(secondPlan.candidates[0].evidence.level).toBe('declared');

          // A second, distinct log line fires, naming the previous grade.
          expect(logger.info).toHaveBeenCalledTimes(2);
          const secondMessage = logger.info.mock.calls[1]?.[0] as string;
          expect(secondMessage).toContain("evidence is 'declared'");
          expect(secondMessage).toContain("(was 'unavailable')");
        } finally {
          vi.useRealTimers();
        }
      });

      it('R-1: a candidate that recovers from excluded to admitted logs an admitted line exactly once', async () => {
        vi.useFakeTimers();
        try {
          const logger = makeLogger();
          const evidenceByConnection: Record<
            string,
            ConnectionReadinessEvidence
          > = {
            'primary-connection': readinessEvidence('discovered'),
          };
          const source: DispatchEvidenceSource = {
            getConnectionReadinessEvidence: async (connectionIds) => {
              const result = new Map<string, ConnectionReadinessEvidence>();
              for (const id of connectionIds) {
                const evidence = evidenceByConnection[id];
                if (evidence) result.set(id, evidence);
              }
              return result;
            },
          };

          await createConfiguredDispatchModel(
            {
              ...baseSpec,
              execution: {
                modelOptions: {
                  dispatch: {
                    enabled: true,
                    policy: { minimumEvidence: 'confirmed' },
                  },
                },
              },
            } as any,
            { ...baseConfig, dispatchEvidenceSource: source, logger },
            primaryBinding,
          );

          // Window 1: excluded (unavailable < confirmed) — one exclusion line.
          const firstPlan = await resolveCapturedPlan();
          expect(firstPlan.candidates[0].evidence.level).toBe('unavailable');
          expect(logger.info).toHaveBeenCalledTimes(1);

          // The connection earns a smoke; window 2 clears the bar.
          evidenceByConnection['primary-connection'] =
            readinessEvidence('smoke-passed');
          vi.advanceTimersByTime(DISPATCH_EVIDENCE_TTL_MS + 1);
          const secondPlan = await resolveCapturedPlan();
          expect(secondPlan.candidates[0].evidence.level).toBe('confirmed');

          // R-1: a distinct 'admitted' line fires, naming the recovery.
          expect(logger.info).toHaveBeenCalledTimes(2);
          const admittedMessage = logger.info.mock.calls[1]?.[0] as string;
          expect(admittedMessage).toContain(
            "Candidate 'candidate-0' admitted for agent 'writer'",
          );
          expect(admittedMessage).toContain("evidence is 'confirmed'");
          expect(admittedMessage).toContain("(was 'unavailable')");

          // Window 3: still admitted, unchanged grade — no further line
          // (the admitted line fires once, at the transition, not every
          // window the candidate stays admitted).
          vi.advanceTimersByTime(DISPATCH_EVIDENCE_TTL_MS + 1);
          const thirdPlan = await resolveCapturedPlan();
          expect(thirdPlan.candidates[0].evidence.level).toBe('confirmed');
          expect(logger.info).toHaveBeenCalledTimes(2);
        } finally {
          vi.useRealTimers();
        }
      });

      it('R-1: a candidate admitted from the start logs nothing (no exclusion, no spurious admitted line)', async () => {
        const logger = makeLogger();
        const source = evidenceSourceFromMap({
          'primary-connection': readinessEvidence('smoke-passed'),
        });

        await createConfiguredDispatchModel(
          {
            ...baseSpec,
            execution: {
              modelOptions: {
                dispatch: {
                  enabled: true,
                  policy: { minimumEvidence: 'confirmed' },
                },
              },
            },
          } as any,
          { ...baseConfig, dispatchEvidenceSource: source, logger },
          primaryBinding,
        );

        const plan = await resolveCapturedPlan();
        expect(plan.candidates[0].evidence.level).toBe('confirmed');
        expect(logger.info).not.toHaveBeenCalled();
      });
    });
  });
});

describe('policy validation (station#1398 slice 5.5)', () => {
  const baseConfig = {
    appConfig: {},
    projectHomeDir: '/tmp/station-test-home',
  } as any;
  const primaryBinding = {
    providerConnection: { id: 'conn-a', type: 'anthropic' },
    providerType: 'anthropic',
    modelId: 'model-a',
  } as any;

  function specWithPolicy(policy: unknown) {
    return {
      name: 'validation-agent',
      execution: {
        modelOptions: { dispatch: { enabled: true, policy } },
      },
    } as any;
  }

  it('rejects an unknown minimumStructuredToolsFidelity rather than letting it reach the engine', async () => {
    // The whole `policy` object is handed to Dispatch verbatim, and an
    // unrecognized fidelity fails the engine's `fidelityRank` lookup — which
    // excludes EVERY candidate silently, with a receipt that says
    // 'no-eligible-candidates' and never mentions the typo. Validation is
    // what turns that into a config error the operator can read.
    await expect(
      createConfiguredDispatchModel(
        specWithPolicy({ minimumStructuredToolsFidelity: 'best-effort' }),
        baseConfig,
        primaryBinding,
      ),
    ).rejects.toThrow(/minimumStructuredToolsFidelity/);
  });

  it("rejects 'unavailable' as a MINIMUM even though it is a real fidelity value", async () => {
    // Dispatch's own type excludes it from this field: every candidate
    // clears it, so accepting it would let a config express a bar that
    // cannot bind while reading as though it does.
    await expect(
      createConfiguredDispatchModel(
        specWithPolicy({ minimumStructuredToolsFidelity: 'unavailable' }),
        baseConfig,
        primaryBinding,
      ),
    ).rejects.toThrow(/minimumStructuredToolsFidelity/);
  });

  it("accepts 'prompted' and 'native'", async () => {
    for (const fidelity of ['prompted', 'native']) {
      await expect(
        createConfiguredDispatchModel(
          specWithPolicy({ minimumStructuredToolsFidelity: fidelity }),
          baseConfig,
          primaryBinding,
        ),
      ).resolves.toBeDefined();
    }
  });
});

describe('S-1: conformance tripwire — our exclusion logging never disagrees with the real @kontourai/dispatch engine', () => {
  // This is the tripwire for the queued dispatch 0.2.0 -> 0.5.0 bump: it
  // does not hardcode an expected admitted set anywhere. It builds a real
  // plan through createConfiguredDispatchModel, runs the REAL dispatch()
  // engine against a registry where every candidate's runtime resolves and
  // succeeds, and cross-checks two independently-derived sets against each
  // other: which candidate ids the real engine actually admitted
  // (receipt.attempts) vs. which candidate ids OUR OWN logExcludedCandidates
  // logged as excluded. If a future dispatch version changes eligible()
  // ranking/comparison semantics, our hand-rolled logging predicate
  // (unchanged) would start disagreeing with the engine's real behavior —
  // exactly what this test exists to catch, loudly, before it ships as a
  // silent lie in an operator-facing log line.
  //
  // **Also carry L-3 into that bump** (archive#1398 security review, RECORD).
  // The fleet envelope resolves `selection` by matching the receipt's
  // succeeded attempt back to an ADMITTED candidate id
  // (`fleet-routing-envelope.ts`). If a future dispatch version ever admits
  // or attempts a candidate this Station's own replica of the eligibility
  // predicate considered excluded — the exact divergence this tripwire
  // detects — the envelope would render `selection: null` on a turn that
  // demonstrably succeeded: a receipt claiming nothing served, for a turn
  // that did. That is a provenance lie of the same class as the ones §8
  // names, and it is downstream of this tripwire rather than a separate
  // check, so whoever does the 0.5.0 bump should assert the envelope's
  // `selection` alongside the admitted-set comparison below rather than
  // treating a red tripwire as a logging-only concern.
  const baseSpec = {
    name: 'tripwire-agent',
    execution: { modelOptions: { dispatch: { enabled: true } } },
  } as any;
  const baseConfig = {
    appConfig: {},
    projectHomeDir: '/tmp/station-test-home',
  } as any;
  const primaryBinding = {
    providerConnection: { id: 'conn-a', type: 'anthropic' },
    providerType: 'anthropic',
    modelId: 'model-a',
  } as any;

  function makeLogger() {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  }

  beforeEach(() => {
    capturedPlan = undefined;
    createAiSdkManagedModel.mockClear();
    resolveManagedModelBinding.mockReset();
  });

  function excludedCandidateIdsFromLog(
    logger: ReturnType<typeof makeLogger>,
  ): Set<string> {
    const ids = new Set<string>();
    for (const call of logger.info.mock.calls) {
      const message = call[0] as string;
      const match = message.match(/^\[dispatch\] Candidate '([^']+)' excluded/);
      if (match?.[1]) ids.add(match[1]);
    }
    return ids;
  }

  const RANK_TO_STATION_LEVEL = {
    unavailable: 'discovered',
    declared: 'catalog-ready',
    confirmed: 'smoke-passed',
  } as const;
  const EVIDENCE_LEVELS = ['unavailable', 'declared', 'confirmed'] as const;

  // One candidate, one plan, per (minimumEvidence, evidence) pair — every
  // combination of "minimumEvidence at each rank x evidence at each rank"
  // (9 cells) gets its own real dispatch() run. One candidate per plan is
  // deliberate: dispatch()'s engine is an ordered FAILOVER router that stops
  // attempting further candidates after the first success
  // (`engine.js`'s `for` loop `return`s inside the loop body) — with more
  // than one eligible candidate and every runtime scripted to succeed,
  // `receipt.attempts` would only ever contain the first one tried, which
  // would make a multi-candidate admitted-set comparison fail for reasons
  // that have nothing to do with eligibility. One candidate removes that
  // confound entirely: it is either the sole attempt (eligible, succeeds) or
  // absent from attempts entirely (excluded).
  async function crossCheckAdmissionAgreesWithExclusionLog(
    minimumEvidence: (typeof EVIDENCE_LEVELS)[number],
    evidenceLevel: (typeof EVIDENCE_LEVELS)[number],
  ): Promise<void> {
    const source = evidenceSourceFromMap({
      'conn-a': readinessEvidence(RANK_TO_STATION_LEVEL[evidenceLevel]),
    });
    const logger = makeLogger();

    await createConfiguredDispatchModel(
      {
        ...baseSpec,
        execution: {
          modelOptions: {
            dispatch: { enabled: true, policy: { minimumEvidence } },
          },
        },
      } as any,
      { ...baseConfig, dispatchEvidenceSource: source, logger },
      primaryBinding,
    );

    // archive#1431: createConfiguredDispatchModel now returns a lazy
    // (function-form) plan — resolve it to the real plan object the same
    // way `@kontourai/dispatch/ai-sdk` does, so this tripwire still
    // exercises the real engine end to end rather than a stale static plan.
    const resolvedPlan = await resolveCapturedPlan();
    expect(resolvedPlan.candidates).toHaveLength(1);
    const [candidate] = resolvedPlan.candidates;

    const runtime = new FakeModelRuntime(
      [
        {
          provider: 'fixture',
          model: candidate.id,
          outputText: 'ok',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          latencyMs: 1,
        },
      ],
      candidate.runtimeId,
    );

    const plan = {
      ...resolvedPlan,
      // createConfiguredDispatchModel's plan omits `request` — the AI SDK
      // wrapper supplies it per-invocation. dispatch() itself requires one
      // to compute the receipt's invocation digest.
      request: { messages: [{ role: 'user' as const, content: 'hi' }] },
      // Capped at candidates.length (1) so budget truncation can never
      // confound an eligibility exclusion with a budget exclusion.
      budget: { maxAttempts: resolvedPlan.candidates.length },
    };
    const outcome = await dispatch(plan, {
      get: (id) => (id === runtime.id ? runtime : undefined),
    });

    const admittedIds = new Set(
      outcome.receipt.attempts.map((attempt) => attempt.candidateId),
    );
    const excludedIds = excludedCandidateIdsFromLog(logger);
    const notExcludedIds = new Set(
      [candidate.id].filter((id) => !excludedIds.has(id)),
    );

    expect(admittedIds).toEqual(notExcludedIds);
    // Sanity: the two sets partition the one candidate (never both, never
    // neither).
    expect(admittedIds.size + excludedIds.size).toBe(1);
  }

  for (const minimumEvidence of EVIDENCE_LEVELS) {
    for (const evidenceLevel of EVIDENCE_LEVELS) {
      it(`minimumEvidence='${minimumEvidence}' vs. candidate evidence='${evidenceLevel}' — engine admission and our exclusion log agree`, async () => {
        await crossCheckAdmissionAgreesWithExclusionLog(
          minimumEvidence,
          evidenceLevel,
        );
      });
    }
  }

  async function crossCheckRequiredCapabilities(
    requiredCapabilities: string[],
    toolSurface?: readonly string[] | null,
    extraPolicy: Record<string, unknown> = {},
  ): Promise<void> {
    // One candidate with confirmed evidence (abort/usage present, per
    // deriveDispatchCapabilities), so the ONLY variable under test is the
    // requiredCapabilities policy itself.
    //
    // R3-a (archive#1398, dispatch 0.5.0 bump): `toolSurface` is the second
    // variable this helper now accepts. Without it every candidate this
    // tripwire builds carries exactly `['abort', 'usage']`, which is why the
    // original three cases could not discriminate the engine's matching
    // semantics — see the R3-a case comments below.
    const source = evidenceSourceFromMap(
      { 'conn-a': readinessEvidence('smoke-passed') },
      toolSurface === undefined ? {} : { 'conn-a model-a': toolSurface },
    );
    const logger = makeLogger();

    await createConfiguredDispatchModel(
      {
        ...baseSpec,
        execution: {
          modelOptions: {
            dispatch: {
              enabled: true,
              policy: { requiredCapabilities, ...extraPolicy },
            },
          },
        },
      } as any,
      { ...baseConfig, dispatchEvidenceSource: source, logger },
      primaryBinding,
    );

    const resolvedPlan = await resolveCapturedPlan();
    expect(resolvedPlan.candidates).toHaveLength(1);
    const [candidate] = resolvedPlan.candidates;
    const runtime = new FakeModelRuntime(
      [
        {
          provider: 'fixture',
          model: candidate.id,
          outputText: 'ok',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          latencyMs: 1,
        },
      ],
      candidate.runtimeId,
    );

    const plan = {
      ...resolvedPlan,
      request: { messages: [{ role: 'user' as const, content: 'hi' }] },
      budget: { maxAttempts: resolvedPlan.candidates.length },
    };
    const outcome = await dispatch(plan, {
      get: (id) => (id === runtime.id ? runtime : undefined),
    });

    const admittedIds = new Set(
      outcome.receipt.attempts.map((attempt) => attempt.candidateId),
    );
    const excludedIds = excludedCandidateIdsFromLog(logger);
    const notExcludedIds = new Set(
      [candidate.id].filter((id) => !excludedIds.has(id)),
    );

    expect(admittedIds).toEqual(notExcludedIds);
  }

  it('requiredCapabilities present (candidate has it) — admitted, agreement holds', async () => {
    await crossCheckRequiredCapabilities(['abort']);
  });

  it('requiredCapabilities absent (candidate lacks it) — excluded, agreement holds', async () => {
    await crossCheckRequiredCapabilities(['structured-tools']);
  });

  it('requiredCapabilities empty — admitted regardless, agreement holds', async () => {
    await crossCheckRequiredCapabilities([]);
  });

  // ---------------------------------------------------------------------
  // R3-a — the MIXED case. The three cases above are individually correct
  // and jointly blind to the one thing `requiredCapabilities` actually
  // specifies: whether the engine requires EVERY named capability or merely
  // SOME of them. All-present admits under both readings, none-present
  // excludes under both, and an empty list admits under both — so an engine
  // that silently relaxed `every` to `some` would keep all three green while
  // routing a turn to a model that satisfies one requirement out of two.
  //
  // A mixed list against a candidate that holds one of the two names
  // discriminates without a hardcoded oracle, exactly like the rest of this
  // tripwire: `every` excludes, `some` admits, and our replica
  // (`logExcludedCandidates`, which uses `!every`) will disagree with the
  // engine the moment the engine stops meaning `every`.
  // ---------------------------------------------------------------------
  it('R3-a: MIXED requiredCapabilities, candidate holds one of two — agreement holds only if the engine means EVERY, not SOME', async () => {
    // Candidate capabilities are ['abort', 'usage'] (no tool surface wired):
    // 'abort' is held, 'structured-tools' is not.
    await crossCheckRequiredCapabilities(['abort', 'structured-tools']);
  });

  it('R3-a: MIXED requiredCapabilities, candidate holds both — agreement holds', async () => {
    // archive#1430's derivation: a confirmed candidate whose model tool
    // surface reports 'tool-calls' derives ['abort', 'usage',
    // 'structured-tools'], so BOTH names in the mixed list are held. This is
    // the other half of the discrimination — without it, a hypothetical
    // engine that had started refusing 'structured-tools' outright would be
    // indistinguishable from one that merely meant `every`.
    await crossCheckRequiredCapabilities(
      ['abort', 'structured-tools'],
      ['tool-calls'],
    );
  });

  // The 0.5.0 bump's second eligibility axis. `minimumStructuredToolsFidelity`
  // reaches `eligible()` whether or not Station declares it (the whole
  // `policy` object is passed to the engine verbatim), so these cases hold
  // the replica to it directly rather than only through the implicit
  // 'native' default that a `structured-tools` requirement turns on.
  it("R3-a: minimumStructuredToolsFidelity 'native' with NO structured-tools requirement, candidate has no tool surface — agreement holds", async () => {
    await crossCheckRequiredCapabilities([], null, {
      minimumStructuredToolsFidelity: 'native',
    });
  });

  it("R3-a: minimumStructuredToolsFidelity 'native' with a candidate that genuinely derives native fidelity — agreement holds", async () => {
    await crossCheckRequiredCapabilities([], ['tool-calls'], {
      minimumStructuredToolsFidelity: 'native',
    });
  });

  it("R3-a: minimumStructuredToolsFidelity 'prompted' is a LOWER bar than the implicit default — agreement holds", async () => {
    await crossCheckRequiredCapabilities(['structured-tools'], ['tool-calls'], {
      minimumStructuredToolsFidelity: 'prompted',
    });
  });

  it("R3-a: requiredCapabilities ['structured-tools'] against a candidate that genuinely derives it — agreement holds", async () => {
    // The mirror of the existing "candidate lacks it" case. Until this
    // existed, no tripwire case ever built a candidate CARRYING
    // 'structured-tools', so every assertion about that capability was an
    // assertion about its absence.
    await crossCheckRequiredCapabilities(['structured-tools'], ['tool-calls']);
  });

  // ---------------------------------------------------------------------
  // R3-b — the engine's DEFAULT minimumEvidence, pinned. Every case above
  // passes `minimumEvidence` explicitly, so the default the engine applies
  // when a policy object exists but says nothing about evidence was
  // unexercised. It matters: `isAdmitted` and `logExcludedCandidates` both
  // hardcode `policy?.minimumEvidence ?? 'unavailable'` as OUR replica of
  // that default, and a policy of `{}` is what an agent config that sets
  // only `retryRuntimeFailures` (or nothing at all beyond `policy: {}`)
  // actually produces.
  // ---------------------------------------------------------------------
  async function crossCheckDefaultMinimumEvidence(
    evidenceLevel: (typeof EVIDENCE_LEVELS)[number],
  ): Promise<Set<string>> {
    const source = evidenceSourceFromMap({
      'conn-a': readinessEvidence(RANK_TO_STATION_LEVEL[evidenceLevel]),
    });
    const logger = makeLogger();

    await createConfiguredDispatchModel(
      {
        ...baseSpec,
        execution: {
          modelOptions: {
            // `policy: {}` — present, so it reaches the engine as a policy
            // object, but naming neither minimumEvidence nor
            // requiredCapabilities. Not `policy: undefined`, which omits the
            // field entirely and is already covered by the base spec.
            dispatch: { enabled: true, policy: {} },
          },
        },
      } as any,
      { ...baseConfig, dispatchEvidenceSource: source, logger },
      primaryBinding,
    );

    const resolvedPlan = await resolveCapturedPlan();
    expect(resolvedPlan.candidates).toHaveLength(1);
    const [candidate] = resolvedPlan.candidates;
    const runtime = new FakeModelRuntime(
      [
        {
          provider: 'fixture',
          model: candidate.id,
          outputText: 'ok',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          latencyMs: 1,
        },
      ],
      candidate.runtimeId,
    );

    const outcome = await dispatch(
      {
        ...resolvedPlan,
        request: { messages: [{ role: 'user' as const, content: 'hi' }] },
        budget: { maxAttempts: resolvedPlan.candidates.length },
      },
      { get: (id) => (id === runtime.id ? runtime : undefined) },
    );

    const admittedIds = new Set(
      outcome.receipt.attempts.map((attempt) => attempt.candidateId),
    );
    const excludedIds = excludedCandidateIdsFromLog(logger);
    expect(admittedIds).toEqual(
      new Set([candidate.id].filter((id) => !excludedIds.has(id))),
    );
    expect(admittedIds.size + excludedIds.size).toBe(1);
    return admittedIds;
  }

  for (const evidenceLevel of EVIDENCE_LEVELS) {
    it(`R3-b: policy {} (no minimumEvidence named) vs. discovered evidence at '${evidenceLevel}' — engine admission and our exclusion log agree`, async () => {
      await crossCheckDefaultMinimumEvidence(evidenceLevel);
    });
  }

  it("R3-b: the engine's DEFAULT minimumEvidence is 'unavailable' — a candidate with NO live evidence still enters the routable set under policy {}", async () => {
    // The explicit pin behind the agreement checks above. Stated as its own
    // assertion because the default is a decision Station's own replica
    // copies verbatim: if the engine ever defaulted to 'declared' instead,
    // Station would go on offering ungraded candidates the engine now
    // refuses, and the receipt's `admitted: true` would be false about the
    // set the router actually considered.
    const admittedIds = await crossCheckDefaultMinimumEvidence('unavailable');
    expect([...admittedIds]).toEqual(['candidate-0']);
  });

  // ---------------------------------------------------------------------
  // R3-c — the multi-candidate ORDERING surface, recovered.
  //
  // The one-candidate-per-plan design above deliberately removes the
  // first-success confound (`engine.js`'s loop `return`s inside the body, so
  // with every runtime scripted to succeed `receipt.attempts` would only ever
  // hold the first eligible candidate). The cost was that nothing in this
  // tripwire ever observed the engine's admitted set as a SEQUENCE — which
  // is what `fleet-routing-envelope.ts`'s `selection` fold and the
  // `before-local`/`after-local` fleet ordering knob both depend on.
  //
  // A registry whose `get` returns undefined for EVERY runtime recovers it
  // without reintroducing the confound: `engine.js` pushes a
  // RUNTIME_NOT_FOUND attempt row and `continue`s rather than returning, so
  // `receipt.attempts` enumerates the entire admitted set, in the engine's
  // own order, with no candidate ever short-circuiting the rest.
  // ---------------------------------------------------------------------
  async function crossCheckMultiCandidateAdmissionOrder(
    minimumEvidence: (typeof EVIDENCE_LEVELS)[number],
  ): Promise<{ attemptedIds: string[]; excludedIds: Set<string> }> {
    const source = evidenceSourceFromMap({
      'conn-a': readinessEvidence('smoke-passed'), // confirmed
      'conn-b': readinessEvidence('discovered'), // unavailable
      'conn-c': readinessEvidence('catalog-ready'), // declared
    });
    const logger = makeLogger();
    resolveManagedModelBinding
      .mockResolvedValueOnce({
        providerConnection: { id: 'conn-b', type: 'ollama' },
        providerType: 'ollama',
        modelId: 'model-b',
      })
      .mockResolvedValueOnce({
        providerConnection: { id: 'conn-c', type: 'ollama' },
        providerType: 'ollama',
        modelId: 'model-c',
      });

    await createConfiguredDispatchModel(
      {
        ...baseSpec,
        execution: {
          modelOptions: {
            dispatch: {
              enabled: true,
              candidates: [
                { modelConnectionId: 'conn-b' },
                { modelConnectionId: 'conn-c' },
              ],
              policy: { minimumEvidence },
            },
          },
        },
      } as any,
      { ...baseConfig, dispatchEvidenceSource: source, logger },
      primaryBinding,
    );

    const resolvedPlan = await resolveCapturedPlan();
    expect(resolvedPlan.candidates).toHaveLength(3);

    const outcome = await dispatch(
      {
        ...resolvedPlan,
        request: { messages: [{ role: 'user' as const, content: 'hi' }] },
        // Never the binding constraint: equal to the FULL candidate count, so
        // a candidate missing from `attempts` is missing because the engine
        // refused it, never because the budget ran out.
        budget: { maxAttempts: resolvedPlan.candidates.length },
      },
      // Every runtime unresolvable — the whole point. See the block comment.
      { get: () => undefined },
    );

    const attemptedIds = outcome.receipt.attempts.map(
      (attempt) => attempt.candidateId,
    );
    const excludedIds = excludedCandidateIdsFromLog(logger);
    const notExcludedInPlanOrder = resolvedPlan.candidates
      .map((candidate: { id: string }) => candidate.id)
      .filter((id: string) => !excludedIds.has(id));

    // The ordering assertion the single-candidate cases cannot make: array
    // equality, not set equality.
    expect(attemptedIds).toEqual(notExcludedInPlanOrder);
    // Every attempt is the no-runtime row, so none of them short-circuited
    // the enumeration by succeeding.
    for (const attempt of outcome.receipt.attempts) {
      expect(attempt.errorCode).toBe('RUNTIME_NOT_FOUND');
      expect(attempt.outcome).toBe('failed');
    }
    return { attemptedIds, excludedIds };
  }

  it('R3-c: multi-candidate admission ORDER matches our exclusion log, with the first-success confound removed', async () => {
    const { attemptedIds } =
      await crossCheckMultiCandidateAdmissionOrder('declared');
    // conn-a is confirmed and conn-c is declared, so both clear a 'declared'
    // minimum; conn-b is unavailable and does not. Plan order is primary
    // first, then configured candidates in order.
    expect(attemptedIds).toEqual(['candidate-0', 'candidate-2']);
  });

  it('R3-c: with nothing excluded, the engine enumerates EVERY candidate in plan order', async () => {
    const { attemptedIds, excludedIds } =
      await crossCheckMultiCandidateAdmissionOrder('unavailable');
    expect(excludedIds.size).toBe(0);
    expect(attemptedIds).toEqual(['candidate-0', 'candidate-1', 'candidate-2']);
  });
});
