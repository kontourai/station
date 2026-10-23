import assert from 'node:assert/strict';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDelegationAuthorityServiceV3 } from '@kontourai/flow-agents/delegation-authority-service-v3';
import { afterEach, test, vi } from 'vitest';
import { AnthropicSealedPreparation } from '../../../runtime/conversation/anthropic-sealed-preparation.js';
import { createLogger } from '../../../utils/logger.js';
import { AgentService } from '../../agents/agent-service.js';
import { StationDelegationPersistence } from '../delegation-group-persistence.js';
import {
  inspectSdkSourceWire,
  sdkDisposalPromise,
} from '../delegation-group-sdk-source-wire-owner.js';
import {
  type PreparedStationReportGroup,
  StationReportGroupPreparation,
} from '../station-report-group-preparation.js';
import { publicFenceFixture } from './delegation-source-fixtures/fence.js';
import { fixture } from './delegation-source-fixtures/source.js';

const NOW = Date.parse('2026-10-23T08:30:00Z');
afterEach(() => vi.restoreAllMocks());
async function setup(kind: 'local-grant' | 'ui-bootstrap' = 'local-grant') {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  const f = await fixture(kind);
  await f.loader.loadAppConfig();
  await f.storage.saveProviderConnection({
    id: 'anthropic-1',
    name: 'Controlled connection',
    type: 'anthropic',
    enabled: true,
    capabilities: ['llm'],
    config: {
      apiKey: 'synthetic-not-a-live-key',
      baseUrl: 'https://api.anthropic.com/v1',
    },
  });
  await f.loader.saveAgent('reviewer', {
    name: 'Reviewer',
    prompt: 'Configured report-only instructions',
    execution: {
      modelConnectionId: 'anthropic-1',
      modelId: 'claude-sonnet-4-6',
    },
  });
  const agentService = new AgentService(
    f.loader,
    f.storage,
    new Map(),
    new Map(),
    new Map(),
    createLogger({ name: 'report-group-fixture', level: 'error' }),
  );
  const rawFetch = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          id: 'msg-controlled',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'Controlled report' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: 4,
            output_tokens: 2,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
  );
  const owner = new StationReportGroupPreparation({
    runtime: {
      configLoader: f.loader,
      storageAdapter: f.storage,
      environmentSecurityService: f.environment,
      requestSecurity: f.environment,
      agentService,
      runtime: {
        getAgentConfigurationRevision: () => 2,
        commitAgentConfigurationRead: async (_revision, work) => work(),
      },
    },
    sources: f.owner,
    qualification: await AnthropicSealedPreparation.create(),
    rawFetch,
  });
  const input = {
    operationId: 'prepare-1',
    projectSlug: 'source',
    resourceId: 'local:source',
    deadlineAt: NOW + 120000,
    maxConcurrent: 2,
    budget: {
      inputTokens: 2 * 1048576,
      outputTokens: 20,
      costMicros: 2 * 3145878,
    },
    members: [
      {
        seatId: 'left',
        agentId: 'reviewer',
        brief: 'Review correctness',
        maxOutputTokens: 10,
      },
      {
        seatId: 'right',
        agentId: 'reviewer',
        brief: 'Review failure paths',
        maxOutputTokens: 10,
      },
    ],
  };
  return { f, owner, input, rawFetch };
}

