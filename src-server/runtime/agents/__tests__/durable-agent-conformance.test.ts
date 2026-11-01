import { mkdtempDisposableSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  LanguageModelV3,
  LanguageModelV3StreamPart,
} from '@ai-sdk/provider';
import {
  type AgentJournal,
  type AgentJournalContext,
  type AgentJournalProtocol,
  type AgentTurnLease,
  createAgentRuntime,
  durableLanguageModel,
  openSqliteAgentJournal,
  runWithAgentTurn,
} from '@kontourai/agent-runtime';
import { openAtomicCrashPointStore } from '@kontourai/monument/testing';
import { VercelModel } from '@strands-agents/sdk/models/vercel';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import { StrandsFramework } from '../../frameworks/strands-adapter.js';
import { durableStrandsModel } from '../../frameworks/strands-durable-model.js';
import { VoltAgentFramework } from '../../frameworks/voltagent-adapter.js';
import {
  flushDurableAgentMemory,
  persistDurableAuthoredMessage,
} from '../durable-agent-memory.js';

import { waitDurableToolApproval } from '../durable-agent-tools.js';

const cleanup: Array<() => void | Promise<void>> = [];
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
const finish = (tool = false): LanguageModelV3StreamPart => ({
  type: 'finish',
  finishReason: {
    unified: tool ? 'tool-calls' : 'stop',
    raw: tool ? 'tool_calls' : 'stop',
  },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
});
async function fixture(
  framework: 'voltagent' | 'strands',
  replay: 'safe' | 'unsafe',
  body: () => Promise<unknown>,
  controls: {
    beforeTool?: () => Promise<boolean>;
    partial?: ReturnType<typeof gate>;
  } = {},
) {
  const dir = mkdtempDisposableSync(
    join(tmpdir(), 'native-agent-conformance-'),
  );
  cleanup.push(() => dir.remove());
  const db = new DatabaseSync(join(dir.path, 'journal.sqlite'));
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON',
  );
  cleanup.push(() => db.close());
  const crash = await openAtomicCrashPointStore<
    AgentJournalProtocol,
    AgentJournalContext,
    DatabaseSync
  >({
    open: async (options) =>
      openSqliteAgentJournal({
        database: db,
        participants: options?.participants,
      }),
    dispose: async () => {},
  });
  cleanup.push(() => crash.dispose());
  let dead = false;
  const owner = {
    id: 'first',
    pid: 123,
    identityKind: 'exact' as const,
    birth: 'first',
  };
  const successor = { ...owner, id: 'next', birth: 'next' };
  const liveness = (candidate: { id: string }) =>
    dead && candidate.id === owner.id ? ('dead' as const) : ('live' as const);
  let holdIntent = false;
  const intentEntered = gate();
  const partialSeen = gate();
  const journal: AgentJournal = {
    close: async () => {},
    execute: async (command, context) => {
      if (
        holdIntent &&
        command.type === 'effectPlan' &&
        command.intent.kind === 'tool'
      ) {
        holdIntent = false;
        const held = crash.holdNextCommit();
        void held.entered.then(() => intentEntered.resolve());
      }
      return crash.storage.execute(command, context);
    },
  };
  const runtime = createAgentRuntime({
    journal,
    owner,
    liveness,
    implementation: 'native-conformance/1',
  });
  const key = {
    scopeId: 'native',
    conversationId: 'conversation',
    invocationId: 'turn',
  };
  const lease = await runtime.start({
    key,
    input: 'authored',
    implementation: 'native-conformance/1',
  });
  const storage = new FileMemoryAdapter({ projectHomeDir: dir.path });
  await storage.createConversation({
    id: key.conversationId,
    resourceId: 'assistant',
    userId: 'owner',
    title: 'Conformance',
    metadata: {},
  });
  const calls: unknown[] = [];
  const results: unknown[] = [];
  const raw: LanguageModelV3 = {
    specificationVersion: 'v3',
    provider: 'scripted',
    modelId: 'native',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('stream required');
    },
    doStream: async (options) => {
      calls.push(options.prompt);
      const afterTool = options.prompt.some(
        (message) => message.role === 'tool',
      );
      const parts: LanguageModelV3StreamPart[] = afterTool
        ? [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'answer' },
            { type: 'text-delta', id: 'answer', delta: 'DONE' },
            { type: 'text-end', id: 'answer' },
            finish(),
          ]
        : [
            { type: 'stream-start', warnings: [] },
            {
              type: 'tool-call',
              toolCallId: 'call-1',
              toolName: 'probe',
              input: '{}',
            },
            finish(true),
          ];
      if (calls.length > 3) throw new Error('Unexpected native model loop');
      return {
        stream: new ReadableStream({
          async start(controller) {
            if (controls.partial && calls.length === 1) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({ type: 'text-start', id: 'partial' });
              controller.enqueue({
                type: 'text-delta',
                id: 'partial',
                delta: 'PARTIAL',
              });
              await controls.partial.promise;
              controller.enqueue({ type: 'text-end', id: 'partial' });
              controller.enqueue(finish());
            } else for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      };
    },
  };
  const model =
    framework === 'voltagent'
      ? raw
      : durableStrandsModel(
          new VercelModel({
            provider: durableLanguageModel(raw, { layer: 'provider' }),
          }),
          'scripted/1',
        );
  const Framework =
    framework === 'voltagent' ? VoltAgentFramework : StrandsFramework;
  const makeAgent = () =>
    new Framework().createTempAgent({
      agentId: 'assistant',
      name: 'Assistant',
      instructions: 'Use probe once.',
      model,
      memoryAdapter: storage,
      tools: [
        {
          name: 'probe',
          description: 'Probe',
          parameters: z.object({}),
          replay,
          execute: body,
        },
      ],
      hooks: {
        beforeToolCall: controls.beforeTool ?? (async () => true),
        afterToolCall: async (tool) => {
          results.push(tool);
        },
      },
    });
  const consume = async (current: AgentTurnLease) =>
    runWithAgentTurn(current, async () => {
      await persistDurableAuthoredMessage(
        current,
        storage,
        'authored',
        'owner',
      );
      const agent = await makeAgent();
      const response = await agent.streamText('authored', {
        userId: 'owner',
        conversationId: key.conversationId,
      });
      void response.text?.catch(() => {});
      void response.usage?.catch(() => {});
      void response.finishReason?.catch(() => {});
      const chunks = [];
      for await (const chunk of response.fullStream) {
        chunks.push(chunk);
        if (
          chunk.type === 'text-delta' &&
          (chunk.text ?? chunk.delta) === 'PARTIAL'
        )
          partialSeen.resolve();
      }
      // Some SDK versions report an error part, others reject the text promise.
      const text = await response.text;
      await response.usage;
      await response.finishReason;
      await flushDurableAgentMemory(current);
      return { text, chunks };
    });
  return {
    lease,
    armBeforeIntent: () => {
      holdIntent = true;
    },
    intentEntered: intentEntered.promise,
    partialSeen: partialSeen.promise,
    crash,
    db,
    calls,
    results,
    consume,
    async recover() {
      dead = true;
      await crash.reopen();
      const next = createAgentRuntime({
        journal,
        owner: successor,
        liveness,
        implementation: 'native-conformance/1',
      });
      const recovered = await next.recover(key);
      if (typeof recovered === 'string')
        throw new Error(`Recovery prerequisite: ${recovered}`);
      return recovered;
    },
  };
}
for (const framework of ['voltagent', 'strands'] as const) {
  for (const replay of ['safe', 'unsafe'] as const) {
    it(`${framework}: interrupted ${replay} body recovers through the real tool loop`, async () => {
      const entered = gate();
      const release = gate();
      let executions = 0;
      const f = await fixture(framework, replay, async () => {
        executions++;
        if (executions === 1) {
          entered.resolve();
          await release.promise;
        }
        return 'EFFECT';
      });
      const old = f.consume(f.lease).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      cleanup.push(async () => {
        release.resolve();
        await old;
      });
      await Promise.race([
        entered.promise,
        old.then((outcome) => {
          if ('error' in outcome) throw outcome.error;
          throw new Error(
            'The native loop returned before tool entry: ' +
              JSON.stringify(outcome),
          );
        }),
      ]);
      const recovered = await f.recover();
      const answer = await f.consume(recovered);
      expect(answer.text).toBe('DONE');
      expect(executions).toBe(replay === 'safe' ? 2 : 1);
      expect(f.calls).toHaveLength(2);
      const finalPrompt = JSON.stringify(f.calls.at(-1));
      expect(finalPrompt).toContain(
        replay === 'safe' ? 'EFFECT' : 'indeterminate',
      );
      release.resolve();
      await old;
    });
  }
  it(`${framework}: completed model and tool tapes replay without repeating external effects`, async () => {
    let executions = 0;
    const f = await fixture(framework, 'unsafe', async () => {
      executions++;
      return 'EFFECT';
    });
    expect((await f.consume(f.lease)).text).toBe('DONE');
    expect((await f.consume(await f.recover())).text).toBe('DONE');
    expect(executions).toBe(1);
    expect(f.calls).toHaveLength(2);
  });
}

