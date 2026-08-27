import { describe, expect, test } from 'vitest';
import {
  extractJson,
  runFullFeedbackAnalysis,
  runMiniFeedbackAnalysis,
} from '../feedback-analysis.js';

describe('feedback-analysis', () => {
  test('extractJson finds the first JSON payload inside prose', () => {
    expect(extractJson('note [{"ok":true}] trailing')).toBe('[{"ok":true}]');
    expect(extractJson('no json here')).toBeNull();
  });

  test('runMiniFeedbackAnalysis annotates pending ratings', async () => {
    const result = await runMiniFeedbackAnalysis(
      async () =>
        '```json\n[{"index":1,"analysis":"Helpful and concise"}]\n```',
      {
        ratings: [
          {
            id: 'r1',
            agentSlug: 'agent',
            conversationId: 'c1',
            messageIndex: 0,
            messagePreview: 'hello',
            rating: 'thumbs_up',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        summary: null,
      },
    );

    expect(result.ratings[0].analysis).toBe('Helpful and concise');
    expect(result.ratings[0].analyzedAt).toBeTruthy();
  });

  test('runFullFeedbackAnalysis builds capped reinforce and avoid summaries', async () => {
    const summary = await runFullFeedbackAnalysis({
      analyze: async () =>
        '{"reinforce":["be concise","show steps"],"avoid":["ramble"]}',
      data: {
        ratings: [
          {
            id: 'r1',
            agentSlug: 'agent',
            conversationId: 'c1',
            messageIndex: 0,
            messagePreview: 'up',
            rating: 'thumbs_up',
            analysis: 'concise',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'r2',
            agentSlug: 'agent',
            conversationId: 'c1',
            messageIndex: 1,
            messagePreview: 'down',
            rating: 'thumbs_down',
            analysis: 'too verbose',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        summary: null,
      },
      maxReinforce: 1,
      maxAvoid: 1,
    });

    expect(summary).toMatchObject({
      reinforce: ['be concise'],
      avoid: ['ramble'],
      analyzedCount: 2,
    });
    expect(summary?.updatedAt).toBeTruthy();
  });
});
