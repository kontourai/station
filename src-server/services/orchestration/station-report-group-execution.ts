import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { AuthorizationLedger } from '@kontourai/dispatch';
import { loadRun, withRunMutationLock } from '@kontourai/flow';
import { createDelegationAuthorityServiceV3 } from '@kontourai/flow-agents/delegation-authority-service-v3';
import type { DelegationEnvelopeV2 } from '@kontourai/flow-agents/delegation-envelope-v2';
import { assertDelegationFlowRuntime } from '@kontourai/flow-agents/delegation-flow-runtime';
import {
  createDelegationRoundsController,
  type DelegationRoundsHost,
  type DelegationRoundsSpec,
  type RoundSeat,
} from '@kontourai/flow-agents/delegation-group-rounds';
import { canonicalJson, type ModelRuntime } from '@kontourai/relay';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import type { runReservedSdkSourceAttempt } from '../../runtime/conversation/reserved-sdk-source-attempt.js';
import type { DelegatedTaskHandle } from '../../tools/station-control-delegation.js';
import type { PreparedReservedFinalFetchOwners } from './delegation-group-launch-fence.js';
import type { StationDelegationPersistence } from './delegation-group-persistence.js';
import {
  inspectSdkSourceWire,
  sdkDisposalPromise,
} from './delegation-group-sdk-source-wire-owner.js';
import type { RuntimeSourceRequestContext } from './delegation-group-source-admission.js';
import type { FileFinalWireIntentStore } from './delegation-group-wire-intent-store.js';
import type { OrchestrationService } from './orchestration-service.js';
import type { StationReportGroupCustody } from './station-report-group-custody.js';
import { parseStationReportGroupInput } from './station-report-group-input.js';
import {
  type PreparedStationReportGroup,
  type StationReportGroupPreparation,
} from './station-report-group-preparation.js';

const same = (left: unknown, right: unknown) =>
  canonicalJson(left) === canonicalJson(right);
