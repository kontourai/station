import type { ProviderKind } from '@kontourai/station-contracts/provider';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { PROVIDER_PROVEN_FINISH_REASONS } from '../../providers/finish-reason-authority.js';
import type { EventBus, ServerEvent } from '../orchestration/event-bus.js';

export const DEFAULT_AUTH_FAILURE_TTL_MS = 60_000;
export const MAX_AUTH_FAILURE_TTL_MS = 15 * 60 * 1000;
/** Provider names are external event data; retain a fixed, bounded key set. */
export const MAX_AUTH_FAILURE_PROVIDERS = 64;

export interface RuntimeAuthenticationFailure {
  observedAt: string;
  expiresAt: string;
}

interface RuntimeAuthenticationFailureEntry {
  failure: RuntimeAuthenticationFailure;
  freshUntilMonotonicMs: number;
}

interface RuntimeAuthHealthMonitorOptions {
  /** Base failure window. Kept as ttlMs for the existing local test seam. */
  ttlMs?: number;
  maxTtlMs?: number;
  now?: () => Date;
  monotonicNow?: () => number;
  maxProviders?: number;
}

class RuntimeAuthHealthTimingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeAuthHealthTimingError';
  }
}

class RuntimeAuthHealthCapacityError extends Error {
  constructor() {
    super('Runtime authentication health provider capacity is exhausted.');
    this.name = 'RuntimeAuthHealthCapacityError';
  }
}

class RuntimeAuthHealthEventDiagnostic extends Error {
  constructor() {
    super('Runtime authentication health event is invalid.');
    this.name = 'RuntimeAuthHealthEventDiagnostic';
  }
}

function invalidTimingConfiguration(): RuntimeAuthHealthTimingError {
  return new RuntimeAuthHealthTimingError(
    'Runtime authentication health timing configuration is invalid.',
  );
}

function requirePositiveDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidTimingConfiguration();
  }
  return value;
}

function requireProviderCapacity(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_AUTH_FAILURE_PROVIDERS
  ) {
    throw invalidTimingConfiguration();
  }
  return value;
}

const AUTH_CODE_PATTERN =
  /(?:^|_)(?:401|invalid_grant|unauthenticated|unauthorized|authentication_(?:error|failed|required)|invalid_(?:api_key|token|credentials?))(?:$|_)/;
const AUTH_MESSAGE_PATTERNS = [
  /\b(?:unauthenticated|unauthorized)\b/i,
  /\bplease\s+(?:log\s*in|login|sign\s*in)\b/i,
  /\bnot\s+(?:logged|signed)\s+in\b/i,
  /\b(?:authentication|credentials?)\b.{0,80}\b(?:failed|invalid|expired|required|missing|rejected|revoked)\b/i,
  /\b(?:failed|invalid|expired|required|missing|rejected|revoked)\b.{0,80}\b(?:authentication|credentials?)\b/i,
  /\b(?:invalid|expired|revoked|missing)\b.{0,40}\b(?:(?:x-)?api[\s-]*key|(?:oauth|access|refresh)\s+token)\b/i,
  /\b(?:oauth|refresh|access)\s+token\b.{0,100}\b(?:already\s+used|expired|invalid|revoked|could\s+not\s+be\s+refreshed|failed)\b/i,
];
const INTERRUPTION_CODE_PATTERN =
  /(?:^|_)(?:abort(?:_?(?:err|error))?|aborted|cancelled|canceled|interrupted)(?:$|_)/;
const INTERRUPTION_MESSAGE_PATTERN =
  /\b(?:aborted|cancelled|canceled|interrupted)\b/i;
