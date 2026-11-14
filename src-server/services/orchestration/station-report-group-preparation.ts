import { createHash, randomUUID } from 'node:crypto';
import {
  type DelegationAuthorityV2,
  type DelegationReferenceV2,
  type RootAuthorityV2,
  validateRootAuthorityV2,
} from '@kontourai/flow-agents/delegation-authority-contract';
import { createDelegationAuthorityServiceV3 } from '@kontourai/flow-agents/delegation-authority-service-v3';
import {
  type DelegationEnvelopeV2,
  delegationEnvelopeDigestV2,
  delegationParentReferenceV2,
  rootAuthorityReferenceV2,
  validateDelegationAncestryV2,
  validateDelegationEnvelopeV2,
} from '@kontourai/flow-agents/delegation-envelope-v2';
import {
  type DelegationRoundsSpec,
  validateDelegationRoundsSpec,
} from '@kontourai/flow-agents/delegation-group-rounds';
import { canonicalJson } from '@kontourai/relay';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import { createOrchestrationRequestPrincipalResolver } from '../../runtime/bootstrap/orchestration-request-principal.js';
import { createPersonalRuntimeRequestGuard } from '../../runtime/bootstrap/runtime-tenant-context.js';
import type { BoundedApiProvider } from '../../runtime/conversation/bounded-api-provider-contract.js';
import { captureEnvironmentLocalGrantObservationOwner } from '../../runtime/conversation/local-grant-observation-owner.js';
import {
  type ObservedSdkProviderCredential,
  readObservedSdkProviderCredential,
} from '../../runtime/conversation/provider-credential-observation.js';
import { REPORT_INPUT_TOOL_NAME } from '../../runtime/conversation/report-input-profile.js';
import type { runReservedSdkSourceAttempt } from '../../runtime/conversation/reserved-sdk-source-attempt.js';
import {
  prepareReservedStationTurn,
  reservedStationRecipient,
  reservedStationSessionRecipient,
  reservedStationTurnResult,
} from '../../runtime/conversation/reserved-station-turn.js';
import {
  RuntimeFencedCredentialObservationOwner,
  type RuntimeFencedCredentialObservationOwners,
} from '../../runtime/conversation/runtime-fenced-credential-observation.js';
import type { SealedProviderPreparation } from '../../runtime/conversation/sealed-provider-preparation.js';
import { createReportInputRuntime } from '../../runtime/mcp/report-input-runtime.js';
import { isOperatorInPersonNotAgent } from '../../security/coding-authority.js';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  resolveClientOriginForRequest,
  runtimeRequestPrincipalMayAccessHttpRoute,
} from '../../security/runtime-request-security.js';
import { outsideStationServerScope } from '../../security/station-server-scope.js';
import {
  type DelegatedTaskHandle,
  delegateTask,
} from '../../tools/station-control-delegation.js';
import type { DelegationAttemptClaimStore } from './delegation-attempt-claim-store.js';
import { RoundsFinalFetchLaunchFence } from './delegation-group-launch-fence.js';
import {
  createPreparedSdkSourceWireOwner,
  inspectSdkSourceWire,
} from './delegation-group-sdk-source-wire-owner.js';
import {
  type LocalSourceAdmissionOwner,
  type RuntimeSourceRequestContext,
  type SourceFlowLaunchOwner,
} from './delegation-group-source-admission.js';
import { assertSynchronous } from './delegation-group-wire-intent-store.js';
import type { OrchestrationService } from './orchestration-service.js';
import type { ReportRoundsScope } from './report-rounds-publication.js';
import {
  reportAdmissionData,
  reportAdmissionSignatureMatches,
  reportCredentialDigest,
} from './station-report-group-admission.js';
import {
  parseStationReportGroupInput,
  type StationReportGroupInput,
  StationReportPreparationUnavailable,
} from './station-report-group-input.js';

const brand = Symbol('prepared Station report group');
export type PreparedStationReportGroup = Readonly<{ [brand]: true }>;
type Member = {
  seatId: string;
  agentId: string;
  taskId: string;
  clientTurnId: string;
  brief: string;
  modelId: string;
  provider: BoundedApiProvider;
  instructionsDigest: string;
  qualification: SealedProviderPreparation;
  credential: ObservedSdkProviderCredential;
  owner: object;
  sdkHandle: object;
  snapshot: object;
  dispatched: boolean;
  inputRuntime?: ReturnType<typeof createReportInputRuntime>;
  flow?: SourceFlowLaunchOwner;
};
type RecordValue = {
  intent: StationReportGroupInput;
  root: RootAuthorityV2;
  envelopes: DelegationEnvelopeV2[];
  spec: DelegationRoundsSpec;
  members: Member[];
};
type State = RecordValue & {
  request: Request;
  deadlineAt: number;
  closed: boolean;
};
function refuse(): never {
  throw new StationReportPreparationUnavailable();
}
const reference = (
  domain: string,
  id: string,
  facts: unknown,
): DelegationReferenceV2 => ({
  id,
  domain,
  digest: `sha256:${createHash('sha256').update(canonicalJson(facts)).digest('hex')}`,
});

