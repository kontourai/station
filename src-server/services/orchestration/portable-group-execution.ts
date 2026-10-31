import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthorizationLedger } from '@kontourai/dispatch';
import type { FlowDurableStepClaim } from '@kontourai/flow';
import { createDelegationAuthorityService } from '@kontourai/flow-agents/delegation-authority-service';
import type { DelegationDispatchAccountingOutcomeV1 } from '@kontourai/flow-agents/delegation-dispatch';
import type { DelegationEnvelopeV2 } from '@kontourai/flow-agents/delegation-envelope-v2';
import {
  createDelegationGroupControllerAccountingV1,
  type DelegationGroupAccountingHostV1,
  projectDelegationGroupV2,
} from '@kontourai/flow-agents/delegation-group-v2';
import { canonicalJson, type ModelRuntime } from '@kontourai/relay';
import type { reservedStationTurnResult } from '../../runtime/conversation/reserved-station-turn.js';
import type { DelegatedTaskHandle } from '../../tools/station-control-delegation.js';
import type { StationDelegationPersistence } from './delegation-group-persistence.js';
import {
  inspectSdkSourceWire,
  sdkDisposalPromise,
} from './delegation-group-sdk-source-wire-owner.js';
import type { RuntimeSourceRequestContext } from './delegation-group-source-admission.js';
import type { FileFinalWireIntentStore } from './delegation-group-wire-intent-store.js';
import type { OrchestrationService } from './orchestration-service.js';
import type { PortableGroupAdmissionStore } from './portable-group-admission-store.js';
import type {
  PortableGroupPreparation,
  PreparedPortableGroup,
} from './portable-group-preparation.js';
import { parseStationReportGroupInput } from './station-report-group-input.js';

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function refuse(): never {
  throw new Error('portable_group_unavailable');
}
type Retained = {
  attempt: Awaited<ReturnType<typeof reservedStationTurnResult>>;
  task: DelegatedTaskHandle;
  envelopeId: string;
};

/** Operator-only V2 composition. Other caller classes require their own admission owner. */
// UNWIRED(#91): factory serving and full caller/protocol qualification remain open.
export class PortableGroupExecution {
  readonly #creating = new Map<
    string,
    {
      intent: string;
      promise: Promise<{
        replayed: boolean;
        projection: import('@kontourai/flow-agents/delegation-group-v2').DelegationGroupProjectionV2;
      }>;
    }
  >();
  constructor(
    private readonly owners: {
      preparation: PortableGroupPreparation;
      admissions: PortableGroupAdmissionStore;
      persistence: StationDelegationPersistence;
      dispatchLedger: AuthorizationLedger;
      wireIntents: FileFinalWireIntentStore;
      orchestration: OrchestrationService;
      authorize(context: RuntimeSourceRequestContext): Promise<() => undefined>;
    },
  ) {}

  async create(
    context: RuntimeSourceRequestContext,
    input: Parameters<PortableGroupPreparation['prepare']>[1],
  ) {
    const current = await this.owners.authorize(context);
    await this.owners.preparation.bindRequest(context);
    const parsed = parseStationReportGroupInput(input);
    const { groupId } = await this.owners.preparation.operationIdentity(
      context,
      parsed,
    );
    current();
    const intent = canonicalJson(parsed);
    const active = this.#creating.get(groupId);
    if (active) {
      if (active.intent !== intent) refuse();
      const result = await active.promise;
      current();
      const retained = this.owners.admissions.read(groupId, current);
      if (
        !retained ||
        !same(
          this.owners.preparation.inspectAdmission(context, retained).intent,
          parsed,
        )
      )
        refuse();
      return { ...result, replayed: true };
    }
    if (this.#creating.size >= 128) refuse();
    const prior = this.owners.admissions.read(groupId, current);
    if (
      prior &&
      !same(
        this.owners.preparation.inspectAdmission(context, prior).intent,
        parsed,
      )
    )
      refuse();
    const promise = prior
      ? this.#resumeCreate(context, prior, current)
      : this.#createNew(context, parsed, current);
    this.#creating.set(groupId, { intent, promise });
    try {
      return await promise;
    } finally {
      if (this.#creating.get(groupId)?.promise === promise)
        this.#creating.delete(groupId);
    }
  }

  async #resumeCreate(
    context: RuntimeSourceRequestContext,
    admission: ReturnType<PortableGroupPreparation['admission']>,
    current: () => undefined,
  ) {
    const metadata = this.owners.preparation.inspectAdmission(
      context,
      admission,
    );
    const existing = await this.owners.persistence
      .groupStore(current)
      .scan(async (journals) =>
        journals.find((journal) => journal.groupId === metadata.spec.groupId),
      );
    if (existing) {
      const projection = projectDelegationGroupV2(existing);
      if (!same(projection.spec, metadata.spec)) refuse();
      return { replayed: true, projection };
    }
    const handle = await this.owners.preparation.readmit(context, admission);
    try {
      return await this.#publishCreate(
        context,
        handle,
        current,
        metadata.intent.operationId,
      );
    } finally {
      this.owners.preparation.close(handle);
    }
  }

