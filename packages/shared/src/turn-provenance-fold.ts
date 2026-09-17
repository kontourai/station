import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  TURN_PROVENANCE_ENVELOPE_VERSION,
  TURN_PROVENANCE_MAX_OBSERVATIONS,
  TURN_PROVENANCE_MAX_TOOL_NAMES,
  type TurnProvenanceEngine,
  type TurnProvenanceEnvelope,
  type TurnProvenanceObservation,
  type TurnProvenanceRefSlot,
  type TurnProvenanceSlot,
  type TurnProvenanceToolSummary,
  type TurnProvenanceToolUse,
  type TurnProvenanceTrustReportRef,
  type TurnProvenanceUnavailableReason,
  type TurnProvenanceUsage,
} from '@kontourai/station-contracts/turn-provenance';
import {
  CONTEXT_INJECTION_METADATA_KEY,
  parseTurnProvenanceContextInjection,
  type TurnProvenanceContextInjection,
} from '@kontourai/station-contracts/turn-provenance-context';
import { providerUsageScope } from './usage-fold.js';

/**
 * Pure, deterministic fold of a durable `CanonicalRuntimeEvent` stream (the
 * orchestration EventStore) into one `TurnProvenanceEnvelope` per completed
 * turn — station#1410, the server-side assembly half of the per-answer
 * provenance card.
 *
 * Mirrors `usage-fold.ts` in shape and constraints: no I/O, no clock, no
 * randomness, output depends only on the input array, and it needs no
 * per-adapter integration because it reads only events every adapter
 * already publishes.
 *
 * **Correlation is strict and structural.** An event contributes to a turn
 * only when `event.turnId` equals that turn's id (`CanonicalRuntimeEventBase.turnId`).
 * Adjacency in the log, `createdAt` ordering, item ids, tool-call ids, and
 * "it must belong to the only open turn" are all deliberately NOT used:
 * an engine that does not tag its events with a turn id produces gaps here
 * instead of a plausible-looking attribution (#1410 R2). Claude, Codex, and
 * the station-agent adapter all stamp `turnId` on their tool and usage
 * events today, so the strict rule is also the useful one.
 *
 * **Secret-free by construction.** The only event fields read are ids,
 * methods, provider/model identifiers, tool NAMES, tool statuses, and token
 * counts. `turn.started.prompt`, `turn.started.ambientContext`,
 * `turn.completed.outputText`, `tool.started.arguments`,
 * `tool.completed.output`, and `tool.completed.error` are never read, so no
 * prompt content, generated text, tool payload, or credential can reach an
 * envelope (#1410 AC3).
 */

const NOT_REPORTED: TurnProvenanceUnavailableReason = 'not-reported-by-engine';
const NOT_CAPTURED: TurnProvenanceUnavailableReason = 'not-captured-by-station';
const SESSION_SCOPED: TurnProvenanceUnavailableReason =
  'reported-only-at-session-scope';
const SCOPE_UNDECLARED: TurnProvenanceUnavailableReason =
  'usage-scope-undeclared';

/**
 * Bounds a slot's audit pointers and DISCLOSES the truncation
 * (`omittedObservations`). Silently slicing would leave a slot claiming 40
 * tool calls next to 12 pointers, inviting the reader to conclude the count
 * rests on those 12 — a quiet mis-statement of the evidence, which is the
 * failure class this envelope exists to prevent.
 */
function boundObservations(observations: TurnProvenanceObservation[]): {
  observedFrom: TurnProvenanceObservation[];
  omittedObservations?: number;
} {
  if (observations.length <= TURN_PROVENANCE_MAX_OBSERVATIONS) {
    return { observedFrom: observations };
  }
  return {
    observedFrom: observations.slice(0, TURN_PROVENANCE_MAX_OBSERVATIONS),
    omittedObservations: observations.length - TURN_PROVENANCE_MAX_OBSERVATIONS,
  };
}

function unavailable(reason: TurnProvenanceUnavailableReason): {
  state: 'unavailable';
  reason: TurnProvenanceUnavailableReason;
} {
  return { state: 'unavailable', reason };
}

function observation(event: CanonicalRuntimeEvent): TurnProvenanceObservation {
  return { eventId: event.eventId, method: event.method };
}

