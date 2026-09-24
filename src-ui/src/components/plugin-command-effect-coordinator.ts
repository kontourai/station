/**
 * Client coordinator for plugin command effects (kontourai/station#1418,
 * #1419). Lazily loaded: nothing here runs until a plugin command row is
 * actually chosen from the command palette.
 *
 * The server's strict-withdrawal contract (issue #1419, owner decision
 * 2026-09-16/17) makes HTTP receipts and SSE invalidations unordered on
 * purpose: an admitted effect stays outstanding on the server until THIS
 * document proves how it ended. This module's whole job is to always send
 * that proof — `applied`, `aborted`, `cancelled` or nothing (only when the
 * admission's own fate was never learned, in which case a cancel is sent
 * instead) — never to guess it away.
 *
 * Design:
 * - Identity: one `documentId` per browser document per Station, persisted
 *   in the injected storage so a reload keeps the SAME id; one `documentKey`
 *   held only in memory, so a reload always mints a NEW key. That is
 *   deliberate: the server ties an admission to a hash of the key that
 *   requested it, so a reloaded document cannot forge proof for effects an
 *   earlier incarnation of itself admitted — those stay outstanding for the
 *   withdrawal machinery or an operator to resolve, exactly like a document
 *   that never comes back.
 * - A bounded in-flight map (at most
 *   {@link PLUGIN_COMMAND_EFFECT_COORDINATOR_MAX_IN_FLIGHT} entries, matching
 *   the server's per-principal outstanding bound) holds every request from
 *   the moment it is issued until the server has confirmed its settlement.
 * - When a receipt arrives, exactly one synchronous step decides the outcome
 *   (mismatch check, then the caller's own `apply`) and writes it to the ack
 *   outbox before any `await` — the outbox item exists in the same tick the
 *   decision is made, so a page teardown right after can still flush it.
 * - The ack outbox retries with backoff, treats `already-settled` (and other
 *   terminal statuses) as done, and keeps retrying `cancel-refused`. On
 *   `pagehide` it flushes immediately, with `keepalive` ONLY when this
 *   document's Station credential is a same-origin browser cookie ("device
 *   session") — the one case a bare `keepalive` fetch can actually carry it
 *   (#1418/#1419 review, MEDIUM; see `isPluginCommandEffectCookieAuthEligible`
 *   in `plugin-command-effect-switch-signal.ts`). Everywhere else — native,
 *   a browser-relay/broker connection, or no confirmed auth mode yet — it
 *   instead attempts the normal authenticated transport: best-effort, may
 *   not finish before teardown, and never claims delivery either way. It
 *   resumes on a bfcache `pageshow`.
 */
import type {
  PluginCommandEffectAdmissionRequest,
  PluginCommandEffectContent,
  PluginCommandEffectOutcome,
  PluginCommandEffectReceipt,
  PluginCommandEffectRefusalReason,
  PluginCommandEffectRequirementContext,
  PluginCommandEffectSettlementRequest,
  PluginCommandEffectSettlementResult,
  PluginCommandEffectTarget,
} from '@kontourai/station-contracts/plugin-command-effect';

/** Mirrors the server's `outstandingPerPrincipal` bound (plugin-command-effects.ts). */
export const PLUGIN_COMMAND_EFFECT_COORDINATOR_MAX_IN_FLIGHT = 16;
/** Mirrors `PLUGIN_COMMAND_EFFECT_MAX_SETTLEMENT_ITEMS`. */
const MAX_SETTLEMENT_BATCH = 16;
const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const DOCUMENT_ID_STORAGE_KEY = 'station.pluginCommandEffects.documentId';
/**
 * An admission whose transport promise neither resolves nor rejects within
 * this window is treated the same as a network error: its fate is unknown,
 * so a cancel with no effectId is sent for it.
 */
export const PLUGIN_COMMAND_EFFECT_ADMISSION_TIMEOUT_MS = 20_000;
/**
 * Bounds `retainedSettlements` (station#1418/#1419 review round 2, HIGH). A
 * retained record survives a Station/authority switch under its OLD
 * identity, and that identity can never authenticate again once a different
 * Station is active — the ambient credential resolver has nothing else to
 * offer it. Without a bound this map would grow by one on every subsequent
 * switch and live for the tab's lifetime. Dropping a record here does not
 * erase the effect: the server's strict-withdrawal contract keeps it
 * outstanding until an operator resolves it, exactly like a document that
 * never comes back — this only stops THIS document from retrying forever.
 */
