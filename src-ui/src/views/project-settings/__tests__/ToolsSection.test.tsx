// @vitest-environment jsdom

import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { expect, test, vi } from 'vitest';
import { ToolsSection } from '../ToolsSection';
import type { ProjectForm } from '../types';
import { buildProjectSavePayload } from '../utils';

vi.mock('@kontourai/station-sdk', () => ({
  useIntegrationsQuery: () => ({
    data: [
      {
        id: 'weather',
        displayName: 'Weather',
        description: 'Weather tools',
        enabled: true,
      },
      { id: 'parked', displayName: 'Parked', enabled: false },
    ],
    isLoading: false,
    isError: false,
  }),
  useKnowledgeRootsQuery: () => ({
    data: [
      {
        id: 'demo-store',
        adapterId: 'kit-default-store',
        storeRoot: '/tmp/demo',
        displayName: 'Demo records',
        createdAt: '2026-10-03T00:00:00.000Z',
        scope: { kind: 'project', projectSlug: 'demo' },
      },
    ] satisfies KnowledgeStoreRoot[],
    isLoading: false,
    isError: false,
  }),
}));

function Editor({ save }: { save: (payload: unknown) => void }) {
  const [form, setForm] = useState<ProjectForm | null>({
    name: 'Demo',
    defaultWorkspaceIsolation: 'inherit',
    toolDefaults: { mcpServers: ['missing'] },
  });
  return (
    form && (
      <>
        <ToolsSection slug="demo" form={form} setForm={setForm} />
        <button
          type="button"
          onClick={() => save(buildProjectSavePayload(form))}
        >
          Save
        </button>
      </>
    )
  );
}

test('Project tool choices save additively, detect stores and preserve unavailable selections', () => {
  const save = vi.fn();
  render(<Editor save={save} />);
  expect(screen.getByText('1 store')).toBeTruthy();
  expect(
    screen.getByRole('checkbox', { name: 'Add missing to Project agents' }),
  ).toHaveProperty('checked', true);
  fireEvent.click(screen.getByRole('button', { name: 'Add tools' }));
  expect(
    screen.getByRole('checkbox', { name: 'Add Parked to Project agents' }),
  ).toHaveProperty('disabled', true);
  fireEvent.click(
    screen.getByRole('checkbox', { name: 'Add Weather to Project agents' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  fireEvent.click(
    screen.getByRole('switch', { name: 'Use Project Knowledge tools' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      toolDefaults: { mcpServers: ['missing', 'weather'], knowledge: false },
    }),
  );
  expect(
    screen.queryByText('Adds tools to agents working in this Project.', {
      exact: false,
    }),
  ).toBeNull();
});
