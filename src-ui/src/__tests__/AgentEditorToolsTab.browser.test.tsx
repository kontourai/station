/**
 * @vitest-environment jsdom
 *
 * #90 D14: the agent editor's per-agent switch for the built-in browser
 * tools. On by default; switching it off is what a save turns into
 * `tools.browser: false`.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, test } from 'vitest';
import type { Tool } from '../types';
import { AgentEditorToolsTab } from '../views/agent-editor/AgentEditorToolsTab';
import { createEmptyAgentForm } from '../views/agent-editor/agentsViewUtils';
import type { AgentFormData } from '../views/agent-editor/types';

function Harness({
  initial,
  onForm,
  locked = false,
  availableTools = [],
  engineId = 'claude',
}: {
  initial: AgentFormData;
  onForm: (form: AgentFormData) => void;
  locked?: boolean;
  availableTools?: Tool[];
  engineId?: string;
}) {
  const [form, setForm] = useState(initial);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      }),
  );
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  onForm(form);
  return (
    // The Tools tab mounts the workflows section, whose SDK hooks need an
    // observer even when the queries are disabled (an unsaved agent has no
    // slug, so nothing fetches).
    <QueryClientProvider client={queryClient}>
      <AgentEditorToolsTab
        form={form}
        setForm={setForm}
        locked={locked}
        availableTools={availableTools}
        engineId={engineId}
        integrationTools={{}}
        expandedIntegrations={expanded}
        setExpandedIntegrations={setExpanded}
        onNavigate={() => {}}
        onOpenAddModal={() => {}}
      />
    </QueryClientProvider>
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
    const toggle = screen.getByRole('switch', { name: 'Browser access' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(
      screen.getByRole('button', { name: 'More about Browser access' }),
    );
    expect(screen.getByRole('tooltip').textContent).toMatch(/Project browser/);
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
          name: 'Browser access',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});

test.each(['station', 'codex'])(
  '%s explains unavailable Station browser delivery without changing the saved preference',
  (engineId) => {
    let latest = createEmptyAgentForm(engineId);
    render(
      <Harness
        initial={latest}
        engineId={engineId}
        onForm={(form) => {
          latest = form;
        }}
      />,
    );
    expect(screen.queryByRole('switch', { name: 'Browser access' })).toBeNull();
    expect(
      screen.getByText(
        'Station browser access is currently available with Claude Code.',
      ),
    ).toBeTruthy();
    expect(latest.tools.browser).toBe(true);
  },
);

test('added sources use one compact row and can be removed without changing another source', () => {
  let latest = createEmptyAgentForm();
  latest.tools.mcpServers = ['docs', 'reports'];
  latest.tools.available = ['docs_read', 'reports_read'];
  render(
    <Harness
      initial={latest}
      onForm={(form) => {
        latest = form;
      }}
      availableTools={[
        { id: 'docs', name: 'Docs' },
        { id: 'reports', name: 'Reports' },
      ]}
    />,
  );
  expect(screen.queryByText('Select shown')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Remove Docs' }));
  expect(latest.tools.mcpServers).toEqual(['reports']);
  expect(latest.tools.available).toEqual(['reports_read']);
});