export const PLUGIN_COMMAND_EFFECT_RETAINED_SETTLEMENT_MAX = 16;
/** See {@link PLUGIN_COMMAND_EFFECT_RETAINED_SETTLEMENT_MAX}. */
export const PLUGIN_COMMAND_EFFECT_RETAINED_SETTLEMENT_MAX_AGE_MS =
  10 * 60 * 1000;

/** A settlement outcome that means the item is fully resolved and can be dropped. */
const TERMINAL_STATUSES = new Set([
  'settled',
  'already-settled',
  'recorded-late',
  'cancel-recorded',
  'conflict',
  'not-found',
]);

export type PluginCommandEffectAdmitOutcome =
  | { kind: 'admitted'; receipt: PluginCommandEffectReceipt }
  | { kind: 'refused'; reason: PluginCommandEffectRefusalReason }
  | { kind: 'network-error' };

/**
 * Mirrors `@kontourai/station-sdk/client`'s `ApiRequestScope` (`apiBase`,
 * `authorityKey`) structurally, without an SDK import — this module is
 * transport-agnostic and exercised against a fake transport in tests.
 * Production wiring (`CommandPalette.tsx`) supplies the live value from
 * `useHostRequestAuthorityScope()`, captured once when a command is issued
 * (station#1418/#1419 review round 2, HIGH).
 */
export interface PluginCommandEffectRequestScope {
  apiBase: string;
  authorityKey: string;
}

/**
 * Transport seam. Production dispatches real HTTP
 * (`plugin-command-effect-transport.ts`); tests script exact orderings of
 * admission responses, invalidations and acks against a fake or a real Hono
 * app.
 */
export interface PluginCommandEffectTransport {
  admit(
    apiBase: string,
    pluginId: string,
    request: PluginCommandEffectAdmissionRequest,
    signal: AbortSignal,
    /** The same captured authority settlement uses; see `settle`. */
    requestScope?: PluginCommandEffectRequestScope,
  ): Promise<PluginCommandEffectAdmitOutcome>;
  /**
   * `null` means the request never reached or returned from the server —
   * including a `requestScope` authority mismatch the SDK transport turns
   * into a fail-fast rejection before it ever dispatches (station#1418/#1419
   * review round 2, HIGH): a settle for a record admitted under a Station
   * that is no longer the active one must never be sent unauthenticated.
   */
  settle(
    apiBase: string,
    request: PluginCommandEffectSettlementRequest,
    options: {
      keepalive: boolean;
      requestScope?: PluginCommandEffectRequestScope;
    },
  ): Promise<readonly PluginCommandEffectSettlementResult[] | null>;
}

export interface PluginCommandEffectStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

type LifecycleListener = (event: { persisted?: boolean }) => void;

export interface PluginCommandEffectWindowLike {
  addEventListener(
    type: 'pagehide' | 'pageshow',
    listener: LifecycleListener,
  ): void;
  removeEventListener(
    type: 'pagehide' | 'pageshow',
    listener: LifecycleListener,
  ): void;
}

