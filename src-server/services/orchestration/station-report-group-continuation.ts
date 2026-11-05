// UNWIRED(#91): reappraisal/retry serving and combined qualification remain pending.
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
  DelegationRoundsTransactionUncertainError,
  effectiveRoundsSpec,
  projectDelegationRounds,
} from '@kontourai/flow-agents/delegation-group-rounds';
import { canonicalJson, type ModelRuntime } from '@kontourai/relay';
import type {
  ReportGroupContextSyncInput,
  ReportGroupReportInput,
} from '@kontourai/station-contracts/report-group';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { z } from 'zod/v3';
import { outsideStationServerScope } from '../../security/station-server-scope.js';
import type { EnvironmentSecurityService } from '../ssh/environment-security-service.js';
import { HomeWriterOwner } from '../ssh/home-writer-owner.js';
import type {
  PreparedReservedFinalFetchOwners,
  RoundsFinalFetchOwners,
} from './delegation-group-launch-fence.js';
import type { StationDelegationPersistence } from './delegation-group-persistence.js';
import type { RuntimeSourceRequestContext } from './delegation-group-source-admission.js';
import type { FileFinalWireIntentStore } from './delegation-group-wire-intent-store.js';
import type { OrchestrationService } from './orchestration-service.js';
import type {
  ReportRoundsPublication,
  ReportRoundsScope,
} from './report-rounds-publication.js';
import type { StationReportGroupCustody } from './station-report-group-custody.js';
import { StationReportPreparationUnavailable } from './station-report-group-input.js';
import type { StationReportRetainedTurns } from './station-report-retained-turn.js';
import {
  captureReportTerminalWitness,
  verifyReportTerminalWitness,
} from './station-report-terminal-witness.js';

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
      environment: EnvironmentSecurityService;
      authorize(
        context: RuntimeSourceRequestContext,
        publication?: ReportRoundsPublication,
      ): Promise<() => void>;
    },
  ) {
    this.owners = Object.freeze({ ...owners });
  }

  async sync(
    context: RuntimeSourceRequestContext,
    groupId: string,
    sent: ReportGroupContextSyncInput,
    publication?: ReportRoundsPublication,
  ) {
    if (!publication) refuse();
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
    return this.#run(context, groupId, { ...input, kind: 'sync' }, publication);
  }

  async report(
    context: RuntimeSourceRequestContext,
    groupId: string,
    sent: ReportGroupReportInput,
    publication?: ReportRoundsPublication,
  ) {
    if (!publication) refuse();
    const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
    const input = z
      .object({
        operationKey: id,
        expectedRevision: z.number().int().nonnegative().safe(),
        seatId: id,
        flowHead: z.string().regex(/^[a-f0-9]{64}$/),
        syncOperationKey: id,
        previousInvocationId: id,
        retryRef: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(structuredClone(sent));
    return this.#run(
      context,
      groupId,
      { ...input, kind: 'report' },
      publication,
    );
  }

  async #run(
    context: RuntimeSourceRequestContext,
    groupId: string,
    input:
      | (ReportGroupContextSyncInput & { kind: 'sync' })
      | (ReportGroupReportInput & { kind: 'report' }),
    publication: ReportRoundsPublication,
  ) {
    const authorize = await this.owners.authorize(context, publication);
    const loaded = await this.owners.custody.loadIntentForMutation(
      context,
      groupId,
      publication,
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
    const maxRenewals = loaded.intent.continuation.maxRenewals;
    const root = epoch.root;
    const effectiveSpec = effectiveRoundsSpec(group);
    let executionSignal = context.req.raw.signal;
    const sourceCurrent = (): undefined => {
      publication.assertCurrent();
      authorize();
      executionSignal.throwIfAborted();
      return undefined;
    };
    const requestWriter = await HomeWriterOwner.forHome(
      this.owners.environment.getProjectHomeDir(),
    );
    const withScope = <Value>(
      work: (scope: ReportRoundsScope) => Promise<Value>,
    ): Promise<Value> =>
      publication.withHome(
        { owner: requestWriter, current: sourceCurrent },
        work,
      );
    const metadata = <Value>(
      work: (current: () => undefined) => Promise<Value>,
    ) => withScope((scope) => work(scope.current));
    const original = loaded.intent.members.find(
      (entry) => entry.seatId === input.seatId,
    );
    if (!original) refuse();
    const exchange =
      input.kind === 'report'
        ? group.continuations.find(
            (entry) => entry.command.operationKey === input.syncOperationKey,
          )
        : undefined;
    if (
      input.kind === 'report' &&
      (exchange?.command.kind !== 'sync' ||
        exchange.command.seatId !== input.seatId ||
        !exchange.receipt?.acknowledged)
    )
      refuse();
    const contextRef =
      input.kind === 'sync'
        ? await metadata((scopedCurrent) =>
            persistence.retainReportContext(groupId, input.text, scopedCurrent),
          )
        : exchange?.command.kind === 'sync'
          ? exchange.command.contextRef
          : refuse();
    const text =
      input.kind === 'sync'
        ? input.text
        : await metadata((scopedCurrent) =>
            persistence.readReportContext(groupId, contextRef, scopedCurrent),
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
            ...(input.kind === 'report'
              ? [
                  input.syncOperationKey,
                  input.previousInvocationId,
                  input.retryRef,
                ]
              : []),
          ]),
        )
        .digest('hex')}`,
    };
    const commandBase = {
      groupId,
      operationKey: input.operationKey,
      expectedRevision: input.expectedRevision,
      controller: group.spec.controller,
      checkpoint,
      flowHead: input.flowHead,
    };
    const command =
      input.kind === 'sync'
        ? {
            ...commandBase,
            kind: 'sync' as const,
            seatId: input.seatId,
            contextRef,
          }
        : {
            ...commandBase,
            kind: 'release' as const,
            seats: [
              {
                seatId: input.seatId,
                mode: 'invoke' as const,
                syncKey: input.syncOperationKey,
                previousInvocationId: input.previousInvocationId,
                retryRef: input.retryRef,
              },
            ],
          };
    const prior = await withScope((scope) => {
      const scopedCurrent = scope.current;
      return persistence
        .roundsStore(scopedCurrent, scopedCurrent, scope)
        .transact(groupId, async (journal) => {
          if (!journal) refuse();
          const event = journal.events.find(
            (entry) =>
              entry.kind === 'command' &&
              entry.command.operationKey === input.operationKey,
          );
          if (event?.kind === 'command' && !same(event.command, command))
            refuse();
          return {
            journal,
            result: event ? projectDelegationRounds(journal) : null,
          };
        });
    });
    // A retained command is never a request to recreate the paid operation.
    if (prior) return { replayed: true, projection: prior };
    if (Date.now() >= loaded.intent.deadlineAt) refuse();
    const deadline = new AbortController();
    const timer = outsideStationServerScope(() =>
      setTimeout(
        () => deadline.abort(),
        Math.max(1, loaded.intent.deadlineAt - Date.now()),
      ),
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
    const request =
      input.kind === 'report'
        ? {
            messages: [
              { role: 'user' as const, content: text },
              { role: 'user' as const, content: original.brief },
            ],
            maxOutputTokens: seat.allocation.outputTokens,
          }
        : {
            messages: [
              {
                role: 'system' as const,
                content: `Receive context only. Do not call tools. Reply exactly ACK SYNC ${runId}`,
              },
              { role: 'user' as const, content: text },
            ],
            tools: [],
            maxOutputTokens: seat.allocation.outputTokens,
          };
    const syncInput = { runId, text };
    const prepared: Prepared[] = [];
    const retained = new Map<
      string,
      { dispatched: Result; prepared: Prepared }
    >();
    const invocation = new AsyncLocalStorage<string>();
    const outcome = await (async () => {
      const prepare = () =>
        input.kind === 'sync'
          ? turns.prepare(
              context,
              groupId,
              input.seatId,
              envelope,
              syncInput,
              publication,
            )
          : turns.prepareReport(
              context,
              groupId,
              input.seatId,
              envelope,
              request,
              publication,
            );
      let selected = await prepare();
      prepared.push(selected);
      let consumed = false;
      const observeRecipient = () => ({
        ...selected.recipient(),
        authority: group.grants.authority,
        envelope: { id: grant.envelope.id, digest: grant.envelope.digest },
        runtimeReceipt: envelope.execution_binding.runtime.runtime_receipt_ref,
        modelReceipt: envelope.execution_binding.runtime.model_receipt_ref,
      });
      const initialRecipient = await withScope(async (scope) =>
        scope.check(observeRecipient),
      );
      const originalAttempt = group.attempts
        .filter((a) => a.seatId === input.seatId && a.terminal)
        .at(-1);
      if (!originalAttempt?.terminal) refuse();
      const observation = await metadata(async (scopedCurrent) => {
        const originalTerminal = await persistence.readReportObservation(
          groupId,
          originalAttempt.invocationId,
          originalAttempt.terminal!,
          scopedCurrent,
        );
        if (
          originalTerminal.observation.kind !== 'terminal' ||
          !originalTerminal.observation.recipient ||
          originalTerminal.observation.sessionId !== member.reservedTaskId
        )
          refuse();
        return persistence.readReportFlowObservation(
          groupId,
          originalTerminal.observation.recipient,
          scopedCurrent,
        );
      });
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
      const build = (scope?: ReportRoundsScope) => {
        const current = scope?.current ?? sourceCurrent;
        const check = <Value>(body: () => Value): Value =>
          scope
            ? scope.check(body)
            : this.owners.environment.withCurrentAuthority(body);
        const checkAsync = <Value>(body: () => Value): Promise<Value> =>
          scope
            ? Promise.resolve(scope.check(body))
            : requestWriter.runRequest(executionSignal, () => check(body));
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
            check(() => selected.assertCurrent());
            return (
              same(candidate, envelope) &&
              same(check(observeRecipient), initialRecipient)
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
          groups: persistence.roundsStore(current, current, scope),
          authorities: persistence.roundsAuthorityStore(
            current,
            current,
            scope,
          ),
          host,
          intents: this.owners.wireIntents,
          finalizeCurrent: current,
          flow: selected.flow,
          reportHome: {
            owner: requestWriter,
            persistence,
            current,
            preparationCurrent: current,

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
                { owner: requestWriter, current: sourceCurrent },
                (scope): Promise<Value> => {
                  const scoped: PreparedReservedFinalFetchOwners =
                    build(scope).launch;
                  return body(scope, {
                    groups: scoped.groups,
                    authorities: scoped.authorities,
                    host: scoped.host,
                  });
                },
              ),
            check: <Value>(guard: () => undefined, body: () => Value) =>
              publication.check({ owner: requestWriter, current: guard }, body),
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
          },
        };
        const service = createDelegationAuthorityServiceV3(
          launch.authorities,
          host,
          { maxRenewals },
        );
        const physical: ReturnType<DelegationRoundsHost['executionHost']> = {
          resolveRuntime: async (candidate) => {
            await checkAsync(() => {
              current();
              if (!same(candidate, envelope)) refuse();
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
              invoke: async (actual, options) => {
                if (scope) refuse();
                const started = Date.now();
                const id = invocation.getStore();
                await checkAsync(() => {
                  current();
                  if (!id || !same(actual, request)) refuse();
                });
                if (!id) refuse();
                if (consumed) {
                  if (input.kind !== 'sync') refuse();
                  selected = await prepare();
                  prepared.push(selected);
                }
                consumed = true;
                await checkAsync(() => {
                  if (!same(check(observeRecipient), initialRecipient))
                    refuse();
                });
                const dispatched = await selected.dispatch(
                  id,
                  input.kind === 'sync' ? 'context-sync' : seat.effect,
                  launch,
                  options?.signal
                    ? AbortSignal.any([executionSignal, options.signal])
                    : executionSignal,
                );
                await checkAsync(() => {
                  retained.set(id, { dispatched, prepared: selected });
                });
                const result = dispatched.result;
                return {
                  provider: selected.provider,
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
              modelReceipt:
                envelope.execution_binding.runtime.model_receipt_ref,
            };
          },
          invokeFenced: async (candidate, id, invoke) => {
            if (scope) refuse();
            await checkAsync(() => {
              current();
              if (!same(candidate, envelope)) refuse();
            });
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
                .find((p) => p.invocationId === attempt.invocationId)
                ?.reference;
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
            if (
              record.observation.witness &&
              !verifyReportTerminalWitness(
                record.observation.witness,
                this.owners.environment,
              )
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
            const { sessionId, eventId } = record.observation;
            const terminal = await checkAsync(() =>
              orchestration.readSessionEventById(
                sessionId,
                eventId,
                sessionReadAuthorityFromRequest(
                  root.authenticated_principal_ref.id,
                  undefined,
                  undefined,
                ),
              ),
            );
            current();
            if (
              terminal?.method !== 'turn.completed' ||
              terminal.eventId !== record.observation.eventId ||
              terminal.threadId !== record.observation.sessionId ||
              terminal.turnId !== record.observation.turnId ||
              !same(check(observeRecipient), initialRecipient)
            )
              return null;
            return terminalRef;
          }
          const readWindow = () =>
            orchestration.readSessionEventWindow(sessionId, {
              turnLimit: 20,
              authority: sessionReadAuthorityFromRequest(
                root.authenticated_principal_ref.id,
                undefined,
                undefined,
              ),
            });
          const window = scope
            ? await requestWriter.withLeaseLifetime(scope.lease, readWindow)
            : await requestWriter.runOwnedLease(executionSignal, (lease) =>
                requestWriter.withLeaseLifetime(lease, readWindow),
              );
          const terminal = window?.events.find(
            ({ event }) =>
              event.threadId === sessionId &&
              event.turnId === turnId &&
              event.method === 'turn.completed',
          );
          current();
          if (!terminal || !same(check(observeRecipient), initialRecipient))
            return null;
          const witness = check(() =>
            captureReportTerminalWitness(
              { environment: this.owners.environment, orchestration, current },
              {
                groupId,
                seatId: input.seatId,
                invocationId: attempt.invocationId,
                root: rootAuthorityReferenceV2(root),
                envelope: {
                  id: envelope.envelope_id,
                  generation: envelope.generation,
                  digest: delegationEnvelopeDigestV2(envelope),
                },
                evidence,
                ownerId: root.authenticated_principal_ref.id,
                turn: {
                  conversationId: member.reservedTaskId,
                  sessionId,
                  clientTurnId: value.dispatched.clientTurnId,
                  turnId,
                },
              },
            ),
          );
          if (
            !witness ||
            witness.data.terminal.terminalEventId !== terminal.event.eventId
          )
            return null;
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
                witness,
                recipient: recipientRef,
              },
            },
            current,
          );
        };
        const roundsHost: DelegationRoundsHost = {
          accountingProtocol: 'retained-tariff-v1',
          authorize: async ({
            action,
            groupId: candidate,
            current: state,
            command: observed,
          }) => {
            current();
            if (
              (action === 'release' || action === 'execute') &&
              !same(observed, command)
            )
              return null;
            if (
              action === 'terminal' &&
              (observed?.kind !== 'terminal' ||
                !retained.has(observed.invocationId))
            )
              return null;
            return (input.kind === 'sync'
              ? ['sync', 'get', 'replay', 'record']
              : ['release', 'terminal', 'execute', 'get', 'replay', 'record']
            ).includes(action) &&
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
                identity: await checkAsync(observeRecipient),
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
          ...(input.kind === 'report'
            ? {
                flow: {
                  executionHost: () => ({
                    ...physical,
                    recordScheduleEvent: async (event) => {
                      await persistence.retainReportFlowObservation(
                        groupId,
                        'schedule',
                        event,
                        current,
                      );
                    },
                    confirmClaim: async (claim, candidate) => {
                      if (
                        !same(candidate, envelope) ||
                        claim.step_id !== seat.stepId ||
                        !selected.flow
                      )
                        return false;
                      const flow = selected.flow;
                      if (!scope) refuse();
                      await flow.withCurrentClaim(
                        claim,
                        () => ({ value: undefined }),
                        scope,
                      );
                      current();
                      return true;
                    },
                    prepareRequest: async () => ({
                      messages: [
                        { role: 'user' as const, content: original.brief },
                      ],
                      maxOutputTokens: seat.allocation.outputTokens,
                    }),
                    recordMemberOutcome: async (claim, _candidate, outcome) => {
                      await persistence.retainReportFlowObservation(
                        groupId,
                        'member',
                        {
                          claim,
                          seatId: input.seatId,
                          outcome: outcome.outcome,
                        },
                        current,
                      );
                    },
                  }),
                  confirmRetainedResult: async () => false,
                  retainEvaluation: async (spec, action, receipt) => {
                    if (
                      !same(spec, effectiveSpec) ||
                      action.seatId !== input.seatId
                    )
                      refuse();
                    return persistence.retainReportFlowObservation(
                      groupId,
                      'evaluation',
                      { action, receipt },
                      current,
                    );
                  },
                } satisfies NonNullable<DelegationRoundsHost['flow']>,
              }
            : {}),
          prepareRequest: async () => refuse(),
          retainObservation: async (spec, attempt) => {
            if (!same(spec, effectiveSpec) || attempt.seatId !== input.seatId)
              refuse();
            const value = retained.get(attempt.invocationId);
            if (!value) refuse();
            const result = value.dispatched.result;
            return persistence.retainReportObservation(
              {
                groupId,
                seatId: input.seatId,
                invocationId: attempt.invocationId,
                observation: {
                  kind: 'result',
                  evidence: result.evidenceReference,
                  text: result.sdkResult.text,
                  modelId: member.requestedModelId,
                  inputTokens: result.accounting.inputTokens,
                  outputTokens: result.accounting.outputTokens,
                  costMicros: result.accounting.costMicros,
                },
              },
              current,
            );
          },
          confirmTerminal: async (spec, attempt, invocation) => {
            if (
              !same(spec, group.spec) ||
              attempt.seatId !== input.seatId ||
              attempt.invocationId !== invocation.invocationId
            )
              return null;
            return confirmTerminal(
              effectiveSpec,
              seat,
              invocation,
              initialRecipient,
            );
          },
          requestDescendantCancellation: async () => refuse(),
        };
        return { host, launch, service, physical, confirmTerminal, roundsHost };
      };
      const base = build();
      const facadeMetadata = <Value>(
        work: (value: ReturnType<typeof build>) => Promise<Value>,
      ) =>
        publication.withHome(
          { owner: requestWriter, current: sourceCurrent },
          (scope) => work(build(scope)),
        );
      const service: typeof base.service = {
        issue: (...args) =>
          facadeMetadata((value) => value.service.issue(...args)),
        derive: (...args) =>
          facadeMetadata((value) => value.service.derive(...args)),
        inspect: (...args) =>
          facadeMetadata((value) => value.service.inspect(...args)),
        admitEffect: (...args) =>
          facadeMetadata((value) => value.service.admitEffect(...args)),
        reserveInvocation: (...args) =>
          facadeMetadata((value) => value.service.reserveInvocation(...args)),
        reconcileInvocation: (...args) =>
          facadeMetadata((value) => value.service.reconcileInvocation(...args)),
        cancel: (...args) =>
          facadeMetadata((value) => value.service.cancel(...args)),
        renew: (...args) =>
          facadeMetadata((value) => value.service.renew(...args)),
        importV2: (...args) =>
          facadeMetadata((value) => value.service.importV2(...args)),
      };
      const physical: typeof base.physical = {
        ...base.physical,
        retainResult: (...args) =>
          facadeMetadata((value) => value.physical.retainResult(...args)),
        retainFailure: (...args) =>
          facadeMetadata((value) => value.physical.retainFailure(...args)),
      };
      const flowExecution = base.roundsHost.flow?.executionHost(effectiveSpec);
      const roundsHost: DelegationRoundsHost = {
        ...base.roundsHost,
        executionHost: () => physical,
        authorize: (...args) =>
          facadeMetadata((value) => value.roundsHost.authorize(...args)),
        retainObservation: (...args) =>
          facadeMetadata((value) =>
            value.roundsHost.retainObservation(...args),
          ),
        confirmTerminal: (...args) =>
          facadeMetadata((value) => value.roundsHost.confirmTerminal(...args)),
        retainContinuation: (...args) =>
          facadeMetadata((value) => {
            const retain = value.roundsHost.retainContinuation;
            if (!retain) refuse();
            return retain(...args);
          }),
        recipient: {
          resolve: async (...args) => {
            const resolve = base.roundsHost.recipient?.resolve;
            if (!resolve) refuse();
            const value = await resolve(...args);
            return {
              ...value,
              retainResult: physical.retainResult,
              retainFailure: physical.retainFailure,
              invokeFenced: physical.invokeFenced,
            };
          },
        },
        context: {
          load: (reference) =>
            facadeMetadata((value) => {
              if (!value.roundsHost.context) refuse();
              return value.roundsHost.context.load(reference);
            }),
          executionHost: () => physical,
          confirmTerminal: (...args) =>
            facadeMetadata((value) => value.confirmTerminal(...args)),
        },
        ...(flowExecution
          ? {
              flow: {
                executionHost: () => ({
                  ...physical,
                  recordScheduleEvent: (...args) =>
                    facadeMetadata((value) => {
                      const flow =
                        value.roundsHost.flow?.executionHost(effectiveSpec);
                      if (!flow) refuse();
                      return flow.recordScheduleEvent(...args);
                    }),
                  confirmClaim: (...args) =>
                    facadeMetadata((value) => {
                      const flow =
                        value.roundsHost.flow?.executionHost(effectiveSpec);
                      if (!flow) refuse();
                      return flow.confirmClaim(...args);
                    }),
                  prepareRequest: (...args) =>
                    facadeMetadata((value) => {
                      const flow =
                        value.roundsHost.flow?.executionHost(effectiveSpec);
                      if (!flow) refuse();
                      return flow.prepareRequest(...args);
                    }),
                  recordMemberOutcome: (...args) =>
                    facadeMetadata((value) => {
                      const flow =
                        value.roundsHost.flow?.executionHost(effectiveSpec);
                      if (!flow) refuse();
                      return flow.recordMemberOutcome(...args);
                    }),
                }),
                confirmRetainedResult: async () => false,
                retainEvaluation: (...args) =>
                  facadeMetadata((value) => {
                    if (!value.roundsHost.flow) refuse();
                    return value.roundsHost.flow.retainEvaluation(...args);
                  }),
              },
            }
          : {}),
      };
      const schedule = selected.flow
        ? await withScope((scope) => selected.flow!.readSchedule(scope))
        : undefined;
      if (!schedule) refuse();
      const controller = createDelegationRoundsController({
        store: base.launch.groups,
        authorityService: service,
        dispatchLedger: this.owners.dispatchLedger,
        host: roundsHost,
        cwd: schedule.cwd,

        transactionOwner: publication.transactionOwner({
          groupId,
          owner: requestWriter,
          current: sourceCurrent,
          build: (scope) => {
            const value = build(scope);
            return {
              store: value.launch.groups,
              host: value.roundsHost,
              authorityService: value.service,
            };
          },
        }),
      });
      if (command.kind === 'sync') return await controller.sync(command);
      const preceding = loaded.authority?.invocations
        .filter((entry) => entry.envelopeId === envelope.envelope_id)
        .at(-1);
      if (
        !preceding?.terminal ||
        preceding.usage === null ||
        !(await facadeMetadata((value) =>
          value.confirmTerminal(
            effectiveSpec,
            seat,
            preceding,
            initialRecipient,
          ),
        ))
      )
        refuse();
      let result = await controller.release(command);
      if (result.replayed) return result;
      for (const attempt of result.projection.attempts.filter(
        (entry) =>
          entry.round === result.projection.rounds.length &&
          entry.seatId === input.seatId &&
          !entry.terminal &&
          entry.admission !== 'not_admitted',
      )) {
        result = await controller.recordTerminal({
          kind: 'terminal',
          groupId,
          operationKey: `terminal:${attempt.invocationId}`,
          expectedRevision: result.projection.revision,
          controller: group.spec.controller,
          invocationId: attempt.invocationId,
        });
      }
      return result;
    })().then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    clearTimeout(timer);
    const closed = await Promise.allSettled(
      prepared.map(async (turn) => turn.close()),
    );
    const cleanupErrors: unknown[] = closed.flatMap((entry) =>
      entry.status === 'rejected' ? [entry.reason] : [],
    );
    if (cleanupErrors.length)
      throw new DelegationRoundsTransactionUncertainError(
        outcome.ok ? 'returned-cleanup-unknown' : 'publication-unknown',
        outcome.ok ? cleanupErrors : [outcome.error, ...cleanupErrors],
      );
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }
}
