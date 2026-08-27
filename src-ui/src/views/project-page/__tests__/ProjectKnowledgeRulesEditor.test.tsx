// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ProjectKnowledgeRulesEditor } from '../ProjectKnowledgeRulesEditor';

/**
 * station#771 regression. This editor used to gate only on
 * `!rulesLoaded && rulesLoading` — a settled query error left both false, so
 * it fell straight through to an EMPTY, EDITABLE textarea with no message at
 * all, silently indistinguishable from a project that genuinely has no rules
 * saved yet.
 */
describe('ProjectKnowledgeRulesEditor (#771)', () => {
  test('renders a skeleton while loading', () => {
    const { container } = render(
      <ProjectKnowledgeRulesEditor
        rulesLoaded={false}
        rulesLoading
        rulesContent=""
        savingRules={false}
        onRulesChange={vi.fn()}
        onSaveRules={vi.fn()}
      />,
    );
    expect(container.querySelector('.skeleton-block')).toBeTruthy();
    expect(container.querySelector('textarea')).toBeNull();
  });

  // station#771 fix round (review LOW): the first pass only threaded a
  // boolean, so every failure rendered the same generic title with no
  // specific text — unlike the other 12 fixed sites, all of which run their
  // error through `describeReadFailure`. Assert the actual message surfaces.
  test('renders an error state with retry and the specific failure text instead of an empty editable textarea', () => {
    const onRetryRules = vi.fn();
    render(
      <ProjectKnowledgeRulesEditor
        rulesLoaded={false}
        rulesLoading={false}
        rulesError
        rulesFailure={new Error('project rules unavailable')}
        onRetryRules={onRetryRules}
        rulesContent=""
        savingRules={false}
        onRulesChange={vi.fn()}
        onSaveRules={vi.fn()}
      />,
    );

    expect(screen.getByText("Couldn't load project rules")).toBeTruthy();
    expect(screen.getByText('project rules unavailable')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetryRules).toHaveBeenCalledTimes(1);
  });

  test('falls back to the generic message when the error carries no specific text', () => {
    render(
      <ProjectKnowledgeRulesEditor
        rulesLoaded={false}
        rulesLoading={false}
        rulesError
        rulesContent=""
        savingRules={false}
        onRulesChange={vi.fn()}
        onSaveRules={vi.fn()}
      />,
    );

    expect(screen.getByText("Couldn't load project rules")).toBeTruthy();
    expect(screen.getByText('Try again in a moment.')).toBeTruthy();
  });

  test('renders the editor once rules have loaded successfully', () => {
    render(
      <ProjectKnowledgeRulesEditor
        rulesLoaded
        rulesLoading={false}
        rulesContent="Always respond in bullet points"
        savingRules={false}
        onRulesChange={vi.fn()}
        onSaveRules={vi.fn()}
      />,
    );

    expect(
      screen.getByDisplayValue('Always respond in bullet points'),
    ).toBeTruthy();
  });
});
