import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import {
  createAgentRuntime,
  durableLanguageModel,
  openSqliteAgentJournal,
  runWithAgentTurn,
} from '../index.js';

const started = performance.now();
let frameMs = 0;
let ipcMs = 0;
const total = Number(process.argv[3] ?? 400);
if (!Number.isSafeInteger(total) || total < 400 || total > 3200)
  throw new Error('Invalid fixture delta count');
const database = new DatabaseSync(process.argv[2]!);
database.exec(
  'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON',
);
const journal = openSqliteAgentJournal({ database });
const runtime = createAgentRuntime({
  journal,
  owner: {
    id: 'child',
    pid: process.pid,
    birth: 'child',
    identityKind: 'exact',
  },
  liveness: () => 'live',
  implementation: 'prefix/1',
});
const lease = await runtime.start({
  key: {
    scopeId: 'prefix',
    conversationId: 'conversation',
    invocationId: 'turn',
  },
  input: 'input',
  implementation: 'prefix/1',
});
const initialized = performance.now();
process.send?.({ kind: 'ready' });
let finish!: () => void;
const displayed = new Promise<void>((resolve) => {
  finish = resolve;
});
const model = durableLanguageModel({
  specificationVersion: 'v3',
  provider: 'scripted',
  modelId: 'prefix',
  supportedUrls: {},
  doGenerate: async () => {
    throw new Error('stream required');
  },
  doStream: async () => {
    let index = 0;
    return {
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        async pull(controller) {
          if (index < total) {
            await delay(1);
            controller.enqueue({
              type: 'text-delta',
              id: 'answer',
              delta: String(index++).padStart(4, '0'),
            });
          } else {
            await displayed;
            controller.enqueue({
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: {
                  total: 1,
                  noCache: 1,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
              },
            });
            controller.close();
          }
        },
      }),
    };
  },
});
const result = await runWithAgentTurn(lease, () =>
  model.doStream({ prompt: [] }),
);
let count = 0;
const batchSize = total > 400 ? 50 : 1;
let pending: Array<{ index: number; delta: string }> = [];
const publish = async () => {
  const batch = pending;
  pending = [];
  const acknowledged = new Promise<void>((resolve) =>
    process.once('message', () => resolve()),
  );
  const frameStart = performance.now();
  const frames = batch.flatMap(({ index, delta }) => [
    {
      id: `answer:${index}`,
      wire: `data: ${JSON.stringify({ type: 'text-delta', id: 'answer', delta })}\n\n`,
    },
    { id: `control:${index}`, wire: 'data: {"type":"checkpoint"}\n\n' },
  ]);
  if (batchSize === 1) {
    for (const frame of frames) await lease.frame(frame.id, frame.wire);
  } else await lease.frameBatch(frames);
  frameMs += performance.now() - frameStart;
  if (count === 1 || count % 100 === 0)
    console.error(
      '[prefix-phase]',
      JSON.stringify({
        count,
        initMs: initialized - started,
        elapsedMs: performance.now() - initialized,
        frameMs,
        ipcMs,
      }),
    );
  process.send?.(batch);
  const ipcStart = performance.now();
  await acknowledged;
  ipcMs += performance.now() - ipcStart;
};
for await (const part of result.stream) {
  if (part.type !== 'text-delta') continue;
  pending.push({ index: count++, delta: part.delta });
  // Keep small probes individually acknowledged; the large probe uses the
  // foreground's atomic frame-batch contract before showing any of the batch.
  if (pending.length === batchSize) await publish();
  if (count === total) {
    if (pending.length) await publish();
    finish();
  }
}
await journal.close();
database.close();
