/**
 * archive#1398 — the wiring test: does an agent that opts into fleet
 * routing actually get peer candidates in its Dispatch plan, and does the
 * receipt that comes back carry every exclusion?
 *
 * The exclusion assertions are the load-bearing ones. §4.5's first banned
 * behavior is dropping an unverified capability with no diagnostic, and the
 * place that would happen is here — between "the peer said no" and "the
 * envelope was written".
 */

import { dispatch, executionPlanDigest } from '@kontourai/dispatch';
import { FakeModelRuntime } from '@kontourai/relay';
import type { ConnectionReadinessEvidence } from '@kontourai/station-contracts/tool';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FleetCandidateResolution } from '../../../services/inference/fleet-candidate-service.js';
import {
  type ActionOperationLedger,
  ActionOperationService,
  type ActionOperationStore,
} from '../../../services/operations/action-operation-service.js';
import { FleetDispatchActionOperationObserver } from '../../../services/operations/fleet-dispatch-action-operation-observer.js';
import {
  type AuthorizedFleetDispatchBegin,
  type AuthorizedFleetDispatchSettlement,
  type FleetDispatchCorrelationObserver,
  runWithAuthorizedTurnCorrelation,
} from '../authorized-turn-correlation.js';
import { FleetInferenceRoutingError } from '../fleet-inference-model.js';
import type { UnsealedFleetRoutingEnvelope } from '../fleet-routing-envelope.js';

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
let capturedOnReceipt: any;
let capturedModels: Record<string, unknown> = {};
vi.mock('@kontourai/dispatch/ai-sdk', () => ({
  createAiSdkDispatchModel: (options: any) => {
    capturedPlan = options.plan;
    capturedOnReceipt = options.onReceipt;
    capturedModels = options.models;
    return { id: options.id };
  },
}));

const { createConfiguredDispatchModel, DISPATCH_EVIDENCE_TTL_MS } =
  await import('../dispatch-model-policy.js');

const PEER_EVIDENCE = {
  level: 'declared' as const,
  provenance: 'peer-attested' as const,
  label: 'attested by peer, not verified',
  peerAttested: {
    availability: 'available',
    freshness: 'live',
    observedAt: '2026-08-01T00:00:00.000Z',
    manifestSourceObservedAt: '2026-08-01T00:00:00.000Z',
    fetchedAt: '2026-08-01T12:00:00.000Z',
    digest: 'a'.repeat(64),
  },
  probe: null,
};

function resolution(
  overrides: Partial<FleetCandidateResolution> = {},
): FleetCandidateResolution {
  return {
    resolvedAt: '2026-08-01T12:00:00.000Z',
    candidates: [
      {
        environmentId: 'env-workstation',
        environmentLabel: 'Workstation',
        apiBase: 'https://workstation.example',
        credential: 'peer-credential-value-0000000000',
        modelId: 'ollama/qwen3',
        displayName: 'Qwen3 32B',
        evidence: PEER_EVIDENCE,
      },
    ],
    exclusions: [
      {
        candidateId: null,
        environmentId: 'env-nas',
        environmentLabel: 'NAS',
        modelId: null,
        code: 'peer-unreachable',
        message: 'NAS is not answering.',
        source: 'station',
      },
    ],
    ...overrides,
  };
}

const readiness: ConnectionReadinessEvidence = {
  evidenceVersion: 1,
  level: 'smoke-passed',
  observedAt: '2026-08-01T00:00:00.000Z',
  freshness: 'fresh',
  summary: 'smoke passed',
  smoke: { status: 'passed', freshness: 'fresh', turnLimit: 1 },
};

const written: UnsealedFleetRoutingEnvelope[] = [];

