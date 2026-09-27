// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { ProjectKnowledgeRulesEditor } from '../ProjectKnowledgeRulesEditor';

/**
 * archive#771 regression. This editor used to gate only on
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
