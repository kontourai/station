/**
 * #2144 slice 3 — the two rules Settings must not re-derive when it writes a
 * project override: the record field a setting is stored under, and the model
 * pair's all-or-nothing resolution.
 */

import { describe, expect, test } from 'vitest';
import {
  buildProjectOverrideUpdate,
  effectiveOverrideValue,
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
    expect(projectOverrideDelta({ defaultWorkspaceIsolation: null }, {})).toEqual(
      {},
    );
    expect(
      projectOverrideDelta(
        { defaultWorkspaceIsolation: null },
        { defaultWorkspaceIsolation: 'worktree' },
      ),
    ).toEqual({ defaultWorkspaceIsolation: null });
  });

  test('a pending reset reads as inheriting before it is saved', () => {
    const saved = { defaultWorkspaceIsolation: 'worktree' } as const;
    expect(
      effectiveOverrideValue('defaultWorkspaceIsolation', {}, saved),
    ).toBe('worktree');
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
    expect(
      buildProjectOverrideUpdate({ defaultModel: 'gpt-5' }, {}),
    ).toEqual({ defaultModel: null, defaultProviderId: null });
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