for (const framework of ['voltagent', 'strands'] as const) {
  it(`${framework}: a crash before tool intent re-enters the native step once`, async () => {
    let effects = 0;
    const f = await fixture(framework, 'unsafe', async () => ++effects);
    f.armBeforeIntent();
    const old = f.consume(f.lease).catch((error) => error);
    await Promise.race([
      f.intentEntered,
      old.then((value) => {
        throw new Error(
          'Native loop returned before the held tool intent: ' + String(value),
        );
      }),
    ]);
    expect(effects).toBe(0);
    const recovered = await f.recover();
    await old;
    expect((await f.consume(recovered)).text).toBe('DONE');
    expect(effects).toBe(1);
    expect(f.calls).toHaveLength(2);
  });
  it(`${framework}: mid-stream crash retains aborted output and refuses provider redispatch`, async () => {
    const release = gate();
    const f = await fixture(framework, 'unsafe', async () => 'unused', {
      partial: release,
    });
    const old = f.consume(f.lease).catch((error) => error);
    cleanup.push(async () => {
      release.resolve();
      await old;
    });
    await f.partialSeen;
    const recovered = await f.recover();
    await expect(f.consume(recovered)).rejects.toThrow(/INDETERMINATE|BUSY/);
    expect(f.calls).toHaveLength(1);
    const effect = await recovered.effect({
      type: 'effectRead',
      id: 'model:0',
    });
    expect(effect.effect.attempts[0]).toMatchObject({
      state: 'aborted',
      output: null,
    });
    expect(effect.effect.attempts[0]?.partials.join('')).toContain('PARTIAL');
    release.resolve();
    await old;
  });
  it(`${framework}: pending approval survives takeover and needs one explicit answer`, async () => {
    const asked = gate();
    const askedAgain = gate();
    const answer = gate();
    let effects = 0;
    const requests: Array<{ id: string; remaining: number }> = [];
    const f = await fixture(framework, 'unsafe', async () => ++effects, {
      beforeTool: () =>
        waitDurableToolApproval('volatile', 60_000, async (id, remaining) => {
          requests.push({ id, remaining });
          if (requests.length === 1) asked.resolve();
          else askedAgain.resolve();
          await answer.promise;
          return true;
        }),
    });
    const old = f.consume(f.lease).catch((error) => error);
    cleanup.push(async () => {
      answer.resolve();
      await old;
    });
    await Promise.race([
      asked.promise,
      old.then((value) => {
        throw new Error(
          'Native loop completed without requesting approval: ' + String(value),
        );
      }),
    ]);
    const recovered = await f.recover();
    const next = f.consume(recovered);
    await Promise.race([
      askedAgain.promise,
      next.then(() => {
        throw new Error(
          'Recovery completed without an explicit approval answer',
        );
      }),
    ]);
    expect(effects).toBe(0);
    expect(requests[1]?.id).toBe(requests[0]?.id);
    expect(requests[1]?.remaining).toBeLessThanOrEqual(requests[0]!.remaining);
    answer.resolve();
    expect((await next).text).toBe('DONE');
    await old;
    expect(effects).toBe(1);
  });
}
