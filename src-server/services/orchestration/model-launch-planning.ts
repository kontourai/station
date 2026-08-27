import {
  MODEL_LAUNCH_PLAN_METADATA_KEY,
  MODEL_LAUNCH_REQUESTED_OVERRIDE_METADATA_KEY,
  MODEL_OVERRIDE_UNSUPPORTED_CODE,
  type ModelLaunchPlan,
  modelLaunchTelemetryAttributes,
  resolveModelLaunchPlan,
} from '@kontourai/station-contracts/provider';
import {
  getProviderAdapterRegistrationProvenance,
  type ProviderAdapterModelCatalog,
  type ProviderAdapterShape,
  type ProviderSessionStartInput,
} from '../../providers/adapter-shape.js';
import {
  MODEL_CATALOG_MAX_ENTRIES,
  MODEL_CATALOG_TEXT_MAX_LENGTH,
} from '../../providers/llm/model-catalog.js';
// IMPORTANT: the counter must be imported from this exact specifier — the
// orchestration test suite vi.mocks '../../telemetry/metrics.js' by resolved
// module id, and 10 assertions observe this counter through that mock. Do
// not inject it as a dep or re-route it through the service — the ledger's
// I4/I6 replays prove those assertions observe emissions from THIS module
// path (dropping an emission reds them), so a re-routed import would
// silently decouple the counter the assertions read from the one the code
// writes.
import { modelLaunchResolutionTotal } from '../../telemetry/metrics.js';
import {
  awaitSettlementWithin,
  raceWithSignal,
  throwIfAborted,
} from '../../utils/bounded-async.js';

const PROVIDER_MODEL_DISCOVERY_TIMEOUT_MS = 4_350;
const PROVIDER_MODEL_ABORT_SETTLEMENT_MS = 650;

function boundedAdapterModels(
  catalog: ProviderAdapterModelCatalog,
): ProviderAdapterModelCatalog['models'] {
  if (!catalog || !Array.isArray(catalog.models)) {
    throw new Error('Provider adapter returned an invalid model catalog.');
  }
  const models: ProviderAdapterModelCatalog['models'] = [];
  for (const model of catalog.models) {
    if (models.length === MODEL_CATALOG_MAX_ENTRIES) break;
    if (
      typeof model?.id !== 'string' ||
      model.id.length === 0 ||
      model.id.length > MODEL_CATALOG_TEXT_MAX_LENGTH ||
      typeof model.name !== 'string' ||
      model.name.length === 0 ||
      model.name.length > MODEL_CATALOG_TEXT_MAX_LENGTH ||
      typeof model.originalId !== 'string' ||
      model.originalId.length === 0 ||
      model.originalId.length > MODEL_CATALOG_TEXT_MAX_LENGTH
    ) {
      continue;
    }
    models.push(model);
  }
  return models;
}

export async function listLaunchableAdapterModels(
  adapter: ProviderAdapterShape,
  options?: { signal?: AbortSignal; operation?: 'discovery' | 'validation' },
): Promise<ProviderAdapterModelCatalog['models']> {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(options?.signal?.reason);
  if (options?.signal?.aborted) abortFromParent();
  else
    options?.signal?.addEventListener('abort', abortFromParent, {
      once: true,
    });
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(
          `${adapter.provider} model ${options?.operation ?? 'discovery'} timed out.`,
        ),
      ),
    PROVIDER_MODEL_DISCOVERY_TIMEOUT_MS,
  );
  try {
    throwIfAborted(controller.signal);
    // station#1430 review, H-2 enumeration: every caller of this helper
    // (`getProviderModels` — the model picker, and the CLI-model
    // launch/turn selector validators) projects the result down to
    // `{id, name, originalId}` (`boundedAdapterModels`,
    // `ProviderAdapterModelCatalog['models']`) — no capability field
    // survives to any of them. Skip enrichment unconditionally so this
    // shared discovery/validation path never pays for `/api/show` work it
    // structurally cannot use, on session launch and picker open alike.
    const pending = adapter.listModelCatalog
      ? adapter.listModelCatalog({
          signal: controller.signal,
          maxEntries: MODEL_CATALOG_MAX_ENTRIES,
          skipCapabilityEnrichment: true,
        })
      : adapter.listModels
        ? adapter
            .listModels({
              signal: controller.signal,
              maxEntries: MODEL_CATALOG_MAX_ENTRIES,
            })
            .then((models) => ({ models }))
        : Promise.resolve({ models: [] });
    try {
      return boundedAdapterModels(
        await raceWithSignal(pending, controller.signal),
      );
    } catch (error) {
      if (
        controller.signal.aborted &&
        getProviderAdapterRegistrationProvenance(adapter) === 'builtin' &&
        adapter.metadata.abortSettlement === 'await'
      ) {
        try {
          await awaitSettlementWithin(
            pending,
            PROVIDER_MODEL_ABORT_SETTLEMENT_MS,
          );
        } catch {
          // Preserve the deadline or caller-cancellation error after cleanup.
        }
      }
      throw error;
    }
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener('abort', abortFromParent);
  }
}

