import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

const temp = trackTempDirs();

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
    dir = temp('feedback-routes-test-');
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

  test('POST /clear-analysis clears the saved analysis', async () => {
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
    // Reset semantics belong to feedback-service.test.ts; this proves the
    // route reaches them, so the seeded analysis must be present first.
    expect(svc.getSummary()).not.toBeNull();

    const body = await json(
      await app.request('/clear-analysis', { method: 'POST' }),
    );
    expect(body.success).toBe(true);
    expect(svc.getSummary()).toBeNull();
    expect(svc.getRatings()[0]?.analysis).toBeUndefined();
  });
});

test('rating target is stamped only by current canonical proof and is cleared by an unverified edit', async () => {
  const root = temp('feedback-target-');
  const service = new FeedbackService(root);
  const { createFeedbackRatingTarget } = await import(
    '../../../services/feedback/feedback-target.js'
  );
  const target = createFeedbackRatingTarget('conversation', {
    role: 'assistant',
    parts: [{ type: 'text', text: 'Canonical response' }],
    metadata: { sessionId: 'session', turnId: 'turn' },
  });
  if (!target) throw new Error('Target fixture missing');
  const resolve = vi.fn(async () => ({ target, assertCurrent() {} }));
  const app = createFeedbackRoutes(service, resolve, () => true);
  const input = {
    agentSlug: 'agent',
    conversationId: 'conversation',
    messageIndex: 0,
    messagePreview: 'Canonical response',
    rating: 'thumbs_up',
    expectedSessionId: 'session',
    expectedTurnId: 'turn',
  };
  try {
    const response = await app.request('/rate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty('data.target', target);
    expect(service.getRatings()[0]?.target).toEqual(target);
    const forged = await app.request('/rate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, target }),
    });
    expect(forged.status).toBe(400);
    const legacy = await createFeedbackRoutes(service).request('/rate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentSlug: input.agentSlug,
        conversationId: input.conversationId,
        messageIndex: input.messageIndex,
        messagePreview: input.messagePreview,
        rating: input.rating,
        reason: 'Edited without target proof',
      }),
    });
    expect(legacy.status).toBe(200);
    expect(service.getRatings()[0]?.target).toBeUndefined();
  } finally {
    service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('canonical feedback target excludes projection position and changes with content or execution', async () => {
  const { createFeedbackRatingTarget } = await import(
    '../../../services/feedback/feedback-target.js'
  );
  const message = {
    id: 'position-one',
    role: 'assistant' as const,
    parts: [{ type: 'text', text: 'Response' }],
    metadata: { sessionId: 'session', turnId: 'turn' },
  };
  const target = createFeedbackRatingTarget('conversation', message);
  const reordered = { ...message, id: 'position-two' };
  expect(createFeedbackRatingTarget('conversation', reordered)).toEqual(target);
  expect(
    createFeedbackRatingTarget('conversation', {
      ...message,
      parts: [{ type: 'text', text: 'Changed' }],
    })?.contentDigest,
  ).not.toBe(target?.contentDigest);
  expect(
    createFeedbackRatingTarget('conversation', {
      ...message,
      metadata: { sessionId: 'other-session', turnId: 'turn' },
    })?.contentDigest,
  ).not.toBe(target?.contentDigest);
  expect(
    createFeedbackRatingTarget('conversation', { ...message, metadata: {} }),
  ).toBeUndefined();
});

test('target egress requires current canonical read permission without deleting retained proof', async () => {
  const root = temp('feedback-egress-');
  const service = new FeedbackService(root);
  const target = {
    conversationId: 'conversation',
    sessionId: 'protected-session',
    turnId: 'protected-turn',
    contentDigest: 'd'.repeat(64),
  };
  service.rateMessage(
    {
      agentSlug: 'a',
      conversationId: 'conversation',
      messageIndex: 0,
      messagePreview: 'Response',
      rating: 'thumbs_up',
    },
    target,
  );
  try {
    const hidden = await createFeedbackRoutes(service).request('/ratings');
    expect(JSON.stringify(await hidden.json())).not.toContain(
      'protected-session',
    );
    const visible = await createFeedbackRoutes(
      service,
      undefined,
      () => true,
    ).request('/ratings');
    expect(await visible.json()).toHaveProperty('data.0.target', target);
    expect(service.getRatings()[0]?.target).toEqual(target);
  } finally {
    service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('explicit response expectations never fall back to a positional write when target verification fails', async () => {
  const root = temp('feedback-target-refusal-');
  const service = new FeedbackService(root);
  const saved = service.rateMessage(
    {
      agentSlug: 'a',
      conversationId: 'conversation',
      messageIndex: 0,
      messagePreview: 'Existing response',
      rating: 'thumbs_up',
    },
    {
      conversationId: 'conversation',
      sessionId: 'session-a',
      turnId: 'turn-a',
      contentDigest: 'a'.repeat(64),
    },
  );
  const file = join(root, 'feedback', 'feedback.json');
  const bytes = readFileSync(file, 'utf8');
  try {
    const app = createFeedbackRoutes(service, async () => undefined);
    const response = await app.request('/rate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentSlug: 'a',
        conversationId: 'conversation',
        messageIndex: 0,
        rating: 'thumbs_down',
        expectedSessionId: 'session-b',
        expectedTurnId: 'turn-b',
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toHaveProperty(
      'code',
      'feedback_target_changed',
    );
    expect(service.getRatings()).toEqual([saved]);
    expect(readFileSync(file, 'utf8')).toBe(bytes);
  } finally {
    service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
