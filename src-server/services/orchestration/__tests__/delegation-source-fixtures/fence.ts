import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileAuthorizationLedger } from '@kontourai/dispatch';
import type { RootAuthorityV2 } from '@kontourai/flow-agents/delegation-authority-contract';
import { createDelegationAuthorityService } from '@kontourai/flow-agents/delegation-authority-service';
import { createDelegationAuthorityServiceV3 } from '@kontourai/flow-agents/delegation-authority-service-v3';
import type { DelegationRetainedAccountingV1 } from '@kontourai/flow-agents/delegation-dispatch';
import type { DelegationEnvelopeV2 } from '@kontourai/flow-agents/delegation-envelope-v2';
import {
  delegationEnvelopeDigestV2,
  rootAuthorityReferenceV2,
} from '@kontourai/flow-agents/delegation-envelope-v2';
import {
  createDelegationRoundsController,
  type DelegationRoundsSpec,
} from '@kontourai/flow-agents/delegation-group-rounds';
import type { DelegationGroupSpecV2 } from '@kontourai/flow-agents/delegation-group-v2';
import { createDelegationGroupControllerAccountingV1 } from '@kontourai/flow-agents/delegation-group-v2';
import {
  canonicalJson,
  type ModelInvocationResult,
  type ModelRuntime,
} from '@kontourai/relay';
import { afterEach, vi } from 'vitest';
import { createGateTestRegistry } from '../../../../__test-utils__/orchestration-gate-test-harness.js';
import { StationAgentAdapter } from '../../../../providers/adapters/station-agent-adapter.js';
import type {
  BoundedApiProvider,
  ResolvedBoundedApiProviderContract,
} from '../../../../runtime/conversation/bounded-api-provider-contract.js';
import type { ReservedProviderEvidence } from '../../../../runtime/conversation/reserved-provider-fetch.js';
import { runReservedSdkSourceAttempt } from '../../../../runtime/conversation/reserved-sdk-source-attempt.js';
import {
  prepareReservedStationTurn,
  type ReservedStationInputRuntime,
  reservedStationRecipient,
  reservedStationTurnResult,
} from '../../../../runtime/conversation/reserved-station-turn.js';
import { runtimeRequestPrincipalMayAccessHttpRoute } from '../../../../security/runtime-request-security.js';
import {
  type DelegatedTaskHandle,
  observeDelegatedTask,
} from '../../../../tools/station-control-delegation.js';
import { ApprovalRegistry } from '../../../approvals/approval-registry.js';
import {
  FinalFetchLaunchFence,
  type FinalWire,
  type ReservedWireBinding,
  RoundsFinalFetchLaunchFence,
  type RoundsFinalFetchOwners,
} from '../../delegation-group-launch-fence.js';
import { StationDelegationPersistence } from '../../delegation-group-persistence.js';
import {
  deliverSdkResponse,
  enterFinalFetch,
  sdkResultPromise,
} from '../../delegation-group-sdk-source-wire-owner.js';
import {
  FileFinalWireIntentStore,
  wireIdentityDigest,
} from '../../delegation-group-wire-intent-store.js';
import { EventBus } from '../../event-bus.js';
import { EventStore } from '../../event-store.js';
import { OrchestrationService } from '../../orchestration-service.js';
import { createSessionAgentResolver } from '../../session-agent-resolution.js';
import type {
  PreparedStationReportGroup,
  StationReportGroupPreparation,
} from '../../station-report-group-preparation.js';
import type { fixture } from './source.js';

const adapterCleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of adapterCleanup.splice(0).reverse()) await close();
});

