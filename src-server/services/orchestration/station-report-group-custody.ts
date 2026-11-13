import { createHash } from 'node:crypto';
import type {
  AuthorizationLedger,
  RecoverableAuthorizationLedger,
} from '@kontourai/dispatch';
import { recoverAuthorizedDelegationAccountingV1 } from '@kontourai/flow-agents/delegation-accounting-recovery';
import {
  createDelegationAuthorityServiceV3,
  type DelegationAuthorityHostV3,
} from '@kontourai/flow-agents/delegation-authority-service-v3';
import {
  delegationEnvelopeDigestV2,
  rootAuthorityReferenceV2,
} from '@kontourai/flow-agents/delegation-envelope-v2';
import {
  ContinuationPublicationUncertainError,
  createDelegationRoundsController,
  type DelegationRoundsHost,
  type DelegationRoundsTransactionOwner,
  type DelegationRoundsTransactionScope,
  DelegationRoundsTransactionUncertainError,
} from '@kontourai/flow-agents/delegation-group-rounds';
import { canonicalJson } from '@kontourai/relay';
import type {
  ReportGroupCancelInput,
  ReportGroupFinalizeCancelInput,
  ReportGroupFinalizeSyncInput,
} from '@kontourai/station-contracts/report-group';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { createOrchestrationRequestPrincipalResolver } from '../../runtime/bootstrap/orchestration-request-principal.js';
import { isRuntimePublicationParticipant } from '../../runtime/bootstrap/runtime-publication-participant.js';
import { createPersonalRuntimeRequestGuard } from '../../runtime/bootstrap/runtime-tenant-context.js';
import {
  captureEnvironmentLocalGrantObservationOwner,
  captureEnvironmentLocalGrantReadOwner,
} from '../../runtime/conversation/local-grant-observation-owner.js';
import { reservedStationSessionRecipient } from '../../runtime/conversation/reserved-station-turn.js';
import { isOperatorInPersonNotAgent } from '../../security/coding-authority.js';
import {
  type CurrentRuntimeRequestPrincipalSecurity,
  getRuntimeAuthenticatedRequestPrincipal,
  runtimeRequestPrincipalMayAccessHttpRoute,
} from '../../security/runtime-request-security.js';
import type { EnvironmentSecurityService } from '../ssh/environment-security-service.js';
import {
  type HomeWriterLease,
  HomeWriterOwner,
  HomeWriterUnavailableError,
} from '../ssh/home-writer-owner.js';
import {
  DelegationPersistenceError,
  type StationDelegationPersistence,
} from './delegation-group-persistence.js';
import type { RuntimeSourceRequestContext } from './delegation-group-source-admission.js';
import {
  type FileFinalWireIntentStore,
  wireIdentityDigest,
} from './delegation-group-wire-intent-store.js';
import type { OrchestrationService } from './orchestration-service.js';
import {
  type ReportRoundsPublication,
  type ReportRoundsScope,
  withReportRoundsPublication,
} from './report-rounds-publication.js';
import {
  type ReportAccountingRecoveryIntent,
  signReportAccountingRecoveryIntent,
} from './station-report-accounting-recovery.js';
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
import {
  captureReportTerminalWitness,
  verifyReportTerminalWitness,
} from './station-report-terminal-witness.js';

type RequestLease = Awaited<
  ReturnType<typeof captureEnvironmentLocalGrantReadOwner>
>;
type RequestAdmission = <Value>(check: () => Value) => Promise<Value>;

class ReportRequestContext implements RuntimeSourceRequestContext {
  readonly req: RuntimeSourceRequestContext['req'];
  #lease: Promise<RequestLease> | undefined;
  readonly #owner: StationReportGroupCustody;
  readonly #original: RuntimeSourceRequestContext;
  constructor(
    owner: StationReportGroupCustody,
    original: RuntimeSourceRequestContext,
  ) {
    this.#owner = owner;
    this.#original = original;
    const request = original.req.raw;
    this.req = Object.freeze({
      raw: request,
      header: (name: string) => original.req.header(name),
    });
    Object.freeze(this);
  }
  get env() {
    return this.#original.env;
  }
  assertBound(owner: StationReportGroupCustody): void {
    if (this.#owner !== owner || this.#original.req.raw !== this.req.raw)
      refuse();
    this.req.raw.signal.throwIfAborted();
  }
  capture(
    owner: StationReportGroupCustody,
    capture: () => Promise<RequestLease>,
  ) {
    this.assertBound(owner);
    // Retain the original host witness, including a failed capture; currentness
    // is checked separately at every consumer's own Home admission boundary.
    this.#lease ??= capture();
    return this.#lease;
  }
}

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
  readonly #activeContinuationFinalizers = new Set<string>();
  constructor(
    private readonly owners: {
      persistence: StationDelegationPersistence;
      environment: EnvironmentSecurityService;
      security: CurrentRuntimeRequestPrincipalSecurity;
      canonicalLocalGrantOrigin?: import('../ssh/environment-security-service.js').CanonicalLocalGrantOrigin;
    },
  ) {
    this.owners = Object.freeze({ ...owners });
  }

  bindRequest(
    context: RuntimeSourceRequestContext,
  ): RuntimeSourceRequestContext {
    if (context instanceof ReportRequestContext) {
      context.assertBound(this);
      return context;
    }
    return new ReportRequestContext(this, context);
  }

  assertRequestBound(context: RuntimeSourceRequestContext): void {
    if (!(context instanceof ReportRequestContext)) refuse();
    context.assertBound(this);
  }

