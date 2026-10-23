// UNWIRED(#91): private historical custody; public serving and cancellation composition remain required.
import { createDelegationAuthorityServiceV3 } from '@kontourai/flow-agents/delegation-authority-service-v3';
import { canonicalJson } from '@kontourai/relay';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { createOrchestrationRequestPrincipalResolver } from '../../runtime/bootstrap/orchestration-request-principal.js';
import { createPersonalRuntimeRequestGuard } from '../../runtime/bootstrap/runtime-tenant-context.js';
import {
  captureEnvironmentLocalGrantObservationOwner,
  captureEnvironmentLocalGrantReadOwner,
} from '../../runtime/conversation/local-grant-observation-owner.js';
import { isOperatorInPersonNotAgent } from '../../security/coding-authority.js';
import {
  type CurrentRuntimeRequestPrincipalSecurity,
  runtimeRequestPrincipalMayAccessHttpRoute,
} from '../../security/runtime-request-security.js';
import type { EnvironmentSecurityService } from '../ssh/environment-security-service.js';
import type { StationDelegationPersistence } from './delegation-group-persistence.js';
import type { RuntimeSourceRequestContext } from './delegation-group-source-admission.js';
import type { OrchestrationService } from './orchestration-service.js';
import {
  reportAdmissionData,
  reportAdmissionSignature,
  reportAdmissionSignatureMatches,
  reportCredentialDigest,
  type StationReportAdmission,
} from './station-report-group-admission.js';
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

/** Historical admission and current request authorization only. No method issues
 * a live source/SDK capability or reconstructs one from persisted references. */
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
    const data = reportAdmissionData(
      prepared,
      reportCredentialDigest(lease.principalCredential),
    );
    const record: StationReportAdmission = {
      data,
      signature: reportAdmissionSignature(data, this.owners.environment),
    };
    const current = (): undefined => {
      lease.assertCurrent();
      this.#request(context, 'POST');
      if (!same(preparer.read(handle, context.req.raw), prepared)) refuse();
      this.#verify(record);
      return undefined;
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
      lease.assertCurrent();
      this.#request(context, method);
      return undefined;
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
  async revokeExecutionAuthority(
    context: RuntimeSourceRequestContext,
    groupId: string,
  ) {
    const authorized = await this.#context(context, 'POST');
    const before = await this.#inspect(authorized, groupId);
    if (!before?.authority) refuse();
    const service = createDelegationAuthorityServiceV3(
      this.owners.persistence.roundsAuthorityStore(authorized.current),
      {
        now: () => new Date().toISOString(),
        authorize: async (action, root) => {
          authorized.current();
          return action === 'cancel' && same(root, before.admission.root);
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

  async inspectDelivery(
    context: RuntimeSourceRequestContext,
    groupId: string,
    seatId: string,
    orchestration: OrchestrationService,
  ) {
    id(seatId);
    const authorized = await this.#context(context, 'GET');
    const historical = await this.#inspect(authorized, groupId);
    if (!historical) return null;
    const member = historical.admission.members.find(
      (m) => m.seatId === seatId,
    );
    if (!member) refuse();
    const attempts =
      historical.group?.attempts.filter((a) => a.seatId === seatId) ?? [];
    if (attempts.length === 0) return null;
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
      member.reservedClientTurnId,
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
      taskId: member.reservedTaskId,
      outcome: delivery.outcome,
      sessionId: delivery.sessionId,
      turnId: delivery.turnId,
    };
  }

  async findOperation(
    context: RuntimeSourceRequestContext,
    operationId: string,
  ) {
    id(operationId);
    const authorized = await this.#context(context, 'GET');
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
