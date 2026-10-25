// UNWIRED(#91): funded report/retry serving and combined qualification remain pending.
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
} from '@kontourai/flow-agents/delegation-group-rounds';
import { canonicalJson, type ModelRuntime } from '@kontourai/relay';
import type { ReportGroupContextSyncInput } from '@kontourai/station-contracts/report-group';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { z } from 'zod/v3';
import type { PreparedReservedFinalFetchOwners } from './delegation-group-launch-fence.js';
import type { StationDelegationPersistence } from './delegation-group-persistence.js';
import type { RuntimeSourceRequestContext } from './delegation-group-source-admission.js';
import type { FileFinalWireIntentStore } from './delegation-group-wire-intent-store.js';
import type { OrchestrationService } from './orchestration-service.js';
import type { StationReportGroupCustody } from './station-report-group-custody.js';
import { StationReportPreparationUnavailable } from './station-report-group-input.js';
import type { StationReportRetainedTurns } from './station-report-retained-turn.js';

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function refuse(): never {
  throw new StationReportPreparationUnavailable();
}
const physicalIdentity = z.object({
  hostId: z.string(),
  recipientId: z.string(),
  generation: z.number().int(),
  executionId: z.string(),
  sessionReceipt: z
    .object({
      id: z.string(),
      domain: z.literal('station.reserved-session.v1'),
      digest: z.string(),
    })
    .strict(),
});
type Prepared = Awaited<ReturnType<StationReportRetainedTurns['prepare']>>;
type Result = Awaited<ReturnType<Prepared['dispatch']>>;

/** Explicit returning-request continuation. Flow owns reservation, bounded retry and exact ACK. */
export class StationReportGroupContinuation {
  constructor(
    private readonly owners: {
      custody: StationReportGroupCustody;
      turns: StationReportRetainedTurns;
      persistence: StationDelegationPersistence;
      orchestration: OrchestrationService;
      dispatchLedger: AuthorizationLedger;
      wireIntents: FileFinalWireIntentStore;
      authorize(context: RuntimeSourceRequestContext): Promise<() => void>;
    },
  ) {
    this.owners = Object.freeze({ ...owners });
  }

