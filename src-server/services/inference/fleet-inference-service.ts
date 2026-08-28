/**
 * archive#1398 — the serving half of fleet inference
 * (`docs/design/inference-fleet.md` §3.2 Option A, §11 slice 2).
 *
 * Station B serves an authenticated completion against a connection its
 * operator marked as contributed. The alternative the design rejected —
 * handing the consumer B's upstream `baseUrl` — is less code and wrong: it
 * gives A a raw, unauthenticated, unrevocable path to B's backend, produces
 * no serve-side record, leaks B's network topology, and degenerates into
 * shipping a credential when the contributed connection is a hosted provider.
 *
 * What this module is NOT, stated because it is the thing to conflate: it is
 * not `delegate_task`. A delegated task runs on this machine with this
 * machine's agents, tools, credentials, and workspace, and persists in this
 * machine's event store. Fleet inference keeps the agent loop, the tools, the
 * files, and the event record on the CONSUMER; only token generation happens
 * here. Concretely, this module never constructs a session, never passes
 * `tools` to the provider, never touches the filesystem, and returns text.
 *
 * Three rules govern every path below:
 *
 * 1. **The contributed subset is the only allowlist.** Reachability is
 *    decided by slice 1's `station.fleet-contribution/v1` projection, never
 *    by the launchable inventory directly — a model this Station can launch
 *    but has not contributed is exactly as unreachable as one that does not
 *    exist, and is refused with the same code so the difference is not an
 *    enumeration oracle (§5.2 rule 2).
 * 2. **No silent no.** Every rejection is a named
 *    {@link FleetInferenceRefusal} carrying the Station's participation
 *    state. §4.5 bans the silent-degradation shape the reference mesh's
 *    stale-status filter has.
 * 3. **Bounded in every dimension.** Prompt size, message count, output
 *    tokens, accumulated response, and concurrency, all from
 *    {@link FLEET_INFERENCE_LIMITS}. §12 records that serving-side
 *    concurrency is unmeasured; small ceilings are how that is held honestly
 *    rather than discovered when the owner's own work stalls.
 */

import type {
  FleetContributedModel,
  FleetContributionDiagnostic,
  FleetContributionManifest,
} from '@kontourai/station-contracts/fleet-contribution';
import { FLEET_CONTRIBUTION_DIAGNOSTIC_ID } from '@kontourai/station-contracts/fleet-contribution';
import type {
  FleetInferenceCompletionRequest,
  FleetInferenceCompletionResponse,
  FleetInferenceMessage,
  FleetInferenceRefusal,
  FleetInferenceRefusalCode,
  FleetInferenceStopReason,
} from '@kontourai/station-contracts/fleet-inference';
import {
  FLEET_INFERENCE_COMPLETION_SCHEMA_VERSION,
  FLEET_INFERENCE_LIMITS,
  FLEET_INFERENCE_REFUSAL_SCHEMA_VERSION,
} from '@kontourai/station-contracts/fleet-inference';
import type {
  ConnectionConfig,
  ProviderConnectionConfig,
} from '@kontourai/station-contracts/tool';
import { createLLMProvider } from '../../providers/connection-factories.js';
import type {
  ILLMProvider,
  LLMMessage,
} from '../../providers/llm/model-provider-types.js';
import {
  fleetInferenceCompletionTotal,
  fleetInferenceGeneratedCharacters,
  fleetInferenceLatency,
} from '../../telemetry/metrics.js';

const VALID_ROLES = new Set(['system', 'user', 'assistant']);
const PROVIDER_CAPABILITIES = new Set(['llm', 'embedding', 'vectordb']);

export interface FleetInferenceServiceDeps {
  /** Slice 1's contributed-subset projection — the only allowlist. */
  getFleetContributionManifest(): Promise<FleetContributionManifest>;
  getConnection(id: string): Promise<ConnectionConfig | null>;
  /** Injectable so tests never construct a real provider or dial a model. */
  createProvider?: (
    connection: ProviderConnectionConfig,
  ) => ILLMProvider | null;
  now?: () => Date;
}

export type FleetInferenceOutcome =
  | { kind: 'completed'; response: FleetInferenceCompletionResponse }
  | { kind: 'refused'; refusal: FleetInferenceRefusal };