function config(
  fleetResolution: FleetCandidateResolution | null,
  observer?: FleetDispatchCorrelationObserver,
) {
  return {
    appConfig: {} as never,
    projectHomeDir: '/tmp/station-fleet-test',
    dispatchEvidenceSource: {
      getConnectionReadinessEvidence: async (ids: readonly string[]) =>
        new Map(ids.map((id) => [id, readiness])),
    },
    ...(fleetResolution
      ? {
          fleetRouting: {
            environmentId: 'env-laptop',
            resolveCandidates: async () => fleetResolution,
            appendReceipt: async (envelope: UnsealedFleetRoutingEnvelope) => {
              written.push(envelope);
              return {
                ...envelope,
                receiptId: `sealed-${written.length}`,
              } as never;
            },
            ...(observer ? { observer } : {}),
          },
        }
      : {}),
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as never;
}

const spec = {
  name: 'researcher',
  execution: {
    modelOptions: {
      dispatch: { enabled: true, fleet: { enabled: true } },
    },
  },
} as never;

const primary = {
  providerConnection: { id: 'conn-local' },
  modelId: 'claude-sonnet',
} as never;

/**
 * Resolves a plan and computes the digest Dispatch will stamp on the receipt
 * for it — `executionPlanDigest` over the same `{...plan, request}` the engine
 * dispatches. Production computes this inside `plan()`; the test computes it
 * the same way so the join under test is the real one and not a fixture.
 */
async function resolvePlanWithDigest(
  request: unknown = { messages: [{ role: 'user', content: 'hi' }] },
): Promise<{ plan: any; planDigest: string }> {
  const plan = await capturedPlan(request);
  return {
    plan,
    planDigest: executionPlanDigest({ ...plan, request } as never),
  };
}

function receiptFor(
  planDigest: string,
  overrides: Record<string, unknown> = {},
): any {
  return {
    schemaVersion: 1,
    planDigest,
    requestDigest: 'request',
    role: 'station-agent',
    outcome: 'succeeded',
    attempts: [],
    totalElapsedMs: 1,
    totalTokens: 0,
    estimatedCostUsd: 0,
    ...overrides,
  };
}

beforeEach(() => {
  written.length = 0;
  capturedPlan = undefined;
  capturedOnReceipt = undefined;
  capturedModels = {};
  vi.clearAllMocks();
});

describe('fleet candidates join the Dispatch plan', () => {
  it('registers one runtime per contributed peer model and grades it peer-attested', async () => {
    await createConfiguredDispatchModel(spec, config(resolution()), primary);
    const plan = await capturedPlan({});

    expect(Object.keys(capturedModels)).toContain('fleet-runtime-0');
    const fleetCandidate = plan.candidates.find(
      (candidate: { id: string }) => candidate.id === 'fleet-candidate-0',
    );
    expect(fleetCandidate).toBeDefined();
    expect(fleetCandidate.evidence.level).toBe('declared');
    expect(fleetCandidate.evidence.source).toBe(
      'station:peer-fleet-manifest/v1',
    );
  });

  // archive#1430 review, M-2: a fleet candidate must never derive
  // 'structured-tools', however healthy the peer's own claim is — a peer's
  // self-reported capability must not become an asserted fact the way a
  // locally-observed one does (the exact reasoning that already caps
  // peer-attested evidence at 'declared', never 'confirmed'). No wire today
  // even carries a peer's `toolSurface` claim into this resolution path
  // (`FleetCandidateEvidence` has no such field), so this pins the call
  // site's SHAPE: `resolveFleetPlanHalf` passes only `live.evidence.level`
  // to `deriveDispatchCapabilities`, never a second argument — at the
  // peer's best reachable level, `declared`, the derived set is exactly
  // `['abort', 'usage']`. If a future slice threads a peer's tool-surface
  // claim through and wires it into this derivation without the deliberate
  // exclusion the comment at that call site names, this goes red.
  it("M-2: a fleet candidate at its best reachable evidence level ('declared') never derives 'structured-tools'", async () => {
    await createConfiguredDispatchModel(spec, config(resolution()), primary);
    const plan = await capturedPlan({});

    const fleetCandidate = plan.candidates.find(
      (candidate: { id: string }) => candidate.id === 'fleet-candidate-0',
    );
    expect(fleetCandidate.evidence.level).toBe('declared');
    expect(fleetCandidate.evidence.capabilities).toEqual(['abort', 'usage']);
    expect(fleetCandidate.evidence.capabilities).not.toContain(
      'structured-tools',
    );
    // archive#1398: the same refusal on dispatch 0.5.0's SECOND
    // axis. A peer's self-reported tool surface must not become an asserted
    // structured-tool fidelity any more than it may become an asserted
    // capability — and because 0.5.0 refuses evidence whose two halves
    // disagree, a future edit that threads a peer's claim into one half
    // without the other now fails eligibility outright rather than routing
    // on an over-claim.
    expect(fleetCandidate.evidence.structuredToolsFidelity).toBe('unavailable');
  });

  it('places fleet candidates after local ones by default', async () => {
    await createConfiguredDispatchModel(spec, config(resolution()), primary);
    const plan = await capturedPlan({});
    expect(plan.candidates.map((c: { id: string }) => c.id)).toEqual([
      'candidate-0',
      'fleet-candidate-0',
    ]);
  });

  it('honours before-local when the operator asked for the fleet first', async () => {
    await createConfiguredDispatchModel(
      {
        ...(spec as object),
        execution: {
          modelOptions: {
            dispatch: {
              enabled: true,
              fleet: { enabled: true, order: 'before-local' },
            },
          },
        },
      } as never,
      config(resolution()),
      primary,
    );
    const plan = await capturedPlan({});
    expect(plan.candidates[0].id).toBe('fleet-candidate-0');
  });

  it('warns loudly and stays local-only when fleet routing is not wired', async () => {
    const unwired = config(null);
    await createConfiguredDispatchModel(spec, unwired, primary);
    const plan = await capturedPlan({});
    expect(plan.candidates.map((c: { id: string }) => c.id)).toEqual([
      'candidate-0',
    ]);
    expect(
      (unwired as never as { logger: { warn: ReturnType<typeof vi.fn> } })
        .logger.warn,
    ).toHaveBeenCalledWith(expect.stringContaining('opted into fleet routing'));
  });
});

describe('the receipt envelope carries every exclusion', () => {
  it('writes the peer’s exclusions and the peer-attested candidate record', async () => {
    await createConfiguredDispatchModel(spec, config(resolution()), primary);
    const { planDigest } = await resolvePlanWithDigest();
    await capturedOnReceipt(
      receiptFor(planDigest, {
        attempts: [
          {
            candidateId: 'fleet-candidate-0',
            runtimeId: 'fleet-runtime-0',
            outcome: 'succeeded',
            elapsedMs: 10,
          },
        ],
      }),
    );

    expect(written).toHaveLength(1);
    const envelope = written[0]!;
    expect(envelope.environmentId).toBe('env-laptop');
    expect(envelope.agentName).toBe('researcher');
    // The unreachable peer must be in the receipt. A receipt that recorded
    // only what ran would make an unreachable machine indistinguishable from
    // a machine that was never in the fleet.
    expect(envelope.exclusions.map((exclusion) => exclusion.code)).toContain(
      'peer-unreachable',
    );
    const fleetRecord = envelope.candidates.find(
      (candidate) => candidate.origin === 'fleet',
    );
    expect(fleetRecord?.evidence.provenance).toBe('peer-attested');
    expect(fleetRecord?.evidence.peerAttested?.digest).toBe('a'.repeat(64));
    expect(envelope.selection?.environmentLabel).toBe('Workstation');
  });

  it('names a candidate the policy refused with below-minimum-evidence', async () => {
    // `minimumEvidence: 'confirmed'` can never admit a peer-attested
    // candidate — the cap sees to that — so this is the case §4.5 calls the
    // one users most need to see: "you have one and I refused to trust it".
    await createConfiguredDispatchModel(
      {
        ...(spec as object),
        execution: {
          modelOptions: {
            dispatch: {
              enabled: true,
              fleet: { enabled: true },
              policy: { minimumEvidence: 'confirmed' },
            },
          },
        },
      } as never,
      config(resolution()),
      primary,
    );
    const { planDigest } = await resolvePlanWithDigest();
    await capturedOnReceipt(
      receiptFor(planDigest, {
        attempts: [
          {
            candidateId: 'candidate-0',
            runtimeId: 'runtime-0',
            outcome: 'succeeded',
            elapsedMs: 4,
          },
        ],
      }),
    );

    const envelope = written[0]!;
    const refused = envelope.exclusions.find(
      (exclusion) => exclusion.candidateId === 'fleet-candidate-0',
    );
    expect(refused?.code).toBe('below-minimum-evidence');
    expect(refused?.message).toContain('attested by peer, not verified');
  });

  it('names a contribution withdrawn since the candidate set was built', async () => {
    // The set is fixed at construction; the GRADE is not. A peer that stops
    // contributing must not simply vanish from the surface.
    let contributing = true;
    const cfg = {
      ...(config(resolution()) as object),
      fleetRouting: {
        environmentId: 'env-laptop',
        resolveCandidates: async () =>
          contributing
            ? resolution()
            : resolution({ candidates: [], exclusions: [] }),
        appendReceipt: async (envelope: UnsealedFleetRoutingEnvelope) => {
          written.push(envelope);
          return envelope as never;
        },
      },
    } as never;
    // Construction builds the runtime registry from the contributing state;
    // the withdrawal happens before the first turn resolves its grade.
    await createConfiguredDispatchModel(spec, cfg, primary);
    contributing = false;
    const { plan, planDigest } = await resolvePlanWithDigest();
    await capturedOnReceipt(
      receiptFor(planDigest, { outcome: 'no-eligible-candidates' }),
    );

    const envelope = written[0]!;
    expect(envelope.exclusions.map((exclusion) => exclusion.code)).toContain(
      'capability-withdrawn',
    );
    expect(envelope.failure?.code).toBe('no-eligible-candidates');

    // Security review, M-3: the withdrawn candidate used to report
    // `admitted: true` in the same envelope as its own
    // `capability-withdrawn` exclusion — `isAdmitted`'s default minimum of
    // `unavailable` passes an unavailable grade, so one receipt stated both
    // that it routed and that it could not.
    const withdrawn = envelope.candidates.find(
      (candidate) => candidate.origin === 'fleet',
    );
    expect(withdrawn?.admitted).toBe(false);

    // ...and it is withheld from the router entirely, so Dispatch cannot
    // spend a budgeted attempt earning a `model-not-contributed` refusal.
    expect(
      plan.candidates.map((candidate: { id: string }) => candidate.id),
    ).not.toContain('fleet-candidate-0');
  });

  it('names a contribution that appeared AFTER the set was built (L-1)', async () => {
    // The other side of the frozen-candidate-set honesty story, and the one
    // that was untested: a peer that starts contributing mid-life must read
    // as "invisible until the next rebuild", never as rejected and never as
    // absent.
    let lateContributed = false;
    const late = {
      environmentId: 'env-nas',
      environmentLabel: 'NAS',
      apiBase: 'https://nas.example',
      credential: 'nas-credential-value-000000000000',
      modelId: 'ollama/llama4',
      displayName: 'Llama 4',
      evidence: PEER_EVIDENCE,
    };
    const cfg = {
      ...(config(resolution()) as object),
      fleetRouting: {
        environmentId: 'env-laptop',
        resolveCandidates: async () => {
          const base = resolution();
          return lateContributed
            ? { ...base, candidates: [...base.candidates, late] }
            : base;
        },
        appendReceipt: async (envelope: UnsealedFleetRoutingEnvelope) => {
          written.push(envelope);
          return envelope as never;
        },
      },
    } as never;
    await createConfiguredDispatchModel(spec, cfg, primary);
    // The NAS starts contributing after the candidate set was built.
    lateContributed = true;
    const { plan, planDigest } = await resolvePlanWithDigest();
    await capturedOnReceipt(receiptFor(planDigest));

    const envelope = written[0]!;
    const lateExclusion = envelope.exclusions.find(
      (exclusion) => exclusion.code === 'not-in-resolved-set',
    );
    expect(lateExclusion).toMatchObject({
      environmentId: 'env-nas',
      modelId: 'ollama/llama4',
    });
    expect(lateExclusion?.message).toContain('next rebuilt');
    // It is named, not routed to: no runtime exists for it in this model.
    expect(Object.keys(capturedModels)).not.toContain('fleet-runtime-1');
    expect(plan.candidates).toHaveLength(2);
  });
});

describe('concurrent turns get their OWN receipt (security review, H-1a)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pairs each Dispatch receipt with the candidate set its own plan resolved', async () => {
    // The defect, precisely: one built Dispatch model serves every invocation
    // of its agent. `plan()` runs per invocation and `onReceipt` fires when
    // that invocation finishes, with nothing ordering them. Two turns
    // straddling the evidence TTL resolve DIFFERENT candidate sets, and a
    // single `lastRouting` variable gave the second resolution's candidates
    // and exclusions to the FIRST turn's receipt — an internally consistent,
    // individually plausible receipt that is false about which machines were
    // considered.
    // Driven by a flag, not a call counter: model CONSTRUCTION performs its
    // own resolution to build the runtime registry, so a counter would be
    // off by one and the test would silently assert the wrong turn.
    let contributing = true;
    const cfg = {
      ...(config(resolution()) as object),
      fleetRouting: {
        environmentId: 'env-laptop',
        resolveCandidates: async () =>
          // Turn A sees the workstation contributing; by turn B it has
          // withdrawn. Two genuinely different considered sets.
          contributing
            ? resolution()
            : resolution({ candidates: [], exclusions: [] }),
        appendReceipt: async (envelope: UnsealedFleetRoutingEnvelope) => {
          written.push(envelope);
          return envelope as never;
        },
      },
    } as never;

    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000);
    await createConfiguredDispatchModel(spec, cfg, primary);

    // Turn A resolves inside the TTL window.
    const turnA = await resolvePlanWithDigest({
      messages: [{ role: 'user', content: 'turn A' }],
    });
    // Turn B resolves after it expires, so it re-resolves and sees the
    // withdrawal.
    contributing = false;
    nowSpy.mockReturnValue(1_000 + DISPATCH_EVIDENCE_TTL_MS + 1);
    const turnB = await resolvePlanWithDigest({
      messages: [{ role: 'user', content: 'turn B' }],
    });

    expect(turnA.planDigest).not.toBe(turnB.planDigest);

    // Receipts arrive OUT OF ORDER — B finishes first. Under last-write-wins
    // this is already lost; under the digest join it does not matter.
    await capturedOnReceipt(receiptFor(turnB.planDigest));
    await capturedOnReceipt(receiptFor(turnA.planDigest));

    expect(written).toHaveLength(2);
    const [envelopeB, envelopeA] = written;

    // Turn A considered the workstation and did NOT see it withdrawn.
    expect(
      envelopeA?.candidates.some(
        (candidate) =>
          candidate.origin === 'fleet' && candidate.admitted === true,
      ),
    ).toBe(true);
    expect(
      envelopeA?.exclusions.map((exclusion) => exclusion.code),
    ).not.toContain('capability-withdrawn');

    // Turn B saw the withdrawal. If the two had been swapped or shared, one
    // of these two assertions would fail.
    expect(envelopeB?.exclusions.map((exclusion) => exclusion.code)).toContain(
      'capability-withdrawn',
    );
    expect(
      envelopeB?.candidates.every(
        (candidate) => candidate.origin !== 'fleet' || !candidate.admitted,
      ),
    ).toBe(true);
  });
});

