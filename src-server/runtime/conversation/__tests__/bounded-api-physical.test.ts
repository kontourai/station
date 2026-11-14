import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModelV3CallOptions } from '@ai-sdk/provider';
import type { AgentSpec } from '@kontourai/station-contracts/agent';
import type { ProviderConnectionConfig } from '@kontourai/station-contracts/tool';
import { VercelModel } from '@strands-agents/sdk/models/vercel';
import { Agent } from '@voltagent/core';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import { createLogger } from '../../../utils/logger.js';
import {
  buildAiSdkLanguageModel,
  createStrandsManagedModel,
  createVoltAgentManagedModel,
} from '../../frameworks/framework-model-factory.js';
import { StrandsFramework } from '../../frameworks/strands-adapter.js';
import { VoltAgentFramework } from '../../frameworks/voltagent-adapter.js';
import type {
  DispatchFleetRouting,
  IAgent,
  IAgentFramework,
} from '../../types.js';
import {
  createAuthorizedTurnCorrelation,
  issueAuthorizedTurnCorrelationHandoff,
  parseAuthorizedTurnCorrelation,
} from '../authorized-turn-correlation.js';
import { runWithModelInvocationCancellation } from '../bounded-api-model.js';
import { boundedApiTransport } from '../bounded-api-transport.js';
import {
  BoundedApiExecutionUnavailableError,
  runWithRequiredBoundedApiTurn,
} from '../bounded-api-turn-grant.js';
import { FleetRoutingReceiptLog } from '../fleet-routing-receipt-log.js';

const makeTempDir = trackTempDirs();
const calls: LanguageModelV3CallOptions = {
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
  maxOutputTokens: 7,
};
const connection: ProviderConnectionConfig = {
  id: 'physical-test',
  type: 'openai-compat',
  name: 'Hermetic physical wire',
  enabled: true,
  capabilities: ['llm'],
  config: { baseUrl: 'https://physical.invalid/v1', apiKey: 'fixture' },
};
const appConfig = {
  defaultModel: 'fixture',
  invokeModel: 'fixture',
  structureModel: 'fixture',
  defaultMaxOutputTokens: 7,
};
const spec: AgentSpec = {
  name: 'physical-test',
  prompt: 'Answer briefly.',
  execution: {
    modelConnectionId: connection.id,
    modelId: 'fixture',
  },
};

function jsonReply() {
  return Response.json({
    id: 'reply',
    model: 'fixture',
    created: 1,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'OK' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  });
}

function streamReply() {
  const chunks = [
    {
      id: 'reply',
      model: 'fixture',
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: 'OK' },
          finish_reason: null,
        },
      ],
    },
    {
      id: 'reply',
      model: 'fixture',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    },
  ];
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
      'data: [DONE]\n\n',
    {
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

const physical = vi.fn<typeof fetch>(async (input, init) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (new URL(url).pathname.endsWith('/models')) {
    return Response.json({ data: [{ id: 'fixture', object: 'model' }] });
  }
  const body = JSON.parse(String(init?.body));
  return body.stream ? streamReply() : jsonReply();
});

beforeEach(() => {
  physical.mockClear();
  vi.stubGlobal('fetch', physical);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function installedModel() {
  return buildAiSdkLanguageModel({
    type: connection.type,
    modelId: 'fixture',
    apiKey: 'fixture',
    baseUrl: String(connection.config.baseUrl),
    requestBodyDefaults: { reasoning_effort: 'low' },
  });
}

async function refused(work: () => unknown) {
  await expect(
    runWithRequiredBoundedApiTurn(async () => work()),
  ).rejects.toBeInstanceOf(BoundedApiExecutionUnavailableError);
  expect(physical).not.toHaveBeenCalled();
}

async function drain(stream: AsyncIterable<unknown>) {
  for await (const _ of stream) {
    /* consume the real installed SDK stream */
  }
}

async function cancelStrandsStream(agent: IAgent, afterStart: boolean) {
  const result = afterStart
    ? await agent.streamText('Hi')
    : await runWithRequiredBoundedApiTurn(() => agent.streamText('Hi'));
  const iterator = result.fullStream[Symbol.asyncIterator]();
  if (afterStart)
    expect(await iterator.next()).toMatchObject({
      value: { type: 'start' },
      done: false,
    });
  expect(physical).not.toHaveBeenCalled();
  await iterator.return?.();
  const settled = Promise.all([result.text, result.finishReason, result.usage]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    expect(
      await Promise.race([
        settled,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('pending'), 200);
        }),
      ]),
      afterStart ? 'after synthetic start' : 'before first next',
    ).toEqual(['', 'cancelled', undefined]);
  } finally {
    clearTimeout(timer);
  }
  expect(await iterator.next()).toMatchObject({ done: true });
  await iterator.return?.();
  expect(await settled).toEqual(['', 'cancelled', undefined]);
  expect(physical).not.toHaveBeenCalled();
}

