import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { DispatchReceipt } from '@kontourai/dispatch';
import type { NativeOutputRelayCompanion } from '../native-output-turn-grant.js';
import type { NativeMemoryHistoryCompanion } from './native-memory-history.js';

/**
 * The only correlation Station carries from an authorized orchestration turn
 * into the Station-engine model invocation. It is deliberately an identity
 * envelope, not a request envelope: prompts, transcript content, tool data,
 * paths, credentials, and provider bodies have no field here.
 *
 * `turnId` is minted by the authorized orchestration seam before the
 * Station-agent adapter starts the turn, then becomes that adapter's canonical
 * turn id. `correlationId` is a separately stable id for a future durable
 * operation adapter; it is never inferred from timing, a plan digest, or a
 * display name.
 */
export interface AuthorizedTurnCorrelation {
  accountId: string;
  sessionId: string;
  turnId: string;
  correlationId: string;
}

/** Internal-only relay header; its opaque value is valid for one handoff. */
export const INTERNAL_TURN_CORRELATION_HEADER =
  'x-station-authorized-turn-correlation';

const MAX_CORRELATION_ID_LENGTH = 512;
const turnCorrelations = new AsyncLocalStorage<{
  correlation: AuthorizedTurnCorrelation;
  nativeMemory?: NativeMemoryHistoryCompanion;
}>();
const relayHandoffs = new Map<
  string,
  {
    correlation: AuthorizedTurnCorrelation;
    nativeOutput?: NativeOutputRelayCompanion;
    nativeMemory?: NativeMemoryHistoryCompanion;
    expiresAt: number;
  }
>();
const MAX_RELAY_HANDOFFS = 128;
const RELAY_HANDOFF_TTL_MS = 60_000;

function boundedIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_CORRELATION_ID_LENGTH &&
    value.trim() === value
  );
}

/**
 * Rejects malformed or widened relay payloads. A partial or extra-keyed
 * context is not "close enough": the fleet observer must receive an exact
 * authorized coordinate or no coordinate at all.
 */
export function parseAuthorizedTurnCorrelation(
  value: unknown,
): AuthorizedTurnCorrelation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 4 ||
    !keys.every((key) =>
      ['accountId', 'sessionId', 'turnId', 'correlationId'].includes(key),
    ) ||
    !boundedIdentifier(record.accountId) ||
    !boundedIdentifier(record.sessionId) ||
    !boundedIdentifier(record.turnId) ||
    !boundedIdentifier(record.correlationId)
  ) {
    return undefined;
  }
  return Object.freeze({
    accountId: record.accountId,
    sessionId: record.sessionId,
    turnId: record.turnId,
    correlationId: record.correlationId,
  });
}

function correlationDigest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/**
 * Hosted tenants can legitimately contain an account with the same text id.
 * Scope it before any durable Action consumer sees it, rather than relying on
 * every future reader to remember a separate tenant comparison. Personal
 * Station accounts keep their existing exact id for compatibility with the
 * local-only authorization surface.
 */
export function tenantQualifiedAccountId(
  accountId: string,
  tenantId: string | undefined,
): string {
  if (!tenantId) return accountId;
  return `tenant-account:${correlationDigest(['tenant-account/v1', tenantId, accountId])}`;
}

/**
 * Mints the exact Station coordinate at the authorized orchestration
 * boundary. A client idempotency key is already the durable replay
 * coordinate, so redelivery derives the SAME turn/correlation ids instead of
 * minting another random Action row. Unkeyed sends intentionally stay random:
 * there is no proof that two such requests are the same turn.
 */
export function createAuthorizedTurnCorrelation(input: {
  accountId: string;
  tenantId?: string;
  sessionId: string;
  clientTurnId?: string;
}): AuthorizedTurnCorrelation {
  const accountId = tenantQualifiedAccountId(input.accountId, input.tenantId);
  const stable =
    typeof input.clientTurnId === 'string' && input.clientTurnId.trim() !== ''
      ? correlationDigest([
          'authorized-turn/v1',
          accountId,
          input.sessionId,
          input.clientTurnId,
        ])
      : undefined;
  const correlation = parseAuthorizedTurnCorrelation({
    accountId,
    sessionId: input.sessionId,
    turnId: stable ? `turn:${stable}` : randomUUID(),
    correlationId: stable ? `fleet:${stable}` : randomUUID(),
  });
  if (!correlation) throw new TypeError('Invalid authorized turn correlation');
  return correlation;
}

