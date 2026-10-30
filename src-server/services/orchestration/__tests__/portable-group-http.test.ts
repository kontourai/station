import assert from 'node:assert/strict';
import { join } from 'node:path';
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

test('HTTP portable operator group runs actual source and exposes owned result and events', async () => {
  const wallNow = Date.now;
  const h = await setup();
  const started = wallNow();
  vi.mocked(Date.now).mockImplementation(() => NOW + wallNow() - started);
  installControl(h);
  const bus = new EventBus();
  const eventStore = new EventStore(join(h.f.root, 'portable-http.sqlite'));
  const logger = { debug() {}, warn() {} };
  const relay = vi.fn<typeof fetch>(async () => {
    throw Error('unexpected relay');
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
  const options = {
    headers: {
      Authorization: `Bearer ${h.f.paired.credential}`,
      'X-Test-Operator': 'yes',
    },
  };
  const base = 'http://report-control.test';
  const send = (
    method: 'GET' | 'POST',
    path: string,
    input?: unknown,
    operator = true,
  ) =>
    app.request(`http://report-control.test/api/orchestration/groups${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${h.f.paired.credential}`,
        ...(operator ? { 'X-Test-Operator': 'yes' } : {}),
        ...(input ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
  try {
    const denied = await send('POST', '', h.input, false);
    assert.equal(denied.status, 503);
    assert.equal(h.rawFetch.mock.calls.length, 0);
    const created = await createDelegationGroup(base, h.input, options);
    const groupId = created.group.groupId;
    const fetched = await getDelegationGroup(base, groupId, options);
    assert.equal(fetched.groupId, groupId);
    const finished = await runDelegationGroup(
      base,
      groupId,
      { operationId: 'run-1', expectedRevision: created.group.revision },
      options,
    );
    assert.equal(finished.group.execution, 'returned');
    assert.equal(h.rawFetch.mock.calls.length, 2);
    assert.equal(relay.mock.calls.length, 0);
    const events = await readDelegationGroupEvents(base, groupId, 0, options);
    assert.ok(events.events.length > 0);
    const output = await readDelegationGroupMemberOutput(
      base,
      groupId,
      'left',
      options,
    );
    assert.equal(output.text, 'Controlled report');
    const members = await readDelegationGroupMemberEvents(
      base,
      groupId,
      'left',
      0,
      options,
    );
    assert.equal(members.seatId, 'left');
    const listed = await listDelegationGroups(base, undefined, options);
    assert.equal(listed.groups.length, 1);
    const cancelled = await cancelDelegationGroup(
      base,
      groupId,
      { operationId: 'cancel-1', expectedRevision: finished.group.revision },
      options,
    );
    assert.equal(cancelled.group.terminal, 'unproven');
  } finally {
    eventStore.close();
  }
}, 130_000);
