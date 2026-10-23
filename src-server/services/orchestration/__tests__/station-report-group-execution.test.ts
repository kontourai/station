import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Hono } from 'hono';
import { test, vi } from 'vitest';
import { createGateTestRegistry } from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { StationAgentAdapter } from '../../../providers/adapters/station-agent-adapter.js';
import { createReportGroupRoutes } from '../../../routes/orchestration/report-groups.js';
import { AnthropicSealedPreparation } from '../../../runtime/conversation/anthropic-sealed-preparation.js';
import {
  bindRuntimeLocalOperator,
  getRuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { ApprovalRegistry } from '../../approvals/approval-registry.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { createSessionAgentResolver } from '../session-agent-resolution.js';
import { StationReportGroupRuntime } from '../station-report-group-runtime.js';
import {
  installControl,
  NOW,
  newGrant,
  setup,
} from './delegation-source-fixtures/report.js';

type View = NonNullable<Awaited<ReturnType<StationReportGroupRuntime['get']>>>;
type Operation = Awaited<ReturnType<StationReportGroupRuntime['create']>>;

test('report HTTP owner runs configured seats through canonical tasks and retained tariffs; expired-profile replay reads without qualification or resend', async () => {
  const wallNow = Date.now;
  const h = await setup();
  const startedAt = wallNow();
  vi.mocked(Date.now).mockImplementation(() => NOW + wallNow() - startedAt);
  installControl(h);
  const bus = new EventBus();
  const eventStore = new EventStore(join(h.f.root, 'report-execution.sqlite'));
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
  const owners = {
    runtime: h.preparationOwners.runtime,
    orchestration,
    rawFetch: h.rawFetch,
  };
  const qualifies = vi.spyOn(AnthropicSealedPreparation, 'create');
  const stampedPrincipal = getRuntimeAuthenticatedRequestPrincipal(h.f.req);
  assert.ok(stampedPrincipal && stampedPrincipal.kind !== 'internal');
  const principal = { ...stampedPrincipal };
  function appFor(runtime: StationReportGroupRuntime | null) {
    const app = new Hono();
    // Controlled ingress stamps; current credential and scope checks remain real owners.
    app.use('*', async (c, next) => {
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        ...principal,
        credential:
          c.req.header('Authorization')?.replace(/^Bearer /, '') ?? '',
      });
      if (c.req.header('X-Test-Operator') === 'yes')
        bindRuntimeLocalOperator(c.req.raw);
      await next();
    });
    app.route(
      '/api/orchestration/report-groups',
      createReportGroupRoutes(runtime),
    );
    return app;
  }
  let app = appFor(new StationReportGroupRuntime(owners));
  const abort = new AbortController();
  const send = (
    method: 'GET' | 'POST',
    path = '',
    body?: unknown,
    credential = h.f.paired.credential,
    operator = true,
  ) =>
    app.request(
      `http://report-control.test/api/orchestration/report-groups${path}`,
      {
        method,
        signal: abort.signal,
        headers: {
          Authorization: `Bearer ${credential}`,
          'Content-Type': 'application/json',
          ...(operator ? { 'X-Test-Operator': 'yes' } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    assert.equal(qualifies.mock.calls.length, 0);
    assert.equal(
      (await send('POST', '', h.input, undefined, false)).status,
      503,
    );
    const response = await Promise.race([
      send('POST', '', h.input),
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => {
          abort.abort();
          reject(Error('report HTTP execution deadline'));
        }, h.input.deadlineAt - Date.now());
      }),
    ]);
    if (watchdog) clearTimeout(watchdog);
    const body = (await response.json()) as {
      success: boolean;
      data: Operation;
    };
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.success, true);
    const result = body.data;
    assert.equal(result.replayed, false);
    assert.equal(result.group.execution, 'returned');
    assert.equal(result.group.acceptance, 'unassessed');
    assert.equal(result.group.members.length, 2);
    assert.equal(h.rawFetch.mock.calls.length, 2);
    assert.equal(relay.mock.calls.length, 0);
    for (const member of result.group.members) {
      assert.equal(member.attempts.length, 1);
      assert.deepEqual(member.attempts[0].usage, {
        inputTokens: 4,
        outputTokens: 2,
        costMicros: 42,
      });
      assert.equal(member.attempts[0].accountingTerminal, true);
      assert.ok(member.attempts[0].terminal);
    }
    for (const privateValue of [
      'synthetic-not-a-live-key',
      'credentialDigest',
      'authenticated_principal_ref',
      'Configured report-only instructions',
      'Review correctness',
      h.f.root,
    ])
      assert.ok(!JSON.stringify(body).includes(privateValue), privateValue);
    assert.equal(qualifies.mock.calls.length, 1);
    vi.mocked(Date.now).mockReturnValue(Date.parse('2026-10-24T01:04:42Z'));
    await assert.rejects(() => AnthropicSealedPreparation.create(), {
      code: 'stale_contract',
    });
    const returning = newGrant(h);
    h.f.environment.devicePairing.revokeDevice(
      h.f.paired.device.id,
      'operator-credential',
    );
    app = appFor(new StationReportGroupRuntime(owners));
    assert.equal(qualifies.mock.calls.length, 2);
    const replayResponse = await send(
      'POST',
      '',
      h.input,
      returning.credential,
    );
    assert.equal(replayResponse.status, 200);
    const replay = (await replayResponse.json()) as { data: Operation };
    assert.equal(replay.data.replayed, true);
    assert.deepEqual(replay.data.group, result.group);
    assert.equal(qualifies.mock.calls.length, 2);
    const changed = await send(
      'POST',
      '',
      { ...h.input, maxConcurrent: 1 },
      returning.credential,
    );
    assert.equal(changed.status, 503);
    const groupId = result.group.groupId;
    assert.equal((await send('GET', `/${groupId}`)).status, 503);
    const inspected = await send(
      'GET',
      `/${groupId}`,
      undefined,
      returning.credential,
    );
    assert.equal(inspected.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(
      ((await inspected.json()) as { data: View }).data,
      result.group,
    );
    const list = await send('GET', '', undefined, returning.credential);
    assert.deepEqual(
      ((await list.json()) as { data: { groups: View[] } }).data.groups,
      [result.group],
    );
    const interrupt = vi.spyOn(orchestration, 'dispatchWithReceipt');
    const command = {
      operationKey: 'cancel-completed',
      expectedRevision: result.group.revision,
    };
    const cancelResponse = await send(
      'POST',
      `/${groupId}/cancel`,
      command,
      returning.credential,
    );
    assert.equal(cancelResponse.status, 200);
    const canceled = (await cancelResponse.json()) as {
      data: { cancellation: string; replayed: boolean };
    };
    assert.equal(canceled.data.cancellation, 'requested');
    assert.equal(canceled.data.replayed, false);
    const repeated = await send(
      'POST',
      `/${groupId}/cancel`,
      command,
      returning.credential,
    );
    assert.equal(
      ((await repeated.json()) as { data: { replayed: boolean } }).data
        .replayed,
      true,
    );
    const after = await send(
      'GET',
      `/${groupId}`,
      undefined,
      returning.credential,
    );
    const afterView = ((await after.json()) as { data: View }).data;
    assert.equal(afterView.authorityRevoked, true);
    assert.deepEqual(afterView.members, result.group.members);
    assert.equal(interrupt.mock.calls.length, 0);
    assert.equal(h.rawFetch.mock.calls.length, 2);
    app = appFor(null);
    assert.equal(
      (await send('GET', '', undefined, returning.credential)).status,
      503,
    );
  } finally {
    if (watchdog) clearTimeout(watchdog);
    abort.abort();
    await orchestration.shutdown();
    eventStore.close();
  }
}, 150_000);
