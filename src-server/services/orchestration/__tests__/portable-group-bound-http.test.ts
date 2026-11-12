import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { Hono } from 'hono';
import { test, vi } from 'vitest';
import {
  cancelDelegationGroup,
  createDelegationGroup,
  getDelegationGroup,
  listDelegationGroups,
  readDelegationGroupEvents,
  readDelegationGroupMemberEvents,
  readDelegationGroupMemberOutput,
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
import {
  installControl,
  NOW,
  setup,
} from './delegation-source-fixtures/report.js';

test('guarded Session owner creates and reads its own V2 group across token rotation', async () => {
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
  let revokeDuringTargetRead = false;
  let observedTargetToken: string | null = null;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      if (
        revokeDuringTargetRead &&
        new URL(request.url).pathname === '/api/agents/reviewer'
      ) {
        observedTargetToken = request.headers.get(
          STATION_CONTROL_CALLER_TOKEN_HEADER,
        );
        revokeDuringTargetRead = false;
        revokeStationControlMcpToken('same-owner-other-session');
      }
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
  try {
    for (const session of [
      'malformed-lineage-session',
      'exhausted-lineage-session',
      'missing-agent-session',
    ]) {
      const token = mintStationControlMcpToken(session, 'sdk-in-process').token;
      await assert.rejects(() =>
        createDelegationGroup(base, h.input, options(token)),
      );
      assert.equal(h.rawFetch.mock.calls.length, 0);
    }
    const first = mintStationControlMcpToken(
      'bound-group-session',
      'sdk-in-process',
    ).token;
    const created = await createDelegationGroup(base, h.input, options(first));
    assert.equal(h.rawFetch.mock.calls.length, 0);
    const groupId = created.group.groupId;
    const other = mintStationControlMcpToken(
      'same-owner-other-session',
      'sdk-in-process',
    ).token;
    await assert.rejects(() =>
      getDelegationGroup(base, groupId, options(other)),
    );
    const secondGroup = await createDelegationGroup(
      base,
      h.input,
      options(other),
    );
    assert.notEqual(secondGroup.group.groupId, groupId);
    const ownList = await listDelegationGroups(base, undefined, options(first));
    assert.deepEqual(
      ownList.groups.map((group) => group.groupId),
      [groupId],
    );
    const foreign = mintStationControlMcpToken(
      'foreign-group-session',
      'sdk-in-process',
    ).token;
    await assert.rejects(() =>
      getDelegationGroup(base, groupId, options(foreign)),
    );
    revokeStationControlMcpToken('bound-group-session');
    await assert.rejects(() =>
      getDelegationGroup(base, groupId, options(first)),
    );
    const rotated = mintStationControlMcpToken(
      'bound-group-session',
      'sdk-in-process',
    ).token;
    assert.equal(
      (await getDelegationGroup(base, groupId, options(rotated))).groupId,
      groupId,
    );
    const result = await runDelegationGroup(
      base,
      groupId,
      { operationId: 'run-bound', expectedRevision: created.group.revision },
      options(rotated),
    );
    assert.equal(result.group.execution, 'returned');
    assert.deepEqual(
      result.group.accounting?.knownTerminalUsage && {
        inputTokens: result.group.accounting.knownTerminalUsage.inputTokens,
        outputTokens: result.group.accounting.knownTerminalUsage.outputTokens,
      },
      { inputTokens: 8, outputTokens: 4 },
    );
    assert.deepEqual(result.group.accounting?.unsettledAllocation, {
      inputTokens: 0,
      outputTokens: 0,
      costMicros: 0,
    });
    assert.ok(
      (await readDelegationGroupEvents(base, groupId, 0, options(rotated)))
        .events.length,
    );
    assert.equal(
      (
        await readDelegationGroupMemberOutput(
          base,
          groupId,
          'left',
          options(rotated),
        )
      ).text,
      'Controlled report',
    );
    assert.equal(
      (
        await readDelegationGroupMemberEvents(
          base,
          groupId,
          'left',
          0,
          options(rotated),
        )
      ).seatId,
      'left',
    );
    const cancelled = await cancelDelegationGroup(
      base,
      groupId,
      { operationId: 'cancel-bound', expectedRevision: result.group.revision },
      options(rotated),
    );
    assert.equal(cancelled.group.terminal, 'unproven');
    revokeDuringTargetRead = true;
    await assert.rejects(() =>
      runDelegationGroup(
        base,
        secondGroup.group.groupId,
        {
          operationId: 'run-revoked',
          expectedRevision: secondGroup.group.revision,
        },
        options(other),
      ),
    );
    assert.equal(observedTargetToken, other);
    assert.equal(revokeDuringTargetRead, false);
    assert.equal(h.rawFetch.mock.calls.length, 2);

    assert.equal(h.rawFetch.mock.calls.length, 2);
    assert.equal(relay.mock.calls.length, 0);
    assert.equal(
      (await getDelegationGroup(base, groupId, options(rotated))).groupId,
      groupId,
    );
  } finally {
    await orchestration.shutdown();
    db.close();
    eventStore.close();
  }
}, 130_000);
