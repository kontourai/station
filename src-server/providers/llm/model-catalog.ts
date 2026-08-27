import type { ModelInventoryFreshness } from '@kontourai/station-contracts/model-inventory';
import { awaitSettlementWithin } from '../../utils/bounded-async.js';
import {
  DEFAULT_MODEL_CATALOG_MAX_ENTRIES,
  DEFAULT_MODEL_CATALOG_MAX_RESPONSE_BYTES,
  ModelCatalogShapeError,
  providerHttpErrorStatus,
} from '../registries/catalog-http.js';
import type {
  ILLMProvider,
  LLMModel,
  LLMModelCatalog,
} from './model-provider-types.js';

/**
 * The hard outer budget `withCatalogTimeout` races every `listModelCatalog`
 * call against. Exported (station#1430 review, H-1) so a provider adapter
 * that does its own internal, sub-catalog work with its own timing budget
 * (e.g. `OllamaLLMProvider`'s `/api/show` enrichment) can DERIVE its budget
 * from this constant instead of picking an independent number that can
 * silently drift out of a safe relationship with it — blowing this outer
 * race doesn't degrade gracefully, it resolves the race with `null` and
 * discards the ENTIRE catalog (see `safeListModelCatalog` below), not just
 * whatever sub-work overran.
 */
export const MODEL_CATALOG_TIMEOUT_MS = 1500;
const MODEL_CATALOG_ABORT_SETTLEMENT_MS = 650;

export interface SafeModelCatalog {
  source: ModelInventoryFreshness | 'unavailable';
  models: LLMModel[];
  truncated?: boolean;
  /**
   * The provider's OWN answer to why discovery did not succeed, when it gave
   * one. Deliberately absent for a timeout or an abort: those are Station
   * giving up, not the provider refusing, and a consumer that records a
   * refusal must not record one for a slow but healthy provider (station
   * RT-06 review H2). Carried, never logged — a transport message can echo a
   * credential-bearing header, so any consumer that shows it redacts first.
   */
  reason?: string;
  /** See `LLMModelCatalog.reasonKind`. */
  reasonKind?: 'refused' | 'no-catalog' | 'unreachable';
}

export const MODEL_CATALOG_MAX_ENTRIES = DEFAULT_MODEL_CATALOG_MAX_ENTRIES;
export const MODEL_CATALOG_TEXT_MAX_LENGTH = 512;

function boundedModels(models: LLMModel[]): {
  models: LLMModel[];
  truncated: boolean;
} {
  const bounded: LLMModel[] = [];
  for (const model of models) {
    if (
      typeof model.id !== 'string' ||
      model.id.length === 0 ||
      model.id.length > MODEL_CATALOG_TEXT_MAX_LENGTH ||
      typeof model.name !== 'string' ||
      model.name.length === 0 ||
      model.name.length > MODEL_CATALOG_TEXT_MAX_LENGTH
    ) {
      continue;
    }
    if (bounded.length === MODEL_CATALOG_MAX_ENTRIES) {
      return { models: bounded, truncated: true };
    }
    bounded.push(model);
  }
  return { models: bounded, truncated: false };
}

type CatalogFailure = {
  reason?: string;
  reasonKind?: SafeModelCatalog['reasonKind'];
};

function failureFields(failure: CatalogFailure): CatalogFailure {
  return {
    ...(failure.reason ? { reason: failure.reason } : {}),
    ...(failure.reasonKind ? { reasonKind: failure.reasonKind } : {}),
  };
}

function unavailableCatalog(
  configuredModels: LLMModel[],
  failure: CatalogFailure = {},
): SafeModelCatalog {
  const { models, truncated } = boundedModels(configuredModels);
  // The reason rides along even when configured selectors stand in for a
  // catalog: those models are the operator's own text, not a provider
  // response, so a consumer deciding "did the provider answer" must still see
  // that it did not.
  return models.length > 0
    ? {
        source: 'configured',
        models,
        ...(truncated ? { truncated: true } : {}),
        ...failureFields(failure),
      }
    : { source: 'unavailable', models: [], ...failureFields(failure) };
}

