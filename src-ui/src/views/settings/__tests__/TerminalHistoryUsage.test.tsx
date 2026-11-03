/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { TerminalHistoryUsage } from '../TerminalHistoryUsage';

const { query, mutation, Unsupported } = vi.hoisted(() => {
  class Unsupported extends Error {}
  return {
    Unsupported,
    query: {
      isLoading: false,
      error: null as Error | null,
      data: undefined as unknown,
      refetch: vi.fn(),
    },
    mutation: {
      isPending: false,
      error: null as Error | null,
      data: undefined as unknown,
      mutate: vi.fn(),
    },
  };
});

vi.mock('@kontourai/station-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kontourai/station-sdk')>()),
  TerminalHistoryUnsupportedError: Unsupported,
  useTerminalHistoryQuery: () => query,
  useClearTerminalHistoryMutation: () => mutation,
}));
vi.mock('../../../contexts/ProjectsContext', () => ({
  useProjects: () => ({
    projects: [{ id: 'project-a', name: 'Alpha' }],
    isLoading: false,
    isConfirmedLoaded: true,
  }),
}));

beforeEach(() => {
  query.isLoading = false;
  query.error = null;
  query.data = {
    enabled: true,
    directory: '/home/station/terminal-journals',
    projects: [
      { projectId: 'project-a', terminals: 3, running: 1, bytes: 3 * 1048576 },
    ],
    terminals: 3,
    bytes: 3 * 1048576,
  };
  query.refetch.mockReset();
  mutation.mutate.mockReset();
  mutation.data = undefined;
});
afterEach(cleanup);

test('shows usage per Project and clears one Project after confirming', () => {
  render(<TerminalHistoryUsage />);
  expect(
    screen.getByText(/3\.0 MiB for 3 terminals in \/home\/station/),
  ).toBeTruthy();
  const row = screen.getByRole('row', { name: /Alpha/ });
  expect(row.textContent).toContain('3 (1 running)');
  fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
  expect(
    screen.getByRole('alertdialog', {
      name: 'Clear terminal history for Alpha?',
    }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Clear history' }));
  expect(mutation.mutate).toHaveBeenCalledWith('project-a', expect.any(Object));
});

test('clears everything with no Project named', () => {
  render(<TerminalHistoryUsage />);
  fireEvent.click(
    screen.getByRole('button', { name: 'Clear all terminal history' }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Clear history' }));
  expect(mutation.mutate).toHaveBeenCalledWith(undefined, expect.any(Object));
});

test('a read failure offers Retry, and an older Station says it cannot report', () => {
  query.data = undefined;
  query.error = new Error('boom');
  const view = render(<TerminalHistoryUsage />);
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(query.refetch).toHaveBeenCalled();
  query.error = new Unsupported(
    'This Station does not report terminal history.',
  );
  view.rerender(<TerminalHistoryUsage />);
  expect(
    screen.getByText('This Station does not report terminal history.'),
  ).toBeTruthy();
});

test('loading shows a skeleton and an empty history disables clearing', () => {
  query.isLoading = true;
  query.data = undefined;
  const view = render(<TerminalHistoryUsage />);
  expect(screen.getByLabelText('Reading terminal history')).toBeTruthy();
  query.isLoading = false;
  query.data = {
    enabled: true,
    directory: '/d',
    projects: [],
    terminals: 0,
    bytes: 0,
  };
  view.rerender(<TerminalHistoryUsage />);
  expect(
    (
      screen.getByRole('button', {
        name: 'Clear all terminal history',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});
