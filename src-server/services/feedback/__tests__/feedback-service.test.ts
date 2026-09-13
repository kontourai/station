import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { JsonFileStore } from '../../infra/json-store.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  feedbackOps: { add: vi.fn() },
}));

const { FeedbackService } = await import('../feedback-service.js');

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const ratingInput = {
  agentSlug: 'a',
  conversationId: 'race',
  messageIndex: 0,
  messagePreview: 'unchanged response',
  rating: 'thumbs_up' as const,
  reason: 'clear explanation',
};
const modelReply = (prompt: string, value = 'useful') =>
  prompt.includes('JSON array')
    ? JSON.stringify([{ index: 1, analysis: value }])
    : JSON.stringify({ reinforce: [value], avoid: [] });

describe('FeedbackService', () => {
  let dir: string;
  let svc: InstanceType<typeof FeedbackService>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'feedback-test-'));
    svc = new FeedbackService(dir);
  });

  afterEach(() => {
    svc.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  test.each(['mini', 'full'])(
    'clearAnalysis fences a pending %s response',
    async (phase) => {
      svc.rateMessage(ratingInput);
      const entered = signal();
      const release = signal();
      svc.setAnalyzeCallback(async (prompt) => {
        if (prompt.includes('JSON array') === (phase === 'mini')) {
          entered.resolve();
          await release.promise;
        }
        return modelReply(prompt, 'obsolete');
      });
      const pending = svc.runAnalysisPipeline();
      await entered.promise;
      svc.clearAnalysis();
      release.resolve();
      await pending;
      expect(svc.getSummary()).toBeNull();
      expect(svc.getRatings()[0]?.analysis).toBeUndefined();
      expect(svc.getRatings()[0]?.analyzedAt).toBeUndefined();
    },
  );

  test('stop prevents late publication and a subsequent full model call', async () => {
    svc.rateMessage(ratingInput);
    const entered = signal();
    const release = signal();
    const analyze = vi.fn(async (prompt: string) => {
      entered.resolve();
      await release.promise;
      return modelReply(prompt);
    });
    svc.setAnalyzeCallback(analyze);
    const pending = svc.runAnalysisPipeline();
    await entered.promise;
    svc.stop();
    release.resolve();
    await pending;
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(svc.getRatings()[0]?.analysis).toBeUndefined();
    expect(svc.getSummary()).toBeNull();
  });

  test('a reason-only re-rating cannot inherit analysis of the previous reason', async () => {
    svc.rateMessage(ratingInput);
    const entered = signal();
    const release = signal();
    svc.setAnalyzeCallback(async (prompt) => {
      entered.resolve();
      await release.promise;
      return modelReply(prompt, 'about the previous reason');
    });
    const pending = svc.runAnalysisPipeline();
    await entered.promise;
    svc.rateMessage({ ...ratingInput, reason: 'too terse' });
    release.resolve();
    await pending;
    expect(svc.getRatings()[0]?.reason).toBe('too terse');
    expect(svc.getRatings()[0]?.analysis).toBeUndefined();
    expect(svc.getSummary()).toBeNull();
  });

  test('joins concurrent analysis requests instead of making duplicate model calls', async () => {
    svc.rateMessage(ratingInput);
    const entered = signal();
    const release = signal();
    const analyze = vi.fn(async (prompt: string) => {
      entered.resolve();
      await release.promise;
      return modelReply(prompt);
    });
    svc.setAnalyzeCallback(analyze);
    const first = svc.runAnalysisPipeline();
    await entered.promise;
    const second = svc.runAnalysisPipeline();
    const blockedCalls = analyze.mock.calls.length;
    release.resolve();
    const results = await Promise.all([first, second]);
    expect(blockedCalls).toBe(1);
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(results[0]).toEqual(results[1]);
  });

  test('recomputes changed summary inputs even when the analyzed count is unchanged', async () => {
    svc.rateMessage(ratingInput);
    svc.setAnalyzeCallback(async (prompt) =>
      modelReply(prompt, 'old preference'),
    );
    await svc.runAnalysisPipeline();
    const file = join(dir, 'feedback', 'feedback.json');
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    stored.ratings[0].analysis = 'different restored evidence';
    writeFileSync(file, JSON.stringify(stored));
    svc.stop();
    svc = new FeedbackService(dir);
    const analyze = vi.fn(
      async () => '{"reinforce":["new preference"],"avoid":[]}',
    );
    svc.setAnalyzeCallback(analyze);
    await svc.runAnalysisPipeline();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(svc.getSummary()?.reinforce).toEqual(['new preference']);
  });

  test('rejects malformed model summaries without persisting a broken profile', async () => {
    svc.rateMessage(ratingInput);
    svc.setAnalyzeCallback(async (prompt) =>
      prompt.includes('JSON array')
        ? modelReply(prompt)
        : '{"reinforce":"not an array","avoid":[]}',
    );
    await expect(svc.runAnalysisPipeline()).rejects.toThrow();
    expect(svc.getSummary()).toBeNull();
    expect(svc.getBehaviorGuidelines()).toBe('');
  });

  test('rejects malformed rating analyses without marking the rating analyzed', async () => {
    svc.rateMessage(ratingInput);
    svc.setAnalyzeCallback(
      async () => '[{"index":1,"analysis":{"invalid":true}}]',
    );
    await expect(svc.runAnalysisPipeline()).rejects.toThrow();
    expect(svc.getRatings()[0]?.analysis).toBeUndefined();
    expect(svc.getStatus().pendingAnalysis).toBe(1);
  });

  test('repeated start owns only one timer pair and stop clears both', () => {
    vi.useFakeTimers();
    svc.start();
    svc.start();
    svc.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('status reports the scheduled tick and clears it when stopped', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    svc.start();
    expect(svc.getStatus().nextAnalysisAt).toBe(startedAt + 5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(svc.getStatus().nextAnalysisAt).toBe(startedAt + 10 * 60 * 1000);
    svc.clearAnalysis();
    expect(svc.getStatus().nextAnalysisAt).toBe(startedAt + 10 * 60 * 1000);
    svc.stop();
    expect(svc.getStatus().nextAnalysisAt).toBeNull();
  });

  test('reuses an unchanged summary without a model call or store rewrite', async () => {
    svc.rateMessage(ratingInput);
    const analyze = vi.fn(async (prompt: string) => modelReply(prompt));
    svc.setAnalyzeCallback(analyze);
    await svc.runAnalysisPipeline();
    const write = vi.spyOn(JsonFileStore.prototype, 'write');
    analyze.mockClear();
    await svc.runAnalysisPipeline();
    expect(analyze).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    expect(svc.getSummary()?.reinforce).toEqual(['useful']);
  });

  test('a current request runs after a superseded model failure settles', async () => {
    svc.rateMessage(ratingInput);
    const entered = signal();
    const release = signal();
    const oldAnalyze = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      throw new Error('old model failed');
    });
    svc.setAnalyzeCallback(oldAnalyze);
    const old = svc.runAnalysisPipeline();
    await entered.promise;
    svc.clearAnalysis();
    const currentAnalyze = vi.fn(async (prompt: string) =>
      modelReply(prompt, 'current'),
    );
    svc.setAnalyzeCallback(currentAnalyze);
    const current = svc.runAnalysisPipeline();
    expect(currentAnalyze).not.toHaveBeenCalled();
    release.resolve();
    await expect(old).resolves.toBeNull();
    await expect(current).resolves.toMatchObject({ reinforce: ['current'] });
    expect(currentAnalyze).toHaveBeenCalledTimes(2);
    expect(svc.getStatus().isAnalyzing).toBe(false);
  });

  test('does not start queued model work after stop', async () => {
    svc.rateMessage(ratingInput);
    const analyze = vi.fn(async (prompt: string) => modelReply(prompt));
    svc.setAnalyzeCallback(analyze);
    const pending = svc.runAnalysisPipeline();
    svc.stop();
    await expect(pending).resolves.toBeNull();
    expect(analyze).not.toHaveBeenCalled();
  });

  test('hides malformed stored derivatives while keeping their rating pending', () => {
    svc.rateMessage(ratingInput);
    const file = join(dir, 'feedback', 'feedback.json');
    const data = JSON.parse(readFileSync(file, 'utf8'));
    data.ratings[0].analysis = { invalid: true };
    data.ratings[0].analyzedAt = new Date().toISOString();
    data.summary = {
      reinforce: 'broken',
      avoid: [],
      analyzedCount: 1,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(file, JSON.stringify(data));
    svc.stop();
    svc = new FeedbackService(dir);
    expect(svc.getSummary()).toBeNull();
    expect(svc.getBehaviorGuidelines()).toBe('');
    expect(svc.getRatings()[0]?.analysis).toBeUndefined();
    expect(svc.getStatus().pendingAnalysis).toBe(1);
  });

  // archive#2900: analysis reads the store, awaits an LLM round-trip, then writes.
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