function fallbackCatalog(
  provider: ILLMProvider | null,
  configuredModels: LLMModel[],
  failure: CatalogFailure = {},
): SafeModelCatalog {
  return provider?.configuredModelFallback === 'deny'
    ? { source: 'unavailable', models: [], ...failureFields(failure) }
    : unavailableCatalog(configuredModels, failure);
}

/**
 * Which of the three answers a thrown catalog error represents.
 *
 * A catalog route that 404s is not a broken connection — plenty of
 * OpenAI-compatible servers serve chat and no `/models` at all — while a 401
 * is exactly a broken connection. Reading that off the typed error rather
 * than off the message keeps the distinction structural.
 */
export function classifyCatalogFailure(
  error: unknown,
): NonNullable<SafeModelCatalog['reasonKind']> {
  const status = providerHttpErrorStatus(error);
  if (status !== undefined) {
    return status === 404 || status === 405 || status === 501
      ? 'no-catalog'
      : 'refused';
  }
  if (error instanceof ModelCatalogShapeError) return 'no-catalog';
  return 'unreachable';
}

async function withCatalogTimeout(
  operation: (signal: AbortSignal) => Promise<LLMModelCatalog>,
  timeoutMs: number,
  parentSignal?: AbortSignal,
  awaitAbortSettlement = false,
): Promise<LLMModelCatalog | null> {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error('Model catalog discovery timed out.')),
    timeoutMs,
  );
  try {
    if (controller.signal.aborted) return null;
    const pending = operation(controller.signal);
    const result = await Promise.race([
      pending,
      new Promise<null>((resolve) => {
        controller.signal.addEventListener('abort', () => resolve(null), {
          once: true,
        });
      }),
    ]);
    if (result === null && awaitAbortSettlement) {
      try {
        await awaitSettlementWithin(pending, MODEL_CATALOG_ABORT_SETTLEMENT_MS);
      } catch {
        // Cancellation is represented by the null result after cleanup settles.
      }
    }
    return result;
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abort);
  }
}

