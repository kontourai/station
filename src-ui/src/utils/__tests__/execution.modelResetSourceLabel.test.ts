import { describe, expect, test } from 'vitest';
import { modelResetSourceLabel } from '../execution';

describe('modelResetSourceLabel', () => {
  test('names the default by its source', () => {
    expect(modelResetSourceLabel('project default')).toBe('project default');
    expect(modelResetSourceLabel('runtime')).toBe('reported by app');
  });

  test('a source with no label never leaves a bare "Use"', () => {
    expect(modelResetSourceLabel('unknown')).toBe('default model');
    expect(modelResetSourceLabel(undefined)).toBe('default model');
    // The Station-scoped start picker keeps its own wording for no source.
    expect(modelResetSourceLabel('unknown', 'Agent defaults')).toBe(
      'Agent defaults',
    );
  });
});
