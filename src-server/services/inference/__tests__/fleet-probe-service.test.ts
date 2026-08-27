/**
 * station#1398 slice 5 — the consumer-verified probe.
 *
 * The assertions that carry weight here are the ones about what a probe does
 * NOT earn: the peer-attested cap must still bind an unverified claim, an
 * expired observation must stop asserting a verification, and the routing
 * path must never wait for a network round trip.
 */

import type { ConsumerProbeObservation } from '@kontourai/station-contracts/fleet-routing-receipt';
import {
  capFleetEvidenceLevel,
  describeConsumerProbe,
  FLEET_PEER_ATTESTED_EVIDENCE_LABEL,
  FLEET_PROBE_VERIFIED_EVIDENCE_LABEL,
  fleetEvidenceLevelWithProbe,
} from '@kontourai/station-contracts/fleet-routing-receipt';
import { describe, expect, it, vi } from 'vitest';

const { fleetProbeFailureCounter } = vi.hoisted(() => ({
  fleetProbeFailureCounter: vi.fn(),
}));
vi.mock('../../../telemetry/metrics.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../telemetry/metrics.js')
  >('../../../telemetry/metrics.js');
  return {
    ...actual,
    fleetProbeFailures: { add: fleetProbeFailureCounter },
  };
});

import {
  FLEET_PROBE_PROMPT,
  FleetProbeService,
  type FleetProbeTarget,
} from '../fleet-probe-service.js';

const TARGET: FleetProbeTarget = {
  environmentId: 'env-workstation',
  environmentLabel: 'Workstation',
  apiBase: 'https://workstation.example',
  credential: 'peer-credential-value-0000000000',
  modelId: 'ollama/qwen3',
  displayName: 'Qwen3 32B',
  providerModel: 'qwen3:32b',
};

function completionResponse(providerModel = 'qwen3:32b') {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      schemaVersion: 'station.fleet-inference-completion/v1',
      delivery: 'buffered',
      model: {
        id: 'ollama/qwen3',
        connectionId: 'conn-1',
        providerModel,
        displayName: 'Qwen3 32B',
      },
      servedAt: '2026-08-01T12:00:00.000Z',
      content: 'pong',
      stop: 'provider',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
      elapsedMs: 12,
    }),
  } as unknown as Response;
}

function refusalResponse(code: string, status = 409) {
  return {
    ok: false,
    status,
    json: async () => ({
      schemaVersion: 'station.fleet-inference-refusal/v1',
      code,
      message: 'nope',
    }),
  } as unknown as Response;
}

function clock(startMs: number) {
  let current = startMs;
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('the probe runs a real bounded completion over the fleet path', () => {
  it('posts one message to the serve route with the peer credential and maxOutputTokens 1', async () => {
    const fetchImpl = vi.fn(async () => completionResponse());
    const service = new FleetProbeService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const observation = await service.refresh(TARGET);

    expect(observation.status).toBe('passed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    // The REAL path §4.3 requires — the same route a routed turn uses, not a
    // health endpoint that would prove something else.
    expect(url).toBe('https://workstation.example/api/inference/completions');
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer peer-credential-value-0000000000',
    );
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      model: 'ollama/qwen3',
      messages: [{ role: 'user', content: FLEET_PROBE_PROMPT }],
      maxOutputTokens: 1,
    });
  });

  it('records nothing from the completion — no content, no digest of it', async () => {
    const service = new FleetProbeService({
      fetchImpl: (async () => completionResponse()) as unknown as typeof fetch,
    });

    const observation = await service.refresh(TARGET);

    // Whitelist the shape rather than blacklisting 'content': a blacklist
    // silently permits the next field somebody adds.
    expect(Object.keys(observation).sort()).toEqual([
      'elapsedMs',
      'expiresAt',
      'failureCode',
      'observedAt',
      'servedProviderModel',
      'status',
    ]);
    expect(JSON.stringify(observation)).not.toContain('pong');
  });

  it('records the provider model the peer actually served, so a substitution is visible', async () => {
    const service = new FleetProbeService({
      fetchImpl: (async () =>
        completionResponse('llama3:8b')) as unknown as typeof fetch,
    });

    const observation = await service.refresh(TARGET);

    // The manifest claimed qwen3:32b. Nothing here decides what to do about
    // the discrepancy, but a receipt that did not record it could never
    // surface one: the completion text would look identical either way.
    expect(observation.servedProviderModel).toBe('llama3:8b');
    expect(observation.servedProviderModel).not.toBe(TARGET.providerModel);
  });

  it("carries the peer's OWN refusal code through, not a generic failure", async () => {
    const service = new FleetProbeService({
      fetchImpl: (async () =>
        refusalResponse('model-not-contributed')) as unknown as typeof fetch,
    });

    const observation = await service.refresh(TARGET);

    expect(observation.status).toBe('failed');
    expect(observation.failureCode).toBe('model-not-contributed');
  });

  it('preserves a provider 429 refusal code rather than flattening it into transport failure', async () => {
    const service = new FleetProbeService({
      fetchImpl: (async () =>
        refusalResponse('rate_limited', 429)) as unknown as typeof fetch,
    });

    const observation = await service.refresh(TARGET);

    expect(observation.status).toBe('failed');
    expect(observation.failureCode).toBe('rate_limited');
  });

  it('finding 3: a peer that ANSWERED 200 with an unreadable body is not reported as unreachable', async () => {
    const service = new FleetProbeService({
      fetchImpl: (async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token < in JSON');
          },
        }) as unknown as Response) as unknown as typeof fetch,
    });

    const observation = await service.refresh(TARGET);

    expect(observation.status).toBe('failed');
    // The whole point: this message reaches an operator inside a
    // `probe-failed` exclusion, and "unreachable" would be false about the
    // one fact they read it for — the peer plainly answered.
    expect(observation.failureCode).toBe('peer-response-unreadable');
    expect(observation.failureCode).not.toBe('peer-unreachable');
  });

  it('names a transport failure distinctly from a peer refusal', async () => {
    const service = new FleetProbeService({
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });

    const observation = await service.refresh(TARGET);

    expect(observation.status).toBe('failed');
    expect(observation.failureCode).toBe('peer-unreachable');
  });
});

