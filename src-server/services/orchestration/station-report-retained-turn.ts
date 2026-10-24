import { createHash, randomUUID } from 'node:crypto';
import type { DelegationEnvelopeV2 } from '@kontourai/flow-agents/delegation-envelope-v2';
import { canonicalJson } from '@kontourai/relay';
import { createOrchestrationRequestPrincipalResolver } from '../../runtime/bootstrap/orchestration-request-principal.js';
import { AnthropicSealedPreparation } from '../../runtime/conversation/anthropic-sealed-preparation.js';
import { captureEnvironmentLocalGrantObservationOwner } from '../../runtime/conversation/local-grant-observation-owner.js';
import { readObservedSdkProviderCredential } from '../../runtime/conversation/provider-credential-observation.js';
import {
  prepareReservedStationTurn,
  reservedStationSessionRecipient,
  reservedStationTurnResult,
} from '../../runtime/conversation/reserved-station-turn.js';
import {
  RuntimeFencedCredentialObservationOwner,
  type RuntimeFencedCredentialObservationOwners,
} from '../../runtime/conversation/runtime-fenced-credential-observation.js';
import {
  type PreparedReservedFinalFetchOwners,
  RoundsFinalFetchLaunchFence,
} from './delegation-group-launch-fence.js';
import type { StationDelegationPersistence } from './delegation-group-persistence.js';
import {
  createPreparedSdkSourceWireOwner,
  disposeSdkSourceWire,
  inspectSdkSourceWire,
  sdkDisposalPromise,
} from './delegation-group-sdk-source-wire-owner.js';
import type {
  LocalSourceAdmissionOwner,
  RuntimeSourceRequestContext,
} from './delegation-group-source-admission.js';
import { assertSynchronous } from './delegation-group-wire-intent-store.js';
import type { OrchestrationService } from './orchestration-service.js';
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

  async prepare(
    context: RuntimeSourceRequestContext,
    groupId: string,
    seatId: string,
    expectedEnvelope: DelegationEnvelopeV2,
    brief: string,
  ) {
    if (
      typeof brief !== 'string' ||
      !brief ||
      Buffer.byteLength(brief) > 65_536
    )
      refuse();
    const { custody, orchestration, sources, persistence } = this.owners;
    const loaded = await custody.loadIntentForMutation(context, groupId);
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
      !same(envelope, expectedEnvelope) ||
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
    );
    const lease = authority.requireCurrentLocalGrant(request);
    const principal = createOrchestrationRequestPrincipalResolver({
      environmentSecurityService:
        this.owners.runtime.environmentSecurityService,
    })(context);
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
    );
    const qualification = await AnthropicSealedPreparation.create();
    const current = (): undefined => {
      request.signal.throwIfAborted();
      lease.assertCurrent();
      qualification.assertCurrent();
      readObservedSdkProviderCredential(
        selected.credential,
        'anthropic',
        request,
      );
      if (Date.now() >= loaded.intent.deadlineAt) refuse();
      return undefined;
    };
    current();
    sessionCurrent();
    qualification.assertSelection(selected.provider, selected.modelId);
    if (selected.modelId !== member.requestedModelId) refuse();
    const subject = { groupId, workItemId: member.reservedTaskId };
    const source = await sources.readmitSnapshot(
      context,
      subject,
      envelope.execution_binding.source,
    );
    let sdk: { owner: object; sdkHandle: object } | undefined;
    try {
      const flow = loaded.intent.flow
        ? await sources.prepareFlowSnapshot(
            context,
            subject,
            source.capability,
            loaded.intent.flow.runId,
          )
        : undefined;
      current();
      sessionCurrent();
      const owner = createPreparedSdkSourceWireOwner({
        provider: 'anthropic',
        modelId: selected.modelId,
        credential: selected.credential,
        preparation: qualification,
        brief,
        instructions: selected.instructions,
        maxOutputTokens: seat.allocation.outputTokens,
        remaining: { ...seat.allocation, currency: 'USD' },
        now: Date.now,
        signal: request.signal,
        rawFetch: this.owners.rawFetch,
      });
      const prepared = await sources.prepareSdkSnapshot(
        context,
        subject,
        source.capability,
        owner,
      );
      sdk = { owner, sdkHandle: prepared.sdkHandle };
      const { wireDigest, quote, contract, sourceBinding } =
        inspectSdkSourceWire(owner, prepared.sdkHandle);
      current();
      sessionCurrent();
      const runtime = reference('station.sealed-sdk.runtime.v2', seatId, {
        agentId: selected.agentId,
        provider: selected.provider,
        modelId: selected.modelId,
        instructionsDigest: `sha256:${createHash('sha256').update(selected.instructions).digest('hex')}`,
        outputTokensPerCall: quote.outputUpperBoundTokens,
        contract: contract,
        source: sourceBinding.source,
      });
      if (
        !same(
          runtime,
          envelope.execution_binding.runtime.runtime_receipt_ref,
        ) ||
        !same(
          reference(
            'station.provider-public-contract.v1',
            contract.id,
            contract,
          ),
          envelope.execution_binding.runtime.model_receipt_ref,
        ) ||
        !same(sourceBinding.source, envelope.execution_binding.source) ||
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
      let closed = false;
      const assertCurrent = (): undefined => {
        if (closed) refuse();
        current();
        flow?.assertCurrent();
        return undefined;
      };
      const close = async () => {
        if (closed) return;
        closed = true;
        sources.releaseSnapshot(source.capability);
        disposeSdkSourceWire(owner, prepared.sdkHandle);
        await sdkDisposalPromise(owner, prepared.sdkHandle);
      };
      return {
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
          if (claimed || launch.protocol !== 'rounds-v1') refuse();
          claimed = true;
          const upstream = launch.finalizeCurrent;
          const finalizeCurrent = (): undefined => {
            assertSynchronous(upstream);
            assertCurrent();
            return undefined;
          };
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
          sessionCurrent();
          const clientTurnId = `report-continuation:${randomUUID()}`;
          const port = prepareReservedStationTurn(
            { ...scope, clientTurnId, input: brief, modelId: selected.modelId },
            {
              persistence,
              sdkOwner: owner,
              sdkHandle: prepared.sdkHandle,
              assertSessionCurrent: sessionCurrent,
              transport: {
                launch: boundLaunch,
                reservation,
                contract: contract,
                provider: 'anthropic',
                signal,
                now: Date.now,
                maxResponseBytes: 1024 * 1024,
              },
            },
            session,
          );
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
      sources.releaseSnapshot(source.capability);
      if (sdk) {
        disposeSdkSourceWire(sdk.owner, sdk.sdkHandle);
        await sdkDisposalPromise(sdk.owner, sdk.sdkHandle);
      }
      throw error;
    }
  }
}
