import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type FlowMultiCursorClaimEvent, loadRun } from '@kontourai/flow';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { Hono } from 'hono';
import { test, vi } from 'vitest';
import {
  createDelegationGroup,
  runDelegationGroup,
} from '../../../../packages/sdk/src/client/delegation-groups.js';
import { createGateTestRegistry } from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { loadOrCreateAgentRegistry } from '../../../domain/agent-registry.js';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { createDelegationGroupRoutes } from '../../../routes/orchestration/delegation-groups.js';
import { createRequestDelegationResolver } from '../../../runtime/agents/request-delegation.js';
import {
  createStationControlCallerRecordResolver,
  resolveStationControlCallerForRequest,
  stationControlCallerRecordSources,
} from '../../../runtime/mcp/station-control-caller.js';
import {
  mintStationControlMcpToken,
  revokeStationControlMcpToken,
} from '../../../runtime/mcp/station-control-mcp-token.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { createStationControlAuthorityGuard } from '../../../security/station-control-authority-guard.js';
import { STATION_CONTROL_CALLER_TOKEN_HEADER } from '../../../tools/station-control-shared.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
} from '../../../utils/internal-api-token.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import { isStationInternalRequest } from '../../browser/browser-request-origin.js';
import { ProjectManifestStore } from '../../projects/project-manifest-store.js';
import { ProjectMembershipService } from '../../projects/project-membership-service.js';
import { ProjectMembershipStore } from '../../projects/project-membership-store.js';
import { ProjectService } from '../../projects/project-service.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { DelegationGroupRuntime } from '../portable-group-runtime.js';
import { createSessionAgentResolver } from '../session-agent-resolution.js';
import { SESSION_LOCAL_PROJECT_ID_METADATA_KEY } from '../session-project-identity.js';
import { createReportFlow } from './delegation-source-fixtures/flow.js';
import {
  installControl,
  NOW,
  setup,
} from './delegation-source-fixtures/report.js';

