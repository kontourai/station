/**
 * #2144 slice 3 — the two rules Settings must not re-derive when it writes a
 * project override: the record field a setting is stored under, and the model
 * pair's all-or-nothing resolution.
 */

import { describe, expect, test } from 'vitest';
import {
  buildProjectOverrideUpdate,
  effectiveOverrideValue,
  pendingOverrideChanges,
  projectOverrideDelta,
} from '../views/settings/project-override-draft';

describe('project override delta', () => {
  test('only entries that differ from what the project stores are a change', () => {
    const saved = { defaultWorkspaceIsolation: 'worktree' } as const;
    expect(
      projectOverrideDelta({ defaultWorkspaceIsolation: 'worktree' }, saved),
    ).toEqual({});
    expect(
      projectOverrideDelta({ defaultWorkspaceIsolation: 'shared' }, saved),
    ).toEqual({ defaultWorkspaceIsolation: 'shared' });
  });

  test('a reset of a key the project never overrode is not a change', () => {
    // Both spellings of "no stored override" compare equal, so Save is not
    // armed over a request that would write nothing.
    expect(
      projectOverrideDelta({ defaultWorkspaceIsolation: null }, {}),
    ).toEqual({});
    expect(
      projectOverrideDelta(
        { defaultWorkspaceIsolation: null },
        { defaultWorkspaceIsolation: 'worktree' },
      ),
    ).toEqual({ defaultWorkspaceIsolation: null });
  });

  test('a pending reset reads as inheriting before it is saved', () => {
    const saved = { defaultWorkspaceIsolation: 'worktree' } as const;
    expect(effectiveOverrideValue('defaultWorkspaceIsolation', {}, saved)).toBe(
      'worktree',
    );
    expect(
      effectiveOverrideValue(
        'defaultWorkspaceIsolation',
        { defaultWorkspaceIsolation: null },
        saved,
      ),
    ).toBeUndefined();
  });
});

describe('project override update body', () => {
  test('a setting is written under the record field that stores it', () => {
    // The one that differs: the Station setting is `defaultLLMProvider` and
    // the project record spells it `defaultProviderId`.
    expect(
      buildProjectOverrideUpdate(
        { defaultLLMProvider: 'openai-main', defaultModel: 'gpt-5' },
        {},
      ),
    ).toEqual({ defaultProviderId: 'openai-main', defaultModel: 'gpt-5' });
  });

  test('reset sends null, never an omission or an empty string', () => {
    const update = buildProjectOverrideUpdate(
      { defaultWorkspaceIsolation: null },
      { defaultWorkspaceIsolation: 'worktree' },
    );
    expect(update).toEqual({ defaultWorkspaceIsolation: null });
    // `JSON.stringify` drops `undefined`, so an omitted field would leave the
    // stored value in place and make the reset do nothing.
    expect(Object.hasOwn(update, 'defaultWorkspaceIsolation')).toBe(true);
    expect(JSON.parse(JSON.stringify(update))).toEqual({
      defaultWorkspaceIsolation: null,
    });
  });

  test('resetting one half of the model pair drops the other with it', () => {
    expect(
      buildProjectOverrideUpdate(
        { defaultModel: null },
        { defaultModel: 'gpt-5', defaultLLMProvider: 'openai-main' },
      ),
    ).toEqual({ defaultModel: null, defaultProviderId: null });
  });

  test('a half-pair is written away rather than stored as an override nothing reads', () => {
    // `readProjectOverrides` accepts the pair only whole, so leaving the
    // provider behind would store a value no resolver ever reaches.
    expect(buildProjectOverrideUpdate({ defaultModel: 'gpt-5' }, {})).toEqual({
      defaultModel: null,
      defaultProviderId: null,
    });
  });

  test('a key the page never touched is left out of the body entirely', () => {
    expect(
      buildProjectOverrideUpdate(
        { defaultWorkspaceIsolation: 'shared' },
        { defaultModel: 'gpt-5', defaultLLMProvider: 'openai-main' },
      ),
    ).toEqual({ defaultWorkspaceIsolation: 'shared' });
  });
});

/**
 * What the rows are told is unsaved.
 *
 * Asserted here rather than through a rendered row because neither half of
 * the model pair HAS a Settings row in this slice (`defaultModel` is a
 * bespoke Defaults field and `defaultLLMProvider` has no control at all), so
 * this map is the only place the pair's widening is observable.
 */
describe('pending override changes', () => {
  const PAIR = {
    defaultModel: 'gpt-5',
    defaultLLMProvider: 'openai-main',
  } as const;

  test('resetting one half of the model pair marks the other pending too', () => {
    // The save drops both (`readProjectOverrides` accepts the pair only
    // whole), so leaving the second row claiming a live, in-effect project
    // override — with a Reset button — describes a state the next write ends.
    expect(pendingOverrideChanges({ defaultModel: null }, PAIR)).toEqual({
      defaultModel: 'reset',
      defaultLLMProvider: 'reset',
    });
  });

  test('a blank draft value is the reset it will be written as', () => {
    expect(
      pendingOverrideChanges(
        { defaultWorkspaceIsolation: '  ' },
        { defaultWorkspaceIsolation: 'worktree' },
      ),
    ).toEqual({ defaultWorkspaceIsolation: 'reset' });
  });

  test('a new value is an edit, and an unchanged one is not pending at all', () => {
    expect(
      pendingOverrideChanges(
        { defaultWorkspaceIsolation: 'shared' },
        { defaultWorkspaceIsolation: 'worktree' },
      ),
    ).toEqual({ defaultWorkspaceIsolation: 'edit' });
    expect(
      pendingOverrideChanges(
        { defaultWorkspaceIsolation: 'worktree' },
        { defaultWorkspaceIsolation: 'worktree' },
      ),
    ).toEqual({});
  });
});