describe('a failed resolution is receipted, not swallowed (H-1b/H-1c)', () => {
  it('writes an envelope naming resolution-failed for every known peer model', async () => {
    // H-1(c): this path used to drop the whole fleet half and return
    // `routing: null`, so every fleet capability vanished from the turn with
    // no diagnostic — §4.5's first banned behavior, inside the module whose
    // docblock claims the shape is unrepresentable.
    // Same reason as above: construction resolves once before any turn does.
    let healthy = true;
    const cfg = {
      ...(config(resolution()) as object),
      fleetRouting: {
        environmentId: 'env-laptop',
        resolveCandidates: async () => {
          if (!healthy) throw new Error('peer registry unreadable');
          return resolution();
        },
        appendReceipt: async (envelope: UnsealedFleetRoutingEnvelope) => {
          written.push(envelope);
          return envelope as never;
        },
      },
    } as never;

    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(1_000);
    await createConfiguredDispatchModel(spec, cfg, primary);
    healthy = false;
    nowSpy.mockReturnValue(1_000 + DISPATCH_EVIDENCE_TTL_MS + 1);
    const { planDigest } = await resolvePlanWithDigest();
    nowSpy.mockRestore();

    await capturedOnReceipt(
      receiptFor(planDigest, { outcome: 'no-eligible-candidates' }),
    );

    expect(written).toHaveLength(1);
    const envelope = written[0]!;
    const failed = envelope.exclusions.filter(
      (exclusion) => exclusion.code === 'resolution-failed',
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      environmentId: 'env-workstation',
      modelId: 'ollama/qwen3',
    });
    expect(failed[0]?.message).toContain('unknown, not empty');
    // The peer is still in the considered set, unadmitted — not deleted.
    expect(
      envelope.candidates.filter((candidate) => candidate.origin === 'fleet'),
    ).toHaveLength(1);
  });

  it('logs loudly when a receipt arrives with no snapshot to pair it with', async () => {
    // H-1(b): the "no routing snapshot" case used to `return` above the
    // try/catch, so a fleet-enabled turn could go entirely unreceipted with
    // nothing on any channel.
    const cfg = config(resolution());
    await createConfiguredDispatchModel(spec, cfg, primary);
    await resolvePlanWithDigest();

    // A digest no plan ever produced — the shape of an evicted or lost
    // snapshot.
    await capturedOnReceipt(receiptFor('a'.repeat(64)));

    expect(written).toHaveLength(0);
    const logger = (
      cfg as never as { logger: { error: ReturnType<typeof vi.fn> } }
    ).logger;
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('NOT receipted'),
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('no routing snapshot'),
    );
  });
});