/**
 * Truncates a diagnostic message from the local vocabulary for the machine
 * boundary — §4.2's open half, decided in this slice.
 *
 * The question was whether a peer-rendered manifest should show another
 * Station's message text verbatim, normalize it to the code, or bound it.
 * Decided: **bound it, and keep the code authoritative.** Dropping the text
 * loses the exact wording an operator already recognizes from their own
 * Connections surface, which is most of its value when two people are
 * debugging one fleet. Passing it verbatim lets a remote Station decide how
 * many bytes this response costs and hands the consumer's renderer an
 * unbounded foreign string. The code is a closed enum a consumer can branch
 * on; the message is supporting prose it should render as prose.
 */
function boundMessage(message: string): string {
  const limit = FLEET_INFERENCE_LIMITS.maxDiagnosticMessageCharacters;
  if (message.length <= limit) return message;
  return `${message.slice(0, limit - 1)}…`;
}

/**
 * The manifest as it crosses the machine boundary: same projection, bounded.
 * Truncation is itself reported through the existing `inventory-truncated`
 * vocabulary rather than by a shorter list, because a shorter list is the
 * silent degradation §4.5 bans.
 */
export function boundFleetContributionManifest(
  manifest: FleetContributionManifest,
): FleetContributionManifest {
  const modelsOverflow =
    manifest.models.length > FLEET_INFERENCE_LIMITS.maxManifestModels;
  const models = modelsOverflow
    ? manifest.models.slice(0, FLEET_INFERENCE_LIMITS.maxManifestModels)
    : manifest.models;

  const carried = manifest.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    message: boundMessage(diagnostic.message),
  }));

  // The models-truncation notice is held OUT of the list being trimmed, not
  // appended to it. Appended, it sat at the end and was the first thing the
  // diagnostics-overflow trim below sliced off — so a Station contributing
  // both too many models and too many diagnostics reported the diagnostics
  // truncation and silently dropped the notice that its model list was
  // short too, which is precisely the shorter-list-with-no-reason failure
  // this function exists to prevent.
  const overflowNotices: FleetContributionDiagnostic[] = [];
  if (modelsOverflow) {
    overflowNotices.push({
      connectionId: FLEET_CONTRIBUTION_DIAGNOSTIC_ID,
      code: 'inventory-truncated',
      message: `This Station contributes more models than one manifest response carries (${FLEET_INFERENCE_LIMITS.maxManifestModels}); the list is incomplete for that reason alone.`,
    });
  }

  const budget =
    FLEET_INFERENCE_LIMITS.maxManifestDiagnostics - overflowNotices.length;
  const diagnosticsOverflow = carried.length > budget;
  const diagnostics = diagnosticsOverflow
    ? [
        ...carried.slice(0, budget - 1),
        {
          connectionId: FLEET_CONTRIBUTION_DIAGNOSTIC_ID,
          code: 'inventory-truncated' as const,
          message: `This Station reported more diagnostics than one manifest response carries (${FLEET_INFERENCE_LIMITS.maxManifestDiagnostics}); some are omitted.`,
        },
        ...overflowNotices,
      ]
    : [...carried, ...overflowNotices];

  return { ...manifest, models, diagnostics };
}

interface ValidatedRequest {
  model: string;
  messages: FleetInferenceMessage[];
  maxOutputTokens: number;
  temperature?: number;
}

type ValidationResult =
  | { ok: true; value: ValidatedRequest }
  | { ok: false; code: FleetInferenceRefusalCode; message: string };

/**
 * Structural validation, separated from execution so the refusal taxonomy is
 * testable without a provider. Every rejection names the field: a peer
 * debugging a fleet across two machines cannot read this Station's logs.
 */
