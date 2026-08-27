/**
 * station#1398 slice 3 — the consuming side's admission gates and, more
 * importantly, its refusals. Every test below is about a way this module
 * could quietly claim more than it knows (`docs/design/inference-fleet.md`
 * §4.4, §4.5, §8).
 */

import type { FleetContributionManifest } from '@kontourai/station-contracts/fleet-contribution';
import type { ConsumerProbeObservation } from '@kontourai/station-contracts/fleet-routing-receipt';
import {
  FLEET_PEER_ATTESTED_EVIDENCE_LABEL,
  FLEET_PROBE_VERIFIED_EVIDENCE_LABEL,
} from '@kontourai/station-contracts/fleet-routing-receipt';
import { describe, expect, it } from 'vitest';
import {
  FleetCandidateService,
  type FleetPeerCredential,
  peerAttestedLevelFromManifestModel,
} from '../fleet-candidate-service.js';
import type { FleetProbeService } from '../fleet-probe-service.js';

const PEER: FleetPeerCredential = {
  environmentId: 'env-workstation',
  apiBase: 'https://workstation.example',
  scope: 'inference:invoke',
  label: 'Workstation',
  credential: 'peer-credential-value-0000000000',
};

function manifest(
  overrides: Partial<FleetContributionManifest> = {},
): FleetContributionManifest {
  return {
    schemaVersion: 'station.fleet-contribution/v1',
    projectedAt: '2026-08-01T00:00:00.000Z',
    sourceObservedAt: '2026-08-01T00:00:00.000Z',
    participation: 'contributing',
    models: [
      {
        id: 'ollama/qwen3',
        connectionId: 'conn-1',
        providerModel: 'qwen3:32b',
        model: { provider: 'ollama', family: null, id: 'qwen3:32b' } as never,
        aliases: [],
        displayName: 'Qwen3 32B',
        locality: 'local',
        availability: 'available',
        freshness: 'live',
        observedAt: '2026-08-01T00:00:00.000Z',
        effectiveContextTokens: 32_000,
        toolSurface: null,
        supportsVision: null,
      },
    ],
    diagnostics: [],
    ...overrides,
  };
}

function respondingFetch(
  handlers: Record<string, () => Response>,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    const key = Object.keys(handlers).find((path) => url.endsWith(path));
    if (!key) throw new Error(`unexpected fetch: ${url}`);
    return handlers[key]!();
  }) as typeof fetch;
}

const HANDSHAKE_OK = () =>
  new Response(
    JSON.stringify({
      environmentId: 'env-workstation',
      capabilities: { fleetInference: true },
    }),
    { status: 200 },
  );

function service(
  peers: FleetPeerCredential[],
  handlers: Record<string, () => Response>,
  probes?: FleetProbeService,
) {
  return new FleetCandidateService({
    peers: { listFleetPeers: () => peers },
    fetchImpl: respondingFetch(handlers),
    now: () => new Date('2026-08-01T12:00:00.000Z'),
    ...(probes ? { probes } : {}),
  });
}

/**
 * A probe service stubbed at its two READ methods. Deliberately not a real
 * `FleetProbeService` with a fake fetch: this suite is about what the
 * candidate service does WITH an observation, and the probe service's own
 * suite already covers how one is produced.
 */
function stubProbes(
  observation: ConsumerProbeObservation | null,
): FleetProbeService {
  const real = new (class {
    observe() {
      return observation;
    }
    exclusionFor(
      target: { environmentId: string; modelId: string; displayName: string },
      obs: ConsumerProbeObservation | null,
    ) {
      if (obs?.status !== 'failed') return null;
      return {
        candidateId: null,
        environmentId: target.environmentId,
        environmentLabel: null,
        modelId: target.modelId,
        code: 'probe-failed' as const,
        message: `probe failed (${obs.failureCode})`,
        source: 'station' as const,
      };
    }
  })();
  return real as unknown as FleetProbeService;
}

/**
 * `FleetCandidateService` folds the observation through
 * `fleetEvidenceLevelWithProbe`, which now enforces expiry against the real
 * clock by default (slice 5.5 review, finding 1). So a FRESH fixture has to
 * be genuinely fresh relative to now — a hardcoded `expiresAt` would assert
 * the pass path only until that timestamp went by, then red on pristine main
 * for no code reason.
 */
function probeObservation(
  status: ConsumerProbeObservation['status'],
  failureCode: string | null = null,
): ConsumerProbeObservation {
  const now = Date.now();
  return {
    status,
    observedAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 15 * 60_000).toISOString(),
    elapsedMs: status === 'failed' ? null : 21,
    servedProviderModel: status === 'failed' ? null : 'qwen3:32b',
    failureCode,
  };
}

