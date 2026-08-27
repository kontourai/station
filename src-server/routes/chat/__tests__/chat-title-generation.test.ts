import { describe, expect, test, vi } from 'vitest';
import { generateConversationTitle } from '../chat-title-generation.js';

function createCtx(overrides: Record<string, unknown> = {}) {
  return {
    appConfig: { structureModel: 'structure-model' },
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
  test('returns null immediately when structureModel is empty', async () => {
    const ctx = createCtx({ appConfig: { structureModel: '' } });

    const title = await generateConversationTitle({
      ctx,
      firstUserText: 'How do I deploy this?',
      assistantText: 'Here is how you deploy it.',
    });

    expect(title).toBeNull();
    expect(ctx.framework.createModel).not.toHaveBeenCalled();
  });

  test('returns null immediately when structureModel is absent', async () => {
    const ctx = createCtx({ appConfig: {} });

    const title = await generateConversationTitle({
      ctx,
      firstUserText: 'How do I deploy this?',
      assistantText: 'Here is how you deploy it.',
    });

    expect(title).toBeNull();
  });

  test('returns a post-processed title on the success path', async () => {
    const generateObject = vi.fn().mockResolvedValue({
      object: { title: '  "Deploying the app to production"  ' },
    });
    const ctx = createCtx({
      framework: {
        createModel: vi.fn().mockResolvedValue({ kind: 'model' }),
        createTempAgent: vi.fn().mockResolvedValue({ generateObject }),
      },
    });

    const title = await generateConversationTitle({
      ctx,
      firstUserText: 'How do I deploy this app?',
      assistantText: 'Run the deploy script.',
    });

    expect(title).toBe('Deploying the app to production');
    expect(ctx.framework.createTempAgent).toHaveBeenCalledOnce();
    expect(generateObject).toHaveBeenCalledOnce();
  });

  test('strips single-quote wrapping and collapses internal whitespace', async () => {
    const generateObject = vi.fn().mockResolvedValue({
      object: { title: "'Fixing   the   login   bug'" },
    });
    const ctx = createCtx({
      framework: {
        createModel: vi.fn().mockResolvedValue({ kind: 'model' }),
        createTempAgent: vi.fn().mockResolvedValue({ generateObject }),
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
    const generateObject = vi.fn().mockResolvedValue({
      object: { title: longTitle },
    });
    const ctx = createCtx({
      framework: {
        createModel: vi.fn().mockResolvedValue({ kind: 'model' }),
        createTempAgent: vi.fn().mockResolvedValue({ generateObject }),
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
    const generateObject = vi.fn().mockResolvedValue({
      object: { title: '   ' },
    });
    const ctx = createCtx({
      framework: {
        createModel: vi.fn().mockResolvedValue({ kind: 'model' }),
        createTempAgent: vi.fn().mockResolvedValue({ generateObject }),
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
      const generateObject = vi.fn(
        () => new Promise(() => {}), // never resolves
      );
      const ctx = createCtx({
        framework: {
          createModel: vi.fn().mockResolvedValue({ kind: 'model' }),
          createTempAgent: vi.fn().mockResolvedValue({ generateObject }),
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
