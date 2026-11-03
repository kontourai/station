import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Hono } from 'hono';
import { test, vi } from 'vitest';
import {
  createDelegationGroup,
  DelegationGroupBudgetInsufficientError,
} from '../../../../packages/sdk/src/client/delegation-groups.js';
import { createGateTestRegistry } from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { createDelegationGroupRoutes } from '../../../routes/orchestration/delegation-groups.js';
import {
  bindRuntimeLocalOperator,
  getRuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { DelegationGroupRuntime } from '../portable-group-runtime.js';
import { createSessionAgentResolver } from '../session-agent-resolution.js';
import {
  installControl,
  NOW,
  setup,
} from './delegation-source-fixtures/report.js';

test('underfunded three-seat admission refuses before Task or provider effects; funded two-seat control creates', async () => {
  const wallNow = Date.now;
  const h = await setup();
  const started = wallNow();
  vi.mocked(Date.now).mockImplementation(() => NOW + wallNow() - started);
  installControl(h);
  const bus = new EventBus();
  const eventStore = new EventStore(
    join(h.f.root, 'portable-execution.sqlite'),
  );
  const logger = { debug() {}, warn() {} };
  const relay = vi.fn<typeof fetch>(async () => {
    throw Error('reserved execution must not relay');
  });
  const adapter = new StationAgentAdapter({
    apiBase: 'http://report-control.test',
    hasAgent: () => true,
    eventBus: bus,
    approvalRegistry: new ApprovalRegistry(logger, { eventBus: bus }),
    fetch: relay,
  });
  const orchestration = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: bus,
    eventStore,
    logger,
    resolveSessionAgent: createSessionAgentResolver({
      loadAgentSpec: (slug) => h.f.loader.loadAgent(slug),
      resolveToolServer: async () => null,
      resolveSkillDir: async () => null,
    }),
  });
  const runtime = new DelegationGroupRuntime({
    runtime: h.preparationOwners.runtime,
    orchestration,
    rawFetch: h.rawFetch,
    delegationAttemptClaimStore: h.delegationAttemptClaimStore,
  });
  const stamped = getRuntimeAuthenticatedRequestPrincipal(h.f.req);
  assert.ok(stamped && stamped.kind !== 'internal');
  const app = new Hono();
  app.use('*', async (context, next) => {
    setRuntimeAuthenticatedRequestPrincipal(context.req.raw, {
      ...stamped,
      credential:
        context.req.header('Authorization')?.replace(/^Bearer /, '') ?? '',
    });
    if (context.req.header('X-Test-Operator') === 'yes')
      bindRuntimeLocalOperator(context.req.raw);
    await next();
  });
  app.route('/api/orchestration/groups', createDelegationGroupRoutes(runtime));
  const controlFetch = globalThis.fetch;
  const responses: { status: number; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (source, init) => {
      const request = new Request(source, init);
      if (
        !new URL(request.url).pathname.startsWith('/api/orchestration/groups')
      )
        return controlFetch(source, init);
      const response = await app.fetch(request);
      if (response.status === 409)
        responses.push({
          status: response.status,
          body: await response.clone().json(),
        });
      return response;
    }),
  );
  const base = 'http://report-control.test';
  const options = {
    headers: {
      Authorization: `Bearer ${h.f.paired.credential}`,
      'X-Test-Operator': 'yes',
    },
  };
  const starts = vi.spyOn(orchestration, 'startSessionInternal');
  const input = {
    ...h.input,
    operationId: 'underfunded-three',
    members: [
      ...h.input.members,
      {
        ...h.input.members[0],
        seatId: 'third',
        brief: 'Review aggregate limit',
      },
    ],
  };
  try {
    await assert.rejects(
      () => createDelegationGroup(base, input, options),
      (error: unknown) =>
        error instanceof DelegationGroupBudgetInsufficientError &&
        error.status === 409 &&
        error.code === 'group_budget_insufficient' &&
        error.failurePhase === 'refused',
    );
    assert.deepEqual(responses, [
      {
        status: 409,
        body: {
          success: false,
          code: 'group_budget_insufficient',
          failurePhase: 'refused',
        },
      },
    ]);
    assert.equal(starts.mock.calls.length, 0);
    assert.equal(h.rawFetch.mock.calls.length, 0);
    assert.equal(relay.mock.calls.length, 0);
    const funded = await createDelegationGroup(
      base,
      { ...h.input, operationId: 'funded-two' },
      options,
    );
    assert.equal(funded.group.members.length, 2);
    assert.equal(starts.mock.calls.length, 0);
    assert.equal(h.rawFetch.mock.calls.length, 0);
  } finally {
    await orchestration.shutdown();
    eventStore.close();
  }
}, 130_000);
