import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createChatRuntimeFixture } from '../../../__test-utils__/chat-runtime-fixture.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import {
  emit,
  startedAdapter,
  THREAD,
  waitFor,
} from '../../../providers/__tests__/codex-adapter-wire-harness.js';
import { createAgentHooks } from '../../../runtime/agents/agent-hooks.js';
import { bindDurableAgent } from '../../../runtime/agents/durable-agent-invocation.js';
import {
  prepareDurableForegroundHandoff,
  releaseDurableForeground,
} from '../../../runtime/agents/durable-agent-lifecycle.js';
import { stationAgentRuntimeOwner } from '../../../runtime/agents/durable-agent-owner.js';
import {
  durableAgentHooks,
  executeDurableTool,
} from '../../../runtime/agents/durable-agent-tools.js';
import {
  createNativeExecutionWorkspace,
  currentNativeExecutionWorkspace,
  runWithNativeExecutionWorkspace,
} from '../../../runtime/conversation/native-execution-workspace.js';
import { createElicitationCallback } from '../../../runtime/conversation/stream-orchestrator.js';
import {
  closeNativeOutputTurnContext,
  createNativeOutputGrantAuthority,
  currentNativeOutputCallScope,
  runWithCurrentNativeOutputCall,
  runWithNativeOutputTurnContext,
} from '../../../runtime/native-output-turn-grant.js';
import { captureRuntimeConfigurationLease } from '../../../runtime/plugins/runtime-configuration-lease.js';
import { InjectableStream } from '../../../runtime/streaming/InjectableStream.js';
import type { IAgent } from '../../../runtime/types.js';
import { resetFixtureSqliteSynchronousForTest } from '../../../utils/sqlite-fixture-durability.js';
import { streamPrimaryAgentChat } from '../chat-primary-stream.js';

const temp = trackTempDirs();
beforeEach(() => resetFixtureSqliteSynchronousForTest());
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
for (const durable of [true]) {
  it(`disconnect ${durable ? 'hands the running Station turn to its durable owner and finishes once' : 'still aborts an engine without durable ownership'}`, async () => {
    const home = temp('chat-durable-disconnect-');
    const memory = new FileMemoryAdapter({ projectHomeDir: home });
    await memory.createConversation({
      id: 'conversation',
      resourceId: 'assistant',
      userId: 'owner',
      title: 'Disconnect',
      metadata: {},
    });
    const owner = stationAgentRuntimeOwner(home);
    const failures: unknown[] = [];
    const forwarded: string[] = [];
    owner.configure({
      preview: {
        select: (branches) =>
          durable ? branches.enabled() : branches.disabled(),
      },
      failed: (error) => failures.push(error),
      onWire: async (_input, _turn, wire) => {
        forwarded.push(wire);
      },
    });
    cleanup.push(() => owner.pause());
    const entered = gate();
    const release = gate();
    let signal!: AbortSignal;
    let finished = 0;
    let invocations = 0;
    const agent: IAgent = {
      id: 'assistant',
      name: 'Assistant',
      model: { modelId: 'scripted' },
      getMemory: () => null,
      generateText: async () => ({ text: 'unused' }),
      streamText: async (_input, options) => {
        invocations++;
        signal = options.abortSignal;
        return {
          fullStream: (async function* () {
            yield { type: 'text-start', id: 'a' };
            yield { type: 'text-delta', id: 'a', text: 'running' };
            entered.resolve();
            await release.promise;
            if (signal.aborted) throw new Error('engine cancelled');
            finished++;
            yield { type: 'text-end', id: 'a' };
            yield { type: 'finish', finishReason: 'stop' };
          })(),
          text: Promise.resolve('running'),
          usage: Promise.resolve({
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
          }),
          finishReason: Promise.resolve('stop'),
        };
      },
    };
    if (durable)
      bindDurableAgent(agent, {
        home,
        slug: 'assistant',
        definition: 'scripted/1',
        memory,
      });
    const runtime = createChatRuntimeFixture(home, memory);
    const client = new AbortController();
    const app = new Hono();
    app.post('/chat', (c) =>
      streamPrimaryAgentChat({
        c,
        ctx: runtime,
        slug: 'assistant',
        plugin: '',
        input: 'hello',
        restOptions: {
          conversationId: 'conversation',
          userId: 'owner',
          clientTurnId: 'turn',
        },
        injectContext: null,
        ragContext: null,
        agent,
        configurationLease: captureRuntimeConfigurationLease(runtime)!,
      }),
    );
    const response = await app.request('/chat', {
      method: 'POST',
      signal: client.signal,
    });
    const wire = response.text();
    cleanup.push(async () => {
      release.resolve();
      await wire;
    });
    await Promise.race([
      entered.promise,
      wire.then(() => {
        throw new Error(
          'The route finished before entering its engine: ' +
            JSON.stringify(failures),
        );
      }),
    ]);
    client.abort('client disconnected');
    expect(signal.aborted).toBe(!durable);
    release.resolve();
    await wire;
    expect(invocations).toBe(1);
    expect(finished).toBe(durable ? 1 : 0);
    if (durable) {
      expect(owner.read('conversation', 'turn')?.turn.state).toBe('completed');
      expect(owner.owns('conversation', 'turn')).toBe(false);
      expect(failures).toEqual([]);
      const deltas = forwarded
        .flatMap((wire) =>
          wire
            .split('\n')
            .filter((line) => line.startsWith('data: {'))
            .map((line) => JSON.parse(line.slice(6))),
        )
        .filter((event) => event.type === 'text-delta')
        .map((event) => event.text ?? event.delta)
        .join('');
      expect(deltas).toBe('running');
      expect(
        forwarded.filter((wire) => wire.includes('data: [DONE]')),
      ).toHaveLength(1);
      expect(owner.frames('conversation', 'turn').length).toBeGreaterThan(0);
    }
  });
}