describe('two IDENTICAL concurrent turns both get a receipt (round 2, M-1)', () => {
  it('does not consume the snapshot on first read', async () => {
    // The pairing suite above deliberately makes its two turns DIFFERENT so
    // their digests differ. This is the case it avoids, and it is not exotic:
    // `executionPlanDigest` is pure content — canonicalized plan plus request
    // digest, no nonce, no timestamp — so two concurrent turns with the same
    // agent, prompt and grades collide on ONE digest deterministically. That
    // is the normal shape of a scheduled job, a retry, and a fan-out.
    //
    // Deleting the entry on first read meant the first receipt got its
    // envelope and the second got `routing-snapshot-lost` with none — a
    // regression, for that case, against the last-write code the digest map
    // replaced.
    const cfg = config(resolution());
    await createConfiguredDispatchModel(spec, cfg, primary);

    const request = { messages: [{ role: 'user', content: 'same prompt' }] };
    const turnA = await resolvePlanWithDigest(request);
    const turnB = await resolvePlanWithDigest(request);

    // The collision is the premise, so assert it rather than assume it.
    expect(turnA.planDigest).toBe(turnB.planDigest);

    await capturedOnReceipt(receiptFor(turnA.planDigest));
    await capturedOnReceipt(receiptFor(turnB.planDigest));

    expect(written).toHaveLength(2);
    for (const envelope of written) {
      expect(
        envelope.candidates.some((candidate) => candidate.origin === 'fleet'),
      ).toBe(true);
      expect(envelope.exclusions.map((exclusion) => exclusion.code)).toContain(
        'peer-unreachable',
      );
    }
    const logger = (
      cfg as never as { logger: { error: ReturnType<typeof vi.fn> } }
    ).logger;
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('authorized turn to fleet receipt correlation (station#3866)', () => {
  const turnA = {
    accountId: 'account-a',
    sessionId: 'session-a',
    turnId: 'turn-a',
    correlationId: 'correlation-a',
  } as const;
  const turnB = {
    accountId: 'account-b',
    sessionId: 'session-b',
    turnId: 'turn-b',
    correlationId: 'correlation-b',
  } as const;

  it('keeps identical concurrent requests in distinct exact turn/receipt pairs', async () => {
    const begun: AuthorizedFleetDispatchBegin[] = [];
    const settled: AuthorizedFleetDispatchSettlement[] = [];
    const observer: FleetDispatchCorrelationObserver = {
      begin: (input) => {
        begun.push(input);
      },
      settle: (input) => {
        settled.push(input);
      },
    };
    await createConfiguredDispatchModel(
      spec,
      config(resolution(), observer),
      primary,
    );

    const request = {
      messages: [{ role: 'user', content: 'identical private prompt' }],
    };
    const [planA, planB] = await Promise.all([
      runWithAuthorizedTurnCorrelation(turnA, () =>
        resolvePlanWithDigest(request),
      ),
      runWithAuthorizedTurnCorrelation(turnB, () =>
        resolvePlanWithDigest(request),
      ),
    ]);

    // Dispatch normally canonicalizes these to one digest. The
    // correlation-qualified candidate IDs make the callback token unique
    // only after an exact server-owned turn coordinate has been installed.
    expect(planA.planDigest).not.toBe(planB.planDigest);
    expect(begun).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ...turnA, planDigest: planA.planDigest }),
        expect.objectContaining({ ...turnB, planDigest: planB.planDigest }),
      ]),
    );

    const fleetA = planA.plan.candidates.find(
      (candidate: { runtimeId: string }) =>
        candidate.runtimeId.startsWith('fleet-runtime-'),
    );
    const fleetB = planB.plan.candidates.find(
      (candidate: { runtimeId: string }) =>
        candidate.runtimeId.startsWith('fleet-runtime-'),
    );
    // Reverse completion order: callback order must not swap the operations.
    await capturedOnReceipt(
      receiptFor(planB.planDigest, {
        attempts: [
          {
            candidateId: fleetB.id,
            runtimeId: fleetB.runtimeId,
            outcome: 'succeeded',
            elapsedMs: 1,
          },
        ],
      }),
    );
    await capturedOnReceipt(
      receiptFor(planA.planDigest, {
        attempts: [
          {
            candidateId: fleetA.id,
            runtimeId: fleetA.runtimeId,
            outcome: 'succeeded',
            elapsedMs: 1,
          },
        ],
      }),
    );

    expect(settled).toEqual([
      expect.objectContaining({
        ...turnB,
        planDigest: planB.planDigest,
        receiptId: 'sealed-1',
        outcome: 'succeeded',
      }),
      expect.objectContaining({
        ...turnA,
        planDigest: planA.planDigest,
        receiptId: 'sealed-2',
        outcome: 'succeeded',
      }),
    ]);
    expect(written[0]!.selection?.candidateId).toBe(fleetB.id);
    expect(written[1]!.selection?.candidateId).toBe(fleetA.id);
  });

  it('reuses one stable correlation on redelivery rather than beginning a second operation', async () => {
    const begun: AuthorizedFleetDispatchBegin[] = [];
    const observer: FleetDispatchCorrelationObserver = {
      begin: (input) => {
        begun.push(input);
      },
      settle: async () => {},
    };
    await createConfiguredDispatchModel(
      spec,
      config(resolution(), observer),
      primary,
    );

    const request = { messages: [{ role: 'user', content: 'retry me' }] };
    const first = await runWithAuthorizedTurnCorrelation(turnA, () =>
      resolvePlanWithDigest(request),
    );
    const redelivery = await runWithAuthorizedTurnCorrelation(turnA, () =>
      resolvePlanWithDigest(request),
    );

    expect(redelivery.planDigest).toBe(first.planDigest);
    expect(begun).toEqual([
      expect.objectContaining({
        ...turnA,
        planDigest: first.planDigest,
      }),
    ]);
  });

  it('reclaims completed correlated snapshots so more than the FIFO ceiling do not evict a live turn', async () => {
    const cfg = config(resolution());
    await createConfiguredDispatchModel(spec, cfg, primary);

    for (let index = 0; index < 33; index += 1) {
      const turn = {
        accountId: `account-${index}`,
        sessionId: `session-${index}`,
        turnId: `turn-${index}`,
        correlationId: `correlation-${index}`,
      };
      const plan = await runWithAuthorizedTurnCorrelation(turn, () =>
        resolvePlanWithDigest({
          messages: [{ role: 'user', content: `turn ${index}` }],
        }),
      );
      await capturedOnReceipt(receiptFor(plan.planDigest));
    }

    expect(written).toHaveLength(33);
    expect((cfg as any).logger.error).not.toHaveBeenCalledWith(
      expect.stringContaining('snapshot evicted'),
    );
  });

  it('bounds never-settling observer begin and settle work without losing the authoritative receipt', async () => {
    const observer: FleetDispatchCorrelationObserver = {
      begin: () => new Promise<void>(() => undefined),
      settle: () => new Promise<void>(() => undefined),
    };
    const cfg = config(resolution(), observer);
    await createConfiguredDispatchModel(spec, cfg, primary);

    const plan = await runWithAuthorizedTurnCorrelation(turnA, () =>
      resolvePlanWithDigest({
        messages: [{ role: 'user', content: 'bounded observer' }],
      }),
    );
    await capturedOnReceipt(receiptFor(plan.planDigest));

    expect(written).toHaveLength(1);
    expect((cfg as any).logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('observer begin timed out'),
      { reason: 'fleet-correlation-observer-timeout' },
    );
    expect((cfg as any).logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('observer settle timed out'),
      { reason: 'fleet-correlation-observer-timeout' },
    );
  });

  it('keeps the authoritative routing receipt when no authorized context exists', async () => {
    const observer = {
      begin: vi.fn(),
      settle: vi.fn(),
    } satisfies FleetDispatchCorrelationObserver;
    const cfg = config(resolution(), observer);
    await createConfiguredDispatchModel(spec, cfg, primary);

    const { planDigest } = await resolvePlanWithDigest();
    await capturedOnReceipt(receiptFor(planDigest));

    expect(written).toHaveLength(1);
    expect(observer.begin).not.toHaveBeenCalled();
    expect(observer.settle).not.toHaveBeenCalled();
    expect((cfg as any).logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('routing receipt will still be written'),
      { reason: 'missing-authorized-turn-context' },
    );
  });

  it('never lets observer failure change the Dispatch receipt and excludes request secrets from observer input', async () => {
    const observer: FleetDispatchCorrelationObserver = {
      begin: async () => {
        throw new Error('operation backend unavailable');
      },
      settle: async () => {
        throw new Error('operation backend unavailable');
      },
    };
    await createConfiguredDispatchModel(
      spec,
      config(resolution(), observer),
      primary,
    );
    const request = {
      messages: [
        {
          role: 'user',
          content:
            'prompt-canary /private/path credential-canary provider-body-canary',
        },
      ],
    };
    const plan = await runWithAuthorizedTurnCorrelation(turnA, () =>
      resolvePlanWithDigest(request),
    );
    await capturedOnReceipt(receiptFor(plan.planDigest));

    expect(written).toHaveLength(1);
    expect(JSON.stringify(written)).not.toContain('prompt-canary');
    expect(JSON.stringify(written)).not.toContain('credential-canary');
    expect(JSON.stringify(written)).not.toContain('provider-body-canary');
  });

  it('keeps the fleet receipt authoritative when the production Action observer store fails', async () => {
    const empty: ActionOperationLedger = {
      version: 1,
      creationSequence: 0,
      changeSequence: 0,
      records: [],
    };
    const failingStore: ActionOperationStore = {
      read: async () => structuredClone(empty),
      transact: async () => {
        throw new Error('injected operation store outage');
      },
    };
    const observer = new FleetDispatchActionOperationObserver(
      new ActionOperationService(failingStore),
    );
    const cfg = config(resolution(), observer);
    await createConfiguredDispatchModel(spec, cfg, primary);

    const plan = await runWithAuthorizedTurnCorrelation(turnA, () =>
      resolvePlanWithDigest({
        messages: [{ role: 'user', content: 'observer isolation' }],
      }),
    );
    await capturedOnReceipt(receiptFor(plan.planDigest));

    expect(written).toHaveLength(1);
    expect((cfg as any).logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('observer begin failed'),
      { reason: 'fleet-correlation-observer-failed' },
    );
  });
});