  async captureRequestLease(
    context: RuntimeSourceRequestContext,
    admit: RequestAdmission,
  ): Promise<RequestLease> {
    if (!(context instanceof ReportRequestContext)) refuse();
    const lease = await context.capture(this, () =>
      context.req.raw.method === 'GET'
        ? captureEnvironmentLocalGrantReadOwner(
            context.req.raw,
            this.owners.environment,
            this.owners.security,
            admit,
            this.owners.canonicalLocalGrantOrigin,
          )
        : captureEnvironmentLocalGrantObservationOwner(
            context.req.raw,
            this.owners.environment,
            this.owners.security,
            admit,
            this.owners.canonicalLocalGrantOrigin,
          ).then((observation) =>
            admit(() => observation.requireCurrentLocalGrant(context.req.raw)),
          ),
    );
    context.assertBound(this);
    return lease;
  }

  #request(context: RuntimeSourceRequestContext, method: 'GET' | 'POST'): void {
    if (context instanceof ReportRequestContext) context.assertBound(this);
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
    publication?: ReportRoundsPublication,
  ): Promise<string> {
    const owner = publication
      ? await HomeWriterOwner.forHome(
          this.owners.environment.getProjectHomeDir(),
        )
      : undefined;
    const admit =
      publication && owner
        ? <Value>(check: () => Value): Promise<Value> =>
            publication.check(
              {
                owner,
                current: () => {
                  context.req.raw.signal.throwIfAborted();
                  return undefined;
                },
              },
              check,
            )
        : undefined;
    const readBefore = () => {
      this.#request(context, 'POST');
      return preparer.read(handle, context.req.raw);
    };
    const before = admit ? await admit(readBefore) : readBefore();
    const authority = await captureEnvironmentLocalGrantObservationOwner(
      context.req.raw,
      this.owners.environment,
      this.owners.security,
      admit,
      this.owners.canonicalLocalGrantOrigin,
    );
    const readPrepared = () => {
      const lease = authority.requireCurrentLocalGrant(context.req.raw);
      const prepared = preparer.read(handle, context.req.raw);
      if (
        !same(before, prepared) ||
        prepared.root.issuer_host_id !== lease.hostContextId
      )
        refuse();
      return { lease, prepared };
    };
    const { lease, prepared } = admit
      ? await admit(readPrepared)
      : readPrepared();
    const assertPrepared = (): undefined => {
      return this.owners.environment.withCurrentAuthority(() => {
        lease.assertCurrent();
        this.#request(context, 'POST');
        if (!same(preparer.read(handle, context.req.raw), prepared)) refuse();
        return undefined;
      });
    };
    const retain = async (scope?: ReportRoundsScope) => {
      const check = <Value>(work: () => Value): Value =>
        scope ? scope.check(work) : work();
      const preparationCurrent = (): undefined => check(assertPrepared);
      const assertReturned = (current: () => undefined): void => {
        try {
          current();
        } catch (error) {
          if (!scope) throw error;
          throw new DelegationRoundsTransactionUncertainError(
            'returned-cleanup-unknown',
            [error],
          );
        }
      };
      if (prepared.intent.continuation) {
        const reference = await this.owners.persistence.retainReportIntent(
          prepared.spec.groupId,
          prepared.intent,
          preparationCurrent,
        );
        if (scope) assertReturned(preparationCurrent);
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
        signature: check(() =>
          reportAdmissionSignature(data, this.owners.environment),
        ),
      };
      const current = (): undefined =>
        check(() =>
          this.owners.environment.withCurrentAuthority(() => {
            assertPrepared();
            this.#verify(record);
            return undefined;
          }),
        );
      current();
      await this.owners.persistence.retainReportAdmission(record, current);
      assertReturned(current);
      return data.spec.groupId;
    };
    return publication && owner
      ? publication.withHome({ owner, current: assertPrepared }, retain)
      : retain();
  }

  async #context(
    context: RuntimeSourceRequestContext,
    method: 'GET' | 'POST',
    publication?: ReportRoundsPublication,
    admission?: <Value>(check: () => Value) => Promise<Value>,
  ) {
    context = this.bindRequest(context);
    const writer = await HomeWriterOwner.forHome(
      this.owners.environment.getProjectHomeDir(),
    );
    const admit =
      admission ??
      (<Value>(check: () => Value): Promise<Value> =>
        publication
          ? publication.check(
              {
                owner: writer,
                current: () => {
                  context.req.raw.signal.throwIfAborted();
                  return undefined;
                },
              },
              check,
            )
          : writer.runRequest(context.req.raw.signal, check));
    await admit(() => this.#request(context, method));
    const lease = await this.captureRequestLease(context, admit);
    const current = (): undefined => {
      return this.owners.environment.withCurrentAuthority(() => {
        lease.assertCurrent();
        this.#request(context, method);
        return undefined;
      });
    };
    const principal = await admit(() => {
      const principal = createOrchestrationRequestPrincipalResolver({
        environmentSecurityService: this.owners.environment,
      })(context);
      current();
      return principal;
    });
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
    const captured = await this.#context(context, 'GET');
    const owner = await HomeWriterOwner.forHome(
      this.owners.environment.getProjectHomeDir(),
    );
    const result = await owner.runOwnedLease(context.req.raw.signal, (lease) =>
      this.#inspect(
        {
          ...captured,
          current: () => owner.runWithLease(lease, captured.current),
        },
        groupId,
      ),
    );
    captured.current();
    return result;
  }
  async inspectForMutation(
    context: RuntimeSourceRequestContext,
    groupId: string,
    publication?: ReportRoundsPublication,
  ) {
    const captured = await this.#context(context, 'POST', publication);
    if (!publication) return this.#inspect(captured, groupId);
    const owner = await HomeWriterOwner.forHome(
      this.owners.environment.getProjectHomeDir(),
    );
    return publication.withHome({ owner, current: captured.current }, (scope) =>
      this.#inspect({ ...captured, current: scope.current }, groupId),
    );
  }
  async loadIntentForMutation(
    context: RuntimeSourceRequestContext,
    groupId: string,
    publication?: ReportRoundsPublication,
  ) {
    const authorized = await this.#context(context, 'POST', publication);
    const load = async (current: () => undefined) => {
      const before = await this.#inspect({ ...authorized, current }, groupId);
      if (!before?.admission.intentRef) refuse();
      const intent = await this.owners.persistence.readReportIntent(
        groupId,
        before.admission.intentRef,
        current,
      );
      const after = await this.#inspect({ ...authorized, current }, groupId);
      if (!after || !same(after.admission, before.admission)) refuse();
      return {
        ...after,
        intent: validateReportIntent(after.admission, intent),
      };
    };
    if (!publication) return load(authorized.current);
    const owner = await HomeWriterOwner.forHome(
      this.owners.environment.getProjectHomeDir(),
    );
    return publication.withHome(
      { owner, current: authorized.current },
      (scope) => load(scope.current),
    );
  }

  async recoverAccounting(
    context: RuntimeSourceRequestContext,
    groupId: string,
    command: { seatId: string; invocationId: string; operationKey: string },
    orchestration: OrchestrationService,
    wireIntents: FileFinalWireIntentStore,
    dispatchLedger: RecoverableAuthorizationLedger,
    publication: ReportRoundsPublication,
  ): Promise<
    Awaited<ReturnType<typeof recoverAuthorizedDelegationAccountingV1>> & {
      replayed: boolean;
      operationKey: string;
    }
  > {
    if (!publication) refuse();
    id(command.seatId);
    id(command.invocationId);
    id(command.operationKey);
    const authority = await this.#context(context, 'POST', publication);
    const writer = await HomeWriterOwner.forHome(
      this.owners.environment.getProjectHomeDir(),
    );
    return publication.withHome(
      { owner: writer, current: authority.current },
      async (scope) => {
        const hold = scope.lease;
        let active = true;
        const current = (): undefined => {
          if (!active) refuse();
          return scope.current();
        };
        const authorized = { ...authority, current };
        current();
        const before = await this.#inspect(authorized, groupId);
        const ledger = before?.authority;
        const origin = ledger?.origins.find(
          (entry) => entry.invocationId === command.invocationId,
        );
        const epoch = origin && ledger?.epochs[origin.epoch];
        const invocation = ledger?.invocations.find(
          (entry) => entry.invocationId === command.invocationId,
        );
        const seat = before?.group?.spec.seats.find(
          (entry) => entry.seatId === command.seatId,
        );
        const member = before?.admission.members.find(
          (entry) => entry.seatId === command.seatId,
        );
        const envelope = epoch?.envelopes.find(
          (entry) => entry.envelope_id === invocation?.envelopeId,
        );
        if (
          !before?.group ||
          !ledger ||
          !origin ||
          !epoch ||
          !invocation ||
          !seat ||
          !member ||
          !envelope ||
          seat.envelope.id !== envelope.envelope_id ||
          envelope.execution_id !== member.reservedTaskId
        )
          refuse();
        const group = before.group;
        const root = rootAuthorityReferenceV2(epoch.root);
        const envelopeRef = {
          id: envelope.envelope_id,
          generation: envelope.generation,
          digest: delegationEnvelopeDigestV2(envelope),
        };
        let intent: ReportAccountingRecoveryIntent | null = null;
        const confirm: NonNullable<
          DelegationAuthorityHostV3['confirmHistoricalReconciliation']
        > = async (candidate, candidateRoot, candidateEnvelope) => {
          current();
          const usage = intent?.data.accounting;
          return (
            !!usage &&
            same(candidateRoot, epoch.root) &&
            same(candidateEnvelope, envelope) &&
            candidate.invocationId === invocation.invocationId &&
            candidate.envelopeId === envelope.envelope_id &&
            same(candidate.allocation, invocation.allocation) &&
            candidate.terminal &&
            same(candidate.usage, {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              costMicros: usage.costMicros,
            })
          );
        };
        const service = createDelegationAuthorityServiceV3(
          this.owners.persistence.roundsAuthorityStore(current, current, scope),
          {
            now: () => new Date().toISOString(),
            authorize: async (action, candidate, child) => {
              current();
              return (
                (action === 'inspect' ||
                  (action === 'reconcile' &&
                    intent !== null &&
                    intent.data.accounting !== null)) &&
                same(candidate, ledger.epochs.at(-1)!.root) &&
                (child === null ||
                  same(
                    child,
                    ledger.epochs
                      .at(-1)!
                      .envelopes.find(
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
          { maxRenewals: ledger.maxRenewals },
        );
        let replayed = false;
        const result = await recoverAuthorizedDelegationAccountingV1({
          authorityId: epoch.root.authority_id,
          invocationId: invocation.invocationId,
          service,
          dispatchLedger,
          host: {
            admitRecovery: async (observed) => {
              current();
              if (
                observed.authorityId !== epoch.root.authority_id ||
                observed.invocationId !== invocation.invocationId ||
                observed.originEpoch !== origin.epoch ||
                !same(observed.root, epoch.root) ||
                !same(observed.envelope, envelope) ||
                !same(observed.invocation.allocation, invocation.allocation)
              )
                refuse();
              const {
                authorizationId,
                invocationId,
                reservationId,
                limits,
                capacity,
              } = observed.reservation;
              const header = {
                version: 1 as const,
                groupId,
                seatId: command.seatId,
                operationKey: command.operationKey,
                authorityId: observed.authorityId,
                invocationId: observed.invocationId,
                ownerId: authorized.principal.id,
                originEpoch: observed.originEpoch,
                root,
                envelope: envelopeRef,
                reservationProtocol: observed.reservationProtocol,
                reservation: {
                  authorizationId,
                  invocationId,
                  reservationId,
                  limits,
                  capacity,
                },
              };
              const retained =
                await this.owners.persistence.readReportAccountingRecovery(
                  groupId,
                  command.operationKey,
                  current,
                );
              if (retained) {
                if (
                  !same(
                    Object.fromEntries(
                      Object.keys(header).map((key) => [
                        key,
                        Reflect.get(retained.data, key),
                      ]),
                    ),
                    header,
                  )
                )
                  refuse();
                replayed = true;
              }
              const wire = await wireIntents.lookup(
                epoch.root.authority_id,
                invocation.invocationId,
                current,
              );
              const terminalRecord =
                await this.owners.persistence.findReportObservationByInvocation(
                  groupId,
                  invocation.invocationId,
                  'terminal',
                  current,
                );
              const resultRecord =
                await this.owners.persistence.findReportObservationByInvocation(
                  groupId,
                  invocation.invocationId,
                  'result',
                  current,
                );
              let terminal =
                retained?.data.terminal ??
                (terminalRecord?.observation.kind === 'terminal'
                  ? (terminalRecord.observation.witness ?? null)
                  : null);
              const evidence =
                terminal?.data.evidence ??
                (resultRecord?.observation.kind === 'result'
                  ? resultRecord.observation.evidence
                  : null);
              let accounting: ReportAccountingRecoveryIntent['data']['accounting'] =
                null;
              if (evidence && wire) {
                if (
                  wire.effect !== seat.effect &&
                  wire.effect !== 'context-sync'
                )
                  refuse();
                if (
                  wire.effect === 'context-sync' &&
                  envelope.execution_authority.allowed_tools.length !== 0
                )
                  refuse();
                const binding = {
                  groupId,
                  controller: group.spec.controller,
                  seatId: member.seatId,
                  root,
                  envelope: envelopeRef,
                  executionId: member.reservedTaskId,
                  invocationId: invocation.invocationId,
                  effect: wire.effect,
                  allocation: invocation.allocation,
                  executionBindingDigest: wireIdentityDigest(
                    envelope.execution_binding,
                  ),
                  principalDigest:
                    epoch.root.authenticated_principal_ref.digest,
                  subjectDigest: epoch.root.authenticated_subject_ref.digest,
                  finalWireDigest: wire.finalWireDigest,
                };
                if (!same(wire, binding))
                  throw new DelegationPersistenceError(
                    'report_recovery_wire_mismatch',
                  );
                const continuation =
                  await this.owners.persistence.readReportContinuationTurn(
                    groupId,
                    invocation.invocationId,
                    current,
                  );
                const initial =
                  group.attempts.find(
                    (attempt) => attempt.seatId === member.seatId,
                  )?.invocationId === invocation.invocationId;
                if (!continuation && !initial && !terminal)
                  throw new DelegationPersistenceError(
                    'report_recovery_turn_binding_missing',
                  );
                const clientTurnId = continuation
                  ? (
                      await this.#continuationTurn(
                        authorized,
                        before,
                        command.seatId,
                        invocation.invocationId,
                      )
                    ).clientTurnId
                  : initial
                    ? member.reservedClientTurnId
                    : terminal?.data.terminal.clientTurnId;
                if (!clientTurnId) refuse();
                if (!terminal) {
                  const delivery = await this.#delivery(
                    authorized,
                    groupId,
                    command.seatId,
                    orchestration,
                    continuation ? invocation.invocationId : undefined,
                    scope.check,
                  );
                  if (delivery?.outcome === 'started')
                    terminal = writer.runWithLease(hold, () =>
                      captureReportTerminalWitness(
                        {
                          environment: this.owners.environment,
                          orchestration,
                          current,
                        },
                        {
                          groupId,
                          seatId: command.seatId,
                          invocationId: invocation.invocationId,
                          root,
                          envelope: envelopeRef,
                          evidence,
                          ownerId: authorized.principal.id,
                          turn: {
                            conversationId: member.reservedTaskId,
                            sessionId: delivery.sessionId,
                            clientTurnId,
                            turnId: delivery.turnId,
                          },
                        },
                      ),
                    );
                }
                if (terminal) {
                  if (
                    !verifyReportTerminalWitness(
                      terminal,
                      this.owners.environment,
                    ) ||
                    terminal.data.groupId !== groupId ||
                    terminal.data.seatId !== command.seatId ||
                    terminal.data.invocationId !== invocation.invocationId ||
                    !same(terminal.data.root, root) ||
                    !same(terminal.data.envelope, envelopeRef) ||
                    !same(terminal.data.evidence, evidence) ||
                    terminal.data.terminal.conversationId !==
                      member.reservedTaskId ||
                    terminal.data.terminal.sessionId !==
                      member.reservedTaskId ||
                    terminal.data.terminal.clientTurnId !== clientTurnId ||
                    terminal.data.terminal.ownerId !== authorized.principal.id
                  )
                    refuse();
                  if (observed.reservationProtocol !== 'retained-tariff-v1')
                    refuse();
                  const priced =
                    (await this.owners.persistence.assertProviderEvidenceReference(
                      evidence,
                      {
                        groupId,
                        rootId: epoch.root.authority_id,
                        invocationId: invocation.invocationId,
                        executionId: member.reservedTaskId,
                        ...(resultRecord?.observation.kind === 'result'
                          ? { usage: resultRecord.observation }
                          : {}),
                        executionIntent: {
                          binding,
                          modelReceipt:
                            envelope.execution_binding.runtime
                              .model_receipt_ref,
                        },
                      },
                      current,
                    )) ?? refuse();
                  accounting = {
                    inputTokens: priced.inputTokens,
                    outputTokens: priced.outputTokens,
                    costMicros: priced.costMicros,
                    costBasis: priced.costBasis,
                  };
                }
              }
              const candidate = writer.runWithLease(hold, () =>
                signReportAccountingRecoveryIntent(
                  {
                    ...header,
                    terminal,
                    wireIntentDigest: wire ? wireIdentityDigest(wire) : null,
                    accounting,
                  },
                  this.owners.environment,
                ),
              );
              if (retained && !same(retained, candidate)) refuse();
              intent = retained ?? candidate;
              const receipt =
                await this.owners.persistence.retainReportAccountingRecovery(
                  intent,
                  current,
                );
              current();
              return {
                accounting: intent.data.accounting,
                receipt,
                lease: {
                  assertCurrent: current,
                  // Publication releases Home after Flow returns.
                  release: () => {
                    active = false;
                  },
                },
              };
            },
          },
        });
        return { replayed, operationKey: command.operationKey, ...result };
      },
    );
  }

  async revokeExecutionAuthority(
    context: RuntimeSourceRequestContext,
    groupId: string,
  ) {
    const authorized = await this.#context(context, 'POST');
    const before = await this.#inspect(authorized, groupId);
    if (!before?.authority) refuse();
    const root = before.authority.epochs.at(-1)!.root;
    const writer = await HomeWriterOwner.forHome(
      this.owners.environment.getProjectHomeDir(),
    );
    await writer.runOwnedLease(context.req.raw.signal, async (lease) => {
      const current = (): undefined => {
        context.req.raw.signal.throwIfAborted();
        return writer.runWithLease(lease, authorized.current);
      };
      const service = createDelegationAuthorityServiceV3(
        this.owners.persistence.roundsAuthorityStore(current, current, {
          owner: writer,
          lease,
        }),
        {
          now: () => new Date().toISOString(),
          authorize: async (action, candidate) => {
            current();
            return action === 'cancel' && same(candidate, root);
          },
          confirmExecution: async () => false,
          authenticateRenewal: async () => null,
        },
        { maxRenewals: 0 },
      );
      current();
      await service.cancel(before.admission.root.authority_id);
    });
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
    publication?: ReportRoundsPublication,
  ) {
    const authorized = await this.#context(context, 'POST', publication);
    const baseCurrent = (): undefined => {
      publication?.assertCurrent();
      return authorized.current();
    };
    const owner = publication
      ? await HomeWriterOwner.forHome(
          this.owners.environment.getProjectHomeDir(),
        )
      : undefined;
    const outsideCurrent = async (): Promise<undefined> => {
      if (publication && owner)
        return publication.withHome(
          { owner, current: baseCurrent },
          async (scope) => scope.current(),
        );
      return baseCurrent();
    };
    const inspect = () =>
      publication && owner
        ? publication.withHome({ owner, current: baseCurrent }, (scope) =>
            this.#inspect({ ...authorized, current: scope.current }, groupId),
          )
        : this.#inspect(authorized, groupId);
    const before = await inspect();
    if (!before?.group || !before.authority) refuse();
    const group = before.group;
    const root = before.authority.epochs.at(-1)!.root;

    const build = (
      current: () => undefined,
      within?: { owner: HomeWriterOwner; lease: HomeWriterLease },
    ) => {
      const scoped = { ...authorized, current };
      const service = createDelegationAuthorityServiceV3(
        this.owners.persistence.roundsAuthorityStore(
          scoped.current,
          scoped.current,
          within,
        ),
        {
          now: () => new Date().toISOString(),
          authorize: async (action, candidate) => {
            scoped.current();
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
          scoped.current();
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
            scoped.current();
            if (attempt.terminal) {
              receipts.push({
                invocationId: attempt.invocationId,
                terminal: attempt.terminal,
              });
              continue;
            }
            const retained = await this.#readMemberInterrupt(
              scoped,
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
          scoped.current();
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
          if (within) refuse();
          if (requestOperationKey === null) refuse();
          const state = await inspect();
          if (
            !state?.group ||
            !state.authority?.cancelled ||
            !same(spec, state.admission.spec)
          )
            refuse();
          const receipts = [];
          for (const attempt of this.#cancellationWork(state)) {
            await outsideCurrent();
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
              publication,
            );
            await outsideCurrent();
            if (!requested.reference) refuse();
            receipts.push({
              invocationId: attempt.invocationId,
              request: requested.reference,
            });
          }
          await outsideCurrent();
          return {
            domain: 'station.report-cancellation.v1',
            id: groupId,
            digest: `sha256:${createHash('sha256')
              .update(canonicalJson([groupId, requestOperationKey, receipts]))
              .digest('hex')}`,
          };
        },
      };
      return {
        store: this.owners.persistence.roundsStore(current, current, within),
        authorityService: service,
        host,
      };
    };
    const defaults = build(baseCurrent);
    let transactionOwner: DelegationRoundsTransactionOwner | undefined;
    if (publication && owner) {
      transactionOwner = publication.transactionOwner({
        groupId,
        owner,
        current: baseCurrent,
        build: (scope) => build(scope.current, scope),
      });
      defaults.authorityService = {
        ...defaults.authorityService,
        cancel: (...args) =>
          publication.withHome({ owner, current: baseCurrent }, (scope) =>
            build(scope.current, scope).authorityService.cancel(...args),
          ),
      };
    }
    const controller = createDelegationRoundsController({
      ...defaults,
      dispatchLedger,
      ...(transactionOwner ? { transactionOwner } : {}),
    });
    return {
      controller,
      current: outsideCurrent,
      identity: before.admission.spec.controller,
    };
  }

  async cancel(
    context: RuntimeSourceRequestContext,
    groupId: string,
    input: ReportGroupCancelInput,
    orchestration: OrchestrationService,
    dispatchLedger: AuthorizationLedger,
    publication?: ReportRoundsPublication,
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
      publication,
    );
    const result = await owner.controller.cancel({
      kind: 'cancel',
      groupId,
      ...command,
      controller: owner.identity,
    });
    await owner.current();
    return result;
  }
  async finalizeCancel(
    context: RuntimeSourceRequestContext,
    groupId: string,
    input: ReportGroupFinalizeCancelInput,
    orchestration: OrchestrationService,
    dispatchLedger: AuthorizationLedger,
    publication?: ReportRoundsPublication,
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
      publication,
    );
    const result = await owner.controller.finalizeCancel({
      kind: 'finalizeCancel',
      groupId,
      ...command,
      controller: owner.identity,
    });
    await owner.current();
    return result;
  }

  /** Close only an already-recorded Flow continuation; this cannot execute work. */
  async finalizeContinuation<T>(
    context: RuntimeSourceRequestContext,
    groupId: string,
    input: {
      operationKey: string;
      expectedRevision: number;
      continuationOperationKey: string;
    },
    dispatchLedger: AuthorizationLedger,
    sources: import('./delegation-group-source-admission.js').LocalSourceAdmissionOwner,
    participant: import('../../runtime/bootstrap/runtime-publication-participant.js').RuntimePublicationParticipant,
    project: (
      historical: NonNullable<
        Awaited<ReturnType<StationReportGroupCustody['inspectForMutation']>>
      >,
    ) => T,
  ) {
    input = structuredClone(input);
    id(groupId);
    id(input.operationKey);
    id(input.continuationOperationKey);
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    )
      refuse();
    if (!isRuntimePublicationParticipant(participant)) refuse();
    participant.assertHome(this.owners.environment.getProjectHomeDir());
    context.req.raw.signal.throwIfAborted();
    context = this.bindRequest(context);
    const principal =
      this.#personal(context.req.raw) &&
      isOperatorInPersonNotAgent(context.req.raw)
        ? getRuntimeAuthenticatedRequestPrincipal(context.req.raw)
        : undefined;
    // Refuse duplicate in-process work; this marker never grants authority.
    const activeKey = principal
      ? canonicalJson([
          reportCredentialDigest(principal.credential),
          groupId,
          input.operationKey,
        ])
      : undefined;
    if (activeKey && this.#activeContinuationFinalizers.has(activeKey))
      throw new HomeWriterUnavailableError('busy');
    if (activeKey) this.#activeContinuationFinalizers.add(activeKey);
    let published = false;
    try {
      return await withReportRoundsPublication(
        {
          participant,
          home: this.owners.environment.getProjectHomeDir(),
          signal: context.req.raw.signal,
        },
        async (publication) => {
          const captured = await this.#context(context, 'POST', publication);
          const writer = await HomeWriterOwner.forHome(
            this.owners.environment.getProjectHomeDir(),
          );
          const readState = async (scope: ReportRoundsScope) => {
            const authorized = { ...captured, current: scope.current };
            const before = await this.#inspect(authorized, groupId);
            const group = before?.group;
            const root = before?.authority?.epochs.at(-1)?.root;
            if (
              !before ||
              !group ||
              !root ||
              group.spec.topology.kind !== 'flow'
            )
              refuse();
            const record = await this.owners.persistence.readReportAdmission(
              groupId,
              scope.current,
            );
            if (!record || !same(record.data, before.admission)) refuse();
            const locations: Array<{
              cwd: string;
              assertCurrent(): undefined;
            }> = [];
            const sourceLocationCurrent = (): undefined => {
              scope.assertLifetimeCurrent();
              return scope.owner.runWithLease(scope.lease, captured.current);
            };
            for (const member of before.admission.members) {
              const envelopes = before.admission.envelopes.filter(
                (entry) => entry.execution_id === member.reservedTaskId,
              );
              if (envelopes.length !== 1) refuse();
              locations.push(
                await sources.readHistoricalFlowLocation({
                  source: envelopes[0]!.execution_binding.source,
                  subject: { groupId, workItemId: member.reservedTaskId },
                  admission: record,
                  principalId: captured.principal.id,
                  hostContextId: captured.lease.hostContextId,
                  current: sourceLocationCurrent,
                }),
              );
            }
            const cwd = locations[0]?.cwd;
            if (!cwd || locations.some((location) => location.cwd !== cwd))
              refuse();
            return { before, group, root, locations, cwd };
          };
          const initial = await publication.withHome(
            { owner: writer, current: captured.current },
            readState,
          );
          const { group, root, cwd } = initial;
          const command = {
            kind: 'finalizeContinuation' as const,
            groupId,
            ...input,
            controller: group.spec.controller,
          };
          const states = new WeakMap<
            ReportRoundsScope,
            Awaited<ReturnType<typeof readState>>
          >();
          const prepare = async (scope: ReportRoundsScope) => {
            const state = await readState(scope);
            if (
              !same(state.group.spec, group.spec) ||
              !same(state.root, root) ||
              state.cwd !== cwd
            )
              refuse();
            states.set(scope, state);
            assertPrepared(scope);
          };
          const assertPrepared = (scope: ReportRoundsScope): undefined => {
            const state = states.get(scope);
            if (!state) refuse();
            // The parent may still hold Home after this transaction child retires.
            scope.assertLifetimeCurrent();
            return scope.owner.runWithLease(scope.lease, () =>
              this.owners.environment.withCurrentAuthority(() =>
                scope.check(() => {
                  for (const location of state.locations)
                    location.assertCurrent();
                  return undefined;
                }),
              ),
            );
          };
          const build = (
            scope?: ReportRoundsScope,
          ): Pick<
            DelegationRoundsTransactionScope,
            'store' | 'host' | 'authorityService'
          > => {
            const current = scope
              ? (): undefined => assertPrepared(scope)
              : refuse;
            const service = createDelegationAuthorityServiceV3(
              this.owners.persistence.roundsAuthorityStore(
                current,
                current,
                scope,
              ),
              {
                now: () => new Date().toISOString(),
                authorize: async (action, candidate) => {
                  current();
                  return action === 'inspect' && same(candidate, root);
                },
                confirmExecution: async () => false,
                authenticateRenewal: async () => null,
              },
              { maxRenewals: 0 },
            );
            return {
              store: this.owners.persistence.roundsStore(
                current,
                current,
                scope,
              ),
              authorityService: service,
              host: {
                authorize: async ({
                  action,
                  groupId: candidate,
                  current: projection,
                  command: sent,
                }) => {
                  current();
                  return ['finalizeContinuation', 'replay'].includes(action) &&
                    candidate === groupId &&
                    (!projection || same(projection.spec, group.spec)) &&
                    (!sent || same(sent, command))
                    ? root.authenticated_principal_ref
                    : null;
                },
                retainContinuation: async (spec, receipt) => {
                  current();
                  if (!same(spec, group.spec)) refuse();
                  return this.owners.persistence.retainReportContinuation(
                    groupId,
                    receipt,
                    current,
                  );
                },
                loadContinuation: async (spec, reference) => {
                  current();
                  if (!same(spec, group.spec)) refuse();
                  return this.owners.persistence.loadReportContinuation(
                    groupId,
                    reference,
                    current,
                  );
                },
                executionHost: () => refuse(),
                prepareRequest: async () => refuse(),
                retainObservation: async () => refuse(),
                confirmTerminal: async () => refuse(),
                requestDescendantCancellation: async () => refuse(),
                flow: {
                  executionHost: () => refuse(),
                  confirmRetainedResult: async () => false,
                  retainEvaluation: async () => refuse(),
                  acquireContinuationPublication: async (original) => {
                    await publication.check(
                      { owner: writer, current: captured.current },
                      () => undefined,
                    );
                    if (
                      original.action !== 'finalizeContinuation' ||
                      !original.finalizerCommand ||
                      !same(original.finalizerCommand, command) ||
                      !same(original.originalSpec, group.spec) ||
                      original.originalCommand.operationKey !==
                        input.continuationOperationKey ||
                      !/^[a-f0-9]{64}$/.test(original.originalPrefixDigest)
                    )
                      refuse();
                    return publication.acquireContinuationPublication({
                      owner: writer,
                      current: captured.current,
                      groupId,
                      prepare,
                      assertPreparationCurrent: assertPrepared,
                    });
                  },
                },
              },
            };
          };
          const transactionOwner = publication.transactionOwner({
            owner: writer,
            current: captured.current,
            groupId,
            prepare,
            build,
            assertPreparationCurrent: assertPrepared,
          });
          // Flow uses only parent admission outside its transaction-scoped facades.
          const defaults = build();
          const controller = createDelegationRoundsController({
            ...defaults,
            dispatchLedger,
            cwd,
            transactionOwner,
          });
          const result = await controller.finalizeContinuation(command);
          published = true;
          const historical = await publication.withHome(
            { owner: writer, current: captured.current },
            async (scope) => {
              await prepare(scope);
              return this.#inspect(
                { ...captured, current: () => assertPrepared(scope) },
                groupId,
              );
            },
          );
          if (!historical) refuse();
          return { result, group: project(historical) };
        },
      );
    } catch (error) {
      if (error instanceof DelegationRoundsTransactionUncertainError) {
        const original = error.errors[0];
        throw new ContinuationPublicationUncertainError(
          published ||
            (original instanceof ContinuationPublicationUncertainError &&
              original.status === 'published-cleanup-unknown')
            ? 'published-cleanup-unknown'
            : 'publication-unknown',
          error.errors,
        );
      }
      throw error;
    } finally {
      if (activeKey) this.#activeContinuationFinalizers.delete(activeKey);
    }
  }

  async finalizeSync(
    context: RuntimeSourceRequestContext,
    groupId: string,
    input: ReportGroupFinalizeSyncInput,
    dispatchLedger: AuthorizationLedger,
    publication?: ReportRoundsPublication,
  ) {
    const command = structuredClone(input);
    id(command.operationKey);
    id(command.syncOperationKey);
    const captured = await this.#context(context, 'POST', publication);
    const baseCurrent = (): undefined => {
      publication?.assertCurrent();
      return captured.current();
    };
    const owner = publication
      ? await HomeWriterOwner.forHome(
          this.owners.environment.getProjectHomeDir(),
        )
      : undefined;
    const before =
      publication && owner
        ? await publication.withHome(
            { owner, current: captured.current },
            (scope) =>
              this.#inspect({ ...captured, current: scope.current }, groupId),
          )
        : await this.#inspect({ ...captured, current: baseCurrent }, groupId);
    const group = before?.group;
    const root = before?.authority?.epochs.at(-1)?.root;
    if (!before || !group || !root) refuse();
    const build = (
      scope?: ReportRoundsScope,
    ): Pick<
      DelegationRoundsTransactionScope,
      'store' | 'host' | 'authorityService'
    > => {
      const current = scope?.current ?? baseCurrent;
      const service = createDelegationAuthorityServiceV3(
        this.owners.persistence.roundsAuthorityStore(current, current, scope),
        {
          now: () => new Date().toISOString(),
          authorize: async (action, candidate) => {
            current();
            return action === 'inspect' && same(candidate, root);
          },
          confirmExecution: async () => false,
          authenticateRenewal: async () => null,
        },
        { maxRenewals: 0 },
      );
      return {
        store: this.owners.persistence.roundsStore(current, current, scope),
        authorityService: service,
        host: {
          authorize: async ({
            action,
            groupId: candidate,
            current: projection,
          }) => {
            current();
            return ['finalizeSync', 'replay'].includes(action) &&
              candidate === groupId &&
              (!projection || same(projection, group))
              ? root.authenticated_principal_ref
              : null;
          },
          retainContinuation: async (spec, receipt) => {
            current();
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
            const authority = await service.inspect(root.authority_id);
            current();
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
                  current,
                );
              const invocation = authority.invocations.find(
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
                current,
              );
            }
            return this.owners.persistence.retainReportFlowObservation(
              groupId,
              'continuation',
              receipt,
              current,
            );
          },
          executionHost: () => refuse(),
          prepareRequest: async () => refuse(),
          retainObservation: async () => refuse(),
          confirmTerminal: async () => refuse(),
          requestDescendantCancellation: async () => refuse(),
        },
      };
    };
    const controller = createDelegationRoundsController({
      ...build(),
      dispatchLedger,
      ...(publication && owner
        ? {
            transactionOwner: publication.transactionOwner({
              groupId,
              owner,
              current: captured.current,
              build: (scope) => build(scope),
            }),
          }
        : {}),
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
    const writer = await HomeWriterOwner.forHome(
      this.owners.environment.getProjectHomeDir(),
    );
    const { value, captured } = await writer.runOwnedLease(
      context.req.raw.signal,
      async (lease) => {
        const captured = await this.#context(
          context,
          'GET',
          undefined,
          async (check) => writer.runWithLease(lease, check),
        );
        const authorized = {
          ...captured,
          current: () => writer.runWithLease(lease, captured.current),
        };
        const check = <Value>(body: () => Value): Value =>
          writer.runWithLease(lease, () =>
            this.owners.environment.withCurrentAuthority(() => {
              authorized.current();
              const value = body();
              authorized.current();
              return value;
            }),
          );
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
          check,
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
          check,
        );
        if (!same(still, delivery)) refuse();
        authorized.current();
        return { value: record.observation, captured };
      },
    );
    await writer.runRequest(context.req.raw.signal, captured.current);
    return value;
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
    check: <Value>(body: () => Value) => Value = (body) => body(),
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
    const delivery = check(() =>
      orchestration.inspectTurnDelivery(
        member.reservedTaskId,
        clientTurnId,
        sessionReadAuthorityFromRequest(
          authorized.principal.id,
          undefined,
          undefined,
        ),
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
    publication?: ReportRoundsPublication,
  ) {
    id(operationId);
    const authorized = await this.#context(context, 'POST', publication);
    const owner = publication
      ? await HomeWriterOwner.forHome(
          this.owners.environment.getProjectHomeDir(),
        )
      : undefined;
    const withMetadata = <Value>(
      work: (
        current: () => undefined,
        check: <Result>(body: () => Result) => Result,
      ) => Promise<Value>,
    ): Promise<Value> =>
      publication && owner
        ? publication.withHome(
            { owner, current: authorized.current },
            (scope) => work(scope.current, scope.check),
          )
        : work(authorized.current, (body) =>
            this.owners.environment.withCurrentAuthority(body),
          );
    const { historical, delivery, member, continuation } = await withMetadata(
      async (current, check) => {
        const scoped = { ...authorized, current };
        const historical = await this.#inspect(scoped, groupId);
        if (!historical?.authority?.cancelled) refuse();
        const delivery = await this.#delivery(
          scoped,
          groupId,
          seatId,
          orchestration,
          continuationInvocationId,
          check,
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
              scoped,
              historical,
              seatId,
              continuationInvocationId,
            )
          : null;
        return { historical, delivery, member, continuation };
      },
    );
    const assertTargetCurrent = (current = authorized.current): undefined => {
      current();
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
    const intent = await withMetadata(async (current, check) =>
      check(() => {
        assertTargetCurrent(current);
        const admissionSignature = reportAdmissionSignature(
          historical.admission,
          this.owners.environment,
        );
        return signReportInterrupt(
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
      }),
    );
    const retained = await this.owners.persistence.recordReportInterrupt(
      intent,
      authorized.current,
      async () => {
        await withMetadata(async (current, check) =>
          check(() => {
            assertTargetCurrent(current);
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
            current();
          }),
        );
        const command = {
          type: 'interruptTurn' as const,
          threadId: delivery.sessionId,
          turnId: delivery.turnId,
        };
        const commandContext = {
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
        };
        const response =
          publication && owner
            ? await orchestration.dispatchWithReceipt(command, commandContext, {
                delegationGroupAdmission: {
                  assertCurrent: authorized.current,
                  signal: context.req.raw.signal,
                  invokeCurrent: <Value>(
                    invoke: (
                      check: <Result>(work: () => Result) => Result,
                    ) => Promise<Value>,
                  ) =>
                    publication.invokeCurrent(
                      { owner, current: authorized.current },
                      invoke,
                    ),
                },
              })
            : await orchestration.dispatchWithReceipt(command, commandContext);
        return withMetadata(async (current, check) =>
          check(() => {
            current();
            const acknowledgement = reportInterruptResultSchema.parse(
              response.result,
            );
            return signReportInterrupt(
              intent.intent,
              acknowledgement,
              this.owners.environment,
            );
          }),
        );
      },
      publication && owner
        ? (body) => withMetadata((current) => body(current))
        : undefined,
    );
    return withMetadata(async (current, check) =>
      check(() => {
        if (!verifyReportInterrupt(retained.record, this.owners.environment))
          refuse();
        current();
        return {
          ...retained,
          reference: retained.record.acknowledgement
            ? reportInterruptReference(retained.record)
            : null,
        };
      }),
    );
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
    publication?: ReportRoundsPublication,
  ) {
    const authorized = await this.#context(context, 'POST', publication);
    if (!publication) return this.#findOperation(authorized, operationId);
    const owner = await HomeWriterOwner.forHome(
      this.owners.environment.getProjectHomeDir(),
    );
    return publication.withHome(
      { owner, current: authorized.current },
      (scope) =>
        this.#findOperation(
          { ...authorized, current: scope.current },
          operationId,
        ),
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