export interface PluginCommandEffectRunInput {
  apiBase: string;
  /**
   * The host authority this admission is issued under, captured once at
   * admission time. Carried on the record so a later settle — possibly long
   * after a Station/authority switch, via `retainedSettlements` — either
   * authenticates for the SAME Station it was admitted against, or fails
   * fast and observably (never silently unauthenticated) once the ambient
   * credential has moved on (station#1418/#1419 review round 2, HIGH).
   * Omitted only by tests that do not exercise cross-Station retry.
   */
  requestScope?: PluginCommandEffectRequestScope;
  pluginId: string;
  commandId: string;
  installationGeneration: string;
  target: PluginCommandEffectTarget;
  context?: PluginCommandEffectRequirementContext;
  /**
   * Live read at receipt time. If it disagrees with `installationGeneration`
   * the effect is aborted without even trying to apply it — an optimisation
   * (the server's own withdrawal capture is the real barrier), not the thing
   * that makes withdrawal safe.
   */
  currentGeneration(): string | undefined;
  /**
   * ONE synchronous application attempt against the receipt's own content
   * (never a cached row). Encapsulates the command's own abort condition —
   * the draft-revision CAS for seed-composer, the unsaved-guard check for
   * navigate — and must not await anything. Returns whether it applied.
   *
   * A throw is caught by the coordinator and settles `aborted` rather than
   * leaving the record in-flight forever (an uncaught throw here used to
   * skip the settlement step entirely). That residual is real: a throw
   * AFTER a partial side effect is still reported as `aborted`, which
   * understates what happened. Implementations must be all-or-nothing —
   * either fully apply before returning `true`, or touch nothing and throw
   * or return `false`.
   */
  apply(content: PluginCommandEffectContent): boolean;
  /** Surfaced for a refused admission or an aborted receipt. Best-effort. */
  notify?(message: string): void;
}

interface RequestRecord {
  requestId: string;
  apiBase: string;
  documentId: string;
  documentKey: string;
  /** Captured at creation; see {@link PluginCommandEffectRunInput.requestScope}. */
  requestScope?: PluginCommandEffectRequestScope;
  /** `now()` at creation. Bounds how long a decided-but-unacked record may live in `retainedSettlements`. */
  createdAt: number;
  /**
   * This record's OWN same-origin-cookie-auth eligibility, captured at
   * creation — never the coordinator's CURRENT (possibly since-changed)
   * value. A retained record must keep using the transport mode it was
   * admitted under; the live `cookieAuthEligible` flag describes whatever
   * identity is active NOW, which after a switch is a different Station
   * (station#1418/#1419 review round 2, HIGH).
   */
  keepaliveEligible: boolean;
  effectId?: string;
  outcome?: PluginCommandEffectOutcome;
  cancelled: boolean;
  attempts: number;
  nextAttemptAt: number;
  controller: AbortController;
}