/**
 * L-3, carried into the dispatch 0.2.0 → 0.5.0 bump (archive#1398).
 *
 * The conformance tripwire in `dispatch-model-policy.test.ts` compares the
 * real engine's admitted set against this Station's replica of its
 * eligibility predicate. This suite asserts the DOWNSTREAM consequence the
 * tripwire's own docblock names: `buildFleetRoutingEnvelope` resolves
 * `selection` by matching the receipt's succeeded attempt back to a candidate
 * this Station recorded as `admitted`. If the engine ever admits (and runs) a
 * candidate the replica considered excluded, the envelope renders
 * `selection: null` on a turn that demonstrably succeeded — a receipt
 * claiming nothing served, for a turn that did.
 *
 * Every other envelope test in this file feeds `capturedOnReceipt` a
 * hand-built receipt, which by construction cannot observe an engine
 * disagreement. These two run the REAL `dispatch()` engine over the REAL
 * resolved plan and feed its REAL receipt through the production
 * `onReceipt` path, so a divergence in `eligible()` reaches the envelope
 * exactly as it would in production.
 */
describe('station#1398 slice 5 — the probe observation reaches the ENVELOPE', () => {
  // The join nothing else covers. `fleet-candidate-service.test.ts` proves the
  // grade, and the two surface suites prove the rendering — but both surface
  // suites read a hand-built receipt, so without this the chain from a real
  // resolution to a stored envelope is unasserted, and a candidate service
  // that produced a perfect observation could still have it dropped on the
  // way through `resolveFleetPlanHalf`.
  const PROBED_EVIDENCE = {
    level: 'confirmed' as const,
    provenance: 'probe-verified' as const,
    label: 'verified from here by a bounded completion',
    peerAttested: PEER_EVIDENCE.peerAttested,
    probe: {
      status: 'passed' as const,
      observedAt: '2026-08-01T11:59:00.000Z',
      expiresAt: '2026-08-01T12:14:00.000Z',
      elapsedMs: 21,
      servedProviderModel: 'qwen3:32b',
      failureCode: null,
    },
  };

  it('carries provenance, the probe record, AND the peer claim through to the stored receipt', async () => {
    const probed = resolution();
    probed.candidates[0]!.evidence = PROBED_EVIDENCE as never;
    await createConfiguredDispatchModel(spec, config(probed), primary);
    const { planDigest } = await resolvePlanWithDigest();
    await capturedOnReceipt(
      receiptFor(planDigest, {
        attempts: [
          {
            candidateId: 'fleet-candidate-0',
            runtimeId: 'fleet-runtime-0',
            outcome: 'succeeded',
            elapsedMs: 10,
          },
        ],
      }),
    );

    const envelope = written[0]!;
    expect(envelope.selection?.evidence.provenance).toBe('probe-verified');
    expect(envelope.selection?.evidence.level).toBe('confirmed');
    expect(envelope.selection?.evidence.probe?.status).toBe('passed');
    // Both claims survive the fold. A receipt read months later must still be
    // able to say what the peer asserted AND what we observed.
    expect(envelope.selection?.evidence.peerAttested?.digest).toBe(
      'a'.repeat(64),
    );
  });

  it('a probe-verified peer clears minimumEvidence confirmed — which no peer-attested candidate ever can', async () => {
    // The routing consequence of the whole slice, asserted end to end rather
    // than inferred from the grade. The mirror assertion (a peer-attested
    // candidate refused by the same policy) already exists above.
    const probed = resolution();
    probed.candidates[0]!.evidence = PROBED_EVIDENCE as never;
    await createConfiguredDispatchModel(
      {
        ...(spec as object),
        execution: {
          modelOptions: {
            dispatch: {
              enabled: true,
              fleet: { enabled: true },
              policy: { minimumEvidence: 'confirmed' },
            },
          },
        },
      } as never,
      config(probed),
      primary,
    );
    const plan = await capturedPlan({});
    const fleetCandidate = plan.candidates.find(
      (candidate: { id: string }) => candidate.id === 'fleet-candidate-0',
    );
    expect(fleetCandidate.evidence.level).toBe('confirmed');
    // Still no structured-tools: a probe proves a completion ran, not that the
    // peer can call tools. Raising one axis must not raise the other.
    expect(fleetCandidate.evidence.capabilities).toEqual(['abort', 'usage']);
    expect(fleetCandidate.evidence.structuredToolsFidelity).toBe('unavailable');
  });
});