export function validateFleetCompletionRequest(
  body: unknown,
): ValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return {
      ok: false,
      code: 'request-invalid',
      message: 'A fleet completion request must be a JSON object.',
    };
  }
  const candidate = body as Partial<FleetInferenceCompletionRequest>;

  if (candidate.stream === true) {
    return {
      ok: false,
      code: 'streaming-unsupported',
      message:
        'This Station serves buffered fleet completions only. Streaming is specified but not yet enabled; omit `stream` to receive the whole completion at once.',
    };
  }
  if (candidate.stream !== undefined && typeof candidate.stream !== 'boolean') {
    return {
      ok: false,
      code: 'request-invalid',
      message: '`stream` must be a boolean when present.',
    };
  }

  if (typeof candidate.model !== 'string' || candidate.model.length === 0) {
    return {
      ok: false,
      code: 'request-invalid',
      message:
        '`model` must be the id of a contributed model, as published by GET /api/inference/manifest.',
    };
  }

  if (!Array.isArray(candidate.messages) || candidate.messages.length === 0) {
    return {
      ok: false,
      code: 'request-invalid',
      message: '`messages` must be a non-empty array.',
    };
  }
  if (candidate.messages.length > FLEET_INFERENCE_LIMITS.maxMessages) {
    return {
      ok: false,
      code: 'request-too-large',
      message: `A fleet completion request carries at most ${FLEET_INFERENCE_LIMITS.maxMessages} messages.`,
    };
  }

  let promptCharacters = 0;
  const messages: FleetInferenceMessage[] = [];
  for (const message of candidate.messages) {
    if (typeof message !== 'object' || message === null) {
      return {
        ok: false,
        code: 'request-invalid',
        message: 'Every entry in `messages` must be an object.',
      };
    }
    const { role, content } = message as Partial<FleetInferenceMessage>;
    if (typeof role !== 'string' || !VALID_ROLES.has(role)) {
      return {
        ok: false,
        code: 'request-invalid',
        message:
          'Every message `role` must be one of system, user, or assistant. Fleet inference serves completions only — there is no tool role.',
      };
    }
    if (typeof content !== 'string') {
      return {
        ok: false,
        code: 'request-invalid',
        message: 'Every message `content` must be a string.',
      };
    }
    promptCharacters += content.length;
    messages.push({ role: role as FleetInferenceMessage['role'], content });
  }
  if (promptCharacters > FLEET_INFERENCE_LIMITS.maxPromptCharacters) {
    return {
      ok: false,
      code: 'request-too-large',
      message: `A fleet completion prompt carries at most ${FLEET_INFERENCE_LIMITS.maxPromptCharacters} characters across all messages.`,
    };
  }

  if (candidate.temperature !== undefined) {
    if (
      typeof candidate.temperature !== 'number' ||
      !Number.isFinite(candidate.temperature) ||
      candidate.temperature < 0 ||
      candidate.temperature > 2
    ) {
      return {
        ok: false,
        code: 'request-invalid',
        message: '`temperature` must be a finite number between 0 and 2.',
      };
    }
  }

  // A caller may ask for fewer output tokens than the ceiling but never more:
  // clamping silently would let a consumer believe it bounded a cost it did
  // not, so an out-of-range value is refused and an in-range one is honored.
  let maxOutputTokens: number = FLEET_INFERENCE_LIMITS.maxOutputTokens;
  if (candidate.maxOutputTokens !== undefined) {
    if (
      typeof candidate.maxOutputTokens !== 'number' ||
      !Number.isInteger(candidate.maxOutputTokens) ||
      candidate.maxOutputTokens < 1
    ) {
      return {
        ok: false,
        code: 'request-invalid',
        message: '`maxOutputTokens` must be a positive integer.',
      };
    }
    if (candidate.maxOutputTokens > FLEET_INFERENCE_LIMITS.maxOutputTokens) {
      return {
        ok: false,
        code: 'request-too-large',
        message: `This Station serves at most ${FLEET_INFERENCE_LIMITS.maxOutputTokens} output tokens per fleet completion.`,
      };
    }
    maxOutputTokens = candidate.maxOutputTokens;
  }

  return {
    ok: true,
    value: {
      model: candidate.model,
      messages,
      maxOutputTokens,
      ...(candidate.temperature === undefined
        ? {}
        : { temperature: candidate.temperature }),
    },
  };
}

export class FleetInferenceService {
  #deps: FleetInferenceServiceDeps;
  #inFlight = 0;

  constructor(deps: FleetInferenceServiceDeps) {
    this.#deps = deps;
  }

  /** Completions currently executing — exposed for the route's own bound. */
  get inFlight(): number {
    return this.#inFlight;
  }

  async readManifest(): Promise<FleetContributionManifest> {
    return boundFleetContributionManifest(
      await this.#deps.getFleetContributionManifest(),
    );
  }

