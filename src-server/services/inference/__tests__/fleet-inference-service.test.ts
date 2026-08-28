/**
 * archive#1398 — the serving half's refusal taxonomy and bounds
 * (`docs/design/inference-fleet.md` §3.2, §4.5, §11 slice 2).
 *
 * The load-bearing property under test is that the CONTRIBUTED SUBSET is the
 * only allowlist. A model this Station can launch but has not contributed
 * must be exactly as unreachable as one that does not exist — and refused
 * with the same code, so the difference is not an enumeration oracle.
 */

import type {
  FleetContributedModel,
  FleetContributionManifest,
  FleetContributionParticipation,
} from '@kontourai/station-contracts/fleet-contribution';
import { FLEET_INFERENCE_LIMITS } from '@kontourai/station-contracts/fleet-inference';
import type { ConnectionConfig } from '@kontourai/station-contracts/tool';
import { describe, expect, test, vi } from 'vitest';
import type {
  ILLMProvider,
  LLMStreamChunk,
  LLMStreamOpts,
} from '../../../providers/llm/model-provider-types.js';
import {
  boundFleetContributionManifest,
  FleetInferenceService,
  validateFleetCompletionRequest,
} from '../fleet-inference-service.js';

// archive#3545 LOW: `#generate` reads `chunk.finishReason ?? null` (line
// ~660), which is honest pass-through — the bug was never here. It was that
// EVERY `AiSdkLLMProvider`-backed provider (Anthropic, Google, OpenAI-compat,
// Bedrock, Ollama) never set `chunk.finishReason` at all, so every fleet
// completion served through one of them reported `finishReason: null`
// regardless of what actually happened. The synthetic `streamingProvider`
// stubs everywhere else in this file supply `finishReason` directly and so
// never exercised that gap — this mocks `ai` to drive a REAL
// `AiSdkLLMProvider` subclass through `FleetInferenceService.complete()`,
// proving the fix at the one seam a stub cannot: production.
vi.mock('ai', () => ({
  streamText: vi.fn(() => ({
    // archive#3586: `AiSdkLLMProvider.createStream` now consumes
    // `result.fullStream`, not `result.textStream` — this mock's
    // `fullStream` yields the raw `TextStreamPart` union (`text-delta` parts
    // carry their text on `.text`, per `node_modules/ai/dist/index.d.ts`),
    // matching what a real ai-sdk stream produces.
    fullStream: (async function* () {
      yield { type: 'text-delta', text: 'truncated ' };
      yield { type: 'text-delta', text: 'answer' };
    })(),
    response: Promise.resolve({}),
    finishReason: Promise.resolve('length'),
  })),
}));
const { AiSdkLLMProvider } = await import(
  '../../../providers/llm/ai-sdk-llm-provider.js'
);

class RealAiSdkProviderStub extends AiSdkLLMProvider {
  readonly id = 'fleet-test-provider';
  readonly displayName = 'Fleet Test Provider';
  protected languageModel(): any {
    return {} as any;
  }
  async listModels() {
    return [];
  }
  async getPrerequisites() {
    return [];
  }
}

const CONNECTION_ID = 'ollama-workstation';

function contributedModel(
  overrides: Partial<FleetContributedModel> = {},
): FleetContributedModel {
  return {
    id: `${CONNECTION_ID}:llama3.3`,
    connectionId: CONNECTION_ID,
    providerModel: 'llama3.3:70b',
    model: { id: 'llama3.3', revision: null, quantization: null },
    aliases: ['llama3.3'],
    displayName: 'Llama 3.3 70B',
    locality: 'local',
    availability: 'available',
    freshness: 'live',
    observedAt: '2026-08-01T10:00:00.000Z',
    effectiveContextTokens: 131_072,
    toolSurface: null,
    supportsVision: false,
    ...overrides,
  };
}

function manifest(
  participation: FleetContributionParticipation,
  models: FleetContributedModel[] = [],
): FleetContributionManifest {
  return {
    schemaVersion: 'station.fleet-contribution/v1',
    projectedAt: '2026-08-01T10:00:01.000Z',
    sourceObservedAt: '2026-08-01T10:00:00.000Z',
    participation,
    models,
    diagnostics: [],
  };
}