/**
 * archive#1398 review, finding 2. `fell-back-to-local` is the §4.5
 * state slice 3 exists to name — a turn that SUCCEEDS locally after a fleet
 * attempt failed, which is the case most likely to be reported as a plain
 * success. Every other test of it feeds `capturedOnReceipt` a hand-built
 * `attempts` array, which cannot observe whether the engine would ever
 * produce that shape. It would not: `FleetInferenceRoutingError` carried
 * `refusalCode` and neither `code` nor `retryable`, so
 * `normalizeInvocationError` collapsed it to RUNTIME_FAILURE/non-retryable
 * and the engine's `if (!typed.retryable && !plan.policy?.retryRuntimeFailures)
 * break;` stopped the loop before the local candidate was ever tried.
 *
 * These run the REAL engine over the REAL plan with a fleet runtime that
 * throws the REAL error type, so the failover is exercised rather than
 * assumed.
 */
describe('finding 2: a failed fleet attempt actually reaches the local candidate', () => {
  class ThrowingRuntime {
    readonly id: string;
    readonly #error: Error;
    constructor(id: string, error: Error) {
      this.id = id;
      this.#error = error;
    }
    capabilities() {
      return {
        structuredTools: true,
        streaming: false,
        abort: true,
        usage: true,
      };
    }
    async invoke(): Promise<never> {
      throw this.#error;
    }
  }

  function localRuntime(runtimeId: string) {
    return new FakeModelRuntime(
      [
        {
          provider: 'fixture',
          model: runtimeId,
          outputText: 'ok',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          latencyMs: 1,
        },
      ],
      runtimeId,
    );
  }

  async function runFleetFirstTurnWith(error: Error) {
    await createConfiguredDispatchModel(
      {
        name: 'researcher',
        execution: {
          modelOptions: {
            dispatch: {
              enabled: true,
              // Fleet FIRST — the only ordering in which a fleet failure can
              // be followed by a local success, and therefore the only one in
              // which `fell-back-to-local` is reachable at all.
              fleet: { enabled: true, order: 'before-local' },
            },
          },
        },
      } as never,
      config(resolution()),
      primary,
    );
    const request = { messages: [{ role: 'user' as const, content: 'hi' }] };
    const plan = await capturedPlan(request);
    const local = localRuntime('runtime-0');
    const outcome = await dispatch(
      { ...plan, request, budget: { maxAttempts: plan.candidates.length } },
      {
        get: (id: string) =>
          id === 'fleet-runtime-0'
            ? (new ThrowingRuntime('fleet-runtime-0', error) as never)
            : id === local.id
              ? local
              : undefined,
      },
    );
    await capturedOnReceipt(outcome.receipt);
    return outcome;
  }

  it('the real engine fails over to the local candidate and the envelope names fell-back-to-local', async () => {
    const outcome = await runFleetFirstTurnWith(
      new FleetInferenceRoutingError({
        environmentId: 'env-workstation',
        modelId: 'ollama/qwen3',
        refusalCode: 'peer-unreachable',
        message: 'Workstation is not answering.',
      }),
    );

    // The engine kept going: two attempts, not one.
    expect(outcome.receipt.outcome).toBe('succeeded');
    expect(outcome.receipt.attempts.map((a) => a.candidateId)).toEqual([
      'fleet-candidate-0',
      'candidate-0',
    ]);
    expect(outcome.receipt.attempts[0]?.retryable).toBe(true);
    expect(outcome.receipt.attempts[0]?.errorCode).toBe('PROVIDER_UNAVAILABLE');

    const envelope = written[0]!;
    expect(envelope.selection?.origin).toBe('local');
    // The state this whole finding was about.
    expect(envelope.failure?.code).toBe('fell-back-to-local');
    expect(envelope.failure?.message).toContain('Workstation');
  });

  it('an error that is NOT dispatch-legible still halts the loop — the exact pre-fix behavior, pinned', async () => {
    // The control. A plain Error carries no `code`/`retryable`, normalizes to
    // RUNTIME_FAILURE/non-retryable, and the engine breaks — no local attempt,
    // no fallback, and an `exhausted` turn. This is what EVERY fleet refusal
    // did before the fix, and pinning it here is what stops a future edit from
    // quietly reverting `FleetInferenceRoutingError` to a plain `Error`
    // subclass without anything going red.
    const outcome = await runFleetFirstTurnWith(new Error('opaque failure'));

    expect(outcome.receipt.outcome).toBe('exhausted');
    expect(outcome.receipt.attempts.map((a) => a.candidateId)).toEqual([
      'fleet-candidate-0',
    ]);
    expect(written[0]!.failure?.code).toBe('fleet-attempts-failed');
  });

  it('every refusal code maps to a dispatch-legible, failover-permitting error', () => {
    // Table-driven over the WHOLE vocabulary rather than the one code the
    // happy-path test uses: a new refusal code that fell through the map would
    // otherwise reintroduce the dead-loop for exactly that case, silently.
    for (const refusalCode of [
      'peer-unreachable',
      'contribution-disabled',
      'model-not-contributed',
      'model-unavailable',
      'contribution-unavailable',
      'capacity-exhausted',
      'completion-timeout',
      'request-abandoned',
      'execution-failed',
      'streaming-unsupported',
      'request-invalid',
      'request-too-large',
    ] as const) {
      const error = new FleetInferenceRoutingError({
        environmentId: 'env-workstation',
        modelId: 'ollama/qwen3',
        refusalCode,
        message: 'refused',
      });
      expect(error.retryable).toBe(true);
      // ABORTED would make the engine treat a peer's refusal as the user
      // cancelling the whole turn.
      expect(error.code).not.toBe('ABORTED');
      expect([
        'PROVIDER_UNAVAILABLE',
        'RATE_LIMITED',
        'INVALID_REQUEST',
        'RUNTIME_FAILURE',
      ]).toContain(error.code);
      // The peer's own word survives alongside the projection.
      expect(error.refusalCode).toBe(refusalCode);
    }
  });
});

