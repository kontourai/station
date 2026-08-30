import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { AgentRegistry } from '../../../domain/agent-registry.js';

/**
 * `vi.mock` factories are hoisted above imports, so the fixtures below cannot
 * close over an imported class directly. The holder is filled in immediately
 * after the imports and read only when a fixture actually throws.
 */
const catalogErrors = vi.hoisted(
  () => ({ HttpError: null }) as { HttpError: any },
);

const catalogControl = vi.hoisted(() => ({
  mode: new Map<
    string,
    | 'live'
    | 'empty'
    | 'unavailable'
    | 'delayed'
    | 'manual'
    | 'truncated'
    | 'unreachable'
  >(),
  model: new Map<string, string>(),
  calls: new Map<string, number>(),
  pending: new Map<
    string,
    (catalog: {
      source: 'live';
      models: Array<{ id: string; name: string }>;
    }) => void
  >(),
  active: 0,
  maxActive: 0,
  aborted: new Set<string>(),
  cleanupComplete: new Set<string>(),
}));

vi.mock('../../../providers/connection-factories.js', () => ({
  createLLMProvider: vi.fn((connection: any) =>
    connection.type === 'controlled-llm'
      ? {
          listModels: vi.fn(async () => []),
          listModelCatalog: vi.fn(async () => {
            catalogControl.calls.set(
              connection.id,
              (catalogControl.calls.get(connection.id) ?? 0) + 1,
            );
            const mode = catalogControl.mode.get(connection.id) ?? 'live';
            if (mode === 'unavailable') {
              return { source: 'unavailable', models: [] };
            }
            if (mode === 'empty') return { source: 'live', models: [] };
            if (mode === 'manual') {
              return new Promise((resolve) => {
                catalogControl.pending.set(connection.id, resolve);
              });
            }
            if (mode === 'delayed') {
              catalogControl.active += 1;
              catalogControl.maxActive = Math.max(
                catalogControl.maxActive,
                catalogControl.active,
              );
              await new Promise((resolve) => setTimeout(resolve, 1));
              catalogControl.active -= 1;
            }
            const model = catalogControl.model.get(connection.id) ?? 'model-a';
            return {
              source: 'live',
              models: [{ id: model, name: model }],
              ...(mode === 'truncated' ? { truncated: true } : {}),
            };
          }),
        }
      : connection.type === 'flaky-llm'
        ? {
            // A transport failure with no status on it — a DNS failure, a
            // connection reset, a provider that went away for a moment. Not a
            // refusal: nothing here is the provider turning these settings
            // away (delta2 review M1).
            getPrerequisites: vi.fn(async () => []),
            listModels: vi.fn(async () => {
              if (catalogControl.mode.get(connection.id) === 'unreachable') {
                throw new Error('fetch failed');
              }
              return [{ id: 'model-a', name: 'model-a' }];
            }),
          }
        : connection.type === 'empty-catalog-llm'
          ? {
              // A live 200 with an empty list: reachable, but it establishes
              // neither an available model nor a working chat endpoint.
              getPrerequisites: vi.fn(async () => []),
              listModels: vi.fn(async () => []),
              listModelCatalog: vi.fn(async () => ({
                source: 'live',
                models: [],
              })),
            }
          : connection.type === 'no-catalog-chat-ok-llm'
            ? {
                // The OpenAI-compatible shape the delta review names: no /models
                // route at all, but chat works.
                getPrerequisites: vi.fn(async () => []),
                listModels: vi.fn(async () => {
                  throw new catalogErrors.HttpError(404);
                }),
                createStream: async function* () {
                  yield { type: 'text-delta', content: 'p' };
                  yield { type: 'finish', finishReason: 'length' };
                },
              }
            : connection.type === 'no-catalog-chat-refused-llm'
              ? {
                  getPrerequisites: vi.fn(async () => []),
                  listModels: vi.fn(async () => {
                    throw new catalogErrors.HttpError(404);
                  }),
                  createStream: async function* () {
                    // `chatErrorStatus` mirrors what ai-sdk attaches to a
                    // failed turn; absent means the failure carried no status
                    // at all, and `chatSilent` is a stream that yields nothing
                    // for Station to judge.
                    if (connection.config?.chatSilent === true) return;
                    const status = connection.config?.chatErrorStatus;
                    yield {
                      type: 'error',
                      error: 'chat refused: 401 unauthorized',
                      ...(typeof status === 'number'
                        ? { errorStatus: status }
                        : {}),
                    };
                  },
                }
              : connection.type === 'auth-refused-llm'
                ? {
                    getPrerequisites: vi.fn(async () => []),
                    listModels: vi.fn(async () => {
                      throw new catalogErrors.HttpError(401);
                    }),
                  }
                : connection.type === 'silent-unavailable-llm'
                  ? {
                      // Unavailable with NO reason: exactly what a key-based provider
                      // answers when no key is configured. Station never reached the
                      // provider, so discovery must record nothing.
                      getPrerequisites: vi.fn(async () => []),
                      listModels: vi.fn(async () => []),
                      listModelCatalog: vi.fn(async () => ({
                        source: 'unavailable',
                        models: [],
                      })),
                    }
                  : connection.type === 'live-catalog-llm'
                    ? {
                        getPrerequisites: vi.fn(async () => []),
                        listModels: vi.fn(async () => [
                          { id: 'm-1', name: 'M 1' },
                        ]),
                        listModelCatalog: vi.fn(async () => ({
                          source: 'live',
                          models: [{ id: 'm-1', name: 'M 1' }],
                        })),
                      }
                    : connection.type === 'silently-refusing-llm'
                      ? {
                          getPrerequisites: vi.fn(async () => []),
                          // The key-based providers swallow their own failure and answer an
                          // empty list; only the catalog carries the reason.
                          listModels: vi.fn(async () => []),
                          listModelCatalog: vi.fn(async () => ({
                            source: 'unavailable',
                            models: [],
                            reason: `Model catalog request failed with HTTP 401 for ${connection.config?.apiKey}.`,
                            reasonKind: 'refused',
                          })),
                        }
                      : connection.type === 'refusing-llm'
                        ? {
                            getPrerequisites: vi.fn(async () => []),
                            // Echoes the key back, as real provider SDKs do — the redaction
                            // in describeModelCheckFailure is what keeps it out of the UI.
                            // `statusCode` is how ai-sdk's `APICallError` carries the
                            // refusal structurally; without it a 401 is indistinguishable
                            // from a network failure and is treated as transient.
                            listModels: vi.fn(async () => {
                              throw Object.assign(
                                new Error(
                                  `401 invalid x-api-key: ${connection.config?.apiKey}`,
                                ),
                                { statusCode: 401 },
                              );
                            }),
                          }
                        : connection.type === 'rejecting-llm'
                          ? {
                              getPrerequisites: vi.fn(async () => []),
                              listModels: vi.fn(async () => []),
                              listModelCatalog: vi.fn(async () => {
                                throw new Error('catalog rejected');
                              }),
                            }
                          : connection.type === 'abortable-llm'
                            ? {
                                abortSettlement: 'await' as const,
                                getPrerequisites: vi.fn(async () => []),
                                listModels: vi.fn(async () => []),
                                listModelCatalog: vi.fn(
                                  ({ signal }: { signal?: AbortSignal } = {}) =>
                                    new Promise<never>((_, reject) => {
                                      signal?.addEventListener(
                                        'abort',
                                        () => {
                                          catalogControl.aborted.add(
                                            connection.id,
                                          );
                                          setTimeout(() => {
                                            catalogControl.cleanupComplete.add(
                                              connection.id,
                                            );
                                            reject(signal.reason);
                                          }, 25);
                                        },
                                        { once: true },
                                      );
                                    }),
                                ),
                              }
                            : connection.type === 'ollama'
                              ? {
                                  execution: {
                                    runtime: { id: 'ollama', version: null },
                                    adapter: {
                                      id: 'station-ollama',
                                      version: null,
                                    },
                                    locality: 'local',
                                  },
                                  listModels: vi.fn(async () => {
                                    if (
                                      connection.config?.catalogUnavailable ===
                                      true
                                    ) {
                                      throw new Error(
                                        'fixture catalog unavailable',
                                      );
                                    }
                                    const fixture =
                                      connection.config?.testModels;
                                    const models = Array.isArray(fixture)
                                      ? fixture
                                      : ['qwen3:30b'];
                                    return models.map((id: string) => ({
                                      id,
                                      name: id,
                                      contextWindow: 32_768,
                                      supportsTools: true,
                                    }));
                                  }),
                                }
                              : connection.type === 'openai-compat'
                                ? {
                                    listModels: vi.fn(async () => [
                                      { id: 'gpt-4.1', name: 'gpt-4.1' },
                                      {
                                        id: 'gpt-4o-mini',
                                        name: 'gpt-4o-mini',
                                      },
                                    ]),
                                  }
                                : connection.type === 'slow-llm'
                                  ? {
                                      listModels: vi.fn(
                                        () => new Promise(() => {}),
                                      ),
                                    }
                                  : connection.type === 'fallback-llm'
                                    ? {
                                        listModels: vi.fn(async () => []),
                                        listModelCatalog: vi.fn(async () => ({
                                          source: 'built-in',
                                          models: [
                                            {
                                              id: 'built-in',
                                              name: 'Built in',
                                            },
                                          ],
                                        })),
                                      }
                                    : null,
  ),
  createEmbeddingProvider: vi.fn(() => null),
  createVectorDbProvider: vi.fn(() => null),
}));

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setProviderAdapterRegistrationProvenance } from '../../../providers/adapter-shape.js';
import { ModelCatalogHttpError } from '../../../providers/registries/catalog-http.js';
import { credentialProfileApplication } from '../../../telemetry/metrics.js';
import { EventStore } from '../../orchestration/event-store.js';
import {
  type ConnectionSmokeRunner,
  type ConnectionSmokeRunResult,
} from '../connection-service.js';
import {
  createConnectionServiceForTest,
  createConnectionServiceWithCredentialApplicationFactoryForTest,
} from './connection-service-test-helper.js';

catalogErrors.HttpError = ModelCatalogHttpError;

beforeEach(() => {
  catalogControl.mode.clear();
  catalogControl.model.clear();
  catalogControl.calls.clear();
  catalogControl.pending.clear();
  catalogControl.active = 0;
  catalogControl.maxActive = 0;
  catalogControl.aborted.clear();
  catalogControl.cleanupComplete.clear();
});

/** Not a credential: a distinctive marker string this suite asserts is redacted. */
const FIXTURE_CREDENTIAL = ['fixture', 'invalid', 'marker', '000'].join('-');
const REPLACEMENT_CREDENTIAL = ['fixture', 'other', 'marker'].join('-');

