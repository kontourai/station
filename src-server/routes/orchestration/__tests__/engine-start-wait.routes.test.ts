/**
 * #4568: a brand-new chat's engine-start wait on the wire. The real
 * OrchestrationService queues a person's first start behind a background
 * start, and the real orchestration stream route carries its
 * `orchestration:engine-start-wait` frames — to the start's owner only, again
 * to a stream that opens while it waits, and cleared once it is admitted.
 */
import { join } from 'node:path';
import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import type { OrchestrationEngineStartWaitFrame } from '@kontourai/station-contracts/orchestration';
import type {
  ProviderSession,
  ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { afterEach, expect, test, vi } from 'vitest';
import {
  applyEngineStartWaitFrame,
  clearEngineStartWaits,
  readEngineStartWait,
  readPendingEngineStart,
} from '../../../../src-ui/src/hooks/orchestration/engineStartWaits.js';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  type ExecutionTargetExecutionDependencies,
  executeForegroundMessage,
} from '../../../services/execution-target/execution-target-execution.js';
import { createRuntimeResourcePostureController } from '../../../services/infra/resource-posture.js';
import { EventBus } from '../../../services/orchestration/event-bus.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service.js';
import { createEventRoutes } from '../events.js';
import { createOrchestrationRoutes } from '../orchestration.js';

const temp = trackTempDirs();
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const WAIT = SERVER_EVENTS.ORCHESTRATION_ENGINE_START_WAIT_CHANGED;

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** The `data` of every `event: <name>` frame in an SSE text, for one thread. */
function framesOf(text: string, name: string, threadId?: string): unknown[] {
  return text
    .split('\n\n')
    .filter((block) => block.split('\n').includes(`event: ${name}`))
    .map(
      (block) =>
        JSON.parse(
          block
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => line.slice('data: '.length))
            .join('\n'),
        ) as { threadId?: string },
    )
    .filter((frame) => threadId === undefined || frame.threadId === threadId);
}