describe('L-3: the envelope names a selection for a turn the real engine actually served', () => {
  function registryFor(runtimeIds: readonly string[]) {
    const runtimes = new Map(
      runtimeIds.map((runtimeId) => [
        runtimeId,
        new FakeModelRuntime(
          [
            {
              provider: 'fixture',
              model: runtimeId,
              outputText: 'ok',
              toolCalls: [],
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              latencyMs: 1,
            },
          ],
          runtimeId,
        ),
      ]),
    );
    return { get: (id: string) => runtimes.get(id) };
  }

  async function runRealTurn(agentSpec: unknown): Promise<void> {
    await createConfiguredDispatchModel(
      agentSpec as never,
      config(resolution()),
      primary,
    );
    const request = { messages: [{ role: 'user' as const, content: 'hi' }] };
    const plan = await capturedPlan(request);
    const outcome = await dispatch(
      { ...plan, request, budget: { maxAttempts: plan.candidates.length } },
      registryFor(
        plan.candidates.map((candidate: { runtimeId: string }) =>
          String(candidate.runtimeId),
        ),
      ),
    );
    expect(outcome.receipt.outcome).toBe('succeeded');
    await capturedOnReceipt(outcome.receipt);
  }

  it('a fleet-first turn served by the peer names the fleet candidate, with no failure state', async () => {
    await runRealTurn({
      name: 'researcher',
      execution: {
        modelOptions: {
          dispatch: {
            enabled: true,
            fleet: { enabled: true, order: 'before-local' },
          },
        },
      },
    });

    expect(written).toHaveLength(1);
    const envelope = written[0]!;
    // The load-bearing assertion: NOT null.
    expect(envelope.selection).not.toBeNull();
    expect(envelope.selection?.origin).toBe('fleet');
    expect(envelope.selection?.environmentId).toBe('env-workstation');
    expect(envelope.selection?.evidence.provenance).toBe('peer-attested');
    // A fleet turn that ran on the fleet is not a degraded state.
    expect(envelope.failure).toBeNull();
  });

  it('a local-first turn served locally names the local candidate, and is not reported as a fallback', async () => {
    await runRealTurn(spec);

    expect(written).toHaveLength(1);
    const envelope = written[0]!;
    expect(envelope.selection).not.toBeNull();
    expect(envelope.selection?.origin).toBe('local');
    expect(envelope.selection?.evidence.provenance).toBe('local-observation');
    // `fell-back-to-local` requires an ATTEMPTED fleet candidate to have
    // failed. Dispatch stops on first success, so the fleet candidate was
    // never tried here — reporting a fallback would be the mirror-image lie
    // of hiding one.
    expect(envelope.failure).toBeNull();
  });
});