export async function safeListModelCatalog(
  provider: ILLMProvider | null,
  configuredModels: LLMModel[] = [],
  timeoutMs: number = MODEL_CATALOG_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<SafeModelCatalog> {
  if (!provider) return unavailableCatalog(configuredModels);

  try {
    const catalog = await withCatalogTimeout(
      (operationSignal) =>
        provider.listModelCatalog
          ? provider.listModelCatalog({
              signal: operationSignal,
              maxEntries: MODEL_CATALOG_MAX_ENTRIES,
              maxResponseBytes: DEFAULT_MODEL_CATALOG_MAX_RESPONSE_BYTES,
            })
          : provider
              .listModels({
                signal: operationSignal,
                maxEntries: MODEL_CATALOG_MAX_ENTRIES,
                maxResponseBytes: DEFAULT_MODEL_CATALOG_MAX_RESPONSE_BYTES,
              })
              .then((models) => ({ source: 'live' as const, models })),
      timeoutMs,
      signal,
      provider.abortSettlement === 'await',
    );
    if (!catalog || catalog.source === 'unavailable') {
      // `catalog === null` is the timeout/abort path — Station gave up, so
      // there is no provider answer to report and no refusal to record.
      return fallbackCatalog(provider, configuredModels, {
        ...(catalog?.reason ? { reason: catalog.reason } : {}),
        ...(catalog?.reasonKind ? { reasonKind: catalog.reasonKind } : {}),
      });
    }
    const bounded = boundedModels(catalog.models);
    return {
      ...catalog,
      models: bounded.models,
      ...(catalog.truncated || bounded.truncated ? { truncated: true } : {}),
    };
  } catch (error) {
    // A provider that throws (Ollama's daemon is down, a DNS failure) HAS
    // answered in the only way it can. An abort is not that: the caller's own
    // cancellation must not be recorded against the provider.
    if (
      signal?.aborted ||
      (error as { name?: string })?.name === 'AbortError' ||
      !(error instanceof Error)
    ) {
      return fallbackCatalog(provider, configuredModels);
    }
    return fallbackCatalog(provider, configuredModels, {
      reason: error.message,
      reasonKind: classifyCatalogFailure(error),
    });
  }
}

export async function safeListModels(
  provider: ILLMProvider | null,
  timeoutMs: number = MODEL_CATALOG_TIMEOUT_MS,
): Promise<LLMModel[]> {
  return (await safeListModelCatalog(provider, [], timeoutMs)).models;
}

/**
 * Whether `requestedModel` is launchable, and under which exact selector.
 *
 * station#3653: for SOME providers an empty catalogue is not an enumeration.
 * An adapter that declares `emptyCatalogMeaning: 'no-catalog'` is saying its
 * zero-row answer carries no statement about which models the endpoint
 * serves — and for those, Station's OTHER derivation of "usable" already
 * reads it that way: `probeModelConnection` treats
 * `source === 'live' && models.length > 0` as the only catalogue that proves
 * anything, and routes an empty answer to the one-token chat probe against
 * the connection's configured `defaultModel`. So such a connection could pass
 * Test Connection on a real chat turn with that model and still be refused
 * HERE, which is what left the Station engine logging "Default agent not
 * registered because no launchable model is configured" beside a connection
 * reading Ready. Two derivations of one fact, disagreeing.
 *
 * The tie is broken toward the configured selector only when BOTH hold: the
 * catalogue enumerated nothing, AND the adapter declared that its empty
 * enumeration is not authoritative.
 *
 * Review HIGH-1: the first version of this fix checked only emptiness, which
 * silently extended the exception to every provider. Anthropic's adapter pins
 * the opposite contract — a successful empty catalogue is `{source:'live',
 * models: []}`, deliberately distinct from `source:'unavailable'` — and
 * `recordModelCatalogDiscovery` records a live-empty list as an answer that
 * "established no model and no chat endpoint". Under the unconditional
 * version, an account whose last model entitlement is revoked would converge
 * to `[]` and Station would keep launching the stale configured selector,
 * report Ready off that registration, and fail on the first real turn. The
 * declaration keeps the exception where an adapter has actually earned it.
 *
 * `configuredModelFallback: 'deny'` (Bedrock, whose catalogue is
 * authoritative) is honoured exactly as `safeListModelCatalog`'s own fallback
 * honours it — this is the same substitution rule, reached one branch later.
 *
 * Deliberately NOT gated on a passed check receipt. `resolveManagedModelIdentity`
 * records why: "a receipt is a claim about the past, and the delivery attempt
 * performs its own authoritative request." Requiring one would simply move the
 * disagreement — a never-tested connection with a correct default model would
 * become unlaunchable — and the delivery attempt still fails loudly (and
 * specifically: a 404 there is classified as "this model is not on this
 * endpoint") if the operator's selector is wrong.
 */
export async function resolveExactModelSelector(
  provider: ILLMProvider | null,
  requestedModel: string,
  configuredModels: LLMModel[] = [],
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<string> {
  const requested = requestedModel.trim();
  if (!requested) {
    throw new Error('A model selector is required.');
  }

  const catalog = await safeListModelCatalog(
    provider,
    configuredModels,
    options?.timeoutMs,
    options?.signal,
  );
  const match = catalog.models.find((model) => model.id === requested);
  if (match) return match.id;

  // A live catalogue speaks for itself unless its own adapter says it cannot.
  const enumerationIsAuthoritative =
    catalog.source === 'live' && provider?.emptyCatalogMeaning !== 'no-catalog';
  if (
    catalog.models.length === 0 &&
    !enumerationIsAuthoritative &&
    provider?.configuredModelFallback !== 'deny'
  ) {
    // Bounded on the same terms `unavailableCatalog` bounds them on, so the
    // stand-in path cannot admit a selector the fallback catalogue itself
    // would have dropped.
    const configured = boundedModels(configuredModels).models.find(
      (model) => model.id === requested,
    );
    if (configured) return configured.id;
  }

  throw new Error(
    `Model selector '${requested}' is not launchable for this provider.`,
  );
}