export interface PluginCommandEffectCoordinatorDeps {
  transport: PluginCommandEffectTransport;
  storage: PluginCommandEffectStorageLike;
  windowLike: PluginCommandEffectWindowLike;
  now?(): number;
  /** Test seam; production mints opaque random ids. */
  randomId?(): string;
  setTimer?(handler: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

function defaultRandomId(): string {
  const bytes = new Uint8Array(24);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

function refusalMessage(reason: PluginCommandEffectRefusalReason): string {
  switch (reason) {
    case 'generation-changed':
    case 'command-not-declared':
    case 'command-not-executable':
      return 'This plugin command changed and could not run. Try it again.';
    case 'target-mismatch':
    case 'requirement-not-satisfied':
      return 'This plugin command is no longer available here.';
    case 'permission-unavailable':
      return 'This plugin command needs a permission that is not granted.';
    case 'capacity':
      return 'Too many plugin commands are already in progress. Try again shortly.';
    case 'cancelled':
      return 'This plugin command was cancelled.';
    case 'request-conflict':
      return 'This plugin command already ran.';
    case 'request-expired':
      return 'This plugin command took too long to reach Station. Try it again.';
    case 'not-found':
      return 'This plugin is not installed.';
    case 'invalid-request':
    case 'unavailable':
      return 'This plugin command could not run.';
    default:
      return 'This plugin command could not run.';
  }
}

/**
 * A fresh coordinator instance. Production keeps exactly one, created lazily
 * the first time a plugin command row is chosen (`getPluginCommandEffectCoordinator`
 * in `plugin-command-effect-transport.ts`); tests create as many as they need.
 */
export function createPluginCommandEffectCoordinator(
  deps: PluginCommandEffectCoordinatorDeps,
) {
  const now = deps.now ?? (() => Date.now());
  const randomId = deps.randomId ?? defaultRandomId;
  const setTimer = deps.setTimer ?? ((handler, ms) => setTimeout(handler, ms));
  const clearTimer =
    deps.clearTimer ?? ((handle) => clearTimeout(handle as never));

  const requests = new Map<string, RequestRecord>();
  /**
   * Decided records (an outcome was reached) that survived an authority
   * reset. They keep retrying under their OWN identity — `documentId`/
   * `documentKey` are already baked into their settlement request — outside
   * the bounded `requests` map so they never block a new command's
   * admission capacity under the NEW identity (station#1418/#1419 review,
   * HIGH: `resetForAuthorityChange` used to `requests.clear()`
   * unconditionally, so a decided-but-unacked outcome whose settle failed
   * was dropped forever even though it could keep retrying).
   */
  const retainedSettlements = new Map<string, RequestRecord>();
  let documentId = loadOrCreateDocumentId();
  let documentKey = randomId();
  let flushTimer: unknown = null;
  /**
   * Whether THIS document's Station credential is a same-origin browser
   * cookie ("device session") — the only mode a `pagehide` flush may use a
   * bare `keepalive` fetch for. Fails closed (`false`, the normal
   * authenticated transport) until the production wiring's live signal says
   * otherwise (#1418/#1419 review, MEDIUM).
   */
  let cookieAuthEligible = false;

  function loadOrCreateDocumentId(): string {
    const existing = deps.storage.getItem(DOCUMENT_ID_STORAGE_KEY);
    if (existing && /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(existing)) {
      return existing;
    }
    const created = randomId();
    deps.storage.setItem(DOCUMENT_ID_STORAGE_KEY, created);
    return created;
  }

  function scheduleFlush(delayMs: number) {
    if (flushTimer !== null) clearTimer(flushTimer);
    flushTimer = setTimer(() => {
      flushTimer = null;
      void flush({ keepalive: false });
    }, delayMs);
  }

  function backoffFor(attempts: number): number {
    return Math.min(
      BACKOFF_START_MS * 2 ** Math.max(0, attempts - 1),
      BACKOFF_MAX_MS,
    );
  }

  /** Forgets a record wherever it currently lives (live or retained). */
  function forgetRecord(requestId: string): void {
    requests.delete(requestId);
    retainedSettlements.delete(requestId);
  }

  /**
   * Drops a retained record that has exceeded a bound rather than left to
   * retry forever. This does not erase the effect — the server keeps it
   * outstanding until an operator resolves it — it only stops THIS document
   * from retrying an identity that can never authenticate again
   * (station#1418/#1419 review round 2, HIGH).
   */
  function dropRetainedRecord(
    requestId: string,
    record: RequestRecord,
    reason: string,
  ): void {
    retainedSettlements.delete(requestId);
    try {
      console.warn(
        `[plugin-command-effect] dropping retained settlement for effect ${
          record.effectId ?? `(unconfirmed, request ${requestId})`
        }: ${reason}. The server keeps this effect outstanding until an operator resolves it.`,
      );
    } catch {
      // A host without a usable console must not turn this into a failure.
    }
  }

  /**
   * Bounds `retainedSettlements` by count and age
   * ({@link PLUGIN_COMMAND_EFFECT_RETAINED_SETTLEMENT_MAX},
   * {@link PLUGIN_COMMAND_EFFECT_RETAINED_SETTLEMENT_MAX_AGE_MS}). Called on
   * every flush (age can pass with no switch at all) and after every
   * authority reset (a switch is what grows this map).
   */
  function pruneRetainedSettlements(): void {
    const nowMs = now();
    for (const [requestId, record] of [...retainedSettlements]) {
      if (
        nowMs - record.createdAt >
        PLUGIN_COMMAND_EFFECT_RETAINED_SETTLEMENT_MAX_AGE_MS
      ) {
        dropRetainedRecord(
          requestId,
          record,
          'exceeded the retention age bound',
        );
      }
    }
    if (
      retainedSettlements.size > PLUGIN_COMMAND_EFFECT_RETAINED_SETTLEMENT_MAX
    ) {
      const oldestFirst = [...retainedSettlements].sort(
        (a, b) => a[1].createdAt - b[1].createdAt,
      );
      const excess =
        oldestFirst.length - PLUGIN_COMMAND_EFFECT_RETAINED_SETTLEMENT_MAX;
      for (let index = 0; index < excess; index += 1) {
        const [requestId, record] = oldestFirst[index];
        dropRetainedRecord(
          requestId,
          record,
          'exceeded the retained-settlement count bound',
        );
      }
    }
  }

  /** Groups pending records by the exact identity they were admitted under. */
  function pendingGroups(): Map<string, RequestRecord[]> {
    const groups = new Map<string, RequestRecord[]>();
    for (const record of [
      ...requests.values(),
      ...retainedSettlements.values(),
    ]) {
      if (record.outcome === undefined) continue;
      if (record.nextAttemptAt > now()) continue;
      const key = `${record.apiBase}\u0000${record.documentId}\u0000${record.documentKey}`;
      const group = groups.get(key) ?? [];
      group.push(record);
      groups.set(key, group);
    }
    return groups;
  }

  /**
   * Schedules the next flush at the EARLIEST `nextAttemptAt` across every
   * still-pending decided record in both maps — never a fixed delay
   * (station#1418/#1419 review round 2, HIGH: a fixed `BACKOFF_START_MS`
   * reschedule only coincidentally matches the first backoff step; once a
   * record's own exponential backoff exceeds it, `pendingGroups()` excludes
   * that record from every future round while nothing re-arms a timer for
   * it, and it silently stops retrying forever). A pending decided record
   * must never be left without a scheduled wake-up.
   */
  function scheduleNextWake(): void {
    let nextWakeAt: number | undefined;
    for (const record of [
      ...requests.values(),
      ...retainedSettlements.values(),
    ]) {
      if (record.outcome === undefined) continue;
      if (nextWakeAt === undefined || record.nextAttemptAt < nextWakeAt) {
        nextWakeAt = record.nextAttemptAt;
      }
    }
    if (nextWakeAt !== undefined) {
      scheduleFlush(Math.max(0, nextWakeAt - now()));
    }
  }

  async function flush(options: { keepalive: boolean }): Promise<void> {
    pruneRetainedSettlements();
    const groups = pendingGroups();
    for (const group of groups.values()) {
      const batch = group.slice(0, MAX_SETTLEMENT_BATCH);
      const first = batch[0];
      if (!first) continue;
      const request: PluginCommandEffectSettlementRequest = {
        documentId: first.documentId,
        documentKey: first.documentKey,
        items: batch.map((record) => ({
          requestId: record.requestId,
          ...(record.effectId ? { effectId: record.effectId } : {}),
          outcome: record.outcome as PluginCommandEffectOutcome,
        })),
      };
      let results: readonly PluginCommandEffectSettlementResult[] | null;
      try {
        results = await deps.transport.settle(first.apiBase, request, {
          // This record's OWN captured eligibility, not the coordinator's
          // current one (station#1418/#1419 review round 2, HIGH) — see
          // `RequestRecord.keepaliveEligible`.
          keepalive: options.keepalive && first.keepaliveEligible,
          ...(first.requestScope ? { requestScope: first.requestScope } : {}),
        });
      } catch {
        results = null;
      }
      if (results === null) {
        for (const record of batch) {
          record.attempts += 1;
          record.nextAttemptAt = now() + backoffFor(record.attempts);
        }
        continue;
      }
      const byRequestId = new Map(
        results.map((result) => [result.requestId, result.status]),
      );
      for (const record of batch) {
        const status = byRequestId.get(record.requestId);
        if (status !== undefined && TERMINAL_STATUSES.has(status)) {
          forgetRecord(record.requestId);
          continue;
        }
        // `cancel-refused`, or the server did not answer this item: retry.
        record.attempts += 1;
        record.nextAttemptAt = now() + backoffFor(record.attempts);
      }
    }
    scheduleNextWake();
  }

  function onPageHide() {
    // `keepalive: true` bypasses the SDK's authenticated transport entirely
    // (see `settlePluginCommandEffects`), so it must only be used when this
    // document's Station credential is an ambient same-origin cookie — the
    // one case `credentials: 'include'` can actually carry. Everywhere else
    // (native, browser-relay/broker, no confirmed auth mode yet) this
    // attempts the normal authenticated transport instead: best-effort, may
    // not finish before teardown, and never claims delivery either way
    // (#1418/#1419 review, MEDIUM).
    void flush({ keepalive: cookieAuthEligible });
  }

  function onPageShow(event: { persisted?: boolean }) {
    if (event.persisted) scheduleFlush(0);
  }

  deps.windowLike.addEventListener('pagehide', onPageHide);
  deps.windowLike.addEventListener('pageshow', onPageShow);

  /**
   * Races the transport's admission call against
   * {@link PLUGIN_COMMAND_EFFECT_ADMISSION_TIMEOUT_MS}. A rejection and a
   * timeout are the same case to the caller: the admission's fate is
   * unknown, so it is settled as `cancelled` with no effectId.
   */
  function admitWithTimeout(
    record: RequestRecord,
    call: () => Promise<PluginCommandEffectAdmitOutcome>,
  ): Promise<PluginCommandEffectAdmitOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimer(() => {
        if (settled) return;
        settled = true;
        record.controller.abort();
        resolve({ kind: 'network-error' });
      }, PLUGIN_COMMAND_EFFECT_ADMISSION_TIMEOUT_MS);
      const onSettled = () => {
        if (settled) return false;
        settled = true;
        clearTimer(timer);
        return true;
      };
      let pending: Promise<PluginCommandEffectAdmitOutcome>;
      try {
        pending = call();
      } catch {
        if (onSettled()) resolve({ kind: 'network-error' });
        return;
      }
      pending.then(
        (outcome) => {
          if (onSettled()) resolve(outcome);
        },
        () => {
          if (onSettled()) resolve({ kind: 'network-error' });
        },
      );
    });
  }

