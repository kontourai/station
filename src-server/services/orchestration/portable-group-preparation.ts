import { createHash, randomUUID } from 'node:crypto';
import {
  type DelegationAuthorityV2,
  type DelegationReferenceV2,
  type RootAuthorityV2,
  validateRootAuthorityV2,
} from '@kontourai/flow-agents/delegation-authority-contract';
import {
  type DelegationEnvelopeV2,
  delegationEnvelopeDigestV2,
  delegationParentReferenceV2,
  rootAuthorityReferenceV2,
  validateDelegationAncestryV2,
  validateDelegationEnvelopeV2,
} from '@kontourai/flow-agents/delegation-envelope-v2';
import {
  type DelegationGroupSpecV2,
  validateDelegationGroupSpecV2,
} from '@kontourai/flow-agents/delegation-group-v2';
import { canonicalJson } from '@kontourai/relay';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type {
  RequestDelegationResolver,
  ResolvedRequestDelegation,
} from '../../runtime/agents/request-delegation.js';
import { createOrchestrationRequestPrincipalResolver } from '../../runtime/bootstrap/orchestration-request-principal.js';
import type { BoundedApiProvider } from '../../runtime/conversation/bounded-api-provider-contract.js';
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
import { resolveClientOriginForRequest } from '../../security/runtime-request-security.js';
import { stationControlRequestAuthority } from '../../security/station-control-request-authority.js';
import { outsideStationServerScope } from '../../security/station-server-scope.js';
import {
  type DelegatedTaskHandle,
  delegateTask,
} from '../../tools/station-control-delegation.js';
import {
  STATION_CONTROL_CALLER_TOKEN_HEADER,
  withStationControlCallerBinding,
  withStationControlCallerContext,
} from '../../tools/station-control-shared.js';
import { HomeWriterOwner } from '../ssh/home-writer-owner.js';
import type { DelegationAttemptClaimStore } from './delegation-attempt-claim-store.js';
import { FinalFetchLaunchFence } from './delegation-group-launch-fence.js';
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
import {
  parseStationReportGroupInput,
  type StationReportGroupInput,
  StationReportPreparationUnavailable,
} from './station-report-group-input.js';

export class PortableGroupBudgetInsufficient extends Error {
  readonly code = 'group_budget_insufficient';
  readonly phase = 'refused' as const;
  constructor() {
    super('The group budget cannot reserve all admitted seats.');
  }
}

function assertSupportedInput(input: StationReportGroupInput): void {
  if (input.continuation || input.members.some((member) => member.input))
    refuse();
}

const brand = Symbol('prepared portable group');
export type PreparedPortableGroup = Readonly<{ [brand]: true }>;
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
  spec: DelegationGroupSpecV2;
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
const samePortable = (a: unknown, b: unknown) =>
  canonicalJson(a) === canonicalJson(b);
const reference = (
  domain: string,
  id: string,
  facts: unknown,
): DelegationReferenceV2 => ({
  id,
  domain,
  digest: `sha256:${createHash('sha256').update(canonicalJson(facts)).digest('hex')}`,
});

/** Prepares V2 authority from request-bound source and credential observations. */
// UNWIRED(#91): factory serving and full caller/protocol qualification remain open.
export class PortableGroupPreparation {
  readonly #failedInputCleanup = new Set<
    ReturnType<typeof createReportInputRuntime>
  >();
  readonly #requestAuthorities = new WeakMap<
    Request,
    Awaited<
      ReturnType<LocalSourceAdmissionOwner['captureRequestAuthority']>
    > & { delegation?: ResolvedRequestDelegation; lineageDigest?: string }
  >();
  readonly #credentials: RuntimeFencedCredentialObservationOwner;
  readonly #operations = new Map<
    string,
    {
      intent: string;
      request: Request;
      promise: Promise<PreparedPortableGroup>;
    }
  >();
  readonly #states = new WeakMap<PreparedPortableGroup, State>();
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
      resolveDelegation?: RequestDelegationResolver;
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