const CANONICAL_UTC_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?Z$/;
const MAX_PROVIDER_ID_LENGTH = 256;
const MAX_RUNTIME_EVENT_ID_LENGTH = 512;
const MAX_RUNTIME_MESSAGE_LENGTH = 4_096;
const MAX_RUNTIME_CODE_LENGTH = 256;
// station#3587 (renamed from SUCCESSFUL_FINISH_REASONS, which conflated two
// questions under one name): this set answers ONLY "is this `finishReason` a
// recognized, well-formed vocabulary member" — never "does this prove the
// provider authenticated" or "should this clear a recorded failure". Those
// are `PROVIDER_PROVEN_FINISH_REASONS` / `clearsRuntimeAuthHealth`'s
// question, immediately below, and they read this same value through a
// DIFFERENT, narrower set — membership here grants no clear authority.
//
// This is now the FULL canonical vocabulary
// (`packages/contracts/src/runtime-events.ts`'s `finishReason` union: `'stop'
// | 'tool-calls' | 'max-tokens' | 'cancelled' | 'other'`), not a subset of
// it. Before this change, `'other'` was excluded — not because it is
// malformed (it is a first-class vocabulary member: the honest answer
// whenever a provider reports a terminal station has no specific member
// for), but because the set's own name made "well-formed" and "successful"
// look like the same question. Excluding it here meant `monitoredRuntimeEventFrom`
// diagnosed a WELL-FORMED `turn.completed` as malformed and `onServerEvent`
// threw before ever reaching the `clear()` decision — a well-formed event
// used to trip a diagnostic that exists to catch genuinely invalid input.
//
// station#3545 (found during #3509's review, narrowed by #3545, closed here)
// traced the dominant population of this gap through
// `AiSdkLLMProvider.createStream` never setting a `finishReason` at all,
// which `normalizeFinishReason` collapsed to `'other'` — so EVERY successful
// Bedrock turn hit this exclusion. #3545 fixed the producer; the residual
// this set used to still reject is every terminal that legitimately reports
// `'other'`: content-filtered generations, ai-sdk `'unknown'` reasons, a
// mid-stream ai-sdk failure translated through `mapAiSdkFinishReason`'s
// default arm (station#3586), and ACP `refusal`/`max_turn_requests`. Adding
// `'other'` here stops the false "malformed" diagnostic for all of them —
// it does NOT grant any of them clear authority; see
// `PROVIDER_PROVEN_FINISH_REASONS` for that question, still answered "no".
const WELL_FORMED_FINISH_REASONS = new Set([
  'stop',
  'tool-calls',
  'max-tokens',
  'cancelled',
  'other',
]);

// station#3509 fix round MEDIUM 2: the clear-authority question above is
// deliberately an ALLOWLIST, not `WELL_FORMED_FINISH_REASONS` minus
// `'cancelled'`/`'other'` — the full record of that decision (and of
// station#3545/#3587's history behind it) now lives with the set itself in
// `providers/finish-reason-authority.ts`, because station#3485 gave the
// identical clear-authority question a second consumer (session-scoped
// `runtime.error` supersession in the event store). One set, one decision
// point: adding a member there grants both authorities, explicitly.

/**
 * station#3509 fix round FIX 2: extracted so the fail-closed rejection path
 * is executed by a real unit test today, not just proven by code reading.
 * The five currently-reachable `finishReason` values (`stop`/`tool-calls`/
 * `max-tokens`/`cancelled`/`other`) cannot exercise this predicate's
 * REJECTION of an unrecognized value — `monitoredRuntimeEventFrom`'s
 * malformed check already refuses anything outside
 * `WELL_FORMED_FINISH_REASONS` before a `turn.completed` ever reaches
 * `onServerEvent` — so this is proven directly, mirroring
 * `resolveTurnCompletionOutcome` in `turn-completion-notifications.ts`
 * ("Exported for unit coverage without standing up an EventBus"). station#3587
 * closed the disclosure this docblock used to carry: `'other'` is now a real,
 * currently-reachable fifth vocabulary member that DOES reach this call
 * inside `onServerEvent` (a well-formed `turn.completed` with
 * `finishReason: 'other'` no longer trips the malformed diagnostic), and
 * `runtime-auth-health-monitor.test.ts` exercises that exact end-to-end
 * coupling: `'other'` reaches `onServerEvent` without throwing and without
 * clearing a recorded failure.
 */
export function clearsRuntimeAuthHealth(
  finishReason: string | undefined,
): boolean {
  return (
    finishReason !== undefined &&
    PROVIDER_PROVEN_FINISH_REASONS.has(finishReason)
  );
}

interface CanonicalRuntimeEventBase {
  eventId: string;
  provider: ProviderKind;
  threadId: string;
  createdAt: string;
}

interface AuthenticationRuntimeError extends CanonicalRuntimeEventBase {
  method: 'runtime.error';
  severity: 'error';
  message: string;
  code?: string;
}

// station#3587: renamed from `SuccessfulTerminalRuntimeEvent` — `'cancelled'`
// and now `'other'` are well-formed members whose completion is not
// evidence of success (see `PROVIDER_PROVEN_FINISH_REASONS`), so "Successful"
// was never an accurate name for the whole union this type carries.
interface TerminalRuntimeEvent extends CanonicalRuntimeEventBase {
  method: 'turn.completed';
  turnId: string;
  finishReason: 'stop' | 'tool-calls' | 'max-tokens' | 'cancelled' | 'other';
}

