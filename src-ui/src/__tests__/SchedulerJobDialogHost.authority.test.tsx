/** @vitest-environment jsdom */
import type { EnrichedAgentProjection } from '@kontourai/station-contracts/enriched-agent';
import type { SchedulerJob } from '@kontourai/station-contracts/scheduler';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SchedulerJobDialogHost } from '../components/scheduler/SchedulerJobDialogHost';
import { bannerStore } from '../contexts/banner-store';
import { navigationStore } from '../contexts/navigation-store';
import { schedulerJobDialogStore } from '../contexts/scheduler-job-dialog-store';

const inputs = vi.hoisted(() => ({
  agents: [] as EnrichedAgentProjection[],
  authority: {
    apiBase: 'https://station-a.example',
    authorityKey: 'a',
    isCurrent: () => true,
  },
  add: vi.fn(),
  edit: vi.fn(),
  refetch: vi.fn(async () => undefined),
}));
vi.mock('@kontourai/station-sdk', () => ({
  useAgentsQuery: () => ({
    data: inputs.agents,
    isSuccess: true,
    isError: false,
    isFetching: false,
    refetch: inputs.refetch,
  }),
}));
vi.mock('../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => inputs.authority,
}));
vi.mock('../contexts/AgentsContext', () => ({
  useAgents: () => inputs.agents,
  useAgentCatalogRead: () => ({
    loaded: true,
    settled: true,
    failed: false,
    retrying: false,
    retry: inputs.refetch,
  }),
}));
vi.mock('../hooks/useScheduler', () => ({
  useSchedulerProviders: () => ({ data: [] }),
  useAddJob: () => ({ isPending: false, mutate: inputs.add }),
  useEditJob: () => ({ isPending: false, mutate: inputs.edit }),
  usePreviewSchedule: () => ({ data: [], isLoading: false }),
}));

const ready = {
  slug: 'b',
  name: 'Agent B',
  available: true,
} as EnrichedAgentProjection;
const broken = {
  slug: 'a',
  name: 'Agent A',
  available: false,
  unavailableReason: 'Connect a Model',
  unavailableFix: { kind: 'model-connection' },
} as EnrichedAgentProjection;
beforeEach(() => {
  inputs.agents = [ready];
  inputs.authority = {
    apiBase: 'https://station-a.example',
    authorityKey: 'a',
    isCurrent: () => true,
  };
  inputs.add.mockReset();
  inputs.edit.mockReset();
  inputs.refetch.mockClear();
  navigationStore.navigate('/schedule', { dock: null, maximize: null });
});
afterEach(() => {
  cleanup();
  const request = schedulerJobDialogStore.getSnapshot();
  if (request) schedulerJobDialogStore.close(request);
  for (const banner of bannerStore.getSnapshot())
    bannerStore.dismiss(banner.id, { reason: 'system' });
});

test('changing captured authority closes the mounted draft and does not reopen it', async () => {
  schedulerJobDialogStore.open({ authority: inputs.authority });
  const view = render(<SchedulerJobDialogHost />);
  fireEvent.change(screen.getByLabelText('Name'), {
    target: { value: 'private draft' },
  });
  inputs.authority = { ...inputs.authority, authorityKey: 'b' };
  view.rerender(<SchedulerJobDialogHost />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(schedulerJobDialogStore.getSnapshot()).toBeNull();
  inputs.authority = { ...inputs.authority, authorityKey: 'a' };
  view.rerender(<SchedulerJobDialogHost />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(inputs.add).not.toHaveBeenCalled();
});

test('a late save callback from the old mounted form cannot close a newer draft', () => {
  schedulerJobDialogStore.open({
    authority: inputs.authority,
    prefill: { name: 'old', prompt: 'old instructions' },
  });
  render(<SchedulerJobDialogHost />);
  fireEvent.click(screen.getByRole('button', { name: 'Add Job' }));
  expect(inputs.add).toHaveBeenCalledOnce();
  const oldSuccess = inputs.add.mock.calls[0]?.[1].onSuccess;
  act(() =>
    schedulerJobDialogStore.open({
      authority: inputs.authority,
      prefill: { name: 'new', prompt: 'new instructions' },
    }),
  );
  act(() => oldSuccess());
  expect(screen.getByLabelText('Name')).toHaveProperty('value', 'new');
  expect(screen.getByLabelText('Instructions')).toHaveProperty(
    'value',
    'new instructions',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Add Job' }));
  act(() => inputs.add.mock.calls[1]?.[1].onSuccess());
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('editing broken A stays in repair while ready B exists, then restores A and the draft', async () => {
  inputs.agents = [broken, ready];
  const job: SchedulerJob = {
    name: 'edit-a',
    provider: 'built-in',
    agent: 'a',
    prompt: 'retained instructions',
    schedule: { kind: 'every', everyMs: 300_000 },
    enabled: true,
  };
  schedulerJobDialogStore.open({ authority: inputs.authority, job });
  const view = render(<SchedulerJobDialogHost />);
  fireEvent.change(screen.getByLabelText('Instructions'), {
    target: { value: 'edited instructions' },
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Repair this agent’s setup' }),
  );
  await waitFor(() =>
    expect(navigationStore.getSnapshot().pathname).toBe('/connections/models'),
  );
  await act(async () => {});
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(inputs.refetch).not.toHaveBeenCalled();
  inputs.agents = [{ ...broken, available: true }, ready];
  view.rerender(<SchedulerJobDialogHost />);
  await screen.findByRole('button', { name: 'Save Changes' });
  expect(navigationStore.getSnapshot().pathname).toBe('/schedule');
  expect(screen.getByLabelText('Instructions')).toHaveProperty(
    'value',
    'edited instructions',
  );
  expect(screen.getByRole('button', { name: /Agent A/ })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
  expect(inputs.edit.mock.calls[0]?.[0]).toEqual({
    target: 'edit-a',
    prompt: 'edited instructions',
  });
});
