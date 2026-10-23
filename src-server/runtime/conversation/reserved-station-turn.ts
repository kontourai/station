import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalJson } from '@kontourai/relay';
import type { ProviderSendTurnInput } from '@kontourai/station-contracts/provider';
import { inspectSdkSourceWire } from '../../services/orchestration/delegation-group-sdk-source-wire-owner.js';
import {
  assertSynchronous,
  wireIdentityDigest,
} from '../../services/orchestration/delegation-group-wire-intent-store.js';
import { runReservedSdkSourceAttempt } from './reserved-sdk-source-attempt.js';

const brand = Symbol('reserved Station turn');
export type ReservedStationTurn = Readonly<{ [brand]: true }>;
type Attempt = Parameters<typeof runReservedSdkSourceAttempt>[0];
type Result = Awaited<ReturnType<typeof runReservedSdkSourceAttempt>>;
type Binding = Readonly<{
  principalId: string;
  threadId: string;
  clientTurnId: string;
  input: string;
  modelId: string;
  modelOptions?: Record<string, unknown>;
}>;
type State = {
  binding: Binding;
  attempt: Attempt;
  identity: string;
  opened: boolean;
  claimed: boolean;
  result?: Promise<Result>;
};
const states = new WeakMap<ReservedStationTurn, State>();
const preparedHandles = new WeakSet<object>();
const context = new AsyncLocalStorage<ReservedStationTurn>();

export class ReservedStationTurnUnavailable extends Error {
  readonly code = 'reserved_station_turn_unavailable';
  constructor() {
    super('Reserved Station turn is unavailable.');
  }
}
function refuse(): never {
  throw new ReservedStationTurnUnavailable();
}
function state(handle: ReservedStationTurn): State {
  const value = states.get(handle);
  if (!value) refuse();
  assertSynchronous(value.attempt.transport.launch.finalizeCurrent);
  return value;
}

// UNWIRED(#91): boot preparation and provider qualification must issue this private port.
/** This handoff cannot reserve capacity: execution still passes the durable final wire fence. */
export function prepareReservedStationTurn(
  binding: Binding,
  attempt: Attempt,
): ReservedStationTurn {
  if (preparedHandles.has(attempt.sdkHandle)) refuse();
  const captured = structuredClone(binding);
  if (
    [
      captured.principalId,
      captured.threadId,
      captured.clientTurnId,
      captured.modelId,
    ].some(
      (value) => typeof value !== 'string' || !value || value.length > 512,
    ) ||
    typeof captured.input !== 'string' ||
    Buffer.byteLength(captured.input) > 65536
  )
    refuse();
  const wire = inspectSdkSourceWire(attempt.sdkOwner, attempt.sdkHandle).wire;
  const body = JSON.parse(wire.body);
  const instruction =
    attempt.transport.provider === 'anthropic'
      ? body.messages?.[0]?.content?.[0]?.text
      : body.contents?.[0]?.parts?.[0]?.text;
  if (
    typeof instruction !== 'string' ||
    JSON.parse(instruction).brief !== captured.input
  )
    refuse();
  const wireModel =
    attempt.transport.provider === 'anthropic'
      ? body.model
      : new URL(wire.url).pathname.split('/models/')[1]?.split(':')[0];
  if (wireModel !== captured.modelId) refuse();
  const frozenAttempt: Attempt = {
    ...attempt,
    transport: {
      ...attempt.transport,
      reservation: structuredClone(attempt.transport.reservation),
      launch: { ...attempt.transport.launch },
    },
  };
  const handle: ReservedStationTurn = Object.freeze({ [brand]: true });
  const reservation = frozenAttempt.transport.reservation;
  states.set(handle, {
    binding: captured,
    attempt: frozenAttempt,
    identity: wireIdentityDigest([
      reservation.groupId,
      reservation.seatId,
      reservation.authority,
      reservation.envelope,
    ]),
    opened: false,
    claimed: false,
  });
  preparedHandles.add(attempt.sdkHandle);
  return handle;
}

export function assertReservedStationTurnBinding(
  handle: ReservedStationTurn,
  principalId: string | undefined,
  threadId: string,
  recordedMode?: unknown,
): void {
  const value = state(handle);
  if (
    value.binding.principalId !== principalId ||
    value.binding.threadId !== threadId
  )
    refuse();
  if (
    recordedMode !== undefined &&
    (!recordedMode ||
      typeof recordedMode !== 'object' ||
      !('identity' in recordedMode) ||
      recordedMode.identity !== value.identity)
  )
    refuse();
}

/** Only internal orchestration options carry this capability; never command JSON or metadata. */
export function withReservedStationTurn<T>(
  handle: ReservedStationTurn,
  principalId: string | undefined,
  threadId: string,
  work: () => T,
): T {
  assertReservedStationTurnBinding(handle, principalId, threadId);
  if (context.getStore()) refuse();
  return context.run(handle, work);
}

export function currentReservedStationTurn(): ReservedStationTurn | undefined {
  return context.getStore();
}

export function openReservedStationSession(
  threadId: string,
  recoveredIdentity?: string,
): string | undefined {
  const handle = context.getStore();
  if (!handle) return undefined;
  const value = state(handle);
  if (
    value.opened ||
    value.claimed ||
    value.binding.threadId !== threadId ||
    (recoveredIdentity !== undefined && recoveredIdentity !== value.identity)
  )
    refuse();
  value.opened = true;
  return value.identity;
}

export function executeReservedStationTurn(
  handle: ReservedStationTurn,
  input: ProviderSendTurnInput,
  sessionIdentity: string | undefined,
  signal: AbortSignal,
): Promise<Result> {
  const value = state(handle);
  const expected = value.binding;
  if (
    value.claimed ||
    !value.opened ||
    sessionIdentity !== value.identity ||
    input.threadId !== expected.threadId ||
    input.clientTurnId !== expected.clientTurnId ||
    input.input !== expected.input ||
    (input.displayInput !== undefined &&
      input.displayInput !== expected.input) ||
    input.modelId !== expected.modelId ||
    input.attachments?.length ||
    input.ambientContext ||
    canonicalJson(input.modelOptions ?? {}) !==
      canonicalJson(expected.modelOptions ?? {})
  )
    refuse();
  signal.throwIfAborted();
  value.claimed = true;
  value.result = runReservedSdkSourceAttempt({
    ...value.attempt,
    transport: {
      ...value.attempt.transport,
      signal: AbortSignal.any([signal, value.attempt.transport.signal]),
    },
  });
  void value.result.catch(() => {});
  return value.result;
}

/** Reauthorize disclosure independently of the asynchronous attempt's completion. */
export async function reservedStationTurnResult(
  handle: ReservedStationTurn,
): Promise<Result> {
  const value = state(handle);
  if (!value.result) refuse();
  const result = await value.result;
  state(handle);
  await value.attempt.persistence.assertProviderEvidenceRetained(
    result.evidence,
    result.evidenceReference,
    value.attempt.transport.launch.finalizeCurrent,
  );
  state(handle);
  return result;
}

export function assertReservedStationTurnCurrent(
  handle: ReservedStationTurn,
): void {
  state(handle);
}
