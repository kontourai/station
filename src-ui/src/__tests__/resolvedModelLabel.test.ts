import { describe, expect, test } from 'vitest';
import {
  resolvedModelLabel,
  type SelectableModel,
} from '../utils/modelCapabilities';

const models: SelectableModel[] = [
  {
    id: 'default',
    name: 'Default (recommended)',
    resolvedModel: 'claude-opus-5[1m]',
  },
  {
    id: 'opus[1m]',
    name: 'Opus (1M context)',
    originalId: 'opus[1m]',
    resolvedModel: 'claude-opus-5[1m]',
  },
  {
    id: 'claude-opus-5[1m]',
    name: 'Opus 5 (1M context)',
    originalId: 'claude-opus-5[1m]',
  },
  { id: 'claude-fable-5', name: 'Fable', originalId: 'claude-fable-5' },
];

describe('resolvedModelLabel (#1012)', () => {
  test('prefers the concrete catalog entry name for the resolved id', () => {
    expect(resolvedModelLabel(models[0], models)).toBe('Opus 5 (1M context)');
  });

  test('never resolves through another alias entry', () => {
    // The concrete entry, not the 'opus[1m]' alias that shares the same
    // resolution target.
    const withoutConcrete = models.filter(
      (model) => model.id !== 'claude-opus-5[1m]',
    );
    expect(resolvedModelLabel(models[0], withoutConcrete)).toBe('Opus 5 (1M)');
  });

  test('refuses a chained alias whose id matches the resolution target', () => {
    // Entry A resolves to 'opus-alias'; entry B's OWN id is 'opus-alias' but
    // B is itself an alias (carries resolvedModel). The guard must skip B and
    // fall back to prettifying rather than presenting an alias as concrete.
    const chained: SelectableModel[] = [
      { id: 'default', name: 'Default', resolvedModel: 'opus-alias' },
      {
        id: 'opus-alias',
        name: 'Opus (alias)',
        originalId: 'opus-alias',
        resolvedModel: 'claude-opus-5',
      },
    ];
    expect(resolvedModelLabel(chained[0], chained)).toBe('Opus Alias');
  });

  test('prettifies a raw id when no catalog entry matches', () => {
    const entry: SelectableModel = {
      id: 'default',
      name: 'Default',
      resolvedModel: 'claude-sonnet-5',
    };
    expect(resolvedModelLabel(entry, [entry])).toBe('Sonnet 5');
  });

  test('returns undefined for concrete entries and missing input', () => {
    expect(resolvedModelLabel(models[3], models)).toBeUndefined();
    expect(resolvedModelLabel(undefined, models)).toBeUndefined();
  });
});
