/**
 * #3112: a real VoltAgent agent over a real file store is handed the
 * authored turn plus a model-input composer. The store keeps the authored
 * turn; only the model reads the composed one.
 */
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { beforeEach, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import type { ModelInputMessage } from '../../types.js';
import { VoltAgentFramework } from '../voltagent-adapter.js';

const CONTEXT = '[Timezone: Europe/Berlin]';

const makeTempDir = trackTempDirs();
let storage: FileMemoryAdapter;

beforeEach(() => {
  storage = new FileMemoryAdapter({
    projectHomeDir: makeTempDir('station-volt-model-input-'),
  });
});

function answeringModel() {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start' as const, id: 'a' },
          { type: 'text-delta' as const, id: 'a', delta: 'Noted.' },
          { type: 'text-end' as const, id: 'a' },
          {
            type: 'finish' as const,
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: 0,
                cacheWrite: 0,
              },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ] as any,
      }),
    }),
  });
}

async function run(
  input: string | ModelInputMessage[],
  composeModelInput: (
    input: string | ModelInputMessage[],
  ) => string | ModelInputMessage[],
  conversationId: string,
) {
  const model = answeringModel();
  const agent = await new VoltAgentFramework().createTempAgent({
    agentId: 'assistant',
    name: 'assistant',
    instructions: 'Answer briefly.',
    model,
    memoryAdapter: storage as any,
  });
  const result = await agent.streamText(input as string, {
    userId: 'owner',
    conversationId,
    composeModelInput,
  });
  for await (const _chunk of result.fullStream) {
    // drain: VoltAgent persists the turn as the stream is consumed
  }
  await result.text;
  const stored = (await storage.getMessages('owner', conversationId)) as Array<{
    role: string;
    parts: Array<{ type: string; text?: string }>;
  }>;
  return { model, stored };
}

test('a text turn is stored as typed while the model reads the composed text', async () => {
  const { model, stored } = await run(
    'What changed?',
    (input) => `${CONTEXT}\n${input as string}`,
    'text-turn',
  );
  expect(stored[0]).toMatchObject({
    role: 'user',
    parts: [{ type: 'text', text: 'What changed?' }],
  });
  const prompt = model.doStreamCalls[0]!.prompt;
  expect(prompt.at(-1)).toMatchObject({
    role: 'user',
    content: [{ type: 'text', text: `${CONTEXT}\nWhat changed?` }],
  });
});

test('a multipart turn is stored as authored while a composed context message reaches the model', async () => {
  const authored: ModelInputMessage[] = [
    {
      id: 'authored-1',
      role: 'user',
      parts: [
        { type: 'text', text: 'Describe this.' },
        {
          type: 'file',
          url: 'data:text/plain;base64,aGk=',
          mediaType: 'text/plain',
        } as { type: string },
      ],
    },
  ];
  const { model, stored } = await run(
    authored,
    (input) => [
      { role: 'user', parts: [{ type: 'text', text: CONTEXT }] },
      ...(input as ModelInputMessage[]),
    ],
    'multipart-turn',
  );
  const storedText = JSON.stringify(stored);
  expect(storedText).toContain('Describe this.');
  expect(storedText).not.toContain(CONTEXT);
  const prompt = JSON.stringify(model.doStreamCalls[0]!.prompt);
  expect(prompt).toContain(CONTEXT);
  expect(prompt.indexOf(CONTEXT)).toBeLessThan(
    prompt.indexOf('Describe this.'),
  );
});