function modelConnection(): ConnectionConfig {
  return {
    id: CONNECTION_ID,
    kind: 'model',
    type: 'ollama',
    name: 'Workstation Ollama',
    enabled: true,
    capabilities: ['llm'],
    config: { baseUrl: 'http://127.0.0.1:11434' },
    status: 'ready',
    prerequisites: [],
    lastCheckedAt: null,
  };
}

function streamingProvider(
  chunks: LLMStreamChunk[],
  seen: LLMStreamOpts[] = [],
): ILLMProvider {
  return {
    id: 'ollama',
    displayName: 'Ollama',
    listModels: async () => [],
    createStream(opts: LLMStreamOpts) {
      seen.push(opts);
      return (async function* () {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

function service(options: {
  manifest?: FleetContributionManifest;
  manifestError?: Error;
  connection?: ConnectionConfig | null;
  provider?: ILLMProvider | null;
}) {
  return new FleetInferenceService({
    getFleetContributionManifest: async () => {
      if (options.manifestError) throw options.manifestError;
      return options.manifest ?? manifest('disabled');
    },
    getConnection: async () =>
      options.connection === undefined ? modelConnection() : options.connection,
    createProvider: () =>
      options.provider === undefined
        ? streamingProvider([
            { type: 'text-delta', content: 'hello ' },
            { type: 'text-delta', content: 'fleet' },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: { inputTokens: 11, outputTokens: 2 },
            },
          ])
        : options.provider,
    now: () => new Date('2026-08-01T10:00:02.000Z'),
  });
}

const REQUEST = {
  model: `${CONNECTION_ID}:llama3.3`,
  messages: [{ role: 'user', content: 'Summarize this changelog.' }],
};

describe('FleetInferenceService: authorized + contributed serves a completion', () => {
  test('returns the buffered completion envelope with the served model identity', async () => {
    const outcome = await service({
      manifest: manifest('contributing', [contributedModel()]),
    }).complete(REQUEST);

    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.response.schemaVersion).toBe(
      'station.fleet-inference-completion/v1',
    );
    // The discriminant that makes streaming additive rather than a contract
    // break (§10 OQ-8) — v1 always buffers, and says so.
    expect(outcome.response.delivery).toBe('buffered');
    expect(outcome.response.content).toBe('hello fleet');
    expect(outcome.response.stop).toBe('provider');
    expect(outcome.response.finishReason).toBe('stop');
    expect(outcome.response.usage).toEqual({
      inputTokens: 11,
      outputTokens: 2,
    });
    expect(outcome.response.model).toEqual({
      id: `${CONNECTION_ID}:llama3.3`,
      connectionId: CONNECTION_ID,
      providerModel: 'llama3.3:70b',
      displayName: 'Llama 3.3 70B',
    });
  });

  test('invokes the provider with the provider-native model id and NO tools', async () => {
    const seen: LLMStreamOpts[] = [];
    const outcome = await service({
      manifest: manifest('contributing', [contributedModel()]),
      provider: streamingProvider(
        [{ type: 'finish', finishReason: 'stop' }],
        seen,
      ),
    }).complete({ ...REQUEST, maxOutputTokens: 64, temperature: 0.2 });

    expect(outcome.kind).toBe('completed');
    expect(seen).toHaveLength(1);
    expect(seen[0].model).toBe('llama3.3:70b');
    expect(seen[0].maxTokens).toBe(64);
    expect(seen[0].temperature).toBe(0.2);
    // The mechanism by which "no tool execution" is true rather than a claim:
    // nothing is ever passed, so the provider cannot call anything. This is
    // the assertion that would fail if fleet inference ever drifted toward
    // `delegate_task`.
    expect(seen[0].tools).toBeUndefined();
  });

  test('a tool-call chunk from a provider is ignored, never acted on', async () => {
    const outcome = await service({
      manifest: manifest('contributing', [contributedModel()]),
      provider: streamingProvider([
        { type: 'text-delta', content: 'thinking' },
        {
          type: 'tool-call',
          toolCall: { id: '1', name: 'run_shell', arguments: { cmd: 'rm' } },
        },
        { type: 'finish', finishReason: 'stop' },
      ]),
    }).complete(REQUEST);

    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.response.content).toBe('thinking');
    expect(JSON.stringify(outcome.response)).not.toContain('run_shell');
  });
});

describe('FleetInferenceService: real ai-sdk producer propagation (station#3545 LOW)', () => {
  test('a completion served through a real AiSdkLLMProvider subclass reports the propagated finishReason, not null', async () => {
    const outcome = await service({
      manifest: manifest('contributing', [contributedModel()]),
      provider: new RealAiSdkProviderStub({}),
    }).complete(REQUEST);

    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.response.content).toBe('truncated answer');
    // The mocked ai-sdk `finishReason` resolves to 'length' (a token-ceiling
    // truncation); `AiSdkLLMProvider.createStream` maps that onto station's
    // vocabulary as 'max-tokens' before #generate ever sees it. Pre-fix this
    // was unconditionally `null` for every AiSdkLLMProvider-backed
    // completion, truncated or not.
    expect(outcome.response.finishReason).toBe('max-tokens');
  });
});

describe('FleetInferenceService: named refusals, never a silent 404 (§4.5)', () => {
  test('a non-contributed model is refused by name and is participation-aware', async () => {
    const outcome = await service({
      manifest: manifest('contributing', [contributedModel()]),
    }).complete({ ...REQUEST, model: 'ollama-workstation:some-other-model' });

    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') return;
    expect(outcome.refusal.code).toBe('model-not-contributed');
    expect(outcome.refusal.participation).toBe('contributing');
    expect(outcome.refusal.message.length).toBeGreaterThan(0);
    expect(outcome.refusal.schemaVersion).toBe(
      'station.fleet-inference-refusal/v1',
    );
  });

  test('a launchable-but-not-contributed model is indistinguishable from a nonexistent one (§5.2 rule 2)', async () => {
    // The enumeration-oracle guard: if these two ever diverge, a peer holding
    // only `inference:invoke` can probe which models this Station HAS but has
    // chosen not to contribute.
    const instance = service({
      manifest: manifest('contributing', [contributedModel()]),
    });
    const withheld = await instance.complete({
      ...REQUEST,
      model: `${CONNECTION_ID}:qwen3-coder`,
    });
    const nonexistent = await instance.complete({
      ...REQUEST,
      model: 'no-such-connection:no-such-model',
    });

    expect(withheld.kind).toBe('refused');
    expect(nonexistent.kind).toBe('refused');
    if (withheld.kind !== 'refused' || nonexistent.kind !== 'refused') return;
    expect(withheld.refusal.code).toBe(nonexistent.refusal.code);
    expect(withheld.refusal.message).toBe(nonexistent.refusal.message);
  });

  test('an alias or provider-native id does not reach the model — only the manifest join key does', async () => {
    const instance = service({
      manifest: manifest('contributing', [contributedModel()]),
    });
    for (const model of ['llama3.3', 'llama3.3:70b']) {
      const outcome = await instance.complete({ ...REQUEST, model });
      expect(outcome.kind).toBe('refused');
      if (outcome.kind !== 'refused') continue;
      expect(outcome.refusal.code).toBe('model-not-contributed');
    }
  });

  test('contribution disabled is refused with the disabled code and state', async () => {
    const outcome = await service({ manifest: manifest('disabled') }).complete(
      REQUEST,
    );
    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') return;
    expect(outcome.refusal.code).toBe('contribution-disabled');
    expect(outcome.refusal.participation).toBe('disabled');
  });

  test('opt-in on with nothing marked is still a disabled-shaped refusal, but names its own state', async () => {
    const outcome = await service({
      manifest: manifest('nothing-contributed'),
    }).complete(REQUEST);
    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') return;
    expect(outcome.refusal.code).toBe('contribution-disabled');
    expect(outcome.refusal.participation).toBe('nothing-contributed');
  });

  test('contributed-but-yielding-nothing is unavailable, not "no such model"', async () => {
    const outcome = await service({
      manifest: manifest('contributed-unavailable'),
    }).complete(REQUEST);
    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') return;
    expect(outcome.refusal.code).toBe('contribution-unavailable');
    expect(outcome.refusal.participation).toBe('contributed-unavailable');
  });

  test('an unreadable manifest is unknown, not empty', async () => {
    const outcome = await service({
      manifestError: new Error('inventory refresh failed'),
    }).complete(REQUEST);
    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') return;
    expect(outcome.refusal.code).toBe('contribution-unavailable');
    expect(outcome.refusal.participation).toBeUndefined();
  });

  test('a stale contributed model is refused as unavailable rather than served', async () => {
    const outcome = await service({
      manifest: manifest('contributing', [
        contributedModel({ availability: 'stale' }),
      ]),
    }).complete(REQUEST);
    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') return;
    expect(outcome.refusal.code).toBe('model-unavailable');
  });

  test('a contributed model whose connection no longer resolves refuses instead of throwing', async () => {
    const outcome = await service({
      manifest: manifest('contributing', [contributedModel()]),
      connection: null,
    }).complete(REQUEST);
    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') return;
    expect(outcome.refusal.code).toBe('model-unavailable');
  });

  test('a provider failure never relays the upstream error text across the machine boundary', async () => {
    const outcome = await service({
      manifest: manifest('contributing', [contributedModel()]),
      provider: streamingProvider([
        {
          type: 'error',
          error: 'connect ECONNREFUSED 10.0.0.7:11434 (profile brian-work)',
        },
      ]),
    }).complete(REQUEST);

    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') return;
    expect(outcome.refusal.code).toBe('execution-failed');
    // Host, port, and account name would all be topology disclosure — §4.2
    // carries no base URLs, and a refusal must not become the side channel
    // the manifest refuses to be.
    expect(outcome.refusal.message).not.toContain('10.0.0.7');
    expect(outcome.refusal.message).not.toContain('brian-work');
    expect(outcome.refusal.message).not.toContain('ECONNREFUSED');
  });
});

describe('FleetInferenceService: bounds (§3.2, §12)', () => {
  test('generation stops at the response bound and says so rather than looking complete', async () => {
    const oversized = 'x'.repeat(
      FLEET_INFERENCE_LIMITS.maxCompletionCharacters + 500,
    );
    const outcome = await service({
      manifest: manifest('contributing', [contributedModel()]),
      provider: streamingProvider([
        { type: 'text-delta', content: oversized },
        { type: 'finish', finishReason: 'stop' },
      ]),
    }).complete(REQUEST);

    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.response.content).toHaveLength(
      FLEET_INFERENCE_LIMITS.maxCompletionCharacters,
    );
    // The honest-degradation property: a truncated answer must not read as a
    // complete one, so `stop` reports this Station's own ceiling separately
    // from whatever the provider would have said.
    expect(outcome.response.stop).toBe('response-bound');
  });

  test('concurrency is bounded and the overflow request is refused by name', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowProvider: ILLMProvider = {
      id: 'ollama',
      displayName: 'Ollama',
      listModels: async () => [],
      createStream() {
        return (async function* () {
          await gate;
          yield { type: 'finish', finishReason: 'stop' } as LLMStreamChunk;
        })();
      },
    };
    const instance = service({
      manifest: manifest('contributing', [contributedModel()]),
      provider: slowProvider,
    });

    const inFlight = Array.from(
      { length: FLEET_INFERENCE_LIMITS.maxConcurrentCompletions },
      () => instance.complete(REQUEST),
    );
    // Let the in-flight completions register before the overflow attempt.
    await vi.waitFor(() =>
      expect(instance.inFlight).toBe(
        FLEET_INFERENCE_LIMITS.maxConcurrentCompletions,
      ),
    );

    const overflow = await instance.complete(REQUEST);
    expect(overflow.kind).toBe('refused');
    if (overflow.kind === 'refused') {
      expect(overflow.refusal.code).toBe('capacity-exhausted');
      // One code, one shape. Admission control runs before the contribution
      // projection, so at the earlier check point `participation` is genuinely
      // unknown; carrying it at only the later one would make its absence read
      // as a fact about contribution rather than about where the request was
      // stopped.
      expect(overflow.refusal.participation).toBeUndefined();
    }

    release?.();
    const settled = await Promise.all(inFlight);
    expect(settled.every((outcome) => outcome.kind === 'completed')).toBe(true);
    // The slot is released even though a refusal happened alongside it.
    expect(instance.inFlight).toBe(0);
  });
});

