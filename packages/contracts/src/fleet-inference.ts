/**
 * Station#1398 slice 2 — the wire contract for the authenticated fleet
 * inference surface (`docs/design/inference-fleet.md` §3.2, §3.3, §10 OQ-1,
 * §10 OQ-8, §11 slice 2).
 *
 * This is Station's **first inference-serving surface** (§2.6: it has never
 * been one), and §3.2 requires it to be treated as a genuine new attack
 * surface rather than a convenience endpoint. Four properties are part of the
 * contract, not implementation detail:
 *
 * 1. **Completions only. It is not `delegate_task`.** Delegating a task to
 *    another Station already exists and has a different trust story — the
 *    work runs there, with that machine's agents, credentials, and workspace,
 *    and persists in its event store
 *    (`docs/guides/machine-relationships.md`). Fleet inference is the
 *    opposite: the agent loop, tools, files, and event record stay on the
 *    *consumer*; only token generation happens here. There is deliberately no
 *    `tools` field, no session id, no filesystem path, and no agent slug
 *    anywhere in {@link FleetInferenceCompletionRequest} — the absence IS the
 *    contract, so adding one is a visible contract change rather than an
 *    additive convenience.
 * 2. **A non-contributed model is refused by name, never 404'd.** Silence is
 *    the degraded state §4.5 bans. Every rejection carries a
 *    {@link FleetInferenceRefusalCode} and a sentence
 *    ({@link FleetInferenceRefusal}).
 * 3. **Every dimension is bounded** ({@link FLEET_INFERENCE_LIMITS}) —
 *    request bytes, message count, prompt size, output tokens, response size,
 *    and concurrency. §12 records that serving-side performance and
 *    concurrency are unmeasured; bounded-by-default is how that gap is held
 *    honestly rather than discovered under load.
 * 4. **Specified for streaming from day one, buffered in v1** (§10 OQ-8). A
 *    Dispatch-routed turn does not stream today, so v1 covers non-interactive
 *    work where buffering is acceptable — but retrofitting streaming onto a
 *    serve route is expensive, so the response carries a
 *    {@link FleetInferenceDelivery} discriminant from the start. See
 *    {@link FleetInferenceCompletionResponse} for exactly what a streaming
 *    v1.x adds without breaking a buffered consumer.
 *
 * Authorization lives outside this file: the whole `/api/inference/**` family
 * requires the `inference:invoke` pairing scope
 * (`src-server/security/pairing-route-scopes.ts`), which no preset except
 * `inference` grants and which the default grant deliberately withholds
 * (`environment-security.ts`).
 */

import type {
  FleetContributionManifest,
  FleetContributionParticipation,
} from './fleet-contribution.js';

export const FLEET_INFERENCE_COMPLETION_SCHEMA_VERSION =
  'station.fleet-inference-completion/v1' as const;

export const FLEET_INFERENCE_REFUSAL_SCHEMA_VERSION =
  'station.fleet-inference-refusal/v1' as const;

/** The route family every fleet-inference endpoint lives under (§3.3). */
export const FLEET_INFERENCE_ROUTE_PREFIX = '/api/inference' as const;

/**
 * The serving Station's self-imposed ceilings. Published on the contract
 * rather than buried in the handler so a consumer can size a request instead
 * of discovering a limit as a failure, and so a later change to any of them
 * is a visible contract change.
 *
 * These are a *serving* Station's protection of its own machine, not a
 * quality knob: §3.2 accepts an inference-serving surface only on the
 * condition that it is bounded, and §12 records that nobody has measured what
 * happens when a peer's local model is already busy with the peer's own work.
 * `maxConcurrentCompletions` is deliberately small for that reason —
 * over-admitting turns a borrowed GPU into a denial of the owner's own work.
 */