  async #createNew(
    context: RuntimeSourceRequestContext,
    input: Parameters<PortableGroupPreparation['prepare']>[1],
    current: () => undefined,
  ) {
    const handle = await this.owners.preparation.prepare(context, input);
    try {
      const prepared = this.owners.preparation.read(handle, context.req.raw);
      const admission = this.owners.preparation.admission(
        handle,
        context.req.raw,
      );
      await this.owners.admissions.retain(
        prepared.spec.groupId,
        admission,
        current,
      );
      return await this.#publishCreate(
        context,
        handle,
        current,
        input.operationId,
      );
    } finally {
      this.owners.preparation.close(handle);
    }
  }

  async #publishCreate(
    context: RuntimeSourceRequestContext,
    handle: PreparedPortableGroup,
    current: () => undefined,
    operationId: string,
  ) {
    const prepared = this.owners.preparation.read(handle, context.req.raw);
    const composed = this.#compose(context, handle, current);
    await composed.service.issue(prepared.root);
    for (const envelope of prepared.envelopes)
      await composed.service.derive(prepared.root.authority_id, envelope);
    return composed.controller.create({
      kind: 'create',
      groupId: prepared.spec.groupId,
      operationKey: operationId,
      expectedRevision: 0,
      controller: prepared.spec.controller,
      spec: prepared.spec,
    });
  }

  async get(context: RuntimeSourceRequestContext, groupId: string) {
    const current = await this.owners.authorize(context);
    await this.owners.preparation.bindRequest(context);
    const admission = this.owners.admissions.read(groupId, current);
    if (!admission) refuse();
    const metadata = this.owners.preparation.inspectAdmission(
      context,
      admission,
    );
    if (metadata.spec.groupId !== groupId) refuse();
    return this.owners.persistence
      .groupStore(current)
      .transact(groupId, async (journal) => {
        if (!journal) refuse();
        const projection = projectDelegationGroupV2(journal);
        if (!same(projection.spec, metadata.spec)) refuse();
        current();
        return { journal, result: projection };
      });
  }

  async events(
    context: RuntimeSourceRequestContext,
    groupId: string,
    afterRevision = 0,
  ) {
    if (
      !Number.isSafeInteger(afterRevision) ||
      afterRevision < 0 ||
      afterRevision > 512
    )
      refuse();
    const current = await this.owners.authorize(context);
    await this.owners.preparation.bindRequest(context);
    const admission = this.owners.admissions.read(groupId, current);
    if (!admission) refuse();
    const metadata = this.owners.preparation.inspectAdmission(
      context,
      admission,
    );
    if (metadata.spec.groupId !== groupId) refuse();
    return this.owners.persistence
      .groupStore(current)
      .transact(groupId, async (journal) => {
        if (!journal) refuse();
        const projection = projectDelegationGroupV2(journal);
        if (!same(projection.spec, metadata.spec)) refuse();
        current();
        return {
          journal,
          result: journal.events.filter(
            (event) => event.revision > afterRevision,
          ),
        };
      });
  }

  async run(
    context: RuntimeSourceRequestContext,
    groupId: string,
    operationId: string,
    expectedRevision: number,
  ) {
    const current = await this.owners.authorize(context);
    await this.owners.preparation.bindRequest(context);
    const admission = this.owners.admissions.read(groupId, current);
    if (!admission) refuse();
    const handle = await this.owners.preparation.readmit(context, admission);
    const prepared = this.owners.preparation.read(handle, context.req.raw);
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(),
      Math.max(1, prepared.intent.deadlineAt - Date.now()),
    );
    const signal = AbortSignal.any([context.req.raw.signal, deadline.signal]);
    try {
      if (prepared.spec.groupId !== groupId) refuse();
      const flow =
        prepared.spec.topology.kind === 'flow'
          ? this.owners.preparation.flow(handle, context.req.raw)
          : undefined;
      if (prepared.spec.topology.kind === 'flow' && !flow) refuse();
      const cwd = flow ? (await flow.readSchedule()).cwd : undefined;
      current();
      const composed = this.#compose(context, handle, current, cwd);
      return await composed.controller.run(
        {
          kind: 'run',
          groupId,
          operationKey: operationId,
          expectedRevision,
          controller: prepared.spec.controller,
        },
        { signal },
      );
    } finally {
      clearTimeout(timer);
      deadline.abort();
      this.owners.preparation.close(handle);
    }
  }

  #compose(
    context: RuntimeSourceRequestContext,
    handle: PreparedPortableGroup,
    requestCurrent: () => undefined,
    cwd?: string,
  ) {
    const { preparation, persistence } = this.owners;
    const prepared = preparation.read(handle, context.req.raw);
    const current = (): undefined => {
      requestCurrent();
      preparation.assertCurrent(handle, context.req.raw);
      return undefined;
    };
    const retained = new Map<string, Retained>();
    const invocation = new AsyncLocalStorage<{
      envelope: DelegationEnvelopeV2;
      id: string;
      claim?: FlowDurableStepClaim;
    }>();
    const claims = new Map<string, FlowDurableStepClaim>();
    const invocationByEnvelope = new Map<string, string>();
    const resultReferences = new Map<
      string,
      Awaited<
        ReturnType<StationDelegationPersistence['retainReportObservation']>
      >
    >();
    const outcomeManifest = (
      seat: (typeof prepared.spec.seats)[number],
      outcome: DelegationDispatchAccountingOutcomeV1,
    ) => {
      const invocationId = invocationByEnvelope.get(seat.envelope.id);
      const value = invocationId ? retained.get(invocationId) : undefined;
      const resultRef = invocationId
        ? resultReferences.get(invocationId)
        : undefined;
      if (outcome.result) {
        if (
          !invocationId ||
          !value ||
          value.envelopeId !== seat.envelope.id ||
          !resultRef ||
          outcome.result.outputText !== value.attempt.sdkResult.text ||
          outcome.result.model !==
            prepared.members.find((member) => member.seatId === seat.seatId)
              ?.modelId ||
          outcome.result.usage?.inputTokens !==
            value.attempt.accounting.inputTokens ||
          outcome.result.usage?.outputTokens !==
            value.attempt.accounting.outputTokens
        )
          refuse();
      }
      if (resultRef && (!value || value.envelopeId !== seat.envelope.id))
        refuse();
      return {
        seatId: seat.seatId,
        invocationId: invocationId ?? null,
        outcome: outcome.outcome,
        dispatchReceipt: outcome.dispatchReceipt,
        ...(outcome.reportedCostUsd === undefined
          ? {}
          : { reportedCostUsd: outcome.reportedCostUsd }),
        accountedCostUsd: outcome.accountedCostUsd,
        costBasis: outcome.costBasis,
        resultRef: resultRef ?? null,
      };
    };
    const memberFor = (envelope: DelegationEnvelopeV2) => {
      current();
      const member = prepared.members.find(
        (value) => value.taskId === envelope.execution_id,
      );
      const seat = prepared.spec.seats.find(
        (value) => value.seatId === member?.seatId,
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
        if (
          !result ||
          result.envelopeId !== candidate.envelopeId ||
          !candidate.terminal
        )
          return false;
        await persistence.assertProviderEvidenceRetained(
          result.attempt.evidence,
          result.attempt.evidenceReference,
          current,
        );
        const accounting = result.attempt.accounting;
        return same(candidate.usage, {
          inputTokens: accounting.inputTokens,
          outputTokens: accounting.outputTokens,
          costMicros: accounting.costMicros,
        });
      },
    };
    const launch = {
      protocol: 'group-v2' as const,
      groups: persistence.groupStore(current),
      authorities: persistence.authorityStore(current),
      host,
      intents: this.owners.wireIntents,
      finalizeCurrent: current,
    };
    const service = createDelegationAuthorityService(launch.authorities, host);
    const physical: ReturnType<
      DelegationGroupAccountingHostV1['executionHost']
    > = {
      accountingProtocol: 'retained-tariff-v1',
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
                    groupId: prepared.spec.groupId,
                    controller: prepared.spec.controller,
                    seatId: seat.seatId,
                    authority: prepared.spec.rootAuthorityRef,
                    envelope: seat.envelope,
                    invocationId: selected.id,
                    effect: seat.effect,
                    allocation: seat.allocation,
                    ...(selected.claim ? { flowClaim: selected.claim } : {}),
                  },
                  contract: captured.contract,
                  provider: member.provider,
                  signal: options?.signal
                    ? AbortSignal.any([context.req.raw.signal, options.signal])
                    : context.req.raw.signal,
                  now: Date.now,
                  maxResponseBytes: 1024 * 1024,
                },
              },
              this.owners.orchestration,
            );
            const attempt = await dispatched.result;
            await sdkDisposalPromise(sdk.owner, sdk.sdkHandle);
            current();
            retained.set(selected.id, {
              attempt,
              task: dispatched.task,
              envelopeId: envelope.envelope_id,
            });
            return {
              provider: member.provider,
              model: member.modelId,
              outputText: attempt.sdkResult.text,
              toolCalls: [],
              usage: {
                inputTokens: attempt.accounting.inputTokens,
                outputTokens: attempt.accounting.outputTokens,
                totalTokens:
                  attempt.accounting.inputTokens +
                  attempt.accounting.outputTokens,
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
        if (invocationByEnvelope.has(envelope.envelope_id)) refuse();
        invocationByEnvelope.set(envelope.envelope_id, id);
        const claim = claims.get(envelope.envelope_id);
        if (prepared.spec.topology.kind === 'flow' && !claim) refuse();
        if (prepared.spec.topology.kind !== 'flow' && claim) refuse();
        if (claim) claims.delete(envelope.envelope_id);
        return invocation.run(
          { envelope, id, ...(claim ? { claim } : {}) },
          invoke,
        );
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
        const resultRef = await persistence.retainReportObservation(
          {
            groupId: prepared.spec.groupId,
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
        if (
          invocationByEnvelope.get(envelope.envelope_id) !== id ||
          resultReferences.has(id)
        )
          refuse();
        resultReferences.set(id, resultRef);
        return value.attempt.accounting;
      },
      retainFailure: async (_error, envelope, id) => {
        const { seat } = memberFor(envelope);
        await persistence.retainReportObservation(
          {
            groupId: prepared.spec.groupId,
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
      recordScheduleEvent: async (event) => {
        current();
        await persistence.retainReportFlowObservation(
          prepared.spec.groupId,
          'schedule',
          event,
          current,
        );
      },
      confirmClaim: async (claim, envelope) => {
        const { seat } = memberFor(envelope);
        const owner = preparation.flow(handle, context.req.raw, seat.seatId);
        if (!owner || claim.step_id !== seat.stepId) return false;
        await owner.withCurrentClaim(claim, () => ({ value: undefined }));
        current();
        return true;
      },
      prepareRequest: async (claim, envelope) => {
        const { seat, member } = memberFor(envelope);
        const owner = preparation.flow(handle, context.req.raw, seat.seatId);
        if (
          !owner ||
          claim.step_id !== seat.stepId ||
          claims.has(envelope.envelope_id)
        )
          refuse();
        await owner.withCurrentClaim(claim, () => ({ value: undefined }));
        current();
        claims.set(envelope.envelope_id, structuredClone(claim));
        return {
          messages: [{ role: 'user', content: member.brief }],
          maxOutputTokens: seat.allocation.outputTokens,
        };
      },
      recordMemberOutcome: async (claim, envelope, outcome) => {
        const { seat } = memberFor(envelope);
        await persistence.retainReportFlowObservation(
          prepared.spec.groupId,
          'member',
          { claim, envelope: seat.envelope, ...outcomeManifest(seat, outcome) },
          current,
        );
      },
    };
    const retain = (kind: 'member' | 'schedule', value: unknown) =>
      persistence.retainReportFlowObservation(
        prepared.spec.groupId,
        kind,
        value,
        current,
      );
    const groupHost: DelegationGroupAccountingHostV1 = {
      authorize: async (input) => {
        current();
        if (input.groupId !== null && input.groupId !== prepared.spec.groupId)
          return null;
        if (input.spec && !same(input.spec, prepared.spec)) return null;
        return prepared.root.authenticated_principal_ref;
      },
      executionHost: () => physical,
      prepareIndependentRequest: async (_spec, seat, envelope) => {
        const { member } = memberFor(envelope);
        return {
          messages: [{ role: 'user', content: member.brief }],
          maxOutputTokens: seat.allocation.outputTokens,
        };
      },
      retainMemberOutcome: async (_spec, seat, outcome) => {
        const ref = await retain('member', outcomeManifest(seat, outcome));
        return { outcomeRef: ref, dissentRefs: [], uncertaintyRefs: [ref] };
      },
      retainRunObservation: async (_spec, observation) =>
        retain('schedule', observation),
      retainRunFailure: async () =>
        retain('schedule', { kind: 'execution_unknown' }),
      requestDescendantCancellation: async () => refuse(),
    };
    return {
      service,
      controller: createDelegationGroupControllerAccountingV1({
        store: launch.groups,
        authorityService: service,
        dispatchLedger: this.owners.dispatchLedger,
        host: groupHost,
        ...(cwd ? { cwd } : {}),
      }),
    };
  }
}