const digest = (value: unknown) =>
  `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
export class StationReportExecutionUnavailable extends Error {
  readonly code = 'group_execution_unavailable';
  constructor() {
    super('Report group execution is unavailable.');
  }
}
function refuse(): never {
  throw new StationReportExecutionUnavailable();
}
type AttemptResult = Awaited<ReturnType<typeof runReservedSdkSourceAttempt>>;
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
    },
  ) {
    this.owners = Object.freeze({ ...owners });
  }

  async execute(context: RuntimeSourceRequestContext, sent: unknown) {
    const input = parseStationReportGroupInput(sent);
    const { custody, persistence, orchestration } = this.owners;
    const existing = await custody.findOperationForMutation(
      context,
      input.operationId,
    );
    if (existing) {
      if (existing.admission.root.revisions.policy.digest !== digest(input))
        refuse();
      return { replayed: true, group: existing };
    }
    if (input.flow)
      assertDelegationFlowRuntime({ loadRun, withRunMutationLock });
    const preparation =
      typeof this.owners.preparation === 'function'
        ? await this.owners.preparation()
        : this.owners.preparation;
    const handle = await preparation.prepare(context, input);
    if (this.#claimed.has(handle)) refuse();
    this.#claimed.add(handle);
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(),
      Math.max(1, input.deadlineAt - Date.now()),
    );
    const signal = AbortSignal.any([context.req.raw.signal, deadline.signal]);
    try {
      const prepared = preparation.read(handle, context.req.raw);
      const groupId = await custody.retain(context, preparation, handle);
      const current = (): undefined => {
        signal.throwIfAborted();
        preparation.assertCurrent(handle, context.req.raw);
        return undefined;
      };
      const retained = new Map<string, Retained>();
      const invocation = new AsyncLocalStorage<{
        envelope: DelegationEnvelopeV2;
        id: string;
      }>();
      const memberFor = (envelope: DelegationEnvelopeV2) => {
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
      };
      const host = {
        now: () => new Date(Date.now()).toISOString(),
        authorize: async (
          _action: unknown,
          root: typeof prepared.root,
          envelope: DelegationEnvelopeV2 | null,
        ) => preparation.authorizes(handle, context.req.raw, root, envelope),
        confirmExecution: async (envelope: DelegationEnvelopeV2) =>
          preparation.confirmsExecution(handle, context.req.raw, envelope),
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
        groups: persistence.roundsStore(current),
        authorities: persistence.roundsAuthorityStore(current),
        host,
        intents: this.owners.wireIntents,
        finalizeCurrent: current,
      };
      const service = createDelegationAuthorityServiceV3(
        launch.authorities,
        host,
        { maxRenewals: prepared.spec.policy.maxRenewals ?? 0 },
      );
      const physical: ReturnType<DelegationRoundsHost['executionHost']> = {
        resolveRuntime: async (envelope) => {
          const { member, seat } = memberFor(envelope);
          if (!preparation.confirmsExecution(handle, context.req.raw, envelope))
            refuse();
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
              const sdk = preparation.sdk(handle, context.req.raw, seat.seatId);
              const captured = inspectSdkSourceWire(sdk.owner, sdk.sdkHandle);
              const started = Date.now();
              const dispatched = await preparation.dispatch(
                handle,
                context,
                seat.seatId,
                {
                  persistence,
                  transport: {
                    launch,
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
                    provider: 'anthropic',
                    signal: options?.signal
                      ? AbortSignal.any([signal, options.signal])
                      : signal,
                    now: Date.now,
                    maxResponseBytes: 1024 * 1024,
                  },
                },
                orchestration,
              );
              const attempt = await dispatched.result;
              await sdkDisposalPromise(sdk.owner, sdk.sdkHandle);
              current();
              retained.set(selected.id, {
                attempt,
                task: dispatched.task,
                recipient: dispatched.recipient,
                envelopeId: envelope.envelope_id,
              });
              const accounting = attempt.accounting;
              return {
                provider: 'anthropic',
                model: member.modelId,
                outputText: attempt.sdkResult.text,
                toolCalls: [],
                usage: {
                  inputTokens: accounting.inputTokens,
                  outputTokens: accounting.outputTokens,
                  totalTokens: accounting.inputTokens + accounting.outputTokens,
                },
                latencyMs: Math.max(0, Date.now() - started),
              };
            },
          };
          return {
            runtime,
            runtimeReceipt:
              envelope.execution_binding.runtime.runtime_receipt_ref,
            modelReceipt: envelope.execution_binding.runtime.model_receipt_ref,
          };
        },
        invokeFenced: async (envelope, id, invoke) => {
          memberFor(envelope);
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
          await persistence.retainReportObservation(
            {
              groupId,
              seatId: seat.seatId,
              invocationId: id,
              observation: {
                kind: 'result',
                evidence: value.attempt.evidenceReference,
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
          const { seat } = memberFor(envelope);
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
          ...candidates[0].recipient(),
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
      const flow = preparation.flow(handle, context.req.raw);
      const schedule = flow ? await flow.readSchedule() : undefined;
      current();
      const flowHost: NonNullable<DelegationRoundsHost['flow']> = {
        executionHost: () => ({
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
            const { member } = memberFor(envelope);
            const owner = preparation.flow(
              handle,
              context.req.raw,
              member.seatId,
            );
            if (
              !owner ||
              claim.step_id !==
                prepared.spec.seats.find(
                  (seat) => seat.seatId === member.seatId,
                )?.stepId
            )
              return false;
            await owner.withCurrentClaim(claim, () => ({ value: undefined }));
            current();
            return true;
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
        }),
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
            const identity = observeRecipient(spec, seat, envelope);
            const resolved = await physical.resolveRuntime(envelope);
            current();
            if (!same(identity, observeRecipient(spec, seat, envelope)))
              refuse();
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
        executionHost: () => physical,
        prepareRequest: async (_spec, seat) => {
          current();
          const member = prepared.members.find((m) => m.seatId === seat.seatId);
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
                    text: value.attempt.sdkResult.text,
                    modelId:
                      prepared.members.find((m) => m.seatId === attempt.seatId)
                        ?.modelId ?? refuse(),
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
          if (!value?.task.initialTurnId) return null;
          await persistence.assertProviderEvidenceRetained(
            value.attempt.evidence,
            value.attempt.evidenceReference,
            current,
          );
          const window = await orchestration.readSessionEventWindow(
            value.task.sessionId,
            {
              turnLimit: 20,
              authority: sessionReadAuthorityFromRequest(
                prepared.root.authenticated_principal_ref.id,
                undefined,
                undefined,
              ),
            },
          );
          current();
          const terminal = window?.events.find(
            ({ event }) =>
              event.threadId === value.task.sessionId &&
              event.turnId === value.task.initialTurnId &&
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
          const observed = value.recipient();
          const terminalCurrent = (): undefined => {
            current();
            if (!same(observed, value.recipient())) refuse();
            return undefined;
          };
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
                turnId: value.task.initialTurnId,
                eventId: terminal.event.eventId,
                recipient: recipientReference,
              },
            },
            terminalCurrent,
          );
        },
        requestDescendantCancellation: async () => refuse(),
      };
      await service.issue(prepared.root);
      for (const envelope of prepared.envelopes)
        await service.derive(prepared.root.authority_id, envelope);
      const controller = createDelegationRoundsController({
        store: launch.groups,
        authorityService: service,
        dispatchLedger: this.owners.dispatchLedger,
        host: roundsHost,
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
        const currentSchedule = flow ? await flow.readSchedule() : undefined;
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
        ),
      };
    } finally {
      clearTimeout(timer);
      deadline.abort();
      preparation.close(handle);
    }
  }
}
