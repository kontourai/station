import { AsyncLocalStorage } from 'node:async_hooks';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import {
  Agent,
  BeforeToolCallEvent,
  FunctionTool,
  Message,
  NullConversationManager,
} from '@strands-agents/sdk';
import { VercelModel } from '@strands-agents/sdk/models/vercel';
import { captureEntry, type StrandsEntry } from './codecs.js';
import {
  assertNativeEntry,
  denyNativeTool,
  guardedModel,
  retainedEntry,
} from './coordinator.js';
import { same } from './decisions.js';
import { RuntimeError } from './encoding.js';
import type { Bodies, ModelRuntime, RestoredEntry } from './types.js';
export function captureStrandsEntry(bodies: Bodies, value: StrandsEntry) {
  return captureEntry(bodies, 'runtime-strands-entry/1', value);
}
export function createDurableStrandsConsumer(input: {
  model: LanguageModelV3;
  runtime: ModelRuntime;
  entry: RestoredEntry;
}) {
  const { runtime, entry } = input;
  const data = retainedEntry(runtime, entry);
  if (!('prefix' in data))
    throw new RuntimeError('DURABLE_ENTRY_CODEC_REQUIRED');
  const control = runtime.bind(entry);
  const agent = new Agent({
    conversationManager: new NullConversationManager(),
    retryStrategy: null,
    model: new VercelModel({
      provider: guardedModel(input),
      ...data.vercelConfig,
    }),
    messages: data.prefix.map((p) => Message.fromJSON(p)),
    systemPrompt: data.systemPrompt,
    tools: data.tools.map(
      (tool) =>
        new FunctionTool({
          name: tool.name,
          description: tool.description ?? '',
          inputSchema: tool.inputSchema,
          callback: () => denyNativeTool(runtime, entry),
        }),
    ),
  });
  agent.addHook(BeforeToolCallEvent, () => denyNativeTool(runtime, entry));
  const selectedModel = agent.model;
  const initialization = new AsyncLocalStorage<boolean>();
  const initialize = agent.initialize.bind(agent);
  const addHook = agent.addHook.bind(agent);
  const addMiddleware = agent.addMiddleware.bind(agent);
  agent.addHook = (...args) => {
    if (!initialization.getStore())
      throw new RuntimeError('DURABLE_HOOKS_UNSUPPORTED');
    return addHook(...args);
  };
  agent.addMiddleware = new Proxy(addMiddleware, {
    apply(target, receiver, args) {
      if (!initialization.getStore())
        throw new RuntimeError('DURABLE_HOOKS_UNSUPPORTED');
      return Reflect.apply(target, receiver, args);
    },
  });
  const stream = agent.stream.bind(agent);
  agent.stream = async function* (message, options) {
    assertNativeEntry(runtime, entry);
    if (agent.model !== selectedModel)
      throw new RuntimeError('DURABLE_IMPLEMENTATION_CHANGED');
    if (
      !same(message, data.effectiveInput) ||
      (options && Object.keys(options).length)
    )
      throw new RuntimeError('DURABLE_ENTRY_CHANGED');
    await initialization.run(true, () => initialize());
    return yield* stream(message);
  };
  return { agent, control };
}