type MonitoredRuntimeEvent = AuthenticationRuntimeError | TerminalRuntimeEvent;

export function isRuntimeAuthenticationFailure(error: {
  message: string;
  code?: string;
}): boolean {
  const normalizedCode = error.code
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
  if (normalizedCode && INTERRUPTION_CODE_PATTERN.test(normalizedCode)) {
    return false;
  }
  if (INTERRUPTION_MESSAGE_PATTERN.test(error.message)) return false;
  if (normalizedCode && AUTH_CODE_PATTERN.test(normalizedCode)) return true;
  return AUTH_MESSAGE_PATTERNS.some((pattern) => pattern.test(error.message));
}

function monitoredRuntimeEventFrom(serverEvent: ServerEvent): {
  event: MonitoredRuntimeEvent | null;
  malformedRelevant: boolean;
} {
  if (serverEvent.event !== SERVER_EVENTS.ORCHESTRATION_EVENT) {
    return { event: null, malformedRelevant: false };
  }
  const candidate = serverEvent.data?.event;
  if (!isPlainRecord(candidate)) {
    return { event: null, malformedRelevant: false };
  }
  if (
    candidate.method !== 'runtime.error' &&
    candidate.method !== 'turn.completed'
  ) {
    return { event: null, malformedRelevant: false };
  }
  const base = canonicalRuntimeEventBaseFrom(candidate);
  if (!base) return { event: null, malformedRelevant: true };

  if (candidate.method === 'runtime.error') {
    if (
      candidate.severity !== 'error' ||
      !isCanonicalBoundedText(candidate.message, MAX_RUNTIME_MESSAGE_LENGTH) ||
      (candidate.code !== undefined &&
        !isCanonicalBoundedText(candidate.code, MAX_RUNTIME_CODE_LENGTH))
    ) {
      return { event: null, malformedRelevant: true };
    }
    return {
      event: {
        ...base,
        method: 'runtime.error',
        severity: 'error',
        message: candidate.message,
        ...(candidate.code === undefined ? {} : { code: candidate.code }),
      },
      malformedRelevant: false,
    };
  }

  if (
    candidate.method !== 'turn.completed' ||
    !isCanonicalBoundedText(candidate.turnId, MAX_RUNTIME_EVENT_ID_LENGTH) ||
    typeof candidate.finishReason !== 'string' ||
    !WELL_FORMED_FINISH_REASONS.has(candidate.finishReason)
  ) {
    return { event: null, malformedRelevant: true };
  }
  return {
    event: {
      ...base,
      method: 'turn.completed',
      turnId: candidate.turnId,
      finishReason:
        candidate.finishReason as TerminalRuntimeEvent['finishReason'],
    },
    malformedRelevant: false,
  };
}

function authenticationRuntimeErrorFrom(
  event: MonitoredRuntimeEvent,
): AuthenticationRuntimeError | null {
  if (event.method !== 'runtime.error') return null;
  if (!isRuntimeAuthenticationFailure(event)) return null;
  return event;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value);
    return (
      (prototype === Object.prototype || prototype === null) &&
      Object.values(Object.getOwnPropertyDescriptors(value)).every(
        (descriptor) =>
          descriptor.get === undefined && descriptor.set === undefined,
      )
    );
  } catch {
    return false;
  }
}

function isCanonicalBoundedText(
  value: unknown,
  maxLength: number,
): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim()
  );
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const match = CANONICAL_UTC_TIMESTAMP.exec(value);
  if (!match) return false;
  const parsed = new Date(value);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().startsWith(`${match[1]}.`)
  );
}

