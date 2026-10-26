import { createHash } from 'node:crypto';
import type { AuthorizationLedger } from '@kontourai/dispatch';
import {
  createDelegationAuthorityServiceV3,
  type DelegationAuthorityHostV3,
} from '@kontourai/flow-agents/delegation-authority-service-v3';
import {
  delegationEnvelopeDigestV2,
  rootAuthorityReferenceV2,
} from '@kontourai/flow-agents/delegation-envelope-v2';
import {
  createDelegationRoundsController,
  type DelegationRoundsHost,
} from '@kontourai/flow-agents/delegation-group-rounds';
import { canonicalJson } from '@kontourai/relay';
import type {
  ReportGroupCancelInput,
  ReportGroupFinalizeCancelInput,
  ReportGroupFinalizeSyncInput,
} from '@kontourai/station-contracts/report-group';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { createOrchestrationRequestPrincipalResolver } from '../../runtime/bootstrap/orchestration-request-principal.js';
import { createPersonalRuntimeRequestGuard } from '../../runtime/bootstrap/runtime-tenant-context.js';
import {
  captureEnvironmentLocalGrantObservationOwner,
  captureEnvironmentLocalGrantReadOwner,
} from '../../runtime/conversation/local-grant-observation-owner.js';
import { reservedStationSessionRecipient } from '../../runtime/conversation/reserved-station-turn.js';
import { isOperatorInPersonNotAgent } from '../../security/coding-authority.js';
import {
  type CurrentRuntimeRequestPrincipalSecurity,
  runtimeRequestPrincipalMayAccessHttpRoute,
} from '../../security/runtime-request-security.js';
import type { EnvironmentSecurityService } from '../ssh/environment-security-service.js';
import type { StationDelegationPersistence } from './delegation-group-persistence.js';
import type { RuntimeSourceRequestContext } from './delegation-group-source-admission.js';
import {
  type FileFinalWireIntentStore,
  wireIdentityDigest,
} from './delegation-group-wire-intent-store.js';
import type { OrchestrationService } from './orchestration-service.js';
import {
  reportAdmissionData,
  reportAdmissionSignature,
  reportAdmissionSignatureMatches,
  reportCredentialDigest,
  type StationReportAdmission,
  validateReportIntent,
} from './station-report-group-admission.js';
import {
  reportInterruptReference,
  reportInterruptResultSchema,
  signReportInterrupt,
  verifyReportContinuationTurn,
  verifyReportInterrupt,
} from './station-report-group-cancellation.js';
import type {
  PreparedStationReportGroup,
  StationReportGroupPreparation,
} from './station-report-group-preparation.js';

type ReadContext = {
  lease: Awaited<ReturnType<typeof captureEnvironmentLocalGrantReadOwner>>;
  principal: import('@kontourai/station-contracts/principal').PrincipalRef;
  current(): undefined;
};

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function id(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) refuse();
}
export class StationReportCustodyUnavailable extends Error {
  readonly code = 'group_custody_unavailable';
  constructor() {
    super('Report group custody is unavailable.');
  }
}
function refuse(): never {
  throw new StationReportCustodyUnavailable();
}

/** Historical admission, private intent custody and current request authorization.
 * No method issues a live source/SDK capability from persisted references. */
export class StationReportGroupCustody {
  readonly #personal = createPersonalRuntimeRequestGuard();
  constructor(
    private readonly owners: {
      persistence: StationDelegationPersistence;
      environment: EnvironmentSecurityService;
      security: CurrentRuntimeRequestPrincipalSecurity;
    },
  ) {
    this.owners = Object.freeze({ ...owners });
  }

