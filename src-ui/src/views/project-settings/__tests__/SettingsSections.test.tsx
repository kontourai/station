// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import { AgentsSection } from '../AgentsSection';
import { LayoutsSection } from '../LayoutsSection';
import type { ProjectForm } from '../types';

const reads = vi.hoisted(() => ({
  retryAgents: vi.fn(),
  retryLayouts: vi.fn(),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useAgentsQuery: () => ({
    data: undefined,
    isError: true,
    refetch: reads.retryAgents,
  }),
  useProjectLayoutsQuery: () => ({
    data: undefined,
    isError: true,
    refetch: reads.retryLayouts,
  }),
  useAvailableProjectLayoutsQuery: () => ({ data: [] }),
  useDeleteProjectLayoutMutation: () => ({ isPending: false }),
  useApplyProjectLayoutMutation: () => ({ isPending: false }),
}));

beforeEach(() => vi.clearAllMocks());

function AgentsEditor() {
  const [form, setForm] = useState<ProjectForm | null>({
    name: 'Demo',
    defaultWorkspaceIsolation: 'inherit',
    defaultModelSelection: 'fixed',
    defaultApprovalModeSelection: 'fixed',
    defaultApprovalMode: 'inherit',
  });
  return (
    form && <AgentsSection form={form} setForm={setForm} projectSlug="demo" />
  );
}

test('an Agent read failure disables choices and offers a retry', () => {
  render(<AgentsEditor />);
  expect(screen.getByText('Could not load agents')).toBeTruthy();
  expect(
    screen.getByRole('combobox', { name: 'Default agent' }),
  ).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(reads.retryAgents).toHaveBeenCalledOnce();
});

test('a failed layout read is not shown as an empty project and can be retried', () => {
  render(<LayoutsSection slug="demo" />);
  expect(screen.getByText('Could not load layouts')).toBeTruthy();
  expect(
    screen.queryByText("This project doesn't have any layouts yet"),
  ).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(reads.retryLayouts).toHaveBeenCalledOnce();
});