test("a person's first-start wait reaches only its owner's streams, replays to a stream opened while it waits, and clears", async () => {
  const store = new EventStore(join(temp('engine-start-wait-'), 'e.sqlite'));
  const bus = new EventBus();
  const adapter = new GateTestAdapter();
  const gate = deferred();
  const entered = deferred();
  const original = adapter.startSession.bind(adapter);
  vi.spyOn(adapter, 'startSession').mockImplementation(async (input) => {
    if (input.threadId === 'background') {
      entered.release();
      await gate.promise;
    }
    return original(input);
  });
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: bus,
    eventStore: store,
    resourcePosture: createRuntimeResourcePostureController(),
    logger: { debug() {}, warn() {} },
  });
  cleanups.push(async () => {
    gate.release();
    await service.shutdown();
    store.close();
  });
  service.initialize();
  let actor = 'owner';
  const app = createOrchestrationRoutes(service, {
    eventBus: bus,
    getUserId: () => actor,
    logger: { debug() {} },
  });
  const openStream = async (user: string, path: string) => {
    actor = user;
    const abort = new AbortController();
    cleanups.push(() => abort.abort());
    const response = await app.request(path, { signal: abort.signal });
    const reader = response.body!.getReader();
    cleanups.push(() => reader.cancel());
    const decoder = new TextDecoder();
    let text = '';
    const until = async (marker: string, count = 1) => {
      while (text.split(marker).length - 1 < count) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`Missing stream marker ${marker}`);
        text += decoder.decode(chunk.value, { stream: true });
      }
      return text;
    };
    await until('orchestration:caughtUp');
    return { until, text: () => text };
  };
  const owner = await openStream('owner', '/events');
  const stranger = await openStream('stranger', '/events');
  const filtered = await openStream('owner', '/events?threadId=elsewhere');
  const bareAbort = new AbortController();
  cleanups.push(() => bareAbort.abort());
  const bare = createEventRoutes({
    eventBus: bus,
    getACPStatus: () => ({ connected: false, connections: [] }),
    logger: { debug() {} },
  });
  const bareResponse = await bare.request('/', { signal: bareAbort.signal });
  const bareReader = bareResponse.body!.getReader();
  cleanups.push(() => bareReader.cancel());

  // A background start holds the slot; the owner's first start queues.
  const background = service.startSessionInternal(
    {
      type: 'start-session',
      input: { threadId: 'background', provider: 'claude' },
    },
    { userId: 'owner' },
    { resourceAdmissionIntent: 'queued_background' },
  );
  await entered.promise;
  const fresh = service.startSessionInternal(
    { type: 'start-session', input: { threadId: 'fresh', provider: 'claude' } },
    { userId: 'owner' },
    { resourceAdmissionIntent: 'interactive_user' },
  );
  await owner.until(`event: ${WAIT}`, 2);
  expect(framesOf(owner.text(), WAIT)).toEqual([
    { threadId: 'fresh', wait: null, pendingStart: true },
    {
      threadId: 'fresh',
      wait: { since: expect.any(String) },
      pendingStart: true,
    },
  ]);

  // Opened mid-wait, the owner's next stream is sent the wait right away.
  const reopened = await openStream('owner', '/events');
  await reopened.until(`event: ${WAIT}`);
  expect(framesOf(reopened.text(), WAIT)).toEqual([
    {
      threadId: 'fresh',
      wait: { since: expect.any(String) },
      pendingStart: true,
    },
  ]);
  const strangerReopened = await openStream('stranger', '/events');
  // A thread-filtered stream sees only its own thread's wait.
  const elsewhere = service.startSessionInternal(
    {
      type: 'start-session',
      input: { threadId: 'elsewhere', provider: 'claude' },
    },
    { userId: 'owner' },
    { resourceAdmissionIntent: 'interactive_user' },
  );
  await filtered.until(`event: ${WAIT}`, 2);
  expect(framesOf(filtered.text(), WAIT)).toEqual([
    { threadId: 'elsewhere', wait: null, pendingStart: true },
    {
      threadId: 'elsewhere',
      wait: { since: expect.any(String) },
      pendingStart: true,
    },
  ]);

  // The stranger's own start is the liveness marker for both stranger streams.
  const strangerStart = service.startSessionInternal(
    {
      type: 'start-session',
      input: { threadId: 'theirs', provider: 'claude' },
    },
    { userId: 'stranger' },
    { resourceAdmissionIntent: 'interactive_user' },
  );
  for (const stream of [stranger, strangerReopened]) {
    await stream.until(`event: ${WAIT}`, 2);
    expect(framesOf(stream.text(), WAIT)).toEqual([
      { threadId: 'theirs', wait: null, pendingStart: true },
      {
        threadId: 'theirs',
        wait: { since: expect.any(String) },
        pendingStart: true,
      },
    ]);
  }

  gate.release();
  expect((await background).status).toBe('accepted');
  expect((await fresh).status).toBe('accepted');
  expect((await elsewhere).status).toBe('accepted');
  await owner.until(`event: ${WAIT}`, 8);
  expect(framesOf(owner.text(), WAIT, 'fresh')).toEqual([
    { threadId: 'fresh', wait: null, pendingStart: true },
    {
      threadId: 'fresh',
      wait: { since: expect.any(String) },
      pendingStart: true,
    },
    { threadId: 'fresh', wait: null, pendingStart: true },
    { threadId: 'fresh', wait: null },
  ]);
  expect((await strangerStart).status).toBe('accepted');
  await stranger.until(`event: ${WAIT}`, 4);
  expect(framesOf(stranger.text(), WAIT)).toEqual([
    { threadId: 'theirs', wait: null, pendingStart: true },
    {
      threadId: 'theirs',
      wait: { since: expect.any(String) },
      pendingStart: true,
    },
    { threadId: 'theirs', wait: null, pendingStart: true },
    { threadId: 'theirs', wait: null },
  ]);
  await filtered.until(`event: ${WAIT}`, 4);
  expect(framesOf(filtered.text(), WAIT)).toEqual([
    { threadId: 'elsewhere', wait: null, pendingStart: true },
    {
      threadId: 'elsewhere',
      wait: { since: expect.any(String) },
      pendingStart: true,
    },
    { threadId: 'elsewhere', wait: null, pendingStart: true },
    { threadId: 'elsewhere', wait: null },
  ]);

  // The identity-free broadcast route relays no wait at all.
  bus.emit(SERVER_EVENTS.RUNTIME_HEALTH_CHANGED, {
    provider: 'claude',
    status: 'healthy',
  });
  const decoder = new TextDecoder();
  let bareText = '';
  while (!bareText.includes(SERVER_EVENTS.RUNTIME_HEALTH_CHANGED)) {
    const chunk = await bareReader.read();
    if (chunk.done) throw new Error('bare stream ended');
    bareText += decoder.decode(chunk.value, { stream: true });
  }
  expect(bareText).not.toContain(WAIT);
});