/** Bound/trim rule for identifier-shaped strings entering an envelope. */
function boundedIdentifier(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

function readMetadataString(
  event: CanonicalRuntimeEvent,
  key: string,
  maxLength: number,
): string | undefined {
  const metadata = (event as { metadata?: Record<string, unknown> }).metadata;
  return boundedIdentifier(metadata?.[key], maxLength);
}

/**
 * Reads an explicitly stamped Surface trust-report reference off a turn's
 * terminal event metadata. Both parts must be present and well-formed —
 * a half-stamped reference is dropped rather than completed with a default,
 * because a wrong drill-down target is worse than an admitted gap.
 */
function readTrustReportRef(
  event: CanonicalRuntimeEvent,
): TurnProvenanceTrustReportRef | undefined {
  const metadata = (event as { metadata?: Record<string, unknown> }).metadata;
  const raw = metadata?.trustReport;
  if (typeof raw !== 'object' || raw === null) return undefined;
  const candidate = raw as Record<string, unknown>;
  const projectSlug = boundedIdentifier(candidate.projectSlug, 256);
  const bundleId = boundedIdentifier(candidate.bundleId, 256);
  if (!projectSlug || !bundleId) return undefined;
  return { kind: 'surface-trust-bundle', projectSlug, bundleId };
}

interface TurnAccumulator {
  terminal?: Extract<
    CanonicalRuntimeEvent,
    { method: 'turn.completed' } | { method: 'turn.aborted' }
  >;
  started?: Extract<CanonicalRuntimeEvent, { method: 'turn.started' }>;
  toolEvents: CanonicalRuntimeEvent[];
  usageEvents: Extract<
    CanonicalRuntimeEvent,
    { method: 'token-usage.updated' }
  >[];
}

function emptyAccumulator(): TurnAccumulator {
  return { toolEvents: [], usageEvents: [] };
}

function engineSlot(
  terminal: CanonicalRuntimeEvent,
): TurnProvenanceSlot<TurnProvenanceEngine> {
  const provider = boundedIdentifier(terminal.provider, 128);
  if (!provider) return unavailable(NOT_REPORTED);
  return {
    state: 'observed',
    value: { provider },
    observedFrom: [observation(terminal)],
  };
}

/**
 * Model slots read ONLY this turn's own `turn.started`/terminal events. A
 * session-level `session.configured` model is deliberately not attributed
 * to a turn: the model can change between turns, and carrying a session
 * value forward would report a model this turn may not have used.
 * `turn.completed` wins over `turn.started` because some adapters only
 * learn the value once the response arrives (station#1182).
 */
function modelSlot(
  accumulator: TurnAccumulator,
  metadataKey: 'effectiveModel' | 'reportedModel',
): TurnProvenanceSlot<string> {
  const candidates: CanonicalRuntimeEvent[] = [];
  if (accumulator.terminal) candidates.push(accumulator.terminal);
  if (accumulator.started) candidates.push(accumulator.started);
  for (const event of candidates) {
    const value = readMetadataString(event, metadataKey, 256);
    if (value) {
      return { state: 'observed', value, observedFrom: [observation(event)] };
    }
  }
  return unavailable(NOT_REPORTED);
}

function toolsSlot(
  accumulator: TurnAccumulator,
): TurnProvenanceSlot<TurnProvenanceToolSummary> {
  if (accumulator.toolEvents.length === 0) {
    // Not `{ uses: [], … }`: a turn with no observed tool events tells us
    // nothing about whether tools ran (#1410 AC2).
    return unavailable(NOT_REPORTED);
  }

  const byName = new Map<string, TurnProvenanceToolUse>();
  const observedFrom: TurnProvenanceObservation[] = [];
  let omittedNames = 0;

  for (const event of accumulator.toolEvents) {
    const name = boundedIdentifier(
      (event as { toolName?: unknown }).toolName,
      256,
    );
    if (!name) continue;
    let use = byName.get(name);
    if (!use) {
      if (byName.size >= TURN_PROVENANCE_MAX_TOOL_NAMES) {
        omittedNames += 1;
        continue;
      }
      use = {
        name,
        started: 0,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
        unresolved: 0,
      };
      byName.set(name, use);
    }
    observedFrom.push(observation(event));
    if (event.method === 'tool.started') {
      use.started += 1;
      continue;
    }
    if (event.method !== 'tool.completed') continue;
    if (event.status === 'success') use.succeeded += 1;
    else if (event.status === 'error') use.failed += 1;
    else if (event.status === 'cancelled') use.cancelled += 1;
    // station#1558: its own counter beside the three outcomes that assert
    // what happened. Adding it to `failed` would blame a tool nothing
    // observed fail; adding it to `cancelled` would claim a stop nobody
    // asked for.
    else if (event.status === 'unresolved')
      use.unresolved = (use.unresolved ?? 0) + 1;
  }

  if (byName.size === 0) return unavailable(NOT_REPORTED);
  return {
    state: 'observed',
    value: { uses: [...byName.values()], omittedNames },
    ...boundObservations(observedFrom),
  };
}

/**
 * Sums the figures this turn's own usage events reported.
 *
 * The subtlety that makes this more than an addition: a `token-usage.updated`
 * event carrying a turn id does NOT always describe that turn. Codex's
 * `thread/tokenUsage/updated` publishes `tokenUsage.total`, a running
 * session-to-date figure, tagged with the turn that happened to trigger it
 * (`codex-adapter-notifications.ts`) — reading it as the turn's own usage
 * would over-report every turn after the first, and the over-report would
 * look exactly like a real measurement. So a `session-cumulative` provider
 * yields a disclosed gap (`reported-only-at-session-scope`), not an
 * arithmetic guess: subtracting consecutive cumulative totals would assume
 * an event ordering and a per-turn partition the protocol does not
 * guarantee. The session-level `foldUsageEvents` remains the correct place
 * to read those figures.
 *
 * A provider whose scope nobody has declared gets the same refusal
 * (`usage-scope-undeclared`). Reading an undeclared engine's numbers as
 * per-turn would make the next cumulative adapter over-report from its very
 * first turn with nothing on screen to say so — the scope declaration in
 * `PROVIDER_USAGE_SCOPE` is what turns numbers on, and its absence is a
 * visible gap rather than a silent guess.
 */
function usageSlot(
  accumulator: TurnAccumulator,
): TurnProvenanceSlot<TurnProvenanceUsage> {
  if (accumulator.usageEvents.length === 0) return unavailable(NOT_REPORTED);
  // Fail closed on scope: a figure whose meaning nobody has declared is not
  // a per-answer number, and guessing "per-turn" is how a future cumulative
  // adapter would start silently over-reporting every turn.
  const scopes = accumulator.usageEvents.map((event) =>
    providerUsageScope(event.provider),
  );
  if (scopes.some((scope) => scope === undefined)) {
    return unavailable(SCOPE_UNDECLARED);
  }
  if (scopes.some((scope) => scope === 'session-cumulative')) {
    return unavailable(SESSION_SCOPED);
  }

  const usage: TurnProvenanceUsage = {};
  const observedFrom: TurnProvenanceObservation[] = [];
  let reportedAnything = false;

  const add = (key: keyof TurnProvenanceUsage, value: number | undefined) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    usage[key] = (usage[key] ?? 0) + value;
    reportedAnything = true;
  };

  for (const event of accumulator.usageEvents) {
    observedFrom.push(observation(event));
    add('inputTokens', event.promptTokens);
    add('outputTokens', event.completionTokens);
    add('totalTokens', event.totalTokens);
    add('cacheReadTokens', event.cacheReadTokens);
    add('cacheWriteTokens', event.cacheWriteTokens);
  }

  // A usage event that carried no numbers at all is not usage.
  if (!reportedAnything) return unavailable(NOT_REPORTED);
  return {
    state: 'observed',
    value: usage,
    ...boundObservations(observedFrom),
  };
}

