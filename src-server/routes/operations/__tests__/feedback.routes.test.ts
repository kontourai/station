import { mkdtempSync, rmSync } from 'node:fs';
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
    rmSync(dir, { recursive: true, force: true });
  });

  test('GET /ratings returns empty initially', async () => {
    const body = await json(await app.request('/ratings'));
    expect(body.success).toBe(true);
    expect(body.data).toEqual([]);
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
