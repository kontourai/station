import { createHash, randomUUID } from 'node:crypto';
import type { DelegationEnvelopeV2 } from '@kontourai/flow-agents/delegation-envelope-v2';
import { DelegationRoundsTransactionUncertainError } from '@kontourai/flow-agents/delegation-group-rounds';
import { canonicalJson, type ModelInvocationRequest } from '@kontourai/relay';
import { createOrchestrationRequestPrincipalResolver } from '../../runtime/bootstrap/orchestration-request-principal.js';
import { captureEnvironmentLocalGrantObservationOwner } from '../../runtime/conversation/local-grant-observation-owner.js';
import { readObservedSdkProviderCredential } from '../../runtime/conversation/provider-credential-observation.js';
import { REPORT_INPUT_TOOL_NAME } from '../../runtime/conversation/report-input-profile.js';
import {
  prepareReservedStationTurn,
  reservedStationSessionOutputDelivery,
  reservedStationSessionRecipient,
  reservedStationTurnResult,
} from '../../runtime/conversation/reserved-station-turn.js';
import {
  RuntimeFencedCredentialObservationOwner,
  type RuntimeFencedCredentialObservationOwners,
} from '../../runtime/conversation/runtime-fenced-credential-observation.js';
import { createSealedProviderPreparation } from '../../runtime/conversation/sealed-provider-preparation.js';
import { HomeWriterOwner } from '../ssh/home-writer-owner.js';
import {
  type PreparedReservedFinalFetchOwners,
  RoundsFinalFetchLaunchFence,
} from './delegation-group-launch-fence.js';
import type { StationDelegationPersistence } from './delegation-group-persistence.js';
import {
  assertSdkSourceWireCurrentSync,
  createContextReportSdkSourceWireOwner,
  createContextSyncSdkSourceWireOwner,
  createPreparedSdkSourceWireOwner,
  inspectSdkSourceWire,
} from './delegation-group-sdk-source-wire-owner.js';
import type {
  LocalSourceAdmissionOwner,
  RuntimeSourceRequestContext,
} from './delegation-group-source-admission.js';
import { assertSynchronous } from './delegation-group-wire-intent-store.js';
import type { OrchestrationService } from './orchestration-service.js';
import type {
  ReportRoundsPublication,
  ReportRoundsScope,
} from './report-rounds-publication.js';
import { reportAdmissionSignature } from './station-report-group-admission.js';
import { signReportContinuationTurn } from './station-report-group-cancellation.js';
import type { StationReportGroupCustody } from './station-report-group-custody.js';
import { StationReportPreparationUnavailable } from './station-report-group-input.js';

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const reference = (domain: string, id: string, value: unknown) => ({
  domain,
  id,
  digest: `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`,
});
function refuse(): never {
  throw new StationReportPreparationUnavailable();
}