describe('validateFleetCompletionRequest', () => {
  test('refuses stream: true by name rather than silently buffering (§10 OQ-8)', () => {
    const result = validateFleetCompletionRequest({ ...REQUEST, stream: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('streaming-unsupported');
  });

  test('accepts an explicit stream: false', () => {
    expect(
      validateFleetCompletionRequest({ ...REQUEST, stream: false }).ok,
    ).toBe(true);
  });

  test('there is no tool role — fleet inference serves completions only', () => {
    const result = validateFleetCompletionRequest({
      ...REQUEST,
      messages: [{ role: 'tool', content: '{}' }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('request-invalid');
  });

  test('refuses an over-ceiling maxOutputTokens instead of silently clamping', () => {
    // Clamping would let a consumer believe it bounded a cost it did not.
    const result = validateFleetCompletionRequest({
      ...REQUEST,
      maxOutputTokens: FLEET_INFERENCE_LIMITS.maxOutputTokens + 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('request-too-large');
  });

  test('defaults maxOutputTokens to the ceiling and honors a smaller one', () => {
    const defaulted = validateFleetCompletionRequest(REQUEST);
    expect(defaulted.ok).toBe(true);
    if (defaulted.ok) {
      expect(defaulted.value.maxOutputTokens).toBe(
        FLEET_INFERENCE_LIMITS.maxOutputTokens,
      );
    }
    const explicit = validateFleetCompletionRequest({
      ...REQUEST,
      maxOutputTokens: 32,
    });
    expect(explicit.ok).toBe(true);
    if (explicit.ok) expect(explicit.value.maxOutputTokens).toBe(32);
  });

  test('bounds message count and total prompt characters', () => {
    const tooMany = validateFleetCompletionRequest({
      ...REQUEST,
      messages: Array.from(
        { length: FLEET_INFERENCE_LIMITS.maxMessages + 1 },
        () => ({ role: 'user', content: 'hi' }),
      ),
    });
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.code).toBe('request-too-large');

    const tooLong = validateFleetCompletionRequest({
      ...REQUEST,
      messages: [
        {
          role: 'user',
          content: 'x'.repeat(FLEET_INFERENCE_LIMITS.maxPromptCharacters + 1),
        },
      ],
    });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.code).toBe('request-too-large');
  });

  test('rejects non-object bodies, empty messages, and a missing model', () => {
    for (const body of [null, 'text', [], 42]) {
      const result = validateFleetCompletionRequest(body);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('request-invalid');
    }
    expect(
      validateFleetCompletionRequest({ ...REQUEST, messages: [] }).ok,
    ).toBe(false);
    expect(
      validateFleetCompletionRequest({ messages: REQUEST.messages }).ok,
    ).toBe(false);
  });
});

describe('boundFleetContributionManifest (§4.2 peer-boundary decision)', () => {
  test('truncates a foreign diagnostic message but keeps the code authoritative', () => {
    const long = 'y'.repeat(
      FLEET_INFERENCE_LIMITS.maxDiagnosticMessageCharacters + 100,
    );
    const bounded = boundFleetContributionManifest({
      ...manifest('contributing', [contributedModel()]),
      diagnostics: [
        { connectionId: CONNECTION_ID, code: 'stale-catalog', message: long },
      ],
    });

    expect(bounded.diagnostics[0].code).toBe('stale-catalog');
    expect(bounded.diagnostics[0].message).toHaveLength(
      FLEET_INFERENCE_LIMITS.maxDiagnosticMessageCharacters,
    );
    // Truncated, not dropped: the local wording an operator recognizes from
    // their own Connections surface is most of its value when two people are
    // debugging one fleet.
    expect(bounded.diagnostics[0].message.startsWith('yyy')).toBe(true);
  });

  test('a model list over the boundary limit reports the truncation instead of just being shorter', () => {
    const many = Array.from(
      { length: FLEET_INFERENCE_LIMITS.maxManifestModels + 3 },
      (_, index) => contributedModel({ id: `${CONNECTION_ID}:model-${index}` }),
    );
    const bounded = boundFleetContributionManifest(
      manifest('contributing', many),
    );

    expect(bounded.models).toHaveLength(
      FLEET_INFERENCE_LIMITS.maxManifestModels,
    );
    expect(
      bounded.diagnostics.some(
        (diagnostic) => diagnostic.code === 'inventory-truncated',
      ),
    ).toBe(true);
  });

  test('leaves a within-limits manifest untouched', () => {
    const source = manifest('contributing', [contributedModel()]);
    expect(boundFleetContributionManifest(source)).toEqual(source);
  });
});

/**
 * archive#1398, review round 1 (M-1) — a concurrency cap is only a
 * bound if every occupant is guaranteed to leave.
 *
 * Before this, a provider that accepted a request and never yielded held its
 * slot forever; two such requests pinned the whole fleet surface permanently,
 * which costs a peer two requests and no credential beyond `inference:invoke`.
 */
describe('FleetInferenceService: liveness bounds (M-1)', () => {
  function neverEndingProvider(seen: LLMStreamOpts[] = []): ILLMProvider {
    return {
      id: 'ollama',
      displayName: 'Ollama',
      listModels: async () => [],
      createStream(opts: LLMStreamOpts) {
        seen.push(opts);
        return (async function* () {
          yield { type: 'text-delta', content: 'thinking' } as LLMStreamChunk;
          // Resolves only when the signal it was handed fires. A provider
          // that ignores the signal entirely is a different (and separately
          // disclosed) failure mode; this one honors it, like every adapter
          // in `src-server/providers/llm`.
          await new Promise<void>((resolve) => {
            opts.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
        })();
      },
    };
  }

  test('a client disconnect aborts generation, frees the slot, and names the outcome', async () => {
    const seen: LLMStreamOpts[] = [];
    const instance = service({
      manifest: manifest('contributing', [contributedModel()]),
      provider: neverEndingProvider(seen),
    });
    const caller = new AbortController();

    const pending = instance.complete(REQUEST, { signal: caller.signal });
    await vi.waitFor(() => expect(instance.inFlight).toBe(1));

    caller.abort();
    const outcome = await pending;

    expect(outcome.kind).toBe('refused');
    if (outcome.kind === 'refused') {
      expect(outcome.refusal.code).toBe('request-abandoned');
    }
    // The property that matters: the slot is back, so the next peer is served.
    expect(instance.inFlight).toBe(0);
    // And the signal genuinely reached the provider — a route that threaded
    // nothing would leave the model generating tokens nobody reads.
    expect(seen[0]?.signal).toBeDefined();
    expect(seen[0]?.signal?.aborted).toBe(true);
  });

  test('the completion deadline fires on a never-ending stream and frees the slot', async () => {
    vi.useFakeTimers();
    try {
      const instance = service({
        manifest: manifest('contributing', [contributedModel()]),
        provider: neverEndingProvider(),
      });

      const pending = instance.complete(REQUEST);
      await vi.waitFor(() => expect(instance.inFlight).toBe(1));

      await vi.advanceTimersByTimeAsync(
        FLEET_INFERENCE_LIMITS.completionDeadlineMs + 1,
      );
      const outcome = await pending;

      expect(outcome.kind).toBe('refused');
      if (outcome.kind === 'refused') {
        // Distinct from `execution-failed`: the provider did not fail, it
        // failed to finish, and slice 3's router must not de-rank a healthy
        // peer for a request that was simply too long.
        expect(outcome.refusal.code).toBe('completion-timeout');
        expect(outcome.refusal.participation).toBe('contributing');
      }
      expect(instance.inFlight).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('two wedged completions no longer pin the cap forever', async () => {
    vi.useFakeTimers();
    try {
      const instance = service({
        manifest: manifest('contributing', [contributedModel()]),
        provider: neverEndingProvider(),
      });

      const wedged = Array.from(
        { length: FLEET_INFERENCE_LIMITS.maxConcurrentCompletions },
        () => instance.complete(REQUEST),
      );
      await vi.waitFor(() =>
        expect(instance.inFlight).toBe(
          FLEET_INFERENCE_LIMITS.maxConcurrentCompletions,
        ),
      );

      // Saturated: the next peer is correctly refused...
      const refusedWhileFull = await instance.complete(REQUEST);
      expect(refusedWhileFull.kind).toBe('refused');

      // ...but the saturation is temporary, which is the whole point.
      await vi.advanceTimersByTimeAsync(
        FLEET_INFERENCE_LIMITS.completionDeadlineMs + 1,
      );
      await Promise.all(wedged);
      expect(instance.inFlight).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a provider that throws on abort is still reported as a timeout, not a provider fault', async () => {
    vi.useFakeTimers();
    try {
      const throwOnAbort: ILLMProvider = {
        id: 'ollama',
        displayName: 'Ollama',
        listModels: async () => [],
        createStream(opts: LLMStreamOpts) {
          return (async function* () {
            yield { type: 'text-delta', content: 'x' } as LLMStreamChunk;
            await new Promise<void>((_, reject) => {
              opts.signal?.addEventListener(
                'abort',
                () => reject(new Error('aborted')),
                { once: true },
              );
            });
          })();
        },
      };
      const instance = service({
        manifest: manifest('contributing', [contributedModel()]),
        provider: throwOnAbort,
      });

      const pending = instance.complete(REQUEST);
      await vi.waitFor(() => expect(instance.inFlight).toBe(1));
      await vi.advanceTimersByTimeAsync(
        FLEET_INFERENCE_LIMITS.completionDeadlineMs + 1,
      );
      const outcome = await pending;

      expect(outcome.kind).toBe('refused');
      if (outcome.kind === 'refused') {
        expect(outcome.refusal.code).toBe('completion-timeout');
      }
      expect(instance.inFlight).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('admission control runs before the manifest projection, so a refused request does no pre-admission work', async () => {
    // L-2: the projection can trigger a bounded inventory refresh with a
    // multi-second deadline. Doing it for a request that was always going to
    // be refused lets a saturated Station be pushed further under by the
    // requests it is refusing.
    const getFleetContributionManifest = vi.fn(async () =>
      manifest('contributing', [contributedModel()]),
    );
    const getConnection = vi.fn(async () => modelConnection());
    const instance = new FleetInferenceService({
      getFleetContributionManifest,
      getConnection,
      createProvider: () => neverEndingProvider(),
    });

    const wedged = Array.from(
      { length: FLEET_INFERENCE_LIMITS.maxConcurrentCompletions },
      () => instance.complete(REQUEST),
    );
    await vi.waitFor(() =>
      expect(instance.inFlight).toBe(
        FLEET_INFERENCE_LIMITS.maxConcurrentCompletions,
      ),
    );
    const callsBefore = getFleetContributionManifest.mock.calls.length;

    const refused = await instance.complete(REQUEST);
    expect(refused.kind).toBe('refused');
    if (refused.kind === 'refused') {
      expect(refused.refusal.code).toBe('capacity-exhausted');
      expect(refused.refusal.participation).toBeUndefined();
    }
    expect(getFleetContributionManifest.mock.calls.length).toBe(callsBefore);
    expect(getConnection.mock.calls.length).toBe(
      FLEET_INFERENCE_LIMITS.maxConcurrentCompletions,
    );

    for (const pending of wedged) void pending;
  });
});

describe('FleetInferenceService: response-bound accounting (L-3)', () => {
  test('a delta that exactly fills the budget is NOT reported as truncated', () => {
    // `>=` treated an exactly-fitting final delta as an overflow: the
    // response claimed `response-bound` even though nothing was cut, and
    // (before the drain fix) lost its terminal accounting as well.
    return (async () => {
      const exact = 'x'.repeat(FLEET_INFERENCE_LIMITS.maxCompletionCharacters);
      const outcome = await service({
        manifest: manifest('contributing', [contributedModel()]),
        provider: streamingProvider([
          { type: 'text-delta', content: exact },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 5, outputTokens: 9 },
          },
        ]),
      }).complete(REQUEST);

      expect(outcome.kind).toBe('completed');
      if (outcome.kind !== 'completed') return;
      expect(outcome.response.content).toHaveLength(
        FLEET_INFERENCE_LIMITS.maxCompletionCharacters,
      );
      expect(outcome.response.stop).toBe('provider');
      expect(outcome.response.finishReason).toBe('stop');
      expect(outcome.response.usage).toEqual({
        inputTokens: 5,
        outputTokens: 9,
      });
    })();
  });

  test('a genuinely truncated completion still carries the provider terminal accounting', async () => {
    // Breaking out of the loop at the ceiling meant EVERY response-bound
    // completion reported `finishReason: null` and `usage: null` — the two
    // fields a consumer needs most when it has just been told the answer was
    // cut off, and the case where "the provider reported nothing" is a lie.
    const outcome = await service({
      manifest: manifest('contributing', [contributedModel()]),
      provider: streamingProvider([
        {
          type: 'text-delta',
          content: 'y'.repeat(
            FLEET_INFERENCE_LIMITS.maxCompletionCharacters + 10,
          ),
        },
        { type: 'text-delta', content: 'discarded overflow' },
        {
          type: 'finish',
          finishReason: 'length',
          usage: { inputTokens: 3, outputTokens: 4096 },
        },
      ]),
    }).complete(REQUEST);

    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') return;
    expect(outcome.response.stop).toBe('response-bound');
    expect(outcome.response.content).toHaveLength(
      FLEET_INFERENCE_LIMITS.maxCompletionCharacters,
    );
    expect(outcome.response.content).not.toContain('discarded overflow');
    expect(outcome.response.finishReason).toBe('length');
    expect(outcome.response.usage).toEqual({
      inputTokens: 3,
      outputTokens: 4096,
    });
  });
});

describe('boundFleetContributionManifest: overflow notices survive each other (L-5)', () => {
  test('a Station that overflows BOTH models and diagnostics reports both truncations', () => {
    // The models-truncation notice used to be appended to the diagnostics
    // list and was therefore the first thing the diagnostics trim sliced
    // off — leaving a short model list with no stated reason, which is the
    // exact silent degradation this function exists to prevent.
    const many = Array.from(
      { length: FLEET_INFERENCE_LIMITS.maxManifestModels + 5 },
      (_, index) => contributedModel({ id: `${CONNECTION_ID}:model-${index}` }),
    );
    const noisy = Array.from(
      { length: FLEET_INFERENCE_LIMITS.maxManifestDiagnostics + 5 },
      (_, index) => ({
        connectionId: `conn-${index}`,
        code: 'stale-catalog' as const,
        message: `stale ${index}`,
      }),
    );

    const bounded = boundFleetContributionManifest({
      ...manifest('contributing', many),
      diagnostics: noisy,
    });

    expect(bounded.diagnostics.length).toBeLessThanOrEqual(
      FLEET_INFERENCE_LIMITS.maxManifestDiagnostics,
    );
    const messages = bounded.diagnostics.map((item) => item.message);
    expect(messages.some((m) => m.includes('contributes more models'))).toBe(
      true,
    );
    expect(messages.some((m) => m.includes('more diagnostics'))).toBe(true);
  });
});