test('bound Station Control SDK Flow follows actual frontier through a join', async () => {
  const wallNow = Date.now;
  const h = await setup();
  const started = wallNow();
  vi.mocked(Date.now).mockImplementation(() => NOW + wallNow() - started);
  installControl(h);
  const spec = await h.f.loader.loadAgent('reviewer');
  await h.f.loader.saveAgent('reviewer', { ...spec, project: 'source' });
  const person = humanPrincipal('test', 'group-owner', 'Group owner');
  const eventStore = new EventStore(join(h.f.root, 'portable-bound.sqlite'));
  const eventBus = new EventBus();
  const logger = { debug() {}, warn() {} };
  const relay = vi.fn<typeof fetch>(async () => {
    throw Error('unexpected relay');
  });
  const adapter = new StationAgentAdapter({
    apiBase: 'http://report-control.test',
    hasAgent: () => true,
    eventBus,
    approvalRegistry: new ApprovalRegistry(logger, { eventBus }),
    fetch: relay,
  });
  const orchestration = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus,
    eventStore,
    logger,
    resolveSessionAgent: createSessionAgentResolver({
      loadAgentSpec: (slug) => h.f.loader.loadAgent(slug),
      resolveToolServer: async () => null,
      resolveSkillDir: async () => null,
    }),
  });
  const db = new DatabaseSync(
    join(h.f.home, 'security', 'portable-membership.sqlite'),
  );
  const store = new ProjectMembershipStore(db, h.f.record.environmentId);
  const projects = new ProjectService(h.f.storage);
  const membership = new ProjectMembershipService(
    h.f.record.environmentId,
    h.f.storage,
    new ProjectManifestStore(h.f.home, h.f.storage),
    store,
  );
  const scope = {
    stationId: h.f.record.environmentId,
    localProjectId: 'persistent-local-project',
    localProjectSlug: 'source',
    portableProjectId: 'prj_persistent',
  };
  store.enable(scope, person);
  const addSession = (
    id: string,
    userId: string,
    facts: Record<string, unknown> = {},
  ) => {
    eventStore.appendEvent({
      eventId: `${id}:start`,
      threadId: id,
      sessionId: id,
      provider: 'claude',
      method: 'session.started',
      createdAt: new Date().toISOString(),
      metadata: {
        userId,
        agentSlug: 'reviewer',
        projectSlug: 'source',
        ...facts,
        [SESSION_LOCAL_PROJECT_ID_METADATA_KEY]: scope.localProjectId,
      },
    });
    eventStore.upsertSession({
      threadId: id,
      provider: 'claude',
      status: 'closed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  };
  addSession('bound-group-session', person.id);
  addSession('same-owner-other-session', person.id);
  addSession('malformed-lineage-session', person.id, {
    delegation: { mode: 'bad' },
  });
  addSession('exhausted-lineage-session', person.id, {
    delegation: {
      mode: 'isolated-child',
      depth: 2,
      maxDepth: 2,
      parentAgentSlug: 'reviewer',
      rootAgentSlug: 'reviewer',
    },
  });
  addSession('missing-agent-session', person.id, {
    agentSlug: 'missing-agent',
  });
  addSession(
    'foreign-group-session',
    humanPrincipal('test', 'foreign', 'Foreign').id,
  );
  const records = createStationControlCallerRecordResolver(
    stationControlCallerRecordSources({
      orchestrationService: orchestration,
      eventStore,
      getProject: (slug) => projects.getProject(slug),
      coordinatorEnabled: () => false,
    }),
  );
  const runtime = new DelegationGroupRuntime({
    runtime: h.preparationOwners.runtime,
    orchestration,
    rawFetch: h.rawFetch,
    delegationAttemptClaimStore: h.delegationAttemptClaimStore,
    resolveDelegation: createRequestDelegationResolver({
      isInternalRequest: isStationInternalRequest,
      resolveCaller: (request) =>
        resolveStationControlCallerForRequest(request, records),
      startedMetadata: (id) => orchestration.firstStartedMetadataOfThread(id),
      sessionEngine: (id) => orchestration.firstStartedEngineOfThread(id),
      loadAgentSpec: (slug) =>
        h.preparationOwners.runtime.agentService.getAgent(slug),
      isRegistryDefaultAgent: async (slug) =>
        (await loadOrCreateAgentRegistry(h.f.loader)).defaultAgents.some(
          (agent) => String(agent.id) === slug,
        ),
    }),
    stationControl: {
      orchestration,
      eventStore,
      projects,
      membership,
      coordinatorEnabled: () => false,
    },
  });
  const app = new Hono();
  app.use('*', async (context, next) => {
    setRuntimeAuthenticatedRequestPrincipal(context.req.raw, {
      kind: 'internal',
      credential: 'internal-token',
      authority: undefined,
      source: 'bearer',
      locality: 'home-possession',
    });
    await next();
  });
  app.use(
    '*',
    createStationControlAuthorityGuard({
      resolveCaller: (request) =>
        resolveStationControlCallerForRequest(request, records),
      isOperatorPrincipal: () => false,
    }),
  );
  app.route('/api/orchestration/groups', createDelegationGroupRoutes(runtime));
  const controlFetch = globalThis.fetch;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      return new URL(request.url).pathname.startsWith(
        '/api/orchestration/groups',
      )
        ? app.fetch(request)
        : controlFetch(input, init);
    }),
  );
  const options = (token: string) => ({
    headers: {
      [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
      [STATION_CONTROL_CALLER_TOKEN_HEADER]: token,
    },
  });
  const base = 'http://report-control.test';
  const flow = await createReportFlow(h.f, 'bound-portable-flow', [
    { id: 'left' },
    { id: 'right' },
    { id: 'join', needs: ['left', 'right'] },
  ]);
  const input = {
    ...h.input,
    deadlineAt: NOW + 240_000,
    budget: {
      inputTokens: 3 * 1048576,
      outputTokens: 30,
      costMicros: 3 * 3145878,
    },
    flow,
    members: [
      ...h.input.members,
      {
        ...h.input.members[0],
        seatId: 'join',
        brief: 'Review combined findings',
      },
    ],
  };
  try {
    const token = mintStationControlMcpToken(
      'bound-group-session',
      'sdk-in-process',
    ).token;
    const created = await createDelegationGroup(base, input, options(token));
    assert.equal(h.rawFetch.mock.calls.length, 0);
    const result = await runDelegationGroup(
      base,
      created.group.groupId,
      {
        operationId: 'bound-flow-run',
        expectedRevision: created.group.revision,
      },
      options(token),
    );
    assert.equal(result.group.execution, 'returned');
    assert.deepEqual(result.group.topology, {
      kind: 'flow',
      runId: flow.runId,
    });
    assert.equal(h.rawFetch.mock.calls.length, 3);
    assert.equal(relay.mock.calls.length, 0);
    const run = await loadRun(flow.runId, h.f.repo);
    assert.equal(run.state.status, 'completed');
    const history: FlowMultiCursorClaimEvent[] =
      run.state.multi_cursor.claim_history;
    const claimed = history.filter((event) => event.action === 'claimed');
    const settled = history.filter((event) => event.action === 'settled');
    assert.deepEqual(claimed.map((event) => event.step_id).sort(), [
      'join',
      'left',
      'right',
    ]);
    assert.deepEqual(
      settled.map((event) => event.claim_id).sort(),
      claimed.map((event) => event.claim_id).sort(),
    );
    const joinClaim = history.findIndex(
      (event) => event.action === 'claimed' && event.step_id === 'join',
    );
    for (const predecessor of ['left', 'right'])
      assert.ok(
        history.findIndex(
          (event) =>
            event.action === 'settled' && event.step_id === predecessor,
        ) < joinClaim,
      );
  } finally {
    revokeStationControlMcpToken('bound-group-session');
    await orchestration.shutdown();
    db.close();
    eventStore.close();
  }
}, 250_000);