/** Fresh one-use source/SDK custody attached to the actual retained adapter record. */
export class StationReportRetainedTurns {
  readonly #credentials: RuntimeFencedCredentialObservationOwner;
  constructor(
    private readonly owners: {
      runtime: RuntimeFencedCredentialObservationOwners;
      sources: LocalSourceAdmissionOwner;
      custody: StationReportGroupCustody;
      orchestration: OrchestrationService;
      persistence: StationDelegationPersistence;
      rawFetch: typeof fetch;
    },
  ) {
    this.owners = Object.freeze({
      ...owners,
      runtime: Object.freeze({ ...owners.runtime }),
    });
    this.#credentials = new RuntimeFencedCredentialObservationOwner(
      this.owners.runtime,
    );
  }

  async checkpoint(
    context: RuntimeSourceRequestContext,
    groupId: string,
    seatId: string,
    expectedRevision: number,
  ) {
    const loaded = await this.owners.custody.loadIntentForMutation(
      context,
      groupId,
    );
    const group = loaded.group;
    const member = loaded.admission.members.find(
      (member) => member.seatId === seatId,
    );
    const grant = group?.grants.envelopes.find(
      (grant) => grant.seatId === seatId,
    );
    const envelope = loaded.authority?.epochs
      .at(-1)
      ?.envelopes.find(
        (envelope) => envelope.envelope_id === grant?.envelope.id,
      );
    if (
      !group ||
      group.revision !== expectedRevision ||
      group.spec.topology.kind !== 'flow' ||
      !member ||
      !envelope ||
      !loaded.intent.flow ||
      !loaded.intent.continuation?.maxSyncs ||
      Date.now() >= loaded.intent.deadlineAt ||
      group.cancellation !== 'none' ||
      loaded.authority?.cancelled
    )
      refuse();
    const source = await this.owners.sources.readmitSnapshot(
      context,
      { groupId, workItemId: member.reservedTaskId },
      envelope.execution_binding.source,
    );
    try {
      const flow = await this.owners.sources.prepareFlowSnapshot(
        context,
        { groupId, workItemId: member.reservedTaskId },
        source.capability,
        loaded.intent.flow.runId,
      );
      const schedule = await flow.readSchedule();
      const current = await this.owners.custody.inspectForMutation(
        context,
        groupId,
      );
      if (
        !current?.group ||
        !same(current.group, group) ||
        !same(current.authority, loaded.authority)
      )
        refuse();
      flow.assertCurrent();
      return {
        groupId,
        seatId,
        revision: group.revision,
        flowHead: schedule.runHead,
      };
    } finally {
      this.owners.sources.releaseSnapshot(source.capability);
    }
  }

  async prepare(
    context: RuntimeSourceRequestContext,
    groupId: string,
    seatId: string,
    expectedEnvelope: DelegationEnvelopeV2,
    syncInput: { runId: string; text: string },
    publication?: ReportRoundsPublication,
  ) {
    return this.#capture(
      context,
      groupId,
      seatId,
      {
        kind: 'sync',
        envelope: expectedEnvelope,
        sync: structuredClone(syncInput),
      },
      publication,
    );
  }

  async prepareReport(
    context: RuntimeSourceRequestContext,
    groupId: string,
    seatId: string,
    expectedEnvelope: DelegationEnvelopeV2,
    request: ModelInvocationRequest,
    publication?: ReportRoundsPublication,
  ) {
    return this.#capture(
      context,
      groupId,
      seatId,
      {
        kind: 'report',
        envelope: expectedEnvelope,
        request: structuredClone(request),
      },
      publication,
    );
  }

  async prepareRenewalCandidate(
    context: RuntimeSourceRequestContext,
    groupId: string,
    seatId: string,
    removeInput: boolean,
    publication: ReportRoundsPublication,
  ) {
    const captured = await this.#capture(
      context,
      groupId,
      seatId,
      {
        kind: 'renewal',
        removeInput,
      },
      publication,
    );
    return Object.freeze({
      binding: captured.binding,
      recipient: captured.recipient,
      assertCurrent: () => {
        captured.assertCurrent();
        captured.assertWireCurrent();
        captured.recipient();
        return undefined;
      },
      close: captured.close,
    });
  }

  async #capture(
    context: RuntimeSourceRequestContext,
    groupId: string,
    seatId: string,
    intent:
      | {
          kind: 'sync';
          envelope: DelegationEnvelopeV2;
          sync: { runId: string; text: string };
        }
      | {
          kind: 'report';
          envelope: DelegationEnvelopeV2;
          request: ModelInvocationRequest;
        }
      | { kind: 'renewal'; removeInput: boolean },
    publication?: ReportRoundsPublication,
  ) {
    const sync = intent.kind === 'sync' ? intent.sync : undefined;
    const environment = this.owners.runtime.environmentSecurityService;
    const { custody, orchestration, sources, persistence } = this.owners;
    const writer = await HomeWriterOwner.forHome(
      environment.getProjectHomeDir(),
    );
    const admit = <Value>(check: () => Value): Promise<Value> =>
      publication
        ? publication.withHome(
            {
              owner: writer,
              current: () => {
                context.req.raw.signal.throwIfAborted();
                return undefined;
              },
            },
            async (scope) => scope.check(check),
          )
        : writer.runRequest(context.req.raw.signal, check);
    const loaded = await custody.loadIntentForMutation(
      context,
      groupId,
      publication,
    );
    const epoch = loaded.authority?.epochs.at(-1);
    const seat = loaded.group?.spec.seats.find((s) => s.seatId === seatId);
    const grant = loaded.group?.grants.envelopes.find(
      (s) => s.seatId === seatId,
    );
    const member = loaded.admission.members.find((m) => m.seatId === seatId);
    const original = loaded.intent.members.find((m) => m.seatId === seatId);
    const envelope = epoch?.envelopes.find(
      (e) => e.envelope_id === grant?.envelope.id,
    );
    if (
      !epoch ||
      !seat ||
      !grant ||
      !member ||
      !original ||
      !envelope ||
      !loaded.intent.continuation ||
      loaded.authority?.cancelled ||
      loaded.group?.cancellation !== 'none' ||
      (intent.kind !== 'renewal' && !same(envelope, intent.envelope)) ||
      envelope.execution_id !== member.reservedTaskId ||
      envelope.selected_grant_id !== seatId ||
      envelope.execution_binding.runtime.runtime_receipt_ref.domain !==
        'station.sealed-sdk.runtime.v2'
    )
      refuse();
    const root = epoch.root;
    const request = context.req.raw;
    const authority = await captureEnvironmentLocalGrantObservationOwner(
      request,
      this.owners.runtime.environmentSecurityService,
      this.owners.runtime.requestSecurity,
      admit,
    );
    const lease = await admit(() =>
      authority.requireCurrentLocalGrant(request),
    );
    const principal = await admit(() =>
      createOrchestrationRequestPrincipalResolver({
        environmentSecurityService:
          this.owners.runtime.environmentSecurityService,
      })(context),
    );
    const principalId = root.authenticated_principal_ref.id;
    if (principal.id !== principalId) refuse();
    if (lease.hostContextId !== root.issuer_host_id) refuse();
    const session = orchestration.captureReservedStationSession(
      member.reservedTaskId,
      { userId: principalId },
    );
    const scope = {
      principalId,
      environmentId: root.issuer_host_id,
      threadId: member.reservedTaskId,
    };
    const recipient = reservedStationSessionRecipient(session, scope);
    const sessionCurrent = (): undefined => {
      if (
        orchestration.captureReservedStationSession(member.reservedTaskId, {
          userId: principalId,
        }) !== session ||
        !same(reservedStationSessionRecipient(session, scope), recipient)
      )
        refuse();
      return undefined;
    };
    const selected = await this.#credentials.captureAgentSdkCredential(
      request,
      original.agentId,
      undefined,
      admit,
    );
    if (
      intent.kind === 'renewal' &&
      (!member.runtimeIdentity ||
        member.runtimeIdentity.provider !== selected.provider ||
        member.runtimeIdentity.instructionsDigest !==
          `sha256:${createHash('sha256').update(selected.instructions).digest('hex')}`)
    )
      refuse();
    const qualification = await createSealedProviderPreparation(
      selected.provider,
    );
    const current = (): undefined => {
      request.signal.throwIfAborted();
      lease.assertCurrent();
      qualification.assertCurrent();
      readObservedSdkProviderCredential(
        selected.credential,
        selected.provider,
        request,
      );
      if (Date.now() >= loaded.intent.deadlineAt) refuse();
      return undefined;
    };
    await admit(() => {
      current();
      sessionCurrent();
      qualification.assertSelection(selected.provider, selected.modelId);
    });
    if (selected.modelId !== member.requestedModelId) refuse();
    const subject = { groupId, workItemId: member.reservedTaskId };
    const source =
      intent.kind !== 'renewal'
        ? await sources.readmitSnapshot(
            context,
            subject,
            envelope.execution_binding.source,
          )
        : await sources.captureSnapshot(context, subject, {
            projectSlug: loaded.intent.projectSlug,
            ...(loaded.intent.resourceId
              ? { resourceId: loaded.intent.resourceId }
              : {}),
          });
    const retireSnapshot = sources.prepareSnapshotRetirement(source.capability);
    let closed = false;
    let cleaned = false;
    let closing: Promise<void> | undefined;
    let requestCleanup!: () => void;
    const cleanupRequested = new Promise<void>((resolve) => {
      requestCleanup = resolve;
    });
    const retire = async () => {
      if (cleaned) return;
      closing ??= retireSnapshot().then(() => {
        cleaned = true;
      });
      try {
        await closing;
      } finally {
        closing = undefined;
      }
    };
    let ownedRetire = retire;
    const close = async () => {
      closed = true;
      requestCleanup();
      await ownedRetire();
    };
    try {
      if (publication)
        ownedRetire = publication.retainCleanup(async () => {
          await cleanupRequested;
          await retire();
        });
      const flow = loaded.intent.flow
        ? await sources.prepareFlowSnapshot(
            context,
            subject,
            source.capability,
            loaded.intent.flow.runId,
          )
        : undefined;
      await admit(() => {
        current();
        sessionCurrent();
      });
      const outputDelivery = reservedStationSessionOutputDelivery(
        session,
        scope,
      );
      const wireOptions = {
        ...(outputDelivery === 'streamed' ? { outputDelivery } : {}),
        provider: selected.provider,
        modelId: selected.modelId,
        credential: selected.credential,
        preparation: qualification,
        instructions: selected.instructions,
        maxOutputTokens: seat.allocation.outputTokens,
        remaining: { ...seat.allocation, currency: 'USD' as const },
        now: Date.now,
        signal: request.signal,
        rawFetch: this.owners.rawFetch,
      };
      let reportContext: string | undefined;
      if (intent.kind === 'report') {
        const messages = intent.request.messages;
        const text = messages[0]?.content;
        if (
          typeof text !== 'string' ||
          !same(intent.request, {
            messages: [
              { role: 'user', content: text },
              { role: 'user', content: original.brief },
            ],
            maxOutputTokens: seat.allocation.outputTokens,
          }) ||
          envelope.execution_authority.allowed_tools.length !== 0
        )
          refuse();
        reportContext = text;
      }
      const selectedWire =
        reportContext !== undefined
          ? createContextReportSdkSourceWireOwner({
              ...wireOptions,
              brief: original.brief,
              text: reportContext,
            })
          : sync
            ? createContextSyncSdkSourceWireOwner({
                ...wireOptions,
                runId: sync.runId,
                text: sync.text,
              })
            : {
                owner: createPreparedSdkSourceWireOwner({
                  ...wireOptions,
                  brief: original.brief,
                  ...(original.input &&
                  envelope.execution_authority.allowed_tools.includes(
                    REPORT_INPUT_TOOL_NAME,
                  ) &&
                  intent.kind === 'renewal' &&
                  !intent.removeInput
                    ? { inputTool: true as const }
                    : {}),
                }),
                input: original.brief,
              };
      const { owner, input: brief } = selectedWire;
      const prepared = await sources.prepareSdkSnapshot(
        context,
        subject,
        source.capability,
        owner,
      );
      const { wireDigest, quote, contract, sourceBinding } = await admit(() => {
        current();
        sessionCurrent();
        return inspectSdkSourceWire(owner, prepared.sdkHandle);
      });
      const runtime = reference('station.sealed-sdk.runtime.v2', seatId, {
        agentId: selected.agentId,
        provider: selected.provider,
        modelId: selected.modelId,
        instructionsDigest: `sha256:${createHash('sha256').update(selected.instructions).digest('hex')}`,
        outputTokensPerCall: quote.outputUpperBoundTokens,
        contract: contract,
        source: sourceBinding.source,
      });
      const modelReceipt = reference(
        'station.provider-public-contract.v1',
        contract.id,
        contract,
      );
      if (
        intent.kind !== 'renewal' &&
        (!same(
          runtime,
          envelope.execution_binding.runtime.runtime_receipt_ref,
        ) ||
          !same(
            modelReceipt,
            envelope.execution_binding.runtime.model_receipt_ref,
          ) ||
          !same(sourceBinding.source, envelope.execution_binding.source))
      )
        refuse();
      if (
        sourceBinding.source.repository_id !==
          envelope.execution_binding.source.repository_id ||
        sourceBinding.source.execution_worktree_id !==
          envelope.execution_binding.source.execution_worktree_id ||
        !same(
          {
            inputTokens: quote.inputUpperBoundTokens,
            outputTokens: quote.outputUpperBoundTokens,
            costMicros: quote.costMicros,
          },
          seat.allocation,
        ) ||
        sourceBinding.request !== request ||
        sourceBinding.principalId !== principalId ||
        sourceBinding.hostContextId !== root.issuer_host_id ||
        sourceBinding.expiresAtMs < loaded.intent.deadlineAt ||
        (flow && !same(flow.topology, loaded.group!.spec.topology))
      )
        refuse();
      let claimed = false;
      const assertCurrent = (): undefined => {
        if (closed) refuse();
        current();
        flow?.assertCurrent();
        return undefined;
      };
      return {
        provider: selected.provider,
        binding: structuredClone({
          runtime: {
            ...envelope.execution_binding.runtime,
            runtime_receipt_ref: runtime,
            model_receipt_ref: modelReceipt,
          },
          source: sourceBinding.source,
          flow_binding: envelope.execution_binding.flow_binding,
        }),
        assertWireCurrent: () =>
          assertSdkSourceWireCurrentSync(owner, prepared.sdkHandle),
        assertCurrent,
        flow,
        recipient: () => {
          assertCurrent();
          sessionCurrent();
          return structuredClone(recipient);
        },
        async dispatch(
          invocationId: string,
          effect: string,
          launch: PreparedReservedFinalFetchOwners,
          signal: AbortSignal,
        ) {
          if (
            intent.kind === 'renewal' ||
            claimed ||
            launch.protocol !== 'rounds-v1'
          )
            refuse();
          claimed = true;
          const upstream = launch.finalizeCurrent;
          const finalizeCurrent = (): undefined => {
            assertSynchronous(upstream);
            assertCurrent();
            return undefined;
          };
          const reportHome = launch.reportHome;
          const withHome = reportHome?.withHome;
          const invokeCurrent = reportHome?.invokeCurrent;
          if (!withHome || !invokeCurrent) refuse();
          const withMetadata = <Value>(
            body: (
              scope: Pick<ReportRoundsScope, 'current' | 'check'>,
            ) => Promise<Value>,
          ): Promise<Value> => withHome(finalizeCurrent, body);
          const reservation = {
            groupId,
            controller: loaded.group!.spec.controller,
            seatId,
            authority: loaded.group!.grants.authority,
            envelope: grant.envelope,
            invocationId,
            effect,
            allocation: seat.allocation,
          };
          const boundLaunch = {
            ...launch,
            ...(flow ? { flow } : {}),
            finalizeCurrent,
          };
          const assertLaunchCurrent = (): undefined => {
            finalizeCurrent();
            sessionCurrent();
            return undefined;
          };
          await new RoundsFinalFetchLaunchFence(boundLaunch).admitTask(
            { ...reservation, expectedWireDigest: wireDigest },
            signal,
          );
          await withMetadata(async (scope) => scope.check(sessionCurrent));
          const clientTurnId = `report-continuation:${randomUUID()}`;
          const port = await withMetadata(async (homeScope) => {
            const publicationCurrent = (): undefined =>
              homeScope.check(assertLaunchCurrent);
            const launchMetadata = homeScope.check(() => {
              assertLaunchCurrent();
              const port = prepareReservedStationTurn(
                {
                  ...scope,
                  clientTurnId,
                  input: brief,
                  modelId: selected.modelId,
                },
                {
                  persistence,
                  sdkOwner: owner,
                  sdkHandle: prepared.sdkHandle,
                  assertSessionCurrent: sessionCurrent,
                  transport: {
                    launch: boundLaunch,
                    reservation,
                    contract: contract,
                    provider: selected.provider,
                    signal,
                    now: Date.now,
                    maxResponseBytes: 1024 * 1024,
                  },
                },
                session,
              );
              const sessionReceipt = recipient.sessionReceipt;
              if (sessionReceipt.domain !== 'station.reserved-session.v1')
                refuse();
              const continuationTurn = signReportContinuationTurn(
                {
                  groupId,
                  seatId,
                  invocationId,
                  hostId: scope.environmentId,
                  principalId,
                  admissionSignature: reportAdmissionSignature(
                    loaded.admission,
                    environment,
                  ),
                  taskId: member.reservedTaskId,
                  clientTurnId,
                  recipient: {
                    ...recipient,
                    sessionReceipt: {
                      ...sessionReceipt,
                      domain: sessionReceipt.domain,
                    },
                  },
                },
                environment,
              );
              return { port, continuationTurn };
            });
            await persistence.retainReportContinuationTurn(
              launchMetadata.continuationTurn,
              publicationCurrent,
            );
            publicationCurrent();
            return launchMetadata.port;
          });
          const sent = await orchestration.dispatchWithReceipt(
            {
              type: 'sendTurn',
              input: {
                threadId: member.reservedTaskId,
                clientTurnId,
                input: brief,
                modelId: selected.modelId,
                signal,
              },
            },
            { userId: principalId, principal },
            {
              reservedStationTurn: port,
              delegationGroupAdmission: {
                assertCurrent: assertLaunchCurrent,
                signal,
                invokeCurrent: <Value>(
                  invoke: (
                    check: <Result>(work: () => Result) => Result,
                  ) => Promise<Value>,
                ) => invokeCurrent(finalizeCurrent, invoke),
              },
            },
          );
          if (
            !sent.result ||
            !('turnId' in sent.result) ||
            typeof sent.result.turnId !== 'string'
          )
            refuse();
          const result = await reservedStationTurnResult(port);
          return {
            result,
            sessionId: member.reservedTaskId,
            turnId: sent.result.turnId,
            clientTurnId,
          };
        },
        close,
      };
    } catch (error) {
      try {
        await close();
      } catch (cleanupError) {
        throw new DelegationRoundsTransactionUncertainError(
          'publication-unknown',
          [error, cleanupError],
        );
      }
      throw error;
    }
  }
}