describe('observe() never performs I/O on the routing path', () => {
  it('answers from cache and returns null on the first look, scheduling the probe instead', async () => {
    let settled: (key: string) => void = () => {};
    const done = new Promise<void>((resolve) => {
      settled = () => resolve();
    });
    const fetchImpl = vi.fn(async () => completionResponse());
    const service = new FleetProbeService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onRefreshSettled: (key) => settled(key),
    });

    // The load-bearing assertion: SYNCHRONOUS, and it reports "never probed"
    // rather than blocking the turn to find out. A design where the first
    // fleet turn paid for a probe would make verification the feature's worst
    // latency case.
    const first = service.observe(TARGET);
    expect(first).toBeNull();

    await done;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(service.observe(TARGET)?.status).toBe('passed');
  });

  it('does not start a second probe for a candidate already in flight', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return completionResponse();
    });
    let settled: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const service = new FleetProbeService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onRefreshSettled: () => settled(),
    });

    service.observe(TARGET);
    service.observe(TARGET);
    service.observe(TARGET);
    release();
    await done;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent direct refreshes for one key and advances the failure streak once', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const time = clock(Date.parse('2026-08-01T12:00:00.000Z'));
    const fetchImpl = vi.fn(async () => {
      await gate;
      return refusalResponse('model-unavailable');
    });
    const service = new FleetProbeService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: time.now,
      monotonicNow: () => time.now().getTime(),
      failureTtlMs: 100,
      maxFailureTtlMs: 400,
    });

    const first = service.refresh(TARGET);
    const second = service.refresh(TARGET);
    expect(first).toBe(second);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);

    const later = await service.refresh(TARGET);
    expect(Date.parse(later.expiresAt) - Date.parse(later.observedAt)).toBe(
      200,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('coalesces a scheduled refresh with a concurrent direct refresh', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled: () => void = () => {};
    const settledPromise = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const time = clock(Date.parse('2026-08-01T12:00:00.000Z'));
    const fetchImpl = vi.fn(async () => {
      await gate;
      return refusalResponse('model-unavailable');
    });
    const service = new FleetProbeService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: time.now,
      monotonicNow: () => time.now().getTime(),
      failureTtlMs: 100,
      maxFailureTtlMs: 400,
      onRefreshSettled: () => settled(),
    });

    expect(service.observe(TARGET)).toBeNull();
    const direct = service.refresh(TARGET);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    release();
    await direct;
    await settledPromise;

    const later = await service.refresh(TARGET);
    expect(Date.parse(later.expiresAt) - Date.parse(later.observedAt)).toBe(
      200,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('refuses to exceed the concurrent-probe ceiling', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl = vi.fn(async () => {
      await gate;
      return completionResponse();
    });
    const service = new FleetProbeService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxConcurrent: 2,
    });

    for (const modelId of ['a', 'b', 'c', 'd']) {
      service.observe({ ...TARGET, modelId });
    }

    // Bounded means bounded: a Station paired with sixteen peers offering
    // thirty-two models each must not open five hundred completions because
    // its cache went cold.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    release();
  });
});