export const FLEET_INFERENCE_LIMITS = {
  /** Request body ceiling before the body is even parsed. */
  maxRequestBytes: 128 * 1024,
  /** Messages in one completion request. */
  maxMessages: 64,
  /** Total characters across every message's content. */
  maxPromptCharacters: 96_000,
  /** Characters of generated text the route will accumulate and return. */
  maxCompletionCharacters: 64_000,
  /** Ceiling applied to a caller's `maxOutputTokens`, and the default. */
  maxOutputTokens: 4_096,
  /** Completions this Station will execute for the fleet at one time. */
  maxConcurrentCompletions: 2,
  /**
   * Wall-clock ceiling on one completion, after which the stream is aborted
   * and the concurrency slot is freed.
   *
   * Without it, `maxConcurrentCompletions` bounds nothing that matters: a
   * provider that accepts a request and then never yields (a hung Ollama
   * process, a TCP connection to a machine that went away, a hosted endpoint
   * that stalls mid-stream) holds its slot forever, and two such requests
   * pin the whole fleet surface permanently — a denial of service that costs
   * a peer two requests and needs no credential beyond `inference:invoke`.
   * A concurrency cap is only a bound if every occupant is guaranteed to
   * leave.
   *
   * 120s is chosen to sit well above a legitimate slow local generation at
   * this route's output ceiling (4,096 tokens on consumer hardware) and well
   * below any human's patience for a hung request. It is deliberately not
   * caller-tunable: it protects the SERVING machine, so a consumer must not
   * be able to raise it.
   *
   * **Cooperative, not preemptive.** It fires the `AbortSignal` the provider
   * was handed. A provider that observes the signal settles and frees its
   * slot; one that accepts the signal and ignores it never settles, and its
   * slot is NOT freed. Every in-tree provider observes it; see
   * `fleet-inference-service.ts`'s `#generate` docblock and
   * `docs/design/inference-fleet.md` §12 for the residual.
   */
  completionDeadlineMs: 120_000,
  /**
   * §4.2's open half, decided here: a peer-rendered manifest shows ANOTHER
   * Station's diagnostic strings, so the serving boundary bounds them. The
   * closed `code` stays the authoritative fact; the message is supporting
   * text, truncated rather than dropped so the local wording an operator
   * would recognize survives.
   */
  maxDiagnosticMessageCharacters: 240,
  /** Diagnostics carried across the machine boundary in one manifest. */
  maxManifestDiagnostics: 64,
  /** Contributed models carried across the machine boundary in one manifest. */
  maxManifestModels: 128,
} as const;

/** Roles a fleet completion request may carry. No `tool` role: v1 has no tools. */
export type FleetInferenceRole = 'system' | 'user' | 'assistant';

export interface FleetInferenceMessage {
  role: FleetInferenceRole;
  content: string;
}

/**
 * `POST /api/inference/completions`.
 *
 * `model` is the contributed model's manifest id — `FleetContributedModel.id`
 * in `fleet-contribution.ts`, described there as "the join key slice 2's
 * serve route addresses". It is matched exactly and only against the
 * contributed subset: a provider-native id, an alias, or the id of a model
 * this Station can launch but has not contributed all resolve to
 * `model-not-contributed`.
 */
export interface FleetInferenceCompletionRequest {
  model: string;
  messages: FleetInferenceMessage[];
  /** Clamped to {@link FLEET_INFERENCE_LIMITS.maxOutputTokens}. */
  maxOutputTokens?: number;
  temperature?: number;
  /**
   * Reserved (§10 OQ-8). v1 refuses `true` with `streaming-unsupported`
   * rather than silently buffering, because a consumer that asked for a
   * stream and received one buffered response has been told something untrue
   * about the path it is routing over — and slice 3's receipt records
   * "whether the path could stream" as a fact.
   */
  stream?: boolean;
}

/**
 * How the completion was delivered. The v1 route always answers `buffered`.
 *
 * This field is the reason enabling interactive chat later is a *client*
 * change rather than a route redesign (§10 OQ-8): a streaming v1.x responds
 * to `stream: true` with an event stream whose terminal event is exactly a
 * {@link FleetInferenceCompletionResponse} carrying `delivery: 'stream'` and
 * the same fields, with `content` holding the concatenation of the deltas
 * already sent. A buffered consumer that never sets `stream` observes no
 * change at all, and a consumer that branches on `delivery` is correct in
 * both worlds.
 */
export type FleetInferenceDelivery = 'buffered' | 'stream';

/**
 * Why generation stopped. Separated from the provider's own `finishReason`
 * on purpose: "the model stopped" and "this Station's own ceiling stopped it"
 * are different facts to a consumer deciding whether to retry, and collapsing
 * them into one string is how a truncated answer reads as a complete one.
 */
export type FleetInferenceStopReason =
  /** The provider ended the generation itself. */
  | 'provider'
  /** {@link FLEET_INFERENCE_LIMITS.maxCompletionCharacters} was reached. */
  | 'response-bound';

export interface FleetInferenceUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Identity of the model that actually served, echoed from the manifest. */
export interface FleetInferenceServedModel {
  id: string;
  connectionId: string;
  providerModel: string;
  displayName: string;
}

export interface FleetInferenceCompletionResponse {
  schemaVersion: typeof FLEET_INFERENCE_COMPLETION_SCHEMA_VERSION;
  delivery: FleetInferenceDelivery;
  model: FleetInferenceServedModel;
  /** Wall-clock time the serving Station finished this completion. */
  servedAt: string;
  content: string;
  stop: FleetInferenceStopReason;
  /** The provider's own reason string, when it reported one. */
  finishReason: string | null;
  /** `null` when the provider reported no usage — unknown, not zero. */
  usage: FleetInferenceUsage | null;
  elapsedMs: number;
}