describe('station#1398 slice 5 — a consumer probe changes the grade, never the claim', () => {
  const handlers = {
    '/.well-known/station/v1': HANDSHAKE_OK,
    '/api/inference/manifest': () =>
      new Response(JSON.stringify({ manifest: manifest() }), { status: 200 }),
  };

  it('with NO probe service wired the behavior is exactly pre-slice-5 — capped, peer-attested', async () => {
    // The absence of probing must not silently change anything. A consuming
    // Station that has not opted in is not downgraded, and `probe-failed`
    // simply stays unreachable for it.
    const resolution = await service([PEER], handlers).resolve();
    expect(resolution.candidates).toHaveLength(1);
    expect(resolution.candidates[0]!.evidence.level).toBe('declared');
    expect(resolution.candidates[0]!.evidence.provenance).toBe('peer-attested');
    expect(resolution.candidates[0]!.evidence.probe).toBeNull();
  });

  it('a FRESH PASS raises the candidate to confirmed / probe-verified and KEEPS the peer claim beside it', async () => {
    const resolution = await service(
      [PEER],
      handlers,
      stubProbes(probeObservation('passed')),
    ).resolve();

    const evidence = resolution.candidates[0]!.evidence;
    expect(evidence.level).toBe('confirmed');
    expect(evidence.provenance).toBe('probe-verified');
    expect(evidence.label).toBe(FLEET_PROBE_VERIFIED_EVIDENCE_LABEL);
    expect(evidence.probe?.status).toBe('passed');
    // The peer's raw claim survives. Losing it would make "we verified a
    // machine that says nothing" indistinguishable from "we verified a
    // machine that says the same thing".
    expect(evidence.peerAttested?.availability).toBe('available');
    expect(evidence.peerAttested?.freshness).toBe('live');
  });

  it('a FRESH FAILURE excludes the candidate by name — probe-failed, reachable at last', async () => {
    const resolution = await service(
      [PEER],
      handlers,
      stubProbes(probeObservation('failed', 'model-unavailable')),
    ).resolve();

    // Withheld from the router AND named. §4.5's first banned behavior is
    // dropping it silently; the peer still says the model is fine, so
    // without the exclusion this would look like the peer stopped offering
    // it.
    expect(resolution.candidates).toHaveLength(0);
    expect(resolution.exclusions.map((e) => e.code)).toContain('probe-failed');
  });

  it('a STALE observation degrades to exactly the pre-probe grade, with the observation still attached', async () => {
    const resolution = await service(
      [PEER],
      handlers,
      stubProbes(probeObservation('stale')),
    ).resolve();

    const evidence = resolution.candidates[0]!.evidence;
    // Back to the capped peer claim — an expired probe stops asserting a
    // verification (§4.3) ...
    expect(evidence.level).toBe('declared');
    expect(evidence.provenance).toBe('peer-attested');
    expect(evidence.label).toBe(FLEET_PEER_ATTESTED_EVIDENCE_LABEL);
    // ... but it is NOT excluded, and the record of it is not dropped: a
    // never-probed candidate and a probed-then-expired one must stay
    // distinguishable on both surfaces.
    expect(evidence.probe?.status).toBe('stale');
    expect(evidence.probe?.observedAt).toBeTruthy();
  });

  it('a probe never rescues a model the PEER itself says is unroutable', async () => {
    // Ordering, asserted: the peer's own claim is evaluated first, so a model
    // the peer reports as stale is excluded before a completion is ever spent
    // on it — and a passing probe cannot resurrect it.
    const staleManifest = manifest({
      models: [{ ...manifest().models[0]!, availability: 'stale' }] as never,
    });
    const resolution = await service(
      [PEER],
      {
        '/.well-known/station/v1': HANDSHAKE_OK,
        '/api/inference/manifest': () =>
          new Response(JSON.stringify({ manifest: staleManifest }), {
            status: 200,
          }),
      },
      stubProbes(probeObservation('passed')),
    ).resolve();

    expect(resolution.candidates).toHaveLength(0);
    expect(resolution.exclusions.map((e) => e.code)).toContain(
      'evidence-stale',
    );
  });
});