describe('the observation cache is bounded', () => {
  function passingService(maxObservations: number) {
    return new FleetProbeService({
      fetchImpl: (async () => completionResponse()) as unknown as typeof fetch,
      maxObservations,
      // Keep `observe` from scheduling a refresh that would repopulate an
      // evicted key mid-assertion.
      maxConcurrent: 0,
    });
  }

  it('evicts oldest-first once the ceiling is reached', async () => {
    const service = passingService(2);
    for (const modelId of ['a', 'b', 'c']) {
      await service.refresh({ ...TARGET, modelId });
    }
    expect(service.observe({ ...TARGET, modelId: 'a' })).toBeNull();
    expect(service.observe({ ...TARGET, modelId: 'b' })?.status).toBe('passed');
    expect(service.observe({ ...TARGET, modelId: 'c' })?.status).toBe('passed');
  });

  it('re-probing an existing entry does not evict an unrelated one', async () => {
    // The discriminating case, and the first version of this test missed it:
    // re-probing the OLDEST key hides the defect, because the eviction
    // removes exactly the key about to be re-set. Re-probing a MIDDLE key is
    // what separates the two implementations — without the delete-before-
    // size-check, refreshing 'b' evicts 'a' and leaves the map one under its
    // ceiling, having thrown away a live observation for no reason.
    const service = passingService(3);
    for (const modelId of ['a', 'b', 'c']) {
      await service.refresh({ ...TARGET, modelId });
    }
    await service.refresh({ ...TARGET, modelId: 'b' });

    expect(service.observe({ ...TARGET, modelId: 'a' })?.status).toBe('passed');
    expect(service.observe({ ...TARGET, modelId: 'b' })?.status).toBe('passed');
    expect(service.observe({ ...TARGET, modelId: 'c' })?.status).toBe('passed');
  });
});

describe('freshness is mandatory, not decorative (§4.3)', () => {
  it("reports an expired PASS as 'stale' rather than continuing to assert it", async () => {
    const time = clock(Date.parse('2026-08-01T12:00:00.000Z'));
    let settled: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const service = new FleetProbeService({
      fetchImpl: (async () => completionResponse()) as unknown as typeof fetch,
      now: time.now,
      monotonicNow: () => time.now().getTime(),
      passTtlMs: 1_000,
      onRefreshSettled: () => settled(),
    });

    service.observe(TARGET);
    await done;
    expect(service.observe(TARGET)?.status).toBe('passed');

    time.advance(1_001);
    const stale = service.observe(TARGET);
    // Still an observation — "we probed this and it aged out" is not the same
    // sentence as "we have never probed this", and collapsing them is the
    // silent degradation §4.5 bans.
    expect(stale?.status).toBe('stale');
    expect(stale?.observedAt).toBe('2026-08-01T12:00:00.000Z');
  });

  it('retries a FAILED probe sooner than it re-verifies a passing one', async () => {
    // A pass ages into "unknown"; a failure ages into "worth trying again".
    // Two windows rather than one, so a peer that was rebooting is not
    // excluded for as long as a verified one stays trusted.
    const time = clock(Date.parse('2026-08-01T12:00:00.000Z'));
    let settled: () => void = () => {};
    let done = new Promise<void>((resolve) => {
      settled = resolve;
    });
    let responder = async () => refusalResponse('model-unavailable');
    const service = new FleetProbeService({
      fetchImpl: (async () => responder()) as unknown as typeof fetch,
      now: time.now,
      monotonicNow: () => time.now().getTime(),
      passTtlMs: 60_000,
      failureTtlMs: 1_000,
      onRefreshSettled: () => settled(),
    });

    service.observe(TARGET);
    await done;
    const failure = service.observe(TARGET);
    expect(failure?.status).toBe('failed');
    expect(
      Date.parse(failure!.expiresAt) - Date.parse(failure!.observedAt),
    ).toBe(1_000);

    // Past the SHORTER failure window the candidate is re-probed; at the same
    // elapsed time a passing observation would still be valid.
    done = new Promise<void>((resolve) => {
      settled = resolve;
    });
    responder = async () => completionResponse();
    time.advance(1_001);
    service.observe(TARGET);
    await done;
    const recovered = service.observe(TARGET);
    expect(recovered?.status).toBe('passed');
    expect(
      Date.parse(recovered!.expiresAt) - Date.parse(recovered!.observedAt),
    ).toBe(60_000);
  });
});