it('a detached durable turn retains its approval requester, workspace and native issuance until its owner finishes', async () => {
  const home = temp('durable-release-');
  const memory = new FileMemoryAdapter({ projectHomeDir: home });
  await memory.createConversation({
    id: 'conversation',
    resourceId: 'assistant',
    userId: 'owner',
    title: 'Lifetime',
    metadata: {},
  });
  const ctx = createChatRuntimeFixture(home, memory);
  const spec = {
    name: 'Assistant',
    prompt: 'Answer',
    tools: { mcpServers: [], askBeforeUse: ['probe'] },
  };
  const hooks = createAgentHooks({
    spec,
    appConfig: ctx.appConfig,
    configLoader: ctx.configLoader,
    agentFixedTokens: new Map(),
    memoryAdapters: ctx.memoryAdapters,
    toolNameMapping: new Map(),
    logger: ctx.logger,
  });
  const owner = stationAgentRuntimeOwner(home);
  const failures: unknown[] = [];
  owner.configure({
    preview: { select: (branches) => branches.enabled() },
    failed: (error) => failures.push(error),
  });
  cleanup.push(() => owner.pause());
  const workspace = createNativeExecutionWorkspace(home);
  const authority = createNativeOutputGrantAuthority();
  const grant = authority.issue(
    {
      threadId: 'conversation',
      turnId: 'turn',
      adapterId: 'station',
      principal: humanPrincipal('test', 'owner', 'Owner'),
      configurationLease: {},
      workspaceRoot: home,
    },
    { isCurrent: () => true },
  );
  if (!grant) throw Error('Real native authority prerequisite');
  const native = { authority, grant };
  const entered = gate();
  const continueWork = gate();
  const asked = gate();
  const released = gate();
  let requests = 0;
  let cleanupCount = 0;
  const ownedHooks = durableAgentHooks(hooks)!;
  const elicitation = createElicitationCallback(
    spec,
    ctx.toolNameMapping,
    ctx.approvalRegistry,
    new InjectableStream(),
    ctx.logger,
    () => 'conversation',
    'conversation',
  );
  const releaseRequester = hooks.registerApprovalRequester(
    'conversation',
    async (tool) => {
      requests++;
      const pending = elicitation({ type: 'tool-approval', ...tool });
      asked.resolve();
      return !!(await pending);
    },
  );
  const agent: IAgent = {
    id: 'assistant',
    name: 'Assistant',
    model: { modelId: 'scripted' },
    getMemory: () => null,
    generateText: async () => ({ text: 'unused' }),
    streamText: async () => ({
      fullStream: (async function* () {
        yield { type: 'text-start', id: 'answer' };
        entered.resolve();
        await continueWork.promise;
        const approved = await ownedHooks.beforeToolCall!(
          { toolCallId: 'late-tool', toolName: 'probe', toolArgs: {} },
          { agentSlug: 'assistant', conversationId: 'conversation' },
        );
        if (approved !== true)
          throw Error('Detached approval requester was released early');
        await executeDurableTool(
          { name: 'probe', id: 'late-tool', args: {} },
          () =>
            runWithCurrentNativeOutputCall('late-tool', async () => {
              const call = currentNativeOutputCallScope();
              expect(call && authority.admit(call)?.turnId).toBe('turn');
              expect(currentNativeExecutionWorkspace()?.workspaceRoot).toBe(
                home,
              );
              return 'scoped result';
            }),
        );
        yield { type: 'text-delta', id: 'answer', text: 'DONE' };
        yield { type: 'text-end', id: 'answer' };
        yield { type: 'finish', finishReason: 'stop' };
      })(),
      text: Promise.resolve('DONE'),
      usage: Promise.resolve({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      }),
      finishReason: Promise.resolve('stop'),
    }),
  };
  bindDurableAgent(agent, {
    home,
    slug: 'assistant',
    definition: 'lifetime/1',
    memory,
  });
  const client = new AbortController();
  const writer = { write: async (_wire: string | Uint8Array) => {} };
  const disconnect = prepareDurableForegroundHandoff({
    agent,
    conversationId: () => 'conversation',
    invocationId: () => 'turn',
    writer,
    signal: client.signal,
    abort: () => {
      throw Error('Durable operation was aborted');
    },
  });
  client.signal.addEventListener('abort', disconnect, { once: true });
  const response = await runWithNativeExecutionWorkspace(workspace, () =>
    runWithNativeOutputTurnContext(native, () =>
      agent.streamText('hello', {
        conversationId: 'conversation',
        clientTurnId: 'turn',
        userId: 'owner',
      }),
    ),
  );
  const consuming = (async () => {
    for await (const chunk of response.fullStream)
      await writer.write(`data: ${JSON.stringify(chunk)}\n\n`);
    await writer.write('data: [DONE]\n\n');
  })();
  cleanup.push(async () => {
    continueWork.resolve();
    await Promise.race([asked.promise, consuming.catch(() => {})]);
    ctx.approvalRegistry.cancelAll();
    await consuming.catch(() => {});
    authority.dispose();
  });
  await entered.promise;
  client.abort();
  releaseDurableForeground(writer, releaseRequester);
  releaseDurableForeground(writer, () => {
    cleanupCount++;
    workspace.close();
    closeNativeOutputTurnContext(native);
    released.resolve();
  });
  expect(cleanupCount).toBe(0);
  expect(workspace.workspaceRoot).toBe(home);
  expect(authority.bindNativeCall(grant, 'still-open')).not.toBeNull();
  continueWork.resolve();
  await expect(
    Promise.race([
      asked.promise,
      consuming.then(() => {
        throw Error('Turn finished without asking');
      }),
    ]),
  ).resolves.toBeUndefined();
  expect(requests).toBe(1);
  expect(cleanupCount).toBe(0);
  await vi.waitFor(() => {
    const approval = owner.approvals('conversation', 'turn')[0];
    expect(approval?.state).toBe('pending');
    expect(approval?.id).toMatch(/^approval:sha256:/);
    expect(ctx.approvalRegistry.has(approval!.id)).toBe(true);
  });
  ctx.approvalRegistry.resolve(
    owner.approvals('conversation', 'turn')[0]!.id,
    true,
  );
  await consuming;
  await released.promise;
  expect(cleanupCount).toBe(1);
  expect(() => workspace.workspaceRoot).toThrow();
  expect(authority.bindNativeCall(grant, 'after-finish')).toBeNull();
  expect(owner.read('conversation', 'turn')?.turn.state).toBe('completed');
  expect(failures).toEqual([]);
});