  async operationIdentity(
    context: RuntimeSourceRequestContext,
    sent: StationReportGroupInput,
  ) {
    const input = parseStationReportGroupInput(sent);
    assertSupportedInput(input);
    const authority = await this.bindRequest(context);
    const groupId = `group:${createHash('sha256')
      .update(
        canonicalJson([
          authority.hostContextId,
          authority.ownerIdentity,
          input.operationId,
        ]),
      )
      .digest('hex')}`;
    authority.assertCurrent();
    return { groupId, principalId: authority.principalId };
  }

  async prepare(
    context: RuntimeSourceRequestContext,
    sent: StationReportGroupInput,
  ): Promise<PreparedPortableGroup> {
    const input = parseStationReportGroupInput(sent);
    assertSupportedInput(input);
    const { groupId, principalId } = await this.operationIdentity(
      context,
      input,
    );
    await this.retryInputCleanup();
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
    const promise = this.#prepare(context, input, groupId, principalId);
    this.#operations.set(groupId, {
      intent,
      request: context.req.raw,
      promise,
    });
    try {
      return await promise;
    } catch (error) {
      if (this.#operations.get(groupId)?.promise === promise)
        this.#operations.delete(groupId);
      throw error;
    }
  }

  async #prepare(
    context: RuntimeSourceRequestContext,
    input: StationReportGroupInput,
    groupId: string,
    expectedPrincipalId: string,
  ): Promise<PreparedPortableGroup> {
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
    const attemptsPerMember = 1;
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
        const isBoundCaller =
          stationControlRequestAuthority(context.req.raw)?.kind === 'caller';
        const sessionCapability = isBoundCaller
          ? await this.owners.sources.captureStationControlCredentialAuthority(
              context,
              subject,
              sealed.capability,
              member.agentId,
            )
          : undefined;
        const selectionKey = isBoundCaller ? member.seatId : member.agentId;
        let selected = selections.get(selectionKey);
        if (!selected) {
          selected = await this.#credentials.captureAgentSdkCredential(
            context.req.raw,
            member.agentId,
            sessionCapability,
          );
          selections.set(selectionKey, selected);
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
      const requestAuthority = this.#requestAuthorities.get(context.req.raw);
      if (!requestAuthority) refuse();
      const parentConversationId =
        requestAuthority.delegation?.context.parentConversationId;
      const root = validateRootAuthorityV2({
        schema_version: '2.0',
        authority_id: groupId,
        authority_epoch: 1,
        issuer_host_id: hostId,
        authenticated_principal_ref: reference(
          requestAuthority.delegation
            ? 'station.authenticated-session-owner.v1'
            : 'station.authenticated-local-operator.v1',
          principalId,
          [hostId, principalId],
        ),
        authenticated_subject_ref: reference(
          requestAuthority.delegation
            ? 'station.authenticated-session-subject.v1'
            : 'station.authenticated-report-request.v1',
          parentConversationId ?? principalId,
          requestAuthority.delegation
            ? [
                principalId,
                parentConversationId,
                requestAuthority.lineageDigest,
              ]
            : [principalId, input],
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
        if (!Number.isSafeInteger(allocated)) refuse();
        if (allocated > budget[field])
          throw new PortableGroupBudgetInsufficient();
      }
      validateDelegationAncestryV2(root, [parent], new Date(now).toISOString());
      for (const envelope of children)
        validateDelegationAncestryV2(
          root,
          [parent, envelope],
          new Date(now).toISOString(),
        );
      const spec = validateDelegationGroupSpecV2({
        schemaVersion: '2.0',
        groupId,
        rootAuthorityRef: rootAuthorityReferenceV2(root),
        controller: { id: `controller:${randomUUID()}`, generation: 1 },
        topology: members[0].flow?.topology ?? { kind: 'independent-advisory' },
        policy: { reference: policy, maxConcurrent: input.maxConcurrent },
        seats: children.map((envelope, index) => {
          const member = members[index];
          const quote = inspectSdkSourceWire(
            member.owner,
            member.sdkHandle,
          ).quote;
          return {
            seatId: member.seatId,
            stepId: input.flow ? input.flow.steps[member.seatId] : null,
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
      const handle: PreparedPortableGroup = Object.freeze({
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

  async bindRequest(context: RuntimeSourceRequestContext) {
    const request = context.req.raw;
    const previous = this.#requestAuthorities.get(request);
    if (previous) {
      previous.assertCurrent();
      return previous;
    }
    const authority =
      await this.owners.sources.captureRequestAuthority(context);
    authority.assertCurrent();
    const caller = stationControlRequestAuthority(request);
    let delegation: ResolvedRequestDelegation | undefined;
    let lineageDigest: string | undefined;
    if (caller?.kind === 'caller') {
      if (!this.owners.resolveDelegation) refuse();
      const resolved = await this.owners.resolveDelegation(request, {
        tool: 'delegate_task',
      });
      delegation = resolved ? structuredClone(resolved) : undefined;
      authority.assertCurrent();
      if (
        delegation?.provenance !== 'caller-derived' ||
        delegation.context.parentConversationId !==
          (caller.caller.conversationId ?? caller.caller.sessionId)
      )
        refuse();
      lineageDigest = `sha256:${createHash('sha256').update(canonicalJson(delegation.context)).digest('hex')}`;
    }
    const bound = Object.freeze({
      ...authority,
      ...(delegation ? { delegation, lineageDigest } : {}),
    });
    this.#requestAuthorities.set(request, bound);
    return bound;
  }
  #assertRequest(request: Request): void {
    const authority = this.#requestAuthorities.get(request);
    if (!authority) refuse();
    authority.assertCurrent();
  }
  #state(handle: PreparedPortableGroup, request: Request): State {
    return this.owners.runtime.environmentSecurityService.withCurrentAuthority(
      () => {
        const state = this.#states.get(handle);
        if (
          !state ||
          state.closed ||
          state.request !== request ||
          request.signal.aborted ||
          Date.now() >= state.deadlineAt
        )
          refuse();
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
  }
  authorizes(
    handle: PreparedPortableGroup,
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
    handle: PreparedPortableGroup,
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

  currentExecutionBinding(
    handle: PreparedPortableGroup,
    request: Request,
    grantId: string,
  ) {
    const state = this.#state(handle, request);
    const member = state.members.find((value) => value.seatId === grantId);
    const grant = state.root.execution_grants.find(
      (value) => value.grant_id === grantId,
    );
    if (!member || !grant) refuse();
    const captured = inspectSdkSourceWire(member.owner, member.sdkHandle);
    if (
      canonicalJson(captured.sourceBinding.source) !==
      canonicalJson(grant.source)
    )
      refuse();
    this.#state(handle, request);
    return structuredClone({
      runtime: grant.runtime,
      source: grant.source,
      flow_binding: grant.flow_binding,
    });
  }

  assertCurrent(handle: PreparedPortableGroup, request: Request): void {
    this.#state(handle, request);
  }

  read(
    handle: PreparedPortableGroup,
    request: Request,
  ): Omit<RecordValue, 'members'> & {
    ownerIdentity?: string;
    lineageDigest?: string;
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
        | 'instructionsDigest'
      >
    >;
  } {
    const { intent, root, envelopes, spec, members } = this.#state(
      handle,
      request,
    );
    const requestAuthority = this.#requestAuthorities.get(request);
    const ownerIdentity = requestAuthority?.ownerIdentity;
    if (!ownerIdentity) refuse();
    return structuredClone({
      ...(ownerIdentity !== root.authenticated_principal_ref.id
        ? { ownerIdentity, lineageDigest: requestAuthority?.lineageDigest }
        : {}),
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
  admission(handle: PreparedPortableGroup, request: Request) {
    const payload = this.read(handle, request);
    const signature =
      this.owners.runtime.environmentSecurityService.signRevisionEvidenceAuthorityBinding(
        canonicalJson(['station.portable-group-admission.v1', payload]),
      );
    this.#state(handle, request);
    return { payload, signature };
  }

  classifyAdmission(
    context: RuntimeSourceRequestContext,
    admission: ReturnType<PortableGroupPreparation['admission']>,
  ) {
    const captured = structuredClone(admission);
    this.#assertRequest(context.req.raw);
    const environment = this.owners.runtime.environmentSecurityService;
    if (
      captured.signature !==
      environment.signRevisionEvidenceAuthorityBinding(
        canonicalJson([
          'station.portable-group-admission.v1',
          captured.payload,
        ]),
      )
    )
      refuse();
    const root = validateRootAuthorityV2(captured.payload.root);
    const spec = validateDelegationGroupSpecV2(captured.payload.spec);
    const principal = createOrchestrationRequestPrincipalResolver({
      environmentSecurityService: environment,
    })(context);
    if (
      root.authority_id !== spec.groupId ||
      !samePortable(spec.rootAuthorityRef, rootAuthorityReferenceV2(root))
    )
      refuse();
    const requestAuthority = this.#requestAuthorities.get(context.req.raw);
    const owned =
      principal.id === root.authenticated_principal_ref.id &&
      captured.payload.lineageDigest === requestAuthority?.lineageDigest &&
      (captured.payload.ownerIdentity ??
        root.authenticated_principal_ref.id) ===
        this.#requestAuthorities.get(context.req.raw)?.ownerIdentity;
    this.#assertRequest(context.req.raw);
    return { owned, payload: captured.payload };
  }
  inspectAdmission(
    context: RuntimeSourceRequestContext,
    admission: ReturnType<PortableGroupPreparation['admission']>,
  ) {
    const result = this.classifyAdmission(context, admission);
    if (!result.owned) refuse();
    return result.payload;
  }

  async readmit(
    context: RuntimeSourceRequestContext,
    admission: ReturnType<PortableGroupPreparation['admission']>,
  ): Promise<PreparedPortableGroup> {
    const { payload, signature } = structuredClone(admission);
    const environment = this.owners.runtime.environmentSecurityService;
    await this.bindRequest(context);
    this.#assertRequest(context.req.raw);
    if (
      signature !==
      environment.signRevisionEvidenceAuthorityBinding(
        canonicalJson(['station.portable-group-admission.v1', payload]),
      )
    )
      refuse();
    const intent = parseStationReportGroupInput(payload.intent);
    assertSupportedInput(intent);
    const root = validateRootAuthorityV2(payload.root);
    const spec = validateDelegationGroupSpecV2(payload.spec);
    const envelopes = payload.envelopes.map(validateDelegationEnvelopeV2);
    if (
      canonicalJson(spec.rootAuthorityRef) !==
        canonicalJson(rootAuthorityReferenceV2(root)) ||
      spec.groupId !== root.authority_id ||
      intent.deadlineAt <= Date.now() ||
      payload.members.length !== spec.seats.length
    )
      refuse();
    const principal = createOrchestrationRequestPrincipalResolver({
      environmentSecurityService: environment,
    })(context);
    if (
      principal.id !== root.authenticated_principal_ref.id ||
      payload.lineageDigest !==
        this.#requestAuthorities.get(context.req.raw)?.lineageDigest ||
      (payload.ownerIdentity ?? root.authenticated_principal_ref.id) !==
        this.#requestAuthorities.get(context.req.raw)?.ownerIdentity
    )
      refuse();
    const members: Member[] = [];
    let pendingSnapshot: object | undefined;
    try {
      for (const entry of payload.members) {
        const requested = intent.members.find(
          (value) => value.seatId === entry.seatId,
        );
        const seat = spec.seats.find((value) => value.seatId === entry.seatId);
        const envelope = envelopes.find(
          (value) => value.envelope_id === seat?.envelope.id,
        );
        const grant = root.execution_grants.find(
          (value) => value.grant_id === entry.seatId,
        );
        if (
          !requested ||
          !seat ||
          !envelope ||
          !grant ||
          requested.agentId !== entry.agentId ||
          requested.brief !== entry.brief ||
          envelope.execution_id !== entry.taskId ||
          envelope.selected_grant_id !== entry.seatId ||
          delegationEnvelopeDigestV2(envelope) !== seat.envelope.digest
        )
          refuse();
        const sealed = await this.owners.sources.readmitSnapshot(
          context,
          { groupId: spec.groupId, workItemId: entry.taskId },
          grant.source,
        );
        pendingSnapshot = sealed.capability;
        const flow = intent.flow
          ? await this.owners.sources.prepareFlowSnapshot(
              context,
              { groupId: spec.groupId, workItemId: entry.taskId },
              sealed.capability,
              intent.flow.runId,
            )
          : undefined;
        if (flow) {
          const schedule = await flow.readSchedule();
          if (
            !samePortable(flow.topology, spec.topology) ||
            !samePortable(flow.source, grant.source) ||
            !seat.stepId ||
            intent.flow?.steps[entry.seatId] !== seat.stepId ||
            !schedule.reportSteps.includes(seat.stepId)
          )
            refuse();
        } else if (spec.topology.kind !== 'independent-advisory') refuse();
        const sessionCapability =
          stationControlRequestAuthority(context.req.raw)?.kind === 'caller'
            ? await this.owners.sources.captureStationControlCredentialAuthority(
                context,
                { groupId: spec.groupId, workItemId: entry.taskId },
                sealed.capability,
                entry.agentId,
              )
            : undefined;
        const selected = await this.#credentials.captureAgentSdkCredential(
          context.req.raw,
          entry.agentId,
          sessionCapability,
        );
        if (
          selected.provider !== entry.provider ||
          selected.modelId !== entry.modelId ||
          `sha256:${createHash('sha256').update(selected.instructions).digest('hex')}` !==
            entry.instructionsDigest
        )
          refuse();
        const qualification =
          typeof this.owners.qualification === 'function'
            ? await this.owners.qualification(selected.provider)
            : this.owners.qualification;
        qualification.assertCurrent();
        qualification.assertSelection(selected.provider, selected.modelId);
        const owner = createPreparedSdkSourceWireOwner({
          outputDelivery: 'streamed',
          provider: selected.provider,
          modelId: selected.modelId,
          credential: selected.credential,
          preparation: qualification,
          brief: entry.brief,
          instructions: selected.instructions,
          maxOutputTokens: requested.maxOutputTokens,
          remaining: { ...intent.budget, currency: 'USD' },
          now: Date.now,
          signal: context.req.raw.signal,
          rawFetch: this.owners.rawFetch,
        });
        const prepared = await this.owners.sources.prepareSdkSnapshot(
          context,
          { groupId: spec.groupId, workItemId: entry.taskId },
          sealed.capability,
          owner,
        );
        const captured = inspectSdkSourceWire(owner, prepared.sdkHandle);
        const observedRuntime = reference(
          'station.sealed-sdk.runtime.v1',
          entry.seatId,
          {
            agentId: selected.agentId,
            provider: selected.provider,
            modelId: selected.modelId,
            wireDigest: captured.wireDigest,
            contract: captured.contract,
            source: captured.sourceBinding.source,
          },
        );
        const observedModel = reference(
          'station.provider-public-contract.v1',
          captured.contract.id,
          captured.contract,
        );
        if (
          captured.sourceBinding.request !== context.req.raw ||
          captured.sourceBinding.principalId !== principal.id ||
          captured.sourceBinding.hostContextId !== root.issuer_host_id ||
          captured.sourceBinding.expiresAtMs < intent.deadlineAt ||
          canonicalJson(captured.sourceBinding.source) !==
            canonicalJson(grant.source) ||
          canonicalJson(observedRuntime) !==
            canonicalJson(grant.runtime.runtime_receipt_ref) ||
          canonicalJson(observedModel) !==
            canonicalJson(grant.runtime.model_receipt_ref) ||
          canonicalJson(envelope.execution_binding) !==
            canonicalJson({
              runtime: grant.runtime,
              source: grant.source,
              flow_binding: grant.flow_binding,
            }) ||
          !qualification.read(captured.contract.id)
        )
          refuse();
        members.push({
          ...entry,
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
      const parent = envelopes.find((value) => value.parent === null);
      if (!parent) refuse();
      for (const envelope of envelopes.filter((value) => value.parent !== null))
        validateDelegationAncestryV2(
          root,
          [parent, envelope],
          new Date(Date.now()).toISOString(),
        );
      const handle: PreparedPortableGroup = Object.freeze({ [brand]: true });
      this.#states.set(handle, {
        intent,
        root,
        envelopes,
        spec,
        members,
        request: context.req.raw,
        deadlineAt: intent.deadlineAt,
        closed: false,
      });
      this.#state(handle, context.req.raw);
      return handle;
    } catch (error) {
      if (pendingSnapshot) this.owners.sources.releaseSnapshot(pendingSnapshot);
      for (const member of members)
        this.owners.sources.releaseSnapshot(member.snapshot);
      throw error;
    }
  }

  flow(
    handle: PreparedPortableGroup,
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
    handle: PreparedPortableGroup,
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
   * the independently persisted V2 reservation at the final wire fence. */
  async dispatch(
    handle: PreparedPortableGroup,
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
    const state = this.#state(handle, context.req.raw);
    const member = state.members.find((m) => m.seatId === seatId);
    const seat = state.spec.seats.find((s) => s.seatId === seatId);
    if (!member || !seat || member.dispatched) refuse();
    if (member.flow) {
      if (
        attempt.transport.launch.protocol === 'rounds-v1' ||
        !attempt.transport.reservation.flowClaim
      )
        refuse();
      attempt.transport.launch.flow = member.flow;
    } else if (attempt.transport.reservation.flowClaim) refuse();
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
      attempt.transport.launch.protocol === 'rounds-v1' ||
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
    if (principal.id !== state.root.authenticated_principal_ref.id) refuse();
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
    finalizeCurrent();
    const admission = new FinalFetchLaunchFence({
      ...attempt.transport.launch,
      finalizeCurrent,
    });
    // Reserve the handoff before any await; an ambiguous failure cannot resend it.
    member.dispatched = true;
    await admission.admitTask(
      {
        ...attempt.transport.reservation,
        expectedWireDigest: captured.wireDigest,
      },
      signal,
    );
    finalizeCurrent();
    const inputRuntime = undefined;
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
    const postDispatchWriter = await HomeWriterOwner.forHome(
      this.owners.runtime.environmentSecurityService.getProjectHomeDir(),
    );
    const requestDelegation = this.#requestAuthorities.get(
      context.req.raw,
    )?.delegation;
    const caller = stationControlRequestAuthority(context.req.raw);
    const launchTask = () =>
      delegateTask(
        {
          reservedStationTurn: port,
          delegationAttemptClaimStore: this.owners.delegationAttemptClaimStore,
          ...(caller?.kind === 'caller'
            ? { createRequestCallerSessionId: caller.caller.sessionId }
            : {}),
          ...(requestDelegation
            ? {
                ownerAttribution: 'verified-bound' as const,
                delegation: requestDelegation.context,
                delegationProvenance: requestDelegation.provenance,
              }
            : {}),
          delegationGroupAdmission: { assertCurrent: finalizeCurrent, signal },
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
    let task: Awaited<ReturnType<typeof delegateTask>>;
    if (caller?.kind === 'caller') {
      const token = context.req.raw.headers.get(
        STATION_CONTROL_CALLER_TOKEN_HEADER,
      );
      if (!token || !requestDelegation) refuse();
      const stillCurrent = () => {
        try {
          finalizeCurrent();
          return stationControlRequestAuthority(context.req.raw) === caller;
        } catch {
          return false;
        }
      };
      task = await withStationControlCallerBinding(
        createHash('sha256').update(token).digest('base64url'),
        () =>
          withStationControlCallerContext(
            { token, resolve: () => (stillCurrent() ? caller.caller : null) },
            launchTask,
          ),
        stillCurrent,
      );
    } else task = await launchTask();
    await postDispatchWriter.runRequest(signal, finalizeCurrent);
    if (
      task.taskId !== member.taskId ||
      task.sessionId !== member.taskId ||
      !task.initialTurnId
    )
      refuse();
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

  async closeInputs(handle: PreparedPortableGroup): Promise<void> {
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

  close(handle: PreparedPortableGroup): void {
    const state = this.#states.get(handle);
    if (!state || state.closed) return;
    state.closed = true;
    const operation = this.#operations.get(state.spec.groupId);
    if (operation?.request === state.request)
      this.#operations.delete(state.spec.groupId);
    for (const member of state.members)
      this.owners.sources.releaseSnapshot(member.snapshot);
  }
}