class StatefulStartAdapter extends GateTestAdapter {
  private readonly sessions = new Map<string, ProviderSession>();

  override async startSession(input: ProviderSessionStartInput) {
    const session = await super.startSession(input);
    this.sessions.set(input.threadId, session);
    return session;
  }

  override async hasSession(threadId?: string) {
    return threadId !== undefined && this.sessions.has(threadId);
  }

  override async listSessions() {
    return [...this.sessions.values()];
  }
}

test.each(['Stop', 'admit after disconnect'] as const)(
  'a fresh /chat publishes to the real consumer and preserves accepted-send semantics: %s',
  async (finish) => {
    const store = new EventStore(
      join(temp('fresh-chat-wire-'), 'events.sqlite'),
    );
    const bus = new EventBus();
    const adapter = new StatefulStartAdapter();
    const held = deferred();
    const entered = deferred();
    const startAdapter = adapter.startSession.bind(adapter);
    const starts = vi
      .spyOn(adapter, 'startSession')
      .mockImplementation(async (input) => {
        if (input.threadId === 'background') {
          entered.release();
          await held.promise;
        }
        return startAdapter(input);
      });
    const service = new OrchestrationService({
      adapterRegistry: createGateTestRegistry(adapter),
      eventBus: bus,
      eventStore: store,
      resourcePosture: createRuntimeResourcePostureController(),
      resolveSessionAgent: async (input) => ({
        ...input,
        agent: { slug: 'claude' },
      }),
      logger: { debug() {}, warn() {} },
    });
    const authority = sessionReadAuthorityFromRequest(
      'owner',
      undefined,
      undefined,
    );
    const apiBase = `https://fresh-chat-${finish.replaceAll(' ', '-')}.test`;
    cleanups.push(async () => {
      held.release();
      await service.shutdown();
      store.close();
      clearEngineStartWaits(apiBase);
    });
    service.initialize();
    const deps: ExecutionTargetExecutionDependencies = {
      resolveEnvironmentAccess: async () => ({
        apiBase,
        environmentId: 'wait-station',
        environmentName: 'Wait Station',
        kind: 'current',
      }),
      getAgent: async () => ({
        slug: 'claude',
        available: true,
        execution: { agentConnectionId: engineConnectionId('claude') },
      }),
      getConnection: async () => ({
        id: engineConnectionId('claude'),
        name: 'Claude',
        type: 'claude',
        kind: 'agent',
        enabled: true,
        status: 'ready',
        capabilities: ['agent-runtime'],
        prerequisites: [],
        config: { provider: 'claude' },
      }),
      getProject: async () => undefined,
      getProviderAdapter: (provider) => service.getProviderAdapter(provider),
      readInitialConversationContext: async () => undefined,
      readSessionBinding: async () => null,
      resolveConversationSession: async (_access, id, requested) =>
        service.resolveConversationContinuation(id, authority, requested),
      startSession: async (_access, input, context) => {
        const result = await service.startSessionInternal(
          { type: 'start-session', input },
          { userId: 'owner' },
          {
            ...context,
            conversationIdentity: {
              conversationId: String(input.metadata?.conversationId),
              environmentId: 'wait-station',
            },
          },
        );
        if (result.status !== 'accepted')
          throw Object.assign(new Error(result.message), { code: result.code });
        return undefined;
      },
      sendTurn: async (_access, input, context) => {
        const result = await service.dispatchWithReceipt(
          { type: 'sendTurn', input },
          { userId: 'owner', ...context },
          context,
        );
        if (!result.result || !('turnId' in result.result))
          throw new Error('Missing turn receipt');
        return { turnId: result.result.turnId };
      },
    };
    const app = createOrchestrationRoutes(service, {
      eventBus: bus,
      getUserId: () => 'owner',
      logger: { debug() {} },
      executeForegroundMessage: (input) =>
        executeForegroundMessage(input, deps),
    });
    const abortStream = new AbortController();
    cleanups.push(() => abortStream.abort());
    const stream = await app.request('/events', { signal: abortStream.signal });
    const reader = stream.body!.getReader();
    cleanups.push(() => reader.cancel());
    const decoder = new TextDecoder();
    let wire = '';
    let buffer = '';
    const consumeUntil = async (ready: () => boolean) => {
      while (!ready()) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('Stream ended before the projection');
        const text = decoder.decode(chunk.value, { stream: true });
        wire += text;
        buffer += text;
        let end = buffer.indexOf('\n\n');
        while (end !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          for (const value of framesOf(`${frame}\n\n`, WAIT))
            applyEngineStartWaitFrame(
              apiBase,
              value as OrchestrationEngineStartWaitFrame,
            );
          end = buffer.indexOf('\n\n');
        }
      }
    };
    await consumeUntil(() => wire.includes('orchestration:caughtUp'));
    const background = service.startSessionInternal(
      {
        type: 'start-session',
        input: { threadId: 'background', provider: 'claude' },
      },
      { userId: 'owner' },
      { resourceAdmissionIntent: 'queued_background' },
    );
    await entered.promise;
    const requestAbort = new AbortController();
    const fresh = app.request('/chat', {
      method: 'POST',
      signal: requestAbort.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'fresh',
        clientTurnId: 'first',
        message: 'hello',
        target: { environment: { kind: 'current' }, agent: agentId('claude') },
      }),
    });
    await Promise.race([
      consumeUntil(() => readEngineStartWait(apiBase, ['fresh']) !== undefined),
      Promise.resolve(fresh).then(async (response) => {
        throw new Error(
          `Chat settled before publishing its wait: ${response.status} ${await response.clone().text()}`,
        );
      }),
    ]);
    expect(readPendingEngineStart(apiBase, 'fresh')).toBe(true);
    expect(store.readSessionByThread('fresh')).toBeUndefined();
    expect(
      starts.mock.calls.filter(([input]) => input.threadId === 'fresh'),
    ).toHaveLength(0);
    requestAbort.abort(new Error('transport disconnected after acceptance'));
    // The transport's join signal never cancels a send Station accepted.
    expect(service.readableEngineStartWaits(authority)).toContainEqual(
      expect.objectContaining({ threadId: 'fresh', wait: expect.any(Object) }),
    );
    if (finish === 'Stop') {
      const response = await app.request('/commands', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'interruptTurn',
          threadId: 'fresh',
          clientTurnId: 'first',
        }),
      });
      expect(response.status).toBe(200);
      const cancelled = await fresh;
      expect(cancelled.status).toBe(400);
      expect(await cancelled.json()).toMatchObject({
        success: false,
        code: 'resource_engine_start_cancelled',
      });
    }
    held.release();
    expect((await background).status).toBe('accepted');
    if (finish !== 'Stop') expect((await fresh).status).toBe(200);
    await consumeUntil(() => !readPendingEngineStart(apiBase, 'fresh'));
    expect(readEngineStartWait(apiBase, ['fresh'])).toBeUndefined();
    expect(
      starts.mock.calls.filter(([input]) => input.threadId === 'fresh'),
    ).toHaveLength(finish === 'Stop' ? 0 : 1);
  },
);