function isCanonicalProviderId(value: unknown): value is ProviderKind {
  return (
    isCanonicalBoundedText(value, MAX_PROVIDER_ID_LENGTH) &&
    !hasControlCharacter(value)
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function canonicalRuntimeEventBaseFrom(
  value: unknown,
): CanonicalRuntimeEventBase | null {
  if (!isPlainRecord(value)) return null;
  if (
    !isCanonicalBoundedText(value.eventId, MAX_RUNTIME_EVENT_ID_LENGTH) ||
    !isCanonicalBoundedText(value.threadId, MAX_RUNTIME_EVENT_ID_LENGTH) ||
    !isCanonicalUtcTimestamp(value.createdAt) ||
    !isCanonicalProviderId(value.provider)
  ) {
    return null;
  }
  return {
    eventId: value.eventId,
    provider: value.provider,
    threadId: value.threadId,
    createdAt: value.createdAt,
  };
}

/**
 * Short-lived negative health cache fed only by real runtime outcomes.
 * Raw provider errors are deliberately never retained.
 */
export class RuntimeAuthHealthMonitor {
  private readonly failures = new Map<
    ProviderKind,
    RuntimeAuthenticationFailureEntry
  >();
  /** Persisted across an expired window; only proven recovery resets it. */
  private readonly failureStreaks = new Map<ProviderKind, number>();
  private readonly expiryTimers = new Map<
    ProviderKind,
    ReturnType<typeof setTimeout>
  >();
  private readonly unsubscribe: () => void;
  private readonly ttlMs: number;
  private readonly maxTtlMs: number;
  private readonly maxProviders: number;
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;
  private lastMonotonicNow: number | undefined;
  private disposed = false;

  constructor(
    private readonly eventBus: EventBus,
    options: RuntimeAuthHealthMonitorOptions = {},
  ) {
    this.ttlMs = requirePositiveDuration(
      options.ttlMs ?? DEFAULT_AUTH_FAILURE_TTL_MS,
    );
    this.maxTtlMs = requirePositiveDuration(
      options.maxTtlMs ?? MAX_AUTH_FAILURE_TTL_MS,
    );
    if (this.maxTtlMs < this.ttlMs) throw invalidTimingConfiguration();
    this.maxProviders = requireProviderCapacity(
      options.maxProviders ?? MAX_AUTH_FAILURE_PROVIDERS,
    );
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.unsubscribe = eventBus.subscribe((event) => this.onServerEvent(event));
  }

  getFailure(provider: ProviderKind): RuntimeAuthenticationFailure | null {
    const entry = this.failures.get(provider);
    if (!entry) return null;
    if (this.readMonotonicNow() >= entry.freshUntilMonotonicMs) {
      this.expire(provider, entry, false);
      return null;
    }
    return { ...entry.failure };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    for (const timer of this.expiryTimers.values()) clearTimeout(timer);
    this.expiryTimers.clear();
    this.failures.clear();
    this.failureStreaks.clear();
  }

  private onServerEvent(serverEvent: ServerEvent): void {
    const { event, malformedRelevant } = monitoredRuntimeEventFrom(serverEvent);
    // The ACP exclusion below only skips a WELL-FORMED acp event's tracking
    // side effects — it sits after this throw, not before it, so a malformed
    // acp event still reaches the diagnostic.
    if (malformedRelevant) throw new RuntimeAuthHealthEventDiagnostic();
    if (!event || event.provider === 'acp') return;

    if (event.method === 'turn.completed') {
      // station#3509 fix round FIX 3 (station#3587: now also covers
      // `'other'`): `WELL_FORMED_FINISH_REASONS` answers "is this malformed"
      // and `clearsRuntimeAuthHealth`/`PROVIDER_PROVEN_FINISH_REASONS`
      // answers a DIFFERENT question, "does it prove the provider
      // authenticated" — 'cancelled' and 'other' are both well-formed
      // without answering the second question the same way. A user
      // cancelling a turn is not evidence the provider authenticated; it
      // says nothing about credential state at all. An `'other'` terminal —
      // content-filtered, an ai-sdk `'unknown'` reason, a mid-stream failure
      // translated through `mapAiSdkFinishReason` (station#3586) — is
      // exactly as uninformative: "the provider reported something we do not
      // specifically recognize" is not evidence of a successful
      // authenticated exchange either. Clearing on either anyway would let a
      // cancellation or an unclassified terminal on ANY thread erase a
      // DIFFERENT thread's recorded auth failure (this record is
      // provider-scoped, not thread-scoped), reset the backoff streak, and
      // flip the Connections UI health badge to healthy while credentials
      // are still broken. Only a genuine content-producing completion clears
      // the record — `clearsRuntimeAuthHealth`, an allowlist (fix round
      // MEDIUM 2) so a future member of `WELL_FORMED_FINISH_REASONS` does not
      // silently inherit clear authority. A cancelled or `'other'` turn is
      // accepted as well-formed but is otherwise a no-op here: no throw, no
      // clear, no streak reset — station#3587's fix is precisely that this
      // branch is now REACHED for `'other'` instead of `onServerEvent`
      // throwing before it ever got here.
      if (clearsRuntimeAuthHealth(event.finishReason)) {
        this.clear(event.provider, { notify: true, resetStreak: true });
      }
      return;
    }
    const failure = authenticationRuntimeErrorFrom(event);
    if (!failure) return;

    if (
      !this.failureStreaks.has(failure.provider) &&
      this.failureStreaks.size >= this.maxProviders
    ) {
      // EventBus contains listener failures: this is observable server-side but
      // a malformed/excess external event cannot terminate the runtime.
      throw new RuntimeAuthHealthCapacityError();
    }

    const streak = (this.failureStreaks.get(failure.provider) ?? 0) + 1;
    const ttlMs = this.failureTtlFor(streak);
    const observedAt = this.readWallClockNow();
    const observedMonotonicMs = this.readMonotonicNow();
    const freshUntilMonotonicMs = observedMonotonicMs + ttlMs;
    if (!Number.isFinite(freshUntilMonotonicMs)) {
      throw invalidTimingConfiguration();
    }
    const entry: RuntimeAuthenticationFailureEntry = {
      failure: {
        observedAt: observedAt.toISOString(),
        expiresAt: new Date(observedAt.getTime() + ttlMs).toISOString(),
      },
      freshUntilMonotonicMs,
    };
    this.failureStreaks.set(failure.provider, streak);
    this.failures.set(failure.provider, entry);
    this.scheduleExpiry(failure.provider, entry, observedMonotonicMs);
    this.eventBus.emit(SERVER_EVENTS.RUNTIME_HEALTH_CHANGED, {
      provider: failure.provider,
      status: 'authentication_failed',
    });
  }

  private failureTtlFor(streak: number): number {
    const exponent = Math.min(streak - 1, 52);
    return Math.min(this.maxTtlMs, this.ttlMs * 2 ** exponent);
  }

  private readWallClockNow(): Date {
    const now = this.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw invalidTimingConfiguration();
    }
    return now;
  }

  private readMonotonicNow(): number {
    const now = this.monotonicNow();
    if (!Number.isFinite(now) || now < 0) throw invalidTimingConfiguration();
    if (this.lastMonotonicNow !== undefined && now < this.lastMonotonicNow) {
      throw new RuntimeAuthHealthTimingError(
        'Runtime authentication health monotonic clock moved backwards.',
      );
    }
    this.lastMonotonicNow = now;
    return now;
  }

  private scheduleExpiry(
    provider: ProviderKind,
    entry: RuntimeAuthenticationFailureEntry,
    observedMonotonicMs = this.readMonotonicNow(),
  ): void {
    const existing = this.expiryTimers.get(provider);
    if (existing) clearTimeout(existing);
    const remainingMs = entry.freshUntilMonotonicMs - observedMonotonicMs;
    if (remainingMs <= 0) {
      this.expire(provider, entry, true);
      return;
    }
    const timer = setTimeout(() => {
      if (this.expiryTimers.get(provider) === timer) {
        this.expiryTimers.delete(provider);
      }
      if (this.failures.get(provider) !== entry) return;
      const now = this.readMonotonicNow();
      if (now < entry.freshUntilMonotonicMs) {
        this.scheduleExpiry(provider, entry, now);
        return;
      }
      this.expire(provider, entry, true);
    }, remainingMs);
    timer.unref?.();
    this.expiryTimers.set(provider, timer);
  }

  private expire(
    provider: ProviderKind,
    entry: RuntimeAuthenticationFailureEntry,
    notify: boolean,
  ): void {
    if (this.failures.get(provider) !== entry) return;
    this.failures.delete(provider);
    const timer = this.expiryTimers.get(provider);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(provider);
    if (!notify) return;
    this.eventBus.emit(SERVER_EVENTS.RUNTIME_HEALTH_CHANGED, {
      provider,
      status: 'recheck_due',
    });
  }

  private clear(
    provider: ProviderKind,
    options: { notify: boolean; resetStreak: boolean },
  ): void {
    const timer = this.expiryTimers.get(provider);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(provider);
    const didClear = this.failures.delete(provider);
    if (options.resetStreak) this.failureStreaks.delete(provider);
    if (!didClear || !options.notify) return;
    this.eventBus.emit(SERVER_EVENTS.RUNTIME_HEALTH_CHANGED, {
      provider,
      status: 'healthy',
    });
  }
}
