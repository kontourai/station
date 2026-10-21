import type { LanguageModelV3 } from '@ai-sdk/provider';
import { Agent, createTool } from '@voltagent/core';
import { z } from 'zod';
import { captureEntry, type VoltEntry } from './codecs.js';
import {
  assertNativeEntry,
  denyNativeTool,
  guardedModel,
  retainedEntry,
} from './coordinator.js';
import { same } from './decisions.js';
import { RuntimeError } from './encoding.js';
import type { Bodies, ModelRuntime, RestoredEntry } from './types.js';
export function captureVoltEntry(bodies: Bodies, value: VoltEntry) {
  return captureEntry(bodies, 'runtime-volt-entry/1', value);
}
export function createDurableVoltConsumer(input: {
  model: LanguageModelV3;
  runtime: ModelRuntime;
  entry: RestoredEntry;
}) {
  const { runtime, entry } = input;
  const data = retainedEntry(runtime, entry);
  if (!('messages' in data))
    throw new RuntimeError('DURABLE_ENTRY_CODEC_REQUIRED');
  const control = runtime.bind(entry);
  const raw = new Agent({
    name: 'durable-model-consumer',
    instructions: '',
    memory: false,
    summarization: false,
    workspace: false,
    workspaceSkillsPrompt: false,
    feedback: false,
    maxRetries: 0,
    maxSteps: 1,
    model: guardedModel(input),
    tools: data.tools.map((tool) =>
      createTool({
        name: tool.name,
        description: tool.description ?? '',
        parameters: z.fromJSONSchema(tool.inputSchema),
        execute: async () => denyNativeTool(runtime, entry),
      }),
    ),
    hooks: {
      onToolStart: async () => denyNativeTool(runtime, entry),
      onPrepareMessages: async ({ messages }) => {
        assertNativeEntry(runtime, entry);
        if (!same(messages, data.messages))
          throw new RuntimeError('DURABLE_ENTRY_CHANGED');
        return { messages };
      },
    },
  });
  const selectedModel = raw.model;
  const selectedHooks = raw.hooks;
  Object.freeze(selectedHooks);
  const stream = raw.streamText.bind(raw);
  raw.streamText = async (messages, options) => {
    assertNativeEntry(runtime, entry);
    if (
      raw.model !== selectedModel ||
      raw.hooks !== selectedHooks ||
      raw.instructions !== ''
    )
      throw new RuntimeError('DURABLE_IMPLEMENTATION_CHANGED');
    if (
      !same(messages, data.messages) ||
      (options && Object.keys(options).length)
    )
      throw new RuntimeError('DURABLE_ENTRY_CHANGED');
    return stream(messages, { ...data.generation, maxRetries: 0, maxSteps: 1 });
  };
  return { raw, control };
}