/**
 * Every way this route says no. Closed and peer-facing: a consumer renders
 * the code, and slice 3's router keys admission on it, so it may not grow
 * silently any more than the manifest's diagnostic vocabulary may.
 */
export type FleetInferenceRefusalCode =
  /** This Station's fleet-contribution opt-in is off. */
  | 'contribution-disabled'
  /**
   * The opt-in is on but this model is not in the contributed subset —
   * including the case where the Station cannot launch it at all. The two
   * are deliberately indistinguishable: distinguishing them would let a
   * peer holding only `inference:invoke` enumerate the models this Station
   * has but has NOT contributed, which is exactly the disclosure §5.2 rule 2
   * narrows.
   */
  | 'model-not-contributed'
  /** Contributed, but its current availability makes it unroutable now. */
  | 'model-unavailable'
  /**
   * Contribution is on and connections are marked, but this Station cannot
   * currently say what it offers (unreadable inventory) or is offering
   * nothing. Unknown/empty, not "no such model" — the consumer should retry
   * or degrade rather than forget this peer.
   */
  | 'contribution-unavailable'
  /** `stream: true` (§10 OQ-8) — reserved, refused rather than buffered. */
  | 'streaming-unsupported'
  /** Malformed body, bad role, empty messages, unsupported field value. */
  | 'request-invalid'
  /** A {@link FLEET_INFERENCE_LIMITS} size ceiling was exceeded. */
  | 'request-too-large'
  /**
   * {@link FLEET_INFERENCE_LIMITS.maxConcurrentCompletions} is saturated.
   * Uniquely among the refusals, this one never carries `participation`:
   * admission control runs before the contribution projection, so at the
   * earlier of its two check points the field is genuinely unknown, and
   * carrying it at only one of them would make its absence read as a fact
   * about contribution rather than about where the request was stopped.
   */
  | 'capacity-exhausted'
  /**
   * {@link FLEET_INFERENCE_LIMITS.completionDeadlineMs} elapsed. The stream
   * was aborted and the slot freed. Distinct from `execution-failed`: the
   * provider did not fail, it failed to *finish*, and a consumer may
   * reasonably retry a shorter request rather than de-rank this peer.
   */
  | 'completion-timeout'
  /**
   * The caller disconnected before the completion finished, so the work was
   * abandoned and the slot freed. Nobody receives this response — it exists
   * so the outcome is named in metrics and in the serve-side record rather
   * than being indistinguishable from a success.
   */
  | 'request-abandoned'
  /** The local provider failed. The upstream error text is never relayed. */
  | 'execution-failed';

export interface FleetInferenceRefusal {
  schemaVersion: typeof FLEET_INFERENCE_REFUSAL_SCHEMA_VERSION;
  code: FleetInferenceRefusalCode;
  /** One sentence, safe to render verbatim, never an upstream error string. */
  message: string;
  /**
   * The serving Station's participation state when the refusal was decided,
   * present whenever it was known. This is what makes a refusal
   * *participation-aware* rather than a bare denial: "off", "on but nothing
   * marked", "marked but yielding nothing", and "contributing, just not that
   * model" are four different sentences to an operator and four different
   * routing decisions to a consumer. It is not a new disclosure — the caller
   * already holds `inference:invoke` and can read the manifest.
   */
  participation?: FleetContributionParticipation;
  refusedAt: string;
}

/**
 * The HTTP status each refusal is served with, declared once so the route and
 * any consumer agree. Deliberately never 404: §11 slice 2 requires a named
 * refusal rather than a silent not-found, and a 404 on a model id is also the
 * enumeration oracle `model-not-contributed` exists to avoid.
 */
export const FLEET_INFERENCE_REFUSAL_STATUS: Readonly<
  Record<FleetInferenceRefusalCode, number>
> = {
  'contribution-disabled': 403,
  'model-not-contributed': 403,
  'model-unavailable': 503,
  'contribution-unavailable': 503,
  'streaming-unsupported': 400,
  'request-invalid': 400,
  'request-too-large': 413,
  'capacity-exhausted': 429,
  'completion-timeout': 504,
  // 499 is the non-standard "client closed request" status. Deliberate: no
  // client is listening by definition, so the code exists to be recorded
  // rather than delivered, and reusing a standard code would make an
  // abandoned request indistinguishable from a real one in a log.
  'request-abandoned': 499,
  'execution-failed': 502,
};

/**
 * `GET /api/inference/manifest` — the authenticated fleet route §4.2 names,
 * carrying the slice-1 `station.fleet-contribution/v1` projection bounded for
 * the machine boundary. Nothing about participation appears on the public
 * handshake; this is the only place it is readable, and only after
 * authenticating with `inference:invoke` (§3.3 point 3, §5.2 rules 1–2).
 */
export interface FleetInferenceManifestResponse {
  manifest: FleetContributionManifest;
}
