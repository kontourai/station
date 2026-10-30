import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, test, vi } from 'vitest';
import { VoltAgentFramework } from '../../../runtime/frameworks/voltagent-adapter.js';
import { generateConversationTitle } from '../chat-title-generation.js';

function createCtx(overrides: Record<string, unknown> = {}) {
  return {
    appConfig: { titleModel: 'title-model' },
    framework: {
      createModel: vi.fn().mockResolvedValue({ kind: 'model' }),
      createTempAgent: vi.fn(),
    },
    configLoader: { getProjectHomeDir: () => '/tmp/project' },
    modelCatalog: undefined,
    providerService: { listProviderConnections: vi.fn(() => []) },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  } as any;
}

describe('generateConversationTitle (station#1566)', () => {
  test.each([
    ['empty', { titleModel: '' }],
    ['absent', {}],
    // #4266: the prompt quotes the conversation; a model configured for
    // another purpose never receives it.
    ['absent, though a structure model is set', { structureModel: 'nova' }],
  ])(
    'returns null without building a model when titleModel is %s',
    async (_label, appConfig) => {
      const ctx = createCtx({ appConfig });

      const title = await generateConversationTitle({
        ctx,
        firstUserText: 'How do I deploy this?',
        assistantText: 'Here is how you deploy it.',
      });

      expect(title).toBeNull();
      expect(ctx.framework.createModel).not.toHaveBeenCalled();
      expect(ctx.framework.createTempAgent).not.toHaveBeenCalled();
    },
  );

  test('a hosted Station builds no model and calls none (#4266)', async () => {
    vi.stubEnv('STATION_HOSTED_TENANT_REGISTRY_FILE', '/srv/tenants.json');
    try {
      const ctx = createCtx();
      const title = await generateConversationTitle({
        ctx,
        firstUserText: 'How do I deploy this?',
        assistantText: 'Here is how you deploy it.',
      });
      expect(title).toBeNull();
      expect(ctx.framework.createModel).not.toHaveBeenCalled();
      expect(ctx.framework.createTempAgent).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test.each([
    [
      '  "Deploying the app to production"  ',
      'Deploying the app to production',
    ],
    ['वनस्पति पत्रिकाओं का संग्रह', 'वनस्पति पत्रिकाओं का संग्रह'],
    ['தாவரவியல் இதழ்களை பாதுகாத்தல்', 'தாவரவியல் இதழ்களை பாதுகாத்தல்'],
    ['การเก็บรักษาวารสารพฤกษศาสตร์', 'การเก็บรักษาวารสารพฤกษศาสตร์'],
    ['Cafe\u0301 botanical journals', 'Café botanical journals'],
  ])('accepts a valid generated title: %s', async (text, expected) => {
    const generateText = vi.fn().mockResolvedValue({
      text,
    });
    const ctx = createCtx({
      framework: {
        createModel: vi.fn().mockResolvedValue({ kind: 'model' }),
        createTempAgent: vi.fn().mockResolvedValue({ generateText }),
      },
    });

    const title = await generateConversationTitle({
      ctx,
      firstUserText: 'How do I deploy this app?',
      assistantText: 'Run the deploy script.',
    });

    expect(title).toBe(expected);
    expect(ctx.framework.createTempAgent).toHaveBeenCalledOnce();
    expect(generateText).toHaveBeenCalledOnce();
  });

  test('strips single-quote wrapping and collapses internal whitespace', async () => {
    const generateText = vi.fn().mockResolvedValue({
      text: "'Fixing   the   login   bug'",
    });
    const ctx = createCtx({
      framework: {
        createModel: vi.fn().mockResolvedValue({ kind: 'model' }),
        createTempAgent: vi.fn().mockResolvedValue({ generateText }),
      },
    });

    const title = await generateConversationTitle({
      ctx,
      firstUserText: 'The login is broken',
      assistantText: "Let's fix it",
    });

    expect(title).toBe('Fixing the login bug');
  });

  test('caps the generated title at 60 characters', async () => {
    const longTitle = 'A'.repeat(80);
    const generateText = vi.fn().mockResolvedValue({
      text: longTitle,
    });
    const ctx = createCtx({
      framework: {
        createModel: vi.fn().mockResolvedValue({ kind: 'model' }),
        createTempAgent: vi.fn().mockResolvedValue({ generateText }),
      },
    });

    const title = await generateConversationTitle({
      ctx,
      firstUserText: 'hello',
      assistantText: 'hi',
    });

    expect(title).toHaveLength(60);
    expect(title).toBe(longTitle.slice(0, 60));
  });

  test('returns null when the model produces an empty title after trimming', async () => {
    const generateText = vi.fn().mockResolvedValue({
      text: '   ',
    });
    const ctx = createCtx({
      framework: {
        createModel: vi.fn().mockResolvedValue({ kind: 'model' }),
        createTempAgent: vi.fn().mockResolvedValue({ generateText }),
      },
    });

    const title = await generateConversationTitle({
      ctx,
      firstUserText: 'hello',
      assistantText: 'hi',
    });

    expect(title).toBeNull();
  });

  test('returns null and logs at debug level when the temp agent throws', async () => {
    const ctx = createCtx({
      framework: {
        createModel: vi
          .fn()
          .mockRejectedValue(new Error('provider unavailable')),
        createTempAgent: vi.fn(),
      },
    });

    const title = await generateConversationTitle({
      ctx,
      firstUserText: 'hello',
      assistantText: 'hi',
    });

    expect(title).toBeNull();
    expect(ctx.logger.debug).toHaveBeenCalledWith(
      'Chat title generation failed',
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });

  test('returns null when generation exceeds the timeout', async () => {
    vi.useFakeTimers();
    try {
      const generateText = vi.fn(
        () => new Promise(() => {}), // never resolves
      );
      const ctx = createCtx({
        framework: {
          createModel: vi.fn().mockResolvedValue({ kind: 'model' }),
          createTempAgent: vi.fn().mockResolvedValue({ generateText }),
        },
      });

      const resultPromise = generateConversationTitle({
        ctx,
        firstUserText: 'hello',
        assistantText: 'hi',
      });

      await vi.advanceTimersByTimeAsync(10_000);

      expect(await resultPromise).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

test('generates through the real VoltAgent adapter with text output', async () => {
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'Deploying the app' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  });
  const framework = new VoltAgentFramework();
  vi.spyOn(framework, 'createModel').mockResolvedValue(model);
  const runtime = createCtx({ framework });
  const result = await generateConversationTitle({
    ctx: runtime,
    firstUserText: 'Deploy?',
    assistantText: 'Use the script.',
  });
  expect(result).toBe('Deploying the app');
  expect(model.doGenerateCalls[0]?.responseFormat?.type).not.toBe('json');
});

test('generates a title through a text-only provider without a structured response format', async () => {
  const model = new MockLanguageModelV3({
    doGenerate: async ({ responseFormat }) => {
      if (responseFormat?.type === 'json')
        throw new Error('structured output unsupported');
      return {
        content: [{ type: 'text', text: 'Botanical Journal Storage' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    },
  });
  const framework = new VoltAgentFramework();
  vi.spyOn(framework, 'createModel').mockResolvedValue(model);
  expect(
    await generateConversationTitle({
      ctx: createCtx({ framework }),
      firstUserText: 'Store botanical journals?',
      assistantText: 'Keep them dry.',
    }),
  ).toBe('Botanical Journal Storage');
});