  #request(context: RuntimeSourceRequestContext, method: 'GET' | 'POST'): void {
    this.owners.environment.withCurrentAuthority(() => {
      const request = context.req.raw;
      request.signal.throwIfAborted();
      if (
        request.method !== method ||
        !this.#personal(request) ||
        !isOperatorInPersonNotAgent(request) ||
        !runtimeRequestPrincipalMayAccessHttpRoute(
          request,
          this.owners.environment,
          method === 'GET'
            ? { method, path: '/api/orchestration/sessions' }
            : { method, path: '/api/orchestration/chat' },
        )
      )
        refuse();
    });
  }
  #verify(record: StationReportAdmission): void {
    if (!reportAdmissionSignatureMatches(record, this.owners.environment))
      refuse();
  }

  async retain(
    context: RuntimeSourceRequestContext,
    preparer: StationReportGroupPreparation,
    handle: PreparedStationReportGroup,
  ): Promise<string> {
    this.#request(context, 'POST');
    const before = preparer.read(handle, context.req.raw);
    const authority = await captureEnvironmentLocalGrantObservationOwner(
      context.req.raw,
      this.owners.environment,
      this.owners.security,
    );
    const lease = authority.requireCurrentLocalGrant(context.req.raw);
    const prepared = preparer.read(handle, context.req.raw);
    if (
      !same(before, prepared) ||
      prepared.root.issuer_host_id !== lease.hostContextId
    )
      refuse();
    const preparationCurrent = (): undefined => {
      return this.owners.environment.withCurrentAuthority(() => {
        lease.assertCurrent();
        this.#request(context, 'POST');
        if (!same(preparer.read(handle, context.req.raw), prepared)) refuse();
        return undefined;
      });
    };
    if (prepared.intent.continuation) {
      const reference = await this.owners.persistence.retainReportIntent(
        prepared.spec.groupId,
        prepared.intent,
        preparationCurrent,
      );
      if (
        !same(
          reference,
          reportAdmissionData(
            prepared,
            reportCredentialDigest(lease.principalCredential),
          ).intentRef,
        )
      )
        refuse();
    }
    const data = reportAdmissionData(
      prepared,
      reportCredentialDigest(lease.principalCredential),
    );
    const record: StationReportAdmission = {
      data,
      signature: reportAdmissionSignature(data, this.owners.environment),
    };
    const current = (): undefined => {
      return this.owners.environment.withCurrentAuthority(() => {
        preparationCurrent();
        this.#verify(record);
        return undefined;
      });
    };
    current();
    await this.owners.persistence.retainReportAdmission(record, current);
    current();
    return data.spec.groupId;
  }

  async #context(context: RuntimeSourceRequestContext, method: 'GET' | 'POST') {
    this.#request(context, method);
    const lease =
      method === 'GET'
        ? await captureEnvironmentLocalGrantReadOwner(
            context.req.raw,
            this.owners.environment,
            this.owners.security,
          )
        : (
            await captureEnvironmentLocalGrantObservationOwner(
              context.req.raw,
              this.owners.environment,
              this.owners.security,
            )
          ).requireCurrentLocalGrant(context.req.raw);
    const principal = createOrchestrationRequestPrincipalResolver({
      environmentSecurityService: this.owners.environment,
    })(context);
    const current = (): undefined => {
      return this.owners.environment.withCurrentAuthority(() => {
        lease.assertCurrent();
        this.#request(context, method);
        return undefined;
      });
    };
    current();
    return { lease, principal, current };
  }

  async #inspect(context: ReadContext, groupId: string) {
    id(groupId);
    const record = await this.owners.persistence.readReportAdmission(
      groupId,
      context.current,
    );
    context.current();
    if (!record) return null;
    this.#verify(record);
    if (
      record.data.root.issuer_host_id !== context.lease.hostContextId ||
      record.data.root.authenticated_principal_ref.id !== context.principal.id
    )
      refuse();
    const execution = await this.owners.persistence.readReportExecution(
      groupId,
      record.data.root.authority_id,
      context.current,
    );
    if (
      (execution.group && !same(execution.group.spec, record.data.spec)) ||
      (execution.authority &&
        (!same(execution.authority.epochs[0].root, record.data.root) ||
          execution.authority.importedFromV2 !== null))
    )
      refuse();
    const final = await this.owners.persistence.readReportAdmission(
      groupId,
      context.current,
    );
    if (!final || !same(final, record)) refuse();
    this.#verify(final);
    context.current();
    return { admission: record.data, ...execution };
  }

  async inspect(context: RuntimeSourceRequestContext, groupId: string) {
    return this.#inspect(await this.#context(context, 'GET'), groupId);
  }
  async inspectForMutation(
    context: RuntimeSourceRequestContext,
    groupId: string,
  ) {
    return this.#inspect(await this.#context(context, 'POST'), groupId);
  }
  async loadIntentForMutation(
    context: RuntimeSourceRequestContext,
    groupId: string,
  ) {
    const authorized = await this.#context(context, 'POST');
    const before = await this.#inspect(authorized, groupId);
    if (!before?.admission.intentRef) refuse();
    const intent = await this.owners.persistence.readReportIntent(
      groupId,
      before.admission.intentRef,
      authorized.current,
    );
    const after = await this.#inspect(authorized, groupId);
    if (!after || !same(after.admission, before.admission)) refuse();
    return { ...after, intent: validateReportIntent(after.admission, intent) };
  }

  async reconcileUsage(
    context: RuntimeSourceRequestContext,
    groupId: string,
    command: { seatId: string; invocationId: string },
    orchestration: OrchestrationService,
    wireIntents: FileFinalWireIntentStore,
  ) {
    id(command.seatId);
    id(command.invocationId);
    const authorized = await this.#context(context, 'POST');
    const before = await this.#inspect(authorized, groupId);
    const authority = before?.authority;
    const currentEpoch = authority?.epochs.at(-1);
    const origin = authority?.origins.find(
      (entry) => entry.invocationId === command.invocationId,
    );
    const epoch = origin && authority?.epochs[origin.epoch];
    const invocation = authority?.invocations.find(
      (entry) => entry.invocationId === command.invocationId,
    );
    const seat = before?.group?.spec.seats.find(
      (entry) => entry.seatId === command.seatId,
    );
    const member = before?.admission.members.find(
      (entry) => entry.seatId === command.seatId,
    );
    const envelope = epoch?.envelopes.find(
      (entry) => entry.envelope_id === seat?.envelope.id,
    );
    if (
      !before?.group ||
      !authority ||
      !currentEpoch ||
      !epoch ||
      !invocation ||
      !seat ||
      !member ||
      !envelope ||
      invocation.envelopeId !== envelope.envelope_id ||
      envelope.execution_id !== member.reservedTaskId
    )
      refuse();
    const record = await this.owners.persistence.readReportResultByInvocation(
      groupId,
      invocation.invocationId,
      authorized.current,
    );
    if (
      record.seatId !== member.seatId ||
      record.observation.kind !== 'result' ||
      record.observation.modelId !== member.requestedModelId
    )
      refuse();
    const result = record.observation;
    const usage = {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costMicros: result.costMicros,
    };
    const initial =
      before.group.attempts.find((entry) => entry.seatId === member.seatId)
        ?.invocationId === invocation.invocationId;
    const delivery = await this.#delivery(
      authorized,
      groupId,
      member.seatId,
      orchestration,
      initial ? undefined : invocation.invocationId,
    );
    if (delivery?.outcome !== 'started') refuse();
    const scope = sessionReadAuthorityFromRequest(
      authorized.principal.id,
      undefined,
      undefined,
    );
    const snapshot = orchestration.readHistoricalReportTurn(
      {
        conversationId: member.reservedTaskId,
        sessionId: delivery.sessionId,
        clientTurnId: delivery.clientTurnId,
        turnId: delivery.turnId,
      },
      scope,
    );
    if (!snapshot) refuse();
    const wire = await wireIntents.lookup(
      epoch.root.authority_id,
      invocation.invocationId,
      authorized.current,
    );
    if (
      !wire ||
      (wire.effect !== seat.effect && wire.effect !== 'context-sync') ||
      (wire.effect === 'context-sync' &&
        envelope.execution_authority.allowed_tools.length !== 0)
    )
      refuse();
    const binding = {
      controller: before.group.spec.controller,
      seatId: member.seatId,
      root: rootAuthorityReferenceV2(epoch.root),
      envelope: {
        id: envelope.envelope_id,
        generation: envelope.generation,
        digest: delegationEnvelopeDigestV2(envelope),
      },
      effect: wire.effect,
      allocation: invocation.allocation,
      executionBindingDigest: wireIdentityDigest(envelope.execution_binding),
      principalDigest: epoch.root.authenticated_principal_ref.digest,
      subjectDigest: epoch.root.authenticated_subject_ref.digest,
      finalWireDigest: wire.finalWireDigest,
    };
    const confirm: NonNullable<
      DelegationAuthorityHostV3['confirmHistoricalReconciliation']
    > = async (candidate, candidateRoot, candidateEnvelope) => {
      authorized.current();
      if (
        !same(candidateRoot, epoch.root) ||
        !same(candidateEnvelope, envelope) ||
        candidate.invocationId !== invocation.invocationId ||
        candidate.envelopeId !== envelope.envelope_id ||
        !same(candidate.allocation, invocation.allocation) ||
        !candidate.terminal ||
        !same(candidate.usage, usage)
      )
        return false;
      await this.owners.persistence.assertProviderEvidenceReference(
        result.evidence,
        {
          groupId,
          rootId: epoch.root.authority_id,
          invocationId: invocation.invocationId,
          executionId: member.reservedTaskId,
          usage,
          executionIntent: {
            binding,
            modelReceipt: envelope.execution_binding.runtime.model_receipt_ref,
          },
        },
        authorized.current,
      );
      if (
        !same(
          await wireIntents.lookup(
            epoch.root.authority_id,
            invocation.invocationId,
            authorized.current,
          ),
          wire,
        )
      )
        return false;
      const actual = orchestration.inspectTurnDelivery(
        member.reservedTaskId,
        delivery.clientTurnId,
        scope,
      );
      const terminal = orchestration.readSessionEventById(
        delivery.sessionId,
        snapshot.terminalEventId,
        scope,
      );
      authorized.current();
      return (
        actual?.outcome === 'started' &&
        actual.turnId === delivery.turnId &&
        actual.sessionId === delivery.sessionId &&
        terminal?.method === 'turn.completed' &&
        terminal.eventId === snapshot.terminalEventId &&
        terminal.threadId === delivery.sessionId &&
        terminal.turnId === delivery.turnId
      );
    };
    const service = createDelegationAuthorityServiceV3(
      this.owners.persistence.roundsAuthorityStore(authorized.current),
      {
        now: () => new Date().toISOString(),
        authorize: async (action, candidate, child) => {
          authorized.current();
          return (
            (action === 'inspect' || action === 'reconcile') &&
            same(candidate, currentEpoch.root) &&
            (child === null ||
              same(
                child,
                currentEpoch.envelopes.find(
                  (entry) => entry.envelope_id === envelope.envelope_id,
                ),
              ))
          );
        },
        confirmExecution: async () => false,
        confirmReconciliation: (candidate, candidateRoot) =>
          confirm(candidate, candidateRoot, envelope),
        confirmHistoricalReconciliation: confirm,
        authenticateRenewal: async () => null,
      },
      { maxRenewals: authority.maxRenewals },
    );
    await service.reconcileInvocation(
      epoch.root.authority_id,
      invocation.invocationId,
      usage,
      true,
    );
    authorized.current();
  }

  async revokeExecutionAuthority(
    context: RuntimeSourceRequestContext,
    groupId: string,
  ) {
    const authorized = await this.#context(context, 'POST');
    const before = await this.#inspect(authorized, groupId);
    if (!before?.authority) refuse();
    const root = before.authority.epochs.at(-1)!.root;
    const service = createDelegationAuthorityServiceV3(
      this.owners.persistence.roundsAuthorityStore(authorized.current),
      {
        now: () => new Date().toISOString(),
        authorize: async (action, candidate) => {
          authorized.current();
          return action === 'cancel' && same(candidate, root);
        },
        confirmExecution: async () => false,
        authenticateRenewal: async () => null,
      },
      { maxRenewals: 0 },
    );
    authorized.current();
    await service.cancel(before.admission.root.authority_id);
    const after = await this.#inspect(authorized, groupId);
    if (!after?.authority?.cancelled) refuse();
    authorized.current();
    return { ...after, authority: after.authority };
  }

  async #cancellationController(
    context: RuntimeSourceRequestContext,
    groupId: string,
    requestOperationKey: string | null,
    orchestration: OrchestrationService,
    dispatchLedger: AuthorizationLedger,
  ) {
    const authorized = await this.#context(context, 'POST');
    const before = await this.#inspect(authorized, groupId);
    if (!before?.group || !before.authority) refuse();
    const group = before.group;
    const root = before.authority.epochs.at(-1)!.root;
    const service = createDelegationAuthorityServiceV3(
      this.owners.persistence.roundsAuthorityStore(authorized.current),
      {
        now: () => new Date().toISOString(),
        authorize: async (action, candidate) => {
          authorized.current();
          return (
            ['cancel', 'inspect'].includes(action) && same(candidate, root)
          );
        },
        confirmExecution: async () => false,
        authenticateRenewal: async () => null,
      },
      { maxRenewals: 0 },
    );
    const host: DelegationRoundsHost = {
      authorize: async ({ action, groupId: candidate, current }) => {
        authorized.current();
        const actions =
          requestOperationKey === null
            ? ['finalizeCancel', 'replay']
            : ['cancel', 'replay', 'get', 'record'];
        return actions.includes(action) &&
          candidate === groupId &&
          (!current ||
            (same(current.spec, before.admission.spec) &&
              (requestOperationKey !== null || same(current, group))))
          ? root.authenticated_principal_ref
          : null;
      },
      confirmCancellation: async (spec, original) => {
        if (!same(spec, before.admission.spec)) refuse();
        const receipts = [];
        // Flow holds the group lock here. Read only the independent signed receipt sidecar.
        for (const attempt of this.#cancellationWork(before)) {
          authorized.current();
          if (attempt.terminal) {
            receipts.push({
              invocationId: attempt.invocationId,
              terminal: attempt.terminal,
            });
            continue;
          }
          const retained = await this.#readMemberInterrupt(
            authorized,
            before,
            attempt.seatId,
            attempt.continuation ? attempt.invocationId : undefined,
          );
          if (
            !retained?.reference ||
            retained.record.intent.operationId !== original.operationKey
          )
            return null;
          receipts.push({
            invocationId: attempt.invocationId,
            request: retained.reference,
          });
        }
        authorized.current();
        return {
          domain: 'station.report-cancellation.v1',
          id: groupId,
          digest: `sha256:${createHash('sha256')
            .update(canonicalJson([groupId, original.operationKey, receipts]))
            .digest('hex')}`,
        };
      },
      executionHost: () => refuse(),
      prepareRequest: async () => refuse(),
      retainObservation: async () => refuse(),
      confirmTerminal: async () => refuse(),
      requestDescendantCancellation: async (spec) => {
        if (requestOperationKey === null) refuse();
        const state = await this.#inspect(authorized, groupId);
        if (
          !state?.group ||
          !state.authority?.cancelled ||
          !same(spec, state.admission.spec)
        )
          refuse();
        const receipts = [];
        for (const attempt of this.#cancellationWork(state)) {
          authorized.current();
          if (attempt.terminal) {
            receipts.push({
              invocationId: attempt.invocationId,
              terminal: attempt.terminal,
            });
            continue;
          }
          const requested = await this.requestMemberInterrupt(
            context,
            groupId,
            attempt.seatId,
            requestOperationKey,
            orchestration,
            attempt.continuation ? attempt.invocationId : undefined,
          );
          authorized.current();
          if (!requested.reference) refuse();
          receipts.push({
            invocationId: attempt.invocationId,
            request: requested.reference,
          });
        }
        authorized.current();
        return {
          domain: 'station.report-cancellation.v1',
          id: groupId,
          digest: `sha256:${createHash('sha256')
            .update(canonicalJson([groupId, requestOperationKey, receipts]))
            .digest('hex')}`,
        };
      },
    };
    const controller = createDelegationRoundsController({
      store: this.owners.persistence.roundsStore(authorized.current),
      authorityService: service,
      dispatchLedger,
      host,
    });
    return {
      controller,
      current: authorized.current,
      identity: before.admission.spec.controller,
    };
  }

  async cancel(
    context: RuntimeSourceRequestContext,
    groupId: string,
    input: ReportGroupCancelInput,
    orchestration: OrchestrationService,
    dispatchLedger: AuthorizationLedger,
  ) {
    const command = Object.freeze({
      operationKey: input.operationKey,
      expectedRevision: input.expectedRevision,
    });
    id(command.operationKey);
    const owner = await this.#cancellationController(
      context,
      groupId,
      command.operationKey,
      orchestration,
      dispatchLedger,
    );
    const result = await owner.controller.cancel({
      kind: 'cancel',
      groupId,
      ...command,
      controller: owner.identity,
    });
    owner.current();
    return result;
  }
  async finalizeCancel(
    context: RuntimeSourceRequestContext,
    groupId: string,
    input: ReportGroupFinalizeCancelInput,
    orchestration: OrchestrationService,
    dispatchLedger: AuthorizationLedger,
  ) {
    const command = Object.freeze({
      operationKey: input.operationKey,
      expectedRevision: input.expectedRevision,
      cancelOperationKey: input.cancelOperationKey,
    });
    id(command.operationKey);
    id(command.cancelOperationKey);
    const owner = await this.#cancellationController(
      context,
      groupId,
      null,
      orchestration,
      dispatchLedger,
    );
    const result = await owner.controller.finalizeCancel({
      kind: 'finalizeCancel',
      groupId,
      ...command,
      controller: owner.identity,
    });
    owner.current();
    return result;
  }

  async finalizeSync(
    context: RuntimeSourceRequestContext,
    groupId: string,
    input: ReportGroupFinalizeSyncInput,
    dispatchLedger: AuthorizationLedger,
  ) {
    const command = structuredClone(input);
    id(command.operationKey);
    id(command.syncOperationKey);
    const authorized = await this.#context(context, 'POST');
    const before = await this.#inspect(authorized, groupId);
    const group = before?.group;
    const root = before?.authority?.epochs.at(-1)?.root;
    if (!before || !group || !root) refuse();
    const service = createDelegationAuthorityServiceV3(
      this.owners.persistence.roundsAuthorityStore(authorized.current),
      {
        now: () => new Date().toISOString(),
        authorize: async (action, candidate) => {
          authorized.current();
          return action === 'inspect' && same(candidate, root);
        },
        confirmExecution: async () => false,
        authenticateRenewal: async () => null,
      },
      { maxRenewals: 0 },
    );
    const controller = createDelegationRoundsController({
      store: this.owners.persistence.roundsStore(authorized.current),
      authorityService: service,
      dispatchLedger,
      host: {
        authorize: async ({ action, groupId: candidate, current }) => {
          authorized.current();
          return ['finalizeSync', 'replay'].includes(action) &&
            candidate === groupId &&
            (!current || same(current, group))
            ? root.authenticated_principal_ref
            : null;
        },
        retainContinuation: async (spec, receipt) => {
          authorized.current();
          if (!same(spec, group.spec)) refuse();
          const pending = group.continuations.find(
            (c) => c.command.operationKey === command.syncOperationKey,
          );
          if (
            !pending?.prepared ||
            pending.command.kind !== 'sync' ||
            !same(pending.prepared, receipt)
          )
            refuse();
          const seatId = pending.command.seatId;
          const member = before.admission.members.find(
            (m) => m.seatId === seatId,
          );
          if (!member) refuse();
          for (const proof of pending.prepared.terminalProofs) {
            const observation =
              await this.owners.persistence.readReportObservation(
                groupId,
                proof.invocationId,
                proof.reference,
                authorized.current,
              );
            const invocation = before.authority!.invocations.find(
              (i) => i.invocationId === proof.invocationId,
            );
            if (
              observation.seatId !== member.seatId ||
              observation.observation.kind !== 'terminal' ||
              observation.observation.sessionId !== member.reservedTaskId ||
              !invocation?.terminal ||
              invocation.usage === null
            )
              refuse();
            await this.owners.persistence.assertProviderEvidenceReference(
              observation.observation.evidence,
              {
                groupId,
                rootId: root.authority_id,
                invocationId: proof.invocationId,
                executionId: member.reservedTaskId,
                usage: invocation.usage,
              },
              authorized.current,
            );
          }
          return this.owners.persistence.retainReportFlowObservation(
            groupId,
            'continuation',
            receipt,
            authorized.current,
          );
        },
        executionHost: () => refuse(),
        prepareRequest: async () => refuse(),
        retainObservation: async () => refuse(),
        confirmTerminal: async () => refuse(),
        requestDescendantCancellation: async () => refuse(),
      },
    });
    return controller.finalizeSync({
      kind: 'finalizeSync',
      groupId,
      ...command,
      controller: group.spec.controller,
    });
  }

  async readResult(
    context: RuntimeSourceRequestContext,
    groupId: string,
    seatId: string,
    invocationId: string,
    orchestration: OrchestrationService,
  ) {
    id(seatId);
    id(invocationId);
    const authorized = await this.#context(context, 'GET');
    const historical = await this.#inspect(authorized, groupId);
    const attempt = historical?.group?.attempts.find(
      (a) => a.seatId === seatId && a.invocationId === invocationId,
    );
    if (!historical || !attempt?.observation) refuse();
    const delivery = await this.#delivery(
      authorized,
      groupId,
      seatId,
      orchestration,
      attempt.previousInvocationId === null ? undefined : invocationId,
    );
    if (delivery?.outcome !== 'started') refuse();
    const record = await this.owners.persistence.readReportObservation(
      groupId,
      invocationId,
      attempt.observation,
      authorized.current,
    );
    if (record.seatId !== seatId || record.observation.kind === 'terminal')
      refuse();
    const still = await this.#delivery(
      authorized,
      groupId,
      seatId,
      orchestration,
      attempt.previousInvocationId === null ? undefined : invocationId,
    );
    if (!same(still, delivery)) refuse();
    authorized.current();
    return record.observation;
  }

  async inspectDelivery(
    context: RuntimeSourceRequestContext,
    groupId: string,
    seatId: string,
    orchestration: OrchestrationService,
  ) {
    const delivery = await this.#delivery(
      await this.#context(context, 'GET'),
      groupId,
      seatId,
      orchestration,
    );
    if (delivery?.outcome !== 'started') return delivery;
    const { clientTurnId: _clientTurnId, ...projection } = delivery;
    return projection;
  }

  #cancellationWork(
    state: NonNullable<
      Awaited<ReturnType<StationReportGroupCustody['inspect']>>
    >,
  ) {
    if (!state.group || !state.authority) refuse();
    const work = state.group.attempts.map((attempt) => ({
      ...attempt,
      continuation: attempt.previousInvocationId !== null,
    }));
    for (const invocation of state.authority.invocations) {
      if (
        work.some((attempt) => attempt.invocationId === invocation.invocationId)
      )
        continue;
      const seat = state.group.spec.seats.find(
        (s) => s.envelope.id === invocation.envelopeId,
      );
      if (!seat) refuse();
      const terminal =
        state.group.continuations
          .flatMap((c) => c.prepared?.terminalProofs ?? [])
          .find((p) => p.invocationId === invocation.invocationId)?.reference ??
        null;
      work.push({
        round: 0,
        seatId: seat.seatId,
        invocationId: invocation.invocationId,
        previousInvocationId: null,
        observation: null,
        terminal,
        continuation: true,
      });
    }
    return work;
  }

  async #continuationTurn(
    authorized: ReadContext,
    historical: NonNullable<
      Awaited<ReturnType<StationReportGroupCustody['inspect']>>
    >,
    seatId: string,
    invocationId: string,
  ) {
    const record = await this.owners.persistence.readReportContinuationTurn(
      historical.admission.spec.groupId,
      invocationId,
      authorized.current,
    );
    const member = historical.admission.members.find(
      (m) => m.seatId === seatId,
    );
    const seat = historical.admission.spec.seats.find(
      (s) => s.seatId === seatId,
    );
    if (
      !record ||
      !member ||
      !seat ||
      !verifyReportContinuationTurn(record, this.owners.environment) ||
      record.intent.groupId !== historical.admission.spec.groupId ||
      record.intent.seatId !== seatId ||
      record.intent.invocationId !== invocationId ||
      record.intent.taskId !== member.reservedTaskId ||
      record.intent.hostId !== authorized.lease.hostContextId ||
      record.intent.principalId !== authorized.principal.id ||
      record.intent.admissionSignature !==
        reportAdmissionSignature(
          historical.admission,
          this.owners.environment,
        ) ||
      !historical.authority?.invocations.some(
        (i) =>
          i.invocationId === invocationId && i.envelopeId === seat.envelope.id,
      )
    )
      refuse();
    authorized.current();
    return record.intent;
  }

  async #delivery(
    authorized: ReadContext,
    groupId: string,
    seatId: string,
    orchestration: OrchestrationService,
    continuationInvocationId?: string,
  ) {
    id(seatId);
    const historical = await this.#inspect(authorized, groupId);
    if (!historical) return null;
    const member = historical.admission.members.find(
      (m) => m.seatId === seatId,
    );
    if (!member) refuse();
    const continuation = continuationInvocationId
      ? await this.#continuationTurn(
          authorized,
          historical,
          seatId,
          continuationInvocationId,
        )
      : null;
    const clientTurnId =
      continuation?.clientTurnId ?? member.reservedClientTurnId;
    const attempts =
      historical.group?.attempts.filter((a) => a.seatId === seatId) ?? [];
    if (!continuation && attempts.length === 0) return null;
    const authority = historical.authority;
    const seat = historical.admission.spec.seats.find(
      (s) => s.seatId === seatId,
    );
    if (
      !authority ||
      !seat ||
      !attempts.every((attempt) =>
        authority.invocations.some(
          (invocation) =>
            invocation.invocationId === attempt.invocationId &&
            invocation.envelopeId === seat.envelope.id,
        ),
      )
    )
      refuse();
    authorized.current();
    const delivery = orchestration.inspectTurnDelivery(
      member.reservedTaskId,
      clientTurnId,
      sessionReadAuthorityFromRequest(
        authorized.principal.id,
        undefined,
        undefined,
      ),
    );
    authorized.current();
    if (!delivery) return null;
    if (delivery.outcome !== 'started')
      return {
        seatId,
        taskId: member.reservedTaskId,
        outcome: delivery.outcome,
      };
    if (delivery.sessionId !== member.reservedTaskId) refuse();
    return {
      seatId,
      clientTurnId,
      taskId: member.reservedTaskId,
      outcome: delivery.outcome,
      sessionId: delivery.sessionId,
      turnId: delivery.turnId,
    };
  }

  async inspectMemberInterrupt(
    context: RuntimeSourceRequestContext,
    groupId: string,
    seatId: string,
  ) {
    id(seatId);
    const authorized = await this.#context(context, 'GET');
    const historical = await this.#inspect(authorized, groupId);
    if (!historical) return null;
    return this.#readMemberInterrupt(authorized, historical, seatId);
  }
  async #readMemberInterrupt(
    authorized: ReadContext,
    historical: NonNullable<
      Awaited<ReturnType<StationReportGroupCustody['inspect']>>
    >,
    seatId: string,
    continuationInvocationId?: string,
  ) {
    const groupId = historical.admission.spec.groupId;
    const member = historical.admission.members.find(
      (entry) => entry.seatId === seatId,
    );
    if (!member) refuse();
    const continuation = continuationInvocationId
      ? await this.#continuationTurn(
          authorized,
          historical,
          seatId,
          continuationInvocationId,
        )
      : null;
    const clientTurnId =
      continuation?.clientTurnId ?? member.reservedClientTurnId;
    const record = await this.owners.persistence.readReportInterrupt(
      groupId,
      seatId,
      authorized.current,
      clientTurnId,
    );
    if (!record) return null;
    if (
      !verifyReportInterrupt(record, this.owners.environment) ||
      record.intent.hostId !== authorized.lease.hostContextId ||
      record.intent.principalId !== authorized.principal.id ||
      record.intent.admissionSignature !==
        reportAdmissionSignature(
          historical.admission,
          this.owners.environment,
        ) ||
      record.intent.taskId !== member.reservedTaskId ||
      record.intent.clientTurnId !== clientTurnId
    )
      refuse();
    authorized.current();
    return {
      record,
      reference: record.acknowledgement
        ? reportInterruptReference(record)
        : null,
    };
  }

  async requestMemberInterrupt(
    context: RuntimeSourceRequestContext,
    groupId: string,
    seatId: string,
    operationId: string,
    orchestration: OrchestrationService,
    continuationInvocationId?: string,
  ) {
    id(operationId);
    const authorized = await this.#context(context, 'POST');
    const historical = await this.#inspect(authorized, groupId);
    if (!historical?.authority?.cancelled) refuse();
    const delivery = await this.#delivery(
      authorized,
      groupId,
      seatId,
      orchestration,
      continuationInvocationId,
    );
    if (
      delivery?.outcome !== 'started' ||
      !delivery.sessionId ||
      !delivery.turnId
    )
      refuse();
    const member = historical.admission.members.find(
      (entry) => entry.seatId === seatId,
    );
    if (!member) refuse();
    const continuation = continuationInvocationId
      ? await this.#continuationTurn(
          authorized,
          historical,
          seatId,
          continuationInvocationId,
        )
      : null;
    const assertTargetCurrent = (): undefined => {
      authorized.current();
      if (continuation) {
        const session = orchestration.captureReservedStationSession(
          member.reservedTaskId,
          { userId: authorized.principal.id },
        );
        if (
          !same(
            reservedStationSessionRecipient(session, {
              principalId: authorized.principal.id,
              environmentId: authorized.lease.hostContextId,
              threadId: member.reservedTaskId,
            }),
            continuation.recipient,
          )
        )
          refuse();
      }
      return undefined;
    };
    const admissionSignature = reportAdmissionSignature(
      historical.admission,
      this.owners.environment,
    );
    const intent = signReportInterrupt(
      {
        groupId,
        seatId,
        operationId,
        hostId: authorized.lease.hostContextId,
        principalId: authorized.principal.id,
        admissionSignature,
        taskId: delivery.taskId,
        clientTurnId: delivery.clientTurnId,
        sessionId: delivery.sessionId,
        turnId: delivery.turnId,
      },
      null,
      this.owners.environment,
    );
    authorized.current();
    const retained = await this.owners.persistence.recordReportInterrupt(
      intent,
      authorized.current,
      async () => {
        assertTargetCurrent();
        const still = orchestration.inspectTurnDelivery(
          member.reservedTaskId,
          delivery.clientTurnId,
          sessionReadAuthorityFromRequest(
            authorized.principal.id,
            undefined,
            undefined,
          ),
        );
        if (
          still?.outcome !== 'started' ||
          still.sessionId !== delivery.sessionId ||
          still.turnId !== delivery.turnId
        )
          refuse();
        authorized.current();
        const response = await orchestration.dispatchWithReceipt(
          {
            type: 'interruptTurn',
            threadId: delivery.sessionId,
            turnId: delivery.turnId,
          },
          {
            userId: authorized.principal.id,
            principal: authorized.principal,
            requestCurrent: () => {
              try {
                assertTargetCurrent();
                return true;
              } catch {
                return false;
              }
            },
          },
        );
        authorized.current();
        const acknowledgement = reportInterruptResultSchema.parse(
          response.result,
        );
        return signReportInterrupt(
          intent.intent,
          acknowledgement,
          this.owners.environment,
        );
      },
    );
    if (!verifyReportInterrupt(retained.record, this.owners.environment))
      refuse();
    authorized.current();
    return {
      ...retained,
      reference: retained.record.acknowledgement
        ? reportInterruptReference(retained.record)
        : null,
    };
  }

  async list(context: RuntimeSourceRequestContext) {
    const authorized = await this.#context(context, 'GET');
    const records = await this.owners.persistence.listReportAdmissions(
      authorized.current,
    );
    const result = [];
    for (const record of records) {
      this.#verify(record);
      if (
        record.data.root.issuer_host_id !== authorized.lease.hostContextId ||
        record.data.root.authenticated_principal_ref.id !==
          authorized.principal.id
      )
        continue;
      const entry = await this.#inspect(authorized, record.data.spec.groupId);
      if (!entry) refuse();
      result.push(entry);
    }
    authorized.current();
    return result.sort((a, b) =>
      a.admission.spec.groupId.localeCompare(b.admission.spec.groupId),
    );
  }

  async findOperation(
    context: RuntimeSourceRequestContext,
    operationId: string,
  ) {
    return this.#findOperation(
      await this.#context(context, 'GET'),
      operationId,
    );
  }

  async findOperationForMutation(
    context: RuntimeSourceRequestContext,
    operationId: string,
  ) {
    return this.#findOperation(
      await this.#context(context, 'POST'),
      operationId,
    );
  }

  async #findOperation(authorized: ReadContext, operationId: string) {
    id(operationId);
    const records = await this.owners.persistence.listReportAdmissions(
      authorized.current,
    );
    authorized.current();
    for (const record of records) this.#verify(record);
    const matching = records.filter(
      (record) =>
        record.data.root.issuer_host_id === authorized.lease.hostContextId &&
        record.data.root.authenticated_principal_ref.id ===
          authorized.principal.id &&
        record.data.root.revisions.policy.id === operationId,
    );
    if (matching.length > 1) refuse();
    const result = matching[0]
      ? await this.#inspect(authorized, matching[0].data.spec.groupId)
      : null;
    return result;
  }
}