/**
 * Projects an external engine's hand-curated `knownModels` metadata
 * (station#977) into the same catalog shape as a live/cached adapter
 * catalog, so callers can treat both uniformly. `originalId` mirrors `id`
 * — these are the canonical short ids the engine accepts directly, not a
 * live catalog's dated wire-format ids.
 */
export function knownModelsCatalog(
  adapter: ProviderAdapterShape,
): ProviderAdapterModelCatalog['models'] {
  return (adapter.metadata.knownModels ?? []).map((model) => ({
    id: model.id,
    name: model.name,
    originalId: model.id,
  }));
}

/** A stable shared-dispatch error for a capability-unavailable model change. */
export class ModelLaunchPlanUnavailableError extends Error {
  readonly code = MODEL_OVERRIDE_UNSUPPORTED_CODE;

  constructor(readonly reason: string) {
    super(`${MODEL_OVERRIDE_UNSUPPORTED_CODE}: ${reason}`);
  }
}

/** Blank selectors are omission, never an override that suppresses retention. */
export function normalizeOmittedModelId<T extends { modelId?: string }>(
  input: T,
): T {
  if (typeof input.modelId !== 'string' || input.modelId.trim() !== '') {
    return input;
  }
  const { modelId: _omitted, ...rest } = input;
  return rest as T;
}

export interface ModelLaunchPlanningDeps {
  /** The C7 read model's retained selector, for a resume that named none. */
  loadedSessionModel(threadId: string): string | undefined;
}

/**
 * Model launch plan & selector validation (epic #4024 slice 8, #4179): the
 * C13 cluster from the seam map — the epic's strictest one-way seam: the
 * cluster calls NO service method and reads exactly one read-model cell
 * through its single named dep. Zero external callers (map §5b). The C12
 * sendTurn arm's inline metadata stamp is deliberately NOT unified here —
 * it is dispatch-spine logic with a different `requestedOverride`
 * derivation. `assertAcceptedModelLaunchPlan`'s unavailable-arm counter is
 * un-guarded while `recordAcceptedModelLaunchPlan`'s accepted-arm counter
 * swallows — the asymmetry is deliberate (telemetry is an observer of an
 * authoritative acceptance; an unavailable rejection has no receipt to
 * protect).
 */
export class ModelLaunchPlanning {
  constructor(private readonly deps: ModelLaunchPlanningDeps) {}

  async validateConnectedCliModelSelector(
    adapter: ProviderAdapterShape,
    input: ProviderSessionStartInput,
  ): Promise<ProviderSessionStartInput> {
    if (adapter.provider !== 'claude' && adapter.provider !== 'codex') {
      return input;
    }
    // station#977 ("local default + defer to engine"): no explicit
    // selector falls back to the adapter's own default model, rather than
    // unconditionally requiring one — external engines like Claude Code
    // have a sensible engine-native default even when Station hasn't been
    // told a model.
    const requested = (
      input.modelId?.trim() ||
      adapter.metadata.defaultModel ||
      ''
    ).trim();
    if (!requested) {
      // station#1154: an external engine with no local default (e.g. codex,
      // which deliberately carries no `metadata.defaultModel` — there is no
      // verifiable one to hardcode) is not an error case. #977's whole
      // premise is defer-to-engine: pass the input through unchanged (no
      // modelId) and let the engine fall back to its own built-in default,
      // exactly as it does when launched with no --model at all.
      return input;
    }
    const liveModels = await listLaunchableAdapterModels(adapter, {
      operation: 'validation',
    });
    // Fall back to the adapter's hand-curated known-models list when the
    // live/cached catalog is empty (a common steady state — see #977's
    // problem statement) instead of treating an empty catalog as "nothing
    // is launchable".
    const catalog = liveModels.length
      ? liveModels
      : knownModelsCatalog(adapter);
    const match = catalog.find((model) => model.id === requested);
    if (!match) {
      // Defer to the engine rather than rejecting: Station's catalog (live
      // or known) is advisory for external engines, not authoritative —
      // pass the explicit/default selector through and let the engine
      // itself validate it.
      return { ...input, modelId: requested };
    }
    return { ...input, modelId: match.originalId };
  }

