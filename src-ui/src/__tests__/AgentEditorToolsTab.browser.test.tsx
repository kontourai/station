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
import {
  buildAgentPayload,
  createEmptyAgentForm,
} from '../views/agent-editor/agentsViewUtils';
import type { AgentFormData } from '../views/agent-editor/types';

function Harness({
  initial,
  onForm,
  locked = false,
  availableTools = [],
  engineId = 'station',
}: {
  initial: AgentFormData;
  onForm: (form: AgentFormData) => void;
  locked?: boolean;
  availableTools?: Tool[];
  engineId?: string;
}) {
  const [form, setForm] = useState(initial);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  onForm(form);
  return (
    // The Tools tab mounts the workflows section, whose SDK hooks need an
    // observer even when the queries are disabled (an unsaved agent has no
    // slug, so nothing fetches).
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        })
      }
    >
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
    fireEvent.click(screen.getByText('Advanced'));
    const toggle = screen.getByRole('switch', { name: 'Browser tools' });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(
      screen.getByRole('button', { name: 'More about Browser tools' }),
    );
    expect(screen.getByRole('tooltip').textContent).toMatch(/Claude agents/);
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
    fireEvent.click(screen.getByText('Advanced'));
    expect(
      (
        screen.getByRole('switch', {
          name: 'Browser tools',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});

const stationTools: Tool[] = [
  {
    id: 'station-control',
    name: 'Station',
    displayName: 'Station tools',
    tools: [
      { name: 'list_agents', readOnly: true, group: 'Agents' },
      { name: 'search_knowledge', readOnly: true, group: 'Knowledge' },
      { name: 'delete_agent', readOnly: false, group: 'Agents' },
    ],
  },
];

test('adds Station tools to a Claude agent and saves read-only, empty and custom choices', () => {
  let latest = createEmptyAgentForm();
  const payload = () => buildAgentPayload({ ...latest, slug: 'helper' });
  render(
    <Harness
      initial={latest}
      onForm={(form) => {
        latest = form;
      }}
      availableTools={stationTools}
      engineId="claude"
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Add Station tools' }));
  expect(payload().tools).toMatchObject({
    mcpServers: ['station-control'],
    mcpMode: 'add',
    available: [
      'station-control_list_agents',
      'station-control_search_knowledge',
    ],
  });
  expect(
    screen.queryByRole('switch', { name: 'Auto-approve list_agents' }),
  ).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Read only' }));
  expect(payload().tools?.available).toEqual([
    'station-control_list_agents',
    'station-control_search_knowledge',
  ]);
  expect(
    (screen.getByRole('checkbox', { name: 'Delete agent' }) as HTMLInputElement)
      .checked,
  ).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'None' }));
  expect(payload().tools?.available).toEqual([]);
  expect(
    screen.getByRole('button', { name: 'None' }).getAttribute('aria-pressed'),
  ).toBe('true');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Search knowledge' }));
  expect(payload().tools?.available).toEqual([
    'station-control_search_knowledge',
  ]);
  fireEvent.change(screen.getByLabelText('Search added tools'), {
    target: { value: 'knowledge' },
  });
  expect(screen.queryByRole('checkbox', { name: 'List agents' })).toBeNull();
  expect(
    screen.getByRole('checkbox', { name: 'Search knowledge' }),
  ).toBeTruthy();
  fireEvent.click(screen.getByLabelText('Tool settings'));
  fireEvent.change(screen.getByLabelText('Discovery'), {
    target: { value: 'on-demand' },
  });
  expect(
    screen.getByRole('button', { name: 'None' }).getAttribute('aria-pressed'),
  ).toBe('false');
  expect(payload().tools?.mcpLoading).toBe('on-demand');
  fireEvent.click(screen.getByRole('switch', { name: 'Keep harness tools' }));
  expect(payload().tools?.mcpMode).toBe('replace');
});

