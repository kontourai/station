import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileAuthorizationLedger } from '@kontourai/dispatch';
import {
  claimReadyStep,
  type FlowDurableStepClaim,
  flowRunHead,
  loadRun,
  pauseRun,
  startRun,
} from '@kontourai/flow';
import type {
  DelegationExecutionBindingV2,
  RootAuthorityV2,
} from '@kontourai/flow-agents/delegation-authority-contract';
import { createDelegationAuthorityService } from '@kontourai/flow-agents/delegation-authority-service';
import { createDelegationAuthorityServiceV3 } from '@kontourai/flow-agents/delegation-authority-service-v3';
import {
  type DelegationEnvelopeV2,
  delegationEnvelopeDigestV2,
  rootAuthorityReferenceV2,
} from '@kontourai/flow-agents/delegation-envelope-v2';
import {
  createDelegationRoundsController,
  type DelegationRoundsExecutionHost,
  type DelegationRoundsJournal,
  type DelegationRoundsSpec,
} from '@kontourai/flow-agents/delegation-group-rounds';
import {
  createDelegationGroupControllerV2,
  type DelegationGroupSpecV2,
} from '@kontourai/flow-agents/delegation-group-v2';
import {
  canonicalJson,
  type ModelInvocationResult,
  type ModelRuntime,
} from '@kontourai/relay';
import { afterEach, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { HomeWriterOwner } from '../../ssh/home-writer-owner.js';
import {
  FinalFetchLaunchFence,
  type FinalWire,
  type ReservedWireBinding,
  RoundsFinalFetchLaunchFence,
  snapshotFinalWire,
} from '../delegation-group-launch-fence.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import type { SourceFlowLaunchOwner } from '../delegation-group-source-admission.js';
import {
  FileFinalWireIntentStore,
  type FinalWireIntentIdentity,
  type WireFinalizer,
  WireIntentRefusal,
  wireIdentityDigest,
} from '../delegation-group-wire-intent-store.js';
import { createReportFlow } from './delegation-source-fixtures/flow.js';
import {
  selection,
  fixture as sourceFixture,
  subject,
} from './delegation-source-fixtures/source.js';

// Real controller/reservation/member linkage; only host observations and fetch are controlled.
// UNWIRED #91: these fixtures do not establish private issuance or managed provider execution.
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
const makeTempDir = trackTempDirs();
const finishers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const finish of finishers.splice(0)) await finish();
});
const digest = (v: unknown) =>
  createHash('sha256').update(canonicalJson(v)).digest('hex');
const reference = (id: string) => ({
  id,
  domain: 'fixture.observation',
  digest: `sha256:${digest(id)}`,
});
const responseResult: ModelInvocationResult = {
  provider: 'no-billable-fixture',
  model: 'fixture-model',
  modelSource: 'provider-reported',
  outputText: 'observed',
  toolCalls: [],
  usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3, costUsd: 0.000001 },
  latencyMs: 0,
};

