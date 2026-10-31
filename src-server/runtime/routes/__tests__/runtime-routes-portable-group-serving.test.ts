import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import {
  createDelegationGroup,
  getDelegationGroup,
  readDelegationGroupMemberOutput,
  runDelegationGroup,
} from '@kontourai/station-sdk/client';
import { test, vi } from 'vitest';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { LOCAL_OPERATOR_PRINCIPAL_ID } from '../../../services/identity/principal-resolver.js';
import {
  NOW,
  setup,
} from '../../../services/orchestration/__tests__/delegation-source-fixtures/report.js';
import { controlledTextStream } from '../../../services/orchestration/__tests__/delegation-source-fixtures/streamed-text.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { SESSION_LOCAL_PROJECT_ID_METADATA_KEY } from '../../../services/orchestration/session-project-identity.js';
import { STATION_CONTROL_CALLER_TOKEN_HEADER } from '../../../tools/station-control-shared.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../utils/internal-api-token.js';
import { StationRuntime } from '../../bootstrap/station-runtime.js';
import {
  mintStationControlMcpToken,
  revokeStationControlMcpToken,
} from '../../mcp/station-control-mcp-token.js';

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

// Real bootstrap/configuration lease, ingress, route factory and task owners.
// Provider responses are controlled; the fixed historical qualification clock
// does not establish current-date provider availability.
test('bootstrap factory serves a guarded caller through actual group source and task owners', async () => {
  const wallNow = Date.now;
  const h = await setup();
  const output = `${'\u0001'.repeat(32767)}😀${'\u0001'.repeat(20000)}`;
  h.rawFetch.mockImplementation(async () =>
    controlledTextStream('anthropic', 'claude-sonnet-4-6', output, {
      input_tokens: 4,
      output_tokens: 54000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }),
  );
  vi.stubEnv('STATION_HOME', h.f.home);
  vi.stubEnv('STATION_INSTANCE', 'child-work-factory');
  const began = wallNow();
  vi.mocked(Date.now).mockImplementation(() => NOW + wallNow() - began);
  const reviewer = await h.f.loader.loadAgent('reviewer');
  await h.f.loader.saveAgent('reviewer', {
    ...reviewer,
    project: 'source',
  });
  await h.f.storage.saveProviderConnection({
    id: 'anthropic-1',
    name: 'Controlled connection',
    type: 'anthropic',
    enabled: true,
    capabilities: ['llm'],
    config: {
      apiKey: 'synthetic-not-a-live-key',
    },
  });
  await h.f.loader.saveAppConfig({
    ...(await h.f.loader.loadAppConfig()),
    defaultLLMProvider: 'anthropic-1',
    defaultModel: 'claude-sonnet-4-6',
    invokeModel: '',
    structureModel: '',
    lanDiscoveryEnabled: false,
  });
  const port = await availablePort();
  const base = `http://127.0.0.1:${port}`;
  const network = globalThis.fetch;
  let catalogRequests = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (
        url.hostname === 'api.anthropic.com' &&
        url.pathname === '/v1/models' &&
        request.method === 'GET'
      ) {
        catalogRequests++;
        return Response.json({
          data: [
            {
              id: 'claude-sonnet-4-6',
              type: 'model',
              display_name: 'Controlled Sonnet',
              created_at: '2026-02-17T00:00:00Z',
            },
          ],
          has_more: false,
        });
      }
      if (
        url.hostname === 'api.anthropic.com' &&
        url.pathname === '/v1/messages'
      )
        return h.rawFetch(input, init);
      if (
        ['127.0.0.1', 'localhost'].includes(url.hostname) &&
        url.port === String(port)
      )
        return network(input, init);
      throw Error(
        `Unexpected bootstrap fixture network: ${url.origin}${url.pathname}`,
      );
    }),
  );
  const runtime = new StationRuntime({
    projectHomeDir: h.f.home,
    port,
    host: '127.0.0.1',
    projectSharing: true,
    logLevel: 'error',
  });
  try {
    await runtime.initialize();
    assert.ok(
      catalogRequests > 0,
      'bootstrap must use the actual provider inventory reader',
    );
    assert.equal(
      h.rawFetch.mock.calls.length,
      0,
      'bootstrap must not invoke the model',
    );
    const storage = Reflect.get(runtime, 'storageAdapter');
    assert.ok(storage instanceof FileStorageAdapter);
    const project = storage.getProject('source');
    const enabled = await fetch(`${base}/api/projects/source/access/enable`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${h.f.paired.credential}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ localProjectId: project.id }),
    });
    assert.equal(enabled.status, 200, await enabled.text());
    const events = Reflect.get(runtime, 'orchestrationEventStore');
    assert.ok(events instanceof EventStore);
    events.appendEvent({
      eventId: 'factory-parent:start',
      threadId: 'factory-parent',
      sessionId: 'factory-parent',
      provider: 'claude',
      method: 'session.started',
      createdAt: new Date().toISOString(),
      metadata: {
        userId: LOCAL_OPERATOR_PRINCIPAL_ID,
        agentSlug: 'reviewer',
        projectSlug: 'source',
        [SESSION_LOCAL_PROJECT_ID_METADATA_KEY]: project.id,
      },
    });
    events.upsertSession({
      threadId: 'factory-parent',
      provider: 'claude',
      status: 'closed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const token = mintStationControlMcpToken(
      'factory-parent',
      'sdk-in-process',
    ).token;
    const options = {
      headers: {
        [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
        [INTERNAL_PROXY_CALLER_HEADER]: 'local',
        [STATION_CONTROL_CALLER_TOKEN_HEADER]: token,
      },
    };
    const created = await createDelegationGroup(
      base,
      {
        ...h.input,
        budget: {
          inputTokens: 2 * 1048576,
          outputTokens: 2 * 64000,
          costMicros: 2 * (1048576 * 3 + 64000 * 15),
        },
        members: h.input.members.map((member) => ({
          ...member,
          maxOutputTokens: 64000,
        })),
      },
      options,
    );
    assert.equal(
      (await getDelegationGroup(base, created.group.groupId, options)).groupId,
      created.group.groupId,
    );
    const result = await runDelegationGroup(
      base,
      created.group.groupId,
      { operationId: 'factory-run', expectedRevision: created.group.revision },
      options,
    );
    assert.equal(result.group.execution, 'returned');
    assert.equal(h.rawFetch.mock.calls.length, 2, JSON.stringify(result.group));
    assert.equal(
      result.group.accounting?.knownTerminalUsage.inputTokens,
      8,
      JSON.stringify(result.group),
    );
    assert.equal(
      result.group.accounting?.knownTerminalUsage.outputTokens,
      108000,
    );
    assert.deepEqual(result.group.accounting?.unsettledAllocation, {
      inputTokens: 0,
      outputTokens: 0,
      costMicros: 0,
    });
    assert.deepEqual(result.group.members[0]?.selection, {
      agentId: 'reviewer',
      runtimeProtocol: 'station.sealed-sdk.runtime.v1',
      provider: 'anthropic',
      modelId: 'claude-sonnet-4-6',
    });
    const first = await readDelegationGroupMemberOutput(
      base,
      created.group.groupId,
      'left',
      options,
    );
    assert.equal(first.afterCodeUnit, 0);
    assert.equal(first.nextCodeUnit, 32767);
    assert.equal(first.hasMore, true);
    const last = await readDelegationGroupMemberOutput(
      base,
      created.group.groupId,
      'left',
      { ...options, afterCodeUnit: first.nextCodeUnit },
    );
    assert.equal(last.hasMore, false);
    assert.equal(last.nextCodeUnit, output.length);
    assert.equal(first.text + last.text, output);
    assert.equal(last.invocationId, first.invocationId);
    assert.deepEqual(last.usage, first.usage);
    await assert.rejects(() =>
      readDelegationGroupMemberOutput(base, created.group.groupId, 'left', {
        ...options,
        afterCodeUnit: 32768,
      }),
    );
  } finally {
    revokeStationControlMcpToken('factory-parent');
    await runtime.shutdown();
  }
}, 130_000);