it('disconnect still interrupts a real external Codex adapter through its app-server transport', async () => {
  const { adapter, process } = await startedAdapter();
  cleanup.push(async () => {
    await adapter.stopSession(THREAD);
  });
  const operation = new AbortController();
  const client = new AbortController();
  let interruption: ReturnType<typeof adapter.interruptTurn> | undefined;
  operation.signal.addEventListener(
    'abort',
    () => {
      interruption = adapter.interruptTurn(THREAD);
    },
    { once: true },
  );
  const writer = { write: async (_wire: string | Uint8Array) => {} };
  const disconnect = prepareDurableForegroundHandoff({
    agent: adapter,
    conversationId: () => THREAD,
    invocationId: () => 'turn-1',
    writer,
    signal: client.signal,
    abort: () => operation.abort('Client disconnected'),
  });
  client.signal.addEventListener('abort', disconnect, { once: true });
  client.abort();
  expect(operation.signal.aborted).toBe(true);
  const request = await waitFor(
    () =>
      process.stdin.lines
        .map((line) => JSON.parse(line))
        .find((value) => value.method === 'turn/interrupt'),
    'real Codex interrupt request',
  );
  expect(request.params.turnId).toBe('turn-1');
  await emit(process, { id: request.id, result: {} });
  await interruption;
  releaseDurableForeground(writer, () => {});
});

