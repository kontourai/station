/**
 * #4515 fix round 3: the lowest seam of Station's own agent runtime. A run of
 * a Station agent (a temp agent created for an agent run, here) is refused
 * by the framework adapter itself while the managed policy does not allow
 * `station-agent`, before the model is called, so a route that skips its own
 * check still starts nothing. A utility agent (a title, a summary, the
 * approval guardian) is not Station's agent and still runs.
 */

import type { AgentSpec } from '@kontourai/station-contracts/agent';
import {
  parseManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import {
  type BaseModelConfig,
  type Message,
  Model,
  ModelContentBlockDeltaEvent,
  ModelContentBlockStartEvent,
  ModelContentBlockStopEvent,
  ModelMessageStartEvent,
  ModelMessageStopEvent,
  type ModelStreamEvent,
} from '@strands-agents/sdk';
import { MockLanguageModelV3 } from 'ai/test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import { installManagedEngineLimits } from '../../../security/managed-engine-limits.js';
import { StrandsFramework } from '../strands-adapter.js';
import { VoltAgentFramework } from '../voltagent-adapter.js';

const makeTempDir = trackTempDirs();
afterEach(() => {
  installManagedEngineLimits(null);
  vi.restoreAllMocks();
});

function install(allowed: string[]) {
  const parsed = parseManagedPolicyDocument({
    schemaVersion: 1,
    organization: 'Acme',
    limits: { engines: { allowed } },
  });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  installManagedEngineLimits({
    document: parsed.document,
    summary: summarizeManagedPolicy(parsed.document),
  });
}

const refused =
  /Acme's policy manages which engines run on this computer: station-agent is not allowed/;

function voltModel() {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  });
}

class TextModel extends Model {
  calls = 0;
  updateConfig(_config: BaseModelConfig): void {}
  getConfig(): BaseModelConfig {
    return { modelId: 'text-fixture' };
  }
  async *stream(_messages: Message[]): AsyncIterable<ModelStreamEvent> {
    this.calls += 1;
    yield new ModelMessageStartEvent({
      type: 'modelMessageStartEvent',
      role: 'assistant',
    });
    yield new ModelContentBlockStartEvent({
      type: 'modelContentBlockStartEvent',
      start: undefined,
    } as never);
    yield new ModelContentBlockDeltaEvent({
      type: 'modelContentBlockDeltaEvent',
      delta: { type: 'textDelta', text: 'ok' },
    });
    yield new ModelContentBlockStopEvent({
      type: 'modelContentBlockStopEvent',
    });
    yield new ModelMessageStopEvent({
      type: 'modelMessageStopEvent',
      stopReason: 'endTurn',
    });
  }
}

describe('VoltAgent', () => {
  const create = (purpose: 'agent-run' | 'utility') => {
    const model = voltModel();
    return new VoltAgentFramework()
      .createTempAgent({ purpose, name: 'gate', instructions: 'Hi.', model })
      .then((agent) => ({ agent, model }));
  };

  test('an agent run is refused before the model is called', async () => {
    install(['claude']);
    const { agent, model } = await create('agent-run');
    await expect(agent.generateText('hello')).rejects.toThrow(refused);
    await expect(agent.streamText('hello')).rejects.toThrow(refused);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(model.doStreamCalls).toHaveLength(0);
  });

  test('a utility still runs, and an allowed station-agent runs', async () => {
    install(['claude']);
    const utility = await create('utility');
    expect((await utility.agent.generateText('hello')).text).toBe('ok');
    install(['station-agent']);
    const run = await create('agent-run');
    expect((await run.agent.generateText('hello')).text).toBe('ok');
    expect(run.model.doGenerateCalls).toHaveLength(1);
  });
});

describe('VoltAgent registered Agent', () => {
  // Station registers the bare inner Agent (`raw`) as the live chat agent,
  // and runs scheduled jobs and `/invoke` through `activeAgents`.
  test('the wrapper and the registered raw Agent both refuse before the model is called', async () => {
    const framework = new VoltAgentFramework();
    const model = voltModel();
    vi.spyOn(framework, 'createModel').mockResolvedValue(model);
    vi.spyOn(framework, 'loadTools').mockResolvedValue([]);
    const projectHomeDir = makeTempDir('station-agent-run-gate-');
    const bundle = await framework.createAgent(
      'assistant',
      { name: 'assistant', prompt: 'Answer briefly.' } as AgentSpec,
      { appConfig: {} as never, projectHomeDir },
      {
        processedPrompt: 'Answer briefly.',
        memoryAdapter: new FileMemoryAdapter({ projectHomeDir }),
      } as never,
    );
    const raw = (bundle.agent as unknown as { raw: typeof bundle.agent }).raw;
    install(['claude']);
    await expect(bundle.agent.generateText('hello')).rejects.toThrow(refused);
    await expect(raw.generateText('hello')).rejects.toThrow(refused);
    await expect(raw.streamText('hello')).rejects.toThrow(refused);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(model.doStreamCalls).toHaveLength(0);
    install(['station-agent']);
    expect((await raw.generateText('hello')).text).toBe('ok');
  });
});

describe('Strands', () => {
  test('an agent run is refused before the model is called; a utility runs', async () => {
    install(['claude']);
    const model = new TextModel();
    const run = await new StrandsFramework().createTempAgent({
      purpose: 'agent-run',
      name: 'gate',
      instructions: 'Hi.',
      model,
      tools: [],
    });
    await expect(run.generateText('hello')).rejects.toThrow(refused);
    await expect(run.streamText('hello')).rejects.toThrow(refused);
    expect(model.calls).toBe(0);
    const utility = await new StrandsFramework().createTempAgent({
      purpose: 'utility',
      name: 'gate',
      instructions: 'Hi.',
      model,
      tools: [],
    });
    await utility.generateText('hello');
    expect(model.calls).toBe(1);
  });
});