describe('ConnectionService — model connection check evidence (RT-06)', () => {
  function refusingProviderService(config: Record<string, unknown>) {
    const connection = {
      id: 'anthropic-1',
      type: 'refusing-llm',
      name: 'Anthropic',
      enabled: true,
      capabilities: ['llm'],
      config,
    };
    return {
      connection,
      service: {
        listProviderConnections: vi.fn(() => [connection]),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(async () => false),
      } as any,
    };
  }

  function serviceFor(providerService: any) {
    return createConnectionServiceForTest(
      providerService,
      () => [] as any,
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(async (updates: any) => updates),
    );
  }

  function providerServiceFor(
    type: string,
    config: Record<string, unknown>,
    name = 'Anthropic',
  ) {
    const connection = {
      id: 'anthropic-1',
      type,
      name,
      enabled: true,
      capabilities: ['llm'],
      config,
    };
    return {
      connection,
      service: {
        listProviderConnections: vi.fn(() => [connection]),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(async () => type === 'live-catalog-llm'),
      } as any,
    };
  }

  test('a refused test is recorded, redacted, and read back by the connection view', async () => {
    const { service: providerService } = refusingProviderService({
      apiKey: FIXTURE_CREDENTIAL,
    });
    const service = serviceFor(providerService);

    const result = await service.testConnection('anthropic-1');
    expect(result.healthy).toBe(false);
    // The provider's own words reach the caller; the key it echoed does not.
    expect(result.reason).toBe('401 invalid x-api-key: [redacted]');
    expect(result.reason).not.toContain(FIXTURE_CREDENTIAL);
    expect(result.checkedAt).toBeTruthy();
    // Review M2: the endpoint must not answer healthy:false beside a stored
    // status of 'ready'.
    expect(result.status).toBe('missing_prerequisites');

    const [view] = await service.listModelConnections();
    expect(view.readinessEvidence?.check).toMatchObject({
      status: 'failed',
      reason: '401 invalid x-api-key: [redacted]',
    });
    // "Ready" is what this used to say, from a saved string alone.
    expect(view.readinessEvidence?.level).toBe('discovered');
    expect(view.lastCheckedAt).toBeTruthy();
  });

  test('a provider that swallows its own failure still reports the HTTP reason, redacted', async () => {
    const { service: providerService } = providerServiceFor(
      'silently-refusing-llm',
      { apiKey: FIXTURE_CREDENTIAL },
    );
    const service = serviceFor(providerService);

    const result = await service.testConnection('anthropic-1');
    expect(result.healthy).toBe(false);
    // `listModels` alone answers [], which would have been reported as "no
    // models" — a different claim from "the provider refused".
    expect(result.reason).toBe(
      'Model catalog request failed with HTTP 401 for [redacted].',
    );
    expect(result.reason).not.toContain(FIXTURE_CREDENTIAL);
  });

  // Review H2 — the listing's own catalogue fetch IS a check, so "Ready" can
  // never come from a saved string alone.
  test('a live catalogue records a passed check attributed to discovery', async () => {
    const { service: providerService } = providerServiceFor(
      'live-catalog-llm',
      { apiKey: FIXTURE_CREDENTIAL },
    );
    const service = serviceFor(providerService);

    const [view] = await service.listModelConnections();
    expect(view.readinessEvidence?.check).toMatchObject({
      status: 'passed',
      source: 'catalog-discovery',
    });
    expect(view.readinessEvidence?.level).toBe('catalog-ready');
    expect(view.lastCheckedAt).toBeTruthy();
  });

  test('a discovery refusal records a failed check without an explicit test', async () => {
    const { service: providerService } = refusingProviderService({
      apiKey: FIXTURE_CREDENTIAL,
    });
    const service = serviceFor(providerService);

    const [view] = await service.listModelConnections();
    expect(view.readinessEvidence?.check).toMatchObject({
      status: 'failed',
      source: 'catalog-discovery',
    });
    // The provider echoed the key into its error; discovery redacts before
    // recording, exactly like the explicit test does.
    expect(view.readinessEvidence?.check?.reason).not.toContain(
      FIXTURE_CREDENTIAL,
    );
    expect(view.readinessEvidence?.level).toBe('discovered');
    expect(service.checkGatedModelConnectionIds()).toEqual(
      new Map([['anthropic-1', 'failed']]),
    );
  });

  // Delta review H1 — a live 200 with an EMPTY list proves the endpoint is
  // reachable and nothing else. Recording it as a pass claimed "Ready to use
  // in chats and agents" off a response that established no model and no chat
  // endpoint.
  test('an empty live catalogue is catalog-unavailable, not passed and not refused', async () => {
    const { service: providerService } = providerServiceFor(
      'empty-catalog-llm',
      { apiKey: FIXTURE_CREDENTIAL },
    );
    const service = serviceFor(providerService);

    const [view] = await service.listModelConnections();
    expect(view.readinessEvidence?.check).toMatchObject({
      status: 'catalog-unavailable',
      source: 'catalog-discovery',
    });
    expect(view.readinessEvidence?.level).not.toBe('catalog-ready');
    // Not a refusal: it must not be excluded from readiness/recommendations.
    expect(service.checkGatedModelConnectionIds().size).toBe(0);
  });

  // Delta review H1 — the OpenAI-compatible case: chat works, /models 404s.
  // Discovery must not mark it broken, and an explicit test must be able to
  // earn Ready by asking the chat route directly.
  test('a catalog-less endpoint is reachable-not-ready, and an explicit test can earn Ready', async () => {
    const { service: providerService } = providerServiceFor(
      'no-catalog-chat-ok-llm',
      { defaultModel: 'gpt-tiny' },
    );
    const service = serviceFor(providerService);

    const [discovered] = await service.listModelConnections();
    expect(discovered.readinessEvidence?.check).toMatchObject({
      status: 'catalog-unavailable',
      source: 'catalog-discovery',
    });
    expect(service.checkGatedModelConnectionIds().size).toBe(0);

    const result = await service.testConnection('anthropic-1');
    expect(result.healthy).toBe(true);
    const [tested] = await service.listModelConnections();
    expect(tested.readinessEvidence?.check).toMatchObject({
      status: 'passed',
      source: 'explicit-test',
    });
    // …and the next listing's 404 must not take that pass away again.
    const [again] = await service.listModelConnections();
    expect(again.readinessEvidence?.check).toMatchObject({
      status: 'passed',
      source: 'explicit-test',
    });
  });

  test('a catalog-less endpoint whose chat is refused IS a refusal', async () => {
    const { service: providerService } = providerServiceFor(
      'no-catalog-chat-refused-llm',
      { defaultModel: 'gpt-tiny' },
    );
    const service = serviceFor(providerService);

    const result = await service.testConnection('anthropic-1');
    expect(result.healthy).toBe(false);
    expect(result.reason).toContain('chat refused: 401 unauthorized');
    expect(service.checkGatedModelConnectionIds()).toEqual(
      new Map([['anthropic-1', 'failed']]),
    );
  });

  // Delta2 review M2 — one word for every chat failure hid the difference
  // between "these credentials are refused" and "this endpoint has no such
  // model", which are fixed in completely different places.
  describe('the chat probe says which failure it saw', () => {
    test('401 is these credentials being refused', async () => {
      const { service: providerService } = providerServiceFor(
        'no-catalog-chat-refused-llm',
        { defaultModel: 'gpt-tiny', chatErrorStatus: 401 },
      );
      const service = serviceFor(providerService);

      const result = await service.testConnection('anthropic-1');

      expect(result.healthy).toBe(false);
      expect(result.reason).toContain('refused a minimal chat request');
      expect(result.reason).toContain('HTTP 401');
      expect(service.checkGatedModelConnectionIds().size).toBe(1);
    });

    test('404 names the model, not a refusal', async () => {
      const { service: providerService } = providerServiceFor(
        'no-catalog-chat-refused-llm',
        { defaultModel: 'gpt-tiny', chatErrorStatus: 404 },
      );
      const service = serviceFor(providerService);

      const result = await service.testConnection('anthropic-1');

      expect(result.healthy).toBe(false);
      expect(result.reason).toContain('no such model on this endpoint');
      expect(result.reason).toContain('HTTP 404');
      expect(result.reason).not.toContain('refused a minimal chat request');
    });

    test('a failure carrying no status keeps the provider’s own words', async () => {
      const { service: providerService } = providerServiceFor(
        'no-catalog-chat-refused-llm',
        { defaultModel: 'gpt-tiny' },
      );
      const service = serviceFor(providerService);

      const result = await service.testConnection('anthropic-1');

      expect(result.reason).toBe('chat refused: 401 unauthorized');
    });

    test('a stream that produced nothing to judge is not a failure', async () => {
      const { service: providerService } = providerServiceFor(
        'no-catalog-chat-refused-llm',
        { defaultModel: 'gpt-tiny', chatSilent: true },
      );
      const service = serviceFor(providerService);

      const result = await service.testConnection('anthropic-1');

      expect(result.healthy).toBe(false);
      const [view] = await service.listModelConnections();
      // Station learned nothing: reachable, unproven, and NOT gated.
      expect(view.readinessEvidence?.check?.status).toBe('catalog-unavailable');
      expect(service.checkGatedModelConnectionIds().size).toBe(0);
    });
  });

  test('a catalog-less endpoint with no default model stays reachable-not-ready and says what is missing', async () => {
    const { service: providerService } = providerServiceFor(
      'no-catalog-chat-ok-llm',
      {},
    );
    const service = serviceFor(providerService);

    const result = await service.testConnection('anthropic-1');
    expect(result.healthy).toBe(false);
    expect(result.reason).toContain('Set a default model');
    const [view] = await service.listModelConnections();
    expect(view.readinessEvidence?.check?.status).toBe('catalog-unavailable');
    expect(service.checkGatedModelConnectionIds().size).toBe(0);
  });

  test('a 401 on the catalog route is a refusal, not a missing catalog', async () => {
    const { service: providerService } = providerServiceFor(
      'auth-refused-llm',
      { apiKey: FIXTURE_CREDENTIAL },
    );
    const service = serviceFor(providerService);

    const [view] = await service.listModelConnections();
    expect(view.readinessEvidence?.check).toMatchObject({ status: 'failed' });
    expect(service.checkGatedModelConnectionIds()).toEqual(
      new Map([['anthropic-1', 'failed']]),
    );
  });

  test('a provider Station never reached leaves the check unasked', async () => {
    // Unavailable with no reason is Station giving up, not a refusal: a
    // timeout or an unconfigured key must not be recorded against the
    // provider.
    const { service: providerService } = providerServiceFor(
      'silent-unavailable-llm',
      { apiKey: FIXTURE_CREDENTIAL },
    );
    const service = serviceFor(providerService);

    const [view] = await service.listModelConnections();
    expect(view.readinessEvidence?.check).toEqual({ status: 'not-checked' });
    expect(view.lastCheckedAt).toBeNull();
    expect(service.checkGatedModelConnectionIds().size).toBe(0);
  });

  // Delta2 review M1 — automatic discovery runs on every listing, so one DNS
  // failure or connection reset used to overwrite an explicit pass with a
  // durable refusal and drop a healthy connection out of every
  // recommendation.
  describe('a transient outage is not a refusal', () => {
    async function passedThenUnreachable() {
      const { connection, service: providerService } = providerServiceFor(
        'flaky-llm',
        { apiKey: FIXTURE_CREDENTIAL },
      );
      const service = serviceFor(providerService);
      // A live catalogue first: this is the pass the grace window protects.
      expect(
        (await service.listModelConnections())[0].readinessEvidence?.check
          ?.status,
      ).toBe('passed');
      catalogControl.mode.set(connection.id, 'unreachable');
      return { service, connection };
    }

    test('one unreachable listing after a pass is retrying, not gating', async () => {
      const { service } = await passedThenUnreachable();

      const [view] = await service.listModelConnections();
      expect(view.readinessEvidence?.check).toMatchObject({
        status: 'unreachable',
        retrying: true,
        source: 'catalog-discovery',
      });
      expect(service.checkGatedModelConnectionIds().size).toBe(0);
    });

    test('three consecutive unreachable listings stop being called transient', async () => {
      const { service } = await passedThenUnreachable();

      await service.listModelConnections();
      await service.listModelConnections();
      const [view] = await service.listModelConnections();

      expect(view.readinessEvidence?.check).toMatchObject({
        status: 'unreachable',
        retrying: false,
      });
      expect(service.checkGatedModelConnectionIds()).toEqual(
        new Map([['anthropic-1', 'unreachable']]),
      );
      expect(view.readinessEvidence?.level).toBe('discovered');
    });

    test('the grace window also closes on time, without another listing', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-08-20T10:00:00.000Z'));
        const { service } = await passedThenUnreachable();
        await service.listModelConnections();
        expect(service.checkGatedModelConnectionIds().size).toBe(0);

        vi.setSystemTime(new Date('2026-08-20T10:10:01.000Z'));
        expect(service.checkGatedModelConnectionIds()).toEqual(
          new Map([['anthropic-1', 'unreachable']]),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    test('with no prior pass there is nothing to protect and it gates at once', async () => {
      const { connection, service: providerService } = providerServiceFor(
        'flaky-llm',
        { apiKey: FIXTURE_CREDENTIAL },
      );
      catalogControl.mode.set(connection.id, 'unreachable');
      const service = serviceFor(providerService);

      const [view] = await service.listModelConnections();
      expect(view.readinessEvidence?.check).toMatchObject({
        status: 'unreachable',
        retrying: false,
      });
      expect(service.checkGatedModelConnectionIds().size).toBe(1);
    });

    test('recovering clears the run, so the next outage starts a fresh window', async () => {
      const { connection, service: providerService } = providerServiceFor(
        'flaky-llm',
        { apiKey: FIXTURE_CREDENTIAL },
      );
      const service = serviceFor(providerService);
      await service.listModelConnections();
      catalogControl.mode.set(connection.id, 'unreachable');
      await service.listModelConnections();
      await service.listModelConnections();
      catalogControl.mode.set(connection.id, 'live');
      expect(
        (await service.listModelConnections())[0].readinessEvidence?.check
          ?.status,
      ).toBe('passed');

      catalogControl.mode.set(connection.id, 'unreachable');
      const [view] = await service.listModelConnections();
      expect(view.readinessEvidence?.check).toMatchObject({
        status: 'unreachable',
        retrying: true,
      });
    });
  });

  test('editing the connection retires the recorded check instead of vouching for new credentials', async () => {
    const config: Record<string, unknown> = { apiKey: FIXTURE_CREDENTIAL };
    const { service: providerService } = providerServiceFor(
      'silent-unavailable-llm',
      config,
    );
    const service = serviceFor(providerService);

    await service.testConnection('anthropic-1');
    // Station never got an answer at all, which is `unreachable`, not a
    // refusal (delta2 review M1) — and with no prior pass to protect there is
    // no grace window, so it gates readiness immediately.
    expect(
      (await service.listModelConnections())[0].readinessEvidence?.check
        ?.status,
    ).toBe('unreachable');
    expect(service.checkGatedModelConnectionIds().size).toBe(1);

    config.apiKey = REPLACEMENT_CREDENTIAL;
    const [after] = await service.listModelConnections();
    expect(after.readinessEvidence?.check).toEqual({ status: 'not-checked' });
    expect(after.lastCheckedAt).toBeNull();
    expect(service.checkGatedModelConnectionIds().size).toBe(0);
  });
});

describe('ConnectionService', () => {
  test('binds a public registry connection id to its runtime adapter for quota reads', async () => {
    const readQuotaSnapshot = vi.fn(async (_input: unknown) => ({
      kind: 'snapshot' as const,
      snapshot: {
        connectionId: 'codex',
        provider: 'codex' as const,
        source: 'provider-reported' as const,
        accountScope: 'profile' as const,
        observedAt: '2026-08-10T00:00:00.000Z',
        windows: [],
      },
    }));
    const invalidateQuotaSnapshot = vi.fn();
    let quotaReadEnabled = true;
    const registry: AgentRegistry = {
      version: 2,
      revision: 0,
      engineConnections: [
        {
          id: engineConnectionId('codex'),
        },
      ],
      defaultAgents: [{ id: agentId('station'), kind: 'station' }],
    };
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => []),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () =>
        [
          {
            provider: 'codex' as const,
            metadata: {
              displayName: 'Codex',
              description: 'runtime',
              capabilities: ['agent-runtime'] as const,
              builtin: true,
              engineId: 'codex',
            },
            getPrerequisites: vi.fn(async () => []),
            ...(quotaReadEnabled ? { readQuotaSnapshot } : {}),
            invalidateQuotaSnapshot,
          },
        ] as any,
      async () => [],
      () => ({ connections: [] }),
      async () =>
        ({
          agentConnections: {
            codex: {
              credentialRecovery: {
                profiles: [{ ref: 'profile-a' }],
                activeProfileRef: 'profile-a',
              },
            },
          },
        }) as any,
      vi.fn(async (updates: any) => updates),
      undefined,
      undefined,
      [],
      undefined,
      { load: async () => registry, register: vi.fn(), unregister: vi.fn() },
    );

    await expect(service.readQuotaSnapshot('codex')).resolves.toEqual({
      kind: 'snapshot',
      snapshot: {
        connectionId: 'codex',
        provider: 'codex',
        source: 'provider-reported',
        accountScope: 'profile',
        observedAt: '2026-08-10T00:00:00.000Z',
        windows: [],
      },
    });
    expect(readQuotaSnapshot).toHaveBeenCalledWith({
      connectionId: 'codex',
      credentialProfileRef: 'profile-a',
    });
    await expect(service.readQuotaSnapshot('codex')).resolves.toEqual({
      kind: 'snapshot',
      snapshot: expect.objectContaining({ connectionId: 'codex' }),
    });
    expect(readQuotaSnapshot).toHaveBeenLastCalledWith({
      connectionId: 'codex',
      credentialProfileRef: 'profile-a',
    });
    registry.engineConnections = [{ id: engineConnectionId('codex') }];
    await expect(service.readQuotaSnapshot('codex')).resolves.toEqual({
      kind: 'snapshot',
      snapshot: expect.objectContaining({ connectionId: 'codex' }),
    });
    expect(readQuotaSnapshot).toHaveBeenLastCalledWith({
      connectionId: 'codex',
    });
    registry.engineConnections = [
      {
        id: engineConnectionId('codex'),
      },
    ];
    quotaReadEnabled = false;
    await expect(service.readQuotaSnapshot('codex')).resolves.toEqual({
      kind: 'unavailable',
      reason: 'unsupported-provider',
    });
    quotaReadEnabled = true;
    await service.upsertCredentialProfile('codex', { ref: 'profile-b' });
    expect(invalidateQuotaSnapshot).toHaveBeenCalledWith({
      connectionId: 'codex',
    });
    await (service as any).invalidateQuotaSnapshot('codex');
    expect(invalidateQuotaSnapshot).toHaveBeenLastCalledWith({
      connectionId: 'codex',
    });
  });

  test('reports the active launchable inventory without exposing connection secrets', async () => {
    const providerService = {
      listProviderConnections: vi.fn(() => [
        {
          id: 'ollama-local',
          type: 'ollama',
          name: 'Local Ollama',
          config: { apiKey: 'must-not-escape' },
          enabled: true,
          capabilities: ['llm'],
        },
      ]),
      saveProviderConnection: vi.fn(),
      deleteProviderConnection: vi.fn(),
      checkHealth: vi.fn().mockResolvedValue(true),
    };
    const service = createConnectionServiceForTest(
      providerService as any,
      () => [],
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(async (updates: any) => updates),
    );

    const inventory = await service.listLaunchableModelInventory();

    expect(inventory.schemaVersion).toBe('station.model-inventory/v2');
    expect(inventory.models).toHaveLength(1);
    expect(inventory.models[0]).toMatchObject({
      connectionId: 'ollama-local',
      runtime: { id: 'ollama', version: null },
      locality: 'local',
      providerModel: 'qwen3:30b',
    });
    expect(JSON.stringify(inventory)).not.toContain('must-not-escape');
  });

  // archive#1430: getModelToolSurface backs DispatchEvidenceSource.getModelToolSurface
  // (dispatch-model-policy.ts). Real ConnectionService instance, real
  // listLaunchableModelInventory() computation underneath — not a stub —
  // proving the deterministic accessor actually resolves a genuine
  // provider-reported toolSurface end to end, not just that the unit
  // function signature accepts one.
  test('getModelToolSurface resolves a real toolSurface for a matching connection+model, and null for anything unmatched', async () => {
    const providerService = {
      listProviderConnections: vi.fn(() => [
        {
          id: 'ollama-local',
          type: 'ollama',
          name: 'Local Ollama',
          config: {},
          enabled: true,
          capabilities: ['llm'],
        },
      ]),
      saveProviderConnection: vi.fn(),
      deleteProviderConnection: vi.fn(),
      checkHealth: vi.fn().mockResolvedValue(true),
    };
    const service = createConnectionServiceForTest(
      providerService as any,
      () => [],
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(async (updates: any) => updates),
    );

    const result = await service.getModelToolSurface([
      { connectionId: 'ollama-local', modelId: 'qwen3:30b' },
      { connectionId: 'ollama-local', modelId: 'no-such-model' },
      { connectionId: 'no-such-connection', modelId: 'qwen3:30b' },
    ]);

    expect(result).toEqual([['tool-calls'], null, null]);
  });

  test('does not run unrelated adapter command discovery for model inventory', async () => {
    const getCommands = vi.fn().mockRejectedValue(new Error('must not run'));
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => []),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () =>
        [
          {
            provider: 'codex',
            metadata: {
              displayName: 'Codex',
              description: 'Codex',
              capabilities: ['agent-runtime'],
              runtimeId: 'codex',
              executionClass: 'connected',
            },
            getPrerequisites: vi.fn().mockResolvedValue([]),
            listModels: vi.fn().mockResolvedValue([]),
            getCommands,
          },
        ] as any,
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(),
    );

    await expect(service.listLaunchableModelInventory()).resolves.toBeTruthy();
    expect(getCommands).not.toHaveBeenCalled();
  });

  test('first-run mode disables host-dependent Agent app discovery', async () => {
    const getPrerequisites = vi.fn().mockResolvedValue([]);
    const listModels = vi.fn().mockResolvedValue([{ id: 'host-model' }]);
    const getCommands = vi.fn().mockResolvedValue([{ name: 'host-command' }]);
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => []),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () =>
        [
          {
            provider: 'claude',
            metadata: {
              displayName: 'Claude Code',
              description: 'Claude',
              capabilities: ['agent-runtime'],
              runtimeId: 'claude',
              executionClass: 'connected',
            },
            getPrerequisites,
            listModels,
            getCommands,
          },
        ] as any,
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(),
    );

    vi.stubEnv('STATION_E2E_FIRST_RUN', '1');
    try {
      const [connection] = await service.listRuntimeConnections();

      expect(getPrerequisites).not.toHaveBeenCalled();
      expect(listModels).not.toHaveBeenCalled();
      expect(getCommands).not.toHaveBeenCalled();
      expect(connection).toMatchObject({
        status: 'missing_prerequisites',
        setup: { state: 'available', detected: false, configured: false },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('does not publish Agent fallback selectors after live discovery fails', async () => {
    const adapter = {
      provider: 'codex',
      metadata: {
        displayName: 'Codex',
        description: 'Codex',
        capabilities: ['agent-runtime'],
        runtimeId: 'codex',
        executionClass: 'connected',
      },
      getPrerequisites: vi.fn().mockResolvedValue([
        {
          id: 'codex',
          name: 'Codex',
          status: 'missing',
          category: 'required',
        },
      ]),
      listModels: vi.fn().mockRejectedValue(new Error('missing binary')),
    } as any;
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => []),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () => [adapter],
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(),
    );

    const inventory = await service.listLaunchableModelInventory();

    expect(inventory.models).toEqual([]);
    expect(inventory.diagnostics).toContainEqual(
      expect.objectContaining({
        connectionId: 'codex',
        code: 'not-ready',
      }),
    );
    const [runtime] = await (
      service as unknown as {
        listRuntimeConnectionsForModels(
          models: [],
          options: {
            adapters: (typeof adapter)[];
            acpConnections: [];
            appConfig: Record<string, never>;
            includeCommands: false;
            includePrerequisites: false;
            allowBuiltInOnDiscoveryFailure: false;
          },
        ): Promise<
          Array<{
            runtimeCatalog?: {
              source: string;
              models: unknown[];
              builtInModels: unknown[];
            };
          }>
        >;
      }
    ).listRuntimeConnectionsForModels([], {
      adapters: [adapter],
      acpConnections: [],
      appConfig: {},
      includeCommands: false,
      includePrerequisites: false,
      allowBuiltInOnDiscoveryFailure: false,
    });
    expect(runtime?.runtimeCatalog).toMatchObject({
      source: 'none',
      models: [],
      builtInModels: [],
    });
  });

  test('does not publish a caller-configured Agent catalog after live discovery fails', async () => {
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => []),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () =>
        [
          {
            provider: 'codex',
            metadata: {
              displayName: 'Codex',
              description: 'Codex',
              capabilities: ['agent-runtime'],
              runtimeId: 'codex',
              executionClass: 'connected',
            },
            listModels: vi.fn().mockRejectedValue(new Error('offline')),
          },
        ] as any,
      async () => [],
      () => ({ connections: [] }),
      async () =>
        ({
          agentConnections: {
            codex: {
              config: {
                cachedModelOptions: [
                  {
                    id: 'gpt-cached',
                    name: 'GPT Cached',
                    originalId: 'gpt-cached',
                  },
                ],
                cachedCatalogFetchedAt: new Date().toISOString(),
              },
            },
          },
        }) as any,
      vi.fn(),
    );

    const inventory = await service.listLaunchableModelInventory();

    expect(inventory.models).toEqual([]);
    expect(inventory.diagnostics).toContainEqual(
      expect.objectContaining({
        connectionId: 'codex',
        code: 'catalog-unavailable',
      }),
    );
  });

  test('reports a provider entry cap as incomplete discovery', async () => {
    catalogControl.mode.set('controlled', 'truncated');
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => [
          {
            id: 'controlled',
            type: 'controlled-llm',
            name: 'Controlled',
            config: {},
            enabled: true,
            capabilities: ['llm'],
          },
        ]),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () => [],
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(),
    );

    const inventory = await service.listLaunchableModelInventory();

    expect(inventory.diagnostics).toContainEqual({
      connectionId: 'controlled',
      code: 'discovery-limited',
      message: 'The model catalog was truncated by its bounded entry limit.',
    });
  });

  test('reports an Agent app entry cap as incomplete discovery', async () => {
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => []),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () =>
        [
          {
            provider: 'codex',
            metadata: {
              displayName: 'Codex',
              description: 'Codex',
              capabilities: ['agent-runtime'],
              runtimeId: 'codex',
              executionClass: 'connected',
            },
            listModelCatalog: vi.fn().mockResolvedValue({
              models: [{ id: 'gpt-a', name: 'GPT A', originalId: 'gpt-a' }],
              truncated: true,
            }),
          },
        ] as any,
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(),
    );

    const inventory = await service.listLaunchableModelInventory();

    expect(inventory.diagnostics).toContainEqual({
      connectionId: 'codex',
      code: 'discovery-limited',
      message:
        'The runtime model catalog was truncated by its bounded entry limit.',
    });
  });

  test('lists model and runtime connections', async () => {
    const providerService = {
      listProviderConnections: vi.fn(() => [
        {
          id: 'bedrock-model',
          type: 'bedrock',
          name: 'Bedrock',
          config: { region: 'us-east-1' },
          enabled: true,
          capabilities: ['llm', 'embedding'],
        },
      ]),
      saveProviderConnection: vi.fn(),
      deleteProviderConnection: vi.fn(),
      checkHealth: vi.fn().mockResolvedValue(true),
    };
    const claudeAdapter = {
      provider: 'claude' as const,
      metadata: {
        displayName: 'Claude Runtime',
        description:
          'Claude Agent SDK runtime with approvals and reasoning events.',
        capabilities: [
          'agent-runtime',
          'session-lifecycle',
          'tool-calls',
          'interrupt',
          'approvals',
          'reasoning-events',
        ] as const,
        runtimeId: 'claude',
        builtin: true,
      },
      getPrerequisites: vi.fn().mockResolvedValue([
        {
          id: 'anthropic-api-key',
          name: 'ANTHROPIC_API_KEY',
          description: 'Claude API key',
          status: 'installed' as const,
          category: 'required' as const,
        },
      ]),
    };
    const codexAdapter = {
      provider: 'codex' as const,
      metadata: {
        displayName: 'Codex Runtime',
        description: 'Codex app-server runtime over the local Codex CLI.',
        capabilities: [
          'agent-runtime',
          'session-lifecycle',
          'tool-calls',
          'interrupt',
          'approvals',
          'resume',
          'external-process',
        ] as const,
        runtimeId: 'codex',
        builtin: true,
      },
      getPrerequisites: vi.fn().mockResolvedValue([
        {
          id: 'openai-api-key',
          name: 'OPENAI_API_KEY',
          description: 'OpenAI API key',
          status: 'missing' as const,
          category: 'required' as const,
        },
      ]),
    };

    const service = createConnectionServiceForTest(
      providerService as any,
      () => [claudeAdapter, codexAdapter] as any,
      async () => [
        { id: 'kiro', name: 'Kiro', command: 'kiro', enabled: true },
      ],
      () => ({ connections: [{ id: 'kiro', status: 'available' }] }),
      async () => ({ defaultModel: 'claude-sonnet' }) as any,
      vi.fn(async (updates: any) => updates),
    );

    const connections = await service.listConnections();
    expect(connections.map((connection) => connection.id)).toEqual(
      expect.arrayContaining(['bedrock-model', 'claude', 'codex', 'kiro']),
    );
    expect(
      connections.find((connection) => connection.id === 'codex')?.status,
    ).toBe('missing_prerequisites');
    expect(
      connections.find((connection) => connection.id === 'kiro'),
    ).toMatchObject({
      type: 'acp',
      status: 'ready',
      config: { engineId: 'acp' },
      readinessEvidence: {
        level: 'catalog-ready',
        smoke: { status: 'not-tested', turnLimit: 1 },
      },
    });
  });

  test('suppresses a runtime after a real authentication failure', async () => {
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => []),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () =>
        [
          {
            provider: 'codex',
            metadata: {
              displayName: 'Codex Runtime',
              description: 'Codex app-server runtime.',
              capabilities: ['agent-runtime'],
              runtimeId: 'codex',
              builtin: true,
              executionClass: 'connected',
            },
            getPrerequisites: vi.fn().mockResolvedValue([]),
          },
        ] as any,
      async () => [],
      () => ({ connections: [] }),
      async () => ({ defaultModel: 'gpt-5.5' }) as any,
      vi.fn(async (updates: any) => updates),
      {
        getFailure: vi.fn(() => ({
          observedAt: '2026-07-13T12:00:00.000Z',
          expiresAt: '2026-07-13T12:01:00.000Z',
        })),
      },
    );

    const [connection] = await service.listRuntimeConnections();
    expect(connection).toMatchObject({
      id: 'codex',
      status: 'missing_prerequisites',
      lastCheckedAt: '2026-07-13T12:00:00.000Z',
      config: {
        readinessState: 'missing_prerequisites',
        readinessReason: expect.stringContaining(
          'rejected a real runtime request',
        ),
      },
      capabilityInventory: {
        status: 'warning',
        authStatus: 'unauthenticated',
        checkedAt: '2026-07-13T12:00:00.000Z',
      },
      prerequisites: [
        expect.objectContaining({
          id: 'runtime-authentication',
          status: 'missing',
          category: 'required',
        }),
      ],
    });
  });

  test('saves and deletes model connections through ProviderService', async () => {
    const providerService = {
      listProviderConnections: vi.fn(() => [
        {
          id: 'openai-compat',
          type: 'openai-compat',
          name: 'OpenAI Compat',
          config: { baseUrl: 'https://example.com' },
          enabled: true,
          capabilities: ['llm'],
        },
      ]),
      saveProviderConnection: vi.fn(),
      deleteProviderConnection: vi.fn(),
      checkHealth: vi.fn().mockResolvedValue(true),
    };
    const service = createConnectionServiceForTest(
      providerService as any,
      () => [],
      async () => [],
      () => ({ connections: [] }),
      async () => ({ defaultModel: 'claude-sonnet' }) as any,
      vi.fn(async (updates: any) => updates),
    );

    await service.saveConnection({
      id: 'openai-compat',
      kind: 'model',
      type: 'openai-compat',
      name: 'OpenAI Compat',
      enabled: true,
      description: 'OpenAI compatible endpoint',
      capabilities: ['llm'],
      config: { baseUrl: 'https://example.com' },
      status: 'ready',
      prerequisites: [],
      lastCheckedAt: null,
    });
    expect(providerService.saveProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'openai-compat',
        type: 'openai-compat',
      }),
    );

    await service.deleteConnection('openai-compat');
    expect(providerService.deleteProviderConnection).toHaveBeenCalledWith(
      'openai-compat',
    );
  });

  test('auto-selects a sole Ollama model before persistence', async () => {
    let providers: any[] = [];
    const providerService = {
      listProviderConnections: vi.fn(() => providers),
      saveProviderConnection: vi.fn((connection) => {
        providers = [connection];
      }),
      deleteProviderConnection: vi.fn(),
      checkHealth: vi.fn(),
    };
    const service = createConnectionServiceForTest(
      providerService as any,
      () => [],
      async () => [],
      () => ({ connections: [] }),
      async () => ({ defaultModel: '' }) as any,
      vi.fn(async (updates: any) => updates),
    );

    await service.saveConnection({
      id: 'ollama-local',
      kind: 'model',
      type: 'ollama',
      name: 'Ollama',
      enabled: true,
      capabilities: ['llm'],
      config: { baseUrl: 'http://localhost:11434' },
      status: 'ready',
      prerequisites: [],
    });

    expect(providerService.saveProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ defaultModel: 'qwen3:30b' }),
      }),
    );
  });

  test.each([
    { label: 'zero', models: [] },
    { label: 'multiple', models: ['llama3.2', 'qwen3:30b'] },
  ])(
    'requires an explicit Ollama model for $label discovered models',
    async ({ models }) => {
      const providerService = {
        listProviderConnections: vi.fn(() => []),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      };
      const service = createConnectionServiceForTest(
        providerService as any,
        () => [],
        async () => [],
        () => ({ connections: [] }),
        async () => ({ defaultModel: '' }) as any,
        vi.fn(async (updates: any) => updates),
      );

      await expect(
        service.saveConnection({
          id: 'ollama-local',
          kind: 'model',
          type: 'ollama',
          name: 'Ollama',
          enabled: true,
          capabilities: ['llm'],
          config: { baseUrl: 'http://localhost:11434', testModels: models },
          status: 'ready',
          prerequisites: [],
        }),
      ).rejects.toThrow(/model/i);
      expect(providerService.saveProviderConnection).not.toHaveBeenCalled();
    },
  );

  test('preserves an existing Ollama selector during a transient catalog outage', async () => {
    let providers: any[] = [
      {
        id: 'ollama-local',
        type: 'ollama',
        name: 'Old name',
        enabled: true,
        capabilities: ['llm'],
        config: {
          baseUrl: 'http://localhost:11434',
          defaultModel: 'qwen3:30b',
          catalogUnavailable: true,
        },
      },
    ];
    const providerService = {
      listProviderConnections: vi.fn(() => providers),
      saveProviderConnection: vi.fn((connection) => {
        providers = [connection];
      }),
      deleteProviderConnection: vi.fn(),
      checkHealth: vi.fn(),
    };
    const service = createConnectionServiceForTest(
      providerService as any,
      () => [],
      async () => [],
      () => ({ connections: [] }),
      async () => ({ defaultModel: '' }) as any,
      vi.fn(async (updates: any) => updates),
    );

    await expect(
      service.saveConnection({
        ...providers[0],
        kind: 'model',
        name: 'Renamed while offline',
        status: 'degraded',
        prerequisites: [],
      }),
    ).resolves.toMatchObject({ name: 'Renamed while offline' });
  });

  test('reports an unavailable Ollama catalog without claiming no models are installed', async () => {
    const providerService = {
      listProviderConnections: vi.fn(() => []),
      saveProviderConnection: vi.fn(),
      deleteProviderConnection: vi.fn(),
      checkHealth: vi.fn(),
    };
    const service = createConnectionServiceForTest(
      providerService as any,
      () => [],
      async () => [],
      () => ({ connections: [] }),
      async () => ({ defaultModel: '' }) as any,
      vi.fn(async (updates: any) => updates),
    );

    await expect(
      service.saveConnection({
        id: 'ollama-local',
        kind: 'model',
        type: 'ollama',
        name: 'Ollama',
        enabled: true,
        capabilities: ['llm'],
        config: {
          baseUrl: 'http://localhost:11434',
          catalogUnavailable: true,
        },
        status: 'degraded',
        prerequisites: [],
      }),
    ).rejects.toThrow(/could not load installed models/i);
    expect(providerService.saveProviderConnection).not.toHaveBeenCalled();
  });

  test('lists model connection catalogs when the provider can enumerate models', async () => {
    const providerService = {
      listProviderConnections: vi.fn(() => [
        {
          id: 'openai-compat',
          type: 'openai-compat',
          name: 'OpenAI Compat',
          config: { baseUrl: 'https://example.com' },
          enabled: true,
          capabilities: ['llm'],
        },
      ]),
      saveProviderConnection: vi.fn(),
      deleteProviderConnection: vi.fn(),
      checkHealth: vi.fn().mockResolvedValue(true),
    };
    const service = createConnectionServiceForTest(
      providerService as any,
      () => [],
      async () => [],
      () => ({ connections: [] }),
      async () => ({ defaultModel: 'gpt-4.1' }) as any,
      vi.fn(async (updates: any) => updates),
    );

    const [connection] = await service.listModelConnections();
    expect(connection?.config).toMatchObject({
      modelOptions: [
        { id: 'gpt-4.1', name: 'gpt-4.1', originalId: 'gpt-4.1' },
        {
          id: 'gpt-4o-mini',
          name: 'gpt-4o-mini',
          originalId: 'gpt-4o-mini',
        },
      ],
    });
  });

  test('falls back when a provider catalog never resolves', async () => {
    vi.useFakeTimers();

    const providerService = {
      listProviderConnections: vi.fn(() => [
        {
          id: 'slow-llm',
          type: 'slow-llm',
          name: 'Slow LLM',
          config: {},
          enabled: true,
          capabilities: ['llm'],
        },
      ]),
      saveProviderConnection: vi.fn(),
      deleteProviderConnection: vi.fn(),
      checkHealth: vi.fn().mockResolvedValue(true),
    };
    const service = createConnectionServiceForTest(
      providerService as any,
      () => [],
      async () => [],
      () => ({ connections: [] }),
      async () => ({ defaultModel: 'fallback-model' }) as any,
      vi.fn(async (updates: any) => updates),
    );

    try {
      const pending = service.listModelConnections();
      await vi.advanceTimersByTimeAsync(1500);
      const [connection] = await pending;

      expect(connection?.id).toBe('slow-llm');
      expect(connection?.config).not.toHaveProperty('modelOptions');
    } finally {
      vi.useRealTimers();
    }
  });

  test('preserves configured remote selectors as stale when live discovery times out', async () => {
    vi.useFakeTimers();
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => [
          {
            id: 'configured-remote',
            type: 'slow-llm',
            name: 'Configured remote',
            config: { defaultModel: 'provider/model-v1' },
            enabled: true,
            capabilities: ['llm'],
          },
        ]),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () => [],
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(),
    );

    try {
      const pending = service.listLaunchableModelInventory();
      await vi.advanceTimersByTimeAsync(1500);
      const inventory = await pending;

      expect(inventory.models[0]).toMatchObject({
        connectionId: 'configured-remote',
        providerModel: 'provider/model-v1',
        freshness: 'configured',
        availability: 'stale',
        observedAt: expect.any(String),
      });
      expect(inventory.diagnostics).toContainEqual(
        expect.objectContaining({
          connectionId: 'configured-remote',
          code: 'stale-catalog',
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not label a built-in provider catalog as live', async () => {
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => [
          {
            id: 'fallback-provider',
            type: 'fallback-llm',
            name: 'Fallback provider',
            config: {},
            enabled: true,
            capabilities: ['llm'],
          },
        ]),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () => [],
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(),
    );

    const inventory = await service.listLaunchableModelInventory();

    expect(inventory.models[0]).toMatchObject({
      providerModel: 'built-in',
      freshness: 'built-in',
      availability: 'stale',
      observedAt: expect.any(String),
    });
  });

  test('coalesces concurrent refreshes, serves stale truth, and recovers after a timed-out generation', async () => {
    vi.useFakeTimers();
    const getPrerequisites = vi.fn().mockResolvedValue([]);
    const adapter = {
      provider: 'codex' as const,
      metadata: {
        displayName: 'Bounded runtime',
        description: 'Bounded runtime',
        capabilities: ['agent-runtime'] as const,
        runtimeId: 'bounded-runtime',
        executionClass: 'connected' as const,
      },
      getPrerequisites,
      listModels: vi
        .fn()
        .mockResolvedValue([
          { id: 'model-a', name: 'Model A', originalId: 'model-a' },
        ]),
    };
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => []),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () => [adapter] as any,
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(),
    );

    try {
      const initial = await service.listLaunchableModelInventory();
      expect(initial.models[0]?.freshness).toBe('live');
      const initialObservedAt = initial.observedAt;

      adapter.listModels.mockImplementation(
        ({ signal }: { signal?: AbortSignal } = {}) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          }),
      );
      const first = service.listLaunchableModelInventory();
      const second = service.listLaunchableModelInventory();
      await vi.advanceTimersByTimeAsync(5000);
      const [firstStale, secondStale] = await Promise.all([first, second]);

      expect(getPrerequisites).toHaveBeenCalled();
      expect(adapter.listModels).toHaveBeenCalledTimes(2);
      expect(firstStale).toEqual(secondStale);
      expect(firstStale.observedAt).toBe(initialObservedAt);
      expect(firstStale.models[0]).toMatchObject({
        availability: 'stale',
        freshness: 'cached',
      });
      expect(firstStale.diagnostics).toContainEqual({
        connectionId: 'station:model-inventory',
        code: 'refresh-unavailable',
        message:
          'Station is serving the last successful inventory because refresh is unavailable.',
      });

      adapter.listModels.mockResolvedValue([
        { id: 'model-a', name: 'Model A', originalId: 'model-a' },
      ]);
      const recovered = await service.listLaunchableModelInventory();
      expect(recovered.models[0]).toMatchObject({
        availability: 'available',
        freshness: 'live',
      });
      expect(adapter.listModels).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not publish static runtime catalogs when required prerequisites are missing', async () => {
    const adapter = {
      provider: 'codex',
      metadata: {
        displayName: 'Codex Runtime',
        description: 'Codex app-server runtime.',
        capabilities: ['agent-runtime'],
        runtimeId: 'codex',
        executionClass: 'connected',
      },
      getPrerequisites: vi.fn().mockResolvedValue([
        {
          id: 'codex-cli',
          name: 'Codex CLI',
          status: 'missing',
          category: 'required',
        },
      ]),
      listModelCatalog: vi.fn().mockResolvedValue({
        models: [{ id: 'qwen3:30b', name: 'Qwen 30B' }],
      }),
    } as any;
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => []),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () => [adapter],
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(),
    );

    const inventory = await service.listLaunchableModelInventory();

    expect(inventory.models).toEqual([]);
    expect(inventory.diagnostics).toContainEqual(
      expect.objectContaining({
        connectionId: 'codex',
        code: 'not-ready',
      }),
    );
  });

  test('retains a matching live catalog as cached on transient failure and removes it on live-empty', async () => {
    const connection = {
      id: 'controlled',
      type: 'controlled-llm',
      name: 'Controlled',
      config: {},
      enabled: true,
      capabilities: ['llm'],
    };
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => [connection]),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () => [],
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(),
    );

    const live = await service.listLaunchableModelInventory();
    expect(live.models[0]?.providerModel).toBe('model-a');

    catalogControl.mode.set('controlled', 'unavailable');
    const cached = await service.listLaunchableModelInventory();
    expect(cached.models[0]).toMatchObject({
      providerModel: 'model-a',
      freshness: 'cached',
      availability: 'stale',
    });

    catalogControl.mode.set('controlled', 'empty');
    const removed = await service.listLaunchableModelInventory();
    expect(removed.models).toEqual([]);
  });

  test('does not reuse cached models after a connection is reconfigured under the same id', async () => {
    let connection: any = {
      id: 'controlled',
      kind: 'model',
      type: 'controlled-llm',
      name: 'Controlled',
      config: { baseUrl: 'https://a.example' },
      enabled: true,
      capabilities: ['llm'],
      status: 'ready',
      prerequisites: [],
    };
    const providerService = {
      listProviderConnections: vi.fn(() => [connection]),
      saveProviderConnection: vi.fn((next) => {
        connection = next;
      }),
      deleteProviderConnection: vi.fn(),
      checkHealth: vi.fn(),
    };
    const service = createConnectionServiceForTest(
      providerService as any,
      () => [],
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(),
    );

    await service.listLaunchableModelInventory();
    catalogControl.mode.set('controlled', 'unavailable');
    await service.saveConnection({
      ...connection,
      config: { baseUrl: 'https://b.example' },
    });

    const inventory = await service.listLaunchableModelInventory();
    expect(inventory.models).toEqual([]);
    expect(JSON.stringify(inventory)).not.toContain('model-a');
  });

  test('discards a late catalog result from the generation invalidated by a save', async () => {
    let connection: any = {
      id: 'controlled',
      kind: 'model',
      type: 'controlled-llm',
      name: 'Controlled',
      config: { baseUrl: 'https://a.example' },
      enabled: true,
      capabilities: ['llm'],
      status: 'ready',
      prerequisites: [],
    };
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => [connection]),
        saveProviderConnection: vi.fn((next) => {
          connection = next;
        }),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () => [],
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(),
    );

    catalogControl.mode.set('controlled', 'manual');
    const obsolete = service.listLaunchableModelInventory();
    const obsoleteResult = obsolete.catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(catalogControl.pending.has('controlled')).toBe(true);
    });

    catalogControl.mode.set('controlled', 'unavailable');
    await service.saveConnection({
      ...connection,
      config: { baseUrl: 'https://b.example' },
    });
    expect(await obsoleteResult).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('configuration changed'),
      }),
    );

    catalogControl.pending.get('controlled')?.({
      source: 'live',
      models: [{ id: 'obsolete-model', name: 'obsolete-model' }],
    });
    await Promise.resolve();

    const inventory = await service.listLaunchableModelInventory();
    expect(JSON.stringify(inventory)).not.toContain('obsolete-model');
  });

  test('discards a late catalog result after a committed mutation from another public path', async () => {
    let revision = 0;
    let notify: ((revision: number) => void) | undefined;
    const revisionSource = {
      getLaunchabilityRevision: () => revision,
      onLaunchabilityChange: (listener: (next: number) => void) => {
        notify = listener;
        return () => {
          notify = undefined;
        };
      },
    };
    const connection = {
      id: 'controlled',
      type: 'controlled-llm',
      name: 'Controlled',
      config: {},
      enabled: true,
      capabilities: ['llm'],
    };
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => [connection]),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () => [],
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(),
      undefined,
      undefined,
      [revisionSource],
    );

    catalogControl.mode.set('controlled', 'manual');
    const obsolete = service.listLaunchableModelInventory();
    const obsoleteResult = obsolete.catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(catalogControl.pending.has('controlled')).toBe(true);
    });

    revision += 1;
    notify?.(revision);
    expect(await obsoleteResult).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('configuration changed'),
      }),
    );

    catalogControl.pending.get('controlled')?.({
      source: 'live',
      models: [{ id: 'obsolete-model', name: 'obsolete-model' }],
    });
    await Promise.resolve();
    catalogControl.mode.set('controlled', 'unavailable');

    const inventory = await service.listLaunchableModelInventory();
    expect(JSON.stringify(inventory)).not.toContain('obsolete-model');
  });

  test('builds a generation from the exact captured provider snapshot', async () => {
    const captured = {
      id: 'captured',
      type: 'controlled-llm',
      name: 'Captured',
      config: {},
      enabled: true,
      capabilities: ['llm'],
    };
    const transient = { ...captured, id: 'transient', name: 'Transient' };
    const providerService = {
      captureLaunchabilitySnapshot: vi.fn(() => ({
        revision: 0,
        connections: [captured],
      })),
      listProviderConnections: vi.fn(() => [transient]),
      getLaunchabilityRevision: vi.fn(() => 0),
      onLaunchabilityChange: vi.fn(() => () => {}),
      saveProviderConnection: vi.fn(),
      deleteProviderConnection: vi.fn(),
      checkHealth: vi.fn(),
    };
    const service = createConnectionServiceForTest(
      providerService as any,
      () => [],
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(),
      undefined,
      undefined,
      [providerService],
    );

    const inventory = await service.listLaunchableModelInventory();

    expect(inventory.models[0]?.connectionId).toBe('captured');
    expect(providerService.listProviderConnections).not.toHaveBeenCalled();
  });

  test('builds a generation from the exact captured app config snapshot', async () => {
    const getAppConfig = vi.fn(async () => ({
      agentConnections: {
        codex: { enabled: true },
      },
    }));
    const appConfigSource = {
      captureAppConfigLaunchabilitySnapshot: vi.fn(async () => ({
        revision: 0,
        config: {
          agentConnections: {
            codex: { enabled: false },
          },
        },
      })),
      getLaunchabilityRevision: vi.fn(() => 0),
      onLaunchabilityChange: vi.fn(() => () => {}),
    };
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => []),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () =>
        [
          {
            provider: 'codex',
            metadata: {
              displayName: 'Codex',
              description: 'Codex',
              capabilities: ['agent-runtime'],
              runtimeId: 'codex',
              executionClass: 'connected',
            },
            listModels: vi
              .fn()
              .mockResolvedValue([
                { id: 'model-a', name: 'Model A', originalId: 'model-a' },
              ]),
          },
        ] as any,
      async () => [],
      () => ({ connections: [] }),
      getAppConfig as any,
      vi.fn(),
      undefined,
      undefined,
      [appConfigSource],
    );

    const inventory = await service.listLaunchableModelInventory();

    expect(inventory.models).toEqual([]);
    expect(getAppConfig).not.toHaveBeenCalled();
  });

  test('does not settle a cancelled inventory refresh before required adapter cleanup', async () => {
    let revision = 0;
    let notify: ((revision: number) => void) | undefined;
    let cleanupComplete = false;
    const listModelCatalog = vi.fn(
      ({ signal }: { signal?: AbortSignal } = {}) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              setTimeout(() => {
                cleanupComplete = true;
                reject(signal.reason);
              }, 50);
            },
            { once: true },
          );
        }),
    );
    const adapter = {
      provider: 'codex',
      metadata: {
        displayName: 'Cleanup runtime',
        description: 'Cleanup runtime',
        capabilities: ['agent-runtime'],
        runtimeId: 'cleanup-runtime',
        abortSettlement: 'await',
      },
      listModelCatalog,
    } as any;
    setProviderAdapterRegistrationProvenance(adapter, 'builtin');
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => []),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () => [adapter],
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(),
      undefined,
      undefined,
      [
        {
          getLaunchabilityRevision: () => revision,
          onLaunchabilityChange: (listener: (next: number) => void) => {
            notify = listener;
            return () => {
              notify = undefined;
            };
          },
        },
      ],
    );
    const pending = service.listLaunchableModelInventory();
    await vi.waitFor(() => expect(listModelCatalog).toHaveBeenCalled());
    let settled = false;
    void pending.catch(() => {
      settled = true;
    });

    revision += 1;
    notify?.(revision);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(cleanupComplete).toBe(false);

    await expect(pending).rejects.toThrow('configuration changed');
    expect(cleanupComplete).toBe(true);
  });

  test('bounds trusted cleanup at the reserved deadline window', async () => {
    vi.useFakeTimers();
    try {
      let cleanupComplete = false;
      const listModelCatalog = vi.fn(
        ({ signal }: { signal?: AbortSignal } = {}) =>
          new Promise<never>((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => {
                setTimeout(() => {
                  cleanupComplete = true;
                  reject(signal.reason);
                }, 1000);
              },
              { once: true },
            );
          }),
      );
      const adapter = {
        provider: 'codex',
        metadata: {
          displayName: 'Slow cleanup runtime',
          description: 'Slow cleanup runtime',
          capabilities: ['agent-runtime'],
          runtimeId: 'slow-cleanup-runtime',
          abortSettlement: 'await',
        },
        listModelCatalog,
      } as any;
      setProviderAdapterRegistrationProvenance(adapter, 'builtin');
      const service = createConnectionServiceForTest(
        {
          listProviderConnections: vi.fn(() => []),
          saveProviderConnection: vi.fn(),
          deleteProviderConnection: vi.fn(),
          checkHealth: vi.fn(),
        } as any,
        () => [adapter],
        async () => [],
        () => ({ connections: [] }),
        async () => ({}) as any,
        vi.fn(),
      );

      const pending = service.listLaunchableModelInventory();
      await vi.advanceTimersByTimeAsync(4350);
      expect(listModelCatalog).toHaveBeenCalled();
      let settled = false;
      void pending.catch(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(649);
      expect(cleanupComplete).toBe(false);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      await expect(pending).rejects.toThrow('timed out');
      expect(cleanupComplete).toBe(false);
      await vi.advanceTimersByTimeAsync(350);
      expect(cleanupComplete).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test('aborts sibling discovery when one inventory branch fails early', async () => {
    const rejectingConfig = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('catalog projection rejected');
        },
      },
    );
    const connections = [
      {
        id: 'rejecting',
        type: 'rejecting-llm',
        name: 'Rejecting',
        config: rejectingConfig,
        enabled: true,
        capabilities: ['llm'],
      },
      {
        id: 'abortable',
        type: 'abortable-llm',
        name: 'Abortable',
        config: {},
        enabled: true,
        capabilities: ['llm'],
      },
    ];
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => connections),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () => [],
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(),
    );

    await expect(service.listLaunchableModelInventory()).rejects.toThrow(
      'catalog projection rejected',
    );
    expect(catalogControl.aborted.has('abortable')).toBe(true);
    expect(catalogControl.cleanupComplete.has('abortable')).toBe(true);
  });

  test('expires a cached live catalog after the bounded stale age', async () => {
    vi.useFakeTimers();
    const connection = {
      id: 'controlled',
      type: 'controlled-llm',
      name: 'Controlled',
      config: {},
      enabled: true,
      capabilities: ['llm'],
    };
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => [connection]),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () => [],
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(),
    );

    try {
      await service.listLaunchableModelInventory();
      catalogControl.mode.set('controlled', 'unavailable');
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1);

      const inventory = await service.listLaunchableModelInventory();
      expect(inventory.models).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not extend inventory freshness when a cached catalog is republished', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T12:00:00.000Z'));
    const connection = {
      id: 'controlled',
      type: 'controlled-llm',
      name: 'Controlled',
      config: {},
      enabled: true,
      capabilities: ['llm'],
    };
    const listProviderConnections = vi.fn(() => [connection]);
    const service = createConnectionServiceForTest(
      {
        listProviderConnections,
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () => [],
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(),
    );

    try {
      const initial = await service.listLaunchableModelInventory();
      catalogControl.mode.set('controlled', 'unavailable');
      await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
      const cached = await service.listLaunchableModelInventory();
      expect(cached.observedAt).toBe(initial.observedAt);
      expect(cached.models[0]?.freshness).toBe('cached');

      await vi.advanceTimersByTimeAsync(60 * 1000 + 1);
      listProviderConnections.mockImplementation(() => {
        throw new Error('refresh unavailable');
      });
      await expect(service.listLaunchableModelInventory()).rejects.toThrow(
        'refresh unavailable',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test('bounds provider fan-out and reports omitted connections', async () => {
    const connections = Array.from({ length: 70 }, (_, index) => ({
      id: `controlled-${String(index).padStart(2, '0')}`,
      type: 'controlled-llm',
      name: `Controlled ${index}`,
      config: {},
      enabled: true,
      capabilities: ['llm'],
    }));
    for (const connection of connections) {
      catalogControl.mode.set(connection.id, 'delayed');
    }
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => [...connections].reverse()),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () => [],
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(),
    );

    const inventory = await service.listLaunchableModelInventory();

    expect(catalogControl.calls.size).toBe(64);
    expect([...catalogControl.calls.keys()].sort()).toEqual(
      connections.slice(0, 64).map((connection) => connection.id),
    );
    expect(catalogControl.maxActive).toBeLessThanOrEqual(4);
    expect(inventory.diagnostics).toContainEqual({
      connectionId: 'station:model-inventory',
      code: 'discovery-limited',
      message:
        '6 connection inventories were omitted by the bounded refresh limit.',
    });
  });

  test('does not publish a refresh that exceeds the generation deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-19T13:00:00.000Z'));
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => {
          vi.setSystemTime(new Date('2026-07-19T13:00:05.001Z'));
          return [];
        }),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () => [],
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(),
    );

    try {
      await expect(service.listLaunchableModelInventory()).rejects.toThrow(
        'timed out',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test('marks an empty stale snapshot explicitly and refuses it after the stale-age limit', async () => {
    vi.useFakeTimers();
    const listProviderConnections = vi.fn((): any[] => []);
    const service = createConnectionServiceForTest(
      {
        listProviderConnections,
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () => [],
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(),
    );

    try {
      const initial = await service.listLaunchableModelInventory();
      listProviderConnections.mockImplementation(() => {
        throw new Error('refresh unavailable');
      });

      const stale = await service.listLaunchableModelInventory();
      expect(stale.observedAt).toBe(initial.observedAt);
      expect(stale.diagnostics).toContainEqual(
        expect.objectContaining({ code: 'refresh-unavailable' }),
      );

      await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1);
      await expect(service.listLaunchableModelInventory()).rejects.toThrow(
        'refresh unavailable',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  test('keeps a stale snapshot response within the absolute inventory byte limit', async () => {
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => {
          throw new Error('refresh unavailable');
        }),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () => [],
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(),
    );
    (service as any).modelInventorySnapshot = {
      schemaVersion: 'station.model-inventory/v2',
      observedAt: new Date().toISOString(),
      models: [],
      diagnostics: [
        {
          connectionId: 'oversized',
          code: 'catalog-unavailable',
          message: 'x'.repeat(2 * 1024 * 1024 - 200),
        },
      ],
    };

    const stale = await service.listLaunchableModelInventory();

    expect(Buffer.byteLength(JSON.stringify(stale))).toBeLessThanOrEqual(
      2 * 1024 * 1024,
    );
    expect(
      Buffer.byteLength(JSON.stringify({ success: true, data: stale })),
    ).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(stale.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'refresh-unavailable' }),
    );
    expect(stale.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'discovery-limited' }),
    );
  });

  test('saves and resets runtime connection overrides through app config', async () => {
    const providerService = {
      listProviderConnections: vi.fn(() => []),
      saveProviderConnection: vi.fn(),
      deleteProviderConnection: vi.fn(),
      checkHealth: vi.fn().mockResolvedValue(true),
    };
    let appConfig: any = {
      defaultModel: 'claude-sonnet',
      agentConnections: {},
    };
    const updateAppConfig = vi.fn(async (updates: any) => {
      appConfig = { ...appConfig, ...updates };
      return appConfig;
    });
    const registry: AgentRegistry = {
      version: 2 as const,
      revision: 0,
      engineConnections: [],
      defaultAgents: [{ id: agentId('station'), kind: 'station' }],
    };
    const register = vi.fn(async (id: string) => {
      const connectionId = engineConnectionId(id);
      registry.engineConnections.push({
        id: connectionId,
      });
      registry.defaultAgents.push({
        id: agentId(id),
        kind: 'engine-connection',
        engineConnectionId: connectionId,
      });
      return registry;
    });
    const unregister = vi.fn(async (id: string) => {
      const connectionId = engineConnectionId(id);
      registry.engineConnections = registry.engineConnections.filter(
        (connection) => connection.id !== connectionId,
      );
      registry.defaultAgents = registry.defaultAgents.filter(
        (agent) => agent.id !== id,
      );
      return registry;
    });
    const service = createConnectionServiceForTest(
      providerService as any,
      () =>
        [
          {
            provider: 'claude' as const,
            metadata: {
              displayName: 'Claude Runtime',
              description:
                'Claude Agent SDK runtime with approvals and reasoning events.',
              capabilities: [
                'agent-runtime',
                'session-lifecycle',
                'tool-calls',
                'interrupt',
                'approvals',
                'reasoning-events',
              ] as const,
              runtimeId: 'claude',
              connectionId: 'claude',
              engineId: 'claude-code',
              builtin: true,
            },
            getPrerequisites: vi.fn().mockResolvedValue([]),
          },
        ] as any,
      async () => [],
      () => ({ connections: [] }),
      async () => appConfig,
      updateAppConfig,
      undefined,
      undefined,
      [],
      undefined,
      { load: async () => registry, register, unregister },
    );

    const saved = await service.saveConnection({
      id: 'claude',
      kind: 'agent',
      type: 'claude',
      name: 'Claude Code Runtime',
      enabled: false,
      description:
        'Claude Agent SDK runtime with approvals and reasoning events.',
      capabilities: [
        'agent-runtime',
        'session-lifecycle',
        'tool-calls',
        'interrupt',
        'approvals',
        'reasoning-events',
      ],
      config: { defaultModel: 'claude-3-7-sonnet' },
      status: 'ready',
      prerequisites: [],
      lastCheckedAt: null,
    });

    expect(updateAppConfig).toHaveBeenCalledWith({
      agentConnections: {
        claude: {
          name: 'Claude Code Runtime',
          enabled: false,
          // `provideSkills`/`useAppHome` are claude-specific
          // (docs/design/connections-onboarding.md §5/§1.1) — always
          // present, off by default, sanitized alongside `defaultModel`.
          config: {
            defaultModel: 'claude-3-7-sonnet',
            provideSkills: [],
            useAppHome: false,
          },
        },
      },
    });
    expect(saved.name).toBe('Claude Code Runtime');
    expect(saved.enabled).toBe(false);
    expect(saved.status).toBe('disabled');
    expect(saved.config).toMatchObject({
      defaultModel: 'claude-3-7-sonnet',
    });
    expect(register).toHaveBeenCalledWith('claude', 'claude');
    expect(registry.defaultAgents).toContainEqual(
      expect.objectContaining({
        id: 'claude',
        engineConnectionId: 'claude',
      }),
    );
    await expect(service.listEngineConnectionStates()).resolves.toEqual([
      {
        runtimeId: 'claude',
        engineConnectionId: 'claude',
        enabled: false,
      },
    ]);

    await service.deleteConnection('claude');
    expect(updateAppConfig).toHaveBeenLastCalledWith({
      agentConnections: {},
    });
    expect(unregister).toHaveBeenCalledWith('claude');
  });

  test('persists a confirmed one-turn smoke without upgrading untested inventory', async () => {
    const providerService = {
      listProviderConnections: vi.fn(() => []),
      saveProviderConnection: vi.fn(),
      deleteProviderConnection: vi.fn(),
      checkHealth: vi.fn().mockResolvedValue(true),
    };
    const adapter = {
      provider: 'codex' as const,
      metadata: {
        displayName: 'Codex Runtime',
        description: 'Codex runtime',
        capabilities: ['agent-runtime'] as const,
        runtimeId: 'codex',
        builtin: true,
        executionClass: 'connected' as const,
        modelLaunch: {
          defaultAtStart: 'engine-selected' as const,
          omissionAtResume: 'engine-selected' as const,
          omissionPerTurn: 'engine-selected' as const,
          overrideAtStart: true,
          overrideAtResume: true,
          overridePerTurn: true,
        },
      },
      getPrerequisites: vi.fn().mockResolvedValue([]),
      listModels: vi.fn().mockResolvedValue([
        { id: 'wrong-first', name: 'Wrong first', originalId: 'wrong-first' },
        { id: 'gpt-5.4', name: 'GPT-5.4', originalId: 'gpt-5.4' },
      ]),
    };
    const service = createConnectionServiceForTest(
      providerService as any,
      () => [adapter] as any,
      async () => [],
      () => ({ connections: [] }),
      async () => ({ defaultModel: 'gpt-5.4' }) as any,
      vi.fn(async (updates: any) => updates),
    );
    const runner = vi.fn().mockResolvedValue({
      ok: true,
      durationMs: 250,
      model: 'gpt-5.4',
    });
    service.setSmokeRunner(runner);

    const [before] = await service.listRuntimeConnections();
    expect(before.readinessEvidence).toMatchObject({
      level: 'catalog-ready',
      smoke: { status: 'not-tested' },
    });
    await expect(
      service.smokeConnection('codex', { confirmed: false }),
    ).rejects.toThrow('Explicit confirmation');
    expect(runner).not.toHaveBeenCalled();

    const evidence = await service.smokeConnection('codex', {
      confirmed: true,
      timeoutMs: 20_000,
    });

    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'codex',
        provider: 'codex',
        modelId: 'gpt-5.4',
        timeoutMs: 20_000,
      }),
    );
    expect(evidence).toMatchObject({
      level: 'smoke-passed',
      smoke: { status: 'passed', model: 'gpt-5.4', turnLimit: 1 },
    });
    expect(
      (await service.listRuntimeConnections())[0].readinessEvidence,
    ).toMatchObject({ level: 'smoke-passed', smoke: { status: 'passed' } });

    runner.mockRejectedValueOnce(new Error('secret token=do-not-store'));
    const failed = await service.smokeConnection('codex', {
      confirmed: true,
    });
    expect(failed).toMatchObject({
      level: 'catalog-ready',
      smoke: {
        status: 'failed',
        reasonCode: 'unknown',
        reason:
          'The bounded smoke runner failed before it could publish a safe receipt.',
      },
    });
    expect(JSON.stringify(failed)).not.toContain('do-not-store');
  });

  test.each([
    {
      provider: 'claude' as const,
      runtimeId: 'claude',
      displayName: 'Claude Runtime',
    },
    {
      provider: 'codex' as const,
      runtimeId: 'codex',
      displayName: 'Codex Runtime',
    },
  ])(
    'smokes an engine-selected $provider runtime without a configured model selector',
    async ({ provider, runtimeId, displayName }) => {
      const adapter = {
        provider,
        metadata: {
          displayName,
          description: `${displayName} fixture`,
          capabilities: ['agent-runtime'] as const,
          builtin: true,
          modelLaunch: {
            defaultAtStart: 'engine-selected' as const,
            omissionAtResume: 'engine-selected' as const,
            omissionPerTurn: 'engine-selected' as const,
            overrideAtStart: true,
            overrideAtResume: true,
            overridePerTurn: true,
          },
        },
        getPrerequisites: vi.fn().mockResolvedValue([]),
        listModels: vi.fn().mockResolvedValue([]),
      };
      const service = createConnectionServiceForTest(
        {
          listProviderConnections: vi.fn(() => []),
          saveProviderConnection: vi.fn(),
          deleteProviderConnection: vi.fn(),
          checkHealth: vi.fn(),
        } as any,
        () => [adapter] as any,
        async () => [],
        () => ({ connections: [] }),
        async () => ({}) as any,
        vi.fn(),
      );
      const runner = vi.fn().mockResolvedValue({ ok: true, durationMs: 25 });
      service.setSmokeRunner(runner);

      await service.smokeConnection(runtimeId, { confirmed: true });

      expect(runner).toHaveBeenCalledTimes(1);
      expect(runner).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: runtimeId,
          provider,
          modelId: undefined,
        }),
      );
    },
  );

  test('does not smoke a station-resolved runtime without a configured model selector', async () => {
    const adapter = {
      provider: 'bedrock' as const,
      metadata: {
        displayName: 'Station Runtime',
        description: 'Station-managed runtime',
        capabilities: ['agent-runtime'] as const,
        runtimeId: 'bedrock-runtime',
        builtin: true,
        modelLaunch: {
          defaultAtStart: 'station-resolved' as const,
          omissionAtResume: 'retain-session-model' as const,
          omissionPerTurn: 'retain-session-model' as const,
          overrideAtStart: true,
          overrideAtResume: true,
          overridePerTurn: true,
          modelConnectionId: 'bedrock-runtime',
        },
      },
      getPrerequisites: vi.fn().mockResolvedValue([]),
      listModels: vi.fn().mockResolvedValue([]),
    };
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => []),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () => [adapter] as any,
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(),
    );
    const runner = vi.fn();
    service.setSmokeRunner(runner);

    const evidence = await service.smokeConnection('bedrock-runtime', {
      confirmed: true,
    });

    expect(runner).not.toHaveBeenCalled();
    expect(evidence).toMatchObject({
      smoke: {
        status: 'failed',
        reasonCode: 'unsupported-runtime',
        reason: 'This runtime has no configured model selector.',
      },
    });
  });

  test('does not smoke a runtime whose adapter omits model-launch capability', async () => {
    const adapter = {
      provider: 'claude' as const,
      metadata: {
        displayName: 'Capability Missing Runtime',
        description: 'Runtime without a positive model omission declaration',
        capabilities: ['agent-runtime'] as const,
        builtin: true,
      },
      getPrerequisites: vi.fn().mockResolvedValue([]),
      listModels: vi.fn().mockResolvedValue([]),
    };
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => []),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () => [adapter] as any,
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(),
    );
    const runner = vi.fn();
    service.setSmokeRunner(runner);

    const evidence = await service.smokeConnection('claude', {
      confirmed: true,
    });

    expect(runner).not.toHaveBeenCalled();
    expect(evidence).toMatchObject({
      smoke: {
        status: 'failed',
        reasonCode: 'unsupported-runtime',
        reason: 'This runtime has no configured model selector.',
      },
    });
  });

  test('smokes a generated ACP connection without requiring a model selector', async () => {
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => []),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () => [],
      async () => [
        {
          id: 'kiro',
          name: 'Kiro',
          command: 'kiro-cli',
          enabled: true,
        },
      ],
      () => ({ connections: [{ id: 'kiro', status: 'available' }] }),
      async () => ({}) as any,
      vi.fn(async (updates: any) => updates),
    );
    const runner = vi.fn().mockResolvedValue({
      ok: true,
      durationMs: 25,
    });
    service.setSmokeRunner(runner);

    const [connection] = await service.listRuntimeConnections();
    expect(connection).toMatchObject({
      id: 'kiro',
      type: 'acp',
      config: { engineId: 'acp' },
    });

    const evidence = await service.smokeConnection('kiro', {
      confirmed: true,
    });

    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'kiro',
        provider: 'acp',
        modelId: undefined,
        metadata: { connectionId: 'kiro' },
      }),
    );
    expect(evidence).toMatchObject({
      level: 'smoke-passed',
      smoke: { status: 'passed', turnLimit: 1 },
    });
  });

  test('discards smoke evidence when the tested connection changes in flight', async () => {
    const acpConnections = [
      {
        id: 'kiro',
        name: 'Kiro',
        command: 'kiro-cli',
        enabled: true,
      },
    ];
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => []),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () => [],
      async () => structuredClone(acpConnections),
      () => ({ connections: [{ id: 'kiro', status: 'available' }] }),
      async () => ({}) as any,
      vi.fn(),
    );
    let completeSmoke!: () => void;
    service.setSmokeRunner(
      vi.fn(
        () =>
          new Promise<ConnectionSmokeRunResult>((resolve) => {
            completeSmoke = () => resolve({ ok: true, durationMs: 25 });
          }),
      ),
    );

    const pending = service.smokeConnection('kiro', { confirmed: true });
    await vi.waitFor(() => expect(completeSmoke).toBeTypeOf('function'));
    acpConnections[0].command = 'kiro-cli-v2';
    completeSmoke();

    await expect(pending).rejects.toThrow(
      'changed while its smoke was running',
    );
    expect(
      (await service.listRuntimeConnections())[0].readinessEvidence,
    ).toMatchObject({ smoke: { status: 'not-tested' } });
  });

  test('does not smoke a configured selector absent from the runtime catalog', async () => {
    const adapter = {
      provider: 'codex' as const,
      metadata: {
        displayName: 'Codex Runtime',
        description: 'Codex runtime',
        capabilities: ['agent-runtime'] as const,
        runtimeId: 'codex',
        builtin: true,
        executionClass: 'connected' as const,
        modelLaunch: {
          defaultAtStart: 'engine-selected' as const,
          omissionAtResume: 'engine-selected' as const,
          omissionPerTurn: 'engine-selected' as const,
          overrideAtStart: true,
          overrideAtResume: true,
          overridePerTurn: true,
        },
      },
      getPrerequisites: vi.fn().mockResolvedValue([]),
      listModels: vi.fn().mockResolvedValue([
        {
          id: 'catalog-only',
          name: 'Catalog only',
          originalId: 'catalog-only',
        },
      ]),
    };
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => []),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () => [adapter] as any,
      async () => [],
      () => ({ connections: [] }),
      async () => ({ defaultModel: 'configured-model' }) as any,
      vi.fn(),
    );
    const runner = vi.fn();
    service.setSmokeRunner(runner);

    const evidence = await service.smokeConnection('codex', {
      confirmed: true,
    });

    expect(runner).not.toHaveBeenCalled();
    expect(evidence).toMatchObject({
      smoke: {
        status: 'failed',
        reasonCode: 'unsupported-runtime',
        reason: 'The configured model is absent from the runtime catalog.',
      },
    });
  });

  test('does not publish configured models for an unregistered provider type', async () => {
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => [
          {
            id: 'forged',
            type: 'not-registered',
            name: 'Forged',
            enabled: true,
            capabilities: ['llm'],
            config: { defaultModel: 'forged-model' },
          },
        ]),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () => [],
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(),
    );

    const inventory = await service.listLaunchableModelInventory();

    expect(inventory.models).toEqual([]);
    expect(JSON.stringify(inventory)).not.toContain('forged-model');
  });

  test('unsubscribes launchability listeners when disposed', () => {
    const unsubscribe = vi.fn();
    const onLaunchabilityChange = vi.fn(() => unsubscribe);
    const runtimeAuthHealth = {
      getFailure: vi.fn(() => null),
      dispose: vi.fn(),
    };
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => []),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () => [],
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(),
      runtimeAuthHealth,
      undefined,
      [
        {
          getLaunchabilityRevision: () => 0,
          onLaunchabilityChange,
        },
      ],
    );

    service.dispose();
    service.dispose();

    expect(onLaunchabilityChange).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(runtimeAuthHealth.dispose).toHaveBeenCalledTimes(1);
  });

  function createCredentialProfileApplyFixture(
    smokeRunner: ReturnType<typeof vi.fn<ConnectionSmokeRunner>>,
    application:
      | 'hot_apply'
      | 'restart_resume'
      | 'unsupported' = 'restart_resume',
    protocol?: ReturnType<EventStore['createCredentialApplicationFactory']>,
  ) {
    let appConfig: any = {
      defaultModel: 'model-a',
      agentConnections: {
        codex: {
          credentialRecovery: {
            profiles: [
              { ref: 'profile-a', label: 'Primary account' },
              { ref: 'canary-profile-ref', label: 'Canary Account Label' },
              { ref: 'profile-c', label: 'Superseding account' },
            ],
            group: {
              profileRefs: ['profile-a', 'canary-profile-ref', 'profile-c'],
              enrolledProfileRefs: ['canary-profile-ref', 'profile-c'],
            },
            activeProfileRef: 'profile-a',
          },
        },
      },
    };
    const mutateAppConfig = vi.fn(async (mutate: any) => {
      appConfig = { ...appConfig, ...mutate(appConfig) };
      return appConfig;
    });
    const createService = protocol
      ? createConnectionServiceWithCredentialApplicationFactoryForTest.bind(
          undefined,
          protocol,
        )
      : createConnectionServiceForTest;
    const service = createService(
      {
        listProviderConnections: vi.fn(() => []),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () =>
        [
          {
            provider: 'codex',
            metadata: {
              displayName: 'Codex',
              description: 'Codex',
              capabilities: ['agent-runtime'],
              runtimeId: 'codex',
              recovery: { sameSession: true, application },
            },
          },
        ] as any,
      async () => [],
      () => ({ connections: [] }),
      async () => appConfig,
      vi.fn(),
      undefined,
      undefined,
      [],
      mutateAppConfig,
    );
    vi.spyOn(service, 'getConnection').mockResolvedValue({
      id: 'codex',
      kind: 'agent',
      type: 'codex',
      enabled: true,
      capabilities: ['agent-runtime'],
      config: { provider: 'codex', defaultModel: 'gpt-5-codex' },
    } as any);
    service.setSmokeRunner(smokeRunner);
    return {
      service,
      mutateAppConfig,
      getAppConfig: () => appConfig,
      supersedePending: () => {
        const recovery = appConfig.agentConnections.codex.credentialRecovery;
        appConfig = {
          ...appConfig,
          agentConnections: {
            ...appConfig.agentConnections,
            codex: {
              ...appConfig.agentConnections.codex,
              credentialRecovery: {
                ...recovery,
                pendingApplication: {
                  previousProfileRef: 'profile-a',
                  candidateProfileRef: 'profile-c',
                  attemptId: 'superseding-attempt',
                },
                outcome: 'staged',
              },
            },
          },
        };
      },
      adoptSuperseding: () => {
        const recovery = appConfig.agentConnections.codex.credentialRecovery;
        appConfig = {
          ...appConfig,
          agentConnections: {
            ...appConfig.agentConnections,
            codex: {
              ...appConfig.agentConnections.codex,
              credentialRecovery: {
                ...recovery,
                activeProfileRef: 'profile-c',
                pendingApplication: undefined,
                outcome: 'adopted',
              },
            },
          },
        };
      },
    };
  }

  test('manual credential application requires confirmation before staging or running a smoke', async () => {
    const smokeRunner = vi.fn<ConnectionSmokeRunner>();
    const { service, mutateAppConfig } =
      createCredentialProfileApplyFixture(smokeRunner);

    await expect(
      service.applyCredentialProfile('codex', 'canary-profile-ref', {
        confirmed: false,
      }),
    ).rejects.toThrow('Explicit confirmation is required');
    expect(mutateAppConfig).not.toHaveBeenCalled();
    expect(smokeRunner).not.toHaveBeenCalled();
  });

  test('automatic credential refusals emit exact bounded metrics without profile identity', async () => {
    const smokeRunner = vi.fn<ConnectionSmokeRunner>();
    const { service } = createCredentialProfileApplyFixture(smokeRunner);
    const metricAdd = vi.spyOn(credentialProfileApplication, 'add');
    try {
      await expect(
        service.stageAutomaticCredentialProfileApplication('codex', {
          kind: 'capacity',
          scope: 'account',
          timing: {},
        }),
      ).resolves.toBeUndefined();
      await expect(
        service.stageAutomaticCredentialProfileApplication('codex', {
          kind: 'capacity',
          scope: 'provider',
          timing: {},
        }),
      ).resolves.toBeUndefined();

      const calls = metricAdd.mock.calls;
      expect(calls).toEqual([
        [
          1,
          {
            source: 'recovery',
            capability: 'restart_resume',
            outcome: 'rejected',
            scope: 'account',
            reason: 'automatic_disabled',
          },
        ],
        [
          1,
          {
            source: 'recovery',
            capability: 'restart_resume',
            outcome: 'rejected',
            scope: 'provider',
            reason: 'ineligible_scope',
          },
        ],
      ]);
      const metrics = JSON.stringify(calls);
      expect(metrics).not.toContain('canary-profile-ref');
      expect(metrics).not.toContain('Canary Account Label');
      expect(metrics).not.toContain('/private/station');
      expect(metrics).not.toContain('"provider":');
    } finally {
      metricAdd.mockRestore();
    }
  });

  test('returns a frozen credential application capability without durable identity', async () => {
    const { service } = createCredentialProfileApplyFixture(
      vi.fn<ConnectionSmokeRunner>(),
    );
    await service.setCredentialRecoveryAutomaticPolicy('codex', true);

    const adapter = service.createCredentialProfileRecoveryAdapter(
      (provider) => (provider === 'codex' ? 'codex' : undefined),
    );
    const staged = await adapter.stage({
      provider: 'codex',
      failure: { kind: 'capacity', scope: 'account', timing: {} },
      recoveryFingerprint: 'opaque-recovery-attempt',
    });

    expect(staged.kind).toBe('staged');
    if (staged.kind !== 'staged') throw new Error('expected staged attempt');
    expect(Object.isFrozen(staged.attempt)).toBe(true);
    expect(staged.attempt).not.toHaveProperty('attemptId');
    expect(staged.attempt).not.toHaveProperty('connectionId');
    expect(typeof staged.attempt.commit).toBe('function');
    expect(typeof staged.attempt.rollback).toBe('function');
  });

  test('startup imports legacy credential evidence before routes can overwrite config', async () => {
    const { service, getAppConfig } = createCredentialProfileApplyFixture(
      vi.fn<ConnectionSmokeRunner>(),
    );
    const recovery = getAppConfig().agentConnections.codex.credentialRecovery;
    recovery.pendingApplication = {
      previousProfileRef: 'profile-a',
      candidateProfileRef: 'canary-profile-ref',
      attemptId: 'legacy-startup-attempt',
    };

    await service.migrateLegacyCredentialApplicationsAtStartup();

    expect(
      getAppConfig().agentConnections.codex.credentialRecovery,
    ).not.toHaveProperty('pendingApplication');
    await expect(service.getCredentialRecovery('codex')).resolves.toMatchObject(
      {
        application: { outcome: 'staged' },
      },
    );
  });

  test('startup retains legacy evidence when the real private ledger cannot admit every row', async () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'credential-legacy-conflict-'),
    );
    const store = new EventStore(join(directory, 'orchestration.sqlite'));
    try {
      const protocol = store.createCredentialApplicationFactory();
      for (let index = 0; index < 64; index += 1) {
        expect(
          protocol.start({
            recoveryFingerprint: `capacity-${index}`,
            connectionId: `connection-${index}`,
            candidateProfileRef: 'candidate',
            now: '2026-08-13T00:00:00.000Z',
          }),
        ).toMatchObject({ kind: 'owner' });
      }
      const { service, getAppConfig } = createCredentialProfileApplyFixture(
        vi.fn<ConnectionSmokeRunner>(),
        'restart_resume',
        protocol,
      );
      getAppConfig().agentConnections.codex.credentialRecovery.pendingApplication =
        {
          previousProfileRef: 'profile-a',
          candidateProfileRef: 'canary-profile-ref',
          attemptId: 'legacy-capacity-conflict',
        };

      await expect(
        service.migrateLegacyCredentialApplicationsAtStartup(),
      ).rejects.toThrow(
        "Credential recovery migration for 'codex' is incomplete.",
      );

      expect(
        getAppConfig().agentConnections.codex.credentialRecovery,
      ).toHaveProperty('pendingApplication');
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('refuses to enable automatic credential recovery when the adapter is unsupported', async () => {
    const { service, mutateAppConfig } = createCredentialProfileApplyFixture(
      vi.fn<ConnectionSmokeRunner>(),
      'unsupported',
    );

    await expect(
      service.setCredentialRecoveryAutomaticPolicy('codex', true),
    ).rejects.toThrow('Automatic credential recovery is unsupported');
    expect(mutateAppConfig).not.toHaveBeenCalled();
  });

  test('rejects unimplemented hot-apply recovery before it can stage a profile', async () => {
    const { service, mutateAppConfig, getAppConfig } =
      createCredentialProfileApplyFixture(
        vi.fn<ConnectionSmokeRunner>(),
        'hot_apply',
      );
    await service.setCredentialRecoveryAutomaticPolicy('codex', true);
    mutateAppConfig.mockClear();

    await expect(
      service.stageAutomaticCredentialProfileApplication('codex', {
        kind: 'capacity',
        scope: 'account',
        timing: {},
      }),
    ).resolves.toBeUndefined();

    expect(mutateAppConfig).not.toHaveBeenCalled();
    expect(
      getAppConfig().agentConnections.codex.credentialRecovery,
    ).not.toHaveProperty('pendingApplication');
  });

  test('manual credential smoke commits only after success and emits bounded, opaque metrics', async () => {
    const smokeRunner = vi.fn<ConnectionSmokeRunner>(async () => ({
      ok: true,
      durationMs: 1,
    }));
    const { service } = createCredentialProfileApplyFixture(smokeRunner);
    const metricAdd = vi.spyOn(credentialProfileApplication, 'add');
    try {
      const applied = await service.applyCredentialProfile(
        'codex',
        'canary-profile-ref',
        { confirmed: true, timeoutMs: 20_000 },
      );

      expect(applied).toEqual({
        capability: 'restart_resume',
        activeProfileRef: 'canary-profile-ref',
        outcome: 'adopted',
      });
      expect(smokeRunner).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: 'codex',
          provider: 'codex',
          modelId: 'gpt-5-codex',
          credentialProfileRef: 'canary-profile-ref',
          timeoutMs: 20_000,
        }),
      );
      const calls = metricAdd.mock.calls;
      expect(calls).toEqual([
        [
          1,
          {
            source: 'manual',
            capability: 'restart_resume',
            outcome: 'staged',
            scope: 'not_applicable',
            reason: 'requested',
          },
        ],
        [
          1,
          {
            source: 'manual',
            capability: 'restart_resume',
            outcome: 'adopted',
            scope: 'not_applicable',
            reason: 'requested',
          },
        ],
      ]);
      const metrics = JSON.stringify(calls);
      expect(metrics).not.toContain('canary-profile-ref');
      expect(metrics).not.toContain('Canary Account Label');
      expect(metrics).not.toContain('/private/station');
      expect(metrics).not.toContain('"provider":');
    } finally {
      metricAdd.mockRestore();
    }
  });

  test('manual credential smoke failures and throws roll back to the previous active credential profile', async () => {
    for (const smokeRunner of [
      vi.fn<ConnectionSmokeRunner>(async () => ({
        ok: false,
        durationMs: 1,
        reasonCode: 'turn-failed',
        reason: 'canary profile smoke returned a failing turn',
        action: 'Check the canary profile credentials and retry.',
      })),
      vi.fn<ConnectionSmokeRunner>(async () => {
        throw new Error('canary profile smoke failed');
      }),
    ]) {
      const { service } = createCredentialProfileApplyFixture(smokeRunner);
      const applied = await service.applyCredentialProfile(
        'codex',
        'canary-profile-ref',
        { confirmed: true },
      );

      expect(applied).toEqual({
        capability: 'restart_resume',
        activeProfileRef: 'profile-a',
        outcome: 'rolled_back',
      });
    }
  });

  test('legacy config receipts cannot supersede a private application claim', async () => {
    const smokeRunner = vi.fn<ConnectionSmokeRunner>(async () => ({
      ok: true,
      durationMs: 1,
    }));
    const fixture = createCredentialProfileApplyFixture(smokeRunner);
    smokeRunner.mockImplementationOnce(async () => {
      fixture.supersedePending();
      return { ok: true, durationMs: 1 };
    });

    await expect(
      fixture.service.applyCredentialProfile('codex', 'canary-profile-ref', {
        confirmed: true,
      }),
    ).resolves.toMatchObject({
      activeProfileRef: 'canary-profile-ref',
      outcome: 'adopted',
    });
    expect(fixture.getAppConfig().agentConnections.codex).toMatchObject({
      credentialRecovery: {
        activeProfileRef: 'canary-profile-ref',
      },
    });
    expect(
      fixture.getAppConfig().agentConnections.codex.credentialRecovery
        .pendingApplication,
    ).toBeUndefined();
  });

  test('legacy config adoption cannot report a different private application outcome', async () => {
    const smokeRunner = vi.fn<ConnectionSmokeRunner>(async () => ({
      ok: true,
      durationMs: 1,
    }));
    const fixture = createCredentialProfileApplyFixture(smokeRunner);
    smokeRunner.mockImplementationOnce(async () => {
      fixture.adoptSuperseding();
      return { ok: true, durationMs: 1 };
    });

    await expect(
      fixture.service.applyCredentialProfile('codex', 'canary-profile-ref', {
        confirmed: true,
      }),
    ).resolves.toMatchObject({
      activeProfileRef: 'canary-profile-ref',
      outcome: 'adopted',
    });
    expect(
      fixture.getAppConfig().agentConnections.codex.credentialRecovery,
    ).toMatchObject({
      activeProfileRef: 'canary-profile-ref',
    });
  });

  test('persists profile stage/terminal transitions atomically without exposing labels in application results', async () => {
    let appConfig: any = {
      defaultModel: 'model-a',
      agentConnections: {
        codex: {
          credentialRecovery: {
            profiles: [
              { ref: 'profile-a', label: 'Account A' },
              { ref: 'profile-b', label: 'Account B' },
            ],
            group: {
              profileRefs: ['profile-a', 'profile-b'],
              enrolledProfileRefs: ['profile-b'],
            },
            activeProfileRef: 'profile-a',
          },
        },
      },
    };
    const mutateAppConfig = vi.fn(async (mutate: any) => {
      appConfig = { ...appConfig, ...mutate(appConfig) };
      return appConfig;
    });
    const service = createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => []),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(),
      } as any,
      () =>
        [
          {
            provider: 'codex',
            metadata: {
              displayName: 'Codex',
              description: 'Codex',
              capabilities: ['agent-runtime'],
              runtimeId: 'codex',
              recovery: { sameSession: true, application: 'restart_resume' },
            },
          },
        ] as any,
      async () => [],
      () => ({ connections: [] }),
      async () => appConfig,
      vi.fn(),
      undefined,
      undefined,
      [],
      mutateAppConfig,
    );

    const staged = await service.stageCredentialProfileApplication('codex', {
      candidateProfileRef: 'profile-b',
      attemptId: 'attempt-1',
    });
    expect(staged).toEqual({
      capability: 'restart_resume',
      activeProfileRef: 'profile-a',
      pendingProfileRef: 'profile-b',
      outcome: 'staged',
    });
    expect(JSON.stringify(staged)).not.toContain('Account');
    expect(mutateAppConfig).not.toHaveBeenCalled();

    // A full unrelated config edit races this durable stage in real callers.
    // It cannot erase or forge the private ledger claim.
    await mutateAppConfig((current: any) => ({
      ...current,
      region: 'us-west-2',
    }));

    const stale = await service.commitCredentialProfileApplication(
      'codex',
      'attempt-stale',
    );
    expect(stale).toMatchObject({
      activeProfileRef: 'profile-a',
      pendingProfileRef: 'profile-b',
      outcome: 'staged',
    });
    const committed = await service.commitCredentialProfileApplication(
      'codex',
      'attempt-1',
    );
    expect(committed).toEqual({
      capability: 'restart_resume',
      activeProfileRef: 'profile-b',
      outcome: 'adopted',
    });
    expect(appConfig.region).toBe('us-west-2');
  });

  test('refuses profile deletion while a private application obligation references it', async () => {
    const smokeRunner = vi.fn<ConnectionSmokeRunner>(async () => ({
      ok: true,
      durationMs: 1,
    }));
    const fixture = createCredentialProfileApplyFixture(smokeRunner);
    await fixture.service.stageCredentialProfileApplication('codex', {
      candidateProfileRef: 'canary-profile-ref',
      attemptId: 'delete-fence',
    });
    await expect(
      fixture.service.deleteCredentialProfile('codex', 'canary-profile-ref'),
    ).rejects.toThrow('referenced by an unresolved application');
  });

  test('releases an exact private reservation when another process deleted its candidate', async () => {
    const fixture = createCredentialProfileApplyFixture(
      vi.fn<ConnectionSmokeRunner>(),
    );
    vi.spyOn(fixture.service, 'getCredentialRecovery').mockResolvedValue({
      application: {
        capability: 'restart_resume',
        activeProfileRef: 'profile-a',
        outcome: 'rejected',
      },
      profiles: [],
      group: { profileRefs: [], enrolledProfileRefs: [] },
      policy: { automatic: false },
    });
    vi.spyOn(
      fixture.service as any,
      'readCredentialRecoveryState',
    ).mockResolvedValue({
      profiles: [{ ref: 'profile-a', label: 'Primary' }],
      activeProfileRef: 'profile-a',
    });

    await expect(
      fixture.service.stageCredentialProfileApplication('codex', {
        attemptId: 'deleted-candidate',
        candidateProfileRef: 'canary-profile-ref',
      }),
    ).resolves.toMatchObject({ outcome: 'rejected' });
  });

  test('serializes a profile delete behind an in-flight stage for the same connection', async () => {
    const fixture = createCredentialProfileApplyFixture(
      vi.fn<ConnectionSmokeRunner>(),
    );
    let releaseRecovery!: (
      value: Awaited<ReturnType<typeof fixture.service.getCredentialRecovery>>,
    ) => void;
    const recovery = new Promise<
      Awaited<ReturnType<typeof fixture.service.getCredentialRecovery>>
    >((resolve) => {
      releaseRecovery = resolve;
    });
    const read = vi
      .spyOn(fixture.service, 'getCredentialRecovery')
      .mockImplementationOnce(() => recovery);

    const staging = fixture.service.stageCredentialProfileApplication('codex', {
      attemptId: 'serialized-stage',
      candidateProfileRef: 'canary-profile-ref',
    });
    await Promise.resolve();
    let deleteSettled = false;
    const deleting = fixture.service
      .deleteCredentialProfile('codex', 'profile-c')
      .finally(() => {
        deleteSettled = true;
      });
    await Promise.resolve();
    expect(deleteSettled).toBe(false);

    releaseRecovery({
      application: {
        capability: 'restart_resume',
        activeProfileRef: 'profile-a',
        outcome: 'rejected',
      },
      profiles: [],
      group: { profileRefs: [], enrolledProfileRefs: [] },
      policy: { automatic: true },
    });
    await expect(staging).resolves.toMatchObject({ outcome: 'staged' });
    await expect(deleting).resolves.toMatchObject({
      application: { activeProfileRef: 'profile-a' },
    });
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('ConnectionService — model inventory membership (station#3747)', () => {
  function providerServiceWith(connections: any[]) {
    return {
      listProviderConnections: vi.fn(() => connections),
      saveProviderConnection: vi.fn(),
      deleteProviderConnection: vi.fn(),
      checkHealth: vi.fn(async () => true),
    } as any;
  }

  function serviceWith(connections: any[]) {
    return createConnectionServiceForTest(
      providerServiceWith(connections),
      () => [] as any,
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(async (updates: any) => updates),
    );
  }

  const vectorStore = {
    id: 'lancedb-builtin',
    type: 'lancedb',
    name: 'Built-in vector store',
    enabled: true,
    capabilities: ['vectordb'],
    config: {},
  };
  const llmConnection = {
    id: 'anthropic-1',
    type: 'anthropic',
    name: 'Anthropic',
    enabled: true,
    capabilities: ['llm'],
    config: {},
  };

  test('the model inventory holds only LLM-capable connections', async () => {
    const service = serviceWith([vectorStore, llmConnection]);

    const inventory = await service.listModelConnections();

    expect(inventory.map((connection) => connection.id)).toEqual([
      'anthropic-1',
    ]);
  });

  test('the full connection projection still carries the vector store', async () => {
    const service = serviceWith([vectorStore, llmConnection]);

    const all = await service.listConnections();

    // Knowledge reads vector stores through `/api/connections`, so removing
    // them from the model inventory must not remove them from Station.
    expect(all.map((connection) => connection.id)).toContain('lancedb-builtin');
  });
});

describe('ConnectionService — per-row inventory isolation (station#3748)', () => {
  function serviceWith(connections: any[]) {
    return createConnectionServiceForTest(
      {
        listProviderConnections: vi.fn(() => connections),
        saveProviderConnection: vi.fn(),
        deleteProviderConnection: vi.fn(),
        checkHealth: vi.fn(async () => true),
      } as any,
      () => [] as any,
      async () => [],
      () => ({ connections: [] }),
      async () => ({}) as any,
      vi.fn(async (updates: any) => updates),
    );
  }

  const healthy = {
    id: 'anthropic-1',
    type: 'anthropic',
    name: 'Anthropic',
    enabled: true,
    capabilities: ['llm'],
    config: {},
  };
  /** A persisted row whose `capabilities` is not a list — `toModelConnection`
   *  calls `.filter` on it and throws, which used to empty both routes. */
  const malformed = {
    id: 'broken-1',
    type: 'openai-compat',
    name: 'Broken Connection',
    enabled: true,
    capabilities: null,
    config: {},
  };

  test('one unreadable row costs itself, and says so by name', async () => {
    const service = serviceWith([malformed, healthy]);

    const inventory = await service.listModelConnectionInventory();

    expect(inventory.connections.map((connection) => connection.id)).toEqual([
      'anthropic-1',
    ]);
    expect(inventory.failures).toHaveLength(1);
    expect(inventory.failures[0]).toMatchObject({
      connectionId: 'broken-1',
      name: 'Broken Connection',
    });
    expect(inventory.failures[0]?.reason).toBeTruthy();
  });

  test('the agent inventory survives an unreadable model row and carries the reason', async () => {
    const service = serviceWith([malformed, healthy]);

    const inventory = await service.listRuntimeConnectionInventory();

    // The whole point: a bad MODEL row used to empty `/api/connections/agents`
    // too, and an empty engine list reads as "no engines configured".
    expect(inventory.failures.map((failure) => failure.connectionId)).toEqual([
      'broken-1',
    ]);
  });

  test('an inventory with no readable rows still reports the failure rather than an empty list', async () => {
    const service = serviceWith([malformed]);

    const inventory = await service.listModelConnectionInventory();

    expect(inventory.connections).toEqual([]);
    expect(inventory.failures).toHaveLength(1);
  });
});