async function cancelStartedStrandsStream(agent: IAgent) {
  const result = await agent.streamText('Hi');
  const iterator = result.fullStream[Symbol.asyncIterator]();
  let text = '';
  for (;;) {
    const next = await iterator.next();
    if (next.done) throw new Error('Expected model text before cancellation');
    if (next.value.type === 'text-delta') {
      text += next.value.text;
      break;
    }
  }
  expect(physical).toHaveBeenCalledTimes(1);
  await iterator.return?.();
  expect(
    await Promise.all([result.text, result.finishReason, result.usage]),
  ).toEqual([text, 'cancelled', undefined]);
  await iterator.return?.();
  expect(physical).toHaveBeenCalledTimes(1);
  physical.mockClear();
}

async function cancelPendingStrandsStream(agent: IAgent) {
  const peer = await new StrandsFramework().createTempAgent({
    purpose: 'utility',
    name: 'independent-stream',
    instructions: 'Answer briefly.',
    tools: [],
    model: new VercelModel({ provider: installedModel() }),
  });
  const result = await agent.streamText('Hi');
  const other = await peer.streamText('Independent');
  const iterator = result.fullStream[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toMatchObject({ type: 'start' });
  expect((await iterator.next()).value).toMatchObject({ type: 'start-step' });
  const next = iterator.next();
  const closing = iterator.return?.();
  const values = await Promise.all([
    result.text,
    result.finishReason,
    result.usage,
  ]);
  expect(await closing).toMatchObject({ done: true });
  expect(await next).toMatchObject({ done: true });
  expect(values).toEqual(['', 'cancelled', undefined]);
  await drain(other.fullStream);
  expect(await other.text).toBe('OK');
  expect(await other.usage).toMatchObject({
    promptTokens: 3,
    completionTokens: 1,
  });
  expect(physical).toHaveBeenCalledTimes(1);
  const body = String(physical.mock.calls[0]?.[1]?.body);
  expect(body).toContain('Independent');
  expect(body).not.toContain('"content":"Hi"');
  physical.mockClear();
}

async function rejectUnstartedStrandsStream(agent: IAgent) {
  const result = await runWithRequiredBoundedApiTurn(() =>
    agent.streamText('Hi'),
  );
  const iterator = result.fullStream[Symbol.asyncIterator]();
  const error = new Error('consumer abandoned stream');
  await expect(iterator.throw?.(error)).rejects.toBe(error);
  expect(
    await Promise.all([result.text, result.finishReason, result.usage]),
  ).toEqual(['', 'error', undefined]);
  expect(await iterator.next()).toMatchObject({ done: true });
  expect(physical).not.toHaveBeenCalled();
}

async function refuseEscapedStrandsStream(agent: IAgent) {
  const escaped = await runWithRequiredBoundedApiTurn(() =>
    agent.streamText('Hi'),
  );
  expect(physical).not.toHaveBeenCalled();
  const iterator = escaped.fullStream[Symbol.asyncIterator]();
  let failure: unknown;
  try {
    while (!(await iterator.next()).done) {
      /* drain outside the originating scope */
    }
  } catch (error) {
    failure = error;
  }
  expect(physical).not.toHaveBeenCalled();
  expect(failure).toBeInstanceOf(BoundedApiExecutionUnavailableError);
  expect(await escaped.text).toBe('');
  expect(await escaped.finishReason).toBe('error');
  expect(await escaped.usage).toBeUndefined();
  expect(await iterator.next()).toMatchObject({ done: true });
  expect(await iterator.return?.()).toMatchObject({ done: true });
  expect(physical).not.toHaveBeenCalled();
}

test('cached installed model refuses both bound invocations while unbound defaults and usage reach the wire', async () => {
  const model = installedModel();
  const response = await model.doGenerate(calls);
  expect(response.content).toContainEqual({ type: 'text', text: 'OK' });
  expect(response.usage.inputTokens.total).toBe(3);
  expect(JSON.parse(String(physical.mock.calls[0]?.[1]?.body))).toMatchObject({
    model: 'fixture',
    max_tokens: 7,
    reasoning_effort: 'low',
  });
  await drain((await model.doStream(calls)).stream);
  expect(physical).toHaveBeenCalledTimes(2);
  physical.mockClear();
  await refused(() => model.doGenerate(calls));
  await refused(() => model.doStream(calls));
});

test.each(['anthropic', 'google', 'openai-compat'] as const)(
  '%s installed provider cannot bypass the physical guard, including a captured required context',
  async (provider) => {
    const transport = runWithRequiredBoundedApiTurn(() =>
      boundedApiTransport(),
    );
    // Construct the SDK directly so this proof reaches the innermost fetch guard.
    const model =
      provider === 'anthropic'
        ? createAnthropic({
            apiKey: 'fixture',
            fetch: transport,
          }).languageModel('claude-sonnet-4-20250514')
        : provider === 'google'
          ? createGoogleGenerativeAI({
              apiKey: 'fixture',
              fetch: transport,
            }).languageModel('gemini-2.5-flash')
          : createOpenAICompatible({
              name: 'fixture',
              apiKey: 'fixture',
              baseURL: 'https://physical.invalid/v1',
              fetch: transport,
            }).chatModel('fixture');
    await expect(model.doGenerate(calls)).rejects.toBeInstanceOf(
      BoundedApiExecutionUnavailableError,
    );
    await expect(model.doStream(calls)).rejects.toBeInstanceOf(
      BoundedApiExecutionUnavailableError,
    );
    expect(physical).not.toHaveBeenCalled();
  },
);

test('cached installed model rechecks per-invocation cancellation at final fetch after SDK awaits without cancelling its peer', async () => {
  const model = installedModel();
  const stopped = new AbortController();
  const peer = new AbortController();
  const cancelled = runWithModelInvocationCancellation(stopped.signal, () =>
    model.doGenerate(calls),
  );
  const allowed = runWithModelInvocationCancellation(peer.signal, () =>
    model.doGenerate(calls),
  );
  stopped.abort();
  await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  expect((await allowed).content).toContainEqual({ type: 'text', text: 'OK' });
  expect(physical).toHaveBeenCalledTimes(1);
  expect(physical.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  physical.mockClear();
  expect((await model.doGenerate(calls)).content).toContainEqual({
    type: 'text',
    text: 'OK',
  });
  expect(physical.mock.calls[0]?.[1]?.signal).toBeUndefined();
});

test('a model created while required cannot escape into an unbound invocation', async () => {
  const model = runWithRequiredBoundedApiTurn(installedModel);
  await expect(async () => model.doGenerate(calls)).rejects.toBeInstanceOf(
    BoundedApiExecutionUnavailableError,
  );
  expect(physical).not.toHaveBeenCalled();
});

test.each(['volt', 'strands'] as const)(
  '%s temp framework with a raw prebuilt installed provider refuses before any fetch',
  async (kind) => {
    const rawProvider = createOpenAICompatible({
      name: 'fixture',
      apiKey: 'fixture',
      baseURL: 'https://physical.invalid/v1',
    }).chatModel('fixture');
    const framework =
      kind === 'volt' ? new VoltAgentFramework() : new StrandsFramework();
    const agent = await framework.createTempAgent({
      purpose: 'utility',
      name: 'physical-test',
      instructions: 'Answer briefly.',
      model:
        kind === 'volt'
          ? rawProvider
          : new VercelModel({ provider: rawProvider }),
      tools: [],
    });
    const generated = await agent.generateText('Hi');
    expect(generated.text).toBe('OK');
    const streamed = await agent.streamText('Hi');
    await drain(streamed.fullStream);
    expect(await streamed.text).toBe('OK');
    physical.mockClear();
    await refused(() => agent.generateText('Hi'));
    await refused(async () => {
      await drain((await agent.streamText('Hi')).fullStream);
    });
    if (kind === 'strands') {
      await refuseEscapedStrandsStream(agent);
      expect(
        await Promise.allSettled([
          cancelStrandsStream(agent, false),
          cancelStrandsStream(agent, true),
        ]),
      ).toEqual([
        { status: 'fulfilled', value: undefined },
        { status: 'fulfilled', value: undefined },
      ]);
      await rejectUnstartedStrandsStream(agent);
      await cancelPendingStrandsStream(agent);
      await cancelStartedStrandsStream(agent);
    }
    if ('raw' in agent && agent.raw instanceof Agent) {
      const raw = agent.raw;
      await refused(() => raw.generateText('Hi'));
      await refused(() => raw.streamText('Hi'));
    }
  },
);

test.each(['volt', 'strands'] as const)(
  '%s real managed agent refuses from registered and wrapper callers',
  async (kind) => {
    const framework: IAgentFramework =
      kind === 'volt' ? new VoltAgentFramework() : new StrandsFramework();
    const projectHomeDir = makeTempDir('bounded-physical-');
    const bundle = await framework.createAgent(
      'physical-test',
      spec,
      {
        appConfig,
        projectHomeDir,
        listProviderConnections: () => [connection],
      },
      {
        processedPrompt: spec.prompt,
        logger: createLogger({ name: 'bounded-physical-test', level: 'error' }),
        memoryAdapter: new FileMemoryAdapter({ projectHomeDir }),
      },
    );
    expect(physical).toHaveBeenCalledWith(
      'https://physical.invalid/v1/models',
      expect.any(Object),
    );
    expect((await bundle.agent.generateText('Hi')).text).toBe('OK');
    await drain((await bundle.agent.streamText('Hi')).fullStream);
    physical.mockClear();
    await refused(() => bundle.agent.generateText('Hi'));
    await refused(async () => {
      await drain((await bundle.agent.streamText('Hi')).fullStream);
    });
    if (kind === 'strands') {
      await refuseEscapedStrandsStream(bundle.agent);
      expect(
        await Promise.allSettled([
          cancelStrandsStream(bundle.agent, false),
          cancelStrandsStream(bundle.agent, true),
        ]),
      ).toEqual([
        { status: 'fulfilled', value: undefined },
        { status: 'fulfilled', value: undefined },
      ]);
      await rejectUnstartedStrandsStream(bundle.agent);
      await cancelPendingStrandsStream(bundle.agent);
      await cancelStartedStrandsStream(bundle.agent);
    }
    if ('raw' in bundle.agent && bundle.agent.raw instanceof Agent) {
      const raw = bundle.agent.raw;
      await refused(() => raw.generateText('Hi'));
      await refused(() => raw.streamText('Hi'));
    }
  },
);

test.each(['fallback', 'fleet'] as const)(
  'real Dispatch %s refuses bound routing before candidate or peer effects',
  async (kind) => {
    const framework = new VoltAgentFramework();
    const projectHomeDir = makeTempDir('bounded-dispatch-');
    const log = new FleetRoutingReceiptLog(projectHomeDir);
    const fleetRouting: DispatchFleetRouting = {
      environmentId: 'local',
      resolveCandidates: async () => ({
        resolvedAt: new Date().toISOString(),
        exclusions: [],
        candidates: [
          {
            environmentId: 'peer',
            environmentLabel: 'Hermetic peer',
            apiBase: 'https://peer.invalid',
            credential: 'fixture',
            modelId: 'peer-model',
            displayName: 'Peer model',
            evidence: {
              level: 'declared',
              provenance: 'peer-attested',
              label: 'attested by peer, not verified',
              peerAttested: {
                availability: 'available',
                freshness: 'live',
                observedAt: new Date().toISOString(),
                manifestSourceObservedAt: new Date().toISOString(),
                fetchedAt: new Date().toISOString(),
                digest: 'a'.repeat(64),
              },
              probe: null,
            },
          },
        ],
      }),
      appendReceipt: (envelope) => log.append(envelope),
    };
    const model = await framework.createModel(
      {
        ...spec,
        execution: {
          ...spec.execution,
          modelOptions: {
            dispatch: {
              enabled: true,
              candidates: [
                { modelConnectionId: connection.id, modelId: 'fixture' },
              ],
              ...(kind === 'fleet' ? { fleet: { enabled: true } } : {}),
            },
          },
        },
      },
      {
        appConfig,
        projectHomeDir,
        listProviderConnections: () => [connection],
        ...(kind === 'fleet' ? { fleetRouting } : {}),
      },
    );
    const generated = await model.doGenerate(calls);
    expect(generated.content).toContainEqual({ type: 'text', text: 'OK' });
    expect(
      physical.mock.calls.some(([, init]) => init?.method === 'POST'),
    ).toBe(true);
    physical.mockClear();
    await refused(() => model.doGenerate(calls));
    await refused(() => model.doStream(calls));
  },
);

test('native Bedrock factories refuse before credential construction and no private requirement becomes public identity', async () => {
  const options = {
    providerConnection: null,
    modelId: 'fixture',
    spec,
    appConfig,
  };
  await refused(() => createVoltAgentManagedModel(options));
  await refused(() => createStrandsManagedModel(options));
  await refused(() =>
    buildAiSdkLanguageModel({ type: 'bedrock', modelId: 'fixture' }),
  );
  const correlation = createAuthorizedTurnCorrelation({
    accountId: 'owner',
    sessionId: 'session',
  });
  expect(Object.keys(correlation).sort()).toEqual([
    'accountId',
    'correlationId',
    'sessionId',
    'turnId',
  ]);
  expect(
    parseAuthorizedTurnCorrelation({ ...correlation, required: true }),
  ).toBeUndefined();
  await refused(() => issueAuthorizedTurnCorrelationHandoff(correlation));
  expect(issueAuthorizedTurnCorrelationHandoff(correlation)).toEqual(
    expect.any(String),
  );
});
