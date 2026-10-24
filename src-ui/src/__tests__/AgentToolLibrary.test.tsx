/** @vitest-environment jsdom */
import type {
  OwnAccessView,
  ToolLibrarySource,
  ToolLibraryView,
} from '@kontourai/station-contracts/tool-library';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { AgentToolLibrary } from '../views/agent-editor/AgentToolLibrary';
import { createEmptyAgentForm } from '../views/agent-editor/agentsViewUtils';
import { ToolLibraryClientContext } from '../views/agent-editor/ToolLibraryContext';

const clients: QueryClient[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const client of clients.splice(0)) client.clear();
});
function fixture(
  operator = true,
  installed = true,
  canManage = true,
  engineId = 'claude',
  personalAccount = false,
) {
  const source: ToolLibrarySource = {
    id: 'station-docs',
    kind: 'integration',
    name: 'Station Docs',
    description: 'Read the Station guide.',
    from: 'Station',
    origin: { kind: 'station', registryName: 'Station' },
    installed,
    enabled: installed,
    permitted: true,
    operatorOnly: false,
    personalAccount,
    tools: installed
      ? [
          {
            name: 'read',
            title: 'Read a guide',
            description: 'Find setup instructions.',
            readOnly: true,
            classificationSource: 'station',
          },
          {
            name: 'write',
            title: 'Change a guide',
            readOnly: false,
            classificationSource: 'station',
          },
        ]
      : [],
  };
  const access: OwnAccessView = {
    principalId: 'alice',
    name: 'Alice',
    station: { name: 'My Mac', operator, canInstallTools: operator },
    projects: [
      {
        id: 'design-id',
        slug: 'design',
        name: 'Design',
        role: operator ? 'operator' : 'admin',
        canManageAgents: canManage,
        canManageTools: operator,
        canExecute: false,
      },
    ],
  };
  const view: ToolLibraryView = {
    sources: [source],
    operator,
    canManageAgents: canManage,
    canManagePolicy: operator,
    project: { id: 'design-id', slug: 'design', name: 'Design' },
    policy: { mode: 'all', sources: [], revision: 1 },
  };
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      let data: unknown;
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        writes.push({ path: url.pathname, body });
        if (url.pathname.endsWith('/discover')) {
          data = source;
        } else if (url.pathname.endsWith('/requests')) {
          source.request = { id: 'request-one', status: 'pending' };
          data = { id: 'request-one', status: 'pending' };
        } else {
          source.installed = true;
          source.enabled = true;
          data = { id: source.id };
        }
      } else if (url.pathname.includes('/accounts/')) {
        data = { connectedAs: 'you-in-project' };
      } else if (url.pathname.endsWith('/access')) data = access;
      else if (url.pathname.endsWith('/catalog')) data = view;
      else
        throw new Error(
          `Unexpected tool library fixture request: ${url.pathname}`,
        );
      return Response.json({ success: true, data, principalId: 'alice' });
    }),
  );
  let latest = createEmptyAgentForm('claude');
  latest.project = 'design';
  latest.name = 'Unsaved analyst';
  latest.tools.autoApprove = ['*'];
  function Harness() {
    const [form, setForm] = useState(latest);
    latest = form;
    return (
      <AgentToolLibrary form={form} setForm={setForm} engineId={engineId} />
    );
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <ToolLibraryClientContext.Provider
        value={{ apiBase: 'http://station.test', principalId: 'alice' }}
      >
        <Harness />
      </ToolLibraryClientContext.Provider>
    </QueryClientProvider>,
  );
  return { source, view, writes, latest: () => latest };
}
test('one list makes the source clear and attaching tools preserves the draft and approval defaults', async () => {
  const h = fixture();
  await screen.findByText('Station Docs');
  expect(screen.queryByText('Servers')).toBeNull();
  expect(screen.queryByText('Plugins')).toBeNull();
  expect(screen.queryByText('Find setup instructions.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  expect(h.latest().name).toBe('Unsaved analyst');
  expect(h.latest().tools.mcpServers).toEqual(['station-docs']);
  expect(h.latest().tools.autoApprove).toContain('mcp/station-docs/read');
  expect(h.latest().tools.askBeforeUse).toContain('mcp/station-docs/write');
  expect(h.writes).toHaveLength(0);
  fireEvent.click(screen.getByLabelText('Details for Read a guide'));
  expect(screen.getByText('Find setup instructions.')).toBeTruthy();
  fireEvent.click(screen.getByText('About this source'));
  expect(
    screen.queryByRole('button', { name: 'Check for new tools' }),
  ).toBeNull();
  expect(screen.queryByRole('button', { name: 'Edit connection' })).toBeNull();
  expect(screen.getByText('All Projects on this Station')).toBeTruthy();
});
test('a Project admin requests installation and sees durable pending state without changing the agent', async () => {
  const h = fixture(false, false);
  await screen.findByRole('button', { name: 'Request' });
  fireEvent.click(screen.getByRole('button', { name: 'Request' }));
  await screen.findByRole('button', { name: 'Pending' });
  expect(h.writes).toEqual([
    {
      path: '/api/tool-library/requests',
      body: {
        project: 'design',
        projectId: 'design-id',
        expectedActor: 'alice',
        sourceId: 'station-docs',
        kind: 'integration',
      },
    },
  ]);
  expect(h.latest().tools.mcpServers).toEqual([]);
  expect(
    (
      screen.getByRole('button', {
        name: 'Pending',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
test('the operator Add action installs then attaches an undiscovered source with future Ask protection', async () => {
  const h = fixture(true, false);
  await screen.findByRole('button', { name: 'Add' });
  fireEvent.click(screen.getByRole('button', { name: 'Add' }));
  await waitFor(() =>
    expect(h.latest().tools.mcpServers).toEqual(['station-docs']),
  );
  expect(h.writes[0]).toEqual({
    path: '/api/tool-library/add',
    body: { id: 'station-docs', kind: 'integration', expectedActor: 'alice' },
  });
  expect(h.latest().tools.askBeforeUse).toContain('mcp/station-docs/*');
});
test('a viewer gets no working attachment or request action', async () => {
  const h = fixture(false, false, false);
  const request = await screen.findByRole('button', {
    name: 'Request',
  });
  expect((request as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(request);
  expect(h.writes).toHaveLength(0);
});

test('refresh preserves explicit action selection and future tools require opt-in', async () => {
  const h = fixture();
  h.source.origin = { kind: 'manual' };
  fireEvent.click(await screen.findByRole('button', { name: 'Add' }));
  fireEvent.click(screen.getByLabelText('Change a guide'));
  h.source.tools.push({ name: 'publish', description: 'Publish updates.' });
  fireEvent.click(screen.getByText('About this source'));
  fireEvent.click(screen.getByRole('button', { name: 'Check for new tools' }));
  await screen.findByLabelText('publish');
  expect((screen.getByLabelText('publish') as HTMLInputElement).checked).toBe(
    false,
  );
  expect(h.latest().tools.available).toEqual(['station-docs_read']);
  fireEvent.click(screen.getByLabelText('Include new tools automatically'));
  expect(h.latest().tools.available).toContain('station-docs_*');
  expect(h.latest().tools.askBeforeUse).toContain('mcp/station-docs/*');
});
test('publisher read annotations still require Ask and approval edits change the agent draft', async () => {
  const h = fixture();
  h.source.tools[0]!.classificationSource = 'publisher';
  fireEvent.click(await screen.findByRole('button', { name: 'Add' }));
  expect(h.latest().tools.askBeforeUse).toContain('mcp/station-docs/read');
  fireEvent.change(
    screen.getByRole('combobox', { name: 'Approval for Read a guide' }),
    {
      target: { value: 'always' },
    },
  );
  expect(h.latest().tools.autoApprove).toContain('mcp/station-docs/read');
});

test('whole-source engines do not offer unsupported individual or future-tool selections', async () => {
  const h = fixture(true, true, true, 'acp');
  fireEvent.click(await screen.findByRole('button', { name: 'Add' }));
  expect(h.latest().tools.available).toContain('station-docs_*');
  expect(screen.queryByText('Include new tools automatically')).toBeNull();
  expect(
    (screen.getByLabelText('Read a guide') as HTMLInputElement).disabled,
  ).toBe(true);
});

test('clicking a source opens individual actions without attaching; its catalog link keeps registry identity and the agent draft', async () => {
  const h = fixture(false);
  h.source.from = 'Team catalog';
  h.source.origin = {
    kind: 'registry',
    registryId: 'team-one',
    registryName: 'Team catalog',
  };
  h.view.sources.push(
    {
      ...h.source,
      id: 'notes',
      name: 'Team notes',
      installed: false,
      enabled: false,
      tools: [],
    },
    {
      ...h.source,
      id: 'other',
      name: 'Other registry tool',
      origin: {
        kind: 'registry',
        registryId: 'team-two',
        registryName: 'Team catalog',
      },
    },
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'View Station Docs tools' }),
  );
  expect(screen.getByLabelText('Read a guide')).toBeTruthy();
  expect(
    screen.getByText('Read', {
      selector: '.agent-tool-library__classification',
    }),
  ).toBeTruthy();
  expect(
    screen.getByText('Write', {
      selector: '.agent-tool-library__classification',
    }),
  ).toBeTruthy();
  expect(h.latest().tools.mcpServers).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Browse Team catalog' }));
  expect(
    screen.getByRole('button', { name: 'View Team notes tools' }),
  ).toBeTruthy();
  expect(
    screen.queryByRole('button', { name: 'View Other registry tool tools' }),
  ).toBeNull();
  expect(screen.getByRole('button', { name: 'Request' })).toBeTruthy();
  expect(h.latest().name).toBe('Unsaved analyst');
  expect(h.latest().tools.mcpServers).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'All sources' }));
  expect(
    screen.getByRole('button', { name: 'View Other registry tool tools' }),
  ).toBeTruthy();
});

test.each(['station', 'claude', 'codex'])(
  '%s can attach a personal OAuth source through the tool picker',
  async (engineId) => {
    const h = fixture(true, true, true, engineId, true);
    await screen.findByText('Station Docs');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(h.latest().tools.mcpServers).toEqual(['station-docs']);
    expect(h.writes).toHaveLength(0);
  },
);

test('an ACP engine cannot attach a personal account source', async () => {
  const h = fixture(true, true, true, 'kiro', true);
  await screen.findByText('Station, Claude Code or Codex required');
  expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
  expect(h.latest().tools.mcpServers).toEqual([]);
});