const ref = (id: string) => ({
  id,
  domain: 'synthetic.fixture.no-activation',
  digest: `sha256:${createHash('sha256').update(id).digest('hex')}`,
});
/** Synthetic group/qualification records are test setup; the source auth owner is real. */
export async function publicFenceFixture(
  f: Awaited<ReturnType<typeof fixture>>,
  source: RootAuthorityV2['execution_grants'][number]['source'],
  sdkOwner: object,
  handle: object,
  wire: FinalWire,
  beforeInner: () => void = () => {},
  observation?: {
    protocol?: 'legacy' | 'rounds';
    principalId?: string;
    reportHome?: RoundsFinalFetchOwners['reportHome'];
    inputRuntime?: ReservedStationInputRuntime;
    allowedTools?: string[];
    invocationSignal?: AbortSignal;
    maxAttempts?: number;
    preparedGroup?: {
      owner: StationReportGroupPreparation;
      handle: PreparedStationReportGroup;
    };
    modelId?: string;
    allocation?: {
      inputTokens: number;
      outputTokens: number;
      costMicros: number;
    };
    provider: BoundedApiProvider;
    contract: ResolvedBoundedApiProviderContract;
    now(): number;
  },
) {
  const issued = observation?.preparedGroup;
  const actual = issued?.owner.read(issued.handle, f.req);
  const initial = actual?.members[0];
  const brief = initial?.brief ?? 'inspect exactly this source';
  const principalId =
    actual?.root.authenticated_principal_ref.id ??
    observation?.principalId ??
    'fixture-owner';
  const clientTurnId = initial?.clientTurnId ?? 'reserved-client-turn';
  const current = () =>
    f.environment.withCurrentAuthority(() =>
      runtimeRequestPrincipalMayAccessHttpRoute(f.req, f.environment, {
        method: 'POST',
        path: '/api/orchestration/chat',
      }),
    );
  const finalize = (): undefined =>
    f.environment.withCurrentAuthority(() => {
      if (!current()) throw Error('actual-local-grant-revoked');
      if (issued) issued.owner.read(issued.handle, f.req);
      return undefined;
    });
  const reportRoot = join(f.home, 'report-groups');
  mkdirSync(reportRoot, { mode: 0o700, recursive: true });
  const persistence = new StationDelegationPersistence(reportRoot);
  const modelId = observation?.modelId ?? 'fixture-model';
  const allocation = observation?.allocation ?? {
    inputTokens: 1000,
    outputTokens: 1000,
    costMicros: 100000,
  };
  const attemptLimit = observation?.maxAttempts ?? 1;
  const authority = {
    allowed_tools: observation?.allowedTools ?? [],
    allowed_effects: ['report'],
    readable_resources: [],
    mutable_resources: [],
    posture: 'report-only' as const,
    approval: 'automatic' as const,
    escalation: 'deny' as const,
  };
  const budget = {
    remaining_depth: 0,
    max_total_children: 1,
    max_total_envelopes: 1,
    max_concurrent_children: 1,
    max_runtime_ms: 60000,
    max_input_tokens: allocation.inputTokens * attemptLimit,
    max_output_tokens: allocation.outputTokens * attemptLimit,
    max_cost_micros: allocation.costMicros * attemptLimit,
    max_attempts: attemptLimit,
    expires_at: '2099-01-01T00:00:00.000Z',
  };
  const actualEnvelope = actual?.envelopes.find(
    (e) => e.execution_id === initial?.taskId,
  );
  const execution = actualEnvelope?.execution_binding ?? {
    runtime: {
      runtime_receipt_ref: ref('runtime'),
      model_receipt_ref: ref('model'),
      required_capabilities: [],
    },
    source,
    flow_binding: {
      status: 'unbound' as const,
      reason: 'synthetic-independent-advisory',
    },
  };
  const root: RootAuthorityV2 = actual?.root ?? {
    schema_version: '2.0',
    authority_id: 'authority',
    authority_epoch: 1,
    issuer_host_id: 'synthetic-host',
    authenticated_principal_ref: ref('principal'),
    authenticated_subject_ref: ref('subject'),
    source_origin: {
      repository_id: source.repository_id,
      worktree_id: source.execution_worktree_id,
      source_state_id: source.source_state_id,
      dirty_state_fingerprint: null,
    },
    execution_worktree_ids: [source.execution_worktree_id],
    execution_grants: [
      { ...execution, grant_id: 'grant', authority_ceiling: authority },
    ],
    delegation_ceiling: authority,
    budget,
    revisions: {
      policy: ref('policy'),
      prompt: ref('prompt'),
      rubric: ref('rubric'),
    },
    root_trace: { trace_id: 'trace', span_id: 'span' },
    root_cancellation_ref: ref('cancel'),
  };
  const envelope: DelegationEnvelopeV2 = actualEnvelope ?? {
    schema_version: '2.0',
    envelope_id: 'envelope',
    generation: 0,
    parent: null,
    root_authority_ref: rootAuthorityReferenceV2(root),
    execution_id: 'execution',
    actor: root.authenticated_principal_ref,
    assignment_subject: root.authenticated_subject_ref,
    trace_id: 'trace',
    span_id: 'span',
    parent_span_id: null,
    selected_grant_id: 'grant',
    remaining_allowed_grant_ids: [],
    execution_binding: execution,
    delegation_ceiling: authority,
    execution_authority: authority,
    budget,
    continuation_ref: ref('continuation'),
    cancellation_ref: root.root_cancellation_ref,
  };
  const spec: DelegationGroupSpecV2 = actual
    ? {
        ...actual.spec,
        schemaVersion: '2.0',
        policy: {
          reference: actual.spec.policy.reference,
          maxConcurrent: actual.spec.policy.maxConcurrent,
        },
        seats: actual.spec.seats.map((seat) => ({ ...seat, stepId: null })),
      }
    : {
        schemaVersion: '2.0',
        groupId: 'group',
        rootAuthorityRef: rootAuthorityReferenceV2(root),
        controller: { id: 'controller', generation: 1 },
        policy: { reference: root.revisions.policy, maxConcurrent: 1 },
        topology: { kind: 'independent-advisory' },
        seats: [
          {
            seatId: 'seat',
            envelope: {
              id: envelope.envelope_id,
              generation: 0,
              digest: delegationEnvelopeDigestV2(envelope),
            },
            stepId: null,
            effect: 'report',
            allocation,
          },
        ],
      };
  const host = {
    now: () =>
      actual ? new Date(Date.now()).toISOString() : '2026-10-21T00:00:00.000Z',
    authorize: async (
      _action: unknown,
      candidateRoot: RootAuthorityV2,
      candidateEnvelope: DelegationEnvelopeV2 | null,
    ) =>
      current() &&
      (!issued ||
        issued.owner.authorizes(
          issued.handle,
          f.req,
          candidateRoot,
          candidateEnvelope,
        )),
    confirmExecution: async (e: DelegationEnvelopeV2) =>
      current() &&
      (issued
        ? issued.owner.confirmsExecution(issued.handle, f.req, e)
        : canonicalJson(e.execution_binding) === canonicalJson(execution)),
    confirmReconciliation: async () => current(),
  };
  let intentCount = 0;
  let invocationFailure: unknown;
  class Intents extends FileFinalWireIntentStore {
    override async consume(
      ...args: Parameters<FileFinalWireIntentStore['consume']>
    ) {
      await super.consume(...args);
      intentCount++;
      beforeInner();
    }
  }
  const intents = new Intents(f.root);
  const inner: typeof fetch = (input, init) =>
    enterFinalFetch(sdkOwner, handle, input, init);
  const roundsFence =
    observation?.protocol === 'rounds'
      ? new RoundsFinalFetchLaunchFence({
          protocol: 'rounds-v1',
          groups: persistence.roundsStore(finalize),
          authorities: persistence.roundsAuthorityStore(finalize),
          host,
          intents,
          finalizeCurrent: finalize,
          fetch: inner,
        })
      : undefined;
  const legacyFence = !roundsFence
    ? new FinalFetchLaunchFence({
        groups: persistence.groupStore(finalize),
        authorities: persistence.authorityStore(finalize),
        host,
        intents,
        finalizeCurrent: finalize,
        fetch: inner,
      })
    : undefined;
  const service = roundsFence
    ? createDelegationAuthorityServiceV3(
        roundsFence.authorities,
        { ...host, authenticateRenewal: async () => null },
        { maxRenewals: 0 },
      )
    : createDelegationAuthorityService(legacyFence!.authorities, host);
  await service.issue(root);
  for (const preparedEnvelope of actual?.envelopes ?? [envelope])
    await service.derive(root.authority_id, preparedEnvelope);
  const invocation = new AsyncLocalStorage<string>();
  const observed: ReservedProviderEvidence[] = [];
  const accounting = new Map<string, DelegationRetainedAccountingV1>();
  const evidenceDirectory = join(reportRoot, 'station-provider-evidence');
  const sessionId = initial?.taskId ?? 'reserved-sdk-session';
  const eventStore = observation
    ? new EventStore(join(f.root, 'reserved-events.sqlite'))
    : undefined;
  let relayCalls = 0;
  const bus = new EventBus();
  const logger = { debug() {}, warn() {}, info() {} };
  const adapter = observation
    ? new StationAgentAdapter({
        apiBase: 'http://127.0.0.1:43979',
        hasAgent: () => true,
        eventBus: bus,
        approvalRegistry: new ApprovalRegistry(logger, { eventBus: bus }),
        fetch: async () => {
          relayCalls++;
          throw Error('reserved turn must not relay through /chat');
        },
      })
    : undefined;
  const orchestration =
    adapter && eventStore
      ? new OrchestrationService({
          adapterRegistry: createGateTestRegistry(adapter),
          eventBus: bus,
          eventStore,
          logger,
          resolveSessionAgent: createSessionAgentResolver({
            loadAgentSpec: async () =>
              actual && initial
                ? f.loader.loadAgent(initial.agentId)
                : {
                    name: 'Reserved reviewer',
                    prompt: 'Report only',
                  },
            resolveToolServer: async () => null,
            resolveSkillDir: async () => null,
          }),
        })
      : undefined;
  if (orchestration && eventStore)
    adapterCleanup.push(async () => {
      await orchestration.shutdown();
      eventStore.close();
    });
  let acceptedTask: DelegatedTaskHandle | undefined;
  let repeatTaskDispatch: (() => Promise<unknown>) | undefined;
  let reservedResult:
    | (() => ReturnType<typeof reservedStationTurnResult>)
    | undefined;
  let recipient:
    | (() => ReturnType<typeof reservedStationRecipient>)
    | undefined;
  let currentSdk: {
    sdkOwner: object;
    handle: object;
    wire: FinalWire;
    brief: string;
    clientTurnId: string;
    contract?: ResolvedBoundedApiProviderContract;
    authorityEpoch?: number;
  } = {
    sdkOwner,
    handle,
    wire,
    brief,
    clientTurnId,
    contract: observation?.contract,
  };
  let sessionStarted = false;
  const turnIds = new Map<string, string>();
  let nextPending = false;
  let repeatAttempt:
    | (() => ReturnType<typeof runReservedSdkSourceAttempt>)
    | undefined;
  const model: ModelRuntime = {
    id: 'installed-sdk-sealed-fixture',
    capabilities: () => ({
      structuredTools: !!observation?.allowedTools?.length,
      streaming: false,
      abort: true,
      usage: true,
      outputTokenLimitFidelity: 'native',
    }),
    invoke: async () => {
      const id = invocation.getStore();
      if (!id) throw Error('actual-invocation-missing');
      const seat = spec.seats[0];
      if (!seat) throw Error('fixture-seat-missing');
      const { sdkOwner, handle, wire, brief, clientTurnId } = currentSdk;
      const binding: ReservedWireBinding = {
        groupId: spec.groupId,
        controller: spec.controller,
        seatId: seat.seatId,
        authority:
          currentSdk.authorityEpoch === undefined
            ? spec.rootAuthorityRef
            : {
                ...spec.rootAuthorityRef,
                authority_epoch: currentSdk.authorityEpoch,
              },
        envelope: seat.envelope,
        invocationId: id,
        effect: seat.effect,
        allocation: seat.allocation,
        expectedWireDigest: wireIdentityDigest(wire),
      };
      let result: Awaited<ReturnType<typeof sdkResultPromise>>;
      let retainedAccounting: DelegationRetainedAccountingV1 | undefined;
      if (observation) {
        const attemptInput: Parameters<typeof runReservedSdkSourceAttempt>[0] =
          {
            sdkOwner,
            sdkHandle: handle,
            persistence,
            transport: {
              launch: roundsFence
                ? {
                    protocol: 'rounds-v1',
                    reportHome: observation.reportHome,
                    groups: persistence.roundsStore(finalize),
                    authorities: persistence.roundsAuthorityStore(finalize),
                    host,
                    intents,
                    finalizeCurrent: finalize,
                  }
                : {
                    groups: persistence.groupStore(finalize),
                    authorities: persistence.authorityStore(finalize),
                    host,
                    intents,
                    finalizeCurrent: finalize,
                  },
              reservation: binding,
              contract: currentSdk.contract ?? observation.contract,
              provider: observation.provider,
              now: observation.now,
              signal:
                observation.invocationSignal ?? new AbortController().signal,
              maxResponseBytes: 1024 * 1024,
            },
          };
        repeatAttempt = () => runReservedSdkSourceAttempt(attemptInput);
        if (!orchestration || !eventStore)
          throw Error('real orchestration missing');
        let attempt: Awaited<ReturnType<typeof reservedStationTurnResult>>;
        if (issued) {
          repeatTaskDispatch = () =>
            issued.owner.dispatch(
              issued.handle,
              f.context(),
              seat.seatId,
              attemptInput,
              orchestration,
            );
          const dispatched = await issued.owner.dispatch(
            issued.handle,
            f.context(),
            seat.seatId,
            attemptInput,
            orchestration,
          );
          acceptedTask = dispatched.task;
          if (dispatched.task.initialTurnId)
            turnIds.set(id, dispatched.task.initialTurnId);
          recipient = dispatched.recipient;
          reservedResult = () => dispatched.result;
          attempt = await dispatched.result;
        } else {
          const port = prepareReservedStationTurn(
            {
              principalId,
              environmentId: f.record.environmentId,
              threadId: sessionId,
              clientTurnId,
              input: brief,
              modelId,
            },
            attemptInput,
            sessionStarted
              ? orchestration.captureReservedStationSession(sessionId, {
                  userId: principalId,
                })
              : undefined,
            observation.inputRuntime,
          );
          reservedResult = () => reservedStationTurnResult(port);
          if (!sessionStarted) {
            const started = await orchestration.startSessionInternal(
              {
                type: 'start-session',
                input: {
                  threadId: sessionId,
                  provider: 'station-agent',
                  modelId,
                  metadata: { agentId: 'reviewer', userId: principalId },
                },
              },
              { userId: principalId },
              { reservedStationTurn: port },
            );
            if (started.status !== 'accepted')
              throw Error('reserved session not admitted');
            sessionStarted = true;
          }
          const sent = await orchestration.dispatchWithReceipt(
            {
              type: 'sendTurn',
              input: {
                threadId: sessionId,
                clientTurnId,
                input: brief,
                modelId,
              },
            },
            { userId: principalId },
            { reservedStationTurn: port },
          );
          if (
            !sent.result ||
            !('turnId' in sent.result) ||
            typeof sent.result.turnId !== 'string'
          )
            throw Error('reserved turn identity missing');
          turnIds.set(id, sent.result.turnId);
          attempt = await reservedStationTurnResult(port);
        }

        await vi.waitFor(
          () => {
            if (
              !eventStore
                .listEvents(sessionId)
                .some(
                  (event) =>
                    event.payload.method === 'turn.completed' &&
                    event.payload.turnId === turnIds.get(id),
                )
            )
              throw Error('reserved completion not persisted');
          },
          { timeout: 10000 },
        );
        observed.push(attempt.evidence);
        retainedAccounting = attempt.accounting;
        result = attempt.sdkResult;
      } else {
        if (!legacyFence) throw Error('legacy fixture missing');
        const begun = await legacyFence.start(
          binding,
          wire,
          new AbortController().signal,
        );
        deliverSdkResponse(sdkOwner, handle, await begun.response);
        result = await sdkResultPromise(sdkOwner, handle);
      }
      const invocationResult: ModelInvocationResult = {
        provider: 'synthetic-no-billable-http',
        model: modelId,
        modelSource: 'provider-reported',
        outputText: result.text,
        toolCalls: [],
        usage: {
          inputTokens: 4,
          outputTokens: 2,
          totalTokens: 6,
          ...(observation ? {} : { costUsd: 0 }),
        },
        latencyMs: 0,
      };
      if (retainedAccounting) accounting.set(id, retainedAccounting);
      return invocationResult;
    },
  };
  mkdirSync(join(f.root, 'dispatch'), { mode: 0o700 });
  const legacyController = legacyFence
    ? createDelegationGroupControllerAccountingV1({
        store: legacyFence.groups,
        authorityService: service,
        dispatchLedger: new FileAuthorizationLedger({
          root: join(f.root, 'dispatch'),
        }),
        host: {
          authorize: async () => (current() ? ref('caller') : null),
          executionHost: () => ({
            accountingProtocol: 'retained-tariff-v1',
            resolveRuntime: async () => ({
              runtime: model,
              runtimeReceipt: execution.runtime.runtime_receipt_ref,
              modelReceipt: execution.runtime.model_receipt_ref,
            }),
            invokeFenced: async (_e, id, invoke) => invocation.run(id, invoke),
            retainFailure: async (error) => {
              invocationFailure = error;
            },
            retainResult: async (_result, _envelope, invocationId) =>
              observation ? (accounting.get(invocationId) ?? null) : undefined,
            recordScheduleEvent: async () => {
              throw Error('not Flow');
            },
            confirmClaim: async () => {
              throw Error('not Flow');
            },
            prepareRequest: async () => {
              throw Error('not Flow');
            },
            recordMemberOutcome: async () => {
              throw Error('not Flow');
            },
          }),
          prepareIndependentRequest: async () => ({
            messages: [{ role: 'user', content: 'synthetic driver only' }],
            maxOutputTokens: 10,
          }),
          retainMemberOutcome: async () => ({
            outcomeRef: ref('result'),
            dissentRefs: [],
            uncertaintyRefs: [],
          }),
          retainRunObservation: async () => ref('observed'),
          retainRunFailure: async () => ref('failed'),
          requestDescendantCancellation: async () => ref('cancel-request'),
          confirmDescendantCancellation: async () => ref('cancel-observed'),
        },
      })
    : undefined;
  const roundsSpec: DelegationRoundsSpec = actual?.spec ?? {
    ...spec,
    schemaVersion: '1.0',
    policy: {
      ...spec.policy,
      maxRounds: attemptLimit,
      maxAttempts: attemptLimit,
    },
    seats: spec.seats.map(({ stepId: _stepId, ...seat }) => seat),
  };
  const roundsController = roundsFence
    ? createDelegationRoundsController({
        store: roundsFence.groups,
        authorityService: service,
        dispatchLedger: new FileAuthorizationLedger({
          root: join(f.root, 'dispatch'),
        }),
        host: {
          accountingProtocol: 'retained-tariff-v1',
          authorize: async () => (current() ? ref('caller') : null),
          executionHost: () => ({
            resolveRuntime: async () => ({
              runtime: model,
              runtimeReceipt: execution.runtime.runtime_receipt_ref,
              modelReceipt: execution.runtime.model_receipt_ref,
            }),
            invokeFenced: async (_e, id, invoke) => invocation.run(id, invoke),
            retainFailure: async (error) => {
              invocationFailure = error;
            },
            retainResult: async (_result, _envelope, id) =>
              accounting.get(id) ?? null,
          }),
          prepareRequest: async () => ({
            messages: [{ role: 'user', content: 'synthetic driver only' }],
            maxOutputTokens: 10,
          }),
          retainObservation: async () => ref('result'),
          confirmTerminal: async (_spec, attempt) => {
            if (!observation?.maxAttempts || !eventStore) return null;
            const turnId = turnIds.get(attempt.invocationId);
            const terminal = eventStore
              .listEvents(sessionId)
              .find(
                (event) =>
                  event.payload.method === 'turn.completed' &&
                  event.payload.turnId === turnId,
              );
            return terminal
              ? {
                  id: terminal.payload.eventId,
                  domain: 'fixture.canonical-turn-terminal',
                  digest: `sha256:${createHash('sha256').update(canonicalJson(terminal.payload)).digest('hex')}`,
                }
              : null;
          },
          requestDescendantCancellation: async () => ref('cancel-request'),
        },
      })
    : undefined;
  const controller = roundsController ?? legacyController;
  if (!controller) throw Error('fixture controller missing');
  await controller.create({
    kind: 'create',
    groupId: spec.groupId,
    operationKey: 'create',
    expectedRevision: 0,
    controller: spec.controller,
    spec: roundsController ? roundsSpec : spec,
  });
  return {
    observed,
    eventBus: bus,
    get task() {
      return acceptedTask;
    },
    repeatTaskDispatch: () => {
      if (!repeatTaskDispatch) throw Error('canonical task not dispatched');
      return repeatTaskDispatch();
    },
    get orchestration() {
      if (!orchestration) throw Error('actual orchestration missing');
      return orchestration;
    },
    taskSnapshot: () => {
      if (!orchestration) throw Error('actual orchestration missing');
      return observeDelegatedTask(
        { taskId: sessionId, userId: principalId },
        orchestration,
      );
    },
    get invocationFailure() {
      return invocationFailure;
    },
    canonicalEvents: () =>
      eventStore?.listEvents(sessionId).map((event) => event.payload) ?? [],
    get relayCalls() {
      return relayCalls;
    },
    sendAfterAdapterRecoveryWithoutReservation: async () => {
      if (!eventStore) throw Error('real event store missing');
      const stored = eventStore.readSessionByThread(sessionId);
      if (!stored?.resumeCursor)
        throw Error('persisted reserved cursor missing');
      const recovery = new StationAgentAdapter({
        apiBase: 'http://127.0.0.1:43979',
        hasAgent: () => true,
        eventBus: bus,
        approvalRegistry: new ApprovalRegistry(logger, { eventBus: bus }),
        fetch: async () => {
          relayCalls++;
          throw Error('recovered reserved session must not relay');
        },
      });
      await recovery.startSession({
        provider: 'station-agent',
        threadId: sessionId,
        modelId,
        resumeCursor: JSON.parse(JSON.stringify(stored.resumeCursor)),
      });
      try {
        return await recovery.sendTurn({
          threadId: sessionId,
          input: 'unreserved recovery request',
          clientTurnId: 'unreserved-recovery',
        });
      } finally {
        await recovery.stopSession(sessionId);
      }
    },
    interrupt: () => {
      if (!orchestration) throw Error('real orchestration missing');
      return orchestration.dispatchWithReceipt(
        { type: 'interruptTurn', threadId: sessionId },
        { userId: principalId },
      );
    },
    sendWithoutReservation: () => {
      if (!orchestration) throw Error('real orchestration missing');
      return orchestration.dispatchWithReceipt(
        {
          type: 'sendTurn',
          input: {
            threadId: sessionId,
            clientTurnId: 'unreserved-client-turn',
            input: 'unreserved request',
            modelId,
          },
        },
        { userId: principalId },
      );
    },
    sendWithForgedReservation: () => {
      if (!orchestration) throw Error('real orchestration missing');
      return Reflect.apply(orchestration.dispatchWithReceipt, orchestration, [
        {
          type: 'sendTurn',
          input: {
            threadId: sessionId,
            clientTurnId: 'forged-client-turn',
            input: brief,
            modelId,
          },
        },
        { userId: principalId },
        { reservedStationTurn: JSON.parse('{}') },
      ]);
    },
    recipient: () => {
      if (!recipient) throw Error('reserved recipient missing');
      return recipient();
    },
    readReservedResult: () => {
      if (!reservedResult) throw Error('reserved result missing');
      return reservedResult();
    },
    evidenceDirectory,
    retainedReference: () => {
      const files = readdirSync(evidenceDirectory).filter((file) =>
        file.endsWith('.json'),
      );
      if (files.length !== 1)
        throw Error('expected one retained evidence record');
      const record = JSON.parse(
        readFileSync(join(evidenceDirectory, files[0]), 'utf8'),
      );
      return {
        id: files[0].slice(0, -5),
        domain: 'station.provider-evidence',
        digest: `sha256:${createHash('sha256').update(canonicalJson(record)).digest('hex')}`,
      };
    },
    retainedEvidence: () => {
      const files = readdirSync(evidenceDirectory).filter((file) =>
        file.endsWith('.json'),
      );
      if (files.length !== 1)
        throw Error('expected one retained evidence record');
      return JSON.parse(readFileSync(join(evidenceDirectory, files[0]), 'utf8'))
        .evidence;
    },
    retainAgain: (evidence: ReservedProviderEvidence) =>
      persistence.retainProviderEvidence(evidence, finalize),
    blockEvidencePublication: () =>
      writeFileSync(evidenceDirectory, 'blocked', { mode: 0o600 }),
    repeatAttempt: () => {
      if (!repeatAttempt) throw Error('source attempt not started');
      return repeatAttempt();
    },
    authorizeInput: async (envelopeId: string) =>
      (await service.admitEffect(root.authority_id, envelopeId, 'report'))
        .envelope,
    ledger: () => service.inspect(root.authority_id),
    reserveAnother: () =>
      service.reserveInvocation(
        root.authority_id,
        envelope.envelope_id,
        'another-physical-attempt',
        spec.seats[0].allocation,
      ),
    run: () =>
      roundsController
        ? roundsController.release({
            kind: 'release',
            groupId: spec.groupId,
            operationKey: 'run',
            expectedRevision: 1,
            controller: spec.controller,
            checkpoint: ref('checkpoint'),
            seats: [
              { seatId: spec.seats[0].seatId, previousInvocationId: null },
            ],
          })
        : legacyController!.run({
            kind: 'run',
            groupId: spec.groupId,
            operationKey: 'run',
            expectedRevision: 1,
            controller: spec.controller,
          }),
    runNext: async (next: typeof currentSdk) => {
      if (!roundsController || !observation?.maxAttempts || nextPending)
        throw Error('owned next-round fixture unavailable');
      nextPending = true;
      try {
        const before = await roundsController.get(spec.groupId);
        const previous = before.attempts.at(-1);
        if (!previous || !turnIds.has(previous.invocationId))
          throw Error('previous actual turn missing');
        await roundsController.recordTerminal({
          kind: 'terminal',
          groupId: spec.groupId,
          operationKey: `terminal:${previous.invocationId}`,
          expectedRevision: before.revision,
          controller: spec.controller,
          invocationId: previous.invocationId,
        });
        const ready = await roundsController.get(spec.groupId);
        currentSdk = next;
        return await roundsController.release({
          kind: 'release',
          groupId: spec.groupId,
          operationKey: `next:${next.clientTurnId}`,
          expectedRevision: ready.revision,
          controller: spec.controller,
          checkpoint: ref(`checkpoint:${next.clientTurnId}`),
          seats: [
            {
              seatId: spec.seats[0].seatId,
              previousInvocationId: previous.invocationId,
            },
          ],
        });
      } finally {
        nextPending = false;
      }
    },
    get intentCount() {
      return intentCount;
    },
  };
}