/**
 * Mints an in-process capability for the Station-agent's loopback
 * HTTP relay. The header carries no identity fields at all: a caller who has
 * an internal token but did not cross the authorized orchestration seam
 * cannot manufacture a turn correlation. Expiry and bounded FIFO eviction
 * keep a failed relay from retaining a process-local map indefinitely.
 */
export function issueAuthorizedTurnCorrelationHandoff(
  correlation: AuthorizedTurnCorrelation,
  nativeOutput?: NativeOutputRelayCompanion,
  nativeMemory?: NativeMemoryHistoryCompanion,
): string {
  const exact = parseAuthorizedTurnCorrelation(correlation);
  if (!exact) {
    throw new TypeError('Invalid authorized turn correlation');
  }
  const now = Date.now();
  for (const [id, handoff] of relayHandoffs) {
    if (handoff.expiresAt <= now) relayHandoffs.delete(id);
  }
  if (relayHandoffs.size >= MAX_RELAY_HANDOFFS) {
    const oldest = relayHandoffs.keys().next().value;
    if (oldest !== undefined) relayHandoffs.delete(oldest);
  }
  const handoffId = randomUUID();
  relayHandoffs.set(handoffId, {
    correlation: exact,
    ...(nativeOutput ? { nativeOutput } : {}),
    ...(nativeMemory ? { nativeMemory } : {}),
    expiresAt: now + RELAY_HANDOFF_TTL_MS,
  });
  return handoffId;
}

/** The matching private grant companion; identity is never serialized. */
export function readNativeOutputRelayCompanion(
  handoffId: string | undefined,
): NativeOutputRelayCompanion | undefined {
  if (!handoffId || handoffId.length > 128) return undefined;
  const handoff = relayHandoffs.get(handoffId);
  if (!handoff || handoff.expiresAt <= Date.now()) return undefined;
  return handoff.nativeOutput;
}

/** Private history access travels only with its existing opaque relay handoff. */
export function readNativeMemoryRelayCompanion(
  handoffId: string | undefined,
): NativeMemoryHistoryCompanion | undefined {
  if (!handoffId || handoffId.length > 128) return undefined;
  const handoff = relayHandoffs.get(handoffId);
  if (!handoff || handoff.expiresAt <= Date.now()) return undefined;
  return handoff.nativeMemory;
}

/**
 * Reads a bounded relay capability without consuming it. Internal fetch may
 * redeliver the same request after a transport failure; every delivery must
 * recover the same exact coordinate so the observer can reuse its stable
 * operation rather than manufacture a duplicate. The value is opaque and
 * valid only while this process retains the originating handoff.
 */
export function readAuthorizedTurnCorrelationHandoff(
  handoffId: string | undefined,
): AuthorizedTurnCorrelation | undefined {
  if (!handoffId || handoffId.length > 128) return undefined;
  const handoff = relayHandoffs.get(handoffId);
  if (!handoff) return undefined;
  if (handoff.expiresAt <= Date.now()) {
    relayHandoffs.delete(handoffId);
    return undefined;
  }
  return handoff.correlation;
}

/** Runs one model-facing request under its exact authorized turn coordinate. */
export function runWithAuthorizedTurnCorrelation<T>(
  correlation: AuthorizedTurnCorrelation,
  work: () => T,
  nativeMemory?: NativeMemoryHistoryCompanion,
): T {
  return turnCorrelations.run(
    { correlation, ...(nativeMemory ? { nativeMemory } : {}) },
    work,
  );
}

/** The current request-scoped correlation, never reconstructed from a receipt. */
export function currentAuthorizedTurnCorrelation():
  | AuthorizedTurnCorrelation
  | undefined {
  return turnCorrelations.getStore()?.correlation;
}

/** Not reconstructed from public options, cursor data, or a serialized identity. */
export function currentNativeMemoryHistory():
  | NativeMemoryHistoryCompanion
  | undefined {
  return turnCorrelations.getStore()?.nativeMemory;
}

/**
 * Narrow observer seam for the durable Action layer (archive#3841) to bind later.
 * Dispatch and fleet receipts remain authoritative; an observer is only a
 * progress/custody projection and its failures must never alter a turn.
 */
export interface FleetDispatchCorrelationObserver {
  begin(input: AuthorizedFleetDispatchBegin): void | Promise<void>;
  settle(input: AuthorizedFleetDispatchSettlement): void | Promise<void>;
}

export interface AuthorizedFleetDispatchBegin
  extends AuthorizedTurnCorrelation {
  planDigest: string;
}

export interface AuthorizedFleetDispatchSettlement
  extends AuthorizedFleetDispatchBegin {
  receiptId: string;
  outcome: DispatchReceipt['outcome'];
}
