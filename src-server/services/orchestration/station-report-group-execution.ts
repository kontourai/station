import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { AuthorizationLedger } from '@kontourai/dispatch';
import { loadRun, withRunMutationLock } from '@kontourai/flow';
import { createDelegationAuthorityServiceV3 } from '@kontourai/flow-agents/delegation-authority-service-v3';
import {
  type DelegationEnvelopeV2,
  delegationEnvelopeDigestV2,
  rootAuthorityReferenceV2,
} from '@kontourai/flow-agents/delegation-envelope-v2';
import { assertDelegationFlowRuntime } from '@kontourai/flow-agents/delegation-flow-runtime';
import {
  createDelegationRoundsController,
  type DelegationRoundsHost,
  type DelegationRoundsSpec,
  DelegationRoundsTransactionUncertainError,
  type RoundSeat,
} from '@kontourai/flow-agents/delegation-group-rounds';
import { canonicalJson, type ModelRuntime } from '@kontourai/relay';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import type { reservedStationTurnResult } from '../../runtime/conversation/reserved-station-turn.js';
import { outsideStationServerScope } from '../../security/station-server-scope.js';
import type { DelegatedTaskHandle } from '../../tools/station-control-delegation.js';
import type { EnvironmentSecurityService } from '../ssh/environment-security-service.js';
import { HomeWriterOwner } from '../ssh/home-writer-owner.js';
import type {
  PreparedReservedFinalFetchOwners,
  RoundsFinalFetchOwners,
} from './delegation-group-launch-fence.js';
import type { StationDelegationPersistence } from './delegation-group-persistence.js';
import {
  inspectSdkSourceWire,
  retireSdkSourceWire,
} from './delegation-group-sdk-source-wire-owner.js';
import type { RuntimeSourceRequestContext } from './delegation-group-source-admission.js';
import type { FileFinalWireIntentStore } from './delegation-group-wire-intent-store.js';
import type { OrchestrationService } from './orchestration-service.js';
import type {
  ReportRoundsPublication,
  ReportRoundsScope,
} from './report-rounds-publication.js';
import type { StationReportGroupCustody } from './station-report-group-custody.js';
import { parseStationReportGroupInput } from './station-report-group-input.js';
import {
  type PreparedStationReportGroup,
  type StationReportGroupPreparation,
} from './station-report-group-preparation.js';
import { captureReportTerminalWitness } from './station-report-terminal-witness.js';

const same = (left: unknown, right: unknown) =>
  canonicalJson(left) === canonicalJson(right);
