import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { DelegationRoundsTransactionUncertainError } from '@kontourai/flow-agents/delegation-group-rounds';
import { canonicalJson } from '@kontourai/relay';
import type {
  InputRequestForm,
  InputRequestResponse,
} from '@kontourai/station-contracts/input-request';
import type { ProviderSendTurnInput } from '@kontourai/station-contracts/provider';
import type { ReportGroupReference } from '@kontourai/station-contracts/report-group';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  inspectSdkSourceWire,
  type SdkSourceCheck,
} from '../../services/orchestration/delegation-group-sdk-source-wire-owner.js';
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
  pending?: object;
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

function assertReservedStationTurnBinding(
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
function assertReservedStationEnvironment(
  handle: ReservedStationTurn,
  environmentId: string,
): void {
  if (state(handle).binding.environmentId !== environmentId) refuse();
}

async function admitReservedStationCheck<Value>(
  handle: ReservedStationTurn,
  check: () => Value,
): Promise<Value> {
  const value = states.get(handle);
  if (!value) refuse();
  const home =
    value.attempt.transport.launch.protocol === 'rounds-v1'
      ? value.attempt.transport.launch.reportHome
      : undefined;
  if (!home) {
    return check();
  }
  if (home.check)
    return home.check(value.attempt.transport.launch.finalizeCurrent, check);
  if (home.withHome)
    return home.withHome(
      value.attempt.transport.launch.finalizeCurrent,
      async (scope) => scope.check(check),
    );
  return home.owner.runRequest(value.attempt.transport.signal, check);
}

export async function admitReservedStationPublication(
  handle: ReservedStationTurn,
  publish: (check: SdkSourceCheck) => void,
): Promise<void> {
  const value = states.get(handle);
  if (!value) refuse();
  const home =
    value.attempt.transport.launch.protocol === 'rounds-v1'
      ? value.attempt.transport.launch.reportHome
      : undefined;
  const invoke = (check: SdkSourceCheck) => {
    check(() => state(handle));
    publish(check);
    return Promise.resolve();
  };
  if (home?.invokeCurrent)
    await home.invokeCurrent(
      value.attempt.transport.launch.finalizeCurrent,
      invoke,
    );
  else await invoke((work) => work());
}

export async function admitReservedStationTurnBinding(
  handle: ReservedStationTurn,
  principalId: string | undefined,
  threadId: string,
  recordedMode?: unknown,
): Promise<void> {
  await admitReservedStationCheck(handle, () =>
    assertReservedStationTurnBinding(
      handle,
      principalId,
      threadId,
      recordedMode,
    ),
  );
}

export async function admitReservedStationEnvironment(
  handle: ReservedStationTurn,
  environmentId: string,
): Promise<void> {
  await admitReservedStationCheck(handle, () =>
    assertReservedStationEnvironment(handle, environmentId),
  );
}

/** Only internal orchestration options carry this capability; never command JSON or metadata. */
export function withReservedStationTurn<T>(
  handle: ReservedStationTurn,
  principalId: string | undefined,
  threadId: string,
  work: () => T,
  check?: <Value>(work: () => Value) => Value,
): T {
  if (check)
    check(() =>
      assertReservedStationTurnBinding(handle, principalId, threadId),
    );
  else assertReservedStationTurnBinding(handle, principalId, threadId);
  if (context.getStore()) refuse();
  return context.run(handle, work);
}

export function currentReservedStationTurn(): ReservedStationTurn | undefined {
  return context.getStore();
}

function openReservedStationSession(
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

/** Queue only reserved-session metadata; the adapter publishes after this returns. */
export async function admitReservedStationSessionOpen(
  handle: ReservedStationTurn,
  threadId: string,
  recoveredIdentity?: string,
): Promise<{ hasInput: boolean; identity: string | undefined }> {
  return admitReservedStationCheck(handle, () => ({
    hasInput: reservedStationTurnHasInput(handle),
    identity: openReservedStationSession(threadId, recoveredIdentity),
  }));
}

export async function admitReservedStationSessionBinding(
  handle: ReservedStationTurn,
  threadId: string,
  record: object,
  isCurrent: () => boolean,
): Promise<ReservedStationSession | undefined> {
  return admitReservedStationCheck(handle, () =>
    bindReservedStationSession(threadId, record, isCurrent),
  );
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

function reservedStationTurnHasInput(handle: ReservedStationTurn): boolean {
  return state(handle).inputRuntime !== undefined;
}

export function executeReservedStationTurn(
  handle: ReservedStationTurn,
  input: ProviderSendTurnInput,
  nativeTurnId: string,
  sessionIdentity: string | undefined,
  sessionRecord: object,
  signal: AbortSignal,
  onTextDelta?: (text: string, check: SdkSourceCheck) => void,
  openInput?: (
    form: InputRequestForm,
    beforeOpen: Parameters<ReservedStationInputOpen>[1],
    signal: AbortSignal,
  ) => Promise<InputRequestResponse>,
  onComplete?: (result: Result, check: SdkSourceCheck) => void,
): Promise<Result> {
  const value = states.get(handle);
  if (!value) refuse();
  const expected = value.binding;
  const submitted = {
    threadId: input.threadId,
    clientTurnId: input.clientTurnId,
    input: input.input,
    displayInput: input.displayInput,
    modelId: input.modelId,
    hasAttachments: Boolean(input.attachments?.length),
    hasAmbientContext: Boolean(input.ambientContext),
    modelOptions: canonicalJson(input.modelOptions ?? {}),
  };
  const validate = () => {
    if (
      !value.opened ||
      sessionIdentity !== value.session?.resumeIdentity ||
      submitted.threadId !== expected.threadId ||
      submitted.clientTurnId !== expected.clientTurnId ||
      submitted.input !== expected.input ||
      (submitted.displayInput !== undefined &&
        submitted.displayInput !== expected.input) ||
      submitted.modelId !== expected.modelId ||
      submitted.hasAttachments ||
      submitted.hasAmbientContext ||
      submitted.modelOptions !== canonicalJson(expected.modelOptions ?? {})
    )
      refuse();
  };
  validate();
  if (value.claimed || value.pending) refuse();
  const pending = {};
  value.pending = pending;
  const executionSignal = AbortSignal.any([
    signal,
    value.attempt.transport.signal,
  ]);
  const assertSessionCurrent = (): undefined => {
    if (value.attempt.assertSessionCurrent)
      assertSynchronous(value.attempt.assertSessionCurrent);
    assertSession(value, sessionRecord);
    return undefined;
  };
  const result: Promise<Result> = Promise.resolve()
    .then(async () => {
      await admitReservedStationCheck(handle, () => {
        state(handle);
        if (value.pending !== pending || value.claimed) refuse();
        validate();
        assertSession(value, sessionRecord);
        executionSignal.throwIfAborted();
        value.claimed = true;
      });
      return runReservedSdkSourceAttempt({
        ...value.attempt,
        assertSessionCurrent,
        onTextDelta: (text, check) => {
          check(() => {
            assertSessionCurrent();
            executionSignal.throwIfAborted();
          });
          onTextDelta?.(text, check);
        },
        transport: {
          ...value.attempt.transport,
          signal: executionSignal,
        },
      });
    })
    .then(async (result) => {
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
    })
    .then(async (result) => {
      if (onComplete)
        await admitReservedStationPublication(handle, (check) =>
          onComplete(result, check),
        );
      return result;
    })
    .catch((error) => {
      if (
        !value.claimed &&
        value.pending === pending &&
        !(error instanceof DelegationRoundsTransactionUncertainError)
      ) {
        delete value.pending;
        if (value.result === result) delete value.result;
      }
      throw error;
    });
  value.result = result;
  void result.catch(() => {});
  return result;
}

/** Reauthorize disclosure independently of the asynchronous attempt's completion. */
export async function reservedStationTurnResult(
  handle: ReservedStationTurn,
): Promise<Result> {
  const value = states.get(handle);
  if (!value) refuse();
  const captured = await admitReservedStationCheck(handle, () => {
    state(handle);
    if (!value.result) refuse();
    return { result: value.result };
  });
  const result = await captured.result;
  const withHome =
    value.attempt.transport.launch.protocol === 'rounds-v1'
      ? value.attempt.transport.launch.reportHome?.withHome
      : undefined;
  if (withHome) {
    await withHome(
      value.attempt.transport.launch.finalizeCurrent,
      async (scope) => {
        scope.check(() => state(handle));
        await value.attempt.persistence.assertProviderEvidenceRetained(
          result.evidence,
          result.evidenceReference,
          scope.current,
        );
        scope.check(() => state(handle));
      },
    );
  } else {
    state(handle);
    await value.attempt.persistence.assertProviderEvidenceRetained(
      result.evidence,
      result.evidenceReference,
      value.attempt.transport.launch.finalizeCurrent,
    );
    state(handle);
  }
  return result;
}

export function assertReservedStationTurnCurrent(
  handle: ReservedStationTurn,
): void {
  state(handle);
}