/** Issues one bounded, no-tools report group from existing authenticated owners.
 * References describe observed facts; only this boot-local capability admits them. */
export class StationReportGroupPreparation {
  readonly #failedInputCleanup = new Set<
    ReturnType<typeof createReportInputRuntime>
  >();
  readonly #personal = createPersonalRuntimeRequestGuard();
  readonly #credentials: RuntimeFencedCredentialObservationOwner;
  readonly #operations = new Map<
    string,
    {
      intent: string;
      request: Request;
      promise: Promise<PreparedStationReportGroup>;
    }
  >();
  readonly #states = new WeakMap<PreparedStationReportGroup, State>();
  constructor(
    private readonly owners: {
      runtime: RuntimeFencedCredentialObservationOwners;
      delegationAttemptClaimStore?: DelegationAttemptClaimStore;
      sources: LocalSourceAdmissionOwner;
      qualification:
        | SealedProviderPreparation
        | ((
            provider: BoundedApiProvider,
          ) => Promise<SealedProviderPreparation>);
      rawFetch: typeof fetch;
    },
  ) {
    this.owners = Object.freeze({
      ...owners,
      runtime: Object.freeze({ ...owners.runtime }),
    });
    this.#credentials = new RuntimeFencedCredentialObservationOwner(
      owners.runtime,
    );
  }

  async prepare(
    context: RuntimeSourceRequestContext,
    sent: StationReportGroupInput,
  ): Promise<PreparedStationReportGroup> {
    const input = parseStationReportGroupInput(sent);
    this.#assertRequest(context.req.raw);
    const authority = await captureEnvironmentLocalGrantObservationOwner(
      context.req.raw,
      this.owners.runtime.environmentSecurityService,
      this.owners.runtime.requestSecurity,
      undefined,
      this.owners.runtime.canonicalLocalGrantOrigin,
    );
    const lease = authority.requireCurrentLocalGrant(context.req.raw);
    lease.assertCurrent();
    await this.retryInputCleanup();
    lease.assertCurrent();
    const principal = createOrchestrationRequestPrincipalResolver({
      environmentSecurityService:
        this.owners.runtime.environmentSecurityService,
    })(context);
    lease.assertCurrent();
    const groupId = `group:${createHash('sha256')
      .update(
        canonicalJson([lease.hostContextId, principal.id, input.operationId]),
      )
      .digest('hex')}`;
    const intent = canonicalJson(input);
    const prior = this.#operations.get(groupId);
    if (prior) {
      if (prior.intent !== intent || prior.request !== context.req.raw)
        refuse();
      const prepared = await prior.promise;
      this.#state(prepared, context.req.raw);
      return prepared;
    }
    if (this.#operations.size >= 128) refuse();
    const promise = this.#prepare(context, input, groupId, principal.id);
    this.#operations.set(groupId, {
      intent,
      request: context.req.raw,
      promise,
    });
    return promise;
  }

  async #prepare(
    context: RuntimeSourceRequestContext,
    input: StationReportGroupInput,
    groupId: string,
    expectedPrincipalId: string,
  ): Promise<PreparedStationReportGroup> {
    const now = Date.now();
    if (
      input.deadlineAt <= now ||
      input.deadlineAt > now + 300_000 ||
      input.maxConcurrent > input.members.length ||
      new Set(input.members.map((m) => m.seatId)).size !== input.members.length
    )
      refuse();
    if (typeof this.owners.qualification !== 'function')
      this.owners.qualification.assertCurrent();
    const qualifications = new Map<
      BoundedApiProvider,
      SealedProviderPreparation
    >();
    const attemptsPerMember = input.continuation?.attemptsPerMember ?? 1;
    const members: Member[] = [];
    const selections = new Map<
      string,
      Awaited<
        ReturnType<
          RuntimeFencedCredentialObservationOwner['captureAgentSdkCredential']
        >
      >
    >();
    const executions: RootAuthorityV2['execution_grants'] = [];
    const authority: DelegationAuthorityV2 = {
      allowed_tools: input.members.some((member) => member.input)
        ? [REPORT_INPUT_TOOL_NAME]
        : [],
      allowed_effects: input.continuation?.maxSyncs
        ? ['report', 'context-sync']
        : ['report'],
      readable_resources: [],
      mutable_resources: [],
      posture: 'report-only',
      approval: 'automatic',
      escalation: 'deny',
    };
    let principalId: string | undefined;
    let hostId: string | undefined;
    let pendingSnapshot: object | undefined;
    const current = () => {
      return this.owners.runtime.environmentSecurityService.withCurrentAuthority(
        () => {
          context.req.raw.signal.throwIfAborted();
          this.#assertRequest(context.req.raw);
          for (const qualification of qualifications.values())
            qualification.assertCurrent();
          if (Date.now() < now || Date.now() >= input.deadlineAt) refuse();
          for (const selected of selections.values())
            readObservedSdkProviderCredential(
              selected.credential,
              selected.provider,
              context.req.raw,
            );
          this.#assertRequest(context.req.raw);
        },
      );
    };
    try {
      for (const member of input.members) {
        current();
        let selected = selections.get(member.agentId);
        if (!selected) {
          selected = await this.#credentials.captureAgentSdkCredential(
            context.req.raw,
            member.agentId,
          );
          selections.set(member.agentId, selected);
        }
        current();
        let qualification = qualifications.get(selected.provider);
        if (!qualification) {
          qualification =
            typeof this.owners.qualification === 'function'
              ? await this.owners.qualification(selected.provider)
              : this.owners.qualification;
          qualifications.set(selected.provider, qualification);
        }
        current();
        qualification.assertSelection(selected.provider, selected.modelId);
        const taskId = `task:${randomUUID()}`;
        const subject = { groupId, workItemId: taskId };
        const sealed = await this.owners.sources.captureSnapshot(
          context,
          subject,
          {
            projectSlug: input.projectSlug,
            ...(input.resourceId === undefined
              ? {}
              : { resourceId: input.resourceId }),
          },
        );
        pendingSnapshot = sealed.capability;
        current();
        const flow = input.flow
          ? await this.owners.sources.prepareFlowSnapshot(
              context,
              subject,
              sealed.capability,
              input.flow.runId,
            )
          : undefined;
        if (flow) {
          const schedule = await flow.readSchedule();
          current();
          if (!schedule.reportSteps.includes(input.flow!.steps[member.seatId]))
            refuse();
          const previousFlow = members[0]?.flow;
          if (
            previousFlow &&
            canonicalJson(previousFlow.topology) !==
              canonicalJson(flow.topology)
          )
            refuse();
        }
        const owner = createPreparedSdkSourceWireOwner({
          outputDelivery: 'streamed',
          provider: selected.provider,
          modelId: selected.modelId,
          credential: selected.credential,
          preparation: qualification,
          brief: member.brief,
          instructions: selected.instructions,
          maxOutputTokens: member.maxOutputTokens,
          remaining: { ...input.budget, currency: 'USD' },
          now: Date.now,
          signal: context.req.raw.signal,
          rawFetch: this.owners.rawFetch,
          ...(member.input ? { inputTool: true as const } : {}),
        });
        const prepared = await this.owners.sources.prepareSdkSnapshot(
          context,
          subject,
          sealed.capability,
          owner,
        );
        const captured = inspectSdkSourceWire(owner, prepared.sdkHandle);
        const binding = captured.sourceBinding;
        current();
        if (
          binding.request !== context.req.raw ||
          binding.principalId !== expectedPrincipalId ||
          binding.expiresAtMs < input.deadlineAt ||
          (principalId !== undefined && principalId !== binding.principalId) ||
          (hostId !== undefined && hostId !== binding.hostContextId)
        )
          refuse();
        const previous = executions[0]?.source;
        if (
          previous &&
          (previous.repository_id !== binding.source.repository_id ||
            previous.source_state_id !== binding.source.source_state_id ||
            previous.dirty_state_fingerprint !==
              binding.source.dirty_state_fingerprint)
        )
          refuse();
        const facts = qualification.read(captured.contract.id);
        if (!facts || facts.expiresAtMs < input.deadlineAt) refuse();
        principalId = binding.principalId;
        hostId = binding.hostContextId;
        executions.push({
          grant_id: member.seatId,
          runtime: {
            runtime_receipt_ref: reference(
              input.continuation
                ? 'station.sealed-sdk.runtime.v2'
                : 'station.sealed-sdk.runtime.v1',
              member.seatId,
              {
                agentId: selected.agentId,
                provider: selected.provider,
                modelId: selected.modelId,
                ...(input.continuation
                  ? {
                      instructionsDigest: `sha256:${createHash('sha256').update(selected.instructions).digest('hex')}`,
                      outputTokensPerCall:
                        captured.quote.outputUpperBoundTokens,
                    }
                  : { wireDigest: captured.wireDigest }),
                contract: captured.contract,
                source: binding.source,
              },
            ),
            model_receipt_ref: reference(
              'station.provider-public-contract.v1',
              captured.contract.id,
              captured.contract,
            ),
            required_capabilities: [],
          },
          source: binding.source,
          flow_binding: flow
            ? {
                status: 'bound',
                flow_run_id: flow.topology.runId,
                definition: flow.topology.definition,
                flow_step_id: input.flow!.steps[member.seatId],
              }
            : { status: 'unbound', reason: 'operator-independent-advisory' },
          authority_ceiling: {
            ...authority,
            allowed_tools: member.input ? [REPORT_INPUT_TOOL_NAME] : [],
          },
        });
        members.push({
          seatId: member.seatId,
          agentId: selected.agentId,
          taskId,
          clientTurnId: randomUUID(),
          brief: member.brief,
          modelId: selected.modelId,
          provider: selected.provider,
          instructionsDigest: `sha256:${createHash('sha256').update(selected.instructions).digest('hex')}`,
          qualification,
          credential: selected.credential,
          owner,
          sdkHandle: prepared.sdkHandle,
          snapshot: sealed.capability,
          dispatched: false,
          ...(flow ? { flow } : {}),
        });
        pendingSnapshot = undefined;
      }
      current();
      if (!principalId || !hostId || !executions[0]) refuse();
      const policy = reference(
        'station.operator-report-policy.v1',
        input.operationId,
        input,
      );
      const source = executions[0].source;
      const budget = {
        remaining_depth: 1,
        max_total_children: input.members.length,
        max_total_envelopes: input.members.length + 1,
        max_concurrent_children: input.maxConcurrent,
        max_runtime_ms: input.deadlineAt - now,
        max_input_tokens: input.budget.inputTokens,
        max_output_tokens: input.budget.outputTokens,
        max_cost_micros: input.budget.costMicros,
        max_attempts: input.members.length * attemptsPerMember,
        expires_at: new Date(input.deadlineAt).toISOString(),
      };
      const root = validateRootAuthorityV2({
        schema_version: '2.0',
        authority_id: groupId,
        authority_epoch: 1,
        issuer_host_id: hostId,
        authenticated_principal_ref: reference(
          'station.authenticated-local-operator.v1',
          principalId,
          [hostId, principalId],
        ),
        authenticated_subject_ref: reference(
          'station.authenticated-report-request.v1',
          groupId,
          [principalId, input],
        ),
        source_origin: {
          repository_id: source.repository_id,
          worktree_id: source.execution_worktree_id,
          source_state_id: source.source_state_id,
          dirty_state_fingerprint: source.dirty_state_fingerprint,
        },
        execution_worktree_ids: executions.map(
          (e) => e.source.execution_worktree_id,
        ),
        execution_grants: executions,
        delegation_ceiling: authority,
        budget,
        revisions: {
          policy,
          prompt: reference('station.report-briefs.v1', groupId, input.members),
          rubric: reference('station.report-result-policy.v1', groupId, {
            acceptance: 'unassessed',
            effect: 'report',
          }),
        },
        root_trace: { trace_id: randomUUID(), span_id: randomUUID() },
        root_cancellation_ref: reference(
          'station.report-group-cancellation.v1',
          groupId,
          [hostId, groupId],
        ),
      });
      const parentGrant =
        executions.find(
          (execution) => execution.authority_ceiling.allowed_tools.length > 0,
        ) ?? executions[0];
      const parent = validateDelegationEnvelopeV2({
        schema_version: '2.0',
        envelope_id: `envelope:${randomUUID()}`,
        generation: 0,
        parent: null,
        root_authority_ref: rootAuthorityReferenceV2(root),
        execution_id: groupId,
        actor: root.authenticated_principal_ref,
        assignment_subject: root.authenticated_subject_ref,
        trace_id: root.root_trace.trace_id,
        span_id: root.root_trace.span_id,
        parent_span_id: null,
        selected_grant_id: parentGrant.grant_id,
        remaining_allowed_grant_ids: executions.map((e) => e.grant_id),
        execution_binding: {
          runtime: parentGrant.runtime,
          source: parentGrant.source,
          flow_binding: parentGrant.flow_binding,
        },
        delegation_ceiling: authority,
        execution_authority: {
          ...authority,
          allowed_effects: [],
          allowed_tools: [],
        },
        budget,
        continuation_ref: reference('station.report-group.v1', groupId, input),
        cancellation_ref: root.root_cancellation_ref,
      });
      const children = executions.map((execution, index) => {
        const { grant_id, authority_ceiling, ...binding } = execution;
        const member = members[index];
        const quote = inspectSdkSourceWire(
          member.owner,
          member.sdkHandle,
        ).quote;
        return validateDelegationEnvelopeV2({
          schema_version: '2.0',
          envelope_id: `envelope:${randomUUID()}`,
          generation: 1,
          parent: delegationParentReferenceV2(parent),
          root_authority_ref: rootAuthorityReferenceV2(root),
          execution_id: member.taskId,
          actor: root.authenticated_principal_ref,
          assignment_subject: root.authenticated_subject_ref,
          trace_id: root.root_trace.trace_id,
          span_id: randomUUID(),
          parent_span_id: parent.span_id,
          selected_grant_id: grant_id,
          remaining_allowed_grant_ids: [],
          execution_binding: binding,
          delegation_ceiling: authority_ceiling,
          execution_authority: authority_ceiling,
          budget: {
            ...budget,
            remaining_depth: 0,
            max_total_children: 1,
            max_concurrent_children: 1,
            max_total_envelopes: 1,
            max_attempts: attemptsPerMember,
            max_input_tokens: quote.inputUpperBoundTokens * attemptsPerMember,
            max_output_tokens: quote.outputUpperBoundTokens * attemptsPerMember,
            max_cost_micros: quote.costMicros * attemptsPerMember,
          },
          continuation_ref: parent.continuation_ref,
          cancellation_ref: root.root_cancellation_ref,
        });
      });
      const envelopes = [parent, ...children];
      for (const field of [
        'max_input_tokens',
        'max_output_tokens',
        'max_cost_micros',
      ] as const) {
        const allocated = children.reduce(
          (sum, envelope) => sum + envelope.budget[field],
          0,
        );
        if (!Number.isSafeInteger(allocated) || allocated > budget[field])
          refuse();
      }
      validateDelegationAncestryV2(root, [parent], new Date(now).toISOString());
      for (const envelope of children)
        validateDelegationAncestryV2(
          root,
          [parent, envelope],
          new Date(now).toISOString(),
        );
      const spec = validateDelegationRoundsSpec({
        schemaVersion: '1.0',
        groupId,
        rootAuthorityRef: rootAuthorityReferenceV2(root),
        controller: { id: `controller:${randomUUID()}`, generation: 1 },
        topology: members[0].flow?.topology ?? { kind: 'independent-advisory' },
        policy: {
          reference: policy,
          maxRounds:
            input.continuation?.maxRounds ?? (input.flow ? members.length : 1),
          ...(input.flow
            ? { maxEvaluations: input.continuation?.maxEvaluations ?? 0 }
            : {}),
          ...(input.continuation
            ? {
                ...(input.continuation.maxSyncs > 0
                  ? { syncAdmission: 'initial-request' as const }
                  : {}),
                maxSyncs: input.continuation.maxSyncs,
                maxRenewals: input.continuation.maxRenewals,
                maxRecoveries: input.continuation.maxRecoveries,
              }
            : {}),
          maxAttempts: members.length * attemptsPerMember,
          maxConcurrent: input.maxConcurrent,
        },
        seats: children.map((envelope, index) => {
          const member = members[index];
          const quote = inspectSdkSourceWire(
            member.owner,
            member.sdkHandle,
          ).quote;
          return {
            seatId: member.seatId,
            ...(input.flow ? { stepId: input.flow.steps[member.seatId] } : {}),
            envelope: {
              id: envelope.envelope_id,
              generation: envelope.generation,
              digest: delegationEnvelopeDigestV2(envelope),
            },
            effect: 'report',
            allocation: {
              inputTokens: quote.inputUpperBoundTokens,
              outputTokens: quote.outputUpperBoundTokens,
              costMicros: quote.costMicros,
            },
          };
        }),
      });
      current();
      const handle: PreparedStationReportGroup = Object.freeze({
        [brand]: true,
      });
      this.#states.set(handle, {
        intent: input,
        root,
        envelopes,
        spec,
        members,
        request: context.req.raw,
        deadlineAt: input.deadlineAt,
        closed: false,
      });
      return handle;
    } catch (error) {
      if (pendingSnapshot) this.owners.sources.releaseSnapshot(pendingSnapshot);
      for (const member of members)
        this.owners.sources.releaseSnapshot(member.snapshot);
      throw error;
    }
  }

  #assertRequest(request: Request): void {
    if (
      !this.#personal(request) ||
      !isOperatorInPersonNotAgent(request) ||
      !runtimeRequestPrincipalMayAccessHttpRoute(
        request,
        this.owners.runtime.environmentSecurityService,
        { method: 'POST', path: '/api/orchestration/chat' },
      )
    )
      refuse();
  }
  #boundState(
    handle: PreparedStationReportGroup,
    request: Request,
    expected?: State,
  ): State {
    const state = this.#states.get(handle);
    if (
      !state ||
      (expected !== undefined && state !== expected) ||
      state.closed ||
      state.request !== request ||
      request.signal.aborted ||
      Date.now() >= state.deadlineAt
    )
      refuse();
    return state;
  }
  #state(handle: PreparedStationReportGroup, request: Request): State {
    const state =
      this.owners.runtime.environmentSecurityService.withCurrentAuthority(
        () => {
          const state = this.#boundState(handle, request);
          this.#assertRequest(request);
          for (const qualification of new Set(
            state.members.map((m) => m.qualification),
          ))
            qualification.assertCurrent();
          const credentials = new Set<ObservedSdkProviderCredential>();
          for (const member of state.members) {
            member.flow?.assertCurrent();
          }
          for (const member of state.members) {
            if (!credentials.has(member.credential)) {
              readObservedSdkProviderCredential(
                member.credential,
                member.provider,
                request,
              );
              credentials.add(member.credential);
            }
          }
          this.#assertRequest(request);
          return state;
        },
      );
    return this.#boundState(handle, request, state);
  }
  authorizes(
    handle: PreparedStationReportGroup,
    request: Request,
    root: RootAuthorityV2,
    envelope: DelegationEnvelopeV2 | null,
  ): boolean {
    const state = this.#state(handle, request);
    return (
      canonicalJson(root) === canonicalJson(state.root) &&
      (envelope === null ||
        state.envelopes.some(
          (e) => canonicalJson(e) === canonicalJson(envelope),
        ))
    );
  }
  confirmsExecution(
    handle: PreparedStationReportGroup,
    request: Request,
    envelope: DelegationEnvelopeV2,
  ): boolean {
    return this.owners.runtime.environmentSecurityService.withCurrentAuthority(
      () => {
        const state = this.#state(handle, request);
        if (
          !state.envelopes.some(
            (e) => canonicalJson(e) === canonicalJson(envelope),
          )
        )
          return false;
        const member = state.members.find(
          (m) => m.seatId === envelope.selected_grant_id,
        );
        if (!member) return false;
        const captured = inspectSdkSourceWire(member.owner, member.sdkHandle);
        return (
          canonicalJson(captured.sourceBinding.source) ===
          canonicalJson(envelope.execution_binding.source)
        );
      },
    );
  }

  assertCurrent(handle: PreparedStationReportGroup, request: Request): void {
    this.#state(handle, request);
  }

  read(
    handle: PreparedStationReportGroup,
    request: Request,
  ): Omit<RecordValue, 'members'> & {
    members: Array<
      Pick<
        Member,
        | 'seatId'
        | 'agentId'
        | 'taskId'
        | 'clientTurnId'
        | 'brief'
        | 'modelId'
        | 'provider'
      >
    >;
  } {
    const { intent, root, envelopes, spec, members } = this.#state(
      handle,
      request,
    );
    return structuredClone({
      intent,
      root,
      envelopes,
      spec,
      members: members.map(
        ({
          seatId,
          agentId,
          taskId,
          clientTurnId,
          brief,
          modelId,
          provider,
          instructionsDigest,
        }) => ({
          seatId,
          agentId,
          taskId,
          clientTurnId,
          brief,
          modelId,
          provider,
          instructionsDigest,
        }),
      ),
    });
  }
  flow(
    handle: PreparedStationReportGroup,
    request: Request,
    seatId?: string,
  ): SourceFlowLaunchOwner | undefined {
    const state = this.#state(handle, request);
    return (
      seatId === undefined
        ? state.members[0]
        : state.members.find((member) => member.seatId === seatId)
    )?.flow;
  }
  sdk(
    handle: PreparedStationReportGroup,
    request: Request,
    seatId: string,
  ): { owner: object; sdkHandle: object } {
    return this.owners.runtime.environmentSecurityService.withCurrentAuthority(
      () => {
        const member = this.#state(handle, request).members.find(
          (m) => m.seatId === seatId,
        );
        if (!member) refuse();
        inspectSdkSourceWire(member.owner, member.sdkHandle);
        return { owner: member.owner, sdkHandle: member.sdkHandle };
      },
    );
  }
  /** A task start is a control-plane effect; the paid request still requires
   * the independently persisted rounds reservation at the final wire fence. */
  async dispatch(
    handle: PreparedStationReportGroup,
    context: RuntimeSourceRequestContext,
    seatId: string,
    attempt: Omit<
      Parameters<typeof runReservedSdkSourceAttempt>[0],
      'sdkOwner' | 'sdkHandle'
    >,
    orchestration: OrchestrationService,
  ): Promise<{
    task: DelegatedTaskHandle;
    result: ReturnType<typeof reservedStationTurnResult>;
    recipient: () => ReturnType<typeof reservedStationRecipient>;
  }> {
    attempt = {
      ...attempt,
      transport: {
        ...attempt.transport,
        reservation: structuredClone(attempt.transport.reservation),
        launch: { ...attempt.transport.launch },
      },
    };
    const signal = AbortSignal.any([
      context.req.raw.signal,
      attempt.transport.signal,
    ]);
    const upstreamFinalize = attempt.transport.launch.finalizeCurrent;
    const finalizeCurrent = (): undefined => {
      assertSynchronous(upstreamFinalize);
      this.#state(handle, context.req.raw);
      signal.throwIfAborted();
      return undefined;
    };
    const withHome =
      attempt.transport.launch.protocol === 'rounds-v1'
        ? attempt.transport.launch.reportHome?.withHome
        : undefined;
    const withMetadata = <Value>(
      body: (
        scope: Pick<ReportRoundsScope, 'current' | 'check'>,
      ) => Promise<Value>,
    ): Promise<Value> =>
      withHome
        ? withHome(finalizeCurrent, body)
        : body({ current: finalizeCurrent, check: (work) => work() });
    const { state, member, captured, principal, invocationId } =
      await withMetadata(async (scope) => {
        const prepared = scope.check(() => {
          const state = this.#state(handle, context.req.raw);
          const member = state.members.find((m) => m.seatId === seatId);
          const seat = state.spec.seats.find((s) => s.seatId === seatId);
          if (!member || !seat || member.dispatched) refuse();
          if (member.flow) {
            if (attempt.transport.launch.protocol !== 'rounds-v1') refuse();
            attempt.transport.launch.flow = member.flow;
          }
          const captured = inspectSdkSourceWire(member.owner, member.sdkHandle);
          const reserved = attempt.transport.reservation;
          const invocationId = reserved.invocationId;
          const reservation = {
            groupId: reserved.groupId,
            controller: reserved.controller,
            seatId: reserved.seatId,
            authority: reserved.authority,
            envelope: reserved.envelope,
            effect: reserved.effect,
            allocation: reserved.allocation,
          };
          if (
            typeof invocationId !== 'string' ||
            !invocationId ||
            attempt.transport.launch.protocol !== 'rounds-v1' ||
            attempt.transport.provider !== member.provider ||
            attempt.transport.contract !== captured.contract ||
            canonicalJson(reservation) !==
              canonicalJson({
                groupId: state.spec.groupId,
                controller: state.spec.controller,
                seatId,
                authority: state.spec.rootAuthorityRef,
                envelope: seat.envelope,
                effect: seat.effect,
                allocation: seat.allocation,
              })
          )
            refuse();
          const principal = createOrchestrationRequestPrincipalResolver({
            environmentSecurityService:
              this.owners.runtime.environmentSecurityService,
          })(context);
          if (principal.id !== state.root.authenticated_principal_ref.id)
            refuse();
          member.dispatched = true;
          return { state, member, captured, principal, invocationId };
        });
        const stored = await attempt.persistence.readReportAdmission(
          prepared.state.spec.groupId,
          scope.current,
        );
        scope.check(() => {
          finalizeCurrent();
          const authenticated = getRuntimeAuthenticatedRequestPrincipal(
            context.req.raw,
          );
          if (
            !stored ||
            !authenticated ||
            authenticated.kind === 'internal' ||
            !reportAdmissionSignatureMatches(
              stored,
              this.owners.runtime.environmentSecurityService,
            ) ||
            canonicalJson(stored.data) !==
              canonicalJson(
                reportAdmissionData(
                  this.read(handle, context.req.raw),
                  reportCredentialDigest(authenticated.credential),
                ),
              )
          )
            refuse();
          finalizeCurrent();
        });
        return prepared;
      });
    if (attempt.transport.launch.protocol !== 'rounds-v1') refuse();
    const admission = new RoundsFinalFetchLaunchFence({
      ...attempt.transport.launch,
      finalizeCurrent,
    });
    await admission.admitTask(
      {
        ...attempt.transport.reservation,
        expectedWireDigest: captured.wireDigest,
      },
      signal,
    );
    const { launch, port } = await withMetadata(async (scope) =>
      scope.check(() => {
        finalizeCurrent();
        const launch = attempt.transport.launch;
        if (launch.protocol !== 'rounds-v1') refuse();
        const inputRuntime = state.intent.members.find(
          (entry) => entry.seatId === seatId,
        )?.input
          ? createReportInputRuntime({
              persistence: attempt.persistence,
              retainCleanup: (cleanup) => {
                const retainCleanup = launch.reportHome?.retainCleanup;
                if (!retainCleanup) refuse();
                return retainCleanup(cleanup);
              },
              check: (current, body) => {
                const check = launch.reportHome?.check;
                if (!check) refuse();
                return check(current, body);
              },
              withHome: (current, body) => {
                const withHome = launch.reportHome?.withHome;
                if (!withHome) refuse();
                return withHome(current, body);
              },
              invokeCurrent: (current, invoke) => {
                const invokeCurrent = launch.reportHome?.invokeCurrent;
                if (!invokeCurrent) refuse();
                return invokeCurrent(current, invoke);
              },
              authorize: async (binding) => {
                const withInputAuthority =
                  launch.reportHome?.withFinalFetchScope;
                if (!withInputAuthority) refuse();
                return withInputAuthority(async (inputScope, facades) => {
                  inputScope.check(() => {
                    finalizeCurrent();
                    if (
                      binding.groupId !== state.spec.groupId ||
                      binding.invocationId !== invocationId ||
                      binding.seatId !== seatId ||
                      binding.executionId !== member.taskId
                    )
                      refuse();
                  });
                  const service = createDelegationAuthorityServiceV3(
                    facades.authorities,
                    {
                      ...facades.host,
                      // Input authority cannot revive the consumed paid wire.
                      confirmExecution: async (envelope) =>
                        inputScope.check(() => {
                          finalizeCurrent();
                          return (
                            envelope.execution_id === member.taskId &&
                            this.authorizes(
                              handle,
                              context.req.raw,
                              state.root,
                              envelope,
                            )
                          );
                        }),
                      authenticateRenewal: async () => null,
                    },
                    { maxRenewals: state.spec.policy.maxRenewals ?? 0 },
                  );
                  const admitted = await service.admitEffect(
                    binding.rootId,
                    binding.envelope.id,
                    'report',
                  );
                  inputScope.check(finalizeCurrent);
                  return admitted.envelope;
                });
              },
            })
          : undefined;
        member.inputRuntime = inputRuntime;
        const port = prepareReservedStationTurn(
          {
            principalId: principal.id,
            environmentId: state.root.issuer_host_id,
            threadId: member.taskId,
            clientTurnId: member.clientTurnId,
            input: member.brief,
            modelId: member.modelId,
          },
          {
            ...attempt,
            sdkOwner: member.owner,
            sdkHandle: member.sdkHandle,
            transport: {
              ...attempt.transport,
              signal,
              now: Date.now,
              launch: { ...attempt.transport.launch, finalizeCurrent },
            },
          },
          undefined,
          inputRuntime,
        );
        return { launch, port };
      }),
    );
    const invokeCurrent = launch.reportHome?.invokeCurrent;
    const task = await delegateTask(
      {
        reservedStationTurn: port,
        delegationAttemptClaimStore: this.owners.delegationAttemptClaimStore,
        delegationGroupAdmission: {
          assertCurrent: finalizeCurrent,
          signal,
          ...(invokeCurrent
            ? {
                invokeCurrent: <Value>(
                  invoke: (
                    check: <Result>(work: () => Result) => Result,
                  ) => Promise<Value>,
                ) => invokeCurrent(finalizeCurrent, invoke),
              }
            : {}),
        },
        prompt: member.brief,
        sessionId: member.taskId,
        clientTurnId: member.clientTurnId,
        initialClientTurnId: member.clientTurnId,
        userId: principal.id,
        principal,
        clientOrigin: resolveClientOriginForRequest(context.req.raw),
        target: {
          environment: { kind: 'current' },
          agent: agentId(member.agentId),
          expectedEngine: { kind: 'station' },
          model: { override: member.modelId },
        },
      },
      orchestration,
    );
    await withMetadata(async (scope) =>
      scope.check(() => {
        finalizeCurrent();
        if (
          task.taskId !== member.taskId ||
          task.sessionId !== member.taskId ||
          !task.initialTurnId
        )
          refuse();
      }),
    );
    const result = reservedStationTurnResult(port);
    outsideStationServerScope(() => {
      void result.catch(() => {});
    });
    return {
      task,
      result,
      recipient: () => {
        this.#state(handle, context.req.raw);
        const observed = reservedStationSessionRecipient(
          orchestration.captureReservedStationSession(member.taskId, {
            userId: principal.id,
          }),
          {
            principalId: principal.id,
            environmentId: state.root.issuer_host_id,
            threadId: member.taskId,
          },
        );
        if (
          canonicalJson(observed) !==
          canonicalJson(reservedStationRecipient(port))
        )
          refuse();
        return observed;
      },
    };
  }

  async retryInputCleanup(): Promise<void> {
    for (const runtime of this.#failedInputCleanup) {
      await runtime.close();
      this.#failedInputCleanup.delete(runtime);
    }
  }

  async closeInputs(handle: PreparedStationReportGroup): Promise<void> {
    const state = this.#states.get(handle);
    if (!state) refuse();
    const runtimes = state.members.flatMap((member) =>
      member.inputRuntime ? [member.inputRuntime] : [],
    );
    for (const runtime of runtimes) this.#failedInputCleanup.add(runtime);
    const results = await Promise.allSettled(
      runtimes.map((runtime) =>
        runtime.close().then(() => {
          this.#failedInputCleanup.delete(runtime);
        }),
      ),
    );
    if (results.some((result) => result.status === 'rejected')) refuse();
  }

  close(handle: PreparedStationReportGroup): void {
    const state = this.#states.get(handle);
    if (!state || state.closed) return;
    state.closed = true;
    for (const member of state.members)
      this.owners.sources.releaseSnapshot(member.snapshot);
  }
}
