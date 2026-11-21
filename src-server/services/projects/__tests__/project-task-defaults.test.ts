/**
 * #5068: a Project's Task model and effort fill in what a dispatch did not
 * choose, only on an engine they belong to.
 */
import { describe, expect, test } from 'vitest';
import { withProjectTaskDefaults } from '../task-graph-service.js';

const start = { agentId: 'coder', projectSlug: 'export' };

describe('withProjectTaskDefaults', () => {
  test('fills the model on its own engine and the effort on an engine that takes one', () => {
    expect(
      withProjectTaskDefaults(start, 'claude', {
        modelId: 'claude-sonnet-5-5',
        providerId: 'claude',
        effort: 'low',
      }),
    ).toEqual({
      ...start,
      modelId: 'claude-sonnet-5-5',
      modelOptions: { effort: 'low' },
    });
  });

  test('the dispatch’s own model and effort win', () => {
    expect(
      withProjectTaskDefaults(
        { ...start, modelId: 'gpt-5', modelOptions: { effort: 'high' } },
        'codex',
        { modelId: 'other', effort: 'low' },
      ),
    ).toBeUndefined();
  });

  test('another engine’s model never applies, and ACP never gets an effort', () => {
    expect(
      withProjectTaskDefaults(start, 'codex', {
        modelId: 'claude-sonnet-5-5',
        providerId: 'claude',
      }),
    ).toBeUndefined();
    expect(
      withProjectTaskDefaults(start, 'acp', { effort: 'high' }),
    ).toBeUndefined();
  });

  test('read per dispatch: a changed default reaches the next dispatch only', () => {
    let defaults = { modelId: 'first', effort: 'low' };
    const first = withProjectTaskDefaults(start, 'claude', defaults);
    defaults = { modelId: 'second', effort: 'high' };
    expect(first).toMatchObject({ modelId: 'first' });
    expect(withProjectTaskDefaults(start, 'claude', defaults)).toMatchObject({
      modelId: 'second',
      modelOptions: { effort: 'high' },
    });
  });
});