async function setup(
  mode: string,
  protocol: 'legacy' | 'rounds' = 'legacy',
  flow?: { owner: SourceFlowLaunchOwner; cwd: string },
  useHome = false,
) {
  const temp = realpathSync(makeTempDir('station-group-launch-fence-'));
  const home = useHome ? join(temp, 'home') : undefined;
  if (home) mkdirSync(join(home, 'security'), { recursive: true, mode: 0o700 });
  const root = home ? join(home, 'report-groups') : temp;
  if (home) mkdirSync(root, { mode: 0o700 });
  const persistence = new StationDelegationPersistence(root);
  const writer = home ? await HomeWriterOwner.forHome(home) : undefined;
  let active = true;
  let now = '2026-10-21T00:00:00.000Z';
  let starts = 0;
  let entered = 0;
  const finalizeCurrent = (): undefined => {
    if (!active) throw new Error('actual-request-revoked');
    return undefined;
  };
  const syncing = mode.includes('sync');
  const authority = {
    allowed_tools: [],
    allowed_effects: syncing ? ['report', 'context-sync'] : ['report'],
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
    max_input_tokens: syncing ? 300 : 100,
    max_output_tokens: syncing ? 30 : 10,
    max_cost_micros: syncing ? 3000 : 1000,
    max_attempts: syncing ? 3 : 1,
    expires_at: '2099-01-01T00:00:00.000Z',
  };
  const executionBinding: DelegationExecutionBindingV2 = {
    runtime: {
      runtime_receipt_ref: reference('runtime'),
      model_receipt_ref: reference('model'),
      required_capabilities: [],
    },
    source: flow?.owner.source ?? {
      repository_id: 'repository',
      source_state_id: 'revision',
      dirty_state_fingerprint: null,
      execution_worktree_id: 'worktree',
      source_admission_receipt: reference('source'),
    },
    flow_binding: flow
      ? {
          status: 'bound',
          flow_run_id: flow.owner.topology.runId,
          definition: flow.owner.topology.definition,
          flow_step_id: 'report',
          gate_attempt: 0,
        }
      : {
          status: 'unbound' as const,
          reason: 'independent-advisory',
        },
  };
  const authorityRoot: RootAuthorityV2 = {
    schema_version: '2.0',
    authority_id: 'authority',
    authority_epoch: 1,
    issuer_host_id: 'host',
    authenticated_principal_ref: reference(
      flow?.owner.topology.actor.key ?? 'principal',
    ),
    authenticated_subject_ref: reference('subject'),
    source_origin: {
      repository_id: executionBinding.source.repository_id,
      worktree_id: executionBinding.source.execution_worktree_id,
      source_state_id: executionBinding.source.source_state_id,
      dirty_state_fingerprint: null,
    },
    execution_worktree_ids: [executionBinding.source.execution_worktree_id],
    execution_grants: [
      { ...executionBinding, grant_id: 'grant', authority_ceiling: authority },
    ],
    delegation_ceiling: authority,
    budget,
    revisions: {
      policy: reference('policy'),
      prompt: reference('prompt'),
      rubric: reference('rubric'),
    },
    root_trace: { trace_id: 'trace', span_id: 'span' },
    root_cancellation_ref: reference('cancel'),
  };
  const envelope: DelegationEnvelopeV2 = {
    schema_version: '2.0',
    envelope_id: 'envelope',
    generation: 0,
    parent: null,
    root_authority_ref: rootAuthorityReferenceV2(authorityRoot),
    execution_id: 'execution',
    actor: authorityRoot.authenticated_principal_ref,
    assignment_subject: authorityRoot.authenticated_subject_ref,
    trace_id: 'trace',
    span_id: 'span',
    parent_span_id: null,
    selected_grant_id: 'grant',
    remaining_allowed_grant_ids: [],
    execution_binding: executionBinding,
    delegation_ceiling: authority,
    execution_authority: authority,
    budget,
    continuation_ref: reference('continue'),
    cancellation_ref: authorityRoot.root_cancellation_ref,
  };
  const spec: DelegationGroupSpecV2 = {
    schemaVersion: '2.0',
    groupId: 'group',
    rootAuthorityRef: rootAuthorityReferenceV2(authorityRoot),
    controller: { id: 'controller', generation: 1 },
    policy: { reference: authorityRoot.revisions.policy, maxConcurrent: 1 },
    topology: flow?.owner.topology ?? { kind: 'independent-advisory' },
    seats: [
      {
        seatId: 'seat',
        envelope: {
          id: 'envelope',
          generation: 0,
          digest: delegationEnvelopeDigestV2(envelope),
        },
        stepId: flow ? 'report' : null,
        effect: 'report',
        allocation: { inputTokens: 100, outputTokens: 10, costMicros: 1000 },
      },
    ],
  };
  const seat = spec.seats[0];
  if (!seat) throw Error('fixture seat missing');
  const host = {
    now: () => now,
    authorize: async (_action: unknown, root: RootAuthorityV2) =>
      active &&
      root.authenticated_principal_ref.id ===
        authorityRoot.authenticated_principal_ref.id,
    confirmExecution: async (actual: DelegationEnvelopeV2) =>
      active && actual.selected_grant_id === 'grant',
    confirmReconciliation: async () => active,
  };
  const sent = deferred<void>();
  const intentReady = deferred<void>();
  const allowIntentReturn = deferred<void>();
  const allowResponse = deferred<void>();
  const modelEntered = deferred<void>();
  const allowFence = deferred<void>();
  let onConsumed: () => void = () => {};
  class ObservedIntents extends FileFinalWireIntentStore {
    override async consume(
      identity: FinalWireIntentIdentity,
      current: WireFinalizer,
    ): Promise<void> {
      await super.consume(identity, current);
      intentReady.resolve();
      if (mode.startsWith('queued-')) await allowIntentReturn.promise;
      onConsumed();
    }
  }
  const intents = new ObservedIntents(root);
  const controlledFetch: typeof fetch = (_url, _request) => {
    starts++;
    sent.resolve();
    if (mode === 'post-send-reject')
      return Promise.reject(new Error('controlled-lost-response'));
    return allowResponse.promise.then(
      () => new Response('fixture', { status: 200 }),
    );
  };
  const legacyFence =
    protocol === 'legacy'
      ? new FinalFetchLaunchFence({
          groups: persistence.groupStore(finalizeCurrent),
          authorities: persistence.authorityStore(finalizeCurrent),
          host,
          intents,
          finalizeCurrent,
          fetch: controlledFetch,
          flow: flow?.owner,
        })
      : undefined;
  const roundsFence =
    protocol === 'rounds'
      ? new RoundsFinalFetchLaunchFence({
          protocol: 'rounds-v1',
          flow: flow?.owner,
          groups: persistence.roundsStore(finalizeCurrent),
          authorities: persistence.roundsAuthorityStore(finalizeCurrent),
          host,
          intents,
          finalizeCurrent,
          fetch: controlledFetch,
          ...(writer
            ? {
                reportHome: {
                  owner: writer,
                  persistence,
                  current: () => {
                    writer.assertSynchronous();
                    return finalizeCurrent();
                  },
                  preparationCurrent: finalizeCurrent,
                },
              }
            : {}),
        })
      : undefined;
  const fence = roundsFence ?? legacyFence;
  if (!fence) throw Error('fixture fence missing');
  const service = roundsFence
    ? createDelegationAuthorityServiceV3(
        roundsFence.authorities,
        { ...host, authenticateRenewal: async () => null },
        { maxRenewals: 0 },
      )
    : createDelegationAuthorityService(legacyFence!.authorities, host);
  await service.issue(authorityRoot);
  await service.derive('authority', envelope);
  mkdirSync(join(root, 'dispatch'), { mode: 0o700 });
  const invocation = new AsyncLocalStorage<string>();
  let capturedFlowClaim: FlowDurableStepClaim | undefined;
  let lastBinding: ReservedWireBinding | undefined;
  let fenceEntered = false;
  let fenceFailure: unknown;
  const wire: FinalWire = {
    url: 'https://no-billable.invalid/invoke',
    method: 'POST',
    headers: [['content-type', 'application/json']],
    body: '{"text":"fixture","max_tokens":10}',
  };
  const model: ModelRuntime = {
    id: 'fixture-runtime',
    capabilities: () => ({
      structuredTools: false,
      streaming: false,
      abort: true,
      usage: true,
      outputTokenLimitFidelity: 'native',
    }),
    invoke: async (request) => {
      const id = invocation.getStore();
      if (!id) throw Error('real invocation context missing');
      entered++;
      modelEntered.resolve();
      const binding: ReservedWireBinding = {
        groupId: 'group',
        controller: structuredClone(spec.controller),
        seatId: 'seat',
        authority: structuredClone(spec.rootAuthorityRef),
        envelope: structuredClone(seat.envelope),
        invocationId: id,
        effect: syncing ? 'context-sync' : 'report',
        allocation: structuredClone(seat.allocation),
        expectedWireDigest: wireIdentityDigest(snapshotFinalWire(wire)),
        ...(protocol === 'legacy' && capturedFlowClaim
          ? { flowClaim: structuredClone(capturedFlowClaim) }
          : {}),
      };
      if (mode === 'v2-flow-missing-claim') delete binding.flowClaim;
      if (mode === 'v2-flow-wrong-claim' && binding.flowClaim)
        binding.flowClaim.claim_id = 'foreign-claim';
      lastBinding = structuredClone(binding);
      if (mode.startsWith('pause-')) await allowFence.promise;
      if (mode === 'wrong-seat') binding.seatId = 'other-seat';
      if (mode === 'wrong-controller') binding.controller.generation++;
      if (mode === 'wrong-epoch') binding.authority.authority_epoch++;
      if (mode === 'wrong-envelope') binding.envelope.generation++;
      if (mode === 'wrong-invocation' || mode === 'sync-wrong-invocation')
        binding.invocationId = 'unreserved';
      if (mode === 'sync-foreign-command') {
        const file = join(
          root,
          'station-delegation-rounds',
          `${createHash('sha256').update('group').digest('hex')}.json`,
        );
        const journal: DelegationRoundsJournal = JSON.parse(
          readFileSync(file, 'utf8'),
        );
        const event = journal.events.find(
          (event) => event.kind === 'command' && event.command.kind === 'sync',
        );
        assert.ok(event?.kind === 'command' && event.command.kind === 'sync');
        event.command.contextRef.id = 'substituted-context-reference';
        writeFileSync(file, JSON.stringify(journal), { mode: 0o600 });
        const observed = await roundsController!.get('group');
        const command = observed.continuations[0].command;
        assert.ok(command.kind === 'sync');
        assert.equal(command.contextRef.id, 'substituted-context-reference');
      }
      if (mode === 'wrong-wire')
        binding.expectedWireDigest = `sha256:${'b'.repeat(64)}`;
      if (mode === 'missing-reservation') {
        const file = join(
          root,
          protocol === 'legacy'
            ? 'station-delegation-authorities'
            : 'station-rounds-authorities-v3',
          `${createHash('sha256').update('authority').digest('hex')}.json`,
        );
        const value = JSON.parse(readFileSync(file, 'utf8'));
        value.invocations = [];
        if (protocol === 'rounds') value.origins = [];
        writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
      }
      if (mode === 'revoke-after-consume')
        onConsumed = () => {
          active = false;
        };
      if (mode === 'expiry-after-consume')
        onConsumed = () => {
          now = '2100-01-01T00:00:00.000Z';
        };
      if (mode === 'nested-owner')
        host.confirmExecution = async () => {
          await service.inspect('authority');
          return true;
        };
      if (mode === 'nested-launch')
        host.confirmExecution = async () => {
          await fence.start(binding, wire, new AbortController().signal);
          return true;
        };
      fenceEntered = true;
      if (protocol === 'legacy' && mode.includes('v2-flow'))
        await fence
          .admitTask(binding, new AbortController().signal)
          .catch((error: unknown) => {
            fenceFailure = error;
            throw error;
          });
      const begun = await fence
        .start(binding, wire, new AbortController().signal)
        .catch((error: unknown) => {
          fenceFailure = error;
          throw error;
        });
      // Keep the actual response outside the group/authority locked transaction result.
      await begun.response;
      return {
        ...structuredClone(responseResult),
        ...(syncing
          ? {
              outputText: String(request.messages[0].content).split(
                'Reply exactly ',
              )[1],
            }
          : {}),
      };
    },
  };
  const legacyController = legacyFence
    ? createDelegationGroupControllerV2({
        cwd: flow?.cwd,
        store: legacyFence.groups,
        authorityService: service,
        dispatchLedger: new FileAuthorizationLedger({
          root: join(root, 'dispatch'),
        }),
        host: {
          authorize: async () =>
            active ? reference('actual-fixture-caller') : null,
          executionHost: () => ({
            resolveRuntime: async () => ({
              runtime: model,
              runtimeReceipt: executionBinding.runtime.runtime_receipt_ref,
              modelReceipt: executionBinding.runtime.model_receipt_ref,
            }),
            invokeFenced: async (_envelope, id, invoke) =>
              invocation.run(id, invoke),
            retainFailure: async () => {},
            retainResult: async () => {},
            recordScheduleEvent: async (event) => {
              if (!flow) throw Error('advisory fixture must not schedule Flow');
              await persistence.retainReportFlowObservation(
                'group',
                'schedule',
                event,
                finalizeCurrent,
              );
            },
            confirmClaim: async (claim) => {
              if (!flow) throw Error('advisory fixture must not claim Flow');
              return (
                await flow.owner.withCurrentClaim(claim, () => ({
                  value: true,
                }))
              ).value;
            },
            prepareRequest: async (claim) => {
              if (!flow) throw Error('advisory fixture must not request Flow');
              capturedFlowClaim = structuredClone(claim);
              return {
                messages: [{ role: 'user', content: 'fixture' }],
                maxOutputTokens: 10,
              };
            },
            recordMemberOutcome: async (claim, envelope, outcome) => {
              if (!flow) throw Error('advisory fixture must not write Flow');
              await persistence.retainReportFlowObservation(
                'group',
                'member',
                { claim, envelopeId: envelope.envelope_id, outcome },
                finalizeCurrent,
              );
            },
          }),
          prepareIndependentRequest: async () => ({
            messages: [{ role: 'user', content: 'fixture' }],
            maxOutputTokens: 10,
          }),
          retainMemberOutcome: async () => ({
            outcomeRef: reference('raw-outcome-fixture'),
            dissentRefs: [],
            uncertaintyRefs: [],
          }),
          retainRunObservation: async () =>
            reference('run-observation-fixture'),
          retainRunFailure: async () => reference('run-failure-fixture'),
          requestDescendantCancellation: async () =>
            reference('controlled-cancel-request'),
          confirmDescendantCancellation: async () =>
            reference('controlled-cancel-observed'),
        },
      })
    : undefined;
  const roundsSpec: DelegationRoundsSpec = {
    ...spec,
    schemaVersion: '1.0',
    policy: {
      ...spec.policy,
      maxRounds: 1,
      maxAttempts: syncing ? 3 : 1,
      ...(syncing ? { maxSyncs: 1 } : {}),
      ...(flow ? { maxEvaluations: 1 } : {}),
    },
    topology: flow?.owner.topology ?? spec.topology,
    seats: spec.seats.map(({ stepId: _stepId, ...seat }) => ({
      ...seat,
      ...(flow ? { stepId: 'report' } : {}),
    })),
  };
  const roundsPhysical: DelegationRoundsExecutionHost = {
    resolveRuntime: async () => ({
      runtime: model,
      runtimeReceipt: executionBinding.runtime.runtime_receipt_ref,
      modelReceipt: executionBinding.runtime.model_receipt_ref,
    }),
    invokeFenced: async (_envelope, id, invoke) => invocation.run(id, invoke),
    retainFailure: async () => {},
    retainResult: async () => ({
      inputTokens: 2,
      outputTokens: 1,
      costMicros: 1,
      costBasis: 'tariff-upper-bound',
    }),
  };
  const roundsController = roundsFence
    ? createDelegationRoundsController({
        cwd: flow?.cwd,
        store: roundsFence.groups,
        authorityService: service,
        dispatchLedger: new FileAuthorizationLedger({
          root: join(root, 'dispatch'),
        }),
        host: {
          accountingProtocol: 'retained-tariff-v1',
          authorize: async () =>
            active ? reference('actual-fixture-caller') : null,
          executionHost: () => roundsPhysical,
          ...(syncing
            ? {
                recipient: {
                  resolve: async (spec, seat, envelope) => ({
                    identity: {
                      hostId: 'host',
                      recipientId: 'controlled-recipient',
                      generation: 1,
                      executionId: envelope.execution_id,
                      authority: spec.rootAuthorityRef,
                      envelope: {
                        id: seat.envelope.id,
                        digest: seat.envelope.digest,
                      },
                      runtimeReceipt:
                        executionBinding.runtime.runtime_receipt_ref,
                      modelReceipt: executionBinding.runtime.model_receipt_ref,
                      sessionReceipt: reference('controlled-session'),
                    },
                    runtime: model,
                    retainResult: roundsPhysical.retainResult,
                    retainFailure: roundsPhysical.retainFailure,
                    invokeFenced: roundsPhysical.invokeFenced,
                  }),
                },
                context: {
                  load: async () => 'Controlled new context',
                  executionHost: () => roundsPhysical,
                  confirmTerminal: async () => reference('controlled-terminal'),
                },
                retainContinuation: async () =>
                  reference('controlled-sync-receipt'),
              }
            : {}),
          ...(flow
            ? {
                flow: {
                  executionHost: () => ({
                    ...roundsPhysical,
                    recordScheduleEvent: async () => {},
                    confirmClaim: async () => true,
                    prepareRequest: async () => ({
                      messages: [{ role: 'user' as const, content: 'fixture' }],
                      maxOutputTokens: 10,
                    }),
                    recordMemberOutcome: async () => {},
                  }),
                  confirmRetainedResult: async () => false,
                  retainEvaluation: async () =>
                    reference('controlled-evaluation'),
                },
              }
            : {}),
          prepareRequest: async () => ({
            messages: [{ role: 'user', content: 'fixture' }],
            maxOutputTokens: 10,
          }),
          retainObservation: async () => reference('raw-outcome-fixture'),
          confirmTerminal: async () => null,
          requestDescendantCancellation: async () =>
            reference('controlled-cancel-request'),
        },
      })
    : undefined;
  const controller = roundsController ?? legacyController;
  if (!controller) throw Error('fixture controller missing');
  await controller.create({
    kind: 'create',
    groupId: 'group',
    operationKey: 'create',
    expectedRevision: 0,
    controller: spec.controller,
    spec: roundsController ? roundsSpec : spec,
  });
  let running: Promise<unknown> | undefined;
  const run = async () => {
    const flowHead = flow
      ? flowRunHead((await loadRun(flow.owner.topology.runId, flow.cwd)).state)
      : undefined;
    if (syncing && roundsController && flowHead) {
      running = roundsController.sync({
        kind: 'sync',
        groupId: 'group',
        operationKey: 'sync-context',
        expectedRevision: 1,
        controller: spec.controller,
        checkpoint: reference('sync-checkpoint'),
        flowHead,
        seatId: 'seat',
        contextRef: {
          domain: 'controlled-context',
          id: 'context',
          digest: `sha256:${createHash('sha256').update('Controlled new context').digest('hex')}`,
        },
      });
      void running.catch(() => {});
      return running;
    }
    running = roundsController
      ? roundsController.release({
          kind: 'release',
          groupId: 'group',
          operationKey: 'run',
          expectedRevision: 1,
          controller: spec.controller,
          checkpoint: reference('checkpoint'),
          ...(flowHead ? { flowHead } : {}),
          seats: [
            {
              seatId: 'seat',
              previousInvocationId: null,
              ...(flow ? { mode: 'invoke', retryRef: null } : {}),
            },
          ],
        })
      : legacyController!.run({
          kind: 'run',
          groupId: 'group',
          operationKey: 'run',
          expectedRevision: 1,
          controller: spec.controller,
        });
    void running.catch(() => {});
    return running;
  };
  finishers.push(async () => {
    active = true;
    allowFence.resolve();
    allowIntentReturn.resolve();
    allowResponse.resolve();
    await running?.catch(() => {});
  });
  return {
    root,
    writer,
    persistence,
    service,
    controller,
    fence,
    intents,
    spec,
    wire,
    host,
    finalizeCurrent,
    run,
    sent,
    allowResponse,
    modelEntered,
    allowFence,
    intentReady,
    allowIntentReturn,
    get starts() {
      return starts;
    },
    get entered() {
      return entered;
    },
    get fenceEntered() {
      return fenceEntered;
    },
    get fenceFailure() {
      return fenceFailure;
    },
    get binding() {
      return lastBinding;
    },
    reactivate() {
      active = true;
      host.confirmExecution = async (actual) =>
        active && actual.selected_grant_id === 'grant';
    },
    revoke() {
      active = false;
    },
  };
}

