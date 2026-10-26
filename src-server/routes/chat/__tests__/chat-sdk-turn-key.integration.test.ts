import { once } from 'node:events';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import {
  ChatHttpError,
  sentTurnKey,
  setClientCredentialResolver,
} from '@kontourai/station-sdk/client';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { streamConversationTurn as StreamConversationTurn } from '../../../../packages/sdk/src/query-domains/chatRuntimeStream.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import type {
  IAgent,
  IStreamResult,
  RuntimeContext,
} from '../../../runtime/types.js';
import { FeedbackService } from '../../../services/feedback/feedback-service.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { createChatRoutes } from '../chat.js';

// Exercise the public root at runtime; its React types use the SDK's JSX typecheck.
const { streamConversationTurn } = await vi.importActual<{
  streamConversationTurn: typeof StreamConversationTurn;
}>('@kontourai/station-sdk');

const temp = trackTempDirs();
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  setClientCredentialResolver();
  for (const close of cleanup.splice(0).reverse()) await close();
});

type ChatFixture = Pick<
  RuntimeContext,
  | 'activeAgents'
  | 'agentSpecs'
  | 'agentTools'
  | 'memoryAdapters'
  | 'toolNameMapping'
  | 'agentStatus'
  | 'agentHooksMap'
  | 'agentStats'
  | 'metricsLog'
  | 'feedbackService'
  | 'orchestrationEventStore'
  | 'appConfig'
  | 'logger'
  | 'getAgentConfigurationRevision'
  | 'commitAgentConfigurationRead'
> & {
  providerService: Pick<
    RuntimeContext['providerService'],
    'getLaunchabilityRevision' | 'listProviderConnections'
  >;
  configLoader: Pick<
    RuntimeContext['configLoader'],
    'getLaunchabilityRevision'
  >;
};

async function fixture(streamText: IAgent['streamText']) {
  const home = temp('sdk-chat-turn-key-');
  const store = new EventStore(join(home, 'events.sqlite'));
  cleanup.push(() => {
    store.close();
  });
  const agent: IAgent = {
    id: 'assistant',
    name: 'Assistant',
    model: { modelId: 'fixture-model' },
    getMemory: () => null,
    generateText: async () => ({ text: 'Fixture conversation' }),
    streamText,
  };
  const ctx: ChatFixture = {
    activeAgents: new Map([['assistant', agent]]),
    agentSpecs: new Map(),
    agentTools: new Map(),
    memoryAdapters: new Map([
      ['assistant', new FileMemoryAdapter({ projectHomeDir: home })],
    ]),
    toolNameMapping: new Map(),
    agentStatus: new Map(),
    agentHooksMap: new Map(),
    agentStats: new Map(),
    metricsLog: [],
    feedbackService: new FeedbackService(home),
    orchestrationEventStore: store,
    appConfig: { defaultModel: '', invokeModel: '', structureModel: '' },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    providerService: {
      getLaunchabilityRevision: () => 0,
      listProviderConnections: () => [],
    },
    configLoader: { getLaunchabilityRevision: () => 0 },
    getAgentConfigurationRevision: () => 0,
    commitAgentConfigurationRead: async (_revision, operation) => operation(),
  };
  const app = new Hono();
  app.route(
    '/api/agents',
    createChatRoutes(
      // @ts-expect-error This typed fixture supplies the real route's used members, without unrelated runtime services.
      ctx,
    ),
  );
  const server = createServer(getRequestListener(app.fetch));
  const responsesFinished: Promise<unknown>[] = [];
  server.on('request', (_request, response) => {
    responsesFinished.push(once(response, 'finish'));
  });
  cleanup.push(async () => {
    await Promise.all(responsesFinished);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No fixture loopback port');
  return `http://127.0.0.1:${address.port}`;
}

function finished(): IStreamResult {
  return {
    fullStream: (async function* () {
      yield { type: 'finish', finishReason: 'stop' };
    })(),
    text: Promise.resolve(''),
    finishReason: Promise.resolve('stop'),
  };
}

const keepState = (_event: unknown, state: unknown) => state;

describe('public SDK direct-chat keys through the production route', () => {
  test('a generated key replays its conversation and an independent send invokes again', async () => {
    const streamText = vi.fn<IAgent['streamText']>(async () => finished());
    const apiBase = await fixture(streamText);
    const input = {
      apiBase,
      agentSlug: 'assistant',
      content: 'hello',
      onStreamEvent: keepState,
    };
    const first = await streamConversationTurn(input);
    expect(first.clientTurnId).toEqual(expect.any(String));
    expect(first.conversationId).toEqual(expect.any(String));
    expect(streamText).toHaveBeenCalledTimes(1);
    const replay = await streamConversationTurn({
      ...input,
      chatOptions: { clientTurnId: first.clientTurnId },
    });
    expect(streamText).toHaveBeenCalledTimes(1);
    expect(replay).toMatchObject({
      clientTurnId: first.clientTurnId,
      conversationId: first.conversationId,
      finishReason: 'completed',
    });
    expect(streamText.mock.calls[0]?.[0]).toEqual([
      {
        id: `msg-${first.clientTurnId}`,
        role: 'user',
        parts: [{ type: 'text', text: 'hello' }],
      },
    ]);
    const independent = await streamConversationTurn(input);
    expect(independent.clientTurnId).not.toBe(first.clientTurnId);
    expect(streamText).toHaveBeenCalledTimes(2);
  });

  test('an error key recovered by the SDK refuses a possible-effect replay without another invocation', async () => {
    const streamText = vi.fn<IAgent['streamText']>(async () => {
      throw new Error('Fixture possible effect');
    });
    const apiBase = await fixture(streamText);
    const failure = new Error('Observed stream failure');
    const input = {
      apiBase,
      agentSlug: 'assistant',
      content: 'hello',
      onStreamEvent: (event: { type?: string }, state: unknown) => {
        if (event.type === 'error') throw failure;
        return state;
      },
    };
    const firstError: unknown = await streamConversationTurn(input).catch(
      (error: unknown) => error,
    );
    expect(firstError).toBe(failure);
    const key = sentTurnKey(firstError);
    expect(key).toEqual(expect.any(String));
    expect(streamText).toHaveBeenCalledTimes(1);
    const retryError: unknown = await streamConversationTurn({
      ...input,
      chatOptions: { clientTurnId: key },
    }).catch((error: unknown) => error);
    expect(streamText).toHaveBeenCalledTimes(1);
    expect(retryError).toBeInstanceOf(ChatHttpError);
    expect(retryError).toMatchObject({
      code: 'foreground_message_indeterminate',
      outcome: 'indeterminate',
    });
    expect(sentTurnKey(retryError)).toBe(key);
  });
});