test('authenticated preparation issues exact source/task envelopes consumed by the published durable v3 authority', async () => {
  const h = await setup();
  const handle = await h.owner.prepare(h.f.context(), h.input);
  try {
    const prepared = h.owner.read(handle, h.f.req);
    assert.equal(prepared.root.issuer_host_id, h.f.record.environmentId);
    assert.equal(
      prepared.root.authenticated_principal_ref.id,
      'human:local:operator',
    );
    assert.equal(prepared.envelopes.length, 3);
    assert.equal(prepared.members.length, 2);
    assert.equal(new Set(prepared.members.map((m) => m.taskId)).size, 2);
    for (const member of prepared.members)
      assert.match(member.taskId, /^task:[0-9a-f-]{36}$/);
    assert.deepEqual(
      prepared.spec.seats.map((s) => s.allocation),
      [
        { inputTokens: 1048576, outputTokens: 10, costMicros: 3145878 },
        { inputTokens: 1048576, outputTokens: 10, costMicros: 3145878 },
      ],
    );
    assert.ok(!JSON.stringify(prepared).includes('synthetic-not-a-live-key'));
    const persistence = new StationDelegationPersistence(h.f.root);
    const current = (): undefined => {
      h.owner.read(handle, h.f.req);
      return undefined;
    };
    const service = createDelegationAuthorityServiceV3(
      persistence.roundsAuthorityStore(current),
      {
        now: () => new Date(Date.now()).toISOString(),
        authorize: async (_action, root, envelope) =>
          h.owner.authorizes(handle, h.f.req, root, envelope),
        confirmExecution: async (envelope) =>
          h.owner.confirmsExecution(handle, h.f.req, envelope),
        authenticateRenewal: async () => null,
      },
      { maxRenewals: 0 },
    );
    await service.issue(prepared.root);
    for (const envelope of prepared.envelopes)
      await service.derive(prepared.root.authority_id, envelope);
    await service.reserveInvocation(
      prepared.root.authority_id,
      prepared.envelopes[1].envelope_id,
      'first-reservation',
      prepared.spec.seats[0].allocation,
    );
    const ledger = await service.inspect(prepared.root.authority_id);
    assert.equal(ledger.envelopes.length, 3);
    assert.equal(ledger.invocations.length, 1);
    assert.equal(ledger.invocations[0].usage, null);
    assert.equal(ledger.invocations[0].terminal, false);
    assert.equal(h.rawFetch.mock.calls.length, 0);
    const changed = structuredClone(prepared.root);
    changed.budget.max_cost_micros++;
    assert.equal(h.owner.authorizes(handle, h.f.req, changed, null), false);
    prepared.root.budget.max_cost_micros = 0;
    assert.equal(
      h.owner.read(handle, h.f.req).root.budget.max_cost_micros,
      6291756,
    );
  } finally {
    h.owner.close(handle);
  }
});

test('same Request and intent joins one preparation; changed intent, foreign Request and copied capability refuse', async () => {
  const h = await setup();
  const [a, b] = await Promise.all([
    h.owner.prepare(h.f.context(), h.input),
    h.owner.prepare(h.f.context(), h.input),
  ]);
  try {
    assert.equal(a, b);
    await assert.rejects(() =>
      h.owner.prepare(h.f.context(), { ...h.input, maxConcurrent: 1 }),
    );
    await assert.rejects(() =>
      h.owner.prepare(h.f.context(h.f.request()), h.input),
    );
    assert.throws(() => h.owner.read(JSON.parse('{}'), h.f.req));
    assert.equal(h.rawFetch.mock.calls.length, 0);
  } finally {
    h.owner.close(a);
  }
});

test('snapshot receipt deletion refuses execution confirmation without inventing stopped work', async () => {
  const h = await setup();
  const handle = await h.owner.prepare(h.f.context(), h.input);
  try {
    const prepared = h.owner.read(handle, h.f.req);
    const envelope = prepared.envelopes[1];
    assert.equal(h.owner.confirmsExecution(handle, h.f.req, envelope), true);
    unlinkSync(
      join(
        h.f.store,
        `snapshot-${envelope.execution_binding.source.source_admission_receipt.id}.json`,
      ),
    );
    assert.throws(() => h.owner.confirmsExecution(handle, h.f.req, envelope));
    assert.equal(h.rawFetch.mock.calls.length, 0);
  } finally {
    h.owner.close(handle);
  }
});

test('aggregate operator budget too small for the immutable roster refuses before any provider request', async () => {
  const h = await setup();
  await assert.rejects(() =>
    h.owner.prepare(h.f.context(), {
      ...h.input,
      budget: { inputTokens: 1048576, outputTokens: 10, costMicros: 3145878 },
    }),
  );
  assert.equal(h.rawFetch.mock.calls.length, 0);
});

