import { describe, expect, test, vi } from 'vitest';
import {
  conversationIntentRevision,
  generateSessionSummary,
  isSessionSummaryFailure,
  renderSessionSummaryTranscript,
  SESSION_SUMMARY_TRANSCRIPT_MAX_CHARS,
} from '../session-summary-generation.js';

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    appConfig: { structureModel: 'structure-model' },
    framework: {
      createModel: vi.fn().mockResolvedValue({}),
      createTempAgent: vi.fn(),
    },
    configLoader: { getProjectHomeDir: () => '/tmp/project' },
    providerService: { listProviderConnections: vi.fn(() => []) },
    logger: { debug: vi.fn(), warn: vi.fn() },
    ...overrides,
  } as any;
}

describe('generateSessionSummary', () => {
  test('uses a one-shot structure model and a named bounded transcript input', async () => {
    const generateObject = vi
      .fn()
      .mockResolvedValue({ object: { summary: 'Decision made.' } });
    const runtime = ctx({
      framework: {
        createModel: vi.fn().mockResolvedValue({}),
        createTempAgent: vi.fn().mockResolvedValue({ generateObject }),
      },
    });
    const messages = [
      {
        id: 'm1',
        role: 'user',
        parts: [
          {
            type: 'text',
            text: 'A'.repeat(SESSION_SUMMARY_TRANSCRIPT_MAX_CHARS),
          },
        ],
      },
      {
        id: 'm2',
        role: 'assistant',
        parts: [{ type: 'text', text: 'B'.repeat(200) }],
      },
    ] as any;
    const result = await generateSessionSummary({ ctx: runtime, messages });
    expect(result).toMatchObject({
      model: 'structure-model',
      summarizedThroughMessageId: 'm2',
      sourceMessageCount: 2,
      partialMessageIncluded: false,
    });
    expect(runtime.framework.createTempAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'session-summary-generator',
        maxSteps: 1,
        tools: [],
      }),
    );
    expect(generateObject.mock.calls[0]![0].length).toBeLessThanOrEqual(
      SESSION_SUMMARY_TRANSCRIPT_MAX_CHARS,
    );
    expect(generateObject.mock.calls[0]![0]).toContain('[…truncated…]');
  });

  test('names the missing structure model instead of returning a bare null', async () => {
    // This asserted `toBeNull()`, which is the shape that produced the
    // defect: four distinct situations all returned null, so the route could
    // only render them as one ambiguous disjunction — "no structure model is
    // configured or the transcript was empty" — naming two causes and
    // computing neither, one of which cannot even reach that line
    // (archive#3148). A test pinning the ambiguity is a test holding it in
    // place.
    const runtime = ctx({ appConfig: {} });
    const result = await generateSessionSummary({
      ctx: runtime,
      messages: [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      ] as any,
    });

    expect(isSessionSummaryFailure(result)).toBe(true);
    expect((result as { kind: string }).kind).toBe('no-structure-model');
    // Actionable, not just accurate: it has to say where to set one.
    expect((result as { message: string }).message).toContain('Settings');
    expect(runtime.framework.createTempAgent).not.toHaveBeenCalled();
  });

  test('distinguishes a transcript with nothing summarizable', async () => {
    // The other cause the old message named. It is a genuinely different
    // state from an unconfigured model and now says so — and note the route
    // 409s on a message-LESS conversation before ever calling this, so the
    // old wording described a case that could not occur here.
    const runtime = ctx({ appConfig: { structureModel: 'model-a' } });
    const result = await generateSessionSummary({
      ctx: runtime,
      messages: [] as any,
    });

    expect(isSessionSummaryFailure(result)).toBe(true);
    expect((result as { kind: string }).kind).toBe('nothing-to-summarize');
    expect(runtime.framework.createTempAgent).not.toHaveBeenCalled();
  });

  test('a provider failure returns a cause-carrying failure and warns (#3026)', async () => {
    // Previously the catch logged at debug — invisible at default level — and
    // returned bare null, so the route 500ed with a cause-free message. This
    // path had NO test at all; the only failure coverage was the
    // unconfigured-model null.
    const runtime = ctx({
      framework: {
        createModel: vi.fn().mockResolvedValue({}),
        createTempAgent: vi
          .fn()
          .mockRejectedValue(
            new Error('no usable provider for structure-model'),
          ),
      },
    });
    const result = await generateSessionSummary({
      ctx: runtime,
      messages: [
        { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      ] as any,
    });
    expect(result).toMatchObject({
      failed: true,
      kind: 'error',
      message: expect.stringContaining('no usable provider'),
    });
    expect(runtime.logger.warn).toHaveBeenCalledWith(
      'Session summary generation failed',
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });

  test('keeps a single oversized final turn bounded without counting it as complete', () => {
    const rendered = renderSessionSummaryTranscript([
      {
        id: 'm1',
        role: 'user',
        parts: [{ type: 'text', text: 'x'.repeat(20_000) }],
      },
    ] as any);
    expect(rendered.transcript.length).toBeLessThanOrEqual(
      SESSION_SUMMARY_TRANSCRIPT_MAX_CHARS,
    );
    expect(rendered.transcript.startsWith('User: ')).toBe(true);
    expect(rendered.included).toEqual([expect.objectContaining({ id: 'm1' })]);
    expect(rendered.partialMessage).toBeUndefined();
  });

  test('redacts secrets, excludes tool parts, and revisions include consumed context boundaries', () => {
    const messages = [
      {
        id: 'm1',
        role: 'user',
        parts: [
          { type: 'text', text: 'token=super-secret-value-1234' },
          { type: 'tool-call', text: 'do not include tool payload' },
        ],
        metadata: {
          provenance: {
            contextBoundary: { state: 'observed', value: { boundaryId: 'b1' } },
          },
        },
      },
    ] as any;
    expect(renderSessionSummaryTranscript(messages).transcript).toContain(
      '[REDACTED]',
    );
    expect(renderSessionSummaryTranscript(messages).transcript).not.toContain(
      'tool payload',
    );
    const changedBoundary = [
      {
        ...messages[0],
        metadata: {
          provenance: {
            contextBoundary: { state: 'observed', value: { boundaryId: 'b2' } },
          },
        },
      },
    ];
    expect(conversationIntentRevision(messages)).not.toBe(
      conversationIntentRevision(changedBoundary as any),
    );
  });
});
