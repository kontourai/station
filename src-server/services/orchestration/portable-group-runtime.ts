import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { FileAuthorizationLedger } from '@kontourai/dispatch';
import { createDelegationAuthorityService } from '@kontourai/flow-agents/delegation-authority-service';
import {
  createDelegationGroupControllerAccountingV1,
  type DelegationGroupAccountingHostV1,
  projectDelegationGroupV2,
} from '@kontourai/flow-agents/delegation-group-v2';
import { canonicalJson } from '@kontourai/relay';
import {
  DELEGATION_GROUP_TRANSPORT_VERSION,
  type DelegationGroupView,
} from '@kontourai/station-contracts/delegation-group';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { inputRequestFromRequestEvent } from '@kontourai/station-shared/input-request';
import { createOrchestrationRequestPrincipalResolver } from '../../runtime/bootstrap/orchestration-request-principal.js';
import {
  captureEnvironmentLocalGrantObservationOwner,
  captureEnvironmentLocalGrantReadOwner,
} from '../../runtime/conversation/local-grant-observation-owner.js';
import type { RuntimeFencedCredentialObservationOwners } from '../../runtime/conversation/runtime-fenced-credential-observation.js';
import { createSealedProviderPreparation } from '../../runtime/conversation/sealed-provider-preparation.js';
import { isOperatorInPersonNotAgent } from '../../security/coding-authority.js';
import {
  isBoundLocalGrantMintedOperator,
  isRuntimeRequestPrincipalCurrent,
} from '../../security/runtime-request-security.js';
import { StationDelegationPersistence } from './delegation-group-persistence.js';
import {
  LocalSourceAdmissionOwner,
  type RuntimeSourceRequestContext,
} from './delegation-group-source-admission.js';
import { FileFinalWireIntentStore } from './delegation-group-wire-intent-store.js';
import type { OrchestrationService } from './orchestration-service.js';
import { PortableGroupAdmissionStore } from './portable-group-admission-store.js';
import { PortableGroupExecution } from './portable-group-execution.js';
import { PortableGroupPreparation } from './portable-group-preparation.js';
import {
  reportInterruptReference,
  reportInterruptResultSchema,
  signReportInterrupt,
  verifyReportInterrupt,
} from './station-report-group-cancellation.js';

function refuse(): never {
  throw new Error('portable_group_unavailable');
}
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function directory(path: string) {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(path) !== path ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o7777) !== 0o700
  )
    refuse();
}