  async validateConnectedCliTurnModelSelector<
    T extends {
      modelId?: string;
    },
  >(adapter: ProviderAdapterShape, input: T): Promise<T> {
    if (
      (adapter.provider !== 'claude' && adapter.provider !== 'codex') ||
      input.modelId === undefined
    ) {
      return input;
    }
    // station#977: mirror validateConnectedCliModelSelector's default
    // fallback + defer-to-engine-on-miss behavior for a turn-level override.
    const requested = (
      input.modelId.trim() ||
      adapter.metadata.defaultModel ||
      ''
    ).trim();
    if (!requested) {
      // station#1154: mirror validateConnectedCliModelSelector's
      // pass-through — an explicit-but-blank turn override with no local
      // default is not an error for an external engine; defer to it.
      return input;
    }
    const liveModels = await listLaunchableAdapterModels(adapter, {
      operation: 'validation',
    });
    const catalog = liveModels.length
      ? liveModels
      : knownModelsCatalog(adapter);
    const match = catalog.find((model) => model.id === requested);
    if (!match) {
      return { ...input, modelId: requested };
    }
    return { ...input, modelId: match.originalId };
  }

  /**
   * The only model-capability gate before adapter invocation. The accepted
   * plan is stamped server-side, preventing a client from forging an applied
   * receipt. Exact catalog validation remains in Station-engine adapters.
   */
  withAcceptedModelLaunchPlan(
    adapter: ProviderAdapterShape,
    input: ProviderSessionStartInput,
    lifecycle: 'start' | 'resume',
    retainedModelId?: string,
  ): ProviderSessionStartInput {
    const normalizedInput = normalizeOmittedModelId(input);
    const acceptedRetainedModelId =
      retainedModelId ??
      (lifecycle === 'resume'
        ? this.deps.loadedSessionModel(input.threadId)
        : undefined);
    const plan = this.assertAcceptedModelLaunchPlan(
      adapter,
      normalizedInput.modelId,
      lifecycle,
      acceptedRetainedModelId,
    );
    const resumedModelId =
      normalizedInput.modelId === undefined && lifecycle === 'resume'
        ? plan.kind === 'station-resolved'
          ? plan.modelId
          : plan.kind === 'engine-selected' &&
              plan.evidence === 'adapter-retained'
            ? acceptedRetainedModelId?.trim()
            : undefined
        : undefined;
    return {
      ...normalizedInput,
      // A retained selector is not a caller override, but a newly-created
      // adapter session still needs it on recovery/resume. Station-resolved
      // plans validate it against their catalog; adapter-retained plans pass
      // it back to the adapter that originally accepted it.
      ...(resumedModelId ? { modelId: resumedModelId } : {}),
      metadata: {
        ...normalizedInput.metadata,
        [MODEL_LAUNCH_PLAN_METADATA_KEY]: plan,
        [MODEL_LAUNCH_REQUESTED_OVERRIDE_METADATA_KEY]:
          typeof normalizedInput.modelId === 'string' &&
          normalizedInput.modelId.trim() !== '',
      },
    };
  }

  assertAcceptedModelLaunchPlan(
    adapter: ProviderAdapterShape,
    modelId: string | undefined,
    lifecycle: 'start' | 'resume' | 'turn',
    retainedModelId?: string,
  ): ModelLaunchPlan {
    const requestedOverride =
      typeof modelId === 'string' && modelId.trim() !== '';
    const plan = resolveModelLaunchPlan(adapter.metadata.modelLaunch, {
      lifecycle,
      requestedModelId: modelId,
      retainedModelId,
    });
    if (plan.kind === 'unavailable') {
      modelLaunchResolutionTotal.add(
        1,
        modelLaunchTelemetryAttributes(
          adapter.provider,
          lifecycle,
          requestedOverride,
          plan,
        ),
      );
      throw new ModelLaunchPlanUnavailableError(plan.reason);
    }
    return plan;
  }

  recordAcceptedModelLaunchPlan(
    adapter: ProviderAdapterShape,
    plan: ModelLaunchPlan,
    lifecycle: 'start' | 'resume' | 'turn',
    requestedOverride: boolean,
  ): void {
    try {
      modelLaunchResolutionTotal.add(
        1,
        modelLaunchTelemetryAttributes(
          adapter.provider,
          lifecycle,
          requestedOverride,
          plan,
        ),
      );
    } catch {
      // Provider acceptance and its durable client-turn claim are
      // authoritative; telemetry is an observer and cannot overturn them.
    }
  }

  modelLaunchPlanFromInput(input: ProviderSessionStartInput): ModelLaunchPlan {
    const plan = input.metadata?.[MODEL_LAUNCH_PLAN_METADATA_KEY];
    if (!plan || typeof plan !== 'object' || !('kind' in plan)) {
      throw new Error('Model launch plan was not attached before dispatch.');
    }
    return plan as ModelLaunchPlan;
  }

  modelLaunchRequestedOverrideFromInput(
    input: ProviderSessionStartInput,
  ): boolean {
    return (
      input.metadata?.[MODEL_LAUNCH_REQUESTED_OVERRIDE_METADATA_KEY] === true
    );
  }
}