  function runCommand(input: PluginCommandEffectRunInput): void {
    if (requests.size >= PLUGIN_COMMAND_EFFECT_COORDINATOR_MAX_IN_FLIGHT) {
      input.notify?.(
        'Too many plugin commands are already in progress. Try again shortly.',
      );
      return;
    }
    const requestId = randomId();
    const record: RequestRecord = {
      requestId,
      apiBase: input.apiBase,
      documentId,
      documentKey,
      requestScope: input.requestScope,
      createdAt: now(),
      keepaliveEligible: cookieAuthEligible,
      cancelled: false,
      attempts: 0,
      nextAttemptAt: 0,
      controller: new AbortController(),
    };
    requests.set(requestId, record);
    const admissionRequest: PluginCommandEffectAdmissionRequest = {
      documentId,
      documentKey,
      requestId,
      issuedAt: now(),
      installationGeneration: input.installationGeneration,
      commandId: input.commandId,
      target: input.target,
      ...(input.context ? { context: input.context } : {}),
    };

    void (async () => {
      const outcome = await admitWithTimeout(record, () =>
        deps.transport.admit(
          input.apiBase,
          input.pluginId,
          admissionRequest,
          record.controller.signal,
          input.requestScope,
        ),
      );
      // A reset (Station/authority switch) removed this record while the
      // admission was in flight. Its fate belongs to the identity that sent
      // it, which no longer exists here; drop it rather than settle under a
      // new one.
      if (requests.get(requestId) !== record) return;

      if (outcome.kind === 'refused') {
        requests.delete(requestId);
        input.notify?.(refusalMessage(outcome.reason));
        return;
      }
      if (outcome.kind === 'network-error') {
        // The admission's own fate is unknown: tombstone the request or
        // cancel the effect it may have created, with no effectId to name.
        record.outcome = 'cancelled';
        input.notify?.(
          'Could not confirm the plugin command reached Station. Cancelling it.',
        );
        scheduleFlush(0);
        return;
      }

      // ---- Exactly one synchronous step from here. No `await` below. ----
      const receipt = outcome.receipt;
      record.effectId = receipt.effectId;
      const mismatched =
        receipt.requestId !== requestId ||
        receipt.pluginId !== input.pluginId ||
        receipt.commandId !== input.commandId ||
        receipt.installationGeneration !== input.installationGeneration;
      const seenInvalidation =
        !mismatched &&
        input.currentGeneration() !== undefined &&
        input.currentGeneration() !== input.installationGeneration;
      let applied = false;
      if (record.cancelled) {
        // Abort: cancel was requested before the receipt arrived.
      } else if (mismatched) {
        // Abort: the receipt does not match the request it answers.
      } else if (seenInvalidation) {
        // Abort: an invalidation for this plugin/generation was already
        // observed. An optimisation — the server's capture is the barrier.
      } else {
        try {
          applied = input.apply(receipt.effect);
        } catch (error) {
          // A throw must still settle the record — never leave it in an
          // in-flight slot forever, never an unhandled rejection. Reported
          // the same as any other abort; see the residual documented on
          // `PluginCommandEffectRunInput.apply`.
          applied = false;
          try {
            console.error(
              '[plugin-command-effect] apply() threw; settling this effect as aborted.',
              error,
            );
          } catch {
            // A host without a usable console must not turn this into a
            // second failure.
          }
        }
      }
      record.outcome = applied ? 'applied' : 'aborted';
      if (!applied) {
        input.notify?.(
          mismatched
            ? 'This plugin command could not be confirmed and was cancelled.'
            : 'This plugin command was cancelled.',
        );
      }
      scheduleFlush(0);
      // ---- End synchronous step. ----
    })();
  }

