// @vitest-environment jsdom
import type {
  PersonalBoardDocument,
  PersonalBoardSaveInput,
} from '@kontourai/station-contracts/personal-board';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
  document: undefined as PersonalBoardDocument | undefined,
  readError: false,
  mutate: vi.fn(),
  refetch: vi.fn(),
  chat: vi.fn(() => true),
}));
vi.mock('@kontourai/station-sdk', async (original) => ({
  ...(await original<typeof import('@kontourai/station-sdk')>()),
  usePersonalBoardQuery: () => ({
    data: state.document,
    isError: state.readError,
    error: new Error('Board read failed'),
    isLoading: false,
    refetch: state.refetch,
  }),
  useSavePersonalBoardMutation: () => ({
    mutate: state.mutate,
    reset: vi.fn(),
    isPending: false,
    isError: false,
  }),
  useTasksQuery: () => ({ data: [], isLoading: false, isError: false }),
  useBoardAttentionQuery: () => ({
    data: { items: [], pendingCount: 0 },
    isLoading: false,
    isError: false,
  }),
  useBoardRecentWorkQuery: () => ({
    data: [],
    isLoading: false,
    isError: false,
  }),
}));
vi.mock('../../../contexts/ApiBaseContext', () => ({
  useHostRequestAuthorityScope: () => ({
    apiBase: 'http://station.test',
    authorityKey: 'station-a',
    isCurrent: () => true,
  }),
}));
vi.mock('../../../contexts/ProjectsContext', () => ({
  useScopedProjectsQuery: () => ({
    data: [{ id: 'p1', slug: 'demo', name: 'Demo' }],
    isLoading: false,
    isError: false,
  }),
}));
vi.mock('../../../contexts/NavigationContext', () => ({
  useNavigation: () => ({ navigate: vi.fn() }),
}));
vi.mock('../../../lib/projectChatEvents', () => ({
  requestProjectChat: state.chat,
}));

import { PersonalBoardWorkspace } from '../PersonalBoardWorkspace';

beforeEach(() => {
  vi.clearAllMocks();
  state.readError = false;
  state.document = {
    layout: {
      id: 'b1',
      slug: 'daily',
      type: 'custom',
      name: 'Untitled Board',
      config: {},
      createdAt: '2026-10-16',
      updatedAt: '2026-10-16',
    },
    revision: 'a'.repeat(64),
    definition: null,
    proposal: null,
  };
});

test('template sections can be edited, reordered and previewed before the exact definition is saved', () => {
  render(<PersonalBoardWorkspace slug="daily" />);
  fireEvent.click(screen.getByRole('button', { name: /Daily brief/ }));
  fireEvent.change(screen.getByLabelText('Board name'), {
    target: { value: 'My morning' },
  });
  fireEvent.change(screen.getByLabelText('Note'), {
    target: { value: 'Review the release before lunch.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Move Note up' }));
  fireEvent.click(screen.getByRole('button', { name: /^Preview$/ }));
  expect(state.mutate).not.toHaveBeenCalled();
  expect(screen.getByRole('heading', { name: 'My morning' })).toBeTruthy();
  expect(screen.getByText('Review the release before lunch.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save Board' }));
  const input: PersonalBoardSaveInput = state.mutate.mock.calls[0][0];
  expect(input.revision).toBe('a'.repeat(64));
  expect(input.definition.name).toBe('My morning');
  expect(input.definition.sections.map((section) => section.kind)).toEqual([
    'attention',
    'tasks',
    'note',
    'recent-work',
  ]);
});

test('an arriving chat proposal does not replace the saved Board until the person reviews and applies it', () => {
  state.document!.definition = {
    version: 1,
    name: 'Saved Board',
    description: '',
    sections: [],
  };
  state.document!.proposal = {
    version: 1,
    name: 'Proposed Board',
    description: '',
    sections: [
      {
        id: 'note',
        title: 'Plan',
        kind: 'note',
        width: 'full',
        body: 'Ship carefully.',
      },
    ],
  };
  render(<PersonalBoardWorkspace slug="daily" />);
  expect(screen.getByRole('heading', { name: 'Saved Board' })).toBeTruthy();
  expect(screen.queryByText('Ship carefully.')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Review proposal' }));
  expect(screen.getByText('Ship carefully.')).toBeTruthy();
  expect(state.mutate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Apply Board' }));
  expect(state.mutate.mock.calls[0][0]).toEqual({
    revision: 'a'.repeat(64),
    definition: state.document!.proposal,
  });
});

test('a newer revision preserves the editor draft and blocks stale Apply', () => {
  const view = render(<PersonalBoardWorkspace slug="daily" />);
  fireEvent.click(screen.getByRole('button', { name: /Start blank/ }));
  fireEvent.change(screen.getByLabelText('Board name'), {
    target: { value: 'Keep my edit' },
  });
  state.document = { ...state.document!, revision: 'b'.repeat(64) };
  view.rerender(<PersonalBoardWorkspace slug="daily" />);
  expect(screen.getByDisplayValue('Keep my edit')).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Save Board' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(screen.getByText(/changed while you were editing/)).toBeTruthy();
  expect(state.mutate).not.toHaveBeenCalled();
});

test('Build with chat offers Board context to the canonical new-chat picker without sending a message', () => {
  render(<PersonalBoardWorkspace slug="daily" />);
  fireEvent.click(screen.getByRole('button', { name: 'Build with chat' }));
  expect(state.chat).toHaveBeenCalledWith(
    expect.objectContaining({
      source: 'personal-board',
      composerDraft: expect.objectContaining({
        message: expect.stringContaining('propose_personal_board'),
      }),
    }),
  );
  expect(state.mutate).not.toHaveBeenCalled();
});

test('a background read error keeps the dirty editor and its discard decision visible', () => {
  const view = render(<PersonalBoardWorkspace slug="daily" />);
  fireEvent.click(screen.getByRole('button', { name: /Start blank/ }));
  fireEvent.change(screen.getByLabelText('Board name'), {
    target: { value: 'Keep this draft' },
  });
  state.readError = true;
  view.rerender(<PersonalBoardWorkspace slug="daily" />);
  expect(screen.getByDisplayValue('Keep this draft')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Retry refresh' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Discard' })).toBeTruthy();
});