async function within<T>(work: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const cases = [
  'success-pending-response',
  'wrong-seat',
  'wrong-controller',
  'wrong-epoch',
  'wrong-envelope',
  'wrong-invocation',
  'wrong-wire',
  'missing-reservation',
  'revoke-after-consume',
  'expiry-after-consume',
  'nested-owner',
  'nested-launch',
  'pause-root-cancel',
  'pause-group-cancel',
  'post-send-reject',
  'duplicate-and-reopen',
  'queued-root-cancel',
  'queued-group-cancel',
] as const;

test('V2 Task admission reuses current reservation checks without transport or wire consumption', async () => {
  const f = await setup('pause-root-cancel', 'legacy');
  const running = f.run().catch(() => undefined);
  await within(f.modelEntered.promise, 'model did not reach reservation');
  assert(f.binding);
  const admission = new FinalFetchLaunchFence({
    groups: f.persistence.groupStore(f.finalizeCurrent),
    authorities: f.persistence.authorityStore(f.finalizeCurrent),
    host: f.host,
    intents: f.intents,
    finalizeCurrent: f.finalizeCurrent,
  });
  const mutableBinding = structuredClone(f.binding);
  const originalSeat = mutableBinding.seatId;
  const pendingAdmission = admission.admitTask(
    mutableBinding,
    new AbortController().signal,
  );
  mutableBinding.invocationId = 'mutated-after-admission';
  mutableBinding.seatId = 'foreign';
  await pendingAdmission;
  assert.equal(f.binding.seatId, originalSeat);
  assert.equal(f.starts, 0);
  assert.equal(
    await f.intents.lookup(
      'authority',
      f.binding.invocationId,
      f.finalizeCurrent,
    ),
    undefined,
  );
  await assert.rejects(
    () => admission.start(f.binding!, f.wire, new AbortController().signal),
    (error: unknown) =>
      error instanceof WireIntentRefusal &&
      error.code === 'wire_transport_unavailable',
  );
  await assert.rejects(() =>
    admission.admitTask(
      { ...f.binding!, seatId: 'foreign' },
      new AbortController().signal,
    ),
  );
  await f.service.cancel('authority');
  await assert.rejects(() =>
    admission.admitTask(f.binding!, new AbortController().signal),
  );
  assert.equal(f.starts, 0);
  f.allowFence.resolve();
  await running;
});

test('rounds launch borrows one home lease and releases it before provider response', async () => {
  const f = await setup('success-pending-response', 'rounds', undefined, true);
  assert.ok(f.writer);
  const running = f.run();
  await within(f.sent.promise, 'reserved wire did not start');
  const contender = await within(
    f.writer.acquire(),
    'home lease retained while provider response was pending',
  );
  await contender.release();
  assert.equal(f.starts, 1);
  f.allowResponse.resolve();
  await running;
});

test.each(
  ['legacy', 'rounds'].flatMap((protocol) =>
    cases.map((mode) => ({ protocol: protocol as 'legacy' | 'rounds', mode })),
  ),
)('final fetch: $protocol $mode', async ({ protocol, mode }) => {
  const f = await setup(mode, protocol);
  const running = f.run();
  const observed = running.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
  if (mode === 'success-pending-response' || mode === 'duplicate-and-reopen') {
    await Promise.race([
      f.sent.promise,
      observed.then((result) => {
        if (!result.ok) throw result.error;
        throw Error('run finished without transport');
      }),
    ]);
    assert.equal(f.starts, 1);
    assert(f.binding);
    if (mode === 'duplicate-and-reopen') {
      const freshIntents = new FileFinalWireIntentStore(f.root);
      const retained = await freshIntents.lookup(
        'authority',
        f.binding.invocationId,
        f.finalizeCurrent,
      );
      assert(retained);
      const duplicate = await f.fence
        .start(f.binding, f.wire, new AbortController().signal)
        .then(
          () => false,
          () => true,
        );
      assert.equal(duplicate, true);
      assert.equal(f.starts, 1);
    }
    // This actual public authority mutation must complete while fetch response is unresolved.
    await within(
      f.service.cancel('authority'),
      'authority lock retained through response',
    );
    f.allowResponse.resolve();
    await observed;
  } else if (mode.startsWith('queued-')) {
    await within(
      Promise.race([
        f.intentReady.promise,
        observed.then((result) => {
          if (!result.ok) throw result.error;
          throw new Error('run completed without durable intent');
        }),
      ]),
      'wire intent not reached',
    );
    const cancellation =
      mode === 'queued-root-cancel'
        ? f.service.cancel('authority')
        : (async () => {
            const current = await f.controller.get('group');
            await f.controller.cancel({
              kind: 'cancel',
              groupId: 'group',
              operationKey: 'cancel',
              expectedRevision: current.revision,
              controller: f.spec.controller,
            });
          })();
    f.allowIntentReturn.resolve();
    await Promise.race([
      f.sent.promise,
      observed.then((result) => {
        if (!result.ok) throw result.error;
      }),
    ]);
    await within(cancellation, 'queued cancellation retained response lock');
    assert.equal(f.starts, 1);
    f.allowResponse.resolve();
    await observed;
  } else if (mode === 'pause-root-cancel' || mode === 'pause-group-cancel') {
    await within(
      Promise.race([
        f.modelEntered.promise,
        observed.then((result) => {
          if (!result.ok) throw result.error;
          throw new Error('run completed without entering member runtime');
        }),
      ]),
      'member runtime not reached',
    );
    assert.equal(f.entered, 1);
    if (mode === 'pause-root-cancel') await f.service.cancel('authority');
    else {
      const current = await f.controller.get('group');
      await f.controller.cancel({
        kind: 'cancel',
        groupId: 'group',
        operationKey: 'cancel',
        expectedRevision: current.revision,
        controller: f.spec.controller,
      });
    }
    f.allowFence.resolve();
    await observed;
    assert.equal(f.starts, 0);
  } else {
    f.allowResponse.resolve();
    await observed;
    assert.equal(f.entered, 1, 'control must reach the real member runtime');
    assert.equal(
      f.starts,
      mode === 'post-send-reject' ? 1 : 0,
      `${mode} unauthorized send`,
    );
  }
  f.reactivate();
  if (mode !== 'missing-reservation') {
    const ledger = await f.service.inspect('authority');
    assert.equal(ledger.invocations.length, 1);
    if (
      mode !== 'success-pending-response' &&
      mode !== 'duplicate-and-reopen' &&
      !mode.startsWith('queued-')
    ) {
      assert.equal(
        ledger.invocations[0]?.usage,
        null,
        'unknown must retain hold',
      );
    }
  }
});

test.each([
  'v2-flow-success',
  'v2-flow-missing-claim',
  'v2-flow-wrong-claim',
  'queued-v2-flow-pause',
])(
  'V2 task and physical send require the same current source-owned Flow claim: %s',
  async (mode) => {
    const source = await sourceFixture();
    const topology = await createReportFlow(source, 'v2-final-fetch', [
      { id: 'report' },
    ]);
    const sealed = await source.owner.captureSnapshot(
      source.context(),
      subject,
      selection,
    );
    const flow = await source.owner.prepareFlowSnapshot(
      source.context(),
      subject,
      sealed.capability,
      topology.runId,
    );
    const f = await setup(mode, 'legacy', { owner: flow, cwd: source.repo });
    try {
      const running = f.run();
      void running.catch(() => {});
      f.allowResponse.resolve();
      if (mode === 'queued-v2-flow-pause') {
        await within(
          Promise.race([
            f.intentReady.promise,
            running.then(() => {
              throw Error('V2 run returned before durable wire intent');
            }),
          ]),
          'V2 wire intent not reached',
        );
        await pauseRun(topology.runId, {
          cwd: source.repo,
          reason: 'Pause between durable wire intent and physical send',
          authority: {
            kind: 'operator_request',
            actor: flow.topology.actor.key,
            request_ref: 'v2-final-fetch-pause',
            requested_at: new Date().toISOString(),
          },
        });
        f.allowIntentReturn.resolve();
      }
      await running.catch(() => undefined);
      assert.equal(
        f.entered,
        1,
        'the real controller must reach the reserved runtime',
      );
      assert.equal(f.starts, mode === 'v2-flow-success' ? 1 : 0);
      if (mode === 'v2-flow-missing-claim' || mode === 'v2-flow-wrong-claim') {
        assert.ok(f.fenceFailure instanceof WireIntentRefusal);
        assert.equal(f.fenceFailure.code, 'reserved_launch_join_unavailable');
      }
      const ledger = await f.service.inspect('authority');
      assert.equal(ledger.invocations.length, 1);
      assert.equal(
        ledger.invocations[0].usage !== null,
        mode === 'v2-flow-success',
      );
    } finally {
      f.allowIntentReturn.resolve();
      f.allowResponse.resolve();
      source.owner.releaseSnapshot(sealed.capability);
    }
  },
);

test('final fetch revalidates the actual source-owned Flow claim after durable wire intent consumption', async () => {
  const source = await sourceFixture();
  const definitionPath = join(source.repo, 'flow.json');
  writeFileSync(
    definitionPath,
    JSON.stringify({
      id: 'report-flow',
      version: '1',
      execution: { mode: 'multi-cursor', claim_contract_version: '1' },
      steps: [{ id: 'report', next: null, mutable_resources: [] }],
      gates: {
        report: {
          step: 'report',
          expects: [
            {
              id: 'report',
              kind: 'trust.bundle',
              required: true,
              description: 'Independent evidence owns acceptance.',
              bundle_claim: {
                claimType: 'quality.report',
                accepted_statuses: ['assumed'],
              },
            },
          ],
        },
      },
    }),
  );
  writeFileSync(join(source.repo, '.gitignore'), '.kontourai/\n');
  await source.git('add', 'flow.json', '.gitignore');
  await source.git('commit', '-qm', 'real Flow fence fixture');
  const run = await startRun(definitionPath, {
    cwd: source.repo,
    runId: 'final-fetch-flow',
  });
  const sealed = await source.owner.captureSnapshot(
    source.context(),
    subject,
    selection,
  );
  const flow = await source.owner.prepareFlowSnapshot(
    source.context(),
    subject,
    sealed.capability,
    run.runId,
  );
  const f = await setup('queued-flow-pause', 'rounds', {
    owner: flow,
    cwd: source.repo,
  });
  const running = f.run();
  void running.catch(() => {});
  await Promise.race([
    f.intentReady.promise,
    running.then(() => {
      throw new Error('Flow round returned before physical intent');
    }),
  ]);
  await pauseRun(run.runId, {
    cwd: source.repo,
    reason: 'Pause after wire intent, before fetch',
    authority: {
      kind: 'operator_request',
      actor: flow.topology.actor.key,
      request_ref: 'final-fetch-pause',
      requested_at: new Date().toISOString(),
    },
  });
  f.allowResponse.resolve();
  f.allowIntentReturn.resolve();
  await assert.rejects(running);
  assert.equal(f.entered, 1);
  assert.equal(f.starts, 0);
  const state = await f.controller.get('group');
  assert.ok('attempts' in state);
  assert.equal(state.attempts.length, 1);
  assert.equal(state.attempts[0].terminal, null);
  const ledger = await f.service.inspect('authority');
  assert.equal(ledger.invocations.length, 1);
  assert.equal(ledger.invocations[0].usage, null);
  source.owner.releaseSnapshot(sealed.capability);
});

test.each([
  'sync-success',
  'sync-wrong-invocation',
  'sync-foreign-command',
  'queued-sync-head',
])(
  'sync final fetch joins the published reservation to the pending command and current Flow head: %s',
  async (mode) => {
    const source = await sourceFixture();
    const topology = await createReportFlow(source, 'sync-final-fetch', [
      { id: 'report' },
    ]);
    const sealed = await source.owner.captureSnapshot(
      source.context(),
      subject,
      selection,
    );
    const flow = await source.owner.prepareFlowSnapshot(
      source.context(),
      subject,
      sealed.capability,
      topology.runId,
    );
    const f = await setup(mode, 'rounds', { owner: flow, cwd: source.repo });
    try {
      const running = f.run();
      void running.catch(() => {});
      f.allowResponse.resolve();
      if (mode === 'queued-sync-head') {
        await Promise.race([
          f.intentReady.promise,
          running.then(() => {
            throw new Error('Sync returned before durable wire intent');
          }),
        ]);
        await claimReadyStep(topology.runId, {
          cwd: source.repo,
          step_id: 'report',
          claim_id: 'changed-head',
          liveness_id: 'head-change-liveness',
          actor: flow.topology.actor,
        });
        f.allowIntentReturn.resolve();
      }
      if (mode === 'sync-success') await running;
      else await assert.rejects(running);
      assert.equal(f.starts, mode === 'sync-success' ? 1 : 0);
      if (mode === 'sync-foreign-command') {
        assert.equal(f.fenceEntered, true);
        assert.ok(f.fenceFailure instanceof Error && 'code' in f.fenceFailure);
        assert.equal(f.fenceFailure.code, 'reserved_launch_join_unavailable');
      }
      const ledger = await f.service.inspect('authority');
      assert.equal(ledger.invocations.length, 1);
      assert.equal(ledger.invocations[0].terminal, mode === 'sync-success');
      const state = await f.controller.get('group');
      assert.ok('continuations' in state);
      assert.equal(
        state.attempts.length,
        0,
        'sync never fabricates an ordinary step attempt',
      );
      assert.equal(
        Boolean(state.continuations[0].receipt?.acknowledged),
        mode === 'sync-success',
      );
    } finally {
      source.owner.releaseSnapshot(sealed.capability);
    }
  },
);
