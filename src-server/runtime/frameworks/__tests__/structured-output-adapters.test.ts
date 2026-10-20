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
  type StreamOptions,
} from '@strands-agents/sdk';
import { jsonSchema, zodSchema } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { StrandsFramework } from '../strands-adapter.js';
import { VoltAgentFramework } from '../voltagent-adapter.js';

const schema = {
  type: 'object' as const,
  additionalProperties: false,
  required: ['title'],
  properties: { title: { type: 'string' as const } },
};

test('VoltAgent requires a schema and forwards output limits and cancellation to the model', async () => {
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: '{"title":"Tour"}' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  });
  const agent = await new VoltAgentFramework().createTempAgent({
    name: 'structure',
    instructions: 'Return JSON.',
    model,
    tools: [],
    maxSteps: 1,
  });
  await expect(agent.generateObject!('Title')).rejects.toThrow(
    'requires structuredOutputSchema',
  );
  expect(model.doGenerateCalls).toHaveLength(0);
  const controller = new AbortController();
  const result = await agent.generateObject!('Title', {
    structuredOutputSchema: jsonSchema(schema),
    signal: controller.signal,
    maxOutputTokens: 77,
    conversationId: 'structure-test',
    userId: 'owner',
  });
  expect(result.object).toEqual({ title: 'Tour' });
  expect(model.doGenerateCalls[0]).toMatchObject({
    responseFormat: { type: 'json' },
    maxOutputTokens: 77,
  });
  controller.abort();
  expect(model.doGenerateCalls[0]?.abortSignal?.aborted).toBe(true);
});

class StructuredModel extends Model {
  readonly tools: unknown[] = [];
  updateConfig(_config: BaseModelConfig): void {}
  getConfig(): BaseModelConfig {
    return { modelId: 'structured-fixture' };
  }
  async *stream(
    _messages: Message[],
    options?: StreamOptions,
  ): AsyncIterable<ModelStreamEvent> {
    this.tools.push(options?.toolSpecs);
    if (this.tools.length > 2)
      throw new Error('Structured fixture exceeded its call budget');
    yield new ModelMessageStartEvent({
      type: 'modelMessageStartEvent',
      role: 'assistant',
    });
    yield new ModelContentBlockStartEvent({
      type: 'modelContentBlockStartEvent',
      start: {
        type: 'toolUseStart',
        toolUseId: 'structured',
        name: 'strands_structured_output',
      },
    });
    yield new ModelContentBlockDeltaEvent({
      type: 'modelContentBlockDeltaEvent',
      delta: { type: 'toolUseInputDelta', input: '{"title":"Tour"}' },
    });
    yield new ModelContentBlockStopEvent({
      type: 'modelContentBlockStopEvent',
    });
    yield new ModelMessageStopEvent({
      type: 'modelMessageStopEvent',
      stopReason: 'toolUse',
    });
  }
}
test.each([
  ['AI SDK JSON schema', jsonSchema(schema)],
  ['AI SDK Zod wrapper', zodSchema(z.object({ title: z.string() }))],
  ['Zod', z.object({ title: z.string() })],
])(
  'Strands produces structured output from %s with its real SDK',
  async (_name, structuredOutputSchema) => {
    const model = new StructuredModel();
    const agent = await new StrandsFramework().createTempAgent({
      name: 'structure',
      instructions: 'Return JSON.',
      model,
      tools: [],
    });
    const result = await agent.generateObject!('Title', {
      structuredOutputSchema,
    });
    expect(result.object).toEqual({ title: 'Tour' });
    expect(model.tools).toHaveLength(1);
  },
);
