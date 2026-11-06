/**
 * #4521: `limits.telemetry: false` stops VoltAgent's own remote export.
 *
 * The real `@voltagent/core` is given VoltOps keys in the environment, which
 * it reads itself to configure a global VoltOps client. The client class's
 * API URL is pointed at a local recorder before anything is constructed (the
 * only redirection; the exporters, processors and client are the
 * dependency's own). VoltAgent logs while it is being constructed, so its
 * log exporter initializes then: redirecting afterwards would miss it. An agent then runs and a
 * log record is emitted, and both are flushed. Without a policy (the control)
 * the recorder receives the trace and log exports; under the limit it
 * receives nothing.
 */
import { createServer } from 'node:http';
import {
  parseManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';

import {
  Agent,
  AgentRegistry,
  VoltAgent,
  VoltOpsClient,
} from '@voltagent/core';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { installManagedCapabilityLimits } from '../../../security/managed-capability-limits.js';
import { installManagedVoltAgentObservability } from '../voltagent-observability.js';

const cleanups: Array<() => Promise<void> | void> = [];
const savedEnv = {
  publicKey: process.env.VOLTAGENT_PUBLIC_KEY,
  secretKey: process.env.VOLTAGENT_SECRET_KEY,
};

function resetVoltAgentGlobals() {
  const registry = AgentRegistry.getInstance();
  registry.setGlobalObservability(undefined as never);
  registry.setGlobalVoltOpsClient(undefined as never);
}

beforeEach(() => {
  resetVoltAgentGlobals();
  process.env.VOLTAGENT_PUBLIC_KEY = 'pk_station_probe';
  process.env.VOLTAGENT_SECRET_KEY = 'sk_station_probe';
});

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
  vi.restoreAllMocks();
  installManagedCapabilityLimits(null);
  resetVoltAgentGlobals();
  for (const [key, value] of [
    ['VOLTAGENT_PUBLIC_KEY', savedEnv.publicKey],
    ['VOLTAGENT_SECRET_KEY', savedEnv.secretKey],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function recorder() {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    response.setHeader('content-type', 'application/json');
    response.end('{}');
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanups.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no TCP');
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

function installTelemetryOff() {
  const parsed = parseManagedPolicyDocument({
    schemaVersion: 1,
    organization: 'Acme',
    limits: { telemetry: false },
  });
  if (!parsed.ok) throw new Error('fixture policy refused');
  installManagedCapabilityLimits({
    summary: summarizeManagedPolicy(parsed.document),
  });
}

function mockModel() {
  return new MockLanguageModelV3({
    doGenerate: {
      content: [{ type: 'text', text: 'ok' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    },
  });
}

/**
 * The order `initializeRuntime` uses: managed observability first, then the
 * agents, then `new VoltAgent(...)` given that observability.
 */
async function runAgentAndLog(sinkUrl: string) {
  vi.spyOn(VoltOpsClient.prototype, 'getApiUrl').mockReturnValue(sinkUrl);
  const managed = installManagedVoltAgentObservability();
  const agent = new Agent({
    id: 'probe',
    name: 'probe',
    instructions: 'Reply once.',
    model: mockModel(),
    memory: false,
    summarization: false,
    workspace: false,
    workspaceSkillsPrompt: false,
    toolRouting: false,
    feedback: false,
    maxSteps: 1,
    maxRetries: 0,
  });
  new VoltAgent({
    agents: { probe: agent },
    ...(managed ? { observability: managed } : {}),
  });
  const registry = AgentRegistry.getInstance();
  // The dependency configured this client from the environment keys.
  const client = registry.getGlobalVoltOpsClient();
  expect(client).toBeDefined();
  if (!client) throw new Error('VoltAgent did not read the environment keys');
  expect(client.getApiUrl()).toBe(sinkUrl);
  const observability = registry.getGlobalObservability();
  if (!observability) throw new Error('no VoltAgent observability');
  cleanups.push(() => observability.shutdown());

  const result = await agent.generateText('hello');
  expect(result.text).toBe('ok');
  observability
    .getLoggerProvider()
    .getLogger('station-probe')
    .emit({ body: 'station probe log record' });
  await observability.forceFlush();
}

test('without a policy the VoltOps exporters reach the recorder (control)', async () => {
  const sink = await recorder();
  await runAgentAndLog(sink.url);
  await expect
    .poll(() => [...new Set(sink.requests)].sort(), { timeout: 10_000 })
    .toEqual([
      'POST /api/public/otel/v1/logs',
      'POST /api/public/otel/v1/traces',
    ]);
});

test('under limits.telemetry: false VoltAgent sends no traces or logs', async () => {
  installTelemetryOff();
  const sink = await recorder();
  await runAgentAndLog(sink.url);
  // The lazy remote processors poll for a client every 100ms for 5 seconds;
  // wait past one batch window so a late initialization would still show.
  await new Promise((done) => setTimeout(done, 1_500));
  await AgentRegistry.getInstance().getGlobalObservability()?.forceFlush();
  expect(sink.requests).toEqual([]);
});