test('a locked agent cannot add Station tools', () => {
  render(
    <Harness
      initial={createEmptyAgentForm()}
      onForm={() => {}}
      availableTools={stationTools}
      locked
    />,
  );
  expect(
    (
      screen.getByRole('button', {
        name: 'Add Station tools',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

test('removing one integration preserves the implicit all-tools setting on the other', () => {
  let latest = createEmptyAgentForm();
  latest.tools.mcpServers = ['alpha', 'beta'];
  latest.toolsOriginal = { mcpServers: ['alpha', 'beta'] };
  render(
    <Harness
      initial={latest}
      onForm={(form) => {
        latest = form;
      }}
      availableTools={[
        { id: 'alpha', name: 'Alpha', tools: [{ name: 'read' }] },
        { id: 'beta', name: 'Beta', tools: [{ name: 'read' }] },
      ]}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Remove alpha' }));
  fireEvent.click(screen.getByRole('button', { name: /^beta/i }));
  expect(
    (screen.getByRole('checkbox', { name: 'Read' }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  expect(buildAgentPayload({ ...latest, slug: 'helper' }).tools).toMatchObject({
    mcpServers: ['beta'],
    available: ['*'],
  });
});

test('adds the complete server for a connected harness that cannot select individual tools', () => {
  let latest = createEmptyAgentForm();
  render(
    <Harness
      initial={latest}
      onForm={(form) => {
        latest = form;
      }}
      availableTools={stationTools}
      engineId="acp"
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Add Station tools' }));
  expect(latest.tools.available).toEqual(['station-control_*']);
  expect(screen.queryByRole('button', { name: 'Read only' })).toBeNull();
});

test.each(['stationControl_deleteAgent', 'stationControl_*'])(
  'None and read-only choices replace legacy selections: %s',
  (legacy) => {
    let latest = createEmptyAgentForm();
    latest.tools.mcpServers = ['station-control'];
    latest.tools.available = [legacy];
    latest.toolsOriginal = {
      mcpServers: ['station-control'],
      available: [legacy],
    };
    render(
      <Harness
        initial={latest}
        onForm={(form) => {
          latest = form;
        }}
        availableTools={stationTools}
        engineId="claude"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Station tools/i }));
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'Delete agent',
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'None' }));
    expect(
      buildAgentPayload({ ...latest, slug: 'helper' }).tools?.available,
    ).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Read only' }));
    expect(
      buildAgentPayload({ ...latest, slug: 'helper' }).tools?.available,
    ).toEqual([
      'station-control_list_agents',
      'station-control_search_knowledge',
    ]);
  },
);

test('group shortcuts preserve other groups and individual choices remain saveable', () => {
  let latest = createEmptyAgentForm();
  const tools: Tool[] = [
    {
      ...stationTools[0],
      tools: [
        ...stationTools[0].tools!,
        {
          name: 'migrate_knowledge',
          readOnly: false,
          group: 'Knowledge',
          title: 'Move knowledge',
        },
      ],
    },
  ];
  render(
    <Harness
      initial={latest}
      onForm={(form) => {
        latest = form;
      }}
      availableTools={tools}
      engineId="codex"
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Add Station tools' }));
  fireEvent.change(screen.getByLabelText('Tool group for Station tools'), {
    target: { value: 'Knowledge' },
  });
  expect(screen.queryByRole('checkbox', { name: 'List agents' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'All' }));
  expect(
    buildAgentPayload({ ...latest, slug: 'helper' }).tools?.available,
  ).toEqual([
    'station-control_list_agents',
    'station-control_search_knowledge',
    'station-control_migrate_knowledge',
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'Read only' }));
  expect(
    (
      screen.getByRole('checkbox', {
        name: 'Move knowledge',
      }) as HTMLInputElement
    ).checked,
  ).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'None' }));
  expect(
    buildAgentPayload({ ...latest, slug: 'helper' }).tools?.available,
  ).toEqual(['station-control_list_agents']);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Move knowledge' }));
  expect(
    buildAgentPayload({ ...latest, slug: 'helper' }).tools?.available,
  ).toEqual([
    'station-control_list_agents',
    'station-control_migrate_knowledge',
  ]);
  fireEvent.change(screen.getByLabelText('Tool group for Station tools'), {
    target: { value: '' },
  });
  expect(
    (screen.getByRole('checkbox', { name: 'List agents' }) as HTMLInputElement)
      .checked,
  ).toBe(true);
});

test('group changes preserve disabled and undiscovered choices and existing approvals outside the group', () => {
  let latest = createEmptyAgentForm();
  latest.tools.mcpServers = ['station-control'];
  latest.tools.available = [
    'station-control_list_agents',
    'station-control_search_knowledge',
    'station-control_temporarily_missing',
  ];
  latest.tools.autoApprove = ['station-control_*'];
  latest.toolsAvailableEdited = true;
  const tools: Tool[] = [
    {
      ...stationTools[0],
      tools: [
        {
          name: 'list_agents',
          readOnly: true,
          group: 'Agents',
          disabled: true,
        },
        { name: 'search_knowledge', readOnly: true, group: 'Knowledge' },
        { name: 'migrate_knowledge', readOnly: false, group: 'Knowledge' },
      ],
    },
  ];
  render(
    <Harness
      initial={latest}
      onForm={(form) => {
        latest = form;
      }}
      availableTools={tools}
      engineId="codex"
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /^Station tools/ }));
  fireEvent.change(screen.getByLabelText('Tool group for Station tools'), {
    target: { value: 'Knowledge' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Read only' }));
  expect(latest.tools.autoApprove).toEqual([
    'station-control_list_agents',
    'station-control_temporarily_missing',
    'station-control_search_knowledge',
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'None' }));
  expect(buildAgentPayload({ ...latest, slug: 'helper' }).tools).toMatchObject({
    available: [
      'station-control_list_agents',
      'station-control_temporarily_missing',
    ],
    autoApprove: [
      'station-control_list_agents',
      'station-control_temporarily_missing',
    ],
  });
});
