import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  feedbackOps: { add: vi.fn() },
}));

const { createFeedbackRoutes } = await import('../feedback.js');
const { FeedbackService } = await import(
  '../../../services/feedback/feedback-service.js'
);

describe('Feedback Routes', () => {
  let dir: string;
  let svc: InstanceType<typeof FeedbackService>;
  let app: ReturnType<typeof createFeedbackRoutes>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'feedback-routes-test-'));
    svc = new FeedbackService(dir);
    app = createFeedbackRoutes(svc);
  });

  afterEach(() => {
    svc.stop();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  test('GET /ratings returns empty initially', async () => {
    const body = await json(await app.request('/ratings'));
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
  });

  test('POST /test analyzes an isolated sample without changing saved feedback', async () => {
    svc.rateMessage({
      agentSlug: 'a',
      conversationId: 'saved',
      messageIndex: 0,
      messagePreview: 'real feedback',
      rating: 'thumbs_up',
    });
    svc.setAnalyzeCallback(async (prompt) =>
      prompt.includes('JSON array')
        ? '[{"index":1,"analysis":"real analysis"}]'
        : '{"reinforce":["saved preference"],"avoid":[]}',
    );
    await svc.runAnalysisPipeline();
    const file = join(dir, 'feedback', 'feedback.json');
    const before = readFileSync(file, 'utf8');
    const summary = svc.getSummary();
    svc.setAnalyzeCallback(async (prompt) =>
      prompt.includes('JSON array')
        ? '[{"index":1,"analysis":"sample analysis"}]'
        : '{"reinforce":["diagnostic only"],"avoid":[]}',
    );
    const res = await app.request('/test', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(svc.getSummary()).toEqual(summary);
    expect(readFileSync(file, 'utf8')).toBe(before);
    const body = await json(res);
    expect(body.data).toMatchObject({
      isolated: true,
      analysisRan: true,
      guidelinesGenerated: true,
      totalRatings: 1,
    });
  });

  test('POST /test without an analyzer does not create a feedback file', async () => {
    const file = join(dir, 'feedback', 'feedback.json');
    expect(existsSync(file)).toBe(false);
    const res = await app.request('/test', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(existsSync(file)).toBe(false);
    expect((await json(res)).data).toMatchObject({
      isolated: true,
      agentAvailable: false,
      analysisRan: false,
    });
  });

  test('POST /test failure does not leave a synthetic rating behind', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    svc.setAnalyzeCallback(async () => {
      throw new Error('model unavailable');
    });
    const res = await app.request('/test', { method: 'POST' });
    expect(res.status).toBe(500);
    expect(svc.getRatings()).toEqual([]);
  });

  test.each([
    '{',
    '[]',
    '{"maxReinforce":"bad"}',
    '{"maxAvoid":1.5}',
    '{"maxAvoid":51}',
  ])(
    'POST /analyze rejects invalid options %s before invoking the model',
    async (body) => {
      const analyze = vi.fn(async () => '[]');
      svc.setAnalyzeCallback(analyze);
      const response = await app.request('/analyze', { method: 'POST', body });
      expect(response.status).toBe(400);
      expect(analyze).not.toHaveBeenCalled();
    },
  );

  test('POST /analyze reports a missing callback instead of claiming success', async () => {
    const response = await app.request('/analyze', { method: 'POST' });
    expect(response.status).toBe(503);
  });

  test('POST /analyze bounds its optional request body', async () => {
    const response = await app.request('/analyze', {
      method: 'POST',
      body: ' '.repeat(4097),
    });
    expect(response.status).toBe(413);
  });

  test('POST /analyze still accepts an omitted body for a configured analyzer', async () => {
    svc.setAnalyzeCallback(async () => '[]');
    const response = await app.request('/analyze', { method: 'POST' });
    expect(response.status).toBe(200);
    expect((await json(response)).data).toBeNull();
  });

  test('POST /rate creates a rating', async () => {
    const res = await app.request('/rate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'c1',
        messageIndex: 0,
        messagePreview: 'test',
        rating: 'thumbs_up',
      }),
    });
    const body = await json(res);
    expect(body.success).toBe(true);
    expect(body.data.rating).toBe('thumbs_up');
  });

  test('DELETE /rate removes a rating', async () => {
    svc.rateMessage({
      agentSlug: 'a',
      conversationId: 'c1',
      messageIndex: 0,
      messagePreview: 'x',
      rating: 'thumbs_up',
    });
    const res = await app.request('/rate', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: 'c1', messageIndex: 0 }),
    });
    const body = await json(res);
    expect(body.success).toBe(true);
    expect(body.removed).toBe(true);
  });

  test('GET /guidelines returns empty with no analysis', async () => {
    const body = await json(await app.request('/guidelines'));
    expect(body.success).toBe(true);
    expect(body.data.guidelines).toBe('');
  });

  test('GET /status returns pipeline status', async () => {
    const body = await json(await app.request('/status'));
    expect(body.success).toBe(true);
    expect(body.data.totalRatings).toBe(0);
  });

  test('POST /clear-analysis resets analysis', async () => {
    const body = await json(
      await app.request('/clear-analysis', { method: 'POST' }),
    );
    expect(body.success).toBe(true);
  });
});
