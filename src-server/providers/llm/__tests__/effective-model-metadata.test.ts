import { describe, expect, test } from 'vitest';
import {
  effectiveModelMetadata,
  reportedModelMetadata,
} from '../effective-model-metadata.js';

describe('effectiveModelMetadata', () => {
  test('keeps bounded model controls and excludes unrelated provider data', () => {
    expect(
      effectiveModelMetadata(' sonnet ', {
        effort: 'high',
        fastMode: true,
        contextWindow: 1_000_000,
        approvalMode: 'never',
        systemPrompt: 'private prompt',
        token: 'secret',
      }),
    ).toEqual({
      effectiveModel: 'sonnet',
      effectiveModelOptions: {
        effort: 'high',
        fastMode: true,
        contextWindow: 1_000_000,
      },
    });
  });

  test('omits invalid and oversized values instead of inventing defaults', () => {
    expect(
      effectiveModelMetadata('', {
        effort: 'x'.repeat(129),
        fastMode: null,
        contextWindow: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({});
  });
});

describe('reportedModelMetadata', () => {
  test('carries a bounded reported model as a distinct field', () => {
    expect(reportedModelMetadata(' claude-opus-4-5-20260101 ')).toEqual({
      reportedModel: 'claude-opus-4-5-20260101',
    });
  });

  test('is absent — not defaulted — when no reported model is given', () => {
    expect(reportedModelMetadata(undefined)).toEqual({});
    expect(reportedModelMetadata('')).toEqual({});
    expect(reportedModelMetadata('   ')).toEqual({});
  });

  test('rejects an oversized value rather than truncating it silently', () => {
    expect(reportedModelMetadata('x'.repeat(257))).toEqual({});
  });

  test('is independent of effectiveModelMetadata — a disagreement is representable', () => {
    const requested = effectiveModelMetadata('claude-fable-5', {});
    const reported = reportedModelMetadata('claude-opus-4-5-20260101');
    const merged = { ...requested, ...reported };
    expect(merged.effectiveModel).toBe('claude-fable-5');
    expect(merged.reportedModel).toBe('claude-opus-4-5-20260101');
    expect(merged.effectiveModel).not.toBe(merged.reportedModel);
  });
});
