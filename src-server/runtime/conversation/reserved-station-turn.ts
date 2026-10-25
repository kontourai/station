import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { canonicalJson } from '@kontourai/relay';
import type {
  InputRequestForm,
  InputRequestResponse,
} from '@kontourai/station-contracts/input-request';
import type { ProviderSendTurnInput } from '@kontourai/station-contracts/provider';
import type { ReportGroupReference } from '@kontourai/station-contracts/report-group';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { inspectSdkSourceWire } from '../../services/orchestration/delegation-group-sdk-source-wire-owner.js';
import {
  assertSynchronous,
  wireIdentityDigest,
} from '../../services/orchestration/delegation-group-wire-intent-store.js';
import type { ReportInputBinding } from '../../services/orchestration/report-input-ledger.js';
import { boundedApiUsesReportInput } from './bounded-api-provider-contract.js';
import { runReservedSdkSourceAttempt } from './reserved-sdk-source-attempt.js';

const sessionBrand = Symbol('reserved Station Session');
export type ReservedStationSession = Readonly<{ [sessionBrand]: true }>;
const brand = Symbol('reserved Station turn');
export type ReservedStationTurn = Readonly<{ [brand]: true }>;
type Attempt = Parameters<typeof runReservedSdkSourceAttempt>[0];
type InputReceipt = ReportGroupReference & {
  domain: 'station.report-input.v1';
};
type Result = Awaited<ReturnType<typeof runReservedSdkSourceAttempt>> & {
  inputReceipt?: InputReceipt;
};
// UNWIRED(#91): production preparation still needs the accounted ordinary-MCP input runtime.
export type ReservedStationInputOpen = (
  form: InputRequestForm,
  beforeOpen: (
    event: Extract<CanonicalRuntimeEvent, { method: 'request.opened' }>,
  ) => Promise<void>,
  signal?: AbortSignal,
) => Promise<InputRequestResponse>;
export type ReservedStationInputRuntime = (
  request: Readonly<{
    id: string;
    question: string;
    providerEvidence: Result['evidenceReference'];
    binding: ReportInputBinding;
  }>,
  open: ReservedStationInputOpen,
  signal: AbortSignal,
  current: () => undefined,
) => Promise<InputReceipt> | Promise<void>;
type Binding = Readonly<{
  principalId: string;
  environmentId: string;
  threadId: string;
  clientTurnId: string;
  input: string;
  modelId: string;
  modelOptions?: Record<string, unknown>;
}>;
type SessionRecipient = Readonly<{
  hostId: string;
  recipientId: string;
  generation: number;
  executionId: string;
  sessionReceipt: Readonly<{
    id: string;
    domain: 'station.reserved-session.v1';
    digest: string;
  }>;
}>;
type SessionState = Readonly<{
  binding: Pick<Binding, 'principalId' | 'environmentId' | 'threadId'>;
  record: object;
  isCurrent(): boolean;
  recipient: SessionRecipient;
  resumeIdentity: string;
  outputDelivery: 'buffered' | 'streamed';
  namespace: string;
  modelId: string;
  modelOptions: string;
  clientTurns: Set<string>;
}>;
const sessions = new WeakMap<ReservedStationSession, SessionState>();
type State = {
  binding: Binding;
  attempt: Attempt;
  identity: string;
  opened: boolean;
  claimed: boolean;
  session?: SessionState;
  result?: Promise<Result>;
  inputRuntime?: ReservedStationInputRuntime;
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

function sessionNamespace(attempt: Attempt): string {
  const reservation = attempt.transport.reservation;
  return wireIdentityDigest([
    reservation.groupId,
    reservation.seatId,
    reservation.authority.id,
    reservation.controller,
  ]);
}

// UNWIRED(#91): retained-Session turns still need fresh source and wire admission.
/** This handoff grants no model invocation: execution still passes the durable final wire fence. */
export function prepareReservedStationTurn(
  binding: Binding,
  attempt: Attempt,
  retainedSession?: ReservedStationSession,
  inputRuntime?: ReservedStationInputRuntime,
): ReservedStationTurn {
  if (preparedHandles.has(attempt.sdkHandle)) refuse();
  if (
    Boolean(inputRuntime) !==
    boundedApiUsesReportInput(
      attempt.transport.contract,
      attempt.transport.now(),
    )
  )
    refuse();
  const captured = structuredClone(binding);
  if (
    [
      captured.principalId,
      captured.environmentId,
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
  const prepared = inspectSdkSourceWire(attempt.sdkOwner, attempt.sdkHandle);
  if (prepared.sourceBinding.hostContextId !== captured.environmentId) refuse();
  const wire = prepared.wire;
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
  const retained = retainedSession ? sessions.get(retainedSession) : undefined;
  if (retainedSession) {
    if (
      retained?.isCurrent() !== true ||
      canonicalJson(retained.binding) !==
        canonicalJson({
          principalId: captured.principalId,
          environmentId: captured.environmentId,
          threadId: captured.threadId,
        }) ||
      retained.namespace !== sessionNamespace(frozenAttempt) ||
      retained.modelId !== captured.modelId ||
      retained.outputDelivery !== prepared.outputDelivery ||
      retained.modelOptions !== canonicalJson(captured.modelOptions ?? {}) ||
      retained.clientTurns.has(captured.clientTurnId) ||
      retained.clientTurns.size >= 128
    )
      refuse();
    retained.clientTurns.add(captured.clientTurnId);
  }
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
    opened: retained !== undefined,
    claimed: false,
    ...(inputRuntime ? { inputRuntime } : {}),
    ...(retained ? { session: retained } : {}),
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
      recordedMode.identity !==
        (value.session?.resumeIdentity ?? value.identity))
  )
    refuse();
}

/** A canonical current-Station lookup must still name the prepared source host. */
export function assertReservedStationEnvironment(
  handle: ReservedStationTurn,
  environmentId: string,
): void {
  if (state(handle).binding.environmentId !== environmentId) refuse();
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

/** Bind the turn to the adapter-owned record, never a serialized resume cursor. */
export function bindReservedStationSession(
  threadId: string,
  record: object,
  isCurrent: () => boolean,
): ReservedStationSession | undefined {
  const handle = context.getStore();
  if (!handle) return undefined;
  const value = state(handle);
  if (
    !value.opened ||
    value.claimed ||
    value.session ||
    value.binding.threadId !== threadId ||
    isCurrent() !== true
  )
    refuse();
  const recipientId = `station-recipient:${randomUUID()}`;
  const facts = [
    value.binding.principalId,
    value.binding.environmentId,
    threadId,
    value.identity,
    recipientId,
  ];
  value.session = Object.freeze({
    binding: Object.freeze({
      principalId: value.binding.principalId,
      environmentId: value.binding.environmentId,
      threadId,
    }),
    record,
    isCurrent,
    resumeIdentity: value.identity,
    outputDelivery: inspectSdkSourceWire(
      value.attempt.sdkOwner,
      value.attempt.sdkHandle,
    ).outputDelivery,
    namespace: sessionNamespace(value.attempt),
    modelId: value.binding.modelId,
    modelOptions: canonicalJson(value.binding.modelOptions ?? {}),
    clientTurns: new Set([value.binding.clientTurnId]),
    recipient: Object.freeze({
      hostId: value.binding.environmentId,
      recipientId,
      generation: 1,
      executionId: threadId,
      sessionReceipt: Object.freeze({
        id: recipientId,
        domain: 'station.reserved-session.v1',
        digest: wireIdentityDigest(facts),
      }),
    }),
  });
  const session: ReservedStationSession = Object.freeze({
    [sessionBrand]: true,
  });
  sessions.set(session, value.session);
  return session;
}

/** Observation only: a retained receipt cannot recreate an adapter activation. */
export function reservedStationRecipient(
  handle: ReservedStationTurn,
): SessionRecipient {
  const value = state(handle);
  if (!value.session) refuse();
  assertSession(value, value.session.record);
  return structuredClone(value.session.recipient);
}

/** A new request must authenticate its own scope; this only observes the actual activation. */
export function reservedStationSessionRecipient(
  session: ReservedStationSession,
  expected: SessionState['binding'],
): SessionRecipient {
  return structuredClone(currentSession(session, expected).recipient);
}

/** Preserve the actual activation's wire mode when preparing a returning turn. */
export function reservedStationSessionOutputDelivery(
  session: ReservedStationSession,
  expected: SessionState['binding'],
): 'buffered' | 'streamed' {
  return currentSession(session, expected).outputDelivery;
}

function currentSession(
  session: ReservedStationSession,
  expected: SessionState['binding'],
): SessionState {
  const value = sessions.get(session);
  if (
    !value ||
    canonicalJson(value.binding) !== canonicalJson(expected) ||
    value.isCurrent() !== true
  )
    refuse();
  return value;
}

function assertSession(value: State, record: object): void {
  if (
    !value.session ||
    value.session.record !== record ||
    value.session.isCurrent() !== true
  )
    refuse();
}

export function reservedStationTurnHasInput(
  handle: ReservedStationTurn,
): boolean {
  return state(handle).inputRuntime !== undefined;
}

export function executeReservedStationTurn(
  handle: ReservedStationTurn,
  input: ProviderSendTurnInput,
  nativeTurnId: string,
  sessionIdentity: string | undefined,
  sessionRecord: object,
  signal: AbortSignal,
  onTextDelta?: (text: string) => void,
  openInput?: (
    form: InputRequestForm,
    beforeOpen: Parameters<ReservedStationInputOpen>[1],
    signal: AbortSignal,
  ) => Promise<InputRequestResponse>,
): Promise<Result> {
  const value = state(handle);
  const expected = value.binding;
  if (
    value.claimed ||
    !value.opened ||
    sessionIdentity !== value.session?.resumeIdentity ||
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
  const executionSignal = AbortSignal.any([
    signal,
    value.attempt.transport.signal,
  ]);
  assertSession(value, sessionRecord);
  executionSignal.throwIfAborted();
  value.claimed = true;
  const assertSessionCurrent = (): undefined => {
    if (value.attempt.assertSessionCurrent)
      assertSynchronous(value.attempt.assertSessionCurrent);
    assertSession(value, sessionRecord);
    return undefined;
  };
  value.result = runReservedSdkSourceAttempt({
    ...value.attempt,
    assertSessionCurrent,
    onTextDelta: (text) => {
      assertSessionCurrent();
      executionSignal.throwIfAborted();
      onTextDelta?.(text);
    },
    transport: {
      ...value.attempt.transport,
      signal: executionSignal,
    },
  }).then(async (result) => {
    if (result.sdkResult.inputRequest) {
      assertSessionCurrent();
      executionSignal.throwIfAborted();
      if (!value.inputRuntime || !openInput) refuse();
      const inputReceipt = await value.inputRuntime(
        Object.freeze({
          ...result.sdkResult.inputRequest,
          providerEvidence: result.evidenceReference,
          binding: {
            groupId: result.evidence.intent.groupId,
            rootId: result.evidence.intent.root.id,
            executionId: result.evidence.intent.executionId,
            authority: structuredClone(result.evidence.intent.root),
            envelope: structuredClone(result.evidence.intent.envelope),
            seatId: result.evidence.intent.seatId,
            invocationId: result.evidence.intent.invocationId,
            usage: {
              inputTokens: result.accounting.inputTokens,
              outputTokens: result.accounting.outputTokens,
              costMicros: result.accounting.costMicros,
            },
            providerToolCallId: result.sdkResult.inputRequest.id,
            providerEvidence: result.evidenceReference,
            threadId: expected.threadId,
            turnId: nativeTurnId,
            recipient: structuredClone(value.session!.recipient),
            question: result.sdkResult.inputRequest.question,
          },
        }),
        (() => {
          let opened = false;
          return (form, beforeOpen, requestSignal) => {
            if (opened) refuse();
            assertSessionCurrent();
            executionSignal.throwIfAborted();
            opened = true;
            return openInput(
              form,
              beforeOpen,
              requestSignal
                ? AbortSignal.any([executionSignal, requestSignal])
                : executionSignal,
            );
          };
        })(),
        executionSignal,
        () => {
          state(handle);
          assertSessionCurrent();
          executionSignal.throwIfAborted();
          return undefined;
        },
      );
      assertSessionCurrent();
      executionSignal.throwIfAborted();
      return { ...result, ...(inputReceipt ? { inputReceipt } : {}) };
    }
    return result;
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