const digest = (value: unknown) =>
  `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
class StationReportExecutionUnavailable extends Error {
  readonly code = 'group_execution_unavailable';
  constructor() {
    super('Report group execution is unavailable.');
  }
}
function refuse(): never {
  throw new StationReportExecutionUnavailable();
}
type AttemptResult = Awaited<ReturnType<typeof reservedStationTurnResult>>;
type Retained = {
  attempt: AttemptResult;
  task: DelegatedTaskHandle;
  recipient: Awaited<
    ReturnType<StationReportGroupPreparation['dispatch']>
  >['recipient'];
  envelopeId: string;
};

export class StationReportGroupExecution {
  readonly #claimed = new WeakSet<PreparedStationReportGroup>();
  constructor(
    private readonly owners: {
      preparation:
        | StationReportGroupPreparation
        | (() => Promise<StationReportGroupPreparation>);
      custody: StationReportGroupCustody;
      persistence: StationDelegationPersistence;
      orchestration: OrchestrationService;
      dispatchLedger: AuthorizationLedger;
      wireIntents: FileFinalWireIntentStore;
      environment: EnvironmentSecurityService;
      authorize(
        context: RuntimeSourceRequestContext,
        publication?: ReportRoundsPublication,
      ): Promise<() => void>;
    },
  ) {
    this.owners = Object.freeze({ ...owners });
  }

  async execute(
    context: RuntimeSourceRequestContext,
    sent: unknown,
    publication?: ReportRoundsPublication,
  ) {
    const input = parseStationReportGroupInput(sent);
    const { custody, persistence, orchestration } = this.owners;
    const existing = await custody.findOperationForMutation(
      context,
      input.operationId,
      publication,
    );
    if (existing) {
      if (existing.admission.root.revisions.policy.digest !== digest(input))
        refuse();
      return { replayed: true, group: existing };
    }
    if (input.flow)
      assertDelegationFlowRuntime({ loadRun, withRunMutationLock });
    const requestCurrent = await this.owners.authorize(context, publication);
    const preparation =
      typeof this.owners.preparation === 'function'
        ? await this.owners.preparation()
        : this.owners.preparation;
    const handle = await preparation.prepare(context, input);
    if (this.#claimed.has(handle)) refuse();
    this.#claimed.add(handle);
    const deadline = new AbortController();
    const timer = outsideStationServerScope(() =>
      setTimeout(
        () => deadline.abort(),
        Math.max(1, input.deadlineAt - Date.now()),
      ),
    );
    const signal = AbortSignal.any([context.req.raw.signal, deadline.signal]);
    try {
      const requestWriter = await HomeWriterOwner.forHome(
        this.owners.environment.getProjectHomeDir(),
      );
      const prepared = preparation.read(handle, context.req.raw);
      const groupId = await custody.retain(
        context,
        preparation,
        handle,
        publication,
      );
      const current = (): undefined => {
        publication?.assertCurrent();
        requestCurrent();
        return undefined;
      };
      const metadataCurrent = (): undefined =>
        this.owners.environment.withCurrentAuthority(() => {
          current();
          signal.throwIfAborted();
          return undefined;
        });
      const assertPreparedSource = (): undefined => {
        preparation.assertCurrent(handle, context.req.raw);
        return undefined;
      };
      const sourceCurrent = (): undefined =>
        this.owners.environment.withCurrentAuthority(() => {
          requestCurrent();
          signal.throwIfAborted();
          return assertPreparedSource();
        });
      const executionCurrent = (): undefined => {
        publication?.assertCurrent();
        return sourceCurrent();
      };
      const assertReturnedPreparation = (scope: ReportRoundsScope): void => {
        try {
          scope.check(assertPreparedSource);
        } catch (error) {
          throw new DelegationRoundsTransactionUncertainError(
            'returned-cleanup-unknown',
            [error],
          );
        }
      };
      const retained = new Map<string, Retained>();
      const invocation = new AsyncLocalStorage<{
        envelope: DelegationEnvelopeV2;
        id: string;
      }>();
      const flow = await requestWriter.runRequest(signal, () =>
        preparation.flow(handle, context.req.raw),
      );
      const readSchedule = () =>
        flow
          ? publication
            ? publication.withHome(
                { owner: requestWriter, current: sourceCurrent },
                (scope) => flow.readSchedule(scope),
              )
            : flow.readSchedule()
          : Promise.resolve(undefined);
      const schedule = await readSchedule();
      await requestWriter.runRequest(signal, current);
      const build = (scope?: ReportRoundsScope) => {
        const current = scope
          ? () => scope.check(assertPreparedSource)
          : () => {
              requestCurrent();
              publication?.assertCurrent();
              return undefined;
            };
        const transactionCurrent = scope?.current ?? current;
        const preparationCurrent = scope ? current : executionCurrent;
        const dispatchCurrent = scope?.current ?? metadataCurrent;
        const check = <Value>(body: () => Value): Value =>
          scope
            ? scope.check(body)
            : this.owners.environment.withCurrentAuthority(body);
        const checkAsync = <Value>(body: () => Value): Promise<Value> =>
          scope
            ? Promise.resolve(check(body))
            : requestWriter.runRequest(signal, () => check(body));
        const memberFor = (envelope: DelegationEnvelopeV2) =>
          check(() => {
            current();
            const member = prepared.members.find(
              (m) => m.taskId === envelope.execution_id,
            );
            const seat = prepared.spec.seats.find(
              (s) => s.seatId === member?.seatId,
            );
            if (
              !member ||
              !seat ||
              !preparation.authorizes(
                handle,
                context.req.raw,
                prepared.root,
                envelope,
              )
            )
              refuse();
            return { member, seat };
          });
        const host = {
          now: () => new Date(Date.now()).toISOString(),
          authorize: async (
            _action: unknown,
            root: typeof prepared.root,
            envelope: DelegationEnvelopeV2 | null,
          ) =>
            check(() =>
              preparation.authorizes(handle, context.req.raw, root, envelope),
            ),
          confirmExecution: async (envelope: DelegationEnvelopeV2) =>
            check(() =>
              preparation.confirmsExecution(handle, context.req.raw, envelope),
            ),
          confirmReconciliation: async (candidate: {
            invocationId: string;
            envelopeId: string;
            usage: unknown;
            terminal: boolean;
          }) => {
            current();
            const result = retained.get(candidate.invocationId);
            if (!result) return false;
            await persistence.assertProviderEvidenceRetained(
              result.attempt.evidence,
              result.attempt.evidenceReference,
              current,
            );
            return (
              !!result &&
              candidate.envelopeId === result.envelopeId &&
              candidate.terminal &&
              same(candidate.usage, {
                inputTokens: result.attempt.accounting.inputTokens,
                outputTokens: result.attempt.accounting.outputTokens,
                costMicros: result.attempt.accounting.costMicros,
              })
            );
          },
          authenticateRenewal: async () => null,
        };
        const launch: PreparedReservedFinalFetchOwners = {
          protocol: 'rounds-v1',
          groups: persistence.roundsStore(
            transactionCurrent,
            preparationCurrent,
            scope,
          ),
          authorities: persistence.roundsAuthorityStore(
            transactionCurrent,
            preparationCurrent,
            scope,
          ),
          host,
          intents: this.owners.wireIntents,
          finalizeCurrent: preparationCurrent,
          reportHome: {
            owner: requestWriter,
            persistence,
            current,
            preparationCurrent,
            ...(publication
              ? {
                  retainCleanup: publication.retainCleanup,
                  withFinalFetchScope: <Value>(
                    body: (
                      scope: ReportRoundsScope,
                      facades: Pick<
                        RoundsFinalFetchOwners,
                        'groups' | 'authorities' | 'host'
                      >,
                    ) => Promise<Value>,
                  ): Promise<Value> =>
                    publication.withHome(
                      { owner: requestWriter, current: metadataCurrent },
                      async (scope): Promise<Value> => {
                        scope.check(assertPreparedSource);
                        const scoped: PreparedReservedFinalFetchOwners =
                          build(scope).launch;
                        const value = await body(scope, {
                          groups: scoped.groups,
                          authorities: scoped.authorities,
                          host: scoped.host,
                        });
                        assertReturnedPreparation(scope);
                        return value;
                      },
                    ),
                  check: <Value>(guard: () => undefined, body: () => Value) =>
                    publication.check(
                      { owner: requestWriter, current: guard },
                      body,
                    ),
                  withHome: <Value>(
                    guard: () => undefined,
                    body: (
                      scope: Pick<ReportRoundsScope, 'current' | 'check'>,
                    ) => Promise<Value>,
                  ) =>
                    publication.withHome(
                      { owner: requestWriter, current: guard },
                      body,
                    ),
                  invokeCurrent: <Value>(
                    guard: () => undefined,
                    invoke: (
                      check: <Result>(work: () => Result) => Result,
                    ) => Promise<Value>,
                  ) =>
                    publication.invokeCurrent(
                      { owner: requestWriter, current: guard },
                      invoke,
                    ),
                }
              : {}),
          },
        };
        const service = createDelegationAuthorityServiceV3(
          launch.authorities,
          host,
          { maxRenewals: prepared.spec.policy.maxRenewals ?? 0 },
        );
        const physical: ReturnType<DelegationRoundsHost['executionHost']> = {
          resolveRuntime: async (envelope) => {
            if (scope) refuse();
            const { member, seat } = await checkAsync(() => {
              const selected = memberFor(envelope);
              if (
                !preparation.confirmsExecution(
                  handle,
                  context.req.raw,
                  envelope,
                )
              )
                refuse();
              return selected;
            });
            const runtime: ModelRuntime = {
              id: envelope.execution_binding.runtime.runtime_receipt_ref.id,
              capabilities: () => ({
                structuredTools: false,
                streaming: false,
                abort: true,
                usage: true,
                outputTokenLimitFidelity: 'native',
              }),
              invoke: async (request, options) => {
                const { selected, sdk, captured } = await checkAsync(() => {
                  current();
                  const selected = invocation.getStore();
                  if (
                    !selected ||
                    !same(selected.envelope, envelope) ||
                    !same(request, {
                      messages: [{ role: 'user', content: member.brief }],
                      maxOutputTokens: seat.allocation.outputTokens,
                    })
                  )
                    refuse();
                  const sdk = preparation.sdk(
                    handle,
                    context.req.raw,
                    seat.seatId,
                  );
                  const captured = inspectSdkSourceWire(
                    sdk.owner,
                    sdk.sdkHandle,
                  );
                  return { selected, sdk, captured };
                });
                const started = Date.now();
                let dispatched: Awaited<
                  ReturnType<StationReportGroupPreparation['dispatch']>
                >;
                let attempt: AttemptResult;
                try {
                  dispatched = await preparation.dispatch(
                    handle,
                    context,
                    seat.seatId,
                    {
                      persistence,
                      transport: {
                        launch: { ...launch, finalizeCurrent: dispatchCurrent },
                        reservation: {
                          groupId,
                          controller: prepared.spec.controller,
                          seatId: seat.seatId,
                          authority: prepared.spec.rootAuthorityRef,
                          envelope: seat.envelope,
                          invocationId: selected.id,
                          effect: seat.effect,
                          allocation: seat.allocation,
                        },
                        contract: captured.contract,
                        provider: member.provider,
                        signal: options?.signal
                          ? AbortSignal.any([signal, options.signal])
                          : signal,
                        now: Date.now,
                        maxResponseBytes: 1024 * 1024,
                      },
                    },
                    orchestration,
                  );
                  attempt = await dispatched.result;
                } finally {
                  await retireSdkSourceWire(sdk.owner, sdk.sdkHandle);
                }
                await checkAsync(() => {
                  current();
                  retained.set(selected.id, {
                    attempt,
                    task: dispatched.task,
                    recipient: dispatched.recipient,
                    envelopeId: envelope.envelope_id,
                  });
                });
                const accounting = attempt.accounting;
                return {
                  provider: member.provider,
                  model: member.modelId,
                  outputText: attempt.sdkResult.text,
                  toolCalls: [],
                  usage: {
                    inputTokens: accounting.inputTokens,
                    outputTokens: accounting.outputTokens,
                    totalTokens:
                      accounting.inputTokens + accounting.outputTokens,
                  },
                  latencyMs: Math.max(0, Date.now() - started),
                };
              },
            };
            return {
              runtime,
              runtimeReceipt:
                envelope.execution_binding.runtime.runtime_receipt_ref,
              modelReceipt:
                envelope.execution_binding.runtime.model_receipt_ref,
            };
          },
          invokeFenced: async (envelope, id, invoke) => {
            if (scope) refuse();
            await checkAsync(() => memberFor(envelope));
            return invocation.run({ envelope, id }, invoke);
          },
          retainResult: async (result, envelope, id) => {
            const { seat } = memberFor(envelope);
            const value = retained.get(id);
            if (!value || value.attempt.sdkResult.text !== result.outputText)
              refuse();
            await persistence.assertProviderEvidenceRetained(
              value.attempt.evidence,
              value.attempt.evidenceReference,
              current,
            );
            if (value.attempt.inputReceipt) {
              const receipt = await persistence.readReportInputReceipt(
                value.attempt.inputReceipt,
                {
                  groupId,
                  invocationId: id,
                  seatId: seat.seatId,
                  threadId: value.task.sessionId,
                  turnId: value.task.initialTurnId ?? refuse(),
                },
                current,
              );
              if (
                !same(
                  receipt.binding.recipient,
                  check(() => value.recipient()),
                )
              )
                refuse();
            }
            await persistence.retainReportObservation(
              {
                groupId,
                seatId: seat.seatId,
                invocationId: id,
                observation: {
                  kind: 'result',
                  evidence: value.attempt.evidenceReference,
                  ...(value.attempt.inputReceipt
                    ? { inputReceipt: value.attempt.inputReceipt }
                    : {}),
                  text: result.outputText,
                  modelId: result.model,
                  inputTokens: value.attempt.accounting.inputTokens,
                  outputTokens: value.attempt.accounting.outputTokens,
                  costMicros: value.attempt.accounting.costMicros,
                },
              },
              current,
            );
            return value.attempt.accounting;
          },
          retainFailure: async (_error, envelope, id) => {
            const { seat } = await checkAsync(() => memberFor(envelope));
            await persistence.retainReportObservation(
              {
                groupId,
                seatId: seat.seatId,
                invocationId: id,
                observation: {
                  kind: 'failure',
                  code: 'report_attempt_unavailable',
                },
              },
              current,
            );
          },
        };
        const observeRecipient = (
          spec: DelegationRoundsSpec,
          seat: RoundSeat,
          envelope: DelegationEnvelopeV2,
        ) => {
          const { member } = memberFor(envelope);
          if (
            !same(spec, prepared.spec) ||
            !same(
              seat,
              prepared.spec.seats.find((s) => s.seatId === member.seatId),
            )
          )
            refuse();
          const candidates = [...retained.values()].filter(
            (value) => value.task.sessionId === member.taskId,
          );
          if (candidates.length !== 1) refuse();
          return {
            ...check(() => candidates[0].recipient()),
            authority: structuredClone(spec.rootAuthorityRef),
            envelope: { id: seat.envelope.id, digest: seat.envelope.digest },
            runtimeReceipt: structuredClone(
              envelope.execution_binding.runtime.runtime_receipt_ref,
            ),
            modelReceipt: structuredClone(
              envelope.execution_binding.runtime.model_receipt_ref,
            ),
          };
        };
        const flowExecution: ReturnType<
          NonNullable<DelegationRoundsHost['flow']>['executionHost']
        > = {
          ...physical,
          recordScheduleEvent: async (event) => {
            current();
            await persistence.retainReportFlowObservation(
              groupId,
              'schedule',
              event,
              current,
            );
          },
          confirmClaim: async (claim, envelope) => {
            const confirm = async (
              lease: import('../ssh/home-writer-owner.js').HomeWriterLease,
            ) => {
              const { member, owner } = requestWriter.runWithLease(
                lease,
                () => {
                  const { member } = memberFor(envelope);
                  return {
                    member,
                    owner: preparation.flow(
                      handle,
                      context.req.raw,
                      member.seatId,
                    ),
                  };
                },
              );
              if (
                !owner ||
                claim.step_id !==
                  prepared.spec.seats.find(
                    (seat) => seat.seatId === member.seatId,
                  )?.stepId
              )
                return false;
              await owner.withCurrentClaim(
                claim,
                () => ({ value: undefined }),
                {
                  owner: requestWriter,
                  lease,
                },
              );
              requestWriter.runWithLease(lease, current);
              return true;
            };
            return scope
              ? confirm(scope.lease)
              : requestWriter.runOwnedLease(signal, confirm);
          },
          prepareRequest: async (_claim, envelope) => {
            const { member, seat } = memberFor(envelope);
            return {
              messages: [{ role: 'user', content: member.brief }],
              maxOutputTokens: seat.allocation.outputTokens,
            };
          },
          recordMemberOutcome: async (claim, envelope, outcome) => {
            const { seat } = memberFor(envelope);
            await persistence.retainReportFlowObservation(
              groupId,
              'member',
              {
                claim,
                seatId: seat.seatId,
                envelope: seat.envelope,
                outcome: outcome.outcome,
              },
              current,
            );
          },
        };
        const flowHost: NonNullable<DelegationRoundsHost['flow']> = {
          executionHost: () => flowExecution,
          confirmRetainedResult: async (_spec, attempt, reference) => {
            current();
            const value = retained.get(attempt.invocationId);
            if (!value) return false;
            const observation = await persistence.readReportObservation(
              groupId,
              attempt.invocationId,
              reference,
              current,
            );
            if (
              observation.seatId !== attempt.seatId ||
              observation.observation.kind !== 'result' ||
              !same(
                observation.observation.evidence,
                value.attempt.evidenceReference,
              )
            )
              return false;
            await persistence.assertProviderEvidenceRetained(
              value.attempt.evidence,
              value.attempt.evidenceReference,
              current,
            );
            return true;
          },
          retainEvaluation: async (_spec, action, receipt) => {
            current();
            return persistence.retainReportFlowObservation(
              groupId,
              'evaluation',
              { action, receipt },
              current,
            );
          },
        };
        const roundsHost: DelegationRoundsHost = {
          ...(flow ? { flow: flowHost } : {}),
          accountingProtocol: 'retained-tariff-v1',
          recipient: {
            resolve: async (spec, seat, envelope) => {
              if (scope) refuse();
              const identity = await checkAsync(() =>
                observeRecipient(spec, seat, envelope),
              );
              const resolved = await physical.resolveRuntime(envelope);
              await checkAsync(() => {
                current();
                if (!same(identity, observeRecipient(spec, seat, envelope)))
                  refuse();
              });
              return {
                identity,
                runtime: resolved.runtime,
                retainResult: physical.retainResult,
                retainFailure: physical.retainFailure,
                invokeFenced: physical.invokeFenced,
              };
            },
          },
          authorize: async ({ current: projection, groupId: candidate }) => {
            current();
            return candidate === groupId &&
              (!projection || same(projection.spec, prepared.spec))
              ? prepared.root.authenticated_principal_ref
              : null;
          },
          executionHost: () => {
            if (scope) refuse();
            return physical;
          },
          prepareRequest: async (_spec, seat) => {
            current();
            const member = prepared.members.find(
              (m) => m.seatId === seat.seatId,
            );
            if (!member) refuse();
            return {
              messages: [{ role: 'user', content: member.brief }],
              maxOutputTokens: seat.allocation.outputTokens,
            };
          },
          retainObservation: async (_spec, attempt) => {
            const value = retained.get(attempt.invocationId);
            return persistence.retainReportObservation(
              {
                groupId,
                seatId: attempt.seatId,
                invocationId: attempt.invocationId,
                observation: value
                  ? {
                      kind: 'result',
                      evidence: value.attempt.evidenceReference,
                      ...(value.attempt.inputReceipt
                        ? { inputReceipt: value.attempt.inputReceipt }
                        : {}),
                      text: value.attempt.sdkResult.text,
                      modelId:
                        prepared.members.find(
                          (m) => m.seatId === attempt.seatId,
                        )?.modelId ?? refuse(),
                      inputTokens: value.attempt.accounting.inputTokens,
                      outputTokens: value.attempt.accounting.outputTokens,
                      costMicros: value.attempt.accounting.costMicros,
                    }
                  : { kind: 'failure', code: 'report_attempt_unavailable' },
              },
              current,
            );
          },
          confirmTerminal: async (_spec, attempt) => {
            current();
            const value = retained.get(attempt.invocationId);
            const initialTurnId = value?.task.initialTurnId;
            if (!value || !initialTurnId) return null;
            await persistence.assertProviderEvidenceRetained(
              value.attempt.evidence,
              value.attempt.evidenceReference,
              current,
            );
            const readWindow = () =>
              orchestration.readSessionEventWindow(value.task.sessionId, {
                turnLimit: 20,
                authority: sessionReadAuthorityFromRequest(
                  prepared.root.authenticated_principal_ref.id,
                  undefined,
                  undefined,
                ),
              });
            const window = scope
              ? await requestWriter.withLeaseLifetime(scope.lease, readWindow)
              : await requestWriter.runOwnedLease(signal, (lease) =>
                  requestWriter.withLeaseLifetime(lease, readWindow),
                );
            current();
            const terminal = window?.events.find(
              ({ event }) =>
                event.threadId === value.task.sessionId &&
                event.turnId === initialTurnId &&
                event.method === 'turn.completed',
            );
            if (!terminal) return null;
            const seat = prepared.spec.seats.find(
              (s) => s.seatId === attempt.seatId,
            );
            const envelope = prepared.envelopes.find(
              (e) => e.envelope_id === seat?.envelope.id,
            );
            if (!seat || !envelope) refuse();
            const recipient = observeRecipient(prepared.spec, seat, envelope);
            const observed = check(() => value.recipient());
            const terminalCurrent = (): undefined => {
              current();
              if (
                !same(
                  observed,
                  check(() => value.recipient()),
                )
              )
                refuse();
              return undefined;
            };
            const member = prepared.members.find(
              (candidate) => candidate.seatId === attempt.seatId,
            );
            if (!member) refuse();
            const witness = check(() =>
              captureReportTerminalWitness(
                {
                  environment: this.owners.environment,
                  orchestration,
                  current: terminalCurrent,
                },
                {
                  groupId,
                  seatId: attempt.seatId,
                  invocationId: attempt.invocationId,
                  root: rootAuthorityReferenceV2(prepared.root),
                  envelope: {
                    id: envelope.envelope_id,
                    generation: envelope.generation,
                    digest: delegationEnvelopeDigestV2(envelope),
                  },
                  evidence: value.attempt.evidenceReference,
                  ownerId: prepared.root.authenticated_principal_ref.id,
                  turn: {
                    conversationId: value.task.taskId,
                    sessionId: value.task.sessionId,
                    clientTurnId: member.clientTurnId,
                    turnId: initialTurnId,
                  },
                },
              ),
            );
            if (
              !witness ||
              witness.data.terminal.terminalEventId !== terminal.event.eventId
            )
              return null;
            const recipientReference =
              await persistence.retainReportFlowObservation(
                groupId,
                'recipient',
                {
                  invocationId: attempt.invocationId,
                  identity: recipient,
                },
                terminalCurrent,
              );
            return persistence.retainReportObservation(
              {
                groupId,
                seatId: attempt.seatId,
                invocationId: attempt.invocationId,
                observation: {
                  kind: 'terminal',
                  evidence: value.attempt.evidenceReference,
                  taskId: value.task.taskId,
                  sessionId: value.task.sessionId,
                  turnId: initialTurnId,
                  eventId: terminal.event.eventId,
                  witness,
                  recipient: recipientReference,
                },
              },
              terminalCurrent,
            );
          },
          requestDescendantCancellation: async () => refuse(),
        };
        return {
          launch,
          service,
          physical,
          flowExecution,
          flowHost,
          roundsHost,
        };
      };
      const base = build();
      const metadata = <Value>(
        work: (
          facades: ReturnType<typeof build>,
          scope?: ReportRoundsScope,
        ) => Promise<Value>,
      ): Promise<Value> =>
        publication
          ? publication.withHome(
              { owner: requestWriter, current: metadataCurrent },
              async (scope) => {
                scope.check(assertPreparedSource);
                const value = await work(build(scope), scope);
                assertReturnedPreparation(scope);
                return value;
              },
            )
          : work(base);
      const service: typeof base.service = publication
        ? {
            issue: (...args) =>
              metadata((value) => value.service.issue(...args)),
            derive: (...args) =>
              metadata((value) => value.service.derive(...args)),
            inspect: (...args) =>
              metadata((value) => value.service.inspect(...args)),
            admitEffect: (...args) =>
              metadata((value) => value.service.admitEffect(...args)),
            reserveInvocation: (...args) =>
              metadata((value) => value.service.reserveInvocation(...args)),
            reconcileInvocation: (...args) =>
              metadata((value) => value.service.reconcileInvocation(...args)),
            cancel: (...args) =>
              metadata((value) => value.service.cancel(...args)),
            renew: (...args) =>
              metadata((value) => value.service.renew(...args)),
            importV2: (...args) =>
              metadata((value) => value.service.importV2(...args)),
          }
        : base.service;
      const physical: typeof base.physical = publication
        ? {
            ...base.physical,
            retainResult: (...args) =>
              metadata((value) => value.physical.retainResult(...args)),
            retainFailure: (...args) =>
              metadata((value) => value.physical.retainFailure(...args)),
          }
        : base.physical;
      const flowExecution: typeof base.flowExecution = publication
        ? {
            ...physical,
            recordScheduleEvent: (...args) =>
              metadata((value) =>
                value.flowExecution.recordScheduleEvent(...args),
              ),
            confirmClaim: (...args) =>
              metadata((value) => value.flowExecution.confirmClaim(...args)),
            prepareRequest: (...args) =>
              metadata((value) => value.flowExecution.prepareRequest(...args)),
            recordMemberOutcome: (...args) =>
              metadata((value) =>
                value.flowExecution.recordMemberOutcome(...args),
              ),
          }
        : base.flowExecution;
      const roundsHost: DelegationRoundsHost = publication
        ? {
            ...base.roundsHost,
            executionHost: () => physical,
            authorize: (...args) =>
              metadata((value) => value.roundsHost.authorize(...args)),
            prepareRequest: (...args) =>
              metadata((value) => value.roundsHost.prepareRequest(...args)),
            retainObservation: (...args) =>
              metadata((value) => value.roundsHost.retainObservation(...args)),
            confirmTerminal: (...args) =>
              metadata((value) => value.roundsHost.confirmTerminal(...args)),
            ...(flow
              ? {
                  flow: {
                    executionHost: () => flowExecution,
                    confirmRetainedResult: (...args) =>
                      metadata((value) =>
                        value.flowHost.confirmRetainedResult(...args),
                      ),
                    retainEvaluation: (...args) =>
                      metadata((value) =>
                        value.flowHost.retainEvaluation(...args),
                      ),
                  },
                }
              : {}),
          }
        : base.roundsHost;
      await metadata(async (initial, scope) => {
        await initial.service.issue(prepared.root);
        if (scope) assertReturnedPreparation(scope);
        for (const envelope of prepared.envelopes) {
          scope?.check(assertPreparedSource);
          await initial.service.derive(prepared.root.authority_id, envelope);
          if (scope) assertReturnedPreparation(scope);
        }
      });
      const controller = createDelegationRoundsController({
        store: base.launch.groups,
        authorityService: service,
        dispatchLedger: this.owners.dispatchLedger,
        host: roundsHost,
        ...(publication
          ? {
              transactionOwner: publication.transactionOwner({
                groupId,
                owner: requestWriter,
                current: metadataCurrent,
                assertPreparationCurrent: assertPreparedSource,
                build: (scope) => {
                  const scoped = build(scope);
                  return {
                    store: scoped.launch.groups,
                    authorityService: scoped.service,
                    host: scoped.roundsHost,
                  };
                },
              }),
            }
          : {}),
        ...(schedule ? { cwd: schedule.cwd } : {}),
      });
      const created = await controller.create({
        kind: 'create',
        groupId,
        operationKey: 'create',
        expectedRevision: 0,
        controller: prepared.spec.controller,
        spec: prepared.spec,
      });
      let projection = created.projection;
      for (let round = 0; round < prepared.spec.policy.maxRounds; round++) {
        if (projection.attempts.length === prepared.members.length) break;
        const currentSchedule = await readSchedule();
        current();
        const seats = prepared.spec.seats.filter(
          (seat) =>
            !projection.attempts.some(
              (attempt) => attempt.seatId === seat.seatId,
            ) &&
            (!currentSchedule ||
              (seat.stepId !== undefined &&
                currentSchedule.readySteps.includes(seat.stepId))),
        );
        if (seats.length === 0) break;
        const released = await controller.release({
          kind: 'release',
          groupId,
          operationKey: `initial:${round}`,
          expectedRevision: projection.revision,
          controller: prepared.spec.controller,
          checkpoint: {
            domain: 'station.report-group-round-checkpoint.v1',
            id: `initial:${round}`,
            digest: digest({
              groupId,
              controller: prepared.spec.controller,
              revision: projection.revision,
              flowHead: currentSchedule?.runHead ?? null,
              seats: seats.map((seat) => seat.seatId),
              policy: prepared.root.revisions.policy,
            }),
          },
          ...(currentSchedule ? { flowHead: currentSchedule.runHead } : {}),
          seats: seats.map((seat) => ({
            seatId: seat.seatId,
            previousInvocationId: null,
            ...(flow ? { mode: 'invoke' as const, retryRef: null } : {}),
          })),
        });
        for (const attempt of released.projection.attempts.filter(
          (attempt) =>
            !attempt.terminal && attempt.admission !== 'not_admitted',
        ))
          await controller.recordTerminal({
            kind: 'terminal',
            groupId,
            operationKey: `terminal:${attempt.invocationId}`,
            expectedRevision: (await controller.get(groupId)).revision,
            controller: prepared.spec.controller,
            invocationId: attempt.invocationId,
          });
        projection = await controller.get(groupId);
        if (
          projection.attempts.some(
            (attempt) => attempt.admission === 'not_admitted',
          )
        )
          break;
      }
      return {
        replayed: false,
        group: await custody.findOperationForMutation(
          context,
          input.operationId,
          publication,
        ),
      };
    } finally {
      clearTimeout(timer);
      deadline.abort();
      preparation.close(handle);
      await preparation.closeInputs(handle);
    }
  }
}