/**
 * station#2649: what Station itself composed into this turn's model input,
 * read off the terminal event's `contextInjection` metadata — stamped by the
 * station-agent adapter from the `/chat` execution engine's own dispatch-time
 * record, never reconstructed here.
 *
 * Absence splits by who ran the turn, because the two absences mean
 * different things:
 * - `station-agent`: Station's engine DID run this turn through `/chat`,
 *   which stamps the record on every turn since station#2649 — an absent
 *   record means the turn predates the feature: `not-captured-by-station`.
 * - any other provider: an external engine (Claude Code, Codex, ACP) owns
 *   its context end-to-end; Station injects nothing and the engine reports
 *   nothing here — `not-reported-by-engine`. The card derives its honest
 *   "managed by <engine>" line from the engine slot, not from a fabricated
 *   observed-empty record: an observed slot requires an observation, and
 *   there is none.
 *
 * The provider check gates the OBSERVED branch too, not just the fallback
 * (review fix). Reading the key first and only consulting the provider on
 * absence would make "an external engine never yields a Station context
 * claim" a property of the six other files that publish external
 * `turn.completed` events — true today, and unenforced. Here it is a
 * property of this function.
 */
function contextInjectionSlot(
  terminal: CanonicalRuntimeEvent,
): TurnProvenanceSlot<TurnProvenanceContextInjection> {
  if (terminal.provider !== 'station-agent') {
    return unavailable(NOT_REPORTED);
  }
  const metadata = (terminal as { metadata?: Record<string, unknown> })
    .metadata;
  const parsed = parseTurnProvenanceContextInjection(
    metadata?.[CONTEXT_INJECTION_METADATA_KEY],
  );
  if (parsed) {
    return {
      state: 'observed',
      value: parsed,
      observedFrom: [observation(terminal)],
    };
  }
  return unavailable(NOT_CAPTURED);
}

