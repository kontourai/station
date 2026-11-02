import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import {
  createAgentRuntime,
  durableLanguageModel,
  openSqliteAgentJournal,
  runWithAgentTurn,
} from '../index.js';

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
          if (index < 400) {
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
for await (const part of result.stream) {
  if (part.type !== 'text-delta') continue;
  const acknowledged = new Promise<void>((resolve) =>
    process.once('message', () => resolve()),
  );
  await lease.frame(`answer:${count}`, `data: ${JSON.stringify(part)}\n\n`);
  process.send?.({ index: count++, delta: part.delta });
  await acknowledged;
  if (count === 400) finish();
}
await journal.close();
database.close();