describe('failed probes back off per key without making wall-clock time authoritative', () => {
  it('doubles a repeated key failure only to the configured cap', async () => {
    const time = clock(Date.parse('2026-08-01T12:00:00.000Z'));
    const service = new FleetProbeService({
      fetchImpl: (async () =>
        refusalResponse('model-unavailable')) as unknown as typeof fetch,
      now: time.now,
      monotonicNow: () => time.now().getTime(),
      failureTtlMs: 100,
      maxFailureTtlMs: 400,
    });

    const windows: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const observation = await service.refresh(TARGET);
      windows.push(
        Date.parse(observation.expiresAt) - Date.parse(observation.observedAt),
      );
    }

    expect(windows).toEqual([100, 200, 400, 400]);
  });

  it('resets only a recovered key while another key retains its own failure streak', async () => {
    const time = clock(Date.parse('2026-08-01T12:00:00.000Z'));
    const replies = [
      refusalResponse('model-unavailable'),
      refusalResponse('model-unavailable'),
      completionResponse(),
      refusalResponse('model-unavailable'),
      refusalResponse('model-unavailable'),
    ];
    const service = new FleetProbeService({
      fetchImpl: (async () => replies.shift()!) as unknown as typeof fetch,
      now: time.now,
      monotonicNow: () => time.now().getTime(),
      failureTtlMs: 100,
      maxFailureTtlMs: 400,
    });

    const first = await service.refresh(TARGET);
    const second = await service.refresh(TARGET);
    await service.refresh(TARGET);
    const afterRecovery = await service.refresh(TARGET);
    const independentKey = await service.refresh({ ...TARGET, modelId: 'b' });

    expect(Date.parse(first.expiresAt) - Date.parse(first.observedAt)).toBe(
      100,
    );
    expect(Date.parse(second.expiresAt) - Date.parse(second.observedAt)).toBe(
      200,
    );
    expect(
      Date.parse(afterRecovery.expiresAt) -
        Date.parse(afterRecovery.observedAt),
    ).toBe(100);
    expect(
      Date.parse(independentKey.expiresAt) -
        Date.parse(independentKey.observedAt),
    ).toBe(100);
  });

  it('uses monotonic time for admission even when wall time jumps forward then backward', async () => {
    const initialWall = Date.parse('2026-08-01T12:00:00.000Z');
    let wallNow = initialWall;
    let monotonicNow = 0;
    const service = new FleetProbeService({
      fetchImpl: (async () => completionResponse()) as unknown as typeof fetch,
      now: () => new Date(wallNow),
      monotonicNow: () => monotonicNow,
      passTtlMs: 100,
      maxConcurrent: 0,
    });

    const observation = await service.refresh(TARGET);
    wallNow += 24 * 60 * 60 * 1_000;
    monotonicNow = 99;
    expect(service.observe(TARGET)?.status).toBe('passed');

    wallNow = initialWall - 24 * 60 * 60 * 1_000;
    monotonicNow = 101;
    expect(service.observe(TARGET)?.status).toBe('stale');
    expect(Date.parse(observation.expiresAt)).toBeGreaterThan(wallNow);
  });

  it('does not cache an interrupted probe as a failure observation', async () => {
    let response: () => Promise<Response> = async () => {
      throw new DOMException('interrupted by caller', 'AbortError');
    };
    let settled: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const service = new FleetProbeService({
      fetchImpl: (async () => response()) as unknown as typeof fetch,
      onRefreshSettled: () => settled(),
    });

    await expect(service.refresh(TARGET)).rejects.toThrow(
      'Fleet probe was interrupted before a result was available.',
    );

    response = async () => completionResponse();
    expect(service.observe(TARGET)).toBeNull();
    await done;
    expect(service.observe(TARGET)?.status).toBe('passed');
  });

  it('rejects a monotonic timing fault after a successful response without caching or classifying it as peer failure', async () => {
    let monotonicNow = 10;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let responder = async () => {
      await gate;
      return completionResponse();
    };
    const fetchImpl = vi.fn(async () => responder());
    const service = new FleetProbeService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      monotonicNow: () => monotonicNow,
    });

    fleetProbeFailureCounter.mockClear();
    const first = service.refresh(TARGET);
    monotonicNow = 9;
    release();
    await expect(first).rejects.toThrow(
      'Fleet probe monotonic clock moved backwards.',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fleetProbeFailureCounter).not.toHaveBeenCalled();

    monotonicNow = 11;
    responder = async () => completionResponse();
    await expect(service.refresh(TARGET)).resolves.toMatchObject({
      status: 'passed',
      failureCode: null,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('fails loudly on invalid backoff timing configuration', () => {
    expect(
      () =>
        new FleetProbeService({
          failureTtlMs: 0,
        }),
    ).toThrow('Fleet probe timing configuration is invalid');
    expect(
      () =>
        new FleetProbeService({
          failureTtlMs: 200,
          maxFailureTtlMs: 100,
        }),
    ).toThrow('Fleet probe timing configuration is invalid');
  });
});

describe('probe-failed becomes reachable (slice 3 declared it and nothing could emit it)', () => {
  const service = new FleetProbeService();

  function observation(
    overrides: Partial<ConsumerProbeObservation> = {},
  ): ConsumerProbeObservation {
    return {
      status: 'failed',
      observedAt: '2026-08-01T12:00:00.000Z',
      expiresAt: '2026-08-01T12:02:00.000Z',
      elapsedMs: null,
      servedProviderModel: null,
      failureCode: 'model-unavailable',
      ...overrides,
    };
  }

  it('emits a probe-failed exclusion naming the peer, the model, and the failure', () => {
    const exclusion = service.exclusionFor(TARGET, observation());
    expect(exclusion?.code).toBe('probe-failed');
    expect(exclusion?.environmentId).toBe('env-workstation');
    expect(exclusion?.modelId).toBe('ollama/qwen3');
    expect(exclusion?.message).toContain('model-unavailable');
    expect(exclusion?.source).toBe('station');
  });

  it('does NOT exclude on a stale failure — that is not evidence about now either', () => {
    // The mirror-image over-claim. A failure that has aged out says as little
    // about the present as an expired pass does, and excluding on it would be
    // asserting a verification result past its own freshness window in the
    // one direction that happens to be conservative.
    expect(
      service.exclusionFor(TARGET, observation({ status: 'stale' })),
    ).toBeNull();
  });

  it('does not exclude a passing or never-probed candidate', () => {
    expect(
      service.exclusionFor(TARGET, observation({ status: 'passed' })),
    ).toBeNull();
    expect(service.exclusionFor(TARGET, null)).toBeNull();
  });
});

describe('the cap still binds every unverified claim', () => {
  function probe(status: ConsumerProbeObservation['status']) {
    return {
      status,
      observedAt: '2026-08-01T12:00:00.000Z',
      expiresAt: '2026-08-01T12:15:00.000Z',
      elapsedMs: 12,
      servedProviderModel: 'qwen3:32b',
      failureCode: null,
    } satisfies ConsumerProbeObservation;
  }

  // Asked AT a fixed instant inside the fixture's own window, never against
  // the wall clock. A fixture with a hardcoded `expiresAt` evaluated against
  // `Date.now()` asserts the pass path right up until that timestamp goes by
  // and then reds spontaneously on pristine main — the time-bomb shape.
  const WITHIN_WINDOW = Date.parse('2026-08-01T12:05:00.000Z');

  it('raises a probed candidate to confirmed, with probe-verified provenance and its own label', () => {
    expect(
      fleetEvidenceLevelWithProbe('confirmed', probe('passed'), WITHIN_WINDOW),
    ).toEqual({
      level: 'confirmed',
      provenance: 'probe-verified',
      label: FLEET_PROBE_VERIFIED_EVIDENCE_LABEL,
    });
  });

  it('the label is DISTINCT from the local one — a probed peer is not a local model', () => {
    expect(FLEET_PROBE_VERIFIED_EVIDENCE_LABEL).not.toBe(
      FLEET_PEER_ATTESTED_EVIDENCE_LABEL,
    );
    expect(FLEET_PROBE_VERIFIED_EVIDENCE_LABEL).toContain('bounded completion');
  });

  it('an UNVERIFIED claim is still capped at declared, however healthy the peer says it is', () => {
    // The fault this whole design exists to prevent: a peer asserting
    // available/live must not reach `confirmed` by any path that does not
    // include an observation.
    for (const probeState of [null, probe('failed'), probe('stale')] as const) {
      expect(
        fleetEvidenceLevelWithProbe('confirmed', probeState, WITHIN_WINDOW),
      ).toEqual({
        level: 'declared',
        provenance: 'peer-attested',
        label: FLEET_PEER_ATTESTED_EVIDENCE_LABEL,
      });
    }
    // And the underlying cap is untouched, not deleted (slice 4's record).
    expect(capFleetEvidenceLevel('confirmed', 'peer-attested')).toBe(
      'declared',
    );
  });

  it("finding 1: a 'passed' record whose expiresAt has gone by does NOT reach confirmed, even when the caller forgot to re-stamp it", () => {
    // The replay case. `FleetProbeService.observe` stamps `status: 'stale'`
    // on an expired record, so the LIVE path never reaches this function with
    // an expired `passed`. But this function is exported from contracts, and
    // `ConsumerProbeObservation` is stored verbatim in the receipt — anything
    // that reads one back (receipt replay, a cross-process cache, slice 7)
    // hands it over exactly as stored, with `status: 'passed'` intact.
    // Enforcing expiry only in the caller made the docblock's "and has not
    // expired" a promise the function did not keep.
    const expiredPass: ConsumerProbeObservation = {
      status: 'passed',
      observedAt: '2026-08-01T11:00:00.000Z',
      expiresAt: '2026-08-01T11:15:00.000Z',
      elapsedMs: 12,
      servedProviderModel: 'qwen3:32b',
      failureCode: null,
    };
    const wellAfterExpiry = Date.parse('2026-08-01T12:00:00.000Z');

    expect(
      fleetEvidenceLevelWithProbe('confirmed', expiredPass, wellAfterExpiry),
    ).toEqual({
      level: 'declared',
      provenance: 'peer-attested',
      label: FLEET_PEER_ATTESTED_EVIDENCE_LABEL,
    });

    // ... and the identical record, asked BEFORE its expiry, still verifies.
    // Without this half the test would also pass if the function simply
    // stopped honoring probes at all.
    const beforeExpiry = Date.parse('2026-08-01T11:14:00.000Z');
    expect(
      fleetEvidenceLevelWithProbe('confirmed', expiredPass, beforeExpiry),
    ).toEqual({
      level: 'confirmed',
      provenance: 'probe-verified',
      label: FLEET_PROBE_VERIFIED_EVIDENCE_LABEL,
    });
  });

  it('a passing probe cannot manufacture evidence a peer never claimed', () => {
    // `unavailable` in means `unavailable` out is NOT the rule — a probe is a
    // genuine observation and outranks the manifest. But the peer's
    // unavailable models never reach the probe at all (they are excluded as
    // `evidence-stale` first), so this pins the function's honest behavior
    // rather than the pipeline's: given an observation, the observation wins.
    expect(
      fleetEvidenceLevelWithProbe(
        'unavailable',
        probe('passed'),
        WITHIN_WINDOW,
      ),
    ).toEqual({
      level: 'confirmed',
      provenance: 'probe-verified',
      label: FLEET_PROBE_VERIFIED_EVIDENCE_LABEL,
    });
  });
});

describe('describeConsumerProbe is the one wording both surfaces render', () => {
  it('says nothing when there is nothing to say', () => {
    expect(describeConsumerProbe(null)).toBeNull();
  });

  it('names the expiry on a stale observation, so it cannot read as current', () => {
    const phrase = describeConsumerProbe({
      status: 'stale',
      observedAt: '2026-08-01T12:00:00.000Z',
      expiresAt: '2026-08-01T12:15:00.000Z',
      elapsedMs: 12,
      servedProviderModel: 'qwen3:32b',
      failureCode: null,
    });
    expect(phrase).toContain('expired');
    expect(phrase).toContain('not evidence about now');
  });

  it('names the failure code on a failed observation', () => {
    expect(
      describeConsumerProbe({
        status: 'failed',
        observedAt: '2026-08-01T12:00:00.000Z',
        expiresAt: '2026-08-01T12:02:00.000Z',
        elapsedMs: null,
        servedProviderModel: null,
        failureCode: 'peer-unreachable',
      }),
    ).toContain('peer-unreachable');
  });
});
