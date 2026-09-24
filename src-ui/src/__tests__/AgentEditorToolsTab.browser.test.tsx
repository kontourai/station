/**
 * @vitest-environment jsdom
 *
 * #90 D14: the agent editor's per-agent switch for the built-in browser
 * tools. On by default; switching it off is what a save turns into
 * `tools.browser: false`.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test } from 'vitest';
import { AgentEditorToolsTab } from '../views/agent-editor/AgentEditorToolsTab';
import { createEmptyAgentForm } from '../views/agent-editor/agentsViewUtils';
import type { AgentFormData } from '../views/agent-editor/types';

function Harness({
  initial,
  onForm,
  locked = false,
}: {
  initial: AgentFormData;
  onForm: (form: AgentFormData) => void;
  locked?: boolean;
}) {
  const [form, setForm] = useState(initial);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  onForm(form);
  return (
    <AgentEditorToolsTab
      form={form}
      setForm={setForm}
      locked={locked}
      availableTools={[]}
      integrationTools={{}}
      expandedIntegrations={expanded}
      setExpandedIntegrations={setExpanded}
      onNavigate={() => {}}
      onOpenAddModal={() => {}}
    />
  );
}

describe('agent editor browser tools switch (D14)', () => {
  test('is on for a new agent and switches the form off and back on', () => {
    let latest: AgentFormData | undefined;
    render(
      <Harness
        initial={createEmptyAgentForm('')}
        onForm={(form) => {
          latest = form;
        }}
      />,
    );
    const toggle = screen.getByRole('switch', { name: 'Browser tools' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(
      document.getElementById(toggle.getAttribute('aria-describedby') ?? '')
        ?.textContent,
    ).toMatch(/Claude agents/);
    fireEvent.click(toggle);
    expect(latest?.tools.browser).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(latest?.tools.browser).toBe(true);
  });

  test('a locked agent cannot be switched', () => {
    render(
      <Harness initial={createEmptyAgentForm('')} onForm={() => {}} locked />,
    );
    expect(
      (
        screen.getByRole('switch', {
          name: 'Browser tools',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
