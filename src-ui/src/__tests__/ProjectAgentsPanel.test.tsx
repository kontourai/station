/** @vitest-environment jsdom */
import type {
  OwnAccessView,
  ToolLibraryView,
} from '@kontourai/station-contracts/tool-library';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ToolLibraryClientContext } from '../views/agent-editor/ToolLibraryContext';
import { ProjectAgentsPanel } from '../views/project-settings/ProjectAgentsPanel';

vi.mock('../views/agent-editor/AgentToolDiscovery', () => ({
  AgentToolConnection: ({
    onDirtyChange,
  }: {
    onDirtyChange: (dirty: boolean) => void;
  }) => (
    <button type="button" onClick={() => onDirtyChange(true)}>
      Edit connection
    </button>
  ),
}));
const clients: QueryClient[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  clients.splice(0).forEach((client) => client.clear());
});
function setup(engine = 'claude') {
  const view: ToolLibraryView = {
    sources: [
      {
        id: 'reports',
        kind: 'integration',
        name: 'Reports',
        from: 'Team registry',
        installed: true,
        enabled: true,
        permitted: false,
        operatorOnly: false,
        tools: [],
      },
    ],
    operator: true,
    canManageAgents: true,
    canManagePolicy: false,
    project: { id: 'design-id', slug: 'design', name: 'Design' },
    policy: { mode: 'selected', sources: [], revision: 1 },
    engines: [
      { id: 'station', name: 'Station', engineId: 'station' },
      { id: 'claude', name: 'Claude', engineId: 'claude' },
      { id: 'codex', name: 'Codex', engineId: 'codex' },
    ],
  };
  const access: OwnAccessView = {
    principalId: 'alice',
    name: 'Alice',
    station: { name: 'My Mac', operator: true, canInstallTools: true },
    projects: [
      {
        ...view.project!,
        role: 'operator',
        canManageAgents: true,
        canManageTools: true,
        canExecute: true,
      },
    ],
  };
  const writes: Record<string, any>[] = [];
  const saved = {
    slug: 'analyst',
    projectId: 'design-id',
    spec: {
      name: 'Analyst',
      project: 'design',
      prompt: 'Read reports',
      execution: engine === 'station' ? {} : { agentConnectionId: engine },
      tools: {
        mcpServers: ['reports'],
        available: ['reports_read'],
        autoApprove: ['mcp/reports/read'],
        askBeforeUse: ['mcp/reports/*'],
      },
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname;
      if (init?.method === 'PUT') {
        writes.push(JSON.parse(String(init.body)));
        return Response.json({ success: true, data: { slug: 'analyst' } });
      }
      const data = path.endsWith('/access')
        ? access
        : path.endsWith('/catalog')
          ? view
          : [saved];
      return Response.json({ success: true, data, principalId: 'alice' });
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <ToolLibraryClientContext.Provider
        value={{ apiBase: 'http://station.test', principalId: 'alice' }}
      >
        <ProjectAgentsPanel project={view.project!} />
      </ToolLibraryClientContext.Provider>
    </QueryClientProvider>,
  );
  return { writes, saved };
}
test('editing preserves tools and approvals; an incompatible engine is refused before save; revoked sources remain removable', async () => {
  const h = setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Name'), {
    target: { value: 'Renamed analyst' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));
  await waitFor(() => expect(h.writes).toHaveLength(1));
  expect(h.writes[0]?.draft.tools).toEqual(h.saved.spec.tools);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.change(screen.getByLabelText('Engine'), {
    target: { value: 'codex' },
  });
  expect(screen.getByRole('alert').textContent).toContain(
    'cannot enforce Ask me',
  );
  expect(
    (screen.getByRole('button', { name: 'Save agent' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));
  await waitFor(() => expect(h.writes).toHaveLength(2));
  expect(h.writes[1]?.draft.tools.mcpServers).toEqual([]);
});
test('connection edits prevent dismissing the Project tools dialog or saving its parent', async () => {
  setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add tools' }));
  fireEvent.click(await screen.findByText('Connect your own source'));
  fireEvent.click(
    screen.getByRole('button', { name: 'Connect a tool source' }),
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Edit connection' }),
  );
  expect(
    (screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (screen.getByRole('button', { name: 'Save agent' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Close tools' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close Project agent' }));
  fireEvent.keyDown(screen.getAllByRole('dialog').at(-1)!, { key: 'Escape' });
  expect(screen.getByRole('button', { name: 'Edit connection' })).toBeTruthy();
});

test('a managed Station agent reopens with Station selected and saves its tools unchanged', async () => {
  const h = setup('station');
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  expect((screen.getByLabelText('Engine') as HTMLSelectElement).value).toBe(
    'station',
  );
  fireEvent.change(screen.getByLabelText('Name'), {
    target: { value: 'Station analyst' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));
  await waitFor(() => expect(h.writes).toHaveLength(1));
  expect(h.writes[0]?.draft.engineId).toBe('station');
  expect(h.writes[0]?.draft.tools).toEqual(h.saved.spec.tools);
});
