import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  DelegationExecutionBindingV2,
  RootAuthorityV2,
} from '@kontourai/flow-agents/delegation-authority-contract';
import {
  type DelegationEnvelopeV2,
  delegationEnvelopeDigestV2,
  rootAuthorityReferenceV2,
} from '@kontourai/flow-agents/delegation-envelope-v2';
import type { DelegationGroupSpecV2 } from '@kontourai/flow-agents/delegation-group-v2';
import { canonicalJson } from '@kontourai/relay';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { afterEach, expect, test, vi } from 'vitest';
import { createDelegationGroupRoutes } from '../../../routes/orchestration/delegation-groups.js';
import { createOrchestrationRequestPrincipalResolver } from '../../../runtime/bootstrap/orchestration-request-principal.js';
import {
  bindRuntimeLocalOperator,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../identity/principal-resolver.js';
import { EnvironmentSecurityService } from '../../ssh/environment-security-service.js';
import { DelegationGroupRuntime } from '../delegation-group-runtime.js';
import { EventBus } from '../event-bus.js';

// Requires the published candidate artifact AND new route scope declarations.
// No mocked controller, downloaded source import, skip, or permissive authority callback.
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const sha = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
const ref = (id: string) => ({
  id,
  domain: 'fixture.observation',
  digest: `sha256:${sha(id)}`,
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'station-group-runtime-'));
  roots.push(directory);
  const privateRoot = join(directory, 'groups');
  mkdirSync(privateRoot, { mode: 0o700 });
  mkdirSync(join(privateRoot, 'prepared'), { mode: 0o700 });
  const security = new EnvironmentSecurityService({
    homeDir: join(directory, 'security'),
  });
  const { credential: operatorCredential } = await security.initialize();
  const offer = security.devicePairing.createOffer({
    endpoint: 'http://127.0.0.1',
  });
  const request = security.devicePairing.requestPairing({
    requesterPosition: 'off-box',
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'Group fixture',
  });
  security.devicePairing.confirmRequest(request.requestId, {
    kind: 'local-grant',
  });
  const local = security.devicePairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: request.requestId,
    locality: 'home-possession',
    mintKind: 'local-grant',
  });
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
    max_runtime_ms: 60_000,
    max_input_tokens: 100,
    max_output_tokens: 10,
    max_cost_micros: 1000,
    max_attempts: 1,
    expires_at: '2099-01-01T00:00:00.000Z',
  };
  const observed: DelegationExecutionBindingV2 = {
    runtime: {
      runtime_receipt_ref: ref('runtime'),
      model_receipt_ref: ref('model'),
      required_capabilities: [],
    },
    source: {
      repository_id: 'repository',
      source_state_id: 'source-revision',
      dirty_state_fingerprint: null,
      execution_worktree_id: 'worktree',
      source_admission_receipt: ref('source-admission'),
    },
    flow_binding: { status: 'unbound', reason: 'independent-advisory' },
  };
  const root: RootAuthorityV2 = {
    schema_version: '2.0',
    authority_id: 'group-fixture',
    authority_epoch: 1,
    issuer_host_id: 'fixture-host',
    authenticated_principal_ref: ref(LOCAL_OPERATOR_PRINCIPAL_ID),
    authenticated_subject_ref: ref(LOCAL_OPERATOR_PRINCIPAL_ID),
    source_origin: {
      repository_id: 'repository',
      worktree_id: 'worktree',
      source_state_id: 'source-revision',
      dirty_state_fingerprint: null,
    },
    execution_worktree_ids: ['worktree'],
    execution_grants: [
      { ...observed, grant_id: 'grant', authority_ceiling: authority },
    ],
    delegation_ceiling: authority,
    budget,
    revisions: {
      policy: ref('policy'),
      prompt: ref('prompt'),
      rubric: ref('rubric'),
    },
    root_trace: { trace_id: 'trace', span_id: 'span' },
    root_cancellation_ref: ref('cancellation'),
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
    execution_binding: observed,
    delegation_ceiling: authority,
    execution_authority: authority,
    budget,
    continuation_ref: ref('continuation'),
    cancellation_ref: root.root_cancellation_ref,
  };
  const spec: DelegationGroupSpecV2 = {
    schemaVersion: '2.0',
    groupId: root.authority_id,
    rootAuthorityRef: rootAuthorityReferenceV2(root),
    controller: { id: 'controller', generation: 1 },
    policy: { reference: root.revisions.policy, maxConcurrent: 1 },
    topology: { kind: 'independent-advisory' },
    seats: [
      {
        seatId: 'reviewer',
        envelope: {
          id: envelope.envelope_id,
          generation: 0,
          digest: delegationEnvelopeDigestV2(envelope),
        },
        stepId: null,
        effect: 'report',
        allocation: { inputTokens: 100, outputTokens: 10, costMicros: 1000 },
      },
    ],
  };
  const prepared = {
    version: 1,
    groupId: spec.groupId,
    subjectConversationId: null,
    callerLineageDigest: null,
    hostId: 'fixture-host',
    root,
    envelopes: [envelope],
    spec,
    slots: [
      {
        seatId: 'reviewer',
        taskId: 'task:fixture',
        conversationId: 'conversation',
        sessionId: 'session',
        clientTurnId: 'client-turn',
        invocationId: 'station-invocation',
      },
    ],
  };
  const preparationPath = join(
    privateRoot,
    'prepared',
    `${sha(spec.groupId)}.json`,
  );
  writeFileSync(preparationPath, JSON.stringify(prepared), { mode: 0o600 });
  const current = structuredClone(observed);
  const readMemberEvents = vi.fn(async () => null);
  const owners = {
    privateRoot,
    eventBus: new EventBus(),
    hostId: 'fixture-host',
    security,
    resolveDelegation: async () => undefined,
    readAuthority: (_request: Request, principal: { id: string }) =>
      sessionReadAuthorityFromRequest(principal.id, undefined, undefined, {
        localHomePossession: true,
      }),
    currentExecutionBinding: async () => structuredClone(current),
    orchestration: {
      readSessionEventPage: readMemberEvents,
      inspectAttentionRequest: () => null,
    },
    flow: {
      confirmClaim: async () => {
        throw new Error('No Flow claim in advisory fixture');
      },
      recordScheduleEvent: async () => {
        throw new Error('No Flow schedule in advisory fixture');
      },
      recordMemberOutcome: async () => {
        throw new Error('No Flow member in advisory fixture');
      },
    },
  };
  const appFor = (runtime: DelegationGroupRuntime) => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      const credential =
        c.req.header('Authorization')?.replace(/^Bearer /, '') ?? '';
      if (
        security.authorizeCredential(credential, {
          method: c.req.method,
          path: c.req.path,
        })
      ) {
        setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
          kind: 'credential',
          credential,
          authority: security.verifyOperatorCredential(credential)
            ? 'operator-credential'
            : 'device-credential',
          source: 'bearer',
          deviceId: security.identifyDevice(credential)?.id,
          locality: security.credentialLocality(credential),
          mintKind: security.credentialMintKind(credential),
        });
        bindRuntimeLocalOperator(c.req.raw);
      }
      await next();
    });
    app.route(
      '/api/orchestration/groups',
      createDelegationGroupRoutes(
        runtime,
        createOrchestrationRequestPrincipalResolver({
          environmentSecurityService: security,
        }),
      ),
    );
    return app;
  };
  let runtime = new DelegationGroupRuntime(owners);
  let app = appFor(runtime);
  return {
    directory,
    privateRoot,
    prepared,
    owners,
    readMemberEvents,
    request: (
      path: string,
      method = 'GET',
      body?: unknown,
      credential = local.credential,
    ) =>
      app.request(`http://127.0.0.1/api/orchestration/groups${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    operatorCredential,
    drift: () => {
      current.source.source_state_id = 'different-revision';
    },
    reopen: () => {
      runtime = new DelegationGroupRuntime(owners);
      app = appFor(runtime);
    },
  };
}

test('new metadata admission refuses at the authority mutation owner without publishing a ledger', async () => {
  const f = await fixture();
  const response = await f.request('/', 'POST', {
    preparationId: 'group-fixture',
    operationId: 'create-1',
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    success: false,
    code: 'group_metadata_fence_unavailable',
  });
  expect(
    readdirSync(join(f.privateRoot, 'delegation-authorities')).filter((name) =>
      name.endsWith('.json'),
    ),
  ).toEqual([]);
  expect(
    readdirSync(join(f.privateRoot, 'delegation-groups-v2')).filter((name) =>
      name.endsWith('.json'),
    ),
  ).toEqual([]);
  f.reopen();
  expect(
    (
      await f.request('/', 'POST', {
        preparationId: 'group-fixture',
        operationId: 'create-1',
      })
    ).status,
  ).toBe(503);
  expect(await (await f.request('/')).json()).toMatchObject({
    data: { groups: [], hasMore: false },
  });
});

test('routes reject supplied authority and unapproved operator credentials before storage mutation', async () => {
  const f = await fixture();
  expect(
    (
      await f.request('/', 'POST', {
        preparationId: 'group-fixture',
        operationId: 'create-1',
        root: f.prepared.root,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await f.request(
        '/',
        'POST',
        { preparationId: 'group-fixture', operationId: 'create-1' },
        f.operatorCredential,
      )
    ).status,
  ).toBe(403);
  expect(f.readMemberEvents).not.toHaveBeenCalled();
});
