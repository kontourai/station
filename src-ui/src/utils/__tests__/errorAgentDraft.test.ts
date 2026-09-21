import { describe, expect, test } from 'vitest';
import { errorAgentDraft } from '../errorAgentDraft';

describe('errorAgentDraft', () => {
  test('keeps structured failure facts and redacts secret-shaped context', () => {
    const error = Object.assign(new Error('Connection refused'), {
      code: 'ECONNREFUSED',
      status: 503,
      context: { authorization: 'Bearer private-token' },
    });
    const draft = errorAgentDraft({
      attempted: 'Connect model',
      error,
      context: { endpoint: 'https://model.example', apiKey: 'sk-secret' },
    });
    expect(draft).toContain('"attempted": "Connect model"');
    expect(draft).toContain('"code": "ECONNREFUSED"');
    expect(draft).toContain('"status": 503');
    expect(draft).not.toContain('private-token');
    expect(draft).not.toContain('sk-secret');
    expect(draft).toContain('[REDACTED]');
  });

  test('bounds cyclic, bigint, and oversized context without throwing', () => {
    const context: Record<string, unknown> = {
      count: 3n,
      payload: 'x'.repeat(30_000),
    };
    context.self = context;
    const draft = errorAgentDraft({
      attempted: 'Load context',
      error: new Error('failed'),
      context,
    });
    expect(draft.length).toBeLessThan(13_000);
    expect(draft).toContain('3');
    expect(draft).toContain('[OMITTED: LIMIT]');
  });
});