function trustReportSlot(
  terminal: CanonicalRuntimeEvent,
): TurnProvenanceRefSlot<TurnProvenanceTrustReportRef> {
  const ref = readTrustReportRef(terminal);
  if (!ref) return unavailable(NOT_CAPTURED);
  return { state: 'referenced', ref, observedFrom: [observation(terminal)] };
}

/**
 * Assemble one envelope per turn that reached a terminal event
 * (`turn.completed` or `turn.aborted`) in the supplied stream, in the order
 * those terminal events appear. A turn that is still open, or whose events
 * carry no `turnId`, yields no envelope — there is nothing truthful to say
 * about it yet.
 */
export function assembleTurnProvenanceEnvelopes(
  events: readonly CanonicalRuntimeEvent[],
): TurnProvenanceEnvelope[] {
  const byTurn = new Map<string, TurnAccumulator>();
  const terminalOrder: string[] = [];

  // Keyed by session AND turn, not turn alone: callers pass one session's
  // events today, but a turn id is only unique WITHIN a session, so a shared
  // or replayed stream could otherwise let one session's tool/usage events
  // land on another's turn. Making the key structural means the terminal
  // event's `threadId` necessarily matches every event that contributed to
  // it — the strictness is enforced by the data structure rather than by a
  // rule a later edit could forget.
  // `\u0000` as the separator, written as an ESCAPE rather than a literal
  // NUL byte (which is invisible in a diff and trips tooling): no thread or
  // turn id can contain it, so two different pairs can never collide into
  // one key.
  const accumulatorKey = (threadId: string, turnId: string) =>
    `${threadId}\u0000${turnId}`;

  const accumulatorFor = (key: string): TurnAccumulator => {
    let accumulator = byTurn.get(key);
    if (!accumulator) {
      accumulator = emptyAccumulator();
      byTurn.set(key, accumulator);
    }
    return accumulator;
  };

  for (const event of events) {
    const turnId = boundedIdentifier(event.turnId, 256);
    if (!turnId) continue;
    const key = accumulatorKey(event.threadId, turnId);
    switch (event.method) {
      case 'turn.started':
        accumulatorFor(key).started = event;
        break;
      case 'turn.completed':
      case 'turn.aborted': {
        const accumulator = accumulatorFor(key);
        // A re-emitted terminal event supersedes rather than duplicates.
        if (!accumulator.terminal) terminalOrder.push(key);
        accumulator.terminal = event;
        break;
      }
      case 'tool.started':
      case 'tool.completed':
        accumulatorFor(key).toolEvents.push(event);
        break;
      case 'token-usage.updated':
        accumulatorFor(key).usageEvents.push(event);
        break;
      default:
        break;
    }
  }

  const envelopes: TurnProvenanceEnvelope[] = [];
  for (const key of terminalOrder) {
    const accumulator = byTurn.get(key);
    const terminal = accumulator?.terminal;
    if (!accumulator || !terminal) continue;
    envelopes.push({
      envelopeVersion: TURN_PROVENANCE_ENVELOPE_VERSION,
      sessionId: terminal.threadId,
      turnId: terminal.turnId,
      outcome: terminal.method === 'turn.completed' ? 'completed' : 'aborted',
      observedAt: terminal.createdAt,
      engine: engineSlot(terminal),
      requestedModel: modelSlot(accumulator, 'effectiveModel'),
      reportedModel: modelSlot(accumulator, 'reportedModel'),
      tools: toolsSlot(accumulator),
      usage: usageSlot(accumulator),
      // #423 has not shipped a per-turn routing receipt; #1409 has not
      // shipped source acquisition. Both stay explicit gaps rather than
      // omitted fields so the card can say so out loud.
      routingReceipt: unavailable(NOT_CAPTURED),
      sources: unavailable(NOT_CAPTURED),
      trustReport: trustReportSlot(terminal),
      contextInjection: contextInjectionSlot(terminal),
    });
  }
  return envelopes;
}