test('bootstrap credentials cannot issue an operator report root', async () => {
  const h = await setup('ui-bootstrap');
  await assert.rejects(() => h.owner.prepare(h.f.context(), h.input));
  assert.equal(h.rawFetch.mock.calls.length, 0);
});

test('current operator revocation invalidates the prepared root and reserved member access', async () => {
  const h = await setup();
  let handle: PreparedStationReportGroup | undefined;
  try {
    handle = await h.owner.prepare(h.f.context(), h.input);
    assert.equal(h.owner.read(handle, h.f.req).members.length, 2);
    h.f.environment.devicePairing.revokeDevice(
      h.f.paired.device.id,
      'operator-credential',
    );
    assert.throws(() => h.owner.read(handle!, h.f.req));
    assert.throws(() => h.owner.sdk(handle!, h.f.req, 'left'));
    assert.equal(h.rawFetch.mock.calls.length, 0);
  } finally {
    if (handle) h.owner.close(handle);
  }
});

test('issued preparation reaches the reserved Station session and retained accounting without synthetic root grants', async () => {
  const h = await setup();
  const input = {
    ...h.input,
    maxConcurrent: 1,
    members: h.input.members.slice(0, 1),
  };
  const handle = await h.owner.prepare(h.f.context(), input);
  try {
    const prepared = h.owner.read(handle, h.f.req);
    const sdk = h.owner.sdk(handle, h.f.req, 'left');
    const captured = inspectSdkSourceWire(sdk.owner, sdk.sdkHandle);
    const driver = await publicFenceFixture(
      h.f,
      captured.sourceBinding.source,
      sdk.owner,
      sdk.sdkHandle,
      captured.wire,
      () => {},
      {
        protocol: 'rounds',
        provider: 'anthropic',
        modelId: prepared.members[0].modelId,
        allocation: prepared.spec.seats[0].allocation,
        contract: captured.contract,
        now: Date.now,
        preparedGroup: { owner: h.owner, handle },
      },
    );
    assert.equal(h.rawFetch.mock.calls.length, 0);
    await driver.run();
    assert.equal(
      h.rawFetch.mock.calls.length,
      1,
      String(driver.invocationFailure),
    );
    assert.equal(driver.relayCalls, 0);
    const ledger = await driver.ledger();
    assert.equal(ledger.root.authority_id, prepared.root.authority_id);
    assert.equal(ledger.envelopes[1].execution_id, prepared.members[0].taskId);
    assert.deepEqual(ledger.invocations[0].usage, {
      inputTokens: 4,
      outputTokens: 2,
      costMicros: 42,
    });
    assert.ok(
      driver.canonicalEvents().some((e) => e.method === 'turn.completed'),
    );
    await sdkDisposalPromise(sdk.owner, sdk.sdkHandle);
  } finally {
    h.owner.close(handle);
  }
});

test('source changes between member seals cannot produce a mixed-source report root', async () => {
  const h = await setup();
  const capture = h.f.owner.captureSnapshot.bind(h.f.owner);
  let seals = 0;
  h.f.owner.captureSnapshot = async (...args) => {
    if (++seals === 2) {
      writeFileSync(join(h.f.repo, 'source.txt'), 'changed between members\n');
      await h.f.git('add', '--', 'source.txt');
      await h.f.git('commit', '-qm', 'Controlled changed source');
    }
    return capture(...args);
  };
  await assert.rejects(() => h.owner.prepare(h.f.context(), h.input), {
    code: 'group_preparation_unavailable',
  });
  assert.equal(seals, 2);
  assert.equal(h.rawFetch.mock.calls.length, 0);
});

test('removing orchestration operation scope invalidates report preparation authority', async () => {
  const h = await setup();
  const handle = await h.owner.prepare(h.f.context(), h.input);
  try {
    assert.equal(h.owner.read(handle, h.f.req).members.length, 2);
    h.f.environment.devicePairing.setDeviceScope(
      h.f.paired.device.id,
      ['orchestration:read'],
      { kind: 'presented-credential' },
    );
    assert.throws(() => h.owner.read(handle, h.f.req));
    assert.equal(h.rawFetch.mock.calls.length, 0);
  } finally {
    h.owner.close(handle);
  }
});
