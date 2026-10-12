/**
 * #3112: a real VoltAgent agent over a real file store is handed the
 * authored turn plus a model-input composer. The store keeps the authored
 * turn; only the model reads the composed one.
 */
import { simulateReadableStream } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { beforeEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { FileMemoryAdapter } from '../../../adapters/file/memory-adapter.js';
import type { ModelInputMessage } from '../../types.js';
import {
  composeInputAtModelSeam,
  VoltAgentFramework,
} from '../voltagent-adapter.js';

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
  options: {
    hooks?: Record<string, unknown>;
    agentPrepareMessages?: (args: { messages: unknown[] }) => unknown;
  } = {},
) {
  const model = answeringModel();
  const agent = await new VoltAgentFramework().createTempAgent({
    agentId: 'assistant',
    name: 'assistant',
    instructions: 'Answer briefly.',
    model,
    memoryAdapter: storage as any,
  });
  if (options.agentPrepareMessages) {
    // Stands in for an agent-level hook such as VoltAgent's workspace skills
    // prompt, which the per-call composition must not replace.
    const inner = (agent as unknown as { inner: { hooks: any } }).inner;
    inner.hooks = {
      ...inner.hooks,
      onPrepareMessages: options.agentPrepareMessages,
    };
  }
  let error: unknown;
  try {
    const result = await agent.streamText(input as string, {
      userId: 'owner',
      conversationId,
      composeModelInput,
      ...(options.hooks ? { hooks: options.hooks } : {}),
    });
    for await (const chunk of result.fullStream) {
      // drain: VoltAgent persists the turn as the stream is consumed
      if ((chunk as { type?: string }).type === 'error')
        error ??= (chunk as { error?: unknown }).error ?? chunk;
    }
    await result.text;
  } catch (caught) {
    error = caught;
  }
  const stored = (await storage.getMessages('owner', conversationId)) as Array<{
    id: string;
    role: string;
    parts: Array<{ type: string; text?: string }>;
  }>;
  return { model, stored, error };
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

test('an id-less multipart turn still reaches the model with its context', async () => {
  const { model, stored, error } = await run(
    [{ role: 'user', parts: [{ type: 'text', text: 'No id here.' }] }],
    (input) => [
      { role: 'user', parts: [{ type: 'text', text: CONTEXT }] },
      ...(input as ModelInputMessage[]),
    ],
    'idless-turn',
  );
  expect(error).toBeUndefined();
  expect(JSON.stringify(model.doStreamCalls[0]!.prompt)).toContain(CONTEXT);
  expect(stored[0]).toMatchObject({
    role: 'user',
    id: expect.any(String),
    parts: [{ type: 'text', text: 'No id here.' }],
  });
});

test.each([
  [
    'a string turn VoltAgent did not append as typed',
    // Whitespace-only text is dropped from the prepared messages, so the
    // tail is no longer the authored turn.
    '   ',
  ],
  [
    'a model-message array VoltAgent re-identifies',
    // Converted to UI messages under fresh ids, so no tail id matches.
    [
      { role: 'user', content: 'Re-identified.' },
    ] as unknown as ModelInputMessage[],
  ],
])(
  '%s fails the turn instead of reaching the model without its context',
  async (_label, input) => {
    const { model, error } = await run(
      input,
      (authored) =>
        typeof authored === 'string'
          ? `${CONTEXT}\n${authored}`
          : [
              { role: 'user', parts: [{ type: 'text', text: CONTEXT }] },
              ...authored,
            ],
      `mismatch-${typeof input}`,
    );
    expect(String((error as Error)?.message ?? error)).toContain(
      'does not end with the authored turn',
    );
    expect(model.doStreamCalls).toHaveLength(0);
  },
);

test("the caller's and the agent's own prepare hooks still run, after the composition", async () => {
  const seen: string[] = [];
  const marker =
    (label: string) =>
    async ({ messages }: { messages: any[] }) => {
      seen.push(`${label}:${JSON.stringify(messages.at(-1))}`);
      return {
        messages: [
          ...messages,
          { id: label, role: 'user', parts: [{ type: 'text', text: label }] },
        ],
      };
    };
  const callerRun = await run(
    'Hello caller.',
    (input) => `${CONTEXT}\n${input as string}`,
    'caller-hook',
    { hooks: { onPrepareMessages: marker('caller-hook') } },
  );
  const agentRun = await run(
    'Hello agent.',
    (input) => `${CONTEXT}\n${input as string}`,
    'agent-hook',
    { agentPrepareMessages: marker('agent-hook') },
  );
  for (const [label, outcome] of [
    ['caller-hook', callerRun],
    ['agent-hook', agentRun],
  ] as const) {
    expect(outcome.error).toBeUndefined();
    // The hook saw the composed turn, and its own change reached the model.
    expect(seen.find((entry) => entry.startsWith(label))).toContain(CONTEXT);
    const prompt = JSON.stringify(outcome.model.doStreamCalls[0]!.prompt);
    expect(prompt).toContain(CONTEXT);
    expect(prompt).toContain(label);
  }
});

describe('composeInputAtModelSeam rejects any tail that is not the authored turn', () => {
  const compose = (input: string | ModelInputMessage[]) =>
    typeof input === 'string' ? `${CONTEXT}\n${input}` : input;
  const history = {
    id: 'h1',
    role: 'assistant',
    parts: [{ type: 'text', text: 'Earlier.' }],
  };
  const user = (id: string, text: string, role = 'user') => ({
    id,
    role,
    parts: [{ type: 'text', text }],
  });

  test.each([
    ['different text', [history, user('u1', 'Something else')]],
    ['not a user message', [history, user('u1', 'Typed', 'assistant')]],
    [
      'more than one part',
      [
        history,
        {
          id: 'u1',
          role: 'user',
          parts: [
            { type: 'text', text: 'Typed' },
            { type: 'text', text: 'Extra' },
          ],
        },
      ],
    ],
    ['no messages at all', []],
  ])('string turn: %s', async (_label, messages) => {
    await expect(
      composeInputAtModelSeam('Typed', compose)({ messages: messages as any }),
    ).rejects.toThrow('does not end with the authored turn');
  });

  test('string turn: the exact tail is composed', async () => {
    const result = await composeInputAtModelSeam(
      'Typed',
      compose,
    )({
      messages: [history, user('u1', 'Typed')] as any,
    });
    expect(result.messages.at(-1)).toMatchObject({
      parts: [{ type: 'text', text: `${CONTEXT}\nTyped` }],
    });
  });

  test.each([
    [
      'a different id',
      [user('a1', 'Typed')],
      [history, user('other', 'Typed')],
    ],
    [
      'a different role',
      [user('a1', 'Typed')],
      [history, user('a1', 'Typed', 'assistant')],
    ],
    [
      'an id-less input',
      [{ role: 'user', parts: [{ type: 'text', text: 'Typed' }] }],
      [history, { role: 'user', parts: [{ type: 'text', text: 'Typed' }] }],
    ],
    [
      'duplicate input ids',
      [user('a1', 'One'), user('a1', 'Two')],
      [user('a1', 'One'), user('a1', 'Two')],
    ],
    [
      'a shorter tail',
      [user('a1', 'One'), user('a2', 'Two')],
      [user('a2', 'Two')],
    ],
  ])('array turn: %s', async (_label, input, messages) => {
    await expect(
      composeInputAtModelSeam(
        input as ModelInputMessage[],
        compose,
      )({ messages: messages as any }),
    ).rejects.toThrow('does not end with the authored turn');
  });
});
