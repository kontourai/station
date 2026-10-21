import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FileAuthorizationLedger } from '@kontourai/dispatch';
import type { RootAuthorityV2 } from '@kontourai/flow-agents/delegation-authority-contract';
import { createDelegationAuthorityService } from '@kontourai/flow-agents/delegation-authority-service';
import type { DelegationEnvelopeV2 } from '@kontourai/flow-agents/delegation-envelope-v2';
import {
  delegationEnvelopeDigestV2,
  rootAuthorityReferenceV2,
} from '@kontourai/flow-agents/delegation-envelope-v2';
import type { DelegationGroupSpecV2 } from '@kontourai/flow-agents/delegation-group-v2';
import { createDelegationGroupControllerV2 } from '@kontourai/flow-agents/delegation-group-v2';
import {
  canonicalJson,
  type ModelInvocationResult,
  type ModelRuntime,
} from '@kontourai/relay';
import { runtimeRequestPrincipalMayAccessHttpRoute } from '../../../../security/runtime-request-security.js';
import {
  FinalFetchLaunchFence,
  type FinalWire,
  type ReservedWireBinding,
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
import type { fixture } from './source.js';

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
) {
  const current = () =>
    runtimeRequestPrincipalMayAccessHttpRoute(f.req, f.environment, {
      method: 'POST',
      path: '/api/orchestration/chat',
    });
  const finalize = (): undefined => {
    if (!current()) throw Error('actual-local-grant-revoked');
    return undefined;
  };
  const persistence = new StationDelegationPersistence(f.root);
  const authority = {
    allowed_tools: [],
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
    max_input_tokens: 1000,
    max_output_tokens: 1000,
    max_cost_micros: 100000,
    max_attempts: 1,
    expires_at: '2099-01-01T00:00:00.000Z',
  };
  const execution = {
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
  const root: RootAuthorityV2 = {
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
  const envelope: DelegationEnvelopeV2 = {
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
  const spec: DelegationGroupSpecV2 = {
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
        allocation: {
          inputTokens: 1000,
          outputTokens: 1000,
          costMicros: 100000,
        },
      },
    ],
  };
  const host = {
    now: () => '2026-10-21T00:00:00.000Z',
    authorize: async () => current(),
    confirmExecution: async (e: DelegationEnvelopeV2) =>
      current() &&
      canonicalJson(e.execution_binding) === canonicalJson(execution),
    confirmReconciliation: async () => current(),
  };
  let intentCount = 0;
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
  const fence = new FinalFetchLaunchFence({
    groups: persistence.groupStore(finalize),
    authorities: persistence.authorityStore(finalize),
    host,
    intents,
    finalizeCurrent: finalize,
    fetch: inner,
  });
  const service = createDelegationAuthorityService(fence.authorities, host);
  await service.issue(root);
  await service.derive(root.authority_id, envelope);
  const invocation = new AsyncLocalStorage<string>();
  const model: ModelRuntime = {
    id: 'installed-sdk-sealed-fixture',
    capabilities: () => ({
      structuredTools: false,
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
      const binding: ReservedWireBinding = {
        groupId: spec.groupId,
        controller: spec.controller,
        seatId: seat.seatId,
        authority: spec.rootAuthorityRef,
        envelope: seat.envelope,
        invocationId: id,
        effect: seat.effect,
        allocation: seat.allocation,
        expectedWireDigest: wireIdentityDigest(wire),
      };
      const begun = await fence.start(
        binding,
        wire,
        new AbortController().signal,
      );
      deliverSdkResponse(sdkOwner, handle, await begun.response);
      const result = await sdkResultPromise(sdkOwner, handle);
      return {
        provider: 'synthetic-no-billable-http',
        model: 'fixture-model',
        modelSource: 'provider-reported',
        outputText: result.text,
        toolCalls: [],
        usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, costUsd: 0 },
        latencyMs: 0,
      } satisfies ModelInvocationResult;
    },
  };
  mkdirSync(join(f.root, 'dispatch'), { mode: 0o700 });
  const controller = createDelegationGroupControllerV2({
    store: fence.groups,
    authorityService: service,
    dispatchLedger: new FileAuthorizationLedger({
      root: join(f.root, 'dispatch'),
    }),
    host: {
      authorize: async () => (current() ? ref('caller') : null),
      executionHost: () => ({
        resolveRuntime: async () => ({
          runtime: model,
          runtimeReceipt: execution.runtime.runtime_receipt_ref,
          modelReceipt: execution.runtime.model_receipt_ref,
        }),
        invokeFenced: async (_e, id, invoke) => invocation.run(id, invoke),
        retainFailure: async () => {},
        retainResult: async () => {},
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
  });
  await controller.create({
    kind: 'create',
    groupId: spec.groupId,
    operationKey: 'create',
    expectedRevision: 0,
    controller: spec.controller,
    spec,
  });
  return {
    run: () =>
      controller.run({
        kind: 'run',
        groupId: spec.groupId,
        operationKey: 'run',
        expectedRevision: 1,
        controller: spec.controller,
      }),
    get intentCount() {
      return intentCount;
    },
  };
}