  #now(): Date {
    return this.#deps.now?.() ?? new Date();
  }

  #refuse(
    code: FleetInferenceRefusalCode,
    message: string,
    participation?: FleetContributionManifest['participation'],
  ): FleetInferenceOutcome {
    fleetInferenceCompletionTotal.add(1, { outcome: 'refused', code });
    return {
      kind: 'refused',
      refusal: {
        schemaVersion: FLEET_INFERENCE_REFUSAL_SCHEMA_VERSION,
        code,
        message,
        ...(participation === undefined ? {} : { participation }),
        refusedAt: this.#now().toISOString(),
      },
    };
  }

  /**
   * Resolves, admits, and runs one completion. Returns a refusal rather than
   * throwing for every expected no, so the route has exactly one shape to
   * serialize and no path can answer with a bare status.
   */
  async complete(
    body: unknown,
    options: { signal?: AbortSignal } = {},
  ): Promise<FleetInferenceOutcome> {
    const validated = validateFleetCompletionRequest(body);
    if (!validated.ok) {
      return this.#refuse(validated.code, validated.message);
    }

    // Admission control comes FIRST, before the manifest projection and the
    // provider construction. Both of those are real work — the projection can
    // trigger a bounded model-inventory refresh with a multi-second deadline —
    // and doing them for a request that was always going to be refused lets a
    // saturated Station be pushed further under by the very requests it is
    // refusing. The check is re-read (not cached) after the slot is taken
    // below, so this ordering trades no correctness for the saving.
    //
    // It costs one thing, and the honest resolution is to pay it uniformly:
    // this refusal carries no `participation`, because the projection that
    // would tell us has deliberately not run. Rather than let one
    // `capacity-exhausted` carry the field and the other omit it — which
    // would make its absence read as a fact about contribution rather than
    // about ordering — the post-admission check below omits it too. A
    // consumer reading this code must not have to know which of two
    // identical codes it received.
    if (this.#inFlight >= FLEET_INFERENCE_LIMITS.maxConcurrentCompletions) {
      return this.#refuse(
        'capacity-exhausted',
        `This Station serves at most ${FLEET_INFERENCE_LIMITS.maxConcurrentCompletions} fleet completions at a time and is currently at that limit. Retry shortly.`,
      );
    }

    let manifest: FleetContributionManifest;
    try {
      manifest = await this.#deps.getFleetContributionManifest();
    } catch {
      return this.#refuse(
        'contribution-unavailable',
        'This Station could not determine what it currently contributes, so it will not serve a completion it cannot attribute to a contributed model.',
      );
    }

    if (manifest.participation === 'disabled') {
      return this.#refuse(
        'contribution-disabled',
        'Fleet contribution is turned off on this Station. No model is offered to the fleet.',
        manifest.participation,
      );
    }
    if (manifest.participation === 'nothing-contributed') {
      return this.#refuse(
        'contribution-disabled',
        'Fleet contribution is turned on for this Station, but no model connection is marked as contributed.',
        manifest.participation,
      );
    }
    if (manifest.participation === 'contributed-unavailable') {
      return this.#refuse(
        'contribution-unavailable',
        'This Station has contributed connections but none currently yields a launchable model. Read GET /api/inference/manifest for the per-connection reason.',
        manifest.participation,
      );
    }

    // Exact-id match against the contributed subset only. A provider-native
    // id, an alias, or a launchable-but-not-contributed model deliberately
    // lands in the same refusal as a nonexistent one.
    const model = manifest.models.find(
      (candidate) => candidate.id === validated.value.model,
    );
    if (!model) {
      return this.#refuse(
        'model-not-contributed',
        'That model is not contributed by this Station. Read GET /api/inference/manifest for the models it offers.',
        manifest.participation,
      );
    }
    if (model.availability !== 'available') {
      return this.#refuse(
        'model-unavailable',
        `This Station contributes '${model.displayName}' but its current availability is '${model.availability}', so it is not routable right now.`,
        manifest.participation,
      );
    }

    const provider = await this.#resolveProvider(model);
    if (!provider) {
      return this.#refuse(
        'model-unavailable',
        `This Station contributes '${model.displayName}' but can no longer construct a provider for its connection.`,
        manifest.participation,
      );
    }

    // Re-checked after the awaits above: the pre-admission check happened
    // before the manifest read, and slots can fill during it. `participation`
    // is deliberately omitted even though it IS known here — see the
    // pre-admission check's note: one refusal code must not have two shapes.
    if (this.#inFlight >= FLEET_INFERENCE_LIMITS.maxConcurrentCompletions) {
      return this.#refuse(
        'capacity-exhausted',
        `This Station serves at most ${FLEET_INFERENCE_LIMITS.maxConcurrentCompletions} fleet completions at a time and is currently at that limit. Retry shortly.`,
      );
    }

    this.#inFlight += 1;
    const startedAt = Date.now();
    // Two independent reasons to stop, unified into one signal the provider
    // stream actually honors: the caller went away, or this Station's own
    // deadline elapsed. Which one fired decides the refusal, so they are
    // tracked separately rather than inferred from a generic abort.
    const deadline = new AbortController();
    let deadlineFired = false;
    const timer = setTimeout(() => {
      deadlineFired = true;
      deadline.abort();
    }, FLEET_INFERENCE_LIMITS.completionDeadlineMs);
    const onCallerAbort = () => deadline.abort();
    options.signal?.addEventListener('abort', onCallerAbort, { once: true });
    try {
      if (options.signal?.aborted) deadline.abort();
      const generated = await this.#generate(
        provider,
        model,
        validated.value,
        deadline.signal,
      );
      if (deadlineFired) {
        return this.#refuse(
          'completion-timeout',
          `This Station stopped generating after ${Math.round(FLEET_INFERENCE_LIMITS.completionDeadlineMs / 1000)} seconds. Nothing partial is returned — retry with a smaller request.`,
          manifest.participation,
        );
      }
      if (options.signal?.aborted) {
        return this.#refuse(
          'request-abandoned',
          'The caller disconnected before this completion finished, so it was abandoned.',
          manifest.participation,
        );
      }
      const elapsedMs = Date.now() - startedAt;
      fleetInferenceCompletionTotal.add(1, {
        outcome: 'completed',
        stop: generated.stop,
      });
      fleetInferenceGeneratedCharacters.record(generated.content.length);
      fleetInferenceLatency.record(elapsedMs);
      return {
        kind: 'completed',
        response: {
          schemaVersion: FLEET_INFERENCE_COMPLETION_SCHEMA_VERSION,
          delivery: 'buffered',
          model: {
            id: model.id,
            connectionId: model.connectionId,
            providerModel: model.providerModel,
            displayName: model.displayName,
          },
          servedAt: this.#now().toISOString(),
          content: generated.content,
          stop: generated.stop,
          finishReason: generated.finishReason,
          usage: generated.usage,
          elapsedMs,
        },
      };
    } catch {
      // A provider that throws ON abort is the common case, so the two
      // stop reasons are checked before the generic failure — otherwise
      // every timeout and every disconnect would be reported as a provider
      // fault, which would de-rank a healthy peer in slice 3's router.
      if (deadlineFired) {
        return this.#refuse(
          'completion-timeout',
          `This Station stopped generating after ${Math.round(FLEET_INFERENCE_LIMITS.completionDeadlineMs / 1000)} seconds. Nothing partial is returned — retry with a smaller request.`,
          manifest.participation,
        );
      }
      if (options.signal?.aborted) {
        return this.#refuse(
          'request-abandoned',
          'The caller disconnected before this completion finished, so it was abandoned.',
          manifest.participation,
        );
      }
      // The upstream error text is deliberately not relayed: it can name a
      // host, a path, a region, or an account, and this response crosses a
      // machine boundary (§4.2 carries no base URLs or filesystem paths).
      return this.#refuse(
        'execution-failed',
        'This Station accepted the request but its local provider failed while generating. The serving Station has the details.',
        manifest.participation,
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onCallerAbort);
      this.#inFlight -= 1;
    }
  }

  async #resolveProvider(
    model: FleetContributedModel,
  ): Promise<ILLMProvider | null> {
    let connection: ConnectionConfig | null;
    try {
      connection = await this.#deps.getConnection(model.connectionId);
    } catch {
      return null;
    }
    if (connection?.kind !== 'model' || !connection.enabled) {
      return null;
    }
    const providerConnection: ProviderConnectionConfig = {
      id: connection.id,
      type: connection.type,
      name: connection.name,
      config: connection.config,
      enabled: connection.enabled,
      capabilities: connection.capabilities.filter(
        (capability): capability is 'llm' | 'embedding' | 'vectordb' =>
          PROVIDER_CAPABILITIES.has(capability),
      ),
    };
    const factory = this.#deps.createProvider ?? createLLMProvider;
    return factory(providerConnection);
  }

  /**
   * Drives the provider stream and accumulates text. No `tools` is passed —
   * that is the mechanism by which "no tool execution" is true rather than a
   * claim — and any non-text chunk is ignored rather than acted on, so a
   * provider that emits a tool call regardless cannot cause one to run here.
   *
   * **The deadline and the abort signal are COOPERATIVE, and the difference
   * matters.** `deadline.abort()` fires the signal the provider was handed;
   * it does not cancel the async generator. A provider that observes the
   * signal settles, this loop exits, `complete()`'s `finally` runs, and the
   * concurrency slot is freed — that is every in-tree adapter
   * (`src-server/providers/llm/**` all pass the signal to their SDK). A
   * provider that ACCEPTS the signal and never observes it never settles:
   * this `for await` stays suspended, `finally` never runs, and **the slot
   * is not freed** — the leak the deadline was added to prevent, just moved
   * behind a worse-behaved adapter. Two such connections would pin the cap
   * permanently, exactly as before.
   *
   * Not defended against, and the reason is bounded reachability rather than
   * difficulty: reaching it requires an operator to install a plugin-supplied
   * provider that ignores abort AND mark its connection as contributed. No
   * in-tree provider does this. Closing it properly means racing the
   * iteration against the deadline and abandoning the generator — real work
   * with its own leak (an abandoned generator still holds its socket), so it
   * is recorded in §12 rather than half-done here.
   */
  async #generate(
    provider: ILLMProvider,
    model: FleetContributedModel,
    request: ValidatedRequest,
    signal?: AbortSignal,
  ): Promise<{
    content: string;
    stop: FleetInferenceStopReason;
    finishReason: string | null;
    usage: FleetInferenceCompletionResponse['usage'];
  }> {
    const messages: LLMMessage[] = request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));

    let content = '';
    let stop: FleetInferenceStopReason = 'provider';
    let finishReason: string | null = null;
    let usage: FleetInferenceCompletionResponse['usage'] = null;
    let failure: string | undefined;

    for await (const chunk of provider.createStream({
      model: model.providerModel,
      messages,
      maxTokens: request.maxOutputTokens,
      ...(request.temperature === undefined
        ? {}
        : { temperature: request.temperature }),
      ...(signal ? { signal } : {}),
    })) {
      if (chunk.type === 'error') {
        failure = chunk.error ?? 'provider stream error';
        break;
      }
      if (chunk.type === 'finish') {
        finishReason = chunk.finishReason ?? null;
        // archive#4197: `LLMStreamChunk.usage` fields are individually
        // optional (absence is a real state — the producer never invents
        // zeros), while `FleetInferenceUsage` requires BOTH figures. A
        // partial report therefore stays `null` on the wire — "the
        // provider reported no usage", the contract's own words — rather
        // than becoming a half-invented pair.
        if (
          chunk.usage &&
          chunk.usage.inputTokens !== undefined &&
          chunk.usage.outputTokens !== undefined
        ) {
          usage = {
            inputTokens: chunk.usage.inputTokens,
            outputTokens: chunk.usage.outputTokens,
          };
        }
        continue;
      }
      if (chunk.type !== 'text-delta' || !chunk.content) continue;
      // Past the ceiling: keep draining so the provider's own `finish` chunk
      // still lands, but accumulate nothing more. Breaking out here instead
      // meant EVERY response-bound completion reported `finishReason: null`
      // and `usage: null` — the two fields a consumer needs most when it has
      // just been told the answer was cut off, and exactly the case where
      // "the provider reported nothing" would be a lie. The drain is bounded
      // by `completionDeadlineMs` and by the caller's abort signal — but see
      // `#generate`'s docblock: that bound is COOPERATIVE. A provider that
      // never finishes and never observes its signal keeps this loop
      // suspended here, exactly as it would have on the pre-drain path.
      if (stop === 'response-bound') continue;

      const remaining =
        FLEET_INFERENCE_LIMITS.maxCompletionCharacters - content.length;
      // `>` not `>=`: a delta that exactly fills the remaining budget is a
      // complete delta, not a truncated one. With `>=`, a completion whose
      // last chunk landed exactly on the ceiling reported `response-bound`
      // and lost its terminal accounting despite nothing being cut.
      if (chunk.content.length > remaining) {
        content += chunk.content.slice(0, remaining);
        stop = 'response-bound';
        continue;
      }
      content += chunk.content;
    }

    if (failure !== undefined) {
      throw new Error(failure);
    }
    return { content, stop, finishReason, usage };
  }
}
