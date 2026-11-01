import { EventEmitter } from 'node:events';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import { MonitoringEmitter } from '../../../monitoring/emitter.js';
import { bindDurableAgent } from '../../../runtime/agents/durable-agent-invocation.js';
import { stationAgentRuntimeOwner } from '../../../runtime/agents/durable-agent-owner.js';
import { captureRuntimeConfigurationLease } from '../../../runtime/plugins/runtime-configuration-lease.js';
import type { IAgent, RuntimeContext } from '../../../runtime/types.js';
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
for (const durable of [true, false]) {
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
          usage: Promise.resolve(undefined),
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
    const ctx = {
      agentSpecs: new Map(),
      toolNameMapping: new Map(),
      approvalRegistry: {},
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      agentHooksMap: new Map(),
      memoryAdapters: new Map([['assistant', memory]]),
      feedbackService: { getRatings: () => [] },
      agentStatus: new Map(),
      agentStats: new Map(),
      agentTools: new Map(),
      monitoringEvents: undefined,
      monitoringEmitter: new MonitoringEmitter(
        new EventEmitter(),
        async () => {},
      ),
      modelCatalog: undefined,
      metricsLog: [],
      providerService: {
        listProviderConnections: () => [],
        getLaunchabilityRevision: () => 0,
      },
      getAgentConfigurationRevision: () => 0,
      configLoader: { getLaunchabilityRevision: () => 0 },
      commitAgentConfigurationRead: async (
        _revision: number,
        work: () => Promise<unknown>,
      ) => work(),
    };
    // The route consumes this bounded fixture; unrelated RuntimeContext services are absent.
    const runtime = ctx as unknown as RuntimeContext;
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
