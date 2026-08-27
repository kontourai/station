import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  feedbackOps: { add: vi.fn() },
}));

const { FeedbackService } = await import('../feedback-service.js');

describe('FeedbackService', () => {
  let dir: string;
  let svc: InstanceType<typeof FeedbackService>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'feedback-test-'));
    svc = new FeedbackService(dir);
  });

  afterEach(() => {
    svc.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test('rateMessage creates a rating', () => {
    const r = svc.rateMessage({
      agentSlug: 'test',
      conversationId: 'c1',
      messageIndex: 0,
      messagePreview: 'Hello world',
      rating: 'thumbs_up',
    });
    expect(r.rating).toBe('thumbs_up');
    expect(svc.getRatings()).toHaveLength(1);
  });

  test('rateMessage upserts on same message', () => {
    svc.rateMessage({
      agentSlug: 'a',
      conversationId: 'c1',
      messageIndex: 0,
      messagePreview: 'x',
      rating: 'thumbs_up',
    });
    svc.rateMessage({
      agentSlug: 'a',
      conversationId: 'c1',
      messageIndex: 0,
      messagePreview: 'x',
      rating: 'thumbs_down',
    });
    const ratings = svc.getRatings();
    expect(ratings).toHaveLength(1);
    expect(ratings[0].rating).toBe('thumbs_down');
  });

  test('removeRating deletes a rating', () => {
    svc.rateMessage({
      agentSlug: 'a',
      conversationId: 'c1',
      messageIndex: 0,
      messagePreview: 'x',
      rating: 'thumbs_up',
    });
    expect(svc.removeRating('c1', 0)).toBe(true);
    expect(svc.getRatings()).toHaveLength(0);
  });

  test('removeRating returns false for missing', () => {
    expect(svc.removeRating('nope', 0)).toBe(false);
  });

  test('getSummary returns null initially', () => {
    expect(svc.getSummary()).toBeNull();
  });

  test('getBehaviorGuidelines returns empty with no summary', () => {
    expect(svc.getBehaviorGuidelines()).toBe('');
  });

  test('hasAnalyzeCallback false by default', () => {
    expect(svc.hasAnalyzeCallback()).toBe(false);
  });

  test('getStatus reflects state', () => {
    const status = svc.getStatus();
    expect(status.totalRatings).toBe(0);
    expect(status.isAnalyzing).toBe(false);
    expect(status.analyzeCallbackAvailable).toBe(false);
  });

  test('clearAnalysis resets analysis data', () => {
    svc.rateMessage({
      agentSlug: 'a',
      conversationId: 'c1',
      messageIndex: 0,
      messagePreview: 'x',
      rating: 'thumbs_up',
    });
    svc.clearAnalysis();
    const ratings = svc.getRatings();
    expect(ratings[0].analysis).toBeUndefined();
    expect(svc.getSummary()).toBeNull();
  });

  // #2900: analysis reads the store, awaits an LLM round-trip, then writes.
  // Writing the pre-await snapshot back silently discarded any rating
  // submitted during that window.
  test('keeps a rating submitted while analysis is awaiting the model', async () => {
    svc.rateMessage({
      agentSlug: 'a',
      conversationId: 'before',
      messageIndex: 0,
      messagePreview: 'rated before analysis started',
      rating: 'thumbs_up',
    });

    let analyzeCalls = 0;
    let releaseModel: () => void = () => {};
    let modelEntered: () => void = () => {};
    const modelIsRunning = new Promise<void>((resolve) => {
      modelEntered = resolve;
    });

    svc.setAnalyzeCallback(async (prompt: string) => {
      analyzeCalls += 1;
      if (analyzeCalls === 1) {
        modelEntered();
        await new Promise<void>((resolve) => {
          releaseModel = resolve;
        });
      }
      // Mini analysis wants a JSON array; the full pass wants the object form.
      // Returning the wrong shape makes the analysis throw and skip its write,
      // which would make this test pass without exercising the bug at all.
      return prompt.includes('JSON array')
        ? '[{"index":1,"analysis":"clear and concise"}]'
        : '{"reinforce":["be concise"],"avoid":["be vague"]}';
    });

    const analysis = svc.runAnalysisPipeline();
    await modelIsRunning;

    svc.rateMessage({
      agentSlug: 'a',
      conversationId: 'during',
      messageIndex: 0,
      messagePreview: 'rated while the model was thinking',
      rating: 'thumbs_down',
    });

    releaseModel();
    await analysis;

    // The write must actually have happened, or this test proves nothing:
    // a thrown analysis also leaves the concurrent rating intact.
    expect(analyzeCalls).toBeGreaterThan(0);
    expect(svc.getSummary()).not.toBeNull();
    expect(
      svc.getRatings().find((r) => r.conversationId === 'before')?.analyzedAt,
    ).toBeTruthy();

    expect(
      svc
        .getRatings()
        .map((r) => r.conversationId)
        .sort(),
    ).toEqual(['before', 'during']);
  });

  // A re-rate during the window reuses the id and clears analyzedAt; the fold
  // must not attach the previous message's analysis to the new rating.
  test('does not attach a stale analysis to a message re-rated during analysis', async () => {
    svc.rateMessage({
      agentSlug: 'a',
      conversationId: 'c1',
      messageIndex: 0,
      messagePreview: 'original text',
      rating: 'thumbs_up',
    });

    let releaseModel: () => void = () => {};
    let modelEntered: () => void = () => {};
    const modelIsRunning = new Promise<void>((resolve) => {
      modelEntered = resolve;
    });
    let calls = 0;
    svc.setAnalyzeCallback(async (prompt: string) => {
      calls += 1;
      if (calls === 1) {
        modelEntered();
        await new Promise<void>((resolve) => {
          releaseModel = resolve;
        });
      }
      return prompt.includes('JSON array')
        ? '[{"index":1,"analysis":"about the ORIGINAL text"}]'
        : '{"reinforce":[],"avoid":[]}';
    });

    const analysis = svc.runAnalysisPipeline();
    await modelIsRunning;

    svc.rateMessage({
      agentSlug: 'a',
      conversationId: 'c1',
      messageIndex: 0,
      messagePreview: 'edited text, rated again',
      rating: 'thumbs_down',
    });

    releaseModel();
    await analysis;

    const entry = svc.getRatings().find((r) => r.conversationId === 'c1');
    expect(entry?.rating).toBe('thumbs_down');
    expect(entry?.messagePreview).toBe('edited text, rated again');
    expect(entry?.analysis).toBeUndefined();
    expect(entry?.analyzedAt).toBeUndefined();
  });
});