  /** Not wired to any UI affordance yet (#1361 gap); exercised by tests. */
  function cancelRequest(requestId: string): void {
    const record = requests.get(requestId);
    if (record) record.cancelled = true;
  }

  /**
   * Station or authority switch. Flushes whatever the OLD identity owes,
   * then mints a fresh document identity.
   *
   * Two different fates for what the old identity was carrying:
   * - An admission still in flight (undecided) has an unknown fate that
   *   belongs to the identity that sent it, which is gone: abort it and
   *   drop it. It stays outstanding server-side, exactly like a document
   *   that never came back.
   * - A DECIDED record (an outcome was already reached, e.g. `applied`,
   *   just not yet acknowledged) is not a mystery — its documentId/
   *   documentKey are already baked into its settlement request — so it is
   *   moved to `retainedSettlements` and keeps retrying under its own old
   *   identity rather than being discarded (station#1418/#1419 review,
   *   HIGH: this used to `requests.clear()` unconditionally, silently
   *   dropping a decided-but-unacked outcome whose settle attempt failed).
   */
  function resetForAuthorityChange(): void {
    void flush({ keepalive: false });
    for (const [requestId, record] of [...requests]) {
      if (record.outcome === undefined) {
        record.controller.abort();
        requests.delete(requestId);
        continue;
      }
      requests.delete(requestId);
      retainedSettlements.set(requestId, record);
    }
    // A switch is exactly what grows `retainedSettlements`; enforce the
    // count bound right after adding to it (station#1418/#1419 review round
    // 2, HIGH). `flush()` above also prunes by age on every call.
    pruneRetainedSettlements();
    documentId = randomId();
    deps.storage.setItem(DOCUMENT_ID_STORAGE_KEY, documentId);
    documentKey = randomId();
  }

  function dispose(): void {
    deps.windowLike.removeEventListener('pagehide', onPageHide);
    deps.windowLike.removeEventListener('pageshow', onPageShow);
    if (flushTimer !== null) clearTimer(flushTimer);
  }

  /**
   * Production wiring calls this from a live signal (`AuthorityQueryContext`
   * via `registerPluginCommandEffectCookieAuthHandler`) whenever the derived
   * same-origin-cookie-auth eligibility could have changed.
   */
  function setCookieAuthEligible(eligible: boolean): void {
    cookieAuthEligible = eligible;
  }

  return {
    runCommand,
    cancelRequest,
    resetForAuthorityChange,
    setCookieAuthEligible,
    dispose,
    /** Test seam only. */
    _debug: {
      get documentId() {
        return documentId;
      },
      get documentKey() {
        return documentKey;
      },
      get inFlightCount() {
        return requests.size;
      },
      /** Decided records retained across an authority reset, still retrying. */
      get retainedSettlementCount() {
        return retainedSettlements.size;
      },
      flushNow: (options: { keepalive: boolean } = { keepalive: false }) =>
        flush(options),
    },
  };
}

export type PluginCommandEffectCoordinator = ReturnType<
  typeof createPluginCommandEffectCoordinator
>;