  async sync(
    context: RuntimeSourceRequestContext,
    groupId: string,
    sent: ReportGroupContextSyncInput,
  ) {
    const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    const input = z
      .object({
        operationKey: identity,
        expectedRevision: z.number().int().nonnegative().safe(),
        seatId: identity,
        flowHead: z.string().regex(/^[a-f0-9]{64}$/),
        text: z.string().min(1).max(65_536),
      })
      .strict()
      .parse(structuredClone(sent));
    const authorize = await this.owners.authorize(context);
    const loaded = await this.owners.custody.loadIntentForMutation(
      context,
      groupId,
    );
    const { persistence, orchestration, turns } = this.owners;
    const group = loaded.group;
    const epoch = loaded.authority?.epochs.at(-1);
    const member = loaded.admission.members.find(
      (m) => m.seatId === input.seatId,
    );
    const seat = group?.spec.seats.find((s) => s.seatId === input.seatId);
    const grant = group?.grants.envelopes.find(
      (s) => s.seatId === input.seatId,
    );
    const envelope = epoch?.envelopes.find(
      (e) => e.envelope_id === grant?.envelope.id,
    );
    if (
      !group ||
      !epoch ||
      !seat ||
      !grant ||
      !envelope ||
      !member ||
      !loaded.intent.continuation ||
      loaded.intent.continuation.maxSyncs < 1 ||
      group.spec.topology.kind !== 'flow' ||
      loaded.authority?.cancelled
    )
      refuse();
    if (
      !group.continuations.some(
        (entry) => entry.command.operationKey === input.operationKey,
      )
    )
      assertDelegationFlowRuntime({ loadRun, withRunMutationLock });
    const root = epoch.root;
    const effectiveSpec = {
      ...group.spec,
      rootAuthorityRef: group.grants.authority,
      seats: group.spec.seats.map((seat) => ({
        ...seat,
        envelope: group.grants.envelopes.find(
          (grant) => grant.seatId === seat.seatId,
        )!.envelope,
      })),
    };
    let executionSignal = context.req.raw.signal;
    const current = (): undefined => {
      authorize();
      executionSignal.throwIfAborted();
      return undefined;
    };
    const contextRef = await persistence.retainReportContext(
      groupId,
      input.text,
      current,
    );
    const checkpoint = {
      domain: 'station.report-continuation-checkpoint.v1',
      id: input.operationKey,
      digest: `sha256:${createHash('sha256')
        .update(
          canonicalJson([
            groupId,
            input.operationKey,
            input.expectedRevision,
            input.flowHead,
            input.seatId,
            contextRef,
          ]),
        )
        .digest('hex')}`,
    };
    const command = {
      kind: 'sync' as const,
      groupId,
      operationKey: input.operationKey,
      expectedRevision: input.expectedRevision,
      controller: group.spec.controller,
      checkpoint,
      flowHead: input.flowHead,
      seatId: input.seatId,
      contextRef,
    };
    const prior = group.continuations.find(
      (c) => c.command.operationKey === input.operationKey,
    );
    if (prior && !same(prior.command, command)) refuse();
    // A retained command is never a request to recreate the paid operation.
    if (prior) return { replayed: true, projection: group };
    if (Date.now() >= loaded.intent.deadlineAt) refuse();
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(),
      Math.max(1, loaded.intent.deadlineAt - Date.now()),
    );
    executionSignal = AbortSignal.any([
      context.req.raw.signal,
      deadline.signal,
    ]);
    const runId = `roundsync_${createHash('sha256')
      .update(
        canonicalJson([groupId, input.operationKey, input.seatId, contextRef]),
      )
      .digest('hex')}`;
    const request = {
      messages: [
        {
          role: 'system' as const,
          content: `Receive context only. Do not call tools. Reply exactly ACK SYNC ${runId}`,
        },
        { role: 'user' as const, content: input.text },
      ],
      tools: [],
      maxOutputTokens: seat.allocation.outputTokens,
    };
    const syncInput = { runId, text: input.text };
    const prepared: Prepared[] = [];
    const retained = new Map<
      string,
      { dispatched: Result; prepared: Prepared }
    >();
    const invocation = new AsyncLocalStorage<string>();
    try {
      let selected = await turns.prepare(
        context,
        groupId,
        input.seatId,
        envelope,
        syncInput,
      );
      prepared.push(selected);
      let consumed = false;
      const observeRecipient = () => ({
        ...selected.recipient(),
        authority: group.grants.authority,
        envelope: { id: grant.envelope.id, digest: grant.envelope.digest },
        runtimeReceipt: envelope.execution_binding.runtime.runtime_receipt_ref,
        modelReceipt: envelope.execution_binding.runtime.model_receipt_ref,
      });
      const initialRecipient = observeRecipient();
      const originalAttempt = group.attempts
        .filter((a) => a.seatId === input.seatId && a.terminal)
        .at(-1);
      if (!originalAttempt?.terminal) refuse();
      const originalTerminal = await persistence.readReportObservation(
        groupId,
        originalAttempt.invocationId,
        originalAttempt.terminal,
        current,
      );
      if (
        originalTerminal.observation.kind !== 'terminal' ||
        !originalTerminal.observation.recipient ||
        originalTerminal.observation.sessionId !== member.reservedTaskId
      )
        refuse();
      const observation = await persistence.readReportFlowObservation(
        groupId,
        originalTerminal.observation.recipient,
        current,
      );
      const originalRecipient = z
        .object({ invocationId: z.string(), identity: physicalIdentity })
        .strict()
        .parse(observation.value);
      if (
        observation.kind !== 'recipient' ||
        originalRecipient.invocationId !== originalAttempt.invocationId ||
        !same(
          originalRecipient.identity,
          physicalIdentity.parse(initialRecipient),
        )
      )
        refuse();
      const host = {
        now: () => new Date().toISOString(),
        authorize: async (
          _action: unknown,
          candidate: typeof root,
          child: DelegationEnvelopeV2 | null,
        ) => {
          current();
          return (
            same(candidate, root) && (child === null || same(child, envelope))
          );
        },
        confirmExecution: async (candidate: DelegationEnvelopeV2) => {
          current();
          selected.assertCurrent();
          return (
            same(candidate, envelope) &&
            same(observeRecipient(), initialRecipient)
          );
        },
        confirmReconciliation: async (candidate: {
          invocationId: string;
          envelopeId: string;
          usage: unknown;
          terminal: boolean;
        }) => {
          current();
          const value = retained.get(candidate.invocationId);
          if (!value) return false;
          const result = value.dispatched.result;
          await persistence.assertProviderEvidenceRetained(
            result.evidence,
            result.evidenceReference,
            current,
          );
          return (
            candidate.terminal &&
            candidate.envelopeId === envelope.envelope_id &&
            same(candidate.usage, {
              inputTokens: result.accounting.inputTokens,
              outputTokens: result.accounting.outputTokens,
              costMicros: result.accounting.costMicros,
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
        flow: selected.flow,
      };
      const service = createDelegationAuthorityServiceV3(
        launch.authorities,
        host,
        { maxRenewals: loaded.intent.continuation.maxRenewals },
      );
      const physical: ReturnType<DelegationRoundsHost['executionHost']> = {
        resolveRuntime: async (candidate) => {
          current();
          if (!same(candidate, envelope)) refuse();
          const runtime: ModelRuntime = {
            id: envelope.execution_binding.runtime.runtime_receipt_ref.id,
            capabilities: () => ({
              structuredTools: false,
              streaming: false,
              abort: true,
              usage: true,
              outputTokenLimitFidelity: 'native',
            }),
            invoke: async (actual, options) => {
              const started = Date.now();
              const id = invocation.getStore();
              current();
              if (!id || !same(actual, request)) refuse();
              if (consumed) {
                selected = await turns.prepare(
                  context,
                  groupId,
                  input.seatId,
                  envelope,
                  syncInput,
                );
                prepared.push(selected);
              }
              consumed = true;
              if (!same(observeRecipient(), initialRecipient)) refuse();
              const dispatched = await selected.dispatch(
                id,
                'context-sync',
                launch,
                options?.signal
                  ? AbortSignal.any([executionSignal, options.signal])
                  : executionSignal,
              );
              retained.set(id, { dispatched, prepared: selected });
              const result = dispatched.result;
              return {
                provider: 'anthropic',
                model: member.requestedModelId,
                outputText: result.sdkResult.text,
                toolCalls: [],
                usage: {
                  inputTokens: result.accounting.inputTokens,
                  outputTokens: result.accounting.outputTokens,
                  totalTokens:
                    result.accounting.inputTokens +
                    result.accounting.outputTokens,
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
        invokeFenced: async (candidate, id, invoke) => {
          current();
          if (!same(candidate, envelope)) refuse();
          return invocation.run(id, invoke);
        },
        retainResult: async (result, candidate, id) => {
          const value = retained.get(id);
          if (
            !value ||
            !same(candidate, envelope) ||
            result.outputText !== value.dispatched.result.sdkResult.text
          )
            refuse();
          const attempt = value.dispatched.result;
          await persistence.retainReportObservation(
            {
              groupId,
              seatId: input.seatId,
              invocationId: id,
              observation: {
                kind: 'result',
                evidence: attempt.evidenceReference,
                text: attempt.sdkResult.text,
                modelId: member.requestedModelId,
                inputTokens: attempt.accounting.inputTokens,
                outputTokens: attempt.accounting.outputTokens,
                costMicros: attempt.accounting.costMicros,
              },
            },
            current,
          );
          return attempt.accounting;
        },
        retainFailure: async (_error, candidate, id) => {
          current();
          if (!same(candidate, envelope)) refuse();
          await persistence.retainReportObservation(
            {
              groupId,
              seatId: input.seatId,
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
      const confirmTerminal: NonNullable<
        DelegationRoundsHost['context']
      >['confirmTerminal'] = async (spec, candidate, attempt, recipient) => {
        current();
        if (
          !same(spec, effectiveSpec) ||
          candidate.seatId !== input.seatId ||
          (recipient !== null &&
            !same(
              physicalIdentity.parse(recipient),
              physicalIdentity.parse(initialRecipient),
            ))
        )
          return null;
        const value = retained.get(attempt.invocationId);
        let sessionId: string,
          turnId: string,
          evidence: {
            id: string;
            domain: 'station.provider-evidence';
            digest: string;
          };
        let retainedTerminal:
          | Parameters<typeof persistence.readReportObservation>[2]
          | undefined;
        if (value) {
          ({ sessionId, turnId } = value.dispatched);
          evidence = value.dispatched.result.evidenceReference;
        } else {
          const previous = group.attempts.find(
            (a) =>
              a.invocationId === attempt.invocationId &&
              a.seatId === input.seatId,
          );
          const terminalRef =
            previous?.terminal ??
            group.continuations
              .flatMap((c) => c.prepared?.terminalProofs ?? [])
              .find((p) => p.invocationId === attempt.invocationId)?.reference;
          if (!terminalRef) return null;
          const record = await persistence.readReportObservation(
            groupId,
            attempt.invocationId,
            terminalRef,
            current,
          );
          if (
            record.observation.kind !== 'terminal' ||
            record.observation.sessionId !== member.reservedTaskId
          )
            return null;
          if (!record.observation.recipient) return null;
          const recipient = await persistence.readReportFlowObservation(
            groupId,
            record.observation.recipient,
            current,
          );
          const observed = z
            .object({ invocationId: z.string(), identity: physicalIdentity })
            .strict()
            .parse(recipient.value);
          if (
            recipient.kind !== 'recipient' ||
            observed.invocationId !== attempt.invocationId ||
            !same(observed.identity, physicalIdentity.parse(initialRecipient))
          )
            return null;
          retainedTerminal = terminalRef;
          ({ sessionId, turnId, evidence } = record.observation);
        }
        const window = await orchestration.readSessionEventWindow(sessionId, {
          turnLimit: 20,
          authority: sessionReadAuthorityFromRequest(
            root.authenticated_principal_ref.id,
            undefined,
            undefined,
          ),
        });
        const terminal = window?.events.find(
          ({ event }) =>
            event.threadId === sessionId &&
            event.turnId === turnId &&
            event.method === 'turn.completed',
        );
        current();
        if (!terminal || !same(observeRecipient(), initialRecipient))
          return null;
        if (retainedTerminal) return retainedTerminal;
        const recipientRef = await persistence.retainReportFlowObservation(
          groupId,
          'recipient',
          { invocationId: attempt.invocationId, identity: initialRecipient },
          current,
        );
        return persistence.retainReportObservation(
          {
            groupId,
            seatId: input.seatId,
            invocationId: attempt.invocationId,
            observation: {
              kind: 'terminal',
              evidence,
              taskId: member.reservedTaskId,
              sessionId,
              turnId,
              eventId: terminal.event.eventId,
              recipient: recipientRef,
            },
          },
          current,
        );
      };
      const roundsHost: DelegationRoundsHost = {
        accountingProtocol: 'retained-tariff-v1',
        authorize: async ({ action, groupId: candidate, current: state }) => {
          current();
          return ['sync', 'get', 'replay', 'record'].includes(action) &&
            candidate === groupId &&
            (!state || same(state.spec, group.spec))
            ? root.authenticated_principal_ref
            : null;
        },
        executionHost: () => physical,
        recipient: {
          resolve: async () => {
            const resolved = await physical.resolveRuntime(envelope);
            return {
              identity: observeRecipient(),
              runtime: resolved.runtime,
              retainResult: physical.retainResult,
              retainFailure: physical.retainFailure,
              invokeFenced: physical.invokeFenced,
            };
          },
        },
        context: {
          load: (ref) => persistence.readReportContext(groupId, ref, current),
          executionHost: () => physical,
          confirmTerminal,
        },
        retainContinuation: (spec, receipt) => {
          if (!same(spec, effectiveSpec)) refuse();
          return persistence.retainReportFlowObservation(
            groupId,
            'continuation',
            receipt,
            current,
          );
        },
        prepareRequest: async () => refuse(),
        retainObservation: async () => refuse(),
        confirmTerminal: async () => refuse(),
        requestDescendantCancellation: async () => refuse(),
      };
      const schedule = await selected.flow?.readSchedule();
      if (!schedule) refuse();
      const controller = createDelegationRoundsController({
        store: launch.groups,
        authorityService: service,
        dispatchLedger: this.owners.dispatchLedger,
        host: roundsHost,
        cwd: schedule.cwd,
      });
      return await controller.sync(command);
    } finally {
      clearTimeout(timer);
      await Promise.all(prepared.map((turn) => turn.close()));
    }
  }
}