it.each([65_536, 1_048_576, 1_048_573])(
  'the real chat route preserves the terminal outcome at %i retained frames',
  async (limit) => {
    const home = temp('durable-frame-capacity-');
    const memory = new FileMemoryAdapter({ projectHomeDir: home });
    await memory.createConversation({
      id: 'conversation',
      resourceId: 'assistant',
      userId: 'owner',
      title: 'Capacity',
      metadata: {},
    });
    const owner = stationAgentRuntimeOwner(home);
    const failures: unknown[] = [];
    owner.configure({
      preview: { select: (branches) => branches.enabled() },
      failed: (error) => failures.push(error),
    });
    cleanup.push(() => owner.pause());
    const entered = gate();
    const resume = gate();
    const releaseAbort = gate();
    let capacityAborted = false;
    let finished = 0;
    const agent: IAgent = {
      id: 'assistant',
      name: 'Assistant',
      model: { modelId: 'capacity' },
      getMemory: () => null,
      generateText: async () => ({ text: 'unused' }),
      streamText: async (_input, options) => ({
        fullStream: (async function* () {
          entered.resolve();
          await resume.promise;
          yield { type: 'text-start', id: 'a' };
          yield { type: 'text-delta', id: 'a', text: 'AFTER_CAP' };
          yield { type: 'text-end', id: 'a' };
          if (limit === 1_048_576) {
            const aborted = () => {
              capacityAborted = true;
              releaseAbort.resolve();
            };
            if (options.abortSignal.aborted) aborted();
            else
              options.abortSignal.addEventListener('abort', aborted, {
                once: true,
              });
            await releaseAbort.promise;
          }
          finished++;
          yield { type: 'finish', finishReason: 'stop' };
        })(),
        text: Promise.resolve('AFTER_CAP'),
        usage: Promise.resolve({
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
        }),
        finishReason: Promise.resolve('stop'),
      }),
    };
    bindDurableAgent(agent, {
      home,
      slug: 'assistant',
      definition: 'capacity/1',
      memory,
    });
    const runtime = createChatRuntimeFixture(home, memory);
    const app = new Hono();
    app.post('/chat', (c) =>
      streamPrimaryAgentChat({
        c,
        ctx: runtime,
        slug: 'assistant',
        plugin: '',
        input: 'hello',
        restOptions: {
          conversationId: 'conversation',
          userId: 'owner',
          clientTurnId: 'turn',
        },
        injectContext: null,
        ragContext: null,
        agent,
        configurationLease: captureRuntimeConfigurationLease(runtime)!,
      }),
    );
    const response = await app.request('/chat', { method: 'POST' });
    const wire = response.text();
    cleanup.push(async () => {
      resume.resolve();
      releaseAbort.resolve();
      await wire.catch(() => {});
    });
    await entered.promise;
    // Seed a valid prior prefix; the next frame must enter through the route.
    const db = new DatabaseSync(`${home}/data/agent-runtime/steps.sqlite`);
    try {
      const turn = db.prepare('SELECT id FROM agent_steps_turns').get();
      if (typeof turn?.id !== 'string') throw Error('Live turn prerequisite');
      const first = Number(
        db
          .prepare(
            'SELECT coalesce(max(position),-1)+1 AS n FROM agent_steps_frames WHERE turn_id=?',
          )
          .get(turn.id)?.n,
      );
      const retained = 'data: {"type":"retained-prefix"}\n\n';
      const digest = `sha256:${createHash('sha256').update(JSON.stringify(retained)).digest('hex')}`;
      db.prepare(`WITH RECURSIVE positions(n) AS (SELECT ? UNION ALL SELECT n+1 FROM positions WHERE n<?)
      INSERT INTO agent_steps_frames SELECT ?, 'prefix:'||n, n, json_object('version',1,'id','prefix:'||n,'position',n,'wire',?,'digest',?,'createdAt','2026-01-01T00:00:00.000Z') FROM positions`).run(
        first,
        limit - 1,
        turn.id,
        retained,
        digest,
      );
    } finally {
      db.close();
    }
    resume.resolve();
    if (limit === 1_048_576)
      await expect.poll(() => capacityAborted, { timeout: 2_000 }).toBe(true);
    const result = await wire;
    const events = result
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)));
    expect(result).toContain('data: [DONE]');
    if (limit >= 1_048_573) {
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'error',
          code: 'DURABLE_AGENT_FRAME_CAPACITY',
          errorText: expect.stringContaining('durable output limit'),
        }),
      );
      await expect
        .poll(() => owner.read('conversation', 'turn')?.turn.state)
        .toBe('blocked');
      expect(
        events
          .filter((event) => event.type === 'text-delta')
          .map((event) => event.text ?? event.delta)
          .join(''),
      ).toBe(limit === 1_048_576 ? '' : 'AFTER_CAP');
    } else {
      expect(
        events
          .filter((event) => event.type === 'text-delta')
          .map((event) => event.text ?? event.delta)
          .join(''),
      ).toBe('AFTER_CAP');
      expect(failures).toEqual([]);
      expect(finished).toBe(1);
      expect(owner.read('conversation', 'turn')?.turn.state).toBe('completed');
      expect(owner.frames('conversation', 'turn').length).toBeGreaterThan(
        65_536,
      );
    }
  },
  60_000,
);