/** Host-owned operator V2 runtime. Other callers and source protocols remain unqualified. */
// UNWIRED(#91): runtime mount and full portable caller qualification remain open.
export class DelegationGroupRuntime {
  readonly #preparation: PortableGroupPreparation;
  readonly #admissions: PortableGroupAdmissionStore;
  readonly #persistence: StationDelegationPersistence;
  readonly #execution: PortableGroupExecution;
  readonly #dispatch: FileAuthorizationLedger;
  constructor(
    private readonly owners: {
      runtime: RuntimeFencedCredentialObservationOwners;
      orchestration: OrchestrationService;
      rawFetch: typeof fetch;
    },
  ) {
    const home = realpathSync(owners.runtime.configLoader.getProjectHomeDir());
    const root = join(home, 'portable-groups');
    directory(root);
    const sources = join(root, 'sources');
    directory(sources);
    const admissions = join(root, 'admissions');
    directory(admissions);
    const dispatch = join(root, 'dispatch');
    directory(dispatch);
    this.#preparation = new PortableGroupPreparation({
      runtime: owners.runtime,
      sources: new LocalSourceAdmissionOwner(
        home,
        owners.runtime.environmentSecurityService,
        sources,
      ),
      qualification: createSealedProviderPreparation,
      rawFetch: owners.rawFetch,
    });
    this.#admissions = new PortableGroupAdmissionStore(admissions);
    this.#persistence = new StationDelegationPersistence(root);
    this.#dispatch = new FileAuthorizationLedger({ root: dispatch });
    this.#execution = new PortableGroupExecution({
      preparation: this.#preparation,
      admissions: this.#admissions,
      persistence: this.#persistence,
      dispatchLedger: this.#dispatch,
      wireIntents: new FileFinalWireIntentStore(root),
      orchestration: owners.orchestration,
      authorize: (context) => this.authorizeResponse(context),
    });
  }
  async authorizeResponse(
    context: RuntimeSourceRequestContext,
  ): Promise<() => undefined> {
    const request = context.req.raw;
    const check = () => {
      request.signal.throwIfAborted();
      if (
        !isOperatorInPersonNotAgent(request) ||
        !isBoundLocalGrantMintedOperator(request) ||
        !isRuntimeRequestPrincipalCurrent(
          request,
          this.owners.runtime.requestSecurity,
        )
      )
        refuse();
    };
    check();
    const lease =
      request.method === 'GET'
        ? await captureEnvironmentLocalGrantReadOwner(
            request,
            this.owners.runtime.environmentSecurityService,
            this.owners.runtime.requestSecurity,
          )
        : (
            await captureEnvironmentLocalGrantObservationOwner(
              request,
              this.owners.runtime.environmentSecurityService,
              this.owners.runtime.requestSecurity,
            )
          ).requireCurrentLocalGrant(request);
    const current = (): undefined =>
      this.owners.runtime.environmentSecurityService.withCurrentAuthority(
        () => {
          lease.assertCurrent();
          check();
          return undefined;
        },
      );
    current();
    return current;
  }
  async #project(
    context: RuntimeSourceRequestContext,
    projection: import('@kontourai/flow-agents/delegation-group-v2').DelegationGroupProjectionV2,
  ): Promise<DelegationGroupView> {
    const current = await this.authorizeResponse(context);
    const admission = this.#admissions.read(projection.spec.groupId, current);
    if (!admission) refuse();
    const metadata = this.#preparation.inspectAdmission(context, admission);
    if (!same(metadata.spec, projection.spec)) refuse();
    const members = metadata.members.map((member) => {
      const state = projection.members.find(
        (value) => value.seatId === member.seatId,
      );
      return {
        seatId: member.seatId,
        taskId: member.taskId,
        invocationId: state?.invocationId ?? null,
        outcome: state?.observation?.outcome ?? null,
        terminalProof: state?.terminalReference
          ? ('proven' as const)
          : ('unproven' as const),
      };
    });
    current();
    return {
      version: DELEGATION_GROUP_TRANSPORT_VERSION,
      groupId: projection.spec.groupId,
      revision: projection.revision,
      execution: projection.execution,
      cancellation: projection.cancellation,
      terminal: projection.terminal,
      acceptance: projection.acceptance,
      topology:
        projection.spec.topology.kind === 'flow'
          ? { kind: 'flow', runId: projection.spec.topology.runId }
          : { kind: 'independent-advisory' },
      members,
    };
  }
  async create(
    context: RuntimeSourceRequestContext,
    input: Parameters<PortableGroupExecution['create']>[1],
  ) {
    const result = await this.#execution.create(context, input);
    return {
      replayed: result.replayed,
      group: await this.#project(context, result.projection),
    };
  }
  async get(context: RuntimeSourceRequestContext, groupId: string) {
    return this.#project(context, await this.#execution.get(context, groupId));
  }
  async events(
    context: RuntimeSourceRequestContext,
    groupId: string,
    afterRevision = 0,
  ) {
    const rows = await this.#execution.events(context, groupId, afterRevision);
    const page = rows.slice(0, 64);
    return {
      groupId,
      afterRevision,
      nextRevision: page.at(-1)?.revision ?? afterRevision,
      hasMore: rows.length > page.length,
      events: page.map((event) => ({
        revision: event.revision,
        kind: event.kind,
        ...('seatId' in event ? { seatId: event.seatId } : {}),
        ...('invocationId' in event
          ? { invocationId: event.invocationId }
          : {}),
        ...(event.kind === 'member_observed'
          ? { outcome: event.observation.outcome }
          : {}),
      })),
    };
  }
  async run(
    context: RuntimeSourceRequestContext,
    groupId: string,
    operationId: string,
    expectedRevision: number,
  ) {
    const result = await this.#execution.run(
      context,
      groupId,
      operationId,
      expectedRevision,
    );
    return {
      replayed: result.replayed,
      group: await this.#project(context, result.projection),
    };
  }
  async #owned(context: RuntimeSourceRequestContext, groupId: string) {
    const current = await this.authorizeResponse(context);
    const admission = this.#admissions.read(groupId, current);
    if (!admission) refuse();
    const metadata = this.#preparation.inspectAdmission(context, admission);
    if (metadata.spec.groupId !== groupId) refuse();
    const projection = await this.#execution.get(context, groupId);
    if (!same(metadata.spec, projection.spec)) refuse();
    const principal = createOrchestrationRequestPrincipalResolver({
      environmentSecurityService:
        this.owners.runtime.environmentSecurityService,
    })(context);
    current();
    return { current, admission, metadata, projection, principal };
  }
  async list(context: RuntimeSourceRequestContext, afterGroupId?: string) {
    const current = await this.authorizeResponse(context);
    const journals = await this.#persistence
      .groupStore(current)
      .scan(async (values) => values);
    const result = [];
    for (const journal of journals) {
      const admission = this.#admissions.read(journal.groupId, current);
      if (!admission) refuse();
      const metadata = this.#preparation.inspectAdmission(context, admission);
      const projection = projectDelegationGroupV2(journal);
      if (!same(projection.spec, metadata.spec)) refuse();
      if (!afterGroupId || projection.spec.groupId > afterGroupId)
        result.push(await this.#project(context, projection));
    }
    result.sort((a, b) =>
      a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0,
    );
    const groups = result.slice(0, 64);
    current();
    return {
      groups,
      nextGroupId:
        result.length > groups.length ? (groups.at(-1)?.groupId ?? null) : null,
      hasMore: result.length > groups.length,
    };
  }
  async memberOutput(
    context: RuntimeSourceRequestContext,
    groupId: string,
    seatId: string,
  ) {
    const owned = await this.#owned(context, groupId);
    const member = owned.projection.members.find(
      (entry) => entry.seatId === seatId,
    );
    if (!member?.invocationId || !member.observation) refuse();
    const result = await this.#persistence.findReportObservationByInvocation(
      groupId,
      member.invocationId,
      'result',
      owned.current,
    );
    if (
      !result ||
      result.seatId !== seatId ||
      result.observation.kind !== 'result'
    )
      refuse();
    owned.current();
    return {
      groupId,
      seatId,
      invocationId: member.invocationId,
      text: result.observation.text,
      modelId: result.observation.modelId,
      usage: {
        inputTokens: result.observation.inputTokens,
        outputTokens: result.observation.outputTokens,
        costMicros: result.observation.costMicros,
      },
    };
  }
  async memberEvents(
    context: RuntimeSourceRequestContext,
    groupId: string,
    seatId: string,
    afterSequence: number,
  ) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) refuse();
    const owned = await this.#owned(context, groupId);
    const member = owned.metadata.members.find(
      (entry) => entry.seatId === seatId,
    );
    const projection = owned.projection.members.find(
      (entry) => entry.seatId === seatId,
    );
    if (!member || !projection?.invocationId) refuse();
    const authority = sessionReadAuthorityFromRequest(
      owned.principal.id,
      undefined,
      undefined,
    );
    const delivery = this.owners.orchestration.inspectTurnDelivery(
      member.taskId,
      member.clientTurnId,
      authority,
    );
    if (
      delivery?.outcome !== 'started' ||
      delivery.sessionId !== member.taskId ||
      !delivery.turnId
    )
      refuse();
    const page = await this.owners.orchestration.readSessionEventPage(
      member.taskId,
      { authority, afterSequence, limit: 64 },
    );
    const after = this.owners.orchestration.inspectTurnDelivery(
      member.taskId,
      member.clientTurnId,
      authority,
    );
    if (!page || !same(after, delivery)) refuse();
    owned.current();
    return {
      groupId,
      seatId,
      nextSequence: page.nextSequence,
      hasMore: page.hasMore,
      events: page.events
        .filter(({ event }) => event.turnId === delivery.turnId)
        .map(({ sequence, event }) => {
          const result = {
            sequence,
            eventId: event.eventId,
            kind: event.method,
            ...(event.turnId ? { turnId: event.turnId } : {}),
          };
          if (event.method !== 'request.opened') return result;
          const inspected = this.owners.orchestration.inspectAttentionRequest(
            {
              threadId: member.taskId,
              requestId: event.requestId,
              requestEventId: event.eventId,
            },
            authority,
          );
          const form =
            inspected?.state === 'open' &&
            inspected.canRespond === true &&
            inspected.reference.threadId === member.taskId &&
            inspected.reference.requestId === event.requestId &&
            inspected.reference.requestEventId === event.eventId
              ? inputRequestFromRequestEvent(event)
              : null;
          return form
            ? {
                ...result,
                inputRequest: {
                  requestId: event.requestId,
                  requestEventId: event.eventId,
                  form,
                },
              }
            : result;
        }),
    };
  }
  async cancel(
    context: RuntimeSourceRequestContext,
    groupId: string,
    operationId: string,
    expectedRevision: number,
  ) {
    const owned = await this.#owned(context, groupId);
    const { metadata, current, principal, admission } = owned;
    const service = createDelegationAuthorityService(
      this.#persistence.authorityStore(current),
      {
        now: () => new Date(Date.now()).toISOString(),
        authorize: async (_action, root) => {
          current();
          return same(root, metadata.root);
        },
        confirmExecution: async () => false,
      },
    );
    const host: DelegationGroupAccountingHostV1 = {
      authorize: async (input) => {
        current();
        return input.groupId === groupId &&
          (!input.spec || same(input.spec, metadata.spec))
          ? metadata.root.authenticated_principal_ref
          : null;
      },
      executionHost: () => refuse(),
      retainMemberOutcome: async () => refuse(),
      retainRunObservation: async () => refuse(),
      retainRunFailure: async () => refuse(),
      requestDescendantCancellation: async () => {
        const authority = sessionReadAuthorityFromRequest(
          principal.id,
          undefined,
          undefined,
        );
        const ledger = await service.inspect(groupId);
        const references = [];
        for (const seat of metadata.spec.seats) {
          const member = metadata.members.find(
            (entry) => entry.seatId === seat.seatId,
          );
          if (!member) refuse();
          const invocation = ledger.invocations.find(
            (entry) => entry.envelopeId === seat.envelope.id,
          );
          if (!invocation) continue;
          const delivery = this.owners.orchestration.inspectTurnDelivery(
            member.taskId,
            member.clientTurnId,
            authority,
          );
          if (
            delivery?.outcome !== 'started' ||
            delivery.sessionId !== member.taskId ||
            !delivery.turnId
          )
            refuse();
          const intent = signReportInterrupt(
            {
              groupId,
              operationId,
              hostId: metadata.root.issuer_host_id,
              principalId: principal.id,
              admissionSignature: admission.signature,
              seatId: seat.seatId,
              taskId: member.taskId,
              clientTurnId: member.clientTurnId,
              sessionId: delivery.sessionId,
              turnId: delivery.turnId,
            },
            null,
            this.owners.runtime.environmentSecurityService,
          );
          const receipt = await this.#persistence.recordReportInterrupt(
            intent,
            current,
            async () => {
              current();
              if (
                !same(
                  this.owners.orchestration.inspectTurnDelivery(
                    member.taskId,
                    member.clientTurnId,
                    authority,
                  ),
                  delivery,
                )
              )
                refuse();
              const result =
                await this.owners.orchestration.dispatchWithReceipt(
                  {
                    type: 'interruptTurn',
                    threadId: delivery.sessionId,
                    turnId: delivery.turnId,
                  },
                  {
                    userId: principal.id,
                    principal,
                    requestCurrent: () => {
                      try {
                        current();
                        return same(
                          this.owners.orchestration.inspectTurnDelivery(
                            member.taskId,
                            member.clientTurnId,
                            authority,
                          ),
                          delivery,
                        );
                      } catch {
                        return false;
                      }
                    },
                  },
                );
              current();
              return signReportInterrupt(
                intent.intent,
                reportInterruptResultSchema.parse(result.result),
                this.owners.runtime.environmentSecurityService,
              );
            },
          );
          if (
            !verifyReportInterrupt(
              receipt.record,
              this.owners.runtime.environmentSecurityService,
            ) ||
            !receipt.record.acknowledgement
          )
            refuse();
          references.push(reportInterruptReference(receipt.record));
        }
        return this.#persistence.retainReportFlowObservation(
          groupId,
          'schedule',
          { kind: 'cancel-requested', operationId, references },
          current,
        );
      },
    };
    const controller = createDelegationGroupControllerAccountingV1({
      store: this.#persistence.groupStore(current),
      authorityService: service,
      dispatchLedger: this.#dispatch,
      host,
    });
    const result = await controller.cancel({
      kind: 'cancel',
      groupId,
      operationKey: operationId,
      expectedRevision,
      controller: metadata.spec.controller,
    });
    return {
      replayed: result.replayed,
      group: await this.#project(context, result.projection),
    };
  }
}