describe('peer capability claims are peer-attested, never verified', () => {
  it('caps a peer’s strongest possible claim at declared and labels it honestly', async () => {
    // The peer says `available` + `live` — the best a manifest can say. The
    // pre-cap mapping grades that `confirmed`; the cap must take it back
    // down, because nothing on THIS Station observed a completion.
    expect(
      peerAttestedLevelFromManifestModel({
        availability: 'available',
        freshness: 'live',
      }),
    ).toBe('confirmed');

    const resolution = await service([PEER], {
      '/.well-known/station/v1': HANDSHAKE_OK,
      '/api/inference/manifest': () =>
        new Response(JSON.stringify({ manifest: manifest() }), { status: 200 }),
    }).resolve();

    expect(resolution.candidates).toHaveLength(1);
    const candidate = resolution.candidates[0]!;
    expect(candidate.evidence.level).toBe('declared');
    expect(candidate.evidence.provenance).toBe('peer-attested');
    expect(candidate.evidence.label).toBe(FLEET_PEER_ATTESTED_EVIDENCE_LABEL);
    // The peer's raw claim survives beside the capped level, so a reader can
    // see what was claimed AND what was routed on.
    expect(candidate.evidence.peerAttested).toMatchObject({
      availability: 'available',
      freshness: 'live',
      observedAt: '2026-08-01T00:00:00.000Z',
    });
  });
});

describe('every peer that does not route leaves a named exclusion', () => {
  it('refuses to send a request when our own credential lacks inference:invoke', async () => {
    const resolution = await service(
      [{ ...PEER, scope: 'orchestration:read orchestration:operate' }],
      // No handlers at all: the assertion is that nothing is fetched.
      {},
    ).resolve();
    expect(resolution.candidates).toHaveLength(0);
    expect(resolution.exclusions).toHaveLength(1);
    expect(resolution.exclusions[0]).toMatchObject({
      code: 'peer-scope-denied',
      environmentId: 'env-workstation',
    });
  });

  it('names a peer that does not advertise fleetInference', async () => {
    const resolution = await service([PEER], {
      '/.well-known/station/v1': () =>
        new Response(JSON.stringify({ environmentId: 'env-workstation' }), {
          status: 200,
        }),
    }).resolve();
    expect(resolution.exclusions[0]?.code).toBe('peer-protocol-unsupported');
  });

  it('names an unreachable peer instead of dropping it', async () => {
    const resolution = await new FleetCandidateService({
      peers: { listFleetPeers: () => [PEER] },
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
    }).resolve();
    expect(resolution.candidates).toHaveLength(0);
    expect(resolution.exclusions[0]?.code).toBe('peer-unreachable');
    expect(resolution.exclusions[0]?.message).toContain(
      'unknown rather than empty',
    );
  });

  it('distinguishes a revoked credential from an unreachable peer', async () => {
    const resolution = await service([PEER], {
      '/.well-known/station/v1': HANDSHAKE_OK,
      '/api/inference/manifest': () => new Response('{}', { status: 403 }),
    }).resolve();
    expect(resolution.exclusions[0]?.code).toBe('peer-scope-denied');
  });

  it('says WHICH empty a non-contributing peer is', async () => {
    const resolution = await service([PEER], {
      '/.well-known/station/v1': HANDSHAKE_OK,
      '/api/inference/manifest': () =>
        new Response(
          JSON.stringify({
            manifest: manifest({
              participation: 'nothing-contributed',
              models: [],
            }),
          }),
          { status: 200 },
        ),
    }).resolve();
    expect(resolution.exclusions[0]?.code).toBe('not-contributed');
    expect(resolution.exclusions[0]?.message).toContain(
      'no connection marked as contributed',
    );
  });

  it('excludes a stale-evidence model by name rather than routing on it', async () => {
    const stale = manifest();
    stale.models[0]!.freshness = 'stale-snapshot';
    const resolution = await service([PEER], {
      '/.well-known/station/v1': HANDSHAKE_OK,
      '/api/inference/manifest': () =>
        new Response(JSON.stringify({ manifest: stale }), { status: 200 }),
    }).resolve();
    expect(resolution.candidates).toHaveLength(0);
    expect(resolution.exclusions[0]).toMatchObject({
      code: 'evidence-stale',
      modelId: 'ollama/qwen3',
    });
  });

  it('refuses a non-local contribution as a reference, not as a dead model', async () => {
    const remote = manifest();
    remote.models[0]!.locality = 'remote';
    const resolution = await service([PEER], {
      '/.well-known/station/v1': HANDSHAKE_OK,
      '/api/inference/manifest': () =>
        new Response(JSON.stringify({ manifest: remote }), { status: 200 }),
    }).resolve();
    expect(resolution.candidates).toHaveLength(0);
    expect(resolution.exclusions[0]?.code).toBe('reference-unresolvable');
  });
});
